"""Streaming ffmpeg detectors for the orchestrator (ORCHESTRATOR_SPEC.md §1, §3.2 `detect_media_boundaries`,
`analyze_shot_visuals`; PLAN.md, "Phase 21").

- `detect_silences`: ffmpeg's `silencedetect`, its log read a line at a time.
- `detect_scene_cuts`: media/shots.py's calibrated hard-cut detector (Phase 19b), on its 96x54 stream.
- `extract_keyframes_for_vlm`: one small JPEG per shot (at scene cuts, every 2 s, or the middle of the
  range), written to a folder for the VLM worker to read.

No media file is ever read into Python: ffmpeg decodes, and only its log lines or the 96x54 frames come
through a pipe. Every time is a frame-exact `RationalTime` (core/timecode_math.py) at the file's rate,
or at the caller's `rate` for a file with no picture."""

from __future__ import annotations

import itertools
import math
import os
import re
import subprocess
import time
from collections.abc import Iterable
from fractions import Fraction
from pathlib import Path
from typing import Literal, TypedDict

from vibecut_agent.broll import ffprobe_util
from vibecut_agent.core.timecode_math import (
    RationalTime,
    TimeRange,
    exact_rate,
    rational_time,
    rational_to_smpte,
    snap_rate,
)
from vibecut_agent.media import shots

FFMPEG_TIMEOUT_S = 3 * 3600.0
KEYFRAME_TIMEOUT_S = 30.0
UNIFORM_SECONDS = 2
MAX_KEYFRAMES = 500
KEYFRAME_WIDTH = 768

SampleStrategy = Literal["scene_cuts", "uniform_2s", "midpoint_only"]
SAMPLE_STRATEGIES: tuple[SampleStrategy, ...] = ("scene_cuts", "uniform_2s", "midpoint_only")

_SILENCE_START = re.compile(r"silence_start:\s*(-?[\d.]+)")
_SILENCE_END = re.compile(r"silence_end:\s*(-?[\d.]+)")


class FfmpegOpError(RuntimeError):
    """ffmpeg couldn't read the file, or the request can't be met (its rate, its length)."""


class SilenceSpan(TypedDict):
    start_seconds: float
    end_seconds: float
    duration_seconds: float
    source_range: TimeRange


class SceneCut(TypedDict):
    """A hard cut: `time` is the new shot's first frame."""

    time: RationalTime
    seconds: float
    smpte: str
    score: float


class Keyframe(TypedDict):
    shot_id: str
    source_range: TimeRange
    keyframe_timestamp_sec: float
    keyframe_time: RationalTime
    image_path: str


def _check_file(path: str) -> None:
    if not os.path.isabs(path):
        raise FfmpegOpError(f"{path!r} isn't an absolute path")
    if not os.path.isfile(path):
        raise FfmpegOpError(f"{path} isn't there (is its drive attached?)")


def _check_window(start: float, end: float | None) -> None:
    if start < 0:
        raise FfmpegOpError("start must be 0 or more seconds")
    if end is not None and end <= start:
        raise FfmpegOpError("end must be after start")


def media_rate(path: str) -> float:
    """The file's picture rate, as one of timecode_math's supported rates."""
    fps = ffprobe_util.probe_video_fps(path)
    if not fps:
        raise FfmpegOpError(f"{os.path.basename(path)} has no picture; give a rate")
    try:
        return snap_rate(fps)
    except ValueError as e:
        raise FfmpegOpError(f"{os.path.basename(path)}: {e}") from None


def _range(first: int, last: int, rate: float) -> TimeRange:
    return {
        "OTIO_SCHEMA": "TimeRange.1",
        "start_time": rational_time(first, rate),
        "duration": rational_time(last - first, rate),
    }


def _seconds(frame: int, rate: float) -> Fraction:
    return Fraction(frame) / exact_rate(rate)


def _seek(seconds: Fraction) -> str:
    # Rounded down to the microsecond: ffmpeg's seek lands on the first frame at or after it, which is
    # this frame and never the one after.
    return f"{math.floor(seconds * 1_000_000) / 1_000_000:.6f}"


def parse_silences(
    lines: Iterable[str], offset: float, window_end: float | None
) -> list[tuple[float, float]]:
    """(start, end) seconds of each silence in `silencedetect`'s log, shifted by `offset` (the input seek).
    A silence still open when the log ends runs to `window_end`, or is dropped when that is unknown."""
    spans: list[tuple[float, float]] = []
    open_start: float | None = None
    for line in lines:
        started = _SILENCE_START.search(line)
        if started:
            open_start = max(0.0, float(started.group(1))) + offset
            continue
        ended = _SILENCE_END.search(line)
        if ended and open_start is not None:
            spans.append((open_start, float(ended.group(1)) + offset))
            open_start = None
    if open_start is not None and window_end is not None and window_end > open_start:
        spans.append((open_start, window_end))
    return spans


