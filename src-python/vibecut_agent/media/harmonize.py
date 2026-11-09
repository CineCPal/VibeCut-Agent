"""The `media-harmonize` command (PLAN.md, "Harmonizer in the agent"): several takes of one performance
lined up with a clean reference recording, each following its own tempo drift.

Ported from VibeCut's src-python/harmonizer (align.py and headless.py, 2026-09-29's rebuild); the
alignment is unchanged. What differs here:
  - Sound comes through core/ffmpeg_ops.decode_mono (ffmpeg's pipe, a chunk at a time) as float32, and
    only the reference and the take being matched are held at once (VibeCut held every file).
  - Files are at most ffmpeg_ops.DECODE_MAX_SECONDS long.
  - Cancelling is the job's SIGTERM, as for the other media commands.

Each take goes through three steps:
  1. `chroma_guide`: a chroma DTW path places the take's music in the reference and follows rubato.
  2. `same_performance_line`: if the take heard the reference's own performance, one straight line
     (offset plus clock drift) fits it to a few milliseconds, and that is its only stretch.
  3. Otherwise `onset_pairs` pairs the reference's notes with the take's along the guide (dynamic
     programming over note starts and their pitches), and `simplify_path` keeps the fewest stretches
     within 20 ms of the pairs. Sound too sparse to pair falls back to `refine_path`'s onset-envelope
     window matching.

request: {
    "referencePath": absolute path of the clean recording (audio or video),
    "takePaths": [absolute paths of the takes, video or audio; at most MAX_TAKES],
    "noRetime": [paths among takePaths whose sound comes from the same recorder as the reference],
    "mergeTolerance": 0.02,       optional: stretches this close to normal speed are joined
    "flagSpeedMin": 0.5,          optional: stretches outside these are flagged for review
    "flagSpeedMax": 2.0
}
result: {
    "referencePath", "referenceDuration", "anchorCount",
    "takes": [{
        "path", "duration", "offset" (seconds the take started after the reference; negative when
        before), "offsetConfidence" (0-100: the share of line windows or notes that agreed), "leadIn"
        (seconds of the reference before the take has anything), "skippedAnchors", "flaggedCount",
        "sameRecording" (the take heard the reference's own performance: one straight stretch),
        "segments": [{"refStart", "refEnd", "takeStart", "takeEnd", "flagged"}]
    }]
}
Each take's segments run end to end in both times: reference seconds `refStart..refEnd` show take seconds
`takeStart..takeEnd`. `flagged` marks a stretch whose speed is outside flagSpeedMin..flagSpeedMax.

Harmonizer's `speed_factor` is reference time over take time; the speed a take PLAYS at to stay in sync is
its inverse. The app never reads it: it uses the segments' end points.
"""

from __future__ import annotations

import itertools
import math
import os
from collections.abc import Callable
from typing import Any

import numpy as np

from vibecut_agent.core import ffmpeg_ops
from vibecut_agent.protocol import Emitter, RequestError, require_absolute_paths

SR = 16000
MIN_SEGMENT_DUR = 0.02
MAX_TAKES = 16

UNSUPPORTED_EXTENSIONS = {".braw"}


class AlignError(RuntimeError):
    pass


class Cancelled(BaseException):
    """Raised between steps when the caller asks to stop."""


def load_mono(path: str) -> np.ndarray:
    """The file's sound as 16 kHz mono float32, streamed through ffmpeg (video files too)."""
    name = os.path.basename(path)
    if os.path.splitext(path)[1].lower() in UNSUPPORTED_EXTENSIONS:
        raise AlignError(f"{name}: Blackmagic RAW sound can't be read here yet")
    try:
        return ffmpeg_ops.decode_mono(path, SR)
    except ffmpeg_ops.FfmpegOpError as exc:
        detail = str(exc)
        if "matches no streams" in detail or detail == "it has no sound":
            raise AlignError(f"{name} has no sound to line up") from None
        raise AlignError(
            f"{name}: could not read its sound ({detail.splitlines()[-1] if detail else 'ffmpeg failed'})"
        ) from None


