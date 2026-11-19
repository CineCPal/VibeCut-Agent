"""Transcript recall and alignment (PLAN.md, "Transcription recall + alignment"): Whisper's lines checked
against the sound itself.

Whisper misses audible speech (a 30 s window it judged silent is skipped whole) and its timings are loose
(word times from cross-attention start late or early and end early; segment times are coarser still), so
cuts made on them clip the first and last syllables. After Whisper runs, the extracted 16 kHz WAV is read
once more, through an ffmpeg pipe a chunk at a time, into a `SpeechMap`:

- Silero VAD speech probabilities every 32 ms (the vendored `assets/silero_vad_v6.onnx`, MIT, run on the
  CPU with onnxruntime, its state carried from one chunk to the next); and
- the sound's level every 10 ms, in dBFS.

From those:

- `speech_regions`: where someone is talking (VAD, hysteresis 0.5 on / 0.35 off).
- `recover_missed`: regions Whisper left mostly without words are transcribed again, all in one
  clip-limited call with Whisper's skip gates off, and their words merged in.
- `drop_hallucinations`: a low-confidence line over silence ("Thanks for watching.") is removed.
- `refine_words`: the words at a phrase's edges are moved onto the sound: a start back to the onset, an end
  on through the decay. Each line's start and end become its first word's start and last word's end.

Without onnxruntime the level alone stands in for the VAD. Where the level barely moves (music, constant
noise: under 12 dB between the 20th and 90th percentile over +-5 s), no word is moved.

Segments here are Whisper's raw dicts (start, end, text, avg_logprob, no_speech_prob, words), the shape
pipeline.merge_transcript_and_speakers reads; words are {start, end, text, probability?}."""

from __future__ import annotations

import math
import sys
from collections.abc import Callable, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import numpy as np

from vibecut_agent.core import ffmpeg_ops

SAMPLE_RATE = 16000
VAD_HOP = 512  # 32 ms: what Silero v6 takes at 16 kHz
VAD_CONTEXT = 64  # samples of the previous hop each hop is given
VAD_SECONDS = VAD_HOP / SAMPLE_RATE
ENERGY_HOP = 160  # 10 ms
ENERGY_SECONDS = ENERGY_HOP / SAMPLE_RATE
VAD_BATCH_HOPS = 256  # about 8 s of sound per onnxruntime call
MODEL_PATH = Path(__file__).with_name("assets") / "silero_vad_v6.onnx"
READ_TIMEOUT_S = 3 * 3600.0

# Speech regions (decided; PLAN.md).
SPEECH_ON = 0.5
SPEECH_OFF = 0.35
MIN_SPEECH_S = 0.25
MERGE_GAP_S = 0.3
REGION_PAD_S = 0.1

# Word edges (decided; PLAN.md).
EDGE_GAP_S = 0.25  # a word next to a pause this long is at a phrase's edge
ONSET_BACK_MAX_S = 0.4
# A start in silence moves on to the sound this far at most (never past the word's own end): Whisper
# often opens a line's first word over the pause before it (0.4 s on large-v3-turbo in testing).
ONSET_FORWARD_MAX_S = 1.0
SNAP_MAX_S = 0.3  # a line without words: its edges onto a speech region's this close
DECAY_FORWARD_MAX_S = 0.6
TRIM_SILENCE_S = 0.5  # an end is pulled back only past this much silence...
TRIM_TAIL_S = 0.08  # ...and keeps this much after the last sound
MIN_WORD_S = 0.05
BRIDGE_FRAMES = 3  # a dip this many 10 ms frames long doesn't end a sound
FLOOR_WINDOW_S = 5.0
FLOOR_PERCENTILE = 20
PEAK_PERCENTILE = 90
ACTIVE_DB = 6.0  # above the local floor by this much is sound
MIN_RANGE_DB = 12.0  # less movement than this between floor and peak: leave the words alone
SILENT_DBFS = -50.0
LEVEL_FLOOR_DBFS = -100.0

