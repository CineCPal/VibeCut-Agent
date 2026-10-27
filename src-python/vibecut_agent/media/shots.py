"""The `media-shots` command (PLAN.md, "Phase 19b"): where the picture cuts from one shot to the next in a
file, so the agent can find the shots in a flattened export, a reference edit or a long clip.

request: {"path", "start" (s, default 0), "end" (s, optional: to the end),
          "sensitivity": "low" | "normal" (default) | "high"}
result: {"cuts": [{"time" (seconds into the file: the new shot's first frame), "score" (0-1)}],
         "start", "end", "fps", "frames"}

ffmpeg decodes the picture small (96x54) and numpy compares each frame with the one before: the mean
change in brightness and the change in a coarse colour histogram, averaged into a score from 0 to 1. A
cut is a spike (`cuts_in`): a frame (or two, with a blended frame) over the threshold whose neighbours
barely change, standing well above the usual change around it. So fast motion, a wipe or a graphic
sweeping across, which change several frames in a row, aren't cuts; nor is a flash (a frame or three
that differ, then the picture comes back). Cuts closer than MIN_SHOT_SECONDS keep only the stronger one.

Hard cuts only: dissolves, fades and wipes aren't found.
"""

from __future__ import annotations

import os
import subprocess
from collections import deque
from typing import Any

import numpy as np

from vibecut_agent.broll import ffprobe_util
from vibecut_agent.protocol import Emitter, RequestError, require_absolute_paths

WIDTH, HEIGHT = 96, 54
FRAME_BYTES = WIDTH * HEIGHT * 3
BINS = 4
# Calibrated on an edited film (a 4-minute holiday piece, 29.97 fps): every cut checked by eye scored
# 0.135 or more as a spike, and nothing else did at 0.12 (PLAN.md, "19b").
THRESHOLDS = {"low": 0.2, "normal": 0.12, "high": 0.08}
# The frames either side of a cut change less than this share of it; a second frame changing at least
# PAIR of the first is the same cut (a blended frame).
ISOLATION = 0.35
PAIR = 0.5
# A cut's score must be this many times the usual change around it.
OVER_BASELINE = 3.0
BASELINE_SECONDS = 1.0
# The usual change is never taken as less than this, so a still picture's tiny noise doesn't make every
# small change a cut.
BASELINE_FLOOR = 0.02
FLASH_FRAMES = 3
MIN_SHOT_SECONDS = 0.4
MAX_SECONDS = 4 * 3600.0
FFMPEG_TIMEOUT_S = 3 * 3600.0