def gcc_phat(sig, ref, fs, max_tau=None, interp=16):
    n = sig.shape[0] + ref.shape[0]
    n_fft = 1 << (n - 1).bit_length()

    SIG = np.fft.rfft(sig, n=n_fft)
    REF = np.fft.rfft(ref, n=n_fft)
    R = SIG * np.conj(REF)

    denom = np.abs(R)
    denom[denom < 1e-15] = 1e-15
    cc = np.fft.irfft(R / denom, n=n_fft * interp)

    max_shift = int(n_fft * interp / 2)
    if max_tau:
        max_shift = min(int(interp * fs * max_tau), max_shift)

    cc = np.concatenate((cc[-max_shift:], cc[: max_shift + 1]))

    peak_idx = int(np.argmax(np.abs(cc)))
    peak_val = np.abs(cc[peak_idx])
    confidence = float(peak_val / (np.mean(np.abs(cc)) + 1e-12))

    shift = peak_idx - max_shift
    tau = shift / float(interp * fs)
    return tau, confidence


# ---- Where the take's music sits in the reference: a chroma DTW guide ----
# Chroma (how much of each of the 12 pitch classes sounds) is the same whichever piano, microphone or
# room played it, and a dynamic-time-warping path through it follows rubato. That makes it the standard
# way to line up *different performances* of one piece. The guide is coarse (GUIDE_HOP samples a
# step); refinement below pins it to the notes.
GUIDE_HOP = 1024
GUIDE_MAX_FRAMES = 4000  # longer files use a coarser hop, which keeps the DTW matrix to ~16M cells


def _guide_hop(n_samples):
    return max(GUIDE_HOP, math.ceil(n_samples / GUIDE_MAX_FRAMES / 512) * 512)


def _chroma(audio, hop):
    import librosa

    chroma = librosa.feature.chroma_cqt(y=audio.astype(np.float32), sr=SR, hop_length=hop, bins_per_octave=36)
    return librosa.util.normalize(chroma, norm=2, axis=0)


def _active_frames(audio, hop):
    """The frames from the take's first to its last sound louder than a tenth of its loud level: a camera
    that rolled before or after the music doesn't have that stretch matched against the reference."""
    import librosa

    rms = librosa.feature.rms(y=audio.astype(np.float32), frame_length=2 * hop, hop_length=hop)[0]
    loud = np.flatnonzero(rms > 0.1 * np.percentile(rms, 95))
    return (int(loud[0]), int(loud[-1]) + 1) if loud.size else (0, rms.size)


def chroma_guide(ref_audio, take_audio):
    """A coarse path (reference seconds, take seconds), strictly rising in reference time, placing the
    take's music wherever it falls in the reference (subsequence DTW: the take may cover only part)."""
    import librosa

    hop = _guide_hop(max(ref_audio.size, take_audio.size))
    ref_chroma = _chroma(ref_audio, hop)
    take_chroma = _chroma(take_audio, hop)
    first, last = _active_frames(take_audio, hop)
    _, warp = librosa.sequence.dtw(X=take_chroma[:, first:last], Y=ref_chroma, metric="cosine", subseq=True)
    warp = warp[::-1]
    ref_t = warp[:, 1] * hop / SR
    take_t = (warp[:, 0] + first) * hop / SR
    # One take time per reference step (the mean where the path runs vertically).
    ref_u, inverse = np.unique(ref_t, return_inverse=True)
    take_u = np.bincount(inverse, weights=take_t) / np.bincount(inverse)
    return ref_u, np.maximum.accumulate(take_u), hop / SR


# ---- The same performance? ----
# A camera that heard the very performance the reference recorded (its own microphone, a different
# clock) lines up by one straight line: an offset plus a tiny clock-rate difference. GCC-PHAT on
# equal-length windows along the guide finds each window's exact lag; if enough of them sit on one
# robust line, the take is that performance and gets a single stretch -- sample-accurate, with none
# of the wobble per-note matching would add. On Lindeblad 0926 the take that shared the Zoom's
# performance had 56% of windows on the line (slope 1.000021); separate performances had 5%.
LINE_WINDOW = 5.0
LINE_STEP = 3.0
LINE_MAX_LAG = 0.5
LINE_INLIER = 0.015
LINE_MIN_SHARE = 0.35
# ...and in every quarter of the piece: a take that keeps the reference's pace for half the piece and
# then plays faster puts half its windows on a line too, but none in the later quarters.
LINE_MIN_QUARTER_SHARE = 0.2


