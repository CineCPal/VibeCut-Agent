"""resolve_timing.py -- speed, splits and tracks on the connected Resolve timeline (PLAN.md, "Phase 7b").

The same change log and Revert as resolve_edit.py:
- `set_clip_speed` sets a clip's constant speed with `TimelineItem.SetSpeed`. Without ripple the clip
  keeps its place and length and shows more or less of its source; with ripple its length changes and
  every later clip on every track (and the markers) moves with it. Its linked sound follows, and its id
  stays. Revert sets the old speed the same way.
- `split_clips` cuts clips (with their linked picture or sound) in two at a time. Resolve has no razor,
  so each clip is trimmed to the left piece by resolve_reshape.replace (carrying its look) and the right
  piece is placed beside it with the same look. Revert removes the right piece and gives the left one
  its old range back.
- `add_track` adds tracks at the end; `remove_track` removes the last track of a kind when it's empty.

What Resolve 21.1 does (checked live, PLAN.md "7b.0 probe"): SetSpeed({Percentage, RippleTimeline})
returns True and keeps clip ids; setting the old percentage restores the clip exactly. Placing a clip
over another is refused, so nothing here overwrites.
"""

from __future__ import annotations

import shutil
import tempfile
from typing import Any

from vibecut_agent.nle.resolve import (
    HostError,
    _linked,
    _number,
    _speed,
    _to_frame,
)
from vibecut_agent.nle.resolve import (
    frame_rate as _frame_rate,
)
from vibecut_agent.nle.resolve_edit import _alive, _chosen, _items, _seconds
from vibecut_agent.nle.resolve_reshape import (
    _apply,
    _clip_fps,
    _has_transition,
    _look,
    _position,
    replace,
    reshape_back,
)

MIN_SPEED, MAX_SPEED = 0.05, 20.0
MAX_NEW_TRACKS = 4


def _fades(item: Any) -> list[float]:
    try:
        fades = item.GetFades() or {}
    except AttributeError:
        return [0.0, 0.0]
    return [float(fades.get("FadeIn") or 0), float(fades.get("FadeOut") or 0)]


# ------------------------------------------------------------------------------- speed


# ------------------------------------------------------------------------------- splitting


def split_clips(host: Any, args: dict[str, Any]) -> dict[str, Any]:
    """{timeline, itemIds, time (seconds from the timeline's start)} -> each clip, with its linked
    picture or sound, cut in two at that time. The left piece replaces the clip; the right one is a
    new clip with the same look, linked to the right pieces of its own link group."""
    project, timeline = host._timeline(args)
    fps = _frame_rate(timeline)
    origin = int(timeline.GetStartFrame())
    time = _number(args.get("time"), "time")
    cut = origin + _to_frame(time, fps)
    found = _items(timeline)
    group: dict[str, tuple[str, int, Any]] = {}
    for item_id, kind, index, item in _chosen(found, args.get("itemIds")):
        if not int(item.GetStart()) < cut < int(item.GetEnd()):
            raise HostError(
                f"{item.GetName()!r} doesn't run across {_seconds(cut - origin, fps)} s, so there's nothing to split"
            )
        group[item_id] = (kind, index, item)
        for other in _linked(item):
            other_id = other.GetUniqueId()
            if other_id in found and int(other.GetStart()) < cut < int(other.GetEnd()):
                group.setdefault(other_id, found[other_id])
    plans, rights = [], []
    for item_id, (kind, index, item) in group.items():
        name = item.GetName()
        if item.GetLeftOffset() is None or item.GetMediaPoolItem() is None:
            raise HostError(f"{name!r} is a transition, generator or title; split it in Resolve")
        if _speed(item) != 1.0:
            raise HostError(
                f"{name!r} has a speed change, which Resolve won't let a split carry; use a draft"
            )
        clip_fps = _clip_fps(item)
        if clip_fps and abs(clip_fps - fps) > 0.01:
            raise HostError(f"{name!r} is {clip_fps:g} fps on a {fps:g} fps timeline; use a draft")
        if _has_transition(timeline, kind, index, item):
            raise HostError(
                f"{name!r} has a transition at an edge, which would be lost; remove it in Resolve first"
            )
        start, end = int(item.GetStart()), int(item.GetEnd())
        first = int(item.GetLeftOffset())
        plans.append({
            "id": item_id, "item": item, "kind": kind, "index": index, "toIndex": index, "start": start,
            "first": first, "last": first + cut - start, "oldFirst": first, "oldLast": first + end - start,
            "before": _position(item_id, kind, index, start, end, first, origin, fps), "fades": _fades(item), "name": name,
        })  # fmt: skip
        rights.append((first + cut - start, first + end - start, end))
    name = plans[0]["item"].GetName()
    markers = any((p["item"].GetMarkers() or {}) for p in plans)
    result = replace(project, timeline, plans)
    lefts = result["placed"]
    missed = list(result["missed"])
    media_pool = project.GetMediaPool()
    workdir = tempfile.mkdtemp(prefix="vibecut-split-")
    placed: list[Any] = []
    try:
        for n, (plan, left, (first, last, end)) in enumerate(zip(plans, lefts, rights, strict=True)):
            items = media_pool.AppendToTimeline([{
                "mediaPoolItem": plan["media"], "startFrame": first, "endFrame": last,
                "mediaType": 1 if plan["kind"] == "video" else 2, "trackIndex": plan["index"], "recordFrame": cut,
            }])  # fmt: skip
            right = (items or [None])[0]
            if not _alive(right):
                _undo_split(project, timeline, plans, lefts, placed, origin, fps)
                raise HostError(
                    f"Resolve didn't place the second half of {plan['name']!r}, so the split was undone"
                )
            placed.append(right)
            missed += _apply(
                right,
                plan["kind"],
                _look(left, plan["kind"], workdir, n),
                left if plan["kind"] == "video" else None,
            )
            fade_in, fade_out = plan["fades"]
            if (fade_in or fade_out) and not (
                left.SetFades({"FadeIn": fade_in, "FadeOut": 0.0})
                and right.SetFades({"FadeIn": 0.0, "FadeOut": fade_out})
            ):
                missed.append("fades")
    finally:
        shutil.rmtree(workdir, ignore_errors=True)
    for members in result["groups"]:
        if len(members) > 1:
            timeline.SetClipsLinked([placed[n] for n in members], True)
    items = []
    for plan, left, right in zip(plans, lefts, placed, strict=True):
        kind, index = plan["kind"], plan["index"]
        items.append({
            "before": plan["before"],
            "after": _position(left.GetUniqueId(), kind, index, plan["start"], cut, plan["first"], origin, fps),
            "right": _position(right.GetUniqueId(), kind, index, cut, int(right.GetEnd()), plan["first"] + cut - plan["start"], origin, fps),
            "fades": plan["fades"],
        })  # fmt: skip
    return {
        "changes": [
            {
                "kind": "split",
                "name": name,
                "cut": _seconds(cut - origin, fps),
                "items": items,
                "notCarried": sorted(set(missed)) + (["clip markers"] if markers else []),
            }
        ],
        "refused": [],
        "renamed": {i["before"]["id"]: i["after"]["id"] for i in items},
    }