def features(frame: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """A frame's brightness (0-1, per pixel) and its colour histogram (BINS per channel, summing to 1)."""
    rgb = frame.reshape(HEIGHT, WIDTH, 3)
    luma = (rgb @ np.array([0.299, 0.587, 0.114], dtype=np.float32)) / 255.0
    q = (rgb // (256 // BINS)).astype(np.int32)
    index = (q[..., 0] * BINS + q[..., 1]) * BINS + q[..., 2]
    hist = np.bincount(index.ravel(), minlength=BINS**3).astype(np.float32) / index.size
    return luma, hist


def change(a: tuple[np.ndarray, np.ndarray], b: tuple[np.ndarray, np.ndarray]) -> float:
    """How different two frames are, 0 (the same) to 1."""
    return float(0.5 * np.abs(a[0] - b[0]).mean() + 0.5 * 0.5 * np.abs(a[1] - b[1]).sum())


def scores_of(frames: Any, threshold: float) -> tuple[list[float], set[int]]:
    """Each frame's change from the one before (the first's is 0), and the frames that are part of a flash:
    a jump of at least `threshold` after which, within FLASH_FRAMES, the picture comes back."""
    scores: list[float] = []
    flash: set[int] = set()
    recent: deque[tuple[np.ndarray, np.ndarray]] = deque(maxlen=FLASH_FRAMES + 2)
    for count, raw in enumerate(frames):
        f = features(np.frombuffer(raw, dtype=np.uint8))
        scores.append(change(recent[-1], f) if recent else 0.0)
        # This frame is like the one before an earlier jump: the jump there, and the jump back here, were a flash.
        for back in range(1, min(FLASH_FRAMES, count - 1) + 1):
            i = count - back
            if scores[i] >= threshold and change(recent[-back - 1], f) < threshold / 2:
                flash.update(range(i, count + 1))
        recent.append(f)
    return scores, flash


def cuts_in(scores: list[float], flash: set[int], fps: float, threshold: float) -> list[tuple[int, float]]:
    """The hard cuts in `scores`, as (frame index, score). A cut is a spike: a change over `threshold` on
    one frame, or two (a blended frame on the cut), with the frames either side changing less than
    ISOLATION of it. A change spread over more frames is a wipe, a flash or fast motion, not a cut; and
    the spike must also stand OVER_BASELINE times above the usual change in the second around it."""
    count = len(scores)
    half = max(1, round(fps * BASELINE_SECONDS / 2))
    candidates: list[tuple[int, float]] = []
    i = 1
    while i < count:
        s = scores[i]
        if s < threshold or i in flash:
            i += 1
            continue
        width = 2 if i + 1 < count and scores[i + 1] >= PAIR * s and i + 1 not in flash else 1
        peak = max(scores[i : i + width])
        before = scores[i - 1]
        after = scores[i + width] if i + width < count else 0.0
        around = scores[max(1, i - half) : i] + scores[i + width : i + width + half]
        baseline = max(float(np.median(around)) if around else 0.0, BASELINE_FLOOR)
        if before < ISOLATION * peak and after < ISOLATION * peak and peak >= OVER_BASELINE * baseline:
            candidates.append((i, peak))
        i += width
    gap = max(1, round(fps * MIN_SHOT_SECONDS))
    cuts: list[tuple[int, float]] = []
    for i, s in candidates:
        if cuts and i - cuts[-1][0] < gap:
            if s > cuts[-1][1]:
                cuts[-1] = (i, s)
            continue
        cuts.append((i, s))
    return cuts


def find_cuts(frames: Any, fps: float, sensitivity: str = "normal") -> tuple[list[tuple[int, float]], int]:
    """(cuts as (frame index, score), frames read) in an iterable of raw RGB frames."""
    threshold = THRESHOLDS[sensitivity]
    scores, flash = scores_of(frames, threshold)
    return cuts_in(scores, flash, fps, threshold), len(scores)


def _frames(path: str, start: float, seconds: float | None) -> tuple[subprocess.Popen[bytes], Any]:
    command = ["ffmpeg", "-v", "error", "-nostdin"]
    if start > 0:
        command += ["-ss", f"{start:.6f}"]
    command += ["-i", path]
    if seconds is not None:
        command += ["-t", f"{seconds:.6f}"]
    command += [
        "-map",
        "0:v:0",
        "-an",
        "-sn",
        "-fps_mode",
        "passthrough",
        "-vf",
        f"scale={WIDTH}:{HEIGHT}:flags=area,format=rgb24",
        "-f",
        "rawvideo",
        "-",
    ]
    process = subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE)

    def read() -> Any:
        assert process.stdout is not None
        while True:
            raw = process.stdout.read(FRAME_BYTES)
            if len(raw) < FRAME_BYTES:
                return
            yield raw

    return process, read()


def run(request: dict[str, Any], emitter: Emitter) -> int:
    path = request.get("path")
    require_absolute_paths([path], "media file")
    start = request.get("start", 0)
    end = request.get("end")
    sensitivity = request.get("sensitivity", "normal")
    if not isinstance(start, (int, float)) or isinstance(start, bool) or start < 0:
        raise RequestError("start must be 0 or more seconds")
    if end is not None and (not isinstance(end, (int, float)) or isinstance(end, bool) or end <= start):
        raise RequestError("end must be after start")
    if sensitivity not in THRESHOLDS:
        raise RequestError('sensitivity must be "low", "normal" or "high"')
    path = str(path)
    if not os.path.isfile(path):
        emitter.error("The file isn't there (is its drive attached?)")
        return 1
    fps = ffprobe_util.probe_video_fps(path)
    if not fps:
        emitter.error(f"{os.path.basename(path)} has no picture to find shots in")
        return 1
    duration = ffprobe_util.probe_duration_seconds(path)
    stop = end if end is not None else duration
    if stop is not None and stop - start > MAX_SECONDS:
        emitter.error(f"Shots are found in at most {MAX_SECONDS / 3600:g} hours at once; give start and end")
        return 1
    emitter.progress(0, 1, phase="watching", detail=os.path.basename(path))
    process, frames = _frames(path, float(start), None if end is None else float(end) - float(start))
    try:
        cuts, count = find_cuts(frames, fps, sensitivity)
        process.wait(timeout=FFMPEG_TIMEOUT_S)
    finally:
        if process.poll() is None:
            process.kill()
    if count == 0:
        message = process.stderr.read().decode(errors="ignore").strip()[-300:] if process.stderr else ""
        emitter.error(message or f"ffmpeg read no picture from {os.path.basename(path)}")
        return 1
    # ffmpeg's input seek starts at the first frame at or after `start`.
    first = int(np.ceil(float(start) * fps - 1e-3))
    emitter.progress(1, 1, phase="done", detail="")
    emitter.emit(
        "result",
        cuts=[{"time": round((first + i) / fps, 3), "score": round(s, 3)} for i, s in cuts],
        start=round(first / fps, 3),
        end=round((first + count) / fps, 3),
        fps=round(fps, 3),
        frames=count,
    )
    return 0