def same_performance_line(ref_audio, take_audio, guide):
    """(slope, intercept, inlier share) of take time = slope * reference time + intercept, or None when
    the take isn't the reference's own performance."""
    from scipy.stats import theilslopes

    ref_t, take_t, _ = guide
    half = LINE_WINDOW / 2
    points = []
    for r in np.arange(ref_t[0] + half, ref_t[-1] - half, LINE_STEP):
        t = float(np.interp(r, ref_t, take_t))
        a, b = int((r - half) * SR), int((t - half) * SR)
        if a < 0 or b < 0:
            continue
        ref_window = ref_audio[a : a + int(LINE_WINDOW * SR)]
        take_window = take_audio[b : b + ref_window.size]
        if take_window.size != ref_window.size or ref_window.size == 0:
            continue
        lag, _ = gcc_phat(take_window, ref_window, SR, max_tau=LINE_MAX_LAG, interp=4)
        points.append((r, t + lag))
    if len(points) < 4:
        return None
    pts = np.array(points)
    slope, intercept, *_ = theilslopes(pts[:, 1], pts[:, 0])
    inliers = np.abs(slope * pts[:, 0] + intercept - pts[:, 1]) < LINE_INLIER
    share = float(inliers.mean())
    if share < LINE_MIN_SHARE or inliers.sum() < 4:
        return None
    quarters = np.minimum(3, ((pts[:, 0] - pts[0, 0]) / (pts[-1, 0] - pts[0, 0] + 1e-9) * 4).astype(int))
    if any(inliers[quarters == q].mean() < LINE_MIN_QUARTER_SHARE for q in range(4) if np.any(quarters == q)):
        return None
    slope, intercept = np.polyfit(pts[inliers, 0], pts[inliers, 1], 1)
    return float(slope), float(intercept), share


# ---- A different performance: pin the guide to the notes ----
# Every REFINE_STEP seconds, the reference's onset-strength envelope over REFINE_WINDOW seconds is
# looked for in the take's, within REFINE_RADIUS of the guide. Onset envelopes (when notes start, not
# the waveform) match across performances, pianos and microphones. Weak matches (a held chord, a
# rest) keep the guide; a running median drops single wrong matches.
ENVELOPE_HOP = 160  # 10 ms
ENVELOPE_FPS = SR / ENVELOPE_HOP
REFINE_STEP = 0.5
REFINE_WINDOW = 2.0
REFINE_RADIUS = 0.2
REFINE_MIN_SCORE = 0.3
# A second, finer pass around the first: a 2 s window smears by +-30 ms when the tempos differ by 3%.
REFINE_FINE_WINDOW = 1.0
REFINE_FINE_RADIUS = 0.06
REFINE_MEDIAN = 5
# Stretch speeds are held to this range; anything outside is a matching error, not playing.
PATH_SPEED_MIN = 0.25
PATH_SPEED_MAX = 4.0
# Stretches are the fewest straight lines that stay within this many seconds of the matched path.
SIMPLIFY_TOLERANCE = 0.02
# A point that makes a neighbouring stretch play outside STUTTER_SPEED_MIN..MAX is dropped when the
# path without it stays within STUTTER_TOLERANCE seconds: a brief slow-then-fast pair is a local
# mismatch, and it would show as a stutter. A real long hold moves the path further and stays.
STUTTER_SPEED_MIN = 0.5
STUTTER_SPEED_MAX = 2.0
STUTTER_TOLERANCE = 0.1


def _onset_envelope(audio):
    import librosa
    from scipy.ndimage import gaussian_filter1d

    envelope = librosa.onset.onset_strength(y=audio.astype(np.float32), sr=SR, hop_length=ENVELOPE_HOP)
    return gaussian_filter1d(envelope.astype(np.float64), 1.0)


def refine_path(ref_envelope, take_envelope, guide, window=REFINE_WINDOW, radius=None):
    """(points, matched, tried): (reference seconds, take seconds) every REFINE_STEP along the guide,
    each pinned to the notes where the match is clear. `guide` is (ref times, take times, its step)."""
    from scipy.ndimage import median_filter

    ref_t, take_t, guide_step = guide
    radius = radius if radius is not None else max(REFINE_RADIUS, 2 * guide_step)
    half = window / 2
    rows, matched = [], 0
    for r in np.arange(ref_t[0] + half, ref_t[-1] - half + 1e-9, REFINE_STEP):
        t = float(np.interp(r, ref_t, take_t))
        part = ref_envelope[int((r - half) * ENVELOPE_FPS) : int((r + half) * ENVELOPE_FPS)]
        part = part - part.mean()
        start = int((t - half - radius) * ENVELOPE_FPS)
        region = take_envelope[max(0, start) : max(0, start) + part.size + int(2 * radius * ENVELOPE_FPS)]
        found = t
        if start >= 0 and region.size > part.size and np.any(part):
            centred = region - region.mean()
            scores = np.correlate(centred, part, "valid") / (
                np.linalg.norm(part) * np.sqrt(np.convolve(centred**2, np.ones(part.size), "valid")) + 1e-12
            )
            best = int(np.argmax(scores))
            if scores[best] >= REFINE_MIN_SCORE:
                found = (start + best) / ENVELOPE_FPS + half
                matched += 1
        rows.append((float(r), found - float(r)))
    if not rows:
        return [], 0, 0
    refs = np.array([r for r, _ in rows])
    offsets = median_filter(np.array([o for _, o in rows]), REFINE_MEDIAN, mode="nearest")
    return list(zip(refs.tolist(), (refs + offsets).tolist(), strict=True)), matched, len(rows)