def _undo_split(
    project: Any,
    timeline: Any,
    plans: list,
    lefts: list,
    placed: list,
    origin: int,
    fps: float,
) -> None:
    """Takes a half-made split back: the right pieces placed so far go, the left ones get their range back."""
    if placed:
        timeline.DeleteClips(placed, False)
    change = {
        "items": [
            {
                "before": p["before"],
                "after": _position(
                    left.GetUniqueId(),
                    p["kind"],
                    p["index"],
                    p["start"],
                    int(left.GetEnd()),
                    p["first"],
                    origin,
                    fps,
                ),
            }
            for p, left in zip(plans, lefts, strict=True)
        ]
    }
    reshape_back(project, timeline, change, origin, fps)


def revert_split(
    project: Any, timeline: Any, change: dict[str, Any], origin: int, fps: float
) -> tuple[str, dict[str, str]]:
    """Undoes a "split": "reverted" (with the new ids), "changed" or "taken"."""
    found = _items(timeline)
    rights = []
    for entry in change.get("items", []):
        right = entry["right"]
        if right["id"] not in found:
            return "changed", {}
        kind, index, item = found[right["id"]]
        if (
            [kind, index] != list(right["track"])
            or abs(_seconds(int(item.GetStart()) - origin, fps) - right["start"]) > 0.5 / fps
            or abs(_seconds(int(item.GetEnd()) - origin, fps) - right["end"]) > 0.5 / fps
            or item.GetLeftOffset() != right["sourceStartFrame"]
        ):
            return "changed", {}
        rights.append(item)
    if any(entry["after"]["id"] not in found for entry in change.get("items", [])):
        return "changed", {}
    if not timeline.DeleteClips(rights, False):
        return "changed", {}
    outcome, ids = reshape_back(project, timeline, change, origin, fps)
    if outcome != "reverted":
        return outcome, {}
    found = _items(timeline)
    for entry in change.get("items", []):
        new = found.get(ids.get(entry["after"]["id"], ""))
        fade_in, fade_out = entry.get("fades") or [0.0, 0.0]
        if new is not None and (fade_in or fade_out):
            new[2].SetFades({"FadeIn": fade_in, "FadeOut": fade_out})
    return "reverted", ids


# ------------------------------------------------------------------------------- tracks
