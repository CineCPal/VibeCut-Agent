"""What VibeCut Agent reads from DaVinci Resolve (connection layer, PLAN.md Phase 3).

Ported from VibeCut's host-resolve/resolve_host.py and headless.py. Runs under Resolve's own Python
(``ResolvePython``), which imports DaVinciResolveScript with no setup; the scripting module only loads
in an interpreter Resolve supports. The Resolve object is passed in, so tests drive this with a fake.
Times cross the boundary in seconds from the timeline's start; Resolve works in frames.

Facts this relies on (checked against Resolve Studio 21.1 by VibeCut):
- ``TimelineItem.GetStart()``/``GetEnd()`` are absolute frames; ``Timeline.GetStartFrame()`` is the
  timeline's first frame, so subtracting it gives frames from the start.
- ``GetLeftOffset()`` is the source in point in frames, but in timeline frames for a retimed clip:
  multiplied by ``GetSpeed()["Percentage"] / 100`` it is the source in point again.
- Transitions and generators come back from ``GetItemListInTrack`` with a ``None`` left offset.
- Marker frames count from the timeline's start.
- ``GetIsTrackEnabled`` reports False for every track of a timeline that isn't the one open in
  Resolve, so a track's switch is only read from the open timeline and is None otherwise.
"""

from __future__ import annotations

import math
import re
import sys
from typing import Any

from vibecut_agent.nle.errors import (
    HostError as HostError,  # noqa: PLC0414 - explicit re-export for the edit modules (mypy --strict)
)
from vibecut_agent.nle.errors import Unreachable

RESOLVE_MARKER_COLORS = (
    "Blue", "Cyan", "Green", "Yellow", "Red", "Pink", "Purple", "Fuchsia",
    "Rose", "Lavender", "Sky", "Mint", "Lemon", "Sand", "Cocoa", "Cream",
)  # fmt: skip
DEFAULT_MARKER_COLOR = "Green"
MAX_MARKERS_PER_CALL = 500
MAX_TEXT = 2000

SCRIPT_MODULES = "/Library/Application Support/Blackmagic Design/DaVinci Resolve/Developer/Scripting/Modules"
NOT_REACHABLE = (
    "DaVinci Resolve isn't running, or doesn't accept outside scripts. Start Resolve Studio and, in "
    'Preferences > System > General, set "External scripting using" to Local. The free version of '
    "Resolve doesn't accept outside scripts."
)


def connect() -> Any:
    """The running Resolve, or Unreachable."""
    try:
        import DaVinciResolveScript as dvr
    except ImportError:
        sys.path.append(SCRIPT_MODULES)
        try:
            import DaVinciResolveScript as dvr
        except ImportError as exc:
            raise Unreachable("DaVinci Resolve's scripting module isn't installed") from exc
    resolve = dvr.scriptapp("Resolve")
    if resolve is None:
        raise Unreachable(NOT_REACHABLE)
    return resolve


def _seconds(frames: float, fps: float) -> float:
    return round(frames / fps, 3)


def _to_frame(seconds: float, fps: float) -> int:
    """Nearest frame, halves rounding up like VibeCut's own Math.round (Python's round() would take
    4.5 s at 25 fps to frame 112 instead of 113)."""
    return math.floor(seconds * fps + 0.5)


def frames_to_timecode(frames: int, fps: float) -> str:
    base = _timecode_base(fps)
    total = max(0, int(frames))
    ff = total % base
    seconds = total // base
    return f"{seconds // 3600:02d}:{seconds // 60 % 60:02d}:{seconds % 60:02d}:{ff:02d}"


def timecode_to_frames(timecode: str, fps: float) -> int:
    match = re.fullmatch(r"(\d+)[:;](\d+)[:;](\d+)[:;](\d+)", timecode.strip())
    if not match:
        raise HostError(f"Unexpected timecode from Resolve: {timecode!r}")
    hh, mm, ss, ff = (int(g) for g in match.groups())
    return ((hh * 60 + mm) * 60 + ss) * _timecode_base(fps) + ff


def _timecode_base(fps: float) -> int:
    """Frames per timecode second: 24 for 23.976, 30 for 29.97."""
    return round(fps)


def _text(value: Any, field: str) -> str:
    if value is None:
        return ""
    if not isinstance(value, str):
        raise HostError(f"{field} must be text")
    return value[:MAX_TEXT]


def _number(value: Any, field: str) -> float:
    if not isinstance(value, (int, float)) or isinstance(value, bool) or not math.isfinite(value):
        raise HostError(f"{field} must be a number")
    return float(value)