# ---- A different performance: pair the reference's notes with the take's ----
# Each note start (onset) in the reference is paired with at most one in the take, near the guide, by
# dynamic programming over the reference's notes: a pair scores how alike the two notes' pitches are
# (the chroma that sounds new at the onset) and pays for how far its timing strays from the guide's pace
# since the previous pair. Notes with no convincing partner (a missed or extra note, a held chord)
# are skipped rather than forced. The pairs are the path, so the take's notes land on the reference's.
# On Lindeblad 0926 this took the clear notes landing within one frame from 72% to 87% (C065) and from
# 77% to 86% (C066), where `refine_path`'s window-by-window matching smeared notes by tens of ms.
PAIR_HOP = 80  # 5 ms
PAIR_DELTA = 0.07  # librosa's onset peak threshold
PAIR_RADIUS = 0.25  # a take note this far from the guide can be paired
PAIR_LOOKBACK = 24  # a pair can follow any of the previous this-many reference notes' pairs
PAIR_SIMILARITY_FLOOR = 0.5  # pitch likeness (cosine) a pair must beat to be worth keeping
PAIR_SIGMA = 0.04  # timing slack between neighbouring pairs, seconds...
PAIR_SIGMA_RATE = 0.1  # ...plus this much per second between them (tempo wanders)
PAIR_CHROMA_HOP = 256
MIN_PAIRS = 8
# Where the pairs leave a gap this long, the guide's shape fills it (bent to meet the pairs either side).
# Shorter gaps are a straight line between the pairs: the guide's 64 ms steps wobble, and filling 2 s
# gaps with them on Lindeblad 0926 tripled the flagged stretches and cost C065 5 points of note hits.
PAIR_GAP = 4.0


def onset_notes(audio):
    """(times, chroma at each): note starts over the whole file, with the pitch classes that sound
    new there (the chroma just after the onset less just before, plus some of what sounds after)."""
    import librosa

    y = audio.astype(np.float32)
    envelope = librosa.onset.onset_strength(y=y, sr=SR, hop_length=PAIR_HOP)
    frames = librosa.onset.onset_detect(onset_envelope=envelope, sr=SR, hop_length=PAIR_HOP, delta=PAIR_DELTA)
    times = frames * PAIR_HOP / SR
    chroma = librosa.feature.chroma_cqt(y=y, sr=SR, hop_length=PAIR_CHROMA_HOP, bins_per_octave=36)
    at = np.clip((times * SR / PAIR_CHROMA_HOP).astype(int), 1, max(1, chroma.shape[1] - 3))
    after = chroma[:, at + 1] + chroma[:, at + 2]
    new = np.maximum(0.0, after - chroma[:, at - 1]) + 0.3 * after
    return times, new / (np.linalg.norm(new, axis=0) + 1e-9)


def onset_pairs(ref_notes, take_notes, guide):
    """(pairs, matched, tried): (reference seconds, take seconds) for each paired note, in order, plus
    how many of the reference's notes inside the guide got a partner and how many there were."""
    ref_t, take_t, _ = guide
    rt, rf = ref_notes
    tt, tf = take_notes
    inside = (rt >= ref_t[0]) & (rt <= ref_t[-1])
    rt, rf = rt[inside], rf[:, inside]
    if rt.size < 2 or tt.size < 2:
        return [], 0, int(rt.size)
    expected = np.interp(rt, ref_t, take_t)
    cands = [np.flatnonzero(np.abs(tt - e) <= PAIR_RADIUS) for e in expected]
    best: list[np.ndarray] = []
    back: list[np.ndarray] = []
    for i, c in enumerate(cands):
        gain = rf[:, i] @ tf[:, c] - PAIR_SIMILARITY_FLOOR
        score, came_from = gain.copy(), np.full((c.size, 2), -1)
        for j in range(max(0, i - PAIR_LOOKBACK), i):
            prev = cands[j]
            if prev.size == 0 or c.size == 0:
                continue
            step = tt[c][None, :] - tt[prev][:, None]
            sigma = PAIR_SIGMA + PAIR_SIGMA_RATE * (rt[i] - rt[j])
            penalty = np.minimum(0.5 * ((step - (expected[i] - expected[j])) / sigma) ** 2, 50.0)
            total = np.where(step > 0, best[j][:, None] - penalty + gain[None, :], -np.inf)
            k = np.argmax(total, axis=0)
            value = total[k, np.arange(c.size)]
            better = value > score
            score[better] = value[better]
            came_from[better, 0], came_from[better, 1] = j, k[better]
        best.append(score)
        back.append(came_from)
    ends = [(float(s.max()), i, int(s.argmax())) for i, s in enumerate(best) if s.size]
    if not ends:
        return [], 0, int(rt.size)
    _, i, k = max(ends)
    pairs = []
    while i >= 0:
        pairs.append((float(rt[i]), float(tt[cands[i][k]])))
        i, k = back[i][k]
    pairs.reverse()
    return pairs, len(pairs), int(rt.size)


