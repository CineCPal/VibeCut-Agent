"""stills.py -- frames of the connected timeline saved as stills (PLAN.md, "Phase 20d"), as the editor
shows them (grade, effects and titles included), for YouTube thumbnails.

request: {timeline, times: [seconds from the timeline's start] (1 to MAX_STILLS), name?}
result:  {stills: [{time, path}], folder}

Each still is a PNG in the project's renders folder (renders.py), "<timeline> thumbnail 0m42s.png" (or
"<timeline> - <name> 0m42s.png"), never overwriting one. Premiere's panel writes the frame with QE's
exportFramePNG into the bridge's frames/ folder (`export_frame`, as the colour tools measure it), and it is
moved from there; Resolve writes it with `ExportCurrentFrameAsStill` from the Edit page, which needs the
timeline open in Resolve. The playhead is put back either way. Standard library only: Resolve's half
runs under Resolve's own Python.
"""

from __future__ import annotations

import os
import shutil
import time
import uuid
from typing import Any

from vibecut_agent.nle.errors import HostError
from vibecut_agent.nle.renders import project_folder, safe_name, unique_stem

MAX_STILLS = 12
FRAME_WAIT_S = 15.0


def _times(args: dict[str, Any]) -> list[float]:
    times = args.get("times")
    if (
        not isinstance(times, list)
        or not 1 <= len(times) <= MAX_STILLS
        or not all(isinstance(t, (int, float)) and not isinstance(t, bool) and t >= 0 for t in times)
    ):
        raise HostError(f"times must list 1 to {MAX_STILLS} moments of the timeline, in seconds")
    return [float(t) for t in dict.fromkeys(times)]


def _stem(timeline: str, name: Any, at: float) -> str:
    label = f"{int(at // 60)}m{at % 60:04.1f}s".replace(".0s", "s")
    base = safe_name(timeline, "Timeline")
    if name is not None and str(name).strip():
        return f"{base} - {safe_name(name)} {label}"
    return f"{base} thumbnail {label}"


def _wait_whole(path: str) -> None:
    """Until the file at `path` stops growing (an export can return before it's whole)."""
    deadline = time.monotonic() + FRAME_WAIT_S
    size = -1
    while True:
        now = os.path.getsize(path) if os.path.isfile(path) else -1
        if now > 0 and now == size:
            return
        if time.monotonic() > deadline:
            raise HostError("The editor didn't write the frame")
        size = now
        time.sleep(0.15)


def premiere_export_stills(host: Any, args: dict[str, Any]) -> dict[str, Any]:
    from vibecut_agent.nle.premiere import TICKS_PER_SECOND
    from vibecut_agent.nle.premiere_bridge import default_dir
    from vibecut_agent.nle.premiere_edit import _read

    times = _times(args)
    timeline = host._name(args)
    seq = _read(host, timeline)
    project = str(host._send("status", {}).get("project") or "Premiere project")
    folder = project_folder(project)
    frames = str(default_dir() / "frames")
    stills = []
    for at in times:
        # On a frame, so the still is that frame and not the one before.
        ticks = round(at * TICKS_PER_SECOND) // seq.timebase * seq.timebase
        name = f"still-{uuid.uuid4().hex[:12]}"
        path = str(
            host._send("export_frame", {"timeline": timeline, "ticks": str(ticks), "name": name})["path"]
        )
        if os.path.dirname(path) != frames:
            raise HostError("Premiere wrote the frame somewhere unexpected")
        _wait_whole(path)
        target = os.path.join(
            folder, unique_stem(folder, _stem(timeline, args.get("name"), at), (".png",)) + ".png"
        )
        shutil.move(path, target)
        stills.append({"time": round(ticks / TICKS_PER_SECOND, 3), "path": target})
    return {"stills": stills, "folder": folder}


def resolve_export_stills(host: Any, args: dict[str, Any]) -> dict[str, Any]:
    from vibecut_agent.nle.resolve import frame_rate, frames_to_timecode, timecode_to_frames

    times = _times(args)
    project, timeline = host._timeline(args)
    current = project.GetCurrentTimeline()
    if not current or current.GetName() != timeline.GetName():
        raise HostError(f"{timeline.GetName()!r} must be the timeline open in Resolve to export its frames")
    fps = frame_rate(timeline)
    start = timecode_to_frames(timeline.GetStartTimecode(), fps)
    folder = project_folder(project.GetName())
    playhead = timeline.GetCurrentTimecode()
    stills = []
    try:
        for at in times:
            frame = int(at * fps + 1e-6)
            if not timeline.SetCurrentTimecode(frames_to_timecode(start + frame, fps)):
                raise HostError("Resolve didn't move the playhead (open the Edit or Cut page)")
            target = os.path.join(
                folder,
                unique_stem(folder, _stem(timeline.GetName(), args.get("name"), at), (".png",)) + ".png",
            )
            if not project.ExportCurrentFrameAsStill(target) or not os.path.isfile(target):
                raise HostError("Resolve didn't export the frame")
            _wait_whole(target)
            stills.append({"time": round(frame / fps, 3), "path": target})
    finally:
        if playhead:
            timeline.SetCurrentTimecode(playhead)
    return {"stills": stills, "folder": folder}
