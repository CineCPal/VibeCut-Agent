"""resolve_structure.py -- track options on the connected Resolve timeline (PLAN.md, "Phase 12d"), from
VibeCut's host-resolve/resolve_structure.py (its "Phase 8a"). Only its track options are ported here;
its links are links.py's, and moving several clips at once isn't ported.

The same change log and Revert as resolve_edit.py: `set_track_options` sets a track's `enabled` and
`locked`, the two Resolve's scripting has, and only on the timeline open in Resolve (on another one the
setters return False and the getters False). Mute, solo and sync lock aren't scriptable.
"""

from __future__ import annotations

from typing import Any

from vibecut_agent.nle.resolve import HostError, _number, _track_locked
from vibecut_agent.nle.resolve_reshape import _label

TRACK_OPTIONS = ("enabled", "locked")


def _read_options(timeline: Any, kind: str, index: int) -> dict[str, bool]:
    return {
        "enabled": bool(timeline.GetIsTrackEnabled(kind, index)),
        "locked": _track_locked(timeline, kind, index),
    }


def _set_option(timeline: Any, kind: str, index: int, option: str, value: bool) -> bool:
    if option == "enabled":
        return bool(timeline.SetTrackEnable(kind, index, value))
    return bool(timeline.SetTrackLock(kind, index, value))


def set_track_options(host: Any, args: dict[str, Any]) -> dict[str, Any]:
    """{timeline, type, index (1-based), options: {enabled?, locked?}} -> the track switched. Only on
    the timeline open in Resolve."""
    project, timeline = host._timeline(args)
    kind = args.get("type")
    if kind not in ("video", "audio"):
        raise HostError('type must be "video" or "audio"')
    index = int(_number(args.get("index"), "index"))
    if index < 1 or index > int(timeline.GetTrackCount(kind) or 0):
        raise HostError(f"There is no {_label(kind, index)}")
    options = args.get("options")
    if not isinstance(options, dict) or not options:
        raise HostError("options must set at least one of enabled or locked")
    for key, value in options.items():
        if key not in TRACK_OPTIONS:
            raise HostError(f"Resolve's scripting can't set a track's {key}; only enabled and locked")
        if not isinstance(value, bool):
            raise HostError(f"{key} must be true or false")
    current = project.GetCurrentTimeline()
    if not current or current.GetName() != timeline.GetName():
        raise HostError(
            f"Resolve only changes the tracks of the timeline open in it; open {timeline.GetName()!r} in Resolve first"
        )
    before = _read_options(timeline, kind, index)
    changed: dict[str, list[bool]] = {}
    for key, value in options.items():
        if before[key] == value:
            continue
        if not _set_option(timeline, kind, index, key, value):
            for done, (old, _new) in changed.items():
                _set_option(timeline, kind, index, done, old)
            raise HostError(f"Resolve didn't set {_label(kind, index)}'s {key}, so nothing changed")
        changed[key] = [before[key], value]
    if not changed:
        return {"changes": [], "refused": []}
    return {
        "changes": [
            {
                "kind": "trackOptions",
                "name": _label(kind, index),
                "type": kind,
                "index": index,
                "options": changed,
            }
        ],
        "refused": [],
    }


def revert_track_options(project: Any, timeline: Any, change: dict[str, Any]) -> str:
    """ "reverted", "changed" (an option was changed since), or "failed" (not the open timeline)."""
    kind, index = change.get("type"), int(change.get("index") or 0)
    options = change.get("options") or {}
    if kind not in ("video", "audio") or index < 1 or index > int(timeline.GetTrackCount(kind) or 0):
        return "changed"
    current = project.GetCurrentTimeline()
    if not current or current.GetName() != timeline.GetName():
        return "failed"
    now = _read_options(timeline, kind, index)
    if any(now.get(k) != after for k, (_before, after) in options.items()):
        return "changed"
    ok = all(_set_option(timeline, kind, index, k, before) for k, (before, _after) in options.items())
    return "reverted" if ok else "failed"