def detect_silences(
    path: str,
    *,
    start: float = 0.0,
    end: float | None = None,
    noise_db: float = -35.0,
    min_duration: float = 0.35,
    rate: float | None = None,
) -> list[SilenceSpan]:
    """The silences in the file's first sound stream between `start` and `end` (seconds). Each one's
    `source_range` is snapped inward to whole frames, so it lies inside the silence; a silence shorter
    than a frame once snapped is left out."""
    _check_file(path)
    _check_window(start, end)
    if noise_db > -10.0:
        raise FfmpegOpError("noise_db must be -10 dB or lower")
    if min_duration < 0.1:
        raise FfmpegOpError("min_duration must be 0.1 s or more")
    rate = rate if rate is not None else media_rate(path)
    exact = exact_rate(rate)
    window_end = end if end is not None else ffprobe_util.probe_duration_seconds(path)
    command = ["ffmpeg", "-hide_banner", "-nostats", "-nostdin", "-v", "info"]
    if start > 0:
        command += ["-ss", f"{start:.6f}"]
    command += ["-i", path]
    if end is not None:
        command += ["-t", f"{end - start:.6f}"]
    command += [
        "-map",
        "0:a:0",
        "-vn",
        "-sn",
        "-af",
        f"silencedetect=noise={noise_db:g}dB:d={min_duration:g}",
    ]
    command += ["-f", "null", "-"]
    process = subprocess.Popen(
        command, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, text=True, errors="replace"
    )
    tail: list[str] = []

    def lines() -> Iterable[str]:
        assert process.stderr is not None
        deadline = time.monotonic() + FFMPEG_TIMEOUT_S
        for line in process.stderr:
            if time.monotonic() > deadline:
                raise FfmpegOpError(f"ffmpeg took over {FFMPEG_TIMEOUT_S / 3600:g} h finding silences")
            tail[:] = [*tail[-4:], line.strip()]
            yield line

    try:
        spans = parse_silences(lines(), start, window_end)
        code = process.wait(timeout=FFMPEG_TIMEOUT_S)
    finally:
        if process.poll() is None:
            process.kill()
        if process.stderr is not None:
            process.stderr.close()
    if code != 0:
        raise FfmpegOpError(" ".join(tail)[-300:] or f"ffmpeg couldn't read {os.path.basename(path)}")
    found: list[SilenceSpan] = []
    for begin, finish in spans:
        first = math.ceil(Fraction(begin) * exact)
        last = math.floor(Fraction(finish) * exact)
        if last <= first:
            continue
        found.append(
            {
                "start_seconds": round(begin, 3),
                "end_seconds": round(finish, 3),
                "duration_seconds": round(finish - begin, 3),
                "source_range": _range(first, last, rate),
            }
        )
    return found


def _scan_cuts(
    path: str, start: float, end: float | None, sensitivity: str
) -> tuple[float, list[tuple[int, float]], int, int]:
    """(rate, cuts as (frame in the file, score), the window's first frame, frames read)."""
    _check_file(path)
    _check_window(start, end)
    if sensitivity not in shots.THRESHOLDS:
        raise FfmpegOpError('sensitivity must be "low", "normal" or "high"')
    rate = media_rate(path)
    fps = float(exact_rate(rate))
    stop = end if end is not None else ffprobe_util.probe_duration_seconds(path)
    if stop is not None and stop - start > shots.MAX_SECONDS:
        raise FfmpegOpError(f"Cuts are found in at most {shots.MAX_SECONDS / 3600:g} hours at once")
    # media/shots.py's own frame pipe: ffmpeg scales to 96x54 RGB, read one frame at a time.
    process, frames = shots._frames(path, start, None if end is None else end - start)
    message = ""
    try:
        cuts, count = shots.find_cuts(frames, fps, sensitivity)
        process.wait(timeout=FFMPEG_TIMEOUT_S)
        if count == 0 and process.stderr:
            message = process.stderr.read().decode(errors="ignore").strip()[-300:]
    finally:
        if process.poll() is None:
            process.kill()
        for pipe in (process.stdout, process.stderr):
            if pipe is not None:
                pipe.close()
    if count == 0:
        raise FfmpegOpError(message or f"ffmpeg read no picture from {os.path.basename(path)}")
    # ffmpeg's input seek starts at the first frame at or after `start`.
    first = math.ceil(Fraction(start) * exact_rate(rate) - Fraction(1, 1000))
    return rate, [(first + i, score) for i, score in cuts], first, count


