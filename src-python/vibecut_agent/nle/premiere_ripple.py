"""premiere_ripple.py -- ripple edits on the connected Premiere sequence (PLAN.md, "Ripple edits on the
timeline").

A ripple changes the time on every track at once, as Premiere's Ripple Delete does with sync lock on, so
picture and sound stay in sync:
- `ripple_delete` {timeline, ranges: [{start, end}]} takes stretches of time out: each clip running across
  an edge is cut there (QE's razor, up to 200 cuts a call), the clips inside are lifted, everything after
  moves earlier by the time taken out before it (`shift_items`, one call), and the pieces right of each cut
  are linked again as the clips they came from were (`link_groups`, one call). A stretch with nothing in
  it closes a gap. Ranges are seconds on the sequence as it is when the call runs; overlapping or touching
  ones are merged.
- `insert_time` {timeline, at, seconds} opens up time: each clip running across `at` is cut there, and
  everything from `at` on moves later.

So hundreds of silences go in a few panel calls, not a few each. Both refuse before changing anything when
a locked track has a clip they would cut, lift or move (it would fall out of sync), when a transition is
where they cut, lift or move (whether Premiere moves a transition with its clip isn't checked yet), or when
nothing would change. If a step fails part way, what was done is undone before the error is raised.

Change records, oldest first: a "split" per cut point (premiere_timing's, reverted by joining the pieces),
a "deleted" per lifted clip (premiere_edit's, put back from its file) and one "shifted" (moved back). The
revert, newest first, moves the later clips back, puts the lifted ones back and joins the cuts.
"""

from __future__ import annotations

from typing import Any

from vibecut_agent.nle.premiere import HostError, seconds
from vibecut_agent.nle.premiere_edit import (
    Sequence,
    _deleted,
    _label,
    _number,
    _placement,
    _read,
    _shift,
    revert_timeline_changes,
)
from vibecut_agent.nle.premiere_timing import timecode

MAX_RANGES = 1000
MAX_INSERT_SECONDS = 3600.0
# QE razor cuts a call (the panel's razor_cuts allows 200).
RAZOR_CHUNK = 200
# Clips lifted a call (the panel's remove_items allows 500).
REMOVE_CHUNK = 500


def _ranges(seq: Sequence, raw: Any) -> list[tuple[int, int]]:
    """The ranges in ticks, on whole frames, sorted, with overlapping and touching ones merged."""
    if not isinstance(raw, list) or not raw or len(raw) > MAX_RANGES:
        raise HostError(f"ranges must list 1 to {MAX_RANGES} stretches of the sequence")
    spans = []
    for i, entry in enumerate(raw):
        if not isinstance(entry, dict):
            raise HostError(f"ranges[{i}] must be {{start, end}}")
        start = seq.ticks(_number(entry.get("start"), f"ranges[{i}].start", 0))
        end = seq.ticks(_number(entry.get("end"), f"ranges[{i}].end", 0))
        if end <= start:
            raise HostError(f"ranges[{i}] must end at least a frame after it starts")
        spans.append((start, end))
    merged: list[tuple[int, int]] = []
    for start, end in sorted(spans):
        if merged and start <= merged[-1][1]:
            merged[-1] = (merged[-1][0], max(merged[-1][1], end))
        else:
            merged.append((start, end))
    return merged


def _span(clip: dict[str, Any]) -> tuple[int, int]:
    return int(clip["startTicks"]), int(clip["endTicks"])


def _refuse(seq: Sequence, clips: list[dict[str, Any]], what: str, region_start: int) -> None:
    """HostError when one of `clips` is on a locked track, or a transition is at or after `region_start`
    on a track a ripple changes."""
    for clip in clips:
        if seq.locked(clip["kind"], clip["index"]):
            raise HostError(
                f"{clip.get('name') or clip['id']} on {_label(clip['kind'], clip['index'])} would be {what}, "
                "but its track is locked; unlock it in Premiere so it stays in sync, or ask the user"
            )
    tracks = {(c["kind"], c["index"]) for c in clips}
    for kind, index in sorted(tracks):
        for transition in seq.tracks[kind][index - 1].get("transitions", []):
            if int(transition["endTicks"]) > region_start:
                raise HostError(
                    f"{_label(kind, index)} has a transition at {seconds(transition['startTicks'])} s, where "
                    "this ripple changes the track; a ripple can't take transitions with it yet. Remove it "
                    "first, or ripple before it"
                )