# Recovery and hallucinations (decided; PLAN.md).
RECOVER_MIN_S = 0.3
RECOVER_COVERAGE = 0.5
RECOVER_PAD_S = 0.25
HALLUCINATION_SPEECH = 0.15

RawSegment = dict[str, Any]
# Transcribes only `clips` ([(start, end)] seconds) of the WAV, in `language` when known: Whisper's raw
# segments with times in the whole file's seconds.
ClipTranscriber = Callable[[list[tuple[float, float]], str | None], list[RawSegment]]
Region = tuple[float, float]


def vad_available() -> bool:
    try:
        import onnxruntime  # noqa: F401
    except ImportError:
        return False
    return MODEL_PATH.is_file()


class _Silero:
    """Silero VAD v6, fed one batch of 512-sample hops at a time with its state carried over."""

    def __init__(self) -> None:
        import onnxruntime

        options = onnxruntime.SessionOptions()
        options.inter_op_num_threads = 1
        options.intra_op_num_threads = 1
        options.enable_cpu_mem_arena = False
        options.log_severity_level = 4
        self.session = onnxruntime.InferenceSession(
            str(MODEL_PATH), providers=["CPUExecutionProvider"], sess_options=options
        )
        self.h = np.zeros((1, 1, 128), dtype=np.float32)
        self.c = np.zeros((1, 1, 128), dtype=np.float32)
        self.context = np.zeros(VAD_CONTEXT, dtype=np.float32)

    def __call__(self, audio: np.ndarray) -> np.ndarray:
        hops = audio.reshape(-1, VAD_HOP)
        contexts = np.concatenate([self.context[None, :], hops[:-1, -VAD_CONTEXT:]], axis=0)
        batch = np.concatenate([contexts, hops], axis=1).astype(np.float32)
        out, self.h, self.c = self.session.run(None, {"input": batch, "h": self.h, "c": self.c})
        self.context = hops[-1, -VAD_CONTEXT:].copy()
        return np.asarray(out, dtype=np.float32).reshape(-1)


@dataclass
class SpeechMap:
    """The sound of one file: speech probability per 32 ms hop (None without the VAD) and level in dBFS
    per 10 ms frame, with each second's local floor and whether its level moves enough to read."""

    vad: np.ndarray | None
    level_db: np.ndarray
    duration: float
    floor_db: np.ndarray  # per second
    readable: np.ndarray  # per second, bool

    @classmethod
    def from_arrays(cls, level_db: np.ndarray, vad: np.ndarray | None = None) -> SpeechMap:
        level = np.asarray(level_db, dtype=np.float32)
        duration = len(level) * ENERGY_SECONDS
        seconds = max(1, math.ceil(duration))
        per = round(1 / ENERGY_SECONDS)
        floor = np.full(seconds, LEVEL_FLOOR_DBFS, dtype=np.float32)
        readable = np.zeros(seconds, dtype=bool)
        window = round(FLOOR_WINDOW_S)
        for second in range(seconds):
            part = level[max(0, (second - window) * per) : (second + window + 1) * per]
            if part.size == 0:
                continue
            low, high = np.percentile(part, [FLOOR_PERCENTILE, PEAK_PERCENTILE])
            floor[second] = low
            readable[second] = high - low >= MIN_RANGE_DB
        return cls(
            vad=None if vad is None else np.asarray(vad, dtype=np.float32),
            level_db=level,
            duration=duration,
            floor_db=floor,
            readable=readable,
        )

    def _second(self, frame: int) -> int:
        return min(len(self.floor_db) - 1, max(0, int(frame * ENERGY_SECONDS)))

    def frame(self, seconds: float) -> int:
        return min(len(self.level_db) - 1, max(0, int(seconds / ENERGY_SECONDS)))

    def readable_at(self, seconds: float) -> bool:
        return bool(len(self.level_db)) and bool(self.readable[self._second(self.frame(seconds))])

    def active(self, frame: int) -> bool:
        """Whether 10 ms frame `frame` has sound in it: above its floor by ACTIVE_DB where the level is
        readable, else just above SILENT_DBFS."""
        if not 0 <= frame < len(self.level_db):
            return False
        second = self._second(frame)
        level = float(self.level_db[frame])
        if not self.readable[second]:
            return level > SILENT_DBFS
        return level > max(float(self.floor_db[second]) + ACTIVE_DB, SILENT_DBFS)

    def speech_probabilities(self) -> tuple[np.ndarray, float]:
        """(probability per hop, hop seconds): the VAD's, or 1/0 from the level where it is readable."""
        if self.vad is not None:
            return self.vad, VAD_SECONDS
        # Without the VAD, sound counts as speech only where the level is readable: constant music or
        # noise would otherwise be one long "speech" region for recovery to transcribe.
        seconds = np.minimum(
            (np.arange(len(self.level_db)) * ENERGY_SECONDS).astype(int), len(self.floor_db) - 1
        )
        threshold = np.maximum(self.floor_db[seconds] + ACTIVE_DB, SILENT_DBFS)
        active = (self.level_db > threshold) & self.readable[seconds]
        return active.astype(np.float32), ENERGY_SECONDS


