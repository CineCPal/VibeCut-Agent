"""The `media-beats` command (PLAN.md, "Phase 13d"): the tempo and beats of a piece of music, so the agent
can cut to them.

request: {"path", "start" (s, default 0), "end" (s, optional: to the end)}
result: {"bpm", "confidence" (0-1), "beats": [seconds into the file], "start", "end"}

numpy only, on the 8 kHz mono decode find_silences uses (peaks.decode): a spectral-flux onset envelope,
its tempo by autocorrelation (weighted toward 120 BPM, as librosa does), and the beats by dynamic
programming (D. Ellis, "Beat Tracking by Dynamic Programming", 2007). Good on music with a steady pulse;
for rubato or ambient music the confidence is low and the agent is told so.
"""

from __future__ import annotations

import math
import os
from typing import Any

import numpy as np

from vibecut_agent.peaks import SAMPLE_RATE, decode
from vibecut_agent.protocol import Emitter, RequestError, require_absolute_paths

FRAME = 512
HOP = 128
FPS = SAMPLE_RATE / HOP
MIN_BPM, MAX_BPM = 60.0, 200.0
PRIOR_BPM = 120.0
TIGHTNESS = 100.0
MIN_SECONDS = 4.0
MAX_SECONDS = 20 * 60.0


def onset_envelope(samples: np.ndarray) -> np.ndarray:
    """How much new sound starts in each hop: the positive change in log magnitude, summed over
    frequencies, with its slow trend taken out."""
    x = samples.astype(np.float32) / 32768.0
    if len(x) < FRAME:
        return np.zeros(0, dtype=np.float32)
    count = 1 + (len(x) - FRAME) // HOP
    frames = np.lib.stride_tricks.as_strided(
        x, shape=(count, FRAME), strides=(x.strides[0] * HOP, x.strides[0])
    )
    spectrum = np.log1p(100.0 * np.abs(np.fft.rfft(frames * np.hanning(FRAME).astype(np.float32), axis=1)))
    flux = np.maximum(0.0, np.diff(spectrum, axis=0)).sum(axis=1)
    flux = np.concatenate([[0.0], flux])
    trend = np.convolve(flux, np.ones(int(FPS / 2)) / int(FPS / 2), mode="same")
    envelope: np.ndarray = np.maximum(0.0, flux - trend).astype(np.float32)
    spread = float(envelope.std())
    return envelope / spread if spread > 0 else envelope


def tempo(envelope: np.ndarray) -> tuple[float, float]:
    """(period in hops, confidence 0-1): the autocorrelation's strongest lag between MIN_BPM and
    MAX_BPM, weighted toward PRIOR_BPM."""
    shortest, longest = int(FPS * 60 / MAX_BPM), math.ceil(FPS * 60 / MIN_BPM)
    centred = envelope - envelope.mean()
    full = np.correlate(centred, centred, mode="full")[len(centred) - 1 :]
    if len(full) <= longest + 1 or full[0] <= 0:
        return 0.0, 0.0
    lags = np.arange(shortest, longest + 1)
    bpm = 60.0 * FPS / lags
    weighted = full[lags] * np.exp(-0.5 * np.log2(bpm / PRIOR_BPM) ** 2)
    best = int(np.argmax(weighted))
    lag = float(lags[best])
    if 0 < best < len(lags) - 1:
        # Parabolic interpolation between the lags either side.
        a, b, c = full[lags[best] - 1], full[lags[best]], full[lags[best] + 1]
        denominator = a - 2 * b + c
        if denominator < 0:
            # float(): numpy 2 keeps float32 here, which the protocol would write as a string.
            lag += float(0.5 * (a - c) / denominator)
    confidence = float(max(0.0, min(1.0, full[lags[best]] / full[0])))
    return lag, confidence


def track(envelope: np.ndarray, period: float) -> list[int]:
    """The hops the beats fall on: the path through the envelope that best keeps to `period`."""
    n = len(envelope)
    if n == 0 or period <= 0:
        return []
    score = envelope.astype(np.float64).copy()
    back = np.full(n, -1)
    low, high = round(period / 2), round(2 * period)
    for t in range(n):
        first, last = max(0, t - high), t - low
        if last <= first:
            continue
        prev = np.arange(first, last)
        penalty = -TIGHTNESS * np.log((t - prev) / period) ** 2
        options = score[prev] + penalty
        best = int(np.argmax(options))
        score[t] = envelope[t] + options[best]
        back[t] = prev[best]
    tail = max(1, round(period))
    t = int(n - tail + np.argmax(score[n - tail :]))
    beats = []
    while t >= 0:
        beats.append(t)
        t = int(back[t])
    return beats[::-1]


def beats_of(samples: np.ndarray) -> dict[str, Any]:
    envelope = onset_envelope(samples)
    period, confidence = tempo(envelope)
    hops = track(envelope, period) if confidence > 0 else []
    # A hop's onset is heard at its frame's centre.
    offset = (FRAME / 2) / SAMPLE_RATE
    bpm = round(float(60.0 * FPS / period), 1) if period else None
    return {
        "bpm": bpm,
        # A fast piece is often heard at half its tempo (174 reads as 87): say so rather than guess.
        **({"maybeDoubleTime": round(bpm * 2, 1)} if bpm and bpm < 95 else {}),
        "confidence": round(confidence, 2),
        "beats": [round(float(h / FPS + offset), 3) for h in hops],
    }


def run(request: dict[str, Any], emitter: Emitter) -> int:
    path = request.get("path")
    require_absolute_paths([path], "media file")
    start = request.get("start", 0)
    end = request.get("end")
    if not isinstance(start, (int, float)) or isinstance(start, bool) or start < 0:
        raise RequestError("start must be 0 or more seconds")
    if end is not None and (not isinstance(end, (int, float)) or isinstance(end, bool) or end <= start):
        raise RequestError("end must be after start")
    if not os.path.isfile(str(path)):
        emitter.error("The file isn't there (is its drive attached?)")
        return 1
    emitter.progress(0, 1, phase="listening", detail=os.path.basename(str(path)))
    samples = decode(str(path))
    first = int(start * SAMPLE_RATE)
    last = len(samples) if end is None else min(len(samples), int(end * SAMPLE_RATE))
    part = samples[first:last]
    seconds = len(part) / SAMPLE_RATE
    if seconds < MIN_SECONDS:
        emitter.error(f"Beats need at least {MIN_SECONDS:g} s of music; this part is {seconds:.1f} s")
        return 1
    if seconds > MAX_SECONDS:
        emitter.error(f"Beats are found in at most {MAX_SECONDS / 60:g} minutes at once; give start and end")
        return 1
    found = beats_of(part)
    found["beats"] = [round(start + b, 3) for b in found["beats"]]
    emitter.progress(1, 1, phase="done", detail="")
    emitter.emit("result", **found, start=start, end=round(start + seconds, 3))
    return 0
