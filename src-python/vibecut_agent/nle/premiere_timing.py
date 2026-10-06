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
    _ids,
    _number,
    _placement,
    _put,
    _read,
)

MIN_SPEED, MAX_SPEED = 0.05, 20.0
MAX_NEW_TRACKS = 4


# ------------------------------------------------------------------------------- speed


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
