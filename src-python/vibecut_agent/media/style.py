"""The `media-style` command (PLAN.md, "Phase 20b"): how a reference edit looks, measured on a frame from
each of its shots, so `learn_style` can keep it and `match_clip_color` can bring clips toward it.

request: {"path", "times": [seconds into the file] (1 to MAX_SAMPLES)}
result: {"frames": [{"time", "ok": true, "brightness", "contrast", "warmth", "tint", "colour"}
                    | {"time", "ok": false, "message"}],
         "look": {"brightness", "contrast", "warmth", "tint", "colour"},
         "spread": {each measure: [10th, 90th percentile]},
         "measured", "dark"}

Each frame is read small with ffmpeg and measured as `get_clip_color` measures the editor's frames
(nle/colour.py `measure`), so the numbers compare. The look is each measure's median over the frames,
leaving out near-black ones (a fade, a title card on black: `dark` counts them), which say nothing
about the grade.
"""

from __future__ import annotations

import os
from concurrent.futures import ThreadPoolExecutor
from typing import Any

from vibecut_agent.broll import ffprobe_util
from vibecut_agent.nle import colour
from vibecut_agent.protocol import Emitter, RequestError, require_absolute_paths

MAX_SAMPLES = 48
MEASURES = colour.MEASURES
# A frame darker than this is a fade or black card, not a graded shot.
DARK = 0.03
WORKERS = 4
FRAME_TIMEOUT_S = 30.0


def _percentile(values: list[float], q: float) -> float:
    ordered = sorted(values)
    at = (len(ordered) - 1) * q
    lo, hi = int(at), min(int(at) + 1, len(ordered) - 1)
    return ordered[lo] + (ordered[hi] - ordered[lo]) * (at - lo)


def summarise(measures: list[dict[str, float]]) -> tuple[dict[str, float], dict[str, list[float]], int]:
    """(look, spread, dark): the median of each measure over the frames that aren't near black (all of
    them, when every one is), each measure's 10th-90th percentile, and how many were near black."""
    lit = [m for m in measures if m["brightness"] >= DARK]
    used = lit or measures
    look = {k: round(_percentile([m[k] for m in used], 0.5), 4) for k in MEASURES}
    spread = {k: [round(_percentile([m[k] for m in used], q), 4) for q in (0.1, 0.9)] for k in MEASURES}
    return look, spread, len(measures) - len(lit)


def _measure(path: str, time: float) -> dict[str, Any]:
    try:
        return {
            "time": time,
            "ok": True,
            **colour.measure(colour.frame_pixels(path, FRAME_TIMEOUT_S, at=time)),
        }
    except colour.ColourError as exc:
        return {"time": time, "ok": False, "message": str(exc)}


def run(request: dict[str, Any], emitter: Emitter) -> int:
    path = request.get("path")
    require_absolute_paths([path], "media file")
    times = request.get("times")
    if (
        not isinstance(times, list)
        or not 1 <= len(times) <= MAX_SAMPLES
        or not all(isinstance(t, (int, float)) and not isinstance(t, bool) and t >= 0 for t in times)
    ):
        raise RequestError(f"times must list 1 to {MAX_SAMPLES} moments of the file, in seconds")
    path = str(path)
    if not os.path.isfile(path):
        emitter.error("The file isn't there (is its drive attached?)")
        return 1
    if not ffprobe_util.probe_video_fps(path):
        emitter.error(f"{os.path.basename(path)} has no picture to measure")
        return 1
    emitter.progress(0, len(times), phase="measuring", detail=os.path.basename(path))
    with ThreadPoolExecutor(max_workers=WORKERS) as pool:
        frames = list(pool.map(lambda t: _measure(path, float(t)), times))
    measured = [{k: f[k] for k in MEASURES} for f in frames if f["ok"]]
    if not measured:
        emitter.error(next((f["message"] for f in frames if not f["ok"]), "No frame could be measured"))
        return 1
    look, spread, dark = summarise(measured)
    emitter.progress(len(times), len(times), phase="done", detail="")
    emitter.emit("result", frames=frames, look=look, spread=spread, measured=len(measured), dark=dark)
    return 0