def _color(value: Any) -> str:
    if value is None:
        return DEFAULT_MARKER_COLOR
    if not isinstance(value, str):
        raise HostError("color must be text")
    for name in RESOLVE_MARKER_COLORS:
        if name.lower() == value.strip().lower():
            return name
    raise HostError(f"Unknown marker color {value!r}; use one of {', '.join(RESOLVE_MARKER_COLORS)}")


def marker_name(name: str, note: str) -> str:
    """Resolve refuses an unnamed marker: use the note's first words, else "Marker"."""
    if name.strip():
        return name
    words = note.split()
    return " ".join(words[:5]) if words else "Marker"


def _marker_frame(value: Any) -> int:
    if not isinstance(value, str) or not re.fullmatch(r"f\d{1,9}", value):
        raise HostError(f"Unknown marker id {value!r}")
    return int(value[1:])


def frame_rate(timeline: Any) -> float:
    """The timeline's rate as a number. Resolve reports it as text, e.g. "23.976" or "29.97 DF"."""
    raw = str(timeline.GetSetting("timelineFrameRate") or "")
    match = re.match(r"\s*(\d+(?:\.\d+)?)", raw)
    if not match or float(match.group(1)) <= 0:
        raise HostError(f"Couldn't read the timeline's frame rate ({raw!r})")
    return float(match.group(1))


def _speed(item: Any) -> float:
    """A clip's constant speed (1.0 = normal); a speed ramp reads as one percentage."""
    try:
        percentage = (item.GetSpeed() or {}).get("Percentage")
    except AttributeError:
        return 1.0
    if not isinstance(percentage, (int, float)) or percentage <= 0:
        return 1.0
    return round(float(percentage) / 100, 4)


def _has_fusion(item: Any) -> bool:
    try:
        return int(item.GetFusionCompCount() or 0) > 0
    except AttributeError:
        return False


def marker_id(frame: int) -> str:
    return f"f{int(frame)}"


def _track_locked(timeline: Any, kind: str, index: int) -> bool:
    try:
        return bool(timeline.GetIsTrackLocked(kind, index))
    except (AttributeError, TypeError):
        return False


def _linked(item: Any) -> list[Any]:
    """The clips linked to ``item`` that list it back. After an unlink Resolve can leave one-way links
    behind, so only mutual links count."""
    own = item.GetUniqueId()
    return [
        other
        for other in item.GetLinkedItems() or []
        if any(back.GetUniqueId() == own for back in other.GetLinkedItems() or [])
    ]


