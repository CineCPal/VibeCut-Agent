"""resolve_reshape.py -- trimming, slipping and moving a clip already on the connected Resolve timeline
(PLAN.md, "Connect page", phase 3c).

Resolve's scripting API can't change a timeline clip's position or source range: TimelineItem has no
SetStart, SetEnd or SetLeftOffset (checked by listing every method in 21.1). So `reshape_clip`
replaces the clip, with its linked picture or sound, by the same media at the new range or place, and
carries its look across:
- the grade: before the clip is lifted it's copied onto a one-frame holder on a temporary track
  (`TimelineItem.CopyGrades`), and from there onto the new clip; the holder and track are removed.
  A clip on one of VibeCut's grade versions (phase 7d) has every version carried by name
  (resolve_color.carry_grades);
- transform, crop, opacity and composite (`GetProperty`/`SetProperties`), fades (`GetFades`/`SetFades`),
  clip colour, the enabled switch and the level;
- Fusion compositions, exported to a temporary file and imported again (`ExportFusionComp`/
  `ImportFusionComp`); a duplicated timeline doesn't keep them, so the backup can't be the source.

Not carried, and so refused or reported: speed changes (`SetSpeed` returns False in 21.1), keyframes
(not exposed), transitions touching the clip (refused), clip markers (reported).

Checked live in 21.1: a clip with a zoom, pan, opacity, fades, a CDL grade and a Fusion comp was
trimmed this way, and its grade exported as a LUT was byte-identical to the original's.
"""

from __future__ import annotations

import os
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
from vibecut_agent.nle.resolve_edit import _alive, _free, _items, _seconds, _volume

# Video properties that SetProperties takes back; the rest of GetProperty() is read-only or audio.
VIDEO_KEYS = (
    "Pan", "Tilt", "ZoomX", "ZoomY", "ZoomGang", "RotationAngle", "AnchorPointX", "AnchorPointY",
    "Pitch", "Yaw", "FlipX", "FlipY", "CropLeft", "CropRight", "CropTop", "CropBottom", "CropSoftness",
    "CropRetain", "CroppingEnabled", "DynamicZoomEase", "DynamicZoomEnabled", "CompositeMode",
    "CompositeEnabled", "Opacity", "Distortion", "RetimeProcess", "MotionEstimation", "Scaling",
    "ResizeFilter", "TransformEnabled", "LensCorrectionEnabled",
)  # fmt: skip


def _label(kind: str, index: int) -> str:
    return f"{kind[0].upper()}{index}"


def _source_frames(item: Any, fps: float) -> int | None:
    media = item.GetMediaPoolItem()
    if media is None:
        return None
    try:
        frames = int(str(media.GetClipProperty("Frames") or ""))
    except ValueError:
        frames = 0
    if frames:
        return frames
    try:
        clip_fps = float(str(media.GetClipProperty("FPS")).split()[0])
        duration = str(media.GetClipProperty("Duration") or "")
        if duration:
            from vibecut_agent.nle.resolve import timecode_to_frames

            return timecode_to_frames(duration, clip_fps)
    except (ValueError, IndexError, HostError):
        pass
    return None


def _clip_fps(item: Any) -> float | None:
    media = item.GetMediaPoolItem()
    try:
        return float(str(media.GetClipProperty("FPS")).split()[0]) if media else None
    except (ValueError, IndexError):
        return None


def _has_transition(timeline: Any, kind: str, index: int, item: Any) -> bool:
    start, end = int(item.GetStart()), int(item.GetEnd())
    for other in timeline.GetItemListInTrack(kind, index) or []:
        if other.GetLeftOffset() is None and int(other.GetStart()) <= end and int(other.GetEnd()) >= start:
            return True
    return False


# ------------------------------------------------------------------------------- carrying the look