def _cut(
    host: Any, timeline: str, seq: Sequence, points: list[int]
) -> tuple[Sequence, list[dict[str, Any]], dict[str, dict[int, str]]]:
    """Cuts every clip running across each point. Returns the sequence after, a "split" record per point
    (oldest first), and for each clip cut, its piece starting at each point (clip id -> {point: piece id})."""
    crossing = [
        (clip, point)
        for clip in seq.clips.values()
        for point in points
        if _span(clip)[0] < point < _span(clip)[1]
    ]
    if not crossing:
        return seq, [], {}
    cuts = sorted(
        {(clip["kind"], clip["index"], point) for clip, point in crossing}, key=lambda c: (c[2], c[0], c[1])
    )
    calls = [
        {"type": kind, "track": index - 1, "timecode": timecode(seq, point)} for kind, index, point in cuts
    ]
    for i in range(0, len(calls), RAZOR_CHUNK):
        host._send("razor_cuts", {"timeline": timeline, "cuts": calls[i : i + RAZOR_CHUNK]})
    after = _read(host, timeline)
    new = {i: c for i, c in after.clips.items() if i not in seq.clips}
    pieces: dict[str, dict[int, str]] = {}
    records: dict[int, list[dict[str, Any]]] = {}
    for clip in seq.clips.values():
        start, end = _span(clip)
        inner = sorted(p for p in points if start < p < end)
        if not inner:
            continue
        # The clip keeps its id on the left; Premiere makes a new clip from each cut on.
        left = after.clips.get(clip["id"])
        on_track = sorted(
            (c for c in new.values() if (c["kind"], c["index"]) == (clip["kind"], clip["index"])),
            key=lambda c: int(c["startTicks"]),
        )
        found = {p: next((c for c in on_track if int(c["startTicks"]) == p), None) for p in inner}
        if left is None or int(left["endTicks"]) != inner[0] or any(c is None for c in found.values()):
            _undo_cuts(host, timeline, after, seq, new)
            raise HostError(
                f"Premiere didn't cut {clip.get('name') or clip['id']} on "
                f"{_label(clip['kind'], clip['index'])} at {', '.join(f'{seconds(p)} s' for p in inner)}, "
                "so the cuts were taken back and nothing changed"
            )
        pieces[clip["id"]] = {p: str(found[p]["id"]) for p in inner}  # type: ignore[index]
        # One record per cut, as if the cuts were made one after another: each splits the piece the one
        # before left on the right.
        current = clip
        for p in inner:
            piece = found[p]
            assert piece is not None
            whole = dict(current)
            left_part = {
                **current,
                "endTicks": str(p),
                "outTicks": str(int(current["inTicks"]) + p - int(current["startTicks"])),
            }
            right_part = {
                **piece,
                "endTicks": str(end),
                "outTicks": str(int(piece["inTicks"]) + end - p),
            }
            records.setdefault(p, []).append(
                {
                    "before": _placement(whole, seq.fps),
                    "after": _placement(left_part, seq.fps),
                    "right": _placement(right_part, seq.fps),
                }
            )
            current = right_part
    splits = [
        {
            "kind": "split",
            "name": f"{len(items)} clip(s)",
            "cut": seconds(p),
            "items": items,
            "notCarried": [],
        }
        for p, items in sorted(records.items())
    ]
    return after, splits, pieces


def _undo_cuts(
    host: Any, timeline: str, after: Sequence, before: Sequence, new: dict[str, dict[str, Any]]
) -> None:
    """Takes cuts back: the new pieces go and each cut clip gets its whole length again."""
    from vibecut_agent.nle.premiere_edit import _put

    if new:
        ids = list(new)
        for i in range(0, len(ids), REMOVE_CHUNK):
            host._send("remove_items", {"timeline": timeline, "ids": ids[i : i + REMOVE_CHUNK]})
    now = _read(host, timeline)
    cut = [c for i, c in before.clips.items() if i in now.clips and now.clips[i]["endTicks"] != c["endTicks"]]
    if cut:
        _put(host, timeline, now, [_placement(c, now.fps) for c in cut])


def _relink(
    host: Any, timeline: str, before: Sequence, pieces: dict[str, dict[int, str]], keep: set[str]
) -> None:
    """Links the pieces each cut made as the clips they came from were linked, where they're kept."""
    groups: list[list[str]] = []
    done: set[str] = set()
    for clip_id, by_point in pieces.items():
        for point, piece in by_point.items():
            if piece in done or piece not in keep:
                continue
            group = [piece]
            for partner in before.clips[clip_id].get("linkedIds", []):
                other = pieces.get(partner, {}).get(point)
                if other is not None and other in keep and other not in group:
                    group.append(other)
            done.update(group)
            if len(group) > 1:
                groups.append(group)
    if groups:
        host._send("link_groups", {"timeline": timeline, "groups": groups})