def fill_gaps(pairs, guide):
    """Pairs with the guide's shape put into every gap longer than PAIR_GAP: the guide's points there,
    shifted by an amount that runs from the pair before the gap to the pair after (so it joins both)."""
    ref_t, take_t, _ = guide
    out = [pairs[0]]
    for (r0, t0), (r1, t1) in itertools.pairwise(pairs):
        if r1 - r0 > PAIR_GAP:
            shift0 = t0 - np.interp(r0, ref_t, take_t)
            shift1 = t1 - np.interp(r1, ref_t, take_t)
            for r in ref_t[(ref_t > r0) & (ref_t < r1)]:
                w = (r - r0) / (r1 - r0)
                out.append((float(r), float(np.interp(r, ref_t, take_t) + shift0 + w * (shift1 - shift0))))
        out.append((r1, t1))
    return out


def _clamp_speeds(points):
    """Take times held so every stretch plays between PATH_SPEED_MIN and PATH_SPEED_MAX."""
    out = [points[0]]
    for r, t in points[1:]:
        pr, pt = out[-1]
        span = r - pr
        out.append((r, min(max(t, pt + PATH_SPEED_MIN * span), pt + PATH_SPEED_MAX * span)))
    return out


def simplify_path(points, tolerance=SIMPLIFY_TOLERANCE):
    """Douglas-Peucker on take time: the fewest points whose straight lines stay within `tolerance`
    seconds of every point. Rubato keeps its corners; matching jitter doesn't become speed changes."""
    pts = np.asarray(points, dtype=np.float64)
    if len(pts) <= 2:
        return [tuple(p) for p in pts]
    keep = np.zeros(len(pts), dtype=bool)
    keep[[0, -1]] = True
    stack = [(0, len(pts) - 1)]
    while stack:
        a, b = stack.pop()
        if b <= a + 1:
            continue
        inner = pts[a + 1 : b]
        predicted = pts[a, 1] + (inner[:, 0] - pts[a, 0]) * (pts[b, 1] - pts[a, 1]) / (pts[b, 0] - pts[a, 0])
        deviation = np.abs(inner[:, 1] - predicted)
        k = int(np.argmax(deviation))
        if deviation[k] > tolerance:
            keep[a + 1 + k] = True
            stack += [(a, a + 1 + k), (a + 1 + k, b)]
    return [tuple(p) for p in pts[keep]]


def remove_stutters(points):
    """Drops points that make a neighbouring stretch play outside STUTTER_SPEED_MIN..MAX when leaving
    them out moves the path less than STUTTER_TOLERANCE (see those constants)."""
    pts = list(points)

    def speed(a, b):
        return (b[1] - a[1]) / (b[0] - a[0])

    while len(pts) > 2:
        # The removable point that moves the path least goes first.
        best = None
        for i in range(1, len(pts) - 1):
            a, p, b = pts[i - 1], pts[i], pts[i + 1]
            if all(STUTTER_SPEED_MIN <= v <= STUTTER_SPEED_MAX for v in (speed(a, p), speed(p, b))):
                continue
            deviation = abs(a[1] + (p[0] - a[0]) * speed(a, b) - p[1])
            if deviation < STUTTER_TOLERANCE and (best is None or deviation < best[0]):
                best = (deviation, i)
        if best is None:
            break
        del pts[best[1]]
    return pts


EDGE_PACE_SECONDS = 10.0
EDGE_STRETCH_SECONDS = 3.0