def _look(item: Any, kind: str, workdir: str, n: int) -> dict[str, Any]:
    look: dict[str, Any] = {
        "enabled": bool(item.GetClipEnabled()),
        "color": item.GetClipColor() or "",
    }
    try:
        look["fades"] = item.GetFades()
    except AttributeError:
        pass
    if kind == "audio":
        look["volume"] = _volume(item)
        return look
    props = item.GetProperty() or {}
    look["props"] = {k: props[k] for k in VIDEO_KEYS if k in props}
    comps = []
    for i, _name in enumerate(item.GetFusionCompNameList() or [], 1):
        path = os.path.join(workdir, f"{n}-{i}.comp")
        if item.ExportFusionComp(path, i):
            comps.append(path)
    look["comps"] = comps
    return look


def _apply(item: Any, kind: str, look: dict[str, Any], holder: Any) -> list[str]:
    """Puts the look back on a new clip; returns what didn't take."""
    missed = []
    if not look.get("enabled", True):
        item.SetClipEnabled(False)
    if look.get("color"):
        item.SetClipColor(look["color"])
    if look.get("fades") and not item.SetFades(look["fades"]):
        missed.append("fades")
    if kind == "audio":
        if isinstance(look.get("volume"), (int, float)) and not item.SetProperty(
            "AudioVolume", float(look["volume"])
        ):
            missed.append("level")
        return missed
    if holder is not None:
        from vibecut_agent.nle.resolve_support import carry_grades

        if not carry_grades(holder, item):
            missed.append("grade")
    if look.get("props") and not item.SetProperties(look["props"]):
        missed.append("transform")
    for path in look.get("comps", []):
        if not item.ImportFusionComp(path):
            missed.append("Fusion composition")
    return missed


# ------------------------------------------------------------------------------- the replace


def link_groups(plans: list[dict[str, Any]]) -> list[tuple[list[int], list[Any]]]:
    """The plans' clips grouped by how they're linked now: each group is (plan indexes, linked clips
    that aren't in any plan). A clip linked to nothing is a group of its own."""
    at = {p["item"].GetUniqueId(): n for n, p in enumerate(plans)}
    parent = list(range(len(plans)))

    def root(n: int) -> int:
        while parent[n] != n:
            parent[n] = parent[parent[n]]
            n = parent[n]
        return n

    outside: dict[str, tuple[int, Any]] = {}
    for n, plan in enumerate(plans):
        for other in _linked(plan["item"]):
            other_id = other.GetUniqueId()
            if other_id in at:
                parent[root(at[other_id])] = root(n)
            elif other_id in outside:
                parent[root(outside[other_id][0])] = root(n)
            else:
                outside[other_id] = (n, other)
    groups: dict[int, tuple[list[int], list[Any]]] = {}
    for n in range(len(plans)):
        groups.setdefault(root(n), ([], []))[0].append(n)
    for n, other in outside.values():
        groups[root(n)][1].append(other)
    return list(groups.values())