def detect_scene_cuts(
    path: str, *, start: float = 0.0, end: float | None = None, sensitivity: str = "normal"
) -> list[SceneCut]:
    """The hard cuts in the picture between `start` and `end` (seconds), as each new shot's first frame."""
    rate, cuts, _, _ = _scan_cuts(path, start, end, sensitivity)
    found: list[SceneCut] = []
    for frame, score in cuts:
        cut = rational_time(frame, rate)
        found.append(
            {
                "time": cut,
                "seconds": round(float(_seconds(frame, rate)), 6),
                "smpte": rational_to_smpte(cut),
                "score": round(score, 3),
            }
        )
    return found


def _shot_bounds(
    path: str, start: float, end: float | None, strategy: SampleStrategy, sensitivity: str
) -> tuple[float, list[tuple[int, int]]]:
    """(rate, each shot's [first, last) frames) for a sampling strategy."""
    if strategy == "scene_cuts":
        rate, cuts, first, count = _scan_cuts(path, start, end, sensitivity)
        edges = [first, *(frame for frame, _ in cuts), first + count]
        return rate, [(a, b) for a, b in itertools.pairwise(edges) if b > a]
    _check_file(path)
    _check_window(start, end)
    rate = media_rate(path)
    stop = end if end is not None else ffprobe_util.probe_duration_seconds(path)
    if stop is None:
        raise FfmpegOpError(f"{os.path.basename(path)}'s length is unknown; give an end")
    exact = exact_rate(rate)
    first = math.ceil(Fraction(start) * exact - Fraction(1, 1000))
    last = math.floor(Fraction(stop) * exact)
    if last <= first:
        raise FfmpegOpError("The range holds no whole frame")
    if strategy == "midpoint_only":
        return rate, [(first, last)]
    step = UNIFORM_SECONDS * round(rate)
    return rate, [(a, min(a + step, last)) for a in range(first, last, step)]


def extract_keyframes_for_vlm(
    path: str,
    out_dir: str | os.PathLike[str],
    *,
    start: float = 0.0,
    end: float | None = None,
    strategy: SampleStrategy = "scene_cuts",
    sensitivity: str = "normal",
    width: int = KEYFRAME_WIDTH,
) -> list[Keyframe]:
    """One JPEG per shot, `width` pixels wide, from the shot's middle frame, written to `out_dir` as
    `<file stem>_<frame>.jpg` (an existing one is reused). Shots come from `strategy`: the scene cuts,
    every UNIFORM_SECONDS, or the whole range as one."""
    if strategy not in SAMPLE_STRATEGIES:
        raise FfmpegOpError(f"strategy must be one of {', '.join(SAMPLE_STRATEGIES)}")
    if width < 16:
        raise FfmpegOpError("width must be 16 pixels or more")
    rate, bounds = _shot_bounds(path, start, end, strategy, sensitivity)
    if len(bounds) > MAX_KEYFRAMES:
        raise FfmpegOpError(f"{len(bounds)} shots is over {MAX_KEYFRAMES} keyframes; give a shorter range")
    folder = Path(out_dir)
    folder.mkdir(parents=True, exist_ok=True)
    stem = Path(path).stem
    keyframes: list[Keyframe] = []
    for index, (first, last) in enumerate(bounds):
        middle = first + (last - first) // 2
        image = folder / f"{stem}_{middle:08d}.jpg"
        if not image.is_file():
            _grab(path, _seconds(middle, rate), width, image)
        keyframes.append(
            {
                "shot_id": f"shot_{index:04d}",
                "source_range": _range(first, last, rate),
                "keyframe_timestamp_sec": round(float(_seconds(middle, rate)), 6),
                "keyframe_time": rational_time(middle, rate),
                "image_path": str(image),
            }
        )
    return keyframes


def _grab(path: str, seconds: Fraction, width: int, image: Path) -> None:
    partial = image.with_name(f".{image.name}.partial.jpg")
    command = [
        "ffmpeg",
        "-hide_banner",
        "-nostats",
        "-nostdin",
        "-v",
        "error",
        "-y",
        "-ss",
        _seek(seconds),
        "-i",
        path,
        "-map",
        "0:v:0",
        "-frames:v",
        "1",
        "-vf",
        f"scale={width}:-2:flags=area",
        "-q:v",
        "3",
        str(partial),
    ]
    try:
        done = subprocess.run(command, capture_output=True, timeout=KEYFRAME_TIMEOUT_S, check=False)
    except subprocess.TimeoutExpired:
        partial.unlink(missing_ok=True)
        raise FfmpegOpError(f"ffmpeg took over {KEYFRAME_TIMEOUT_S:g} s for one frame") from None
    if done.returncode != 0 or not partial.is_file() or partial.stat().st_size == 0:
        partial.unlink(missing_ok=True)
        message = done.stderr.decode(errors="ignore").strip()[-300:]
        raise FfmpegOpError(message or f"ffmpeg wrote no frame at {float(seconds):.3f} s")
    partial.replace(image)