def _edge_pace(pts, at_start):
    """The take's pace at the start (or end) of the path, held to 0.5x-2x: the edge stretch's own pace
    when it lasts EDGE_STRETCH_SECONDS or more (a fitted line, so the local pace), else the pace over
    the first (last) EDGE_PACE_SECONDS, so a note or two can't skew it."""
    ordered = np.array(pts if at_start else [(-r, -t) for r, t in reversed(pts)], dtype=np.float64)
    (r0, t0), (r1, t1) = ordered[0], ordered[1]
    if r1 - r0 >= EDGE_STRETCH_SECONDS:
        pace = (t1 - t0) / (r1 - r0)
    else:
        far = min(r0 + EDGE_PACE_SECONDS, ordered[-1, 0])
        pace = (np.interp(far, ordered[:, 0], ordered[:, 1]) - t0) / (far - r0)
    return float(min(max(pace, 0.5), 2.0))


def _extend_to_overlap(points, ref_duration, take_duration):
    """Carries the path on to wherever the reference or the take runs out, at both ends, at the take's
    pace near that end (`_edge_pace`): a camera that rolled on keeps its pace."""
    pts = list(points)
    pace = _edge_pace(pts, at_start=True)
    (r0, t0) = pts[0]
    back = min(r0, t0 / pace)
    if back > MIN_SEGMENT_DUR:
        pts.insert(0, (r0 - back, t0 - back * pace))
    else:
        pts[0] = (r0 - back, t0 - back * pace)
    pace = _edge_pace(pts, at_start=False)
    (r1, t1) = pts[-1]
    forward = min(ref_duration - r1, (take_duration - t1) / pace)
    if forward > MIN_SEGMENT_DUR:
        pts.append((r1 + forward, t1 + forward * pace))
    elif forward < 0:
        pts[-1] = (r1 + forward, t1 + forward * pace)
    return [(max(0.0, r), min(max(0.0, t), take_duration)) for r, t in pts]


def segments_from_path(path, merge_tolerance, flag_speed_min, flag_speed_max):
    """Turn an ordered list of {"ref_time", "take_time"} points into merged, flagged segments."""
    raw_segments = []
    for a, b in itertools.pairwise(path):
        ref_dur = b["ref_time"] - a["ref_time"]
        take_dur = b["take_time"] - a["take_time"]
        raw_segments.append(
            {
                "ref_start": a["ref_time"],
                "ref_end": b["ref_time"],
                "take_start": a["take_time"],
                "take_end": b["take_time"],
                "speed_factor": ref_dur / take_dur,
            }
        )

    merged: list[dict[str, Any]] = []
    for seg in raw_segments:
        if (
            merged
            and abs(merged[-1]["speed_factor"] - 1.0) <= merge_tolerance
            and abs(seg["speed_factor"] - 1.0) <= merge_tolerance
        ):
            prev = merged[-1]
            prev["ref_end"] = seg["ref_end"]
            prev["take_end"] = seg["take_end"]
            prev["speed_factor"] = (prev["ref_end"] - prev["ref_start"]) / (
                prev["take_end"] - prev["take_start"]
            )
        else:
            merged.append(dict(seg))

    for seg in merged:
        seg["flagged"] = not (flag_speed_min <= seg["speed_factor"] <= flag_speed_max)
    return merged


DEFAULTS = {
    "merge_tolerance": 0.02,
    "flag_speed_min": 0.5,
    "flag_speed_max": 2.0,
}


def _envelope_path(ref_envelope, take_envelope, guide):
    """The fallback when too few notes pair up (very sparse or noisy sound): onset-envelope windows
    matched along the guide, a coarse pass then a fine one, as (points, matched, tried)."""
    refined, matched, tried = refine_path(ref_envelope, take_envelope, guide)
    if len(refined) >= 2:
        first = np.array(refined)
        fine = refine_path(
            ref_envelope,
            take_envelope,
            (first[:, 0], first[:, 1], 0.0),
            window=REFINE_FINE_WINDOW,
            radius=REFINE_FINE_RADIUS,
        )
        if len(fine[0]) >= 2:
            return fine
    return refined, matched, tried