def replace(project: Any, timeline: Any, plans: list[dict[str, Any]]) -> dict[str, Any]:
    """Each plan: {item, kind, index (track now), toIndex, start, first, last} in absolute record frames
    and source frames. Lifts every item and places it again as planned, carrying its look, and links
    the new clips as the old ones were, including to linked clips left in place (a sound slipped
    without its picture). Each link group is kept apart: unrelated clips replaced together aren't
    linked to each other. If Resolve refuses a placement, everything goes back where it was.
    Returns {placed: [new items in plan order], missed: [what didn't carry], groups: [[plan indexes]
    of each link group]}."""
    media_pool = project.GetMediaPool()
    workdir = tempfile.mkdtemp(prefix="vibecut-reshape-")
    # Every holder placed (all are removed afterwards), and those that took the clip's grade: an
    # ungraded clip's CopyGrades returns False, and there's nothing to carry.
    holders: list[Any] = []
    graded: dict[int, Any] = {}
    temp_tracks = 0
    try:
        for n, plan in enumerate(plans):
            plan["look"] = _look(plan["item"], plan["kind"], workdir, n)
            plan["media"] = plan["item"].GetMediaPoolItem()
            plan["old"] = (
                plan["index"],
                int(plan["item"].GetStart()),
                plan["oldFirst"],
                plan["oldLast"],
            )
        # The grade can only be copied between clips that exist, so it waits on a holder.
        videos = [n for n, p in enumerate(plans) if p["kind"] == "video"]
        if videos:
            if not timeline.AddTrack("video"):
                raise HostError("Resolve didn't add the temporary track needed to carry the grade")
            temp_tracks = 1
            top = int(timeline.GetTrackCount("video"))
            for n in videos:
                plan = plans[n]
                placed = media_pool.AppendToTimeline([{
                    "mediaPoolItem": plan["media"], "startFrame": plan["oldFirst"], "endFrame": plan["oldFirst"] + 1,
                    "mediaType": 1, "trackIndex": top, "recordFrame": int(plan["item"].GetStart()),
                }])  # fmt: skip
                holder = (placed or [None])[0]
                if _alive(holder):
                    holders.append(holder)
                    from vibecut_agent.nle.resolve_support import carry_grades

                    if carry_grades(plan["item"], holder):
                        graded[n] = holder
        # Each link group as it is now, with the linked clips that stay where they are: the new
        # clips are linked to them again.
        groups = link_groups(plans)
        if not timeline.DeleteClips([p["item"] for p in plans], False):
            raise HostError("Resolve didn't lift the clip, so nothing changed")

        def place(plan: dict[str, Any], index: int, start: int, first: int, last: int) -> Any:
            items = media_pool.AppendToTimeline([{
                "mediaPoolItem": plan["media"], "startFrame": first, "endFrame": last,
                "mediaType": 1 if plan["kind"] == "video" else 2, "trackIndex": index, "recordFrame": start,
            }])  # fmt: skip
            item = (items or [None])[0]
            return item if _alive(item) else None

        new = [place(p, p["toIndex"], p["start"], p["first"], p["last"]) for p in plans]
        failed = any(item is None for item in new)
        if failed:
            # Put everything back as it was.
            timeline.DeleteClips([item for item in new if item is not None], False)
            new = [place(p, *p["old"]) for p in plans]
        missed: list[str] = []
        for n, (plan, item) in enumerate(zip(plans, new)):
            if item is not None:
                missed += _apply(item, plan["kind"], plan["look"], graded.get(n))
        for members, kept in groups:
            alive = [new[n] for n in members if new[n] is not None] + kept
            if len(alive) > 1:
                timeline.SetClipsLinked(alive, True)
        if failed:
            raise HostError(
                "Resolve didn't place the clip at its new range, so it was put back where it was"
                + ("" if all(new) else " (but not all of it: check the timeline)")
            )
        return {
            "placed": new,
            "missed": sorted(set(missed)),
            "groups": [members for members, _kept in groups],
        }
    finally:
        if holders:
            timeline.DeleteClips(holders, False)
        if temp_tracks:
            top = int(timeline.GetTrackCount("video"))
            if not timeline.GetItemListInTrack("video", top):
                timeline.DeleteTrack("video", top)
        shutil.rmtree(workdir, ignore_errors=True)


def _position(
    item_id: str,
    kind: str,
    index: int,
    start: int,
    end: int,
    first: int,
    origin: int,
    fps: float,
) -> dict[str, Any]:
    return {
        "id": item_id,
        "track": [kind, index],
        "start": _seconds(start - origin, fps),
        "end": _seconds(end - origin, fps),
        "sourceStartFrame": first,
    }