def _undo(host: Any, timeline: str, changes: list[dict[str, Any]]) -> str:
    if not changes:
        return "nothing had changed"
    try:
        result = revert_timeline_changes(host, {"timeline": timeline, "changes": changes})
    except HostError as exc:
        return f"undoing what was done failed too ({exc}); the request's backup has the sequence as it was"
    left = [*result.get("changedSince", []), *result.get("failed", [])]
    if left:
        return f"{len(left)} of its {len(changes)} change(s) couldn't be undone; the request's backup has the sequence as it was"
    return "what was done was undone"


def ripple_delete(host: Any, args: dict[str, Any]) -> dict[str, Any]:
    """See the module docstring."""
    timeline = host._name(args)
    seq = _read(host, timeline)
    ranges = _ranges(seq, args.get("ranges"))
    first = ranges[0][0]
    affected = [c for c in seq.clips.values() if _span(c)[1] > first]
    if not affected:
        raise HostError(
            f"Nothing on the sequence is at or after {seconds(first)} s, so there's nothing to close up"
        )
    _refuse(seq, affected, "cut, lifted or moved", first)
    points = sorted({p for r in ranges for p in r})
    changes: list[dict[str, Any]] = []
    try:
        after, splits, pieces = _cut(host, timeline, seq, points)
        changes += splits
        inside = [
            c
            for c in after.clips.values()
            if any(start <= _span(c)[0] and _span(c)[1] <= end for start, end in ranges)
        ]
        lifted = {c["id"] for c in inside}
        if inside:
            records = []
            for clip in inside:
                group = [i for i in after.partners(clip["id"]) if i in lifted]
                records.append(_deleted(clip, group, after.channel(clip)))
            ids = [c["id"] for c in inside]
            gone: set[str] = set()
            for i in range(0, len(ids), REMOVE_CHUNK):
                removed = host._send("remove_items", {"timeline": timeline, "ids": ids[i : i + REMOVE_CHUNK]})
                gone |= set(removed.get("removed", []))
            changes += [r for r in records if r["itemId"] in gone]
            if gone != lifted:
                raise HostError(f"Premiere lifted {len(gone)} of the {len(lifted)} clips in the stretches")
            after = _read(host, timeline)
        offsets: dict[str, int] = {}
        for clip in after.clips.values():
            start = _span(clip)[0]
            taken = sum(end - begin for begin, end in ranges if end <= start)
            if taken:
                offsets[clip["id"]] = -taken
        if offsets:
            after = _shift(host, timeline, after, offsets)
            changes.append(_shifted(after, offsets))
        _relink(host, timeline, seq, pieces, set(after.clips))
    except HostError as exc:
        raise HostError(f"{exc}; {_undo(host, timeline, changes)}") from None
    removed_total = sum(end - start for start, end in ranges)
    return {
        "changes": changes,
        "refused": [],
        "renamed": {},
        "removedSeconds": seconds(removed_total),
        "lifted": len(lifted),
        "moved": len(offsets),
    }


def insert_time(host: Any, args: dict[str, Any]) -> dict[str, Any]:
    """See the module docstring."""
    timeline = host._name(args)
    seq = _read(host, timeline)
    at = seq.ticks(_number(args.get("at"), "at", 0))
    length = seq.ticks(_number(args.get("seconds"), "seconds", 0))
    if length <= 0 or length > seq.ticks(MAX_INSERT_SECONDS):
        raise HostError(f"seconds must be at least a frame and at most {MAX_INSERT_SECONDS:g}")
    affected = [c for c in seq.clips.values() if _span(c)[1] > at]
    if not affected:
        raise HostError(f"Nothing on the sequence is after {seconds(at)} s, so there's nothing to move")
    _refuse(seq, affected, "cut or moved", at)
    changes: list[dict[str, Any]] = []
    try:
        after, splits, pieces = _cut(host, timeline, seq, [at])
        changes += splits
        offsets = {c["id"]: length for c in after.clips.values() if _span(c)[0] >= at}
        after = _shift(host, timeline, after, offsets)
        changes.append(_shifted(after, offsets))
        _relink(host, timeline, seq, pieces, set(after.clips))
    except HostError as exc:
        raise HostError(f"{exc}; {_undo(host, timeline, changes)}") from None
    return {"changes": changes, "refused": [], "renamed": {}, "moved": len(offsets)}


def _shifted(after: Sequence, offsets: dict[str, int]) -> dict[str, Any]:
    from vibecut_agent.nle.premiere import TICKS_PER_SECOND

    return {
        "kind": "shifted",
        "name": f"{len(offsets)} clip(s)",
        "moves": [
            {
                "itemId": item_id,
                "offset": round(offset / TICKS_PER_SECOND, 6),
                "offsetTicks": str(offset),
                "startTicks": after.clips[item_id]["startTicks"],
            }
            for item_id, offset in offsets.items()
        ],
    }
