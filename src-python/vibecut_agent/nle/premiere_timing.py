"""premiere_timing.py -- speed, splits and tracks on the connected Premiere sequence (PLAN.md, "Phase 7b").

The same change records and Revert as premiere_edit.py and host-resolve's resolve_timing.py:
- `set_clip_speed` sets a clip's constant speed, and its linked partners', through QE (the panel's
  `set_speed`). Premiere keeps the clip's length, so it shows more or less of its source. A ripple
  isn't possible here (Premiere's setSpeed never moves later clips), so the agent does that in a
  draft. Fade keys sit at source times and wouldn't follow, so a clip with fades is refused.
- `split_clips` razors the tracks of the clips and their linked partners at a time (the panel's
  `razor`), then links the right pieces together as the left ones are. Revert removes the right
  pieces and gives the left ones their old ends.
- `add_track` adds tracks at the end through QE; `remove_track` removes the last empty one.

What Premiere 26.5.2 does (PLAN.md, "7b.0 probe"): setSpeed changes only the item it's called on and
leaves CEP's start/end/inPoint/outPoint as they were (inPoint and outPoint are in speed-scaled ticks,
so the source is in + duration x speed); a razor keeps the left piece's id and links, and the right
piece is new and unlinked.
"""

from __future__ import annotations

from typing import Any

from vibecut_agent.nle.premiere import TICKS_PER_SECOND, HostError, seconds
from vibecut_agent.nle.premiere_edit import (
    Sequence,
    _add_tracks,
    _ids,
    _label,
    _number,
    _placement,
    _put,
    _read,
    _remove_tracks,
)
from vibecut_agent.nle.premiere_support import Probe

MIN_SPEED, MAX_SPEED = 0.05, 20.0
MAX_NEW_TRACKS = 4


# ------------------------------------------------------------------------------- speed


def _speed(clip: dict[str, Any]) -> float:
    speed = clip.get("speed")
    return round(float(speed), 4) if isinstance(speed, (int, float)) and speed > 0 else 1.0


def set_clip_speed(host: Any, args: dict[str, Any], probe: Any = None) -> dict[str, Any]:
    """{timeline, itemId, speed (0.05-20, 1 is normal)} -> the clip and its linked partners play at
    that speed, each keeping its length."""
    probe = probe or Probe()
    if args.get("ripple") is True:
        raise HostError("Premiere can't ripple a speed change from a script; do it in a draft")
    timeline = host._name(args)
    seq = _read(host, timeline)
    clip = seq.clip(args.get("itemId"))
    speed = _number(args.get("speed"), "speed")
    if not MIN_SPEED <= speed <= MAX_SPEED:
        raise HostError(f"speed must be from {MIN_SPEED} to {MAX_SPEED:g} (1 is normal)")
    members = [seq.clips[i] for i in seq.partners(clip["id"])]
    for m in members:
        if m.get("adjustment") or not m.get("mediaPath"):
            raise HostError(f"{m['name']} has no media file; its speed can't be set here")
        if m.get("reversed"):
            raise HostError(f"{m['name']} plays in reverse; change it in Premiere")
    if all(abs(_speed(m) - speed) < 1e-4 for m in members):
        return {"changes": [], "refused": []}
    from vibecut_agent.nle.premiere_effects import has_fades

    faded = has_fades(host, timeline, seq, [m["id"] for m in members])
    if faded:
        raise HostError(
            f"{faded} has a fade or keyframes, which sit at source times and wouldn't follow the speed; remove the fade first"
        )
    duration = (probe.timecode(clip["mediaPath"]) or {}).get("duration")
    for m in members:
        source_in = int(m["inTicks"]) * _speed(m)
        needed = source_in + (int(m["endTicks"]) - int(m["startTicks"])) * speed
        if duration and needed > duration * TICKS_PER_SECOND + seq.timebase:
            raise HostError(
                f"{m['name']}'s file runs out at {speed:g}x for its length; trim it first, or do it in a draft"
            )
    answer = host._send(
        "set_speed",
        {
            "timeline": timeline,
            "items": [{"id": m["id"], "speed": speed} for m in members],
        },
    )
    speeds = answer.get("speeds") or {}
    missed = [
        m
        for m in members
        if not isinstance(speeds.get(m["id"]), (int, float)) or abs(float(speeds[m["id"]]) - speed) > 1e-3
    ]
    if missed:
        host._send(
            "set_speed",
            {
                "timeline": timeline,
                "items": [{"id": m["id"], "speed": _speed(m)} for m in members],
            },
        )
        raise HostError(f"Premiere didn't set {missed[0]['name']} to {speed:g}x, so it was put back")
    return {
        "changes": [
            {
                "kind": "speed",
                "itemId": clip["id"],
                "name": clip.get("name", ""),
                "before": _speed(clip),
                "after": round(speed, 4),
                "ripple": False,
                "speeds": [{"id": m["id"], "before": _speed(m)} for m in members],
                "start": seconds(clip["startTicks"]),
                "end": seconds(clip["endTicks"]),
                "endBefore": seconds(clip["endTicks"]),
            }
        ],
        "refused": [],
    }