def harmonize(
    ref_path: str,
    take_paths: list[str],
    options: dict[str, float] | None = None,
    no_retime: frozenset[str] = frozenset(),
    on_progress: Callable[[str, float, str], None] = lambda phase, fraction, detail: None,
    is_cancelled: Callable[[], bool] = lambda: False,
) -> dict[str, Any]:
    """Aligns each take to the reference (see the module header). Takes are named by their path;
    `no_retime` lists paths of takes known to share the reference's sound (fed from the same recorder),
    which get one stretch at exactly 1x. Returns the report: per take, the stretches mapping reference
    time to take time, plus where it starts (lead-in and offset) and a confidence out of 100 (the share
    of line windows or note matches that agreed). `anchor_count` and `skipped_anchors` count the
    note-matching points tried and the ones too weak to use.

    `on_progress(phase, fraction, detail)` reports "read", "offset", "anchors" and "solve" in turn,
    `fraction` covering the whole job. Only the reference and the take being matched are in memory."""
    opts = {**DEFAULTS, **(options or {})}

    def check():
        if is_cancelled():
            raise Cancelled()

    names = list(take_paths)
    check()
    on_progress("read", 0.0, f"Reading {os.path.basename(ref_path)}")
    ref_audio = load_mono(ref_path)
    ref_duration = len(ref_audio) / SR
    ref_envelope = _onset_envelope(ref_audio)
    ref_notes = None  # the reference's notes, found once for the first take that needs them

    segments, offsets, confidence, leadin, skipped, take_durations, same = {}, {}, {}, {}, {}, {}, {}
    anchor_count = 0
    for i, name in enumerate(names):
        base = 0.1 + 0.9 * i / len(names)
        share = 0.9 / len(names)
        label = os.path.basename(name)

        check()
        on_progress("read", base, f"Reading {label}")
        take = load_mono(name)
        take_duration = len(take) / SR
        take_durations[name] = take_duration

        check()
        on_progress("offset", base + 0.2 * share, f"Finding where {label} sits in the reference")
        guide = chroma_guide(ref_audio, take)

        check()
        on_progress("anchors", base + 0.5 * share, f"Matching {label} note by note")
        line = same_performance_line(ref_audio, take, guide)
        same[name] = line is not None
        if name in no_retime:
            # Same recorder: the same pace by definition, so one stretch at exactly 1x.
            ref_t, take_t, _ = guide
            offset = line[1] + (line[0] - 1) * ref_t[0] if line else float(np.median(take_t - ref_t))
            points = _extend_to_overlap(
                [(ref_t[0], ref_t[0] + offset), (ref_t[-1], ref_t[-1] + offset)], ref_duration, take_duration
            )
            confidence[name] = 100.0 * line[2] if line else 0.0
            skipped[name] = 0
        elif line:
            slope, intercept, inlier_share = line
            ref_t = guide[0]
            points = _extend_to_overlap(
                [(ref_t[0], slope * ref_t[0] + intercept), (ref_t[-1], slope * ref_t[-1] + intercept)],
                ref_duration,
                take_duration,
            )
            confidence[name] = 100.0 * inlier_share
            skipped[name] = 0
        else:
            if ref_notes is None:
                ref_notes = onset_notes(ref_audio)
            pairs, matched, tried = onset_pairs(ref_notes, onset_notes(take), guide)
            if len(pairs) >= MIN_PAIRS:
                refined = fill_gaps(pairs, guide)
            else:
                refined, matched, tried = _envelope_path(ref_envelope, _onset_envelope(take), guide)
            if len(refined) < 2:
                ref_t, take_t, _ = guide
                refined = [(ref_t[0], take_t[0]), (ref_t[-1], take_t[-1])]
            points = _extend_to_overlap(
                remove_stutters(simplify_path(_clamp_speeds(refined))), ref_duration, take_duration
            )
            anchor_count = max(anchor_count, tried)
            confidence[name] = 100.0 * matched / tried if tried else 0.0
            skipped[name] = tried - matched
        del take

        check()
        on_progress("solve", base + 0.9 * share, f"Working out {label}'s speed changes")
        leadin[name] = points[0][0]
        offsets[name] = points[0][1] - points[0][0]
        path = [{"ref_time": r, "take_time": t} for r, t in points]
        segments[name] = segments_from_path(
            path, opts["merge_tolerance"], opts["flag_speed_min"], opts["flag_speed_max"]
        )

    on_progress("solve", 1.0, "Done")
    return {
        "reference": ref_path,
        "takes": names,
        "ref_duration": ref_duration,
        "take_durations": take_durations,
        "coarse_offsets_sec": offsets,
        "coarse_offset_confidence": confidence,
        "anchor_count": anchor_count,
        "segments": segments,
        "skipped_anchors": skipped,
        "excluded_leadin_ref_sec": leadin,
        "same_performance": same,
        "merge_tolerance": opts["merge_tolerance"],
        "flag_speed_min": opts["flag_speed_min"],
        "flag_speed_max": opts["flag_speed_max"],
    }