def reshape_clip(host: Any, args: dict[str, Any]) -> dict[str, Any]:
    """{timeline, itemId, and one of: sourceIn (seconds into the source: trims the start), sourceOut
    (trims the end), slip (seconds: moves the source range, the clip stays), start (seconds from the
    timeline's start: moves the clip) with videoTrack/audioTrack (1-based, optional), withLinked
    (default true; false only with slip: the sound slips into sync and its picture stays)} -> the clip
    and its linked picture or sound, replaced at the new range or place with their look carried
    across. Nothing is overwritten: the new place must be free."""
    project, timeline = host._timeline(args)
    found = _items(timeline)
    item_id = args.get("itemId")
    if not isinstance(item_id, str) or item_id not in found:
        raise HostError(f"There is no clip {item_id!r} on the connected timeline any more")
    modes = [k for k in ("sourceIn", "sourceOut", "slip", "start") if args.get(k) is not None]
    if not modes or (len(modes) > 1 and set(modes) != {"sourceIn", "sourceOut"}):
        raise HostError(
            "Give sourceIn and/or sourceOut (trim), slip, or start (move): one kind of change at a time"
        )
    if args.get("withLinked") is False and modes != ["slip"]:
        raise HostError("withLinked false goes with slip only; a trim or move keeps linked clips together")
    fps = _frame_rate(timeline)
    origin = int(timeline.GetStartFrame())
    _main_kind, _main_index, main = found[item_id]
    group = [(item_id, *found[item_id])]
    if args.get("withLinked") is not False:
        for other in _linked(main):
            other_id = other.GetUniqueId()
            if other_id in found and other_id != item_id:
                group.append((other_id, *found[other_id]))

    main_first = main.GetLeftOffset()
    if main_first is None or main.GetMediaPoolItem() is None:
        raise HostError(f"{main.GetName()!r} is a transition, generator or title; it can't be reshaped")
    d_in = d_out = shift = 0
    if "sourceIn" in modes:
        d_in = _to_frame(_number(args["sourceIn"], "sourceIn"), fps) - int(main_first)
    if "sourceOut" in modes:
        main_last = int(main_first) + int(main.GetEnd()) - int(main.GetStart())
        d_out = _to_frame(_number(args["sourceOut"], "sourceOut"), fps) - main_last
    slip = _to_frame(_number(args["slip"], "slip"), fps) if "slip" in modes else 0
    if "start" in modes:
        shift = origin + _to_frame(_number(args["start"], "start"), fps) - int(main.GetStart())
    targets = {}
    for kind, key in (("video", "videoTrack"), ("audio", "audioTrack")):
        if args.get(key) is not None:
            if "start" not in modes:
                raise HostError(f"{key} goes with start (a move)")
            index = int(_number(args[key], key))
            if index < 1 or index > int(timeline.GetTrackCount(kind) or 0):
                raise HostError(f"There is no {_label(kind, index)}; add_clips can add a track")
            targets[kind] = index

    plans, lifted = [], {g[0] for g in group}
    for gid, kind, index, item in group:
        name = item.GetName()
        if _speed(item) != 1.0:
            raise HostError(
                f"{name!r} has a speed change, which Resolve won't let a script set again; use a draft"
            )
        clip_fps = _clip_fps(item)
        if clip_fps and abs(clip_fps - fps) > 0.01:
            raise HostError(f"{name!r} is {clip_fps:g} fps on a {fps:g} fps timeline; use a draft")
        if _has_transition(timeline, kind, index, item):
            raise HostError(
                f"{name!r} has a transition at an edge, which would be lost; remove it in Resolve or use a draft"
            )
        first = int(item.GetLeftOffset())
        start, end = int(item.GetStart()), int(item.GetEnd())
        last = first + end - start
        new_first, new_last = first + d_in + slip, last + d_out + slip
        new_start, new_end = start + d_in + shift, end + d_out + shift
        if new_last - new_first < 1 or new_end - new_start < 1:
            raise HostError("That would leave nothing of the clip")
        if new_first < 0:
            raise HostError(
                f"{name!r} has only {_seconds(first, fps)} s of source before its start to reach back into"
            )
        frames = _source_frames(item, fps)
        if frames is not None and new_last > frames:
            raise HostError(f"{name!r}'s source is only {_seconds(frames, fps)} s long")
        if new_start < origin:
            raise HostError("That would start before the timeline does")
        to_index = targets.get(kind, index)
        others = [
            (int(o.GetStart()), int(o.GetEnd()))
            for o in timeline.GetItemListInTrack(kind, to_index) or []
            if o.GetUniqueId() not in lifted
        ]
        if not _free(others, new_start, new_end):
            raise HostError(
                f"{_label(kind, to_index)} isn't free from {_seconds(new_start - origin, fps)} s to {_seconds(new_end - origin, fps)} s; nothing is overwritten"
            )
        plans.append({
            "id": gid, "item": item, "kind": kind, "index": index, "toIndex": to_index,
            "start": new_start, "first": new_first, "last": new_last, "oldFirst": first, "oldLast": last,
            "before": _position(gid, kind, index, start, end, first, origin, fps),
        })  # fmt: skip
    markers = any((p["item"].GetMarkers() or {}) for p in plans)
    name = main.GetName()  # the item is gone once replaced
    result = replace(project, timeline, plans)
    items = []
    for plan, new in zip(plans, result["placed"]):
        after = _position(
            new.GetUniqueId(),
            plan["kind"],
            plan["toIndex"],
            plan["start"],
            int(new.GetEnd()),
            plan["first"],
            origin,
            fps,
        )
        items.append({"before": plan["before"], "after": after})
    what = {
        "sourceIn": "trimmed",
        "sourceOut": "trimmed",
        "slip": "slipped",
        "start": "moved",
    }[modes[0]]
    not_carried = result["missed"] + (["clip markers"] if markers else [])
    return {
        "changes": [
            {
                "kind": "reshaped",
                "how": what,
                "name": name,
                "items": items,
                "notCarried": not_carried,
            }
        ],
        "refused": [],
        "renamed": {i["before"]["id"]: i["after"]["id"] for i in items},
    }