def revert_speed(host: Any, timeline: str, seq: Sequence, change: dict[str, Any], current: Any) -> str:
    items = [(current(i["id"]), i["before"]) for i in change.get("speeds", [])]
    if not items or any(i not in seq.clips for i, _ in items):
        return "changed"
    if any(abs(_speed(seq.clips[i]) - float(change["after"])) > 1e-3 for i, _ in items):
        return "changed"
    answer = host._send(
        "set_speed",
        {
            "timeline": timeline,
            "items": [{"id": i, "speed": float(b)} for i, b in items],
        },
    )
    speeds = answer.get("speeds") or {}
    return (
        "reverted"
        if all(
            isinstance(speeds.get(i), (int, float)) and abs(float(speeds[i]) - float(b)) < 1e-3
            for i, b in items
        )
        else "failed"
    )


# ------------------------------------------------------------------------------- splitting


def timecode(seq: Sequence, ticks: int) -> str:
    """The sequence's own timecode of a point, counting whole frames at its nominal rate (the zero
    point included, as Premiere shows it)."""
    frames = (int(seq.raw.get("zeroPoint") or 0) + ticks) // seq.timebase
    nominal = max(1, round(TICKS_PER_SECOND / seq.timebase))
    ff = frames % nominal
    total = frames // nominal
    return f"{total // 3600:02d}:{total // 60 % 60:02d}:{total % 60:02d}:{ff:02d}"


def split_clips(host: Any, args: dict[str, Any]) -> dict[str, Any]:
    """{timeline, itemIds, time (seconds from the sequence's start)} -> each clip, with its linked
    partners that run across the time, cut in two there. The right pieces are linked within the
    link group each came from."""
    timeline = host._name(args)
    seq = _read(host, timeline)
    cut = seq.ticks(_number(args.get("time"), "time", 0))
    group: list[str] = []
    # Each target's link group, so right pieces are linked only within the group they came from.
    groups: list[list[str]] = []
    for item_id in _ids(args):
        clip = seq.clip(item_id)
        if not int(clip["startTicks"]) < cut < int(clip["endTicks"]):
            raise HostError(
                f"{clip['name']} doesn't run across {seconds(cut)} s, so there's nothing to split"
            )
        crossing = []
        for other in seq.partners(item_id):
            o = seq.clips[other]
            if int(o["startTicks"]) < cut < int(o["endTicks"]):
                crossing.append(other)
                if other not in group:
                    group.append(other)
        joined = [g for g in groups if set(g) & set(crossing)]
        merged = list(dict.fromkeys([i for g in joined for i in g] + crossing))
        groups = [g for g in groups if g not in joined] + [merged]
    members = [seq.clips[i] for i in group]
    host._send("razor", {"timeline": timeline, "ids": group, "timecode": timecode(seq, cut)})
    after = _read(host, timeline)
    rights: dict[str, dict[str, Any]] = {}
    new = [c for i, c in after.clips.items() if i not in seq.clips]
    for m in members:
        right = next(
            (
                c
                for c in new
                if (c["kind"], c["index"]) == (m["kind"], m["index"]) and int(c["startTicks"]) == cut
            ),
            None,
        )
        left = after.clips.get(m["id"])
        if right is None or left is None or int(left["endTicks"]) != cut:
            _undo_razor(host, timeline, after, members, new)
            raise HostError(
                f"Premiere didn't cut {m['name']} at {seconds(cut)} s ({timecode(seq, cut)}), so it was put back"
            )
        rights[m["id"]] = right
    for linked in groups:
        if len(linked) > 1:
            host._send(
                "link_items",
                {"timeline": timeline, "ids": [rights[i]["id"] for i in linked]},
            )
    items = [
        {
            "before": _placement(m, seq.fps),
            "after": _placement(after.clips[m["id"]], seq.fps),
            "right": _placement(rights[m["id"]], seq.fps),
        }
        for m in members
    ]
    return {
        "changes": [
            {
                "kind": "split",
                "name": members[0].get("name", ""),
                "cut": seconds(cut),
                "items": items,
                "notCarried": [],
            }
        ],
        "refused": [],
        "renamed": {},
    }


