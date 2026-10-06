"""The Premiere project's bins and clips for the agent (PLAN.md, "Phase 6a"), ported from VibeCut's
host-premiere/premiere_pool.py (its "Connect page", phase 4d): Premiere's side of host-resolve's resolve_pool.py, with the same commands and answers, so the
Connect page and the agent treat the Project panel like Resolve's Media Pool.

Three commands, none of which changes the project: `read_media_pool` (bins, clips, sequences, and
what's selected in the Project panel and on the connected sequence), `get_clip_info` (one clip in full:
every Project panel column that's set, and its own markers) and `search_media_pool`.

What Premiere 26.5.2 gives (checked live against the round-trip scratch project):
- Every project item has a `nodeId` that stays the same while the project is open, also when the item
  is moved to another bin. It is the clip id here.
- `getProjectColumnsMetadata()` lists the Project panel's columns: Label (the colour's name), Frame
  Rate ("29.97 fps"), Media Duration (ticks), Video Info ("1280 x 720 (1.0)"), Audio Info, Status
  ("Online"), and the logged fields Description, Log Note, Scene, Shot and Good ("true"/"false").
  There is no Comment column and no keywords, and no usage count: the panel counts uses itself by
  walking every sequence.
- `getColorLabel()` is an index into Premiere's 16 label colours (PREMIERE_LABEL_COLORS, the default
  names); every item has one.
- `getInPoint(4)`/`getOutPoint(4)` are the item's In/Out in seconds; unmarked, they span the media.
- `app.getCurrentProjectViewSelection()` gives the Project panel's selection (none when nothing is
  selected).
"""

from __future__ import annotations

import re
from typing import Any

from vibecut_agent.nle.premiere import TICKS_PER_SECOND, HostError, PremiereHost, color_name

MAX_CLIPS = 2000
MAX_RESULTS = 200
# Premiere's label colours by index, as its preferences name them by default.
PREMIERE_LABEL_COLORS = (
    "Violet", "Iris", "Caribbean", "Lavender", "Cerulean", "Forest", "Rose", "Mango",
    "Purple", "Blue", "Teal", "Magenta", "Tan", "Green", "Brown", "Yellow",
)  # fmt: skip
# The logged fields, by the name the agent sees -> the panel's column key.
METADATA_FIELDS = {
    "Description": "Description",
    "Log Note": "LogNote",
    "Scene": "Scene",
    "Shot": "Shot",
    "Good": "Good",
}


def label_name(index: Any) -> str | None:
    if isinstance(index, int) and 0 <= index < len(PREMIERE_LABEL_COLORS):
        return PREMIERE_LABEL_COLORS[index]
    return None


def _fps(columns: dict[str, Any]) -> float | None:
    match = re.match(r"\s*([\d.]+)", str(columns.get("MediaTimebase") or ""))
    try:
        fps = float(match.group(1)) if match else 0.0
    except ValueError:
        return None
    return round(fps, 3) if fps > 0 else None


def _duration(columns: dict[str, Any]) -> float | None:
    try:
        ticks = int(str(columns.get("MediaDuration") or 0))
    except ValueError:
        return None
    return round(ticks / TICKS_PER_SECOND, 3) if ticks > 0 else None


def _resolution(columns: dict[str, Any]) -> str | None:
    match = re.match(r"\s*(\d+)\s*x\s*(\d+)", str(columns.get("VideoInfo") or ""))
    return f"{match.group(1)}x{match.group(2)}" if match else None


def _type(columns: dict[str, Any]) -> str:
    video, audio = bool(columns.get("VideoInfo")), bool(columns.get("AudioInfo"))
    if video and audio:
        return "Video + Audio"
    if video:
        return "Video" if columns.get("MediaTimebase") else "Still"
    return "Audio" if audio else ""


def metadata(columns: dict[str, Any]) -> dict[str, str]:
    """The logged fields that are set; Good only when it's ticked."""
    logged = {}
    for name, key in METADATA_FIELDS.items():
        value = str(columns.get(key) or "")
        if key == "Good":
            if value.lower() == "true":
                logged[name] = "true"
        elif value:
            logged[name] = value
    return logged


def clip_summary(raw: dict[str, Any], usage: dict[str, Any]) -> dict[str, Any]:
    """One project item as a HostPoolClip (src/types/connect.ts)."""
    columns = raw.get("columns") or {}
    summary: dict[str, Any] = {
        "id": raw["id"],
        "name": raw.get("name", ""),
        "bin": raw.get("bin", ""),
        "type": _type(columns),
    }
    duration, fps, resolution = _duration(columns), _fps(columns), _resolution(columns)
    if duration:
        summary["duration"] = duration
    if fps:
        summary["fps"] = fps
    if resolution:
        summary["resolution"] = resolution
    if raw.get("mediaPath"):
        summary["filePath"] = raw["mediaPath"]
    color = label_name(raw.get("label"))
    if color:
        summary["clipColor"] = color
    summary["usage"] = int(usage.get(raw["id"], 0) or 0)
    if raw.get("offline") or (columns.get("Status") and columns["Status"] != "Online"):
        summary["offline"] = True
    mark_in, mark_out = raw.get("inSeconds"), raw.get("outSeconds")
    if isinstance(mark_in, (int, float)) and isinstance(mark_out, (int, float)):
        # Unmarked, In/Out span the whole media; within a frame of that counts as unmarked.
        frame = 1 / (fps or 25.0)
        whole = mark_in <= frame / 2 and (duration is None or mark_out >= duration - frame)
        if not whole and mark_out > mark_in:
            summary["markIn"], summary["markOut"] = (
                round(mark_in, 3),
                round(mark_out, 3),
            )
    logged = metadata(columns)
    if logged:
        summary["metadata"] = logged
    return summary


