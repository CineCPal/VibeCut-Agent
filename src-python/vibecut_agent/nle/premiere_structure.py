"""premiere_structure.py -- track options on the connected Premiere sequence (PLAN.md, "Phase 12d"), from
VibeCut's host-premiere/premiere_structure.py (its "Phase 8a"). Only its track options are ported here;
its links are links.py's, and moving several clips at once isn't ported.

The same change log and Revert as premiere_edit.py: `set_track_options` sets a track's `muted`
(`enabled` is its opposite: a video track's output, an audio track's mute), `locked` and `targeted`
through CEP, and `syncLocked` through QE. Premiere's scripting has no solo.
"""

from __future__ import annotations

from typing import Any

from vibecut_agent.nle.premiere import HostError
from vibecut_agent.nle.premiere_edit import Sequence, _label, _number, _read

TRACK_OPTIONS = ("muted", "locked", "targeted", "syncLocked")


# ------------------------------------------------------------------------------- track options


def _track_request(seq: Sequence, args: dict[str, Any]) -> tuple[str, int]:
    kind = args.get("type")
    if kind not in ("video", "audio"):
        raise HostError('type must be "video" or "audio"')
    index = int(_number(args.get("index"), "index"))
    if index < 1 or index > len(seq.tracks[kind]):
        raise HostError(f"There is no {_label(kind, index)}")
    return kind, index


def set_track_options(host: Any, args: dict[str, Any]) -> dict[str, Any]:
    """{timeline, type, index (1-based), options: {enabled?, muted?, locked?, targeted?, syncLocked?}}
    -> the track switched. `enabled` is the opposite of `muted`."""
    timeline = host._name(args)
    seq = _read(host, timeline)
    kind, index = _track_request(seq, args)
    options = args.get("options")
    if not isinstance(options, dict) or not options:
        raise HostError("options must set at least one option")
    wanted: dict[str, bool] = {}
    for key, value in options.items():
        if key == "soloed":
            raise HostError("Premiere's scripting can't solo a track")
        if key not in (*TRACK_OPTIONS, "enabled"):
            raise HostError(f"Premiere's scripting can't set a track's {key}")
        if not isinstance(value, bool):
            raise HostError(f"{key} must be true or false")
        name, value = ("muted", not value) if key == "enabled" else (key, value)
        if wanted.get(name, value) != value:
            raise HostError("enabled and muted contradict each other")
        wanted[name] = value
    answer = host._send(
        "set_track_options",
        {
            "timeline": timeline,
            "kind": kind,
            "index": index - 1,
            "options": wanted,
            "keys": list(wanted),
        },
    )
    before, after = answer.get("before") or {}, answer.get("after") or {}
    missed = [k for k, v in wanted.items() if after.get(k) != v]
    if missed:
        host._send(
            "set_track_options",
            {
                "timeline": timeline,
                "kind": kind,
                "index": index - 1,
                "options": before,
                "keys": list(before),
            },
        )
        raise HostError(
            f"Premiere didn't set {_label(kind, index)}'s {', '.join(missed)}, so nothing changed"
        )
    changed = {k: [before.get(k), after[k]] for k in wanted if before.get(k) != after[k]}
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


def revert_track_options(host: Any, timeline: str, change: dict[str, Any]) -> str:
    """ "reverted", "changed" (an option was changed since) or "failed"."""
    kind, index = change.get("type"), int(change.get("index") or 0)
    options = change.get("options") or {}
    seq = _read(host, timeline)
    if kind not in ("video", "audio") or index < 1 or index > len(seq.tracks[kind]):
        return "changed"
    base = {
        "timeline": timeline,
        "kind": kind,
        "index": index - 1,
        "keys": list(options),
    }
    now = host._send("set_track_options", {**base, "options": {}}).get("after") or {}
    if any(now.get(k) != after for k, (_before, after) in options.items()):
        return "changed"
    back = {k: before for k, (before, _after) in options.items()}
    done = host._send("set_track_options", {**base, "options": back}).get("after") or {}
    return "reverted" if all(done.get(k) == v for k, v in back.items()) else "failed"