def reshape_back(
    project: Any, timeline: Any, change: dict[str, Any], origin: int, fps: float
) -> tuple[str, dict[str, str]]:
    """Undoes a "reshaped" change: "reverted", "changed" (a clip isn't where the change left it) or
    "taken" (its old place isn't free), and the new ids."""
    found = _items(timeline)
    plans = []
    lifted = {i["after"]["id"] for i in change.get("items", [])}
    for entry in change.get("items", []):
        after, before = entry["after"], entry["before"]
        if after["id"] not in found:
            return "changed", {}
        kind, index, item = found[after["id"]]
        if (
            [kind, index] != list(after["track"])
            or abs(_seconds(int(item.GetStart()) - origin, fps) - after["start"]) > 0.5 / fps
            or item.GetLeftOffset() != after["sourceStartFrame"]
        ):
            return "changed", {}
        start = origin + _to_frame(before["start"], fps)
        end = origin + _to_frame(before["end"], fps)
        to_index = int(before["track"][1])
        if to_index > int(timeline.GetTrackCount(kind) or 0):
            return "taken", {}
        others = [
            (int(o.GetStart()), int(o.GetEnd()))
            for o in timeline.GetItemListInTrack(kind, to_index) or []
            if o.GetUniqueId() not in lifted
        ]
        if not _free(others, start, end):
            return "taken", {}
        first = int(before["sourceStartFrame"])
        plans.append({
            "id": after["id"], "item": item, "kind": kind, "index": index, "toIndex": to_index, "start": start,
            "first": first, "last": first + end - start, "oldFirst": int(item.GetLeftOffset()),
            "oldLast": int(item.GetLeftOffset()) + int(item.GetEnd()) - int(item.GetStart()),
        })  # fmt: skip
    if not plans:
        return "changed", {}
    result = replace(project, timeline, plans)
    return "reverted", {p["id"]: new.GetUniqueId() for p, new in zip(plans, result["placed"])}
