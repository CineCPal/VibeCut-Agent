"""The `audio-peaks` sidecar command (PLAN.md, "Phase 6b"): each file's sound as peak levels, the
`WaveformPeaks` shape VibeCut's silence finder reads (src/vibecut/lib/silence.ts). It replaces VibeCut's
Rust waveform cache for the agent's find_silences.

request: {"paths": [absolute media files], "peaksPerSecond": 50}
result: {"peaks": {path: {"peaksPerSecond", "mins", "maxes"}}, "failed": [{"path", "message"}]}
Levels are -1..1 (full scale), one (min, max) pair per 1/peaksPerSecond seconds, mono (all channels
mixed). ffmpeg decodes at 8 kHz, plenty for telling speech from silence.
"""

from __future__ import annotations

import os
import subprocess
from typing import Any, TextIO

import numpy as np

from vibecut_agent.broll import (
    ffprobe_util,  # noqa: F401 - imported for its side effect: Homebrew's ffmpeg on PATH
)
from vibecut_agent.protocol import Emitter, RequestError, read_request, require_absolute_paths

SAMPLE_RATE = 8000
MAX_FILES = 64
DEFAULT_PEAKS_PER_SECOND = 50


def peaks_of_samples(samples: np.ndarray, peaks_per_second: int) -> dict[str, Any]:
    """(min, max) of each bin of 16-bit mono samples, scaled to -1..1."""
    per_bin = max(1, SAMPLE_RATE // peaks_per_second)
    count = len(samples) // per_bin
    if count == 0:
        return {"peaksPerSecond": peaks_per_second, "mins": [], "maxes": []}
    bins = samples[: count * per_bin].reshape(count, per_bin).astype(np.float32) / 32768.0
    return {
        "peaksPerSecond": peaks_per_second,
        "mins": np.round(bins.min(axis=1), 4).tolist(),
        "maxes": np.round(bins.max(axis=1), 4).tolist(),
    }


def decode(path: str) -> np.ndarray:
    """The file's sound, mixed to mono at SAMPLE_RATE, as 16-bit samples."""
    result = subprocess.run(
        [
            "ffmpeg",
            "-v",
            "error",
            "-nostdin",
            "-i",
            path,
            "-vn",
            "-ac",
            "1",
            "-ar",
            str(SAMPLE_RATE),
            "-f",
            "s16le",
            "-",
        ],
        capture_output=True,
        timeout=600,
        check=False,
    )
    if result.returncode != 0:
        raise RuntimeError(
            result.stderr.decode(errors="ignore").strip()[-300:] or "ffmpeg couldn't read its sound"
        )
    return np.frombuffer(result.stdout, dtype="<i2")


def run(request: dict[str, Any], emitter: Emitter) -> int:
    paths = request.get("paths")
    if not isinstance(paths, list) or not paths or len(paths) > MAX_FILES:
        raise RequestError(f"paths must list 1 to {MAX_FILES} media files")
    require_absolute_paths(paths, "media file")
    rate = request.get("peaksPerSecond", DEFAULT_PEAKS_PER_SECOND)
    if not isinstance(rate, int) or isinstance(rate, bool) or not 1 <= rate <= 200:
        raise RequestError("peaksPerSecond must be a whole number from 1 to 200")
    peaks: dict[str, Any] = {}
    failed: list[dict[str, str]] = []
    unique = list(dict.fromkeys(paths))
    for index, path in enumerate(unique):
        emitter.progress(index, len(unique), phase="measuring", detail=os.path.basename(path))
        try:
            if not os.path.isfile(path):
                raise RuntimeError("the file isn't there (is its drive attached?)")
            peaks[path] = peaks_of_samples(decode(path), rate)
        except Exception as exc:  # noqa: BLE001 - one unreadable file is reported, the rest still measured
            failed.append({"path": path, "message": str(exc)})
    emitter.progress(len(unique), len(unique), phase="done", detail="")
    emitter.emit("result", peaks=peaks, failed=failed)
    return 0 if peaks or not failed else 1


def main(stdin: TextIO, emitter: Emitter) -> int:
    emitter.emit("starting", tool="audio-peaks", command="audio-peaks")
    try:
        code = run(read_request(stdin), emitter)
    except RequestError as exc:
        emitter.error(str(exc))
        code = 2
    emitter.emit("done", cancelled=False)
    return code