def build_speech_map(wav_path: str, use_vad: bool = True) -> SpeechMap:
    """One pass over a 16 kHz WAV (or any file ffmpeg reads) through a pipe: level every 10 ms and, with
    onnxruntime, Silero's speech probability every 32 ms."""
    silero = _Silero() if use_vad and vad_available() else None
    levels: list[np.ndarray] = []
    probabilities: list[np.ndarray] = []
    pending = np.zeros(0, dtype=np.float32)
    lcm = VAD_HOP * ENERGY_HOP // math.gcd(VAD_HOP, ENERGY_HOP)  # 2560 samples: whole hops of both
    block = lcm * max(1, (VAD_HOP * VAD_BATCH_HOPS) // lcm)
    total = 0

    def consume(audio: np.ndarray) -> None:
        frames = audio.reshape(-1, ENERGY_HOP)
        rms = np.sqrt(np.mean(frames.astype(np.float64) ** 2, axis=1))
        levels.append(np.maximum(20 * np.log10(np.maximum(rms, 1e-10)), LEVEL_FLOOR_DBFS).astype(np.float32))
        if silero is not None:
            probabilities.append(silero(audio))

    def take(samples: Any) -> None:
        nonlocal pending, total
        chunk = np.frombuffer(samples, dtype=np.int16).astype(np.float32) / 32768.0
        total += len(chunk)
        pending = np.concatenate([pending, chunk])
        whole = len(pending) - len(pending) % block
        if whole:
            consume(pending[:whole])
            pending = pending[whole:]

    process = ffmpeg_ops._audio_pipe(wav_path, 0.0, READ_TIMEOUT_S * 10, SAMPLE_RATE)
    ffmpeg_ops._read_samples(process, sys.maxsize, take, READ_TIMEOUT_S)
    if len(pending):
        consume(np.pad(pending, (0, -len(pending) % lcm)))
    # The zeros that filled out the last block aren't sound: frames past the real end are dropped.
    level = np.concatenate(levels)[: math.ceil(total / ENERGY_HOP)] if levels else np.zeros(0, np.float32)
    vad = np.concatenate(probabilities)[: math.ceil(total / VAD_HOP)] if probabilities else None
    return SpeechMap.from_arrays(level, vad)


def speech_regions(speech: SpeechMap) -> list[Region]:
    """Where someone is talking: speech probability on at SPEECH_ON and off below SPEECH_OFF, runs under
    MIN_SPEECH_S dropped, runs closer than MERGE_GAP_S joined, each padded by REGION_PAD_S."""
    probabilities, hop = speech.speech_probabilities()
    runs: list[list[float]] = []
    start: float | None = None
    for index, probability in enumerate(probabilities):
        if start is None and probability >= SPEECH_ON:
            start = index * hop
        elif start is not None and probability < SPEECH_OFF:
            runs.append([start, index * hop])
            start = None
    if start is not None:
        runs.append([start, len(probabilities) * hop])
    merged: list[list[float]] = []
    for run in runs:
        if merged and run[0] - merged[-1][1] < MERGE_GAP_S:
            merged[-1][1] = run[1]
        else:
            merged.append(run)
    end = speech.duration
    return [
        (max(0.0, s - REGION_PAD_S), min(end, e + REGION_PAD_S)) for s, e in merged if e - s >= MIN_SPEECH_S
    ]


def _overlap(a_start: float, a_end: float, b_start: float, b_end: float) -> float:
    return max(0.0, min(a_end, b_end) - max(a_start, b_start))


def _spans(segments: Sequence[RawSegment]) -> list[Region]:
    """What the transcript covers: its words, or a line's own span when it has none."""
    spans: list[Region] = []
    for seg in segments:
        words = seg.get("words") or []
        if words:
            spans.extend((float(w["start"]), float(w["end"])) for w in words)
        else:
            spans.append((float(seg["start"]), float(seg["end"])))
    return sorted(spans)


def uncovered(segments: Sequence[RawSegment], regions: Sequence[Region]) -> list[Region]:
    """Speech regions of RECOVER_MIN_S or more that the transcript covers less than RECOVER_COVERAGE of."""
    spans = _spans(segments)
    missed = []
    for start, end in regions:
        length = end - start
        if length < RECOVER_MIN_S:
            continue
        covered = sum(_overlap(start, end, s, e) for s, e in spans if e > start and s < end)
        if covered / length < RECOVER_COVERAGE:
            missed.append((start, end))
    return missed


def recover_missed(
    segments: list[RawSegment],
    regions: Sequence[Region],
    transcribe_clips: ClipTranscriber,
    duration: float,
    language: str | None = None,
) -> list[RawSegment]:
    """`segments` with Whisper's second look at the speech it left out: every missed region (padded by
    RECOVER_PAD_S) in one call. A recovered word is kept when it overlaps a missed region and its middle
    isn't inside a word already there; a recovered line is its kept words. In time order."""
    missed = uncovered(segments, regions)
    if not missed:
        return segments
    clips = [(max(0.0, s - RECOVER_PAD_S), min(duration, e + RECOVER_PAD_S)) for s, e in missed]
    found = transcribe_clips(clips, language)
    existing = _spans(segments)

    def wanted(start: float, end: float) -> bool:
        # On the missed speech at all (Whisper often stretches a first word back into the padding), and
        # not on a word already there.
        middle = (start + end) / 2
        return any(_overlap(start, end, s, e) > 0 for s, e in missed) and not any(
            s <= middle <= e for s, e in existing
        )

    recovered: list[RawSegment] = []
    for seg in found:
        text = str(seg.get("text") or "").strip()
        words = [w for w in seg.get("words") or [] if wanted(float(w["start"]), float(w["end"]))]
        if words:
            recovered.append(
                {
                    **seg,
                    "start": float(words[0]["start"]),
                    "end": float(words[-1]["end"]),
                    "text": " ".join(str(w["text"]).strip() for w in words),
                    "words": words,
                }
            )
        elif text and not seg.get("words") and wanted(float(seg["start"]), float(seg["end"])):
            recovered.append({**seg, "text": text})
    return sorted([*segments, *recovered], key=lambda s: (float(s["start"]), float(s["end"])))


def _low_confidence(seg: RawSegment) -> bool:
    from vibecut_agent.transcribe import pipeline

    return (
        float(seg.get("avg_logprob", 0.0)) < pipeline.LOW_CONFIDENCE_AVG_LOGPROB
        or float(seg.get("no_speech_prob", 0.0)) > pipeline.LOW_CONFIDENCE_NO_SPEECH_PROB
    )


def _quiet(speech: SpeechMap, start: float, end: float) -> bool:
    """Whether at least 1 - HALLUCINATION_SPEECH of [start, end) has no sound in it."""
    first, last = speech.frame(start), speech.frame(end)
    frames = range(first, max(first + 1, last))
    active = sum(1 for f in frames if speech.active(f))
    return active / len(frames) < HALLUCINATION_SPEECH


def drop_hallucinations(
    segments: list[RawSegment], speech: SpeechMap, regions: Sequence[Region]
) -> list[RawSegment]:
    """`segments` without the lines Whisper made up over silence: low confidence, under
    HALLUCINATION_SPEECH of the line in a speech region, and the sound there mostly silent."""
    kept = []
    for seg in segments:
        start, end = float(seg["start"]), float(seg["end"])
        length = max(end - start, 1e-6)
        in_speech = sum(_overlap(start, end, s, e) for s, e in regions) / length
        if _low_confidence(seg) and in_speech < HALLUCINATION_SPEECH and _quiet(speech, start, end):
            continue
        kept.append(seg)
    return kept


def _onset(speech: SpeechMap, start: float, end: float, earliest: float) -> float | None:
    """Where the sound under a word that starts at `start` really starts, or None to leave it."""
    if not speech.readable_at(start):
        return None
    frame = speech.frame(start)
    if speech.active(frame):
        limit = speech.frame(max(earliest, start - ONSET_BACK_MAX_S, 0.0))
        onset, gap, probe = frame, 0, frame - 1
        while probe >= limit:
            if speech.active(probe):
                onset, gap = probe, 0
            else:
                gap += 1
                if gap > BRIDGE_FRAMES:
                    break
            probe -= 1
        return max(earliest, onset * ENERGY_SECONDS)
    # Starts in silence: on to the first sound, not past the word's own end.
    reach = min(ONSET_FORWARD_MAX_S, end - start - MIN_WORD_S)
    if reach <= 0:
        return None
    for probe in range(frame + 1, speech.frame(start + reach) + 1):
        if speech.active(probe):
            return probe * ENERGY_SECONDS
    return None


def _offset(speech: SpeechMap, start: float, end: float, latest: float) -> float | None:
    """Where the sound under a word that ends at `end` really ends, or None to leave it."""
    probe_at = max(start, end - ENERGY_SECONDS)
    if not speech.readable_at(probe_at):
        return None
    frame = speech.frame(probe_at)
    if speech.active(frame):
        limit = speech.frame(min(latest, end + DECAY_FORWARD_MAX_S, speech.duration))
        last, gap, probe = frame, 0, frame + 1
        while probe <= limit:
            if speech.active(probe):
                last, gap = probe, 0
            else:
                gap += 1
                if gap > BRIDGE_FRAMES:
                    break
            probe += 1
        return min(latest, (last + 1) * ENERGY_SECONDS)
    # Ends in silence: pulled back only when the silence after the last sound is long.
    first = speech.frame(start)
    for probe in range(frame, first - 1, -1):
        if speech.active(probe):
            sound_end = (probe + 1) * ENERGY_SECONDS
            if end - sound_end > TRIM_SILENCE_S:
                return max(start + MIN_WORD_S, sound_end + TRIM_TAIL_S)
            return None
    return None


def refine_words(
    segments: list[RawSegment], speech: SpeechMap, regions: Sequence[Region]
) -> list[RawSegment]:
    """`segments` (in time order) with the words at phrase edges moved onto the sound, and each line's
    start and end on its first and last word. Words never cross their neighbours."""
    flat: list[tuple[int, int]] = [
        (si, wi) for si, seg in enumerate(segments) for wi, _ in enumerate(seg.get("words") or [])
    ]
    words_of = [[dict(w) for w in seg.get("words") or []] for seg in segments]
    moved_start: set[tuple[int, int]] = set()
    moved_end: set[tuple[int, int]] = set()
    for k, (si, wi) in enumerate(flat):
        word = words_of[si][wi]
        start, end = float(word["start"]), float(word["end"])
        before = words_of[flat[k - 1][0]][flat[k - 1][1]] if k > 0 else None
        after = words_of[flat[k + 1][0]][flat[k + 1][1]] if k + 1 < len(flat) else None
        earliest = float(before["end"]) if before else 0.0
        latest = float(after["start"]) if after else speech.duration
        first_word = wi == 0
        last_word = wi == len(words_of[si]) - 1
        new_start, new_end = start, end
        if first_word or start - earliest >= EDGE_GAP_S:
            onset = _onset(speech, start, end, earliest)
            if onset is not None:
                new_start = onset
        if last_word or latest - end >= EDGE_GAP_S:
            offset = _offset(speech, new_start, end, latest)
            if offset is not None:
                new_end = offset
        if new_end - new_start < MIN_WORD_S:
            continue
        if new_start != start:
            moved_start.add((si, wi))
        if new_end != end:
            moved_end.add((si, wi))
        word["start"], word["end"] = round(new_start, 3), round(new_end, 3)
    out = []
    for si, seg in enumerate(segments):
        words = words_of[si]
        start, end = float(seg["start"]), float(seg["end"])
        if words:
            first, last = words[0], words[-1]
            # A word that was read against the sound sets the line's edge; one that couldn't be read
            # keeps whichever of Whisper's two times leaves more of the line in.
            start = float(first["start"]) if (si, 0) in moved_start else min(start, float(first["start"]))
            end = float(last["end"]) if (si, len(words) - 1) in moved_end else max(end, float(last["end"]))
        else:
            start, end = _snap_to_regions(start, end, regions)
        out.append(
            {**seg, "start": round(start, 3), "end": round(max(end, start), 3), "words": words or None}
        )
    return out


def _snap_to_regions(start: float, end: float, regions: Sequence[Region]) -> tuple[float, float]:
    """A line without words: its edges onto the nearest speech region edge within SNAP_MAX_S."""
    starts = [s for s, _ in regions if abs(s - start) <= SNAP_MAX_S]
    ends = [e for _, e in regions if abs(e - end) <= SNAP_MAX_S]
    new_start = min(starts, key=lambda s: abs(s - start)) if starts else start
    new_end = min(ends, key=lambda e: abs(e - end)) if ends else end
    return (new_start, new_end) if new_end > new_start else (start, end)


def align(
    segments: list[RawSegment],
    speech: SpeechMap,
    transcribe_clips: ClipTranscriber | None = None,
    language: str | None = None,
) -> list[RawSegment]:
    """Whisper's raw segments checked against the sound: missed speech recovered (when a clip transcriber
    is given), lines made up over silence dropped, word and line edges put on the sound."""
    regions = speech_regions(speech)
    ordered = sorted(segments, key=lambda s: (float(s["start"]), float(s["end"])))
    if transcribe_clips is not None:
        ordered = recover_missed(ordered, regions, transcribe_clips, speech.duration, language)
    ordered = drop_hallucinations(ordered, speech, regions)
    return refine_words(ordered, speech, regions)


def shift(segments: list[Any], offset: float) -> list[Any]:
    """Segments (raw dicts or pipeline Segments) moved by `offset` seconds, so their times count from the
    picture's start rather than the first audio sample. Words before 0 are dropped, and a line left
    entirely before 0 with it."""
    if not offset:
        return segments
    out = []
    for seg in segments:
        is_dict = isinstance(seg, dict)
        get = seg.get if is_dict else (lambda k, s=seg: getattr(s, k))
        words = [
            {**w, "start": round(max(0.0, w["start"] + offset), 3), "end": round(w["end"] + offset, 3)}
            for w in get("words") or []
            if w["end"] + offset > 0
        ]
        start, end = float(get("start")) + offset, float(get("end")) + offset
        if end <= 0:
            continue
        changes = {"start": round(max(0.0, start), 3), "end": round(end, 3), "words": words or None}
        if is_dict:
            out.append({**seg, **changes})
        else:
            for key, value in changes.items():
                setattr(seg, key, value)
            out.append(seg)
    return out