def read_project(host: PremiereHost, args: dict[str, Any], usage: bool = True) -> dict[str, Any]:
    """The panel's raw project read: {root, bins: [{id, path, items}], items, truncated, usage,
    selection}."""
    request: dict[str, Any] = {} if usage else {"usage": False}
    if isinstance(args.get("timeline"), str) and args["timeline"]:
        request["timeline"] = args["timeline"]
    return host._send("read_project", request)


def read_media_pool(host: PremiereHost, args: dict[str, Any]) -> dict[str, Any]:
    """{timeline (optional: the connected one, for its selection)} -> bins, clips, sequences, selection,
    shaped like host-resolve's."""
    raw = read_project(host, args)
    usage = raw.get("usage") or {}
    clips: list[dict[str, Any]] = []
    timelines: list[str] = []
    for item in raw.get("items", []):
        if item.get("sequence"):
            timelines.append(item.get("name", ""))
        elif len(clips) < MAX_CLIPS:
            clips.append(clip_summary(item, usage))
    selection = raw.get("selection") or {}
    return {
        "bins": [{"path": b["path"], "clips": int(b.get("items", 0))} for b in raw.get("bins", [])],
        "clips": clips,
        "timelines": timelines,
        "truncated": bool(raw.get("truncated")) or len(clips) >= MAX_CLIPS,
        "selection": {
            "pool": list(selection.get("project") or []),
            "timeline": list(selection.get("timeline") or []),
            "underPlayhead": selection.get("underPlayhead"),
        },
    }


def _clip_id(value: Any) -> str:
    if not isinstance(value, str) or not re.fullmatch(r"[\w-]{1,64}", value):
        raise HostError("clipId must name a clip in the Premiere project")
    return value


def get_clip_info(host: PremiereHost, args: dict[str, Any]) -> dict[str, Any]:
    """{clipId} -> the clip's summary, its own markers (seconds from the clip's start) and every Project
    panel column that's set."""
    raw = host._send("project_item_info", {"id": _clip_id(args.get("clipId"))})
    if raw.get("sequence"):
        raise HostError(f"{raw.get('name')!r} is a sequence, not a clip")
    info = clip_summary(raw, {raw["id"]: raw.get("usage", 0)})
    info["markers"] = [
        {
            "time": round(int(m["startTicks"]) / TICKS_PER_SECOND, 3),
            "name": m.get("name", ""),
            "color": color_name(m.get("colorIndex")),
            "note": m.get("comments", ""),
            "duration": round(max(0, int(m["endTicks"]) - int(m["startTicks"])) / TICKS_PER_SECOND, 3),
        }
        for m in sorted(raw.get("markers") or [], key=lambda m: int(m["startTicks"]))
    ]
    info["properties"] = dict(sorted((raw.get("columns") or {}).items()))
    return info


def _normal(value: Any) -> str:
    """ "Video + Audio" and "video+audio" alike."""
    return "".join(str(value).lower().split())


def _matches(summary: dict[str, Any], args: dict[str, Any]) -> bool:
    text = args.get("text")
    if isinstance(text, str) and text.strip():
        haystack = " ".join(
            [
                summary.get("name", ""),
                summary.get("bin", ""),
                summary.get("filePath", ""),
            ]
            + [str(v) for v in summary.get("metadata", {}).values()]
        ).lower()
        if not all(word in haystack for word in text.lower().split()):
            return False
    color = args.get("clipColor")
    if (
        isinstance(color, str)
        and color.strip()
        and summary.get("clipColor", "").lower() != color.strip().lower()
    ):
        return False
    kind = args.get("type")
    if isinstance(kind, str) and kind.strip() and _normal(kind) != _normal(summary.get("type", "")):
        return False
    bin_name = args.get("bin")
    if (
        isinstance(bin_name, str)
        and bin_name.strip()
        and bin_name.strip().lower() not in summary.get("bin", "").lower()
    ):
        return False
    if args.get("unused") is True and summary.get("usage", 0) > 0:
        return False
    return not (args.get("marked") is True and "markIn" not in summary)


def search_media_pool(host: PremiereHost, args: dict[str, Any]) -> dict[str, Any]:
    """{text, clipColor (a label colour), type ("Video + Audio", "Video", "Audio", "Still": exact), bin,
    unused, marked} -- all optional, all must match. Premiere has no keywords or flags."""
    for name, what in (("keyword", "keywords"), ("flag", "flags")):
        if isinstance(args.get(name), str) and args[name].strip():
            raise HostError(f"Premiere's project has no {what}; search with text instead")
    raw = read_project(host, {})
    usage = raw.get("usage") or {}
    results: list[dict[str, Any]] = []
    total = 0
    for item in raw.get("items", []):
        if item.get("sequence"):
            continue
        summary = clip_summary(item, usage)
        if _matches(summary, args):
            total += 1
            if len(results) < MAX_RESULTS:
                results.append(summary)
    return {"clips": results, "total": total}