class ResolveHost:
    def __init__(self, resolve: Any) -> None:
        self._resolve = resolve

    def _project(self) -> Any:
        project = self._resolve.GetProjectManager().GetCurrentProject()
        if not project:
            raise HostError("No project is open in DaVinci Resolve")
        return project

    @staticmethod
    def _timelines(project: Any) -> list[Any]:
        return [project.GetTimelineByIndex(i) for i in range(1, int(project.GetTimelineCount() or 0) + 1)]

    def _timeline(self, args: dict[str, Any]) -> tuple[Any, Any]:
        name = args.get("timeline")
        if not isinstance(name, str) or not name:
            raise HostError("timeline must name a timeline")
        project = self._project()
        for timeline in self._timelines(project):
            if timeline and timeline.GetName() == name:
                return project, timeline
        raise HostError(f"There is no timeline called {name!r} in the Resolve project {project.GetName()!r}")

    def status(self, _args: dict[str, Any]) -> dict[str, Any]:
        project = self._resolve.GetProjectManager().GetCurrentProject()
        info: dict[str, Any] = {
            "product": self._resolve.GetProductName(),
            "version": self._resolve.GetVersionString(),
            "project": None,
            "timelines": [],
            "currentTimeline": None,
        }
        if project:
            current = project.GetCurrentTimeline()
            info["project"] = project.GetName()
            info["timelines"] = [t.GetName() for t in self._timelines(project) if t]
            info["currentTimeline"] = current.GetName() if current else None
        return info

    def read_timeline(self, args: dict[str, Any]) -> dict[str, Any]:
        project, timeline = self._timeline(args)
        fps = frame_rate(timeline)
        start = int(timeline.GetStartFrame())
        current = project.GetCurrentTimeline()
        is_current = bool(current and current.GetName() == timeline.GetName())
        tracks = []
        for kind in ("video", "audio", "subtitle"):
            for index in range(1, int(timeline.GetTrackCount(kind) or 0) + 1):
                tracks.append(self._read_track(timeline, kind, index, start, fps, is_current))
        return {
            "project": project.GetName(),
            "timeline": timeline.GetName(),
            "fps": fps,
            "startTimecode": timeline.GetStartTimecode(),
            "duration": _seconds(int(timeline.GetEndFrame()) - start, fps),
            "isCurrent": is_current,
            "tracks": tracks,
            "markers": self._markers(timeline, fps),
        }

    def _read_track(
        self, timeline: Any, kind: str, index: int, start: int, fps: float, is_current: bool
    ) -> dict[str, Any]:
        clips = []
        for item in timeline.GetItemListInTrack(kind, index) or []:
            left = item.GetLeftOffset()
            clip: dict[str, Any] = {
                "id": item.GetUniqueId(),
                "name": item.GetName(),
                "start": _seconds(item.GetStart() - start, fps),
                "end": _seconds(item.GetEnd() - start, fps),
                "enabled": bool(item.GetClipEnabled()),
            }
            if left is None:
                clip["kind"] = "effect"  # a transition or generator: no source file
            else:
                speed = _speed(item)
                clip["sourceIn"] = _seconds(left * speed, fps)
                clip["sourceOut"] = _seconds((left + item.GetEnd() - item.GetStart()) * speed, fps)
                if speed != 1.0:
                    clip["speed"] = speed
                if _has_fusion(item):
                    clip["fusion"] = True
                try:
                    fades = item.GetFades() or {}
                except AttributeError:
                    fades = {}
                for key, field in (("FadeIn", "fadeIn"), ("FadeOut", "fadeOut")):
                    if float(fades.get(key) or 0) > 0:
                        clip[field] = _seconds(float(fades[key]), fps)
                media = item.GetMediaPoolItem()
                path = media.GetClipProperty("File Path") if media else None
                if path:
                    clip["filePath"] = path
                if kind == "audio":
                    volume = (item.GetProperty() or {}).get("AudioVolume")
                    if isinstance(volume, (int, float)):
                        clip["volumeDb"] = round(float(volume), 2)
                linked = [other.GetUniqueId() for other in _linked(item)]
                if linked:
                    clip["linkedIds"] = linked
            clips.append(clip)
        return {
            "type": kind,
            "index": index,
            "name": timeline.GetTrackName(kind, index),
            "enabled": bool(timeline.GetIsTrackEnabled(kind, index)) if is_current else None,
            # Like enabled, Resolve only reports it for the timeline open in it.
            "locked": _track_locked(timeline, kind, index) if is_current else None,
            "clips": clips,
        }

    def _markers(self, timeline: Any, fps: float) -> list[dict[str, Any]]:
        markers = []
        for frame, info in sorted((timeline.GetMarkers() or {}).items()):
            markers.append(
                {
                    "id": marker_id(int(frame)),
                    "time": _seconds(int(frame), fps),
                    "name": info.get("name", ""),
                    "color": info.get("color", ""),
                    "note": info.get("note", ""),
                    "duration": _seconds(int(info.get("duration", 1) or 1), fps),
                }
            )
        return markers

    def list_markers(self, args: dict[str, Any]) -> dict[str, Any]:
        _project, timeline = self._timeline(args)
        return {"markers": self._markers(timeline, frame_rate(timeline))}

    def add_markers(self, args: dict[str, Any]) -> dict[str, Any]:
        _project, timeline = self._timeline(args)
        fps = frame_rate(timeline)
        markers = args.get("markers")
        if not isinstance(markers, list) or not markers:
            raise HostError("markers must be a non-empty list")
        if len(markers) > MAX_MARKERS_PER_CALL:
            raise HostError(f"At most {MAX_MARKERS_PER_CALL} markers per call")
        length = int(timeline.GetEndFrame()) - int(timeline.GetStartFrame())
        # Every marker is checked before any is added, so a bad one leaves the timeline unchanged.
        planned = []
        for i, marker in enumerate(markers):
            if not isinstance(marker, dict):
                raise HostError(f"markers[{i}] must be an object")
            time = _number(marker.get("time"), f"markers[{i}].time")
            frame = _to_frame(time, fps)
            if frame < 0 or frame > length:
                raise HostError(
                    f"markers[{i}].time {time} s is outside the timeline (0 to {_seconds(length, fps)} s)"
                )
            note = _text(marker.get("note"), f"markers[{i}].note")
            name = marker_name(_text(marker.get("name"), f"markers[{i}].name"), note)
            color = _color(marker.get("color"))
            duration = max(
                1,
                _to_frame(_number(marker.get("duration", 0), f"markers[{i}].duration"), fps),
            )
            planned.append((frame, color, name, note, duration))
        existing = set((timeline.GetMarkers() or {}).keys())
        added, kept, refused = [], [], []
        for frame, color, name, note, duration in planned:
            if frame in existing:
                kept.append(marker_id(frame))
            elif timeline.AddMarker(frame, color, name, note, duration):
                existing.add(frame)
                added.append(
                    {
                        "id": marker_id(frame),
                        "time": _seconds(frame, fps),
                        "name": name,
                        "color": color,
                    }
                )
            else:
                refused.append(_seconds(frame, fps))
        return {"added": added, "alreadyThere": kept, "refusedAt": refused}

    def update_marker(self, args: dict[str, Any]) -> dict[str, Any]:
        """Resolve can't edit a marker in place, so this removes it and adds the changed one."""
        _project, timeline = self._timeline(args)
        fps = frame_rate(timeline)
        frame = _marker_frame(args.get("markerId"))
        markers = timeline.GetMarkers() or {}
        if frame not in markers:
            raise HostError(f"There is no marker {args.get('markerId')!r}")
        old = markers[frame]
        new_frame = _to_frame(_number(args["time"], "time"), fps) if args.get("time") is not None else frame
        length = int(timeline.GetEndFrame()) - int(timeline.GetStartFrame())
        if new_frame < 0 or new_frame > length:
            raise HostError("time is outside the timeline")
        if new_frame != frame and new_frame in markers:
            raise HostError(f"There is already a marker at {_seconds(new_frame, fps)} s")
        note = _text(args["note"], "note") if args.get("note") is not None else old.get("note", "")
        name = marker_name(
            _text(args["name"], "name") if args.get("name") is not None else old.get("name", ""),
            note,
        )
        color = (
            _color(args["color"]) if args.get("color") is not None else old.get("color", DEFAULT_MARKER_COLOR)
        )
        duration = int(old.get("duration", 1) or 1)
        timeline.DeleteMarkerAtFrame(frame)
        if not timeline.AddMarker(new_frame, color, name, note, duration, old.get("customData", "")):
            # Put the original back rather than lose it.
            timeline.AddMarker(
                frame,
                old.get("color", DEFAULT_MARKER_COLOR),
                old.get("name", ""),
                old.get("note", ""),
                duration,
            )
            raise HostError("Resolve refused the changed marker; the original is unchanged")
        return {
            "id": marker_id(new_frame),
            "time": _seconds(new_frame, fps),
            "name": name,
            "color": color,
            "note": note,
        }

    def remove_markers(self, args: dict[str, Any]) -> dict[str, Any]:
        _project, timeline = self._timeline(args)
        markers = timeline.GetMarkers() or {}
        if args.get("all") is True:
            frames = list(markers)
        else:
            ids = args.get("markerIds")
            if not isinstance(ids, list) or not ids:
                raise HostError("Pass markerIds, or all: true")
            frames = [_marker_frame(i) for i in ids]
        removed, missing = [], []
        for frame in frames:
            if frame in markers and timeline.DeleteMarkerAtFrame(frame):
                removed.append(marker_id(frame))
            else:
                missing.append(marker_id(frame))
        return {"removed": removed, "notFound": missing}

    def get_playhead(self, args: dict[str, Any]) -> dict[str, Any]:
        project, timeline = self._timeline(args)
        current = project.GetCurrentTimeline()
        if not current or current.GetName() != timeline.GetName():
            raise HostError(
                f"{timeline.GetName()!r} isn't the timeline open in Resolve, so it has no playhead"
            )
        fps = frame_rate(timeline)
        frames = timecode_to_frames(timeline.GetCurrentTimecode(), fps) - timecode_to_frames(
            timeline.GetStartTimecode(), fps
        )
        return {"time": _seconds(frames, fps)}

    def set_playhead(self, args: dict[str, Any]) -> dict[str, Any]:
        """Opens the connected timeline in Resolve if another one is showing, then moves its playhead."""
        project, timeline = self._timeline(args)
        fps = frame_rate(timeline)
        time = _number(args.get("time"), "time")
        length = int(timeline.GetEndFrame()) - int(timeline.GetStartFrame())
        frame = min(max(0, _to_frame(time, fps)), length)
        current = project.GetCurrentTimeline()
        if not current or current.GetName() != timeline.GetName():
            project.SetCurrentTimeline(timeline)
        target = timecode_to_frames(timeline.GetStartTimecode(), fps) + frame
        if not timeline.SetCurrentTimecode(frames_to_timecode(target, fps)):
            raise HostError("Resolve didn't move the playhead (the Edit or Cut page must be open)")
        return {"time": _seconds(frame, fps)}