def _undo_razor(
    host: Any,
    timeline: str,
    after: Sequence,
    members: list[dict[str, Any]],
    new: list[dict[str, Any]],
) -> None:
    if new:
        host._send("remove_items", {"timeline": timeline, "ids": [c["id"] for c in new]})
    now = _read(host, timeline)
    alive = [m for m in members if m["id"] in now.clips]
    if alive:
        _put(host, timeline, now, [_placement(m, now.fps) for m in alive])


def _near(seq: Sequence, clip: dict[str, Any], ticks: dict[str, Any]) -> bool:
    """Within half a frame: a speed set and set back leaves the ticks a hair off (7b, checked live)."""
    keys = ("startTicks", "endTicks", "inTicks", "outTicks")
    return all(abs(int(clip[k]) - int(ticks[k])) <= seq.timebase // 2 for k in keys)


def revert_split(host: Any, timeline: str, seq: Sequence, change: dict[str, Any], current: Any) -> str:
    items = change.get("items", [])
    for entry in items:
        left, right = current(entry["after"]["id"]), entry["right"]["id"]
        if left not in seq.clips or right not in seq.clips:
            return "changed"
        if not (
            _near(seq, seq.clips[left], entry["after"]["ticks"])
            and _near(seq, seq.clips[right], entry["right"]["ticks"])
        ):
            return "changed"
    host._send("remove_items", {"timeline": timeline, "ids": [e["right"]["id"] for e in items]})
    now = _read(host, timeline)
    _put(
        host,
        timeline,
        now,
        [{**e["before"], "id": current(e["after"]["id"])} for e in items],
    )
    return "reverted"


# ------------------------------------------------------------------------------- tracks


def _kind(args: dict[str, Any]) -> str:
    kind = args.get("type")
    if kind not in ("video", "audio"):
        raise HostError('type must be "video" or "audio"')
    return kind


def add_track(host: Any, args: dict[str, Any]) -> dict[str, Any]:
    """{timeline, type, count (1-4, default 1)} -> new empty tracks at the end."""
    timeline = host._name(args)
    kind = _kind(args)
    count = int(_number(args.get("count", 1), "count"))
    if not 1 <= count <= MAX_NEW_TRACKS:
        raise HostError(f"count must be from 1 to {MAX_NEW_TRACKS}")
    before = len(_read(host, timeline).tracks[kind])
    _add_tracks(host, timeline, count if kind == "video" else 0, count if kind == "audio" else 0)
    added = list(range(before + 1, before + count + 1))
    return {
        "changes": [
            {
                "kind": "track",
                "action": "added",
                "type": kind,
                "indexes": added,
                "name": ", ".join(_label(kind, i) for i in added),
            }
        ],
        "refused": [],
        "addedTracks": [_label(kind, i) for i in added],
    }


def remove_track(host: Any, args: dict[str, Any]) -> dict[str, Any]:
    """{timeline, type, index (1-based; must be the last of its kind)} -> removes it if it's empty."""
    timeline = host._name(args)
    kind = _kind(args)
    seq = _read(host, timeline)
    count = len(seq.tracks[kind])
    index = int(_number(args.get("index", count), "index"))
    if index != count or count <= 1:
        raise HostError(
            f"Only the last {kind} track can be removed, and not the only one ({_label(kind, count)} is the last)"
        )
    if seq.busy(kind, index):
        raise HostError(f"{_label(kind, index)} has clips on it; only an empty track is removed")
    _remove_tracks(host, timeline, [[kind, index]])
    if len(_read(host, timeline).tracks[kind]) != count - 1:
        return {
            "changes": [],
            "refused": [{"reason": "Premiere didn't remove the track"}],
        }
    return {
        "changes": [
            {
                "kind": "track",
                "action": "removed",
                "type": kind,
                "indexes": [index],
                "name": _label(kind, index),
            }
        ],
        "refused": [],
    }


def revert_track(host: Any, timeline: str, seq: Sequence, change: dict[str, Any]) -> str:
    kind = change["type"]
    indexes = sorted(int(i) for i in change.get("indexes", []))
    count = len(seq.tracks[kind])
    if change.get("action") == "added":
        if count != indexes[-1] or any(seq.busy(kind, i) for i in indexes):
            return "changed"
        _remove_tracks(host, timeline, [[kind, i] for i in reversed(indexes)])
        return "reverted" if len(_read(host, timeline).tracks[kind]) == count - len(indexes) else "failed"
    if count != indexes[0] - 1:
        return "changed"
    try:
        _add_tracks(host, timeline, 1 if kind == "video" else 0, 1 if kind == "audio" else 0)
    except HostError:
        return "failed"
    return "reverted"
