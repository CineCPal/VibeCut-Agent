"""What VibeCut Agent reads from Premiere Pro through its panel (connection layer, PLAN.md Phase 3).

Ported from VibeCut's host-premiere/premiere_host.py; the answers have the same names and shapes as
:mod:`vibecut_agent.nle.resolve`, so the agent treats both editors alike. The panel
(src-premiere-panel/host.jsx) works in Premiere's own units; this module converts:
- Times are ticks, 254016000000 per second. A sequence's ``timebase`` is ticks per frame, so its
  rate is 254016000000 / timebase.
- Clip and marker times count from the sequence's start; ``zeroPoint`` is its start timecode.
- A clip's Level is a gain where 0 dB is 10^(-15/20): dB = 20 * log10(gain) + 15.
- Marker colours are indexes into PREMIERE_MARKER_COLORS.
- A retimed clip's inPoint/outPoint are in timeline time: multiplied by its speed they are the
  source points.
"""

from __future__ import annotations

import math
import re
from collections.abc import Callable
from typing import Any

from vibecut_agent.nle.errors import (
    HostError as HostError,  # noqa: PLC0414 - explicit re-export for the edit modules (mypy --strict)
)

TICKS_PER_SECOND = 254016000000
PREMIERE_MARKER_COLORS = ("Green", "Red", "Purple", "Orange", "Yellow", "White", "Blue", "Cyan")
DEFAULT_MARKER_COLOR = "Green"
MAX_MARKERS_PER_CALL = 500
MAX_TEXT = 2000
ID_PATTERN = re.compile(r"[\w-]{1,64}")

# How long the panel gets for each command, in seconds.
TIMEOUTS = {"read_sequence": 25.0, "read_project": 25.0, "import_sequence": 170.0}
DEFAULT_TIMEOUT_S = 20.0

Request = Callable[[str, dict[str, Any], float], Any]


def seconds(ticks: Any) -> float:
    return round(int(ticks) / TICKS_PER_SECOND, 3)


def frame_rate(timebase: Any) -> float:
    try:
        per_frame = int(timebase)
    except (TypeError, ValueError) as exc:
        raise HostError(f"Couldn't read the sequence's frame rate ({timebase!r})") from exc
    if per_frame <= 0:
        raise HostError(f"Couldn't read the sequence's frame rate ({timebase!r})")
    return round(TICKS_PER_SECOND / per_frame, 3)