# ---- The command ----


def _number(request: dict[str, Any], key: str, low: float, high: float) -> float | None:
    value = request.get(key)
    if value is None:
        return None
    if not isinstance(value, (int, float)) or isinstance(value, bool) or not low <= value <= high:
        raise RequestError(f"{key} must be a number from {low} to {high}")
    return float(value)


def validate(request: dict[str, Any]) -> dict[str, Any]:
    reference = request.get("referencePath")
    if not isinstance(reference, str) or not reference:
        raise RequestError("Choose the reference recording first")
    takes = request.get("takePaths")
    if not isinstance(takes, list) or not takes or not all(isinstance(t, str) and t for t in takes):
        raise RequestError("Choose at least one take to line up")
    if len(takes) > MAX_TAKES:
        raise RequestError(f"At most {MAX_TAKES} takes can be lined up at once")
    if len(set(takes)) != len(takes):
        raise RequestError("The same take is listed twice")
    if reference in takes:
        raise RequestError("The reference recording can't also be a take")
    require_absolute_paths([reference, *takes], "media file")
    for path in [reference, *takes]:
        if not os.path.isfile(path):
            raise RequestError(f"File not found (is its drive attached?): {path}")
    no_retime = request.get("noRetime") or []
    if not isinstance(no_retime, list) or any(p not in takes for p in no_retime):
        raise RequestError("noRetime must list takes from takePaths")
    options = {}
    for key, option, low, high in (
        ("mergeTolerance", "merge_tolerance", 0.0, 0.5),
        ("flagSpeedMin", "flag_speed_min", 0.05, 1.0),
        ("flagSpeedMax", "flag_speed_max", 1.0, 20.0),
    ):
        value = _number(request, key, low, high)
        if value is not None:
            options[option] = value
    return {"reference": reference, "takes": takes, "noRetime": frozenset(no_retime), "options": options}


def _usable(seg: dict[str, Any]) -> bool:
    """A stretch with finite times that moves forward in reference time. A take that isn't the reference's
    piece at all can come out of the matching with a stretch of no length (a NaN pace); the protocol refuses
    NaN, so the whole result would be lost."""
    times = [seg["ref_start"], seg["ref_end"], seg["take_start"], seg["take_end"]]
    return all(math.isfinite(t) for t in times) and seg["ref_end"] > seg["ref_start"]


def _finite(value: float) -> float:
    return float(value) if math.isfinite(value) else 0.0


def to_result(report: dict[str, Any]) -> dict[str, Any]:
    """The alignment report in the shape the app reads (camelCase, one entry per take)."""
    takes = []
    for path in report["takes"]:
        segments = [
            {
                "refStart": float(seg["ref_start"]),
                "refEnd": float(seg["ref_end"]),
                "takeStart": float(seg["take_start"]),
                "takeEnd": float(seg["take_end"]),
                "flagged": bool(seg["flagged"]),
            }
            for seg in report["segments"][path]
            if _usable(seg)
        ]
        takes.append(
            {
                "path": path,
                "duration": report["take_durations"][path],
                "offset": _finite(report["coarse_offsets_sec"][path]),
                "offsetConfidence": _finite(report["coarse_offset_confidence"][path]),
                "leadIn": _finite(report["excluded_leadin_ref_sec"][path]),
                "skippedAnchors": report["skipped_anchors"][path],
                "flaggedCount": sum(1 for s in segments if s["flagged"]),
                "sameRecording": bool(report.get("same_performance", {}).get(path, False)),
                "segments": segments,
            }
        )
    return {
        "referencePath": report["reference"],
        "referenceDuration": report["ref_duration"],
        "anchorCount": report["anchor_count"],
        "takes": takes,
    }


def run(raw_request: dict[str, Any], emitter: Emitter) -> int:
    request = validate(raw_request)

    def on_progress(phase: str, fraction: float, detail: str) -> None:
        emitter.progress(fraction, 1.0, phase=phase, detail=detail)

    try:
        import librosa  # noqa: F401 - the `harmonize` extra; slow to import, so only once the request is good
    except ImportError:
        emitter.error("Harmonizer needs the `harmonize` extra (librosa); the app installs it on first use")
        return 1
    try:
        report = harmonize(
            request["reference"],
            request["takes"],
            request["options"],
            no_retime=request["noRetime"],
            on_progress=on_progress,
        )
    except AlignError as exc:
        emitter.error(str(exc))
        return 1
    emitter.emit("result", cancelled=False, **to_result(report))
    return 0