def timecode(ticks: int, timebase: int) -> str:
    """Non-drop timecode of a tick count: 24 frames per timecode second at 23.976."""
    base = round(TICKS_PER_SECOND / timebase)
    total = max(0, int(ticks) // timebase)
    ff = total % base
    secs = total // base
    return f"{secs // 3600:02d}:{secs // 60 % 60:02d}:{secs % 60:02d}:{ff:02d}"


def to_ticks(time: float, timebase: int) -> int:
    """The nearest frame's ticks, halves rounding up like VibeCut's own Math.round."""
    frame = math.floor(time * TICKS_PER_SECOND / timebase + 0.5)
    return frame * timebase


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


def color_index(value: Any) -> int:
    if value is None:
        return PREMIERE_MARKER_COLORS.index(DEFAULT_MARKER_COLOR)
    if not isinstance(value, str):
        raise HostError("color must be text")
    for i, name in enumerate(PREMIERE_MARKER_COLORS):
        if name.lower() == value.strip().lower():
            return i
    raise HostError(f"Unknown marker color {value!r}; use one of {', '.join(PREMIERE_MARKER_COLORS)}")


def _marker_id(value: Any, field: str = "markerId") -> str:
    if not isinstance(value, str) or not ID_PATTERN.fullmatch(value):
        raise HostError(f"Unknown marker id {value!r}")
    return value


def level_db(gain: Any) -> float | None:
    if not isinstance(gain, (int, float)) or isinstance(gain, bool):
        return None
    if gain <= 0:
        return -96.0
    return round(20 * math.log10(gain) + 15, 2)


def color_name(index: Any) -> str:
    if isinstance(index, int) and 0 <= index < len(PREMIERE_MARKER_COLORS):
        return PREMIERE_MARKER_COLORS[index]
    return DEFAULT_MARKER_COLOR


def marker(raw: dict[str, Any]) -> dict[str, Any]:
    start = int(raw["startTicks"])
    return {
        "id": raw["id"],
        "time": seconds(start),
        "name": raw.get("name", ""),
        "color": color_name(raw.get("colorIndex")),
        "note": raw.get("comments", ""),
        "duration": seconds(max(0, int(raw["endTicks"]) - start)),
    }


def _clip(raw: dict[str, Any], kind: str) -> dict[str, Any]:
    clip: dict[str, Any] = {
        "id": raw["id"],
        "name": raw.get("name", ""),
        "start": seconds(raw["startTicks"]),
        "end": seconds(raw["endTicks"]),
        "enabled": not raw.get("disabled", False),
    }
    if raw.get("adjustment"):
        clip["kind"] = "effect"  # an adjustment layer: no source file
        return clip
    speed = raw.get("speed")
    rate = float(speed) if isinstance(speed, (int, float)) and speed > 0 else 1.0
    clip["sourceIn"] = round(int(raw["inTicks"]) * rate / TICKS_PER_SECOND, 3)
    clip["sourceOut"] = round(int(raw["outTicks"]) * rate / TICKS_PER_SECOND, 3)
    if round(rate, 4) != 1:
        clip["speed"] = round(rate, 4)
    if raw.get("reversed"):
        clip["speed"] = -abs(clip.get("speed", 1.0))
    if raw.get("mediaPath"):
        clip["filePath"] = raw["mediaPath"]
    if raw.get("nested"):
        clip["nested"] = True
    if raw.get("offline"):
        clip["offline"] = True
    if kind == "audio":
        db = level_db(raw.get("level"))
        if db is not None:
            clip["volumeDb"] = db
    if raw.get("linkedIds"):
        clip["linkedIds"] = list(raw["linkedIds"])
    return clip


def _track(raw: dict[str, Any], kind: str, index: int) -> dict[str, Any]:
    clips = [_clip(c, kind) for c in raw.get("clips", [])]
    # Transitions sit across clip edges; they are listed like Resolve's, as clips with no source.
    for i, transition in enumerate(raw.get("transitions", [])):
        clips.append(
            {
                "id": f"tr-{kind[0]}{index}-{i + 1}",
                "name": transition.get("name") or "Transition",
                "start": seconds(transition["startTicks"]),
                "end": seconds(transition["endTicks"]),
                "enabled": True,
                "kind": "effect",
            }
        )
    clips.sort(key=lambda c: (c["start"], c["end"]))
    return {
        "type": kind,
        "index": index,
        "name": raw.get("name", ""),
        # Premiere reports a track's output switch (video) or mute (audio) for every sequence.
        "enabled": not raw.get("muted", False),
        "muted": bool(raw.get("muted", False)),
        "locked": bool(raw.get("locked", False)),
        "targeted": bool(raw.get("targeted", False)),
        "clips": clips,
    }


def number_channels(tracks: list[dict[str, Any]]) -> None:
    """Premiere puts each channel of a recording on its own audio track (A1 left, A2 right, ...):
    clips of one file at the same place and source point on several audio tracks are its channels,
    numbered in track order."""
    groups: dict[tuple[Any, ...], list[dict[str, Any]]] = {}
    for track in tracks:
        if track["type"] != "audio":
            continue
        for clip in track["clips"]:
            if clip.get("filePath") and clip.get("kind") is None:
                key = (clip["filePath"], clip["start"], clip["end"], clip["sourceIn"])
                groups.setdefault(key, []).append(clip)
    for clips in groups.values():
        if len(clips) > 1:
            for channel, clip in enumerate(clips, start=1):
                clip["channel"] = channel


def timeline(raw: dict[str, Any]) -> dict[str, Any]:
    """read_sequence's answer as a timeline, in the same shape Resolve's read_timeline returns."""
    timebase = int(raw["timebase"])
    fps = frame_rate(timebase)
    tracks = [_track(t, "video", i + 1) for i, t in enumerate(raw.get("video", []))]
    tracks += [_track(t, "audio", i + 1) for i, t in enumerate(raw.get("audio", []))]
    number_channels(tracks)
    return {
        "project": raw.get("project", ""),
        "timeline": raw["name"],
        "fps": fps,
        "startTimecode": timecode(int(raw.get("zeroPoint") or 0), timebase),
        "duration": seconds(raw["endTicks"]),
        "isCurrent": bool(raw.get("isActive")),
        "tracks": tracks,
        "markers": sorted((marker(m) for m in raw.get("markers", [])), key=lambda m: m["time"]),
    }


def timeline_name(args: dict[str, Any]) -> str:
    name = args.get("timeline")
    if not isinstance(name, str) or not name:
        raise HostError("timeline must name a sequence")
    return name


class PremiereHost:
    """``request(command, args, timeout_s)`` sends one command to the panel (PremiereBridge.request)."""

    def __init__(self, request: Request) -> None:
        self._request = request

    def _send(self, command: str, args: dict[str, Any]) -> Any:
        return self._request(command, args, TIMEOUTS.get(command, DEFAULT_TIMEOUT_S))

    # The edit modules (premiere_edit.py and friends) name the sequence through the host, as VibeCut's do.
    _name = staticmethod(timeline_name)

    def status(self, _args: dict[str, Any]) -> dict[str, Any]:
        raw = self._send("status", {})
        names: list[str] = []
        for name in raw.get("sequences", []):
            if name not in names:
                names.append(name)
        return {
            "product": raw.get("product", "Adobe Premiere Pro"),
            "version": raw.get("version", ""),
            "project": raw.get("project"),
            "timelines": names,
            "currentTimeline": raw.get("activeSequence"),
        }

    def read_timeline(self, args: dict[str, Any]) -> dict[str, Any]:
        return timeline(self._send("read_sequence", {"timeline": timeline_name(args)}))

    def _info(self, args: dict[str, Any]) -> dict[str, Any]:
        """The sequence's rate, start and length, without reading its clips."""
        info: dict[str, Any] = self._send("sequence_info", {"timeline": timeline_name(args)})
        return info

    def list_markers(self, args: dict[str, Any]) -> dict[str, Any]:
        return {"markers": self.read_timeline(args)["markers"]}

    def add_markers(self, args: dict[str, Any]) -> dict[str, Any]:
        markers = args.get("markers")
        if not isinstance(markers, list) or not markers:
            raise HostError("markers must be a non-empty list")
        if len(markers) > MAX_MARKERS_PER_CALL:
            raise HostError(f"At most {MAX_MARKERS_PER_CALL} markers per call")
        info = self._info(args)
        timebase = int(info["timebase"])
        length = int(info["endTicks"])
        # Every marker is checked before any is added, so a bad one leaves the sequence unchanged.
        planned = []
        for i, wanted in enumerate(markers):
            if not isinstance(wanted, dict):
                raise HostError(f"markers[{i}] must be an object")
            time = _number(wanted.get("time"), f"markers[{i}].time")
            ticks = to_ticks(time, timebase)
            if ticks < 0 or ticks > length:
                raise HostError(
                    f"markers[{i}].time {time} s is outside the sequence (0 to {seconds(length)} s)"
                )
            duration = _number(wanted.get("duration", 0), f"markers[{i}].duration")
            end = to_ticks(time + duration, timebase) if duration > 0 else 0
            planned.append({
                "ticks": str(ticks),
                "seconds": ticks / TICKS_PER_SECOND,
                "endSeconds": end / TICKS_PER_SECOND if end > ticks else None,
                "name": _text(wanted.get("name"), f"markers[{i}].name"),
                "comments": _text(wanted.get("note"), f"markers[{i}].note"),
                "colorIndex": color_index(wanted.get("color")),
            })  # fmt: skip
        raw = self._send("add_markers", {"timeline": timeline_name(args), "markers": planned})
        added = [marker(m) for m in raw.get("added", [])]
        return {
            "added": [{k: m[k] for k in ("id", "time", "name", "color")} for m in added],
            "alreadyThere": list(raw.get("alreadyThere", [])),
            "refusedAt": [seconds(t) for t in raw.get("refusedAt", [])],
        }

    def update_marker(self, args: dict[str, Any]) -> dict[str, Any]:
        request: dict[str, Any] = {
            "timeline": timeline_name(args),
            "id": _marker_id(args.get("markerId")),
        }
        if args.get("name") is not None:
            request["name"] = _text(args["name"], "name")
        if args.get("note") is not None:
            request["comments"] = _text(args["note"], "note")
        if args.get("color") is not None:
            request["colorIndex"] = color_index(args["color"])
        if args.get("time") is not None:
            info = self._info(args)
            ticks = to_ticks(_number(args["time"], "time"), int(info["timebase"]))
            if ticks < 0 or ticks > int(info["endTicks"]):
                raise HostError("time is outside the sequence")
            request["ticks"] = str(ticks)  # to find a marker already there
            request["seconds"] = ticks / TICKS_PER_SECOND  # to move it: Premiere sets marker times in seconds
        changed = marker(self._send("update_marker", request))
        return {k: changed[k] for k in ("id", "time", "name", "color", "note")}

    def remove_markers(self, args: dict[str, Any]) -> dict[str, Any]:
        if args.get("all") is True:
            request: dict[str, Any] = {"timeline": timeline_name(args), "all": True}
        else:
            ids = args.get("markerIds")
            if not isinstance(ids, list) or not ids:
                raise HostError("Pass markerIds, or all: true")
            request = {
                "timeline": timeline_name(args),
                "ids": [_marker_id(i) for i in ids],
            }
        raw = self._send("remove_markers", request)
        return {
            "removed": list(raw.get("removed", [])),
            "notFound": list(raw.get("notFound", [])),
        }

    def get_playhead(self, args: dict[str, Any]) -> dict[str, Any]:
        return {"time": seconds(self._send("get_playhead", {"timeline": timeline_name(args)})["ticks"])}

    def set_playhead(self, args: dict[str, Any]) -> dict[str, Any]:
        """Opens the connected sequence in Premiere if another one is showing, then moves its playhead."""
        info = self._info(args)
        timebase = int(info["timebase"])
        ticks = min(
            max(0, to_ticks(_number(args.get("time"), "time"), timebase)),
            int(info["endTicks"]),
        )
        raw = self._send("set_playhead", {"timeline": timeline_name(args), "ticks": str(ticks)})
        return {"time": seconds(raw["ticks"])}
