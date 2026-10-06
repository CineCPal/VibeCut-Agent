"""resolve_edit.py -- direct edits on the connected Resolve timeline (PLAN.md, "Connect page", phase 3).

Unlike a rebuild, these change the user's own timeline, so they're kept small and exact:
- `add_clips` puts Media Pool clips (or files, imported into the pool first) into free space on a
  track, picture and sound linked; it never overwrites.
- `delete_clips` lifts clips out, leaving a gap (with their linked picture or sound by default).
- `set_clips_enabled` switches clips on or off; `set_clip_levels` sets sound clips' level in dB.

Each returns every change with what it replaced, and `revert_timeline_changes` undoes them, newest
first, where the timeline still has what the change left. `backup_timeline` duplicates the timeline
first (the frontend calls it once per request), because a deleted clip put back from its source loses
its grade and effects; the backup keeps them.

What Resolve 21.1 does (checked live against a scratch project):
- `MediaPool.AppendToTimeline([{mediaPoolItem, startFrame, endFrame, mediaType, trackIndex,
  recordFrame}])` places a clip at an absolute record frame; it runs endFrame - startFrame frames.
  mediaType 1 is picture only, 2 sound only. Without mediaType a clip with sound goes on V1 and A1
  whatever trackIndex says, so picture and sound are placed separately and linked with
  `Timeline.SetClipsLinked`.
- It won't place a clip over another on the same track, and won't make a missing track: either way
  it returns an item whose GetName() is None, not an error. So free space is checked first, and
  `Timeline.AddTrack` makes the next track.
- `Timeline.DeleteClips([items], False)` removes just those items (not their linked ones). With
  ripple=True it removes the time range from every track, B-roll above included, which is what a
  draft's remove_time_ranges does; it isn't offered here.
- `TimelineItem.SetClipEnabled(bool)` works. `SetProperty("AudioVolume", -6.0)` sets the level in dB
  (a number; the text "-6" is refused).
- `Timeline.DeleteTrack(kind, index)` removes a track (used only on an empty one this module added).
- `Timeline.DuplicateTimeline(name)` copies the timeline and makes the copy the open one, so the
  previous one is opened again. Timeline item ids stay the same between reads.
"""

from __future__ import annotations

import os
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
from vibecut_agent.nle.resolve_support import _pool_by_path, _walk, ensure_in_pool, unique_name

MAX_ITEMS_PER_CALL = 200
MIN_DB, MAX_DB = -100.0, 30.0


# ------------------------------------------------------------------------------- finding things


def _items(timeline: Any) -> dict[str, tuple[str, int, Any]]:
    """Every clip on the timeline: id -> (track type, track index, item)."""
    found: dict[str, tuple[str, int, Any]] = {}
    for kind in ("video", "audio"):
        for index in range(1, int(timeline.GetTrackCount(kind) or 0) + 1):
            for item in timeline.GetItemListInTrack(kind, index) or []:
                found[item.GetUniqueId()] = (kind, index, item)
    return found


def _chosen(found: dict[str, tuple[str, int, Any]], ids: Any) -> list[tuple[str, str, int, Any]]:
    if not isinstance(ids, list) or not ids or not all(isinstance(i, str) and i for i in ids):
        raise HostError("itemIds must be a non-empty list of timeline clip ids")
    ids = list(dict.fromkeys(ids))
    if len(ids) > MAX_ITEMS_PER_CALL:
        raise HostError(f"At most {MAX_ITEMS_PER_CALL} clips at a time")
    out = []
    for item_id in ids:
        if item_id not in found:
            raise HostError(f"There is no clip {item_id!r} on the connected timeline any more")
        kind, index, item = found[item_id]
        out.append((item_id, kind, index, item))
    return out


def _alive(item: Any) -> bool:
    """AppendToTimeline returns an empty item (no name, no position) when it placed nothing."""
    return item is not None and item.GetName() is not None and item.GetStart() is not None


def _busy(timeline: Any, kind: str, index: int) -> list[tuple[int, int]]:
    return [(int(i.GetStart()), int(i.GetEnd())) for i in timeline.GetItemListInTrack(kind, index) or []]


def _free(spans: list[tuple[int, int]], start: int, end: int) -> bool:
    return all(end <= s or start >= e for s, e in spans)


def _volume(item: Any) -> float | None:
    value = (item.GetProperty() or {}).get("AudioVolume")
    return round(float(value), 2) if isinstance(value, (int, float)) else None


def _seconds(frames: int, fps: float) -> float:
    return round(frames / fps, 3)


# ------------------------------------------------------------------------------- the safety net


def backup_timeline(host: Any, args: dict[str, Any]) -> dict[str, Any]:
    """{timeline} -> duplicates it as "<name> (before VibeCut n)" and leaves the same timeline open
    as before."""
    project, timeline = host._timeline(args)
    taken = {t.GetName() for t in host._timelines(project) if t}
    base, n = timeline.GetName(), 1
    while f"{base} (before VibeCut {n})" in taken:
        n += 1
    name = unique_name(f"{base} (before VibeCut {n})", taken)
    current = project.GetCurrentTimeline()
    copy = timeline.DuplicateTimeline(name)
    if not copy:
        raise HostError("Resolve didn't duplicate the timeline, so no edit was made")
    # Duplicating opens the copy; the user stays where they were.
    if current:
        project.SetCurrentTimeline(current)
    return {"backup": copy.GetName()}


# ------------------------------------------------------------------------------- adding


def _source(media_pool: Any, by_id: dict[str, Any], spec: dict[str, Any], i: int) -> Any:
    clip_id, path = spec.get("clipId"), spec.get("path")
    if bool(clip_id) == bool(path):
        raise HostError(f"clips[{i}]: give clipId (a Media Pool clip) or path (a file), not both")
    if clip_id:
        if clip_id not in by_id:
            raise HostError(f"clips[{i}]: there is no Media Pool clip {clip_id!r} any more")
        return by_id[clip_id]
    if not isinstance(path, str) or not path.startswith("/"):
        raise HostError(f"clips[{i}]: path must be an absolute file path")
    if not os.path.isfile(path):
        raise HostError(f"clips[{i}]: there is no file {path}")
    return None  # imported once every clip has been checked


def _clip_fps(clip: Any, fallback: float) -> float:
    try:
        fps = float(str(clip.GetClipProperty("FPS")).split()[0])
    except (ValueError, IndexError):
        return fallback
    return fps if fps > 0 else fallback


def _clip_frames(clip: Any, fps: float) -> int | None:
    try:
        frames = int(str(clip.GetClipProperty("Frames") or ""))
    except ValueError:
        return None
    return frames if frames > 0 else None


def add_clips(host: Any, args: dict[str, Any]) -> dict[str, Any]:
    """{timeline, clips: [{clipId | path, sourceIn, sourceOut (seconds into the clip), at (seconds from
    the timeline's start), videoTrack, audioTrack (1-based; default the lowest free), picture, sound
    (default: what the clip has), volumeDb}]} -> places each in free space, picture and sound linked.
    Every clip is checked before any is placed."""
    project, timeline = host._timeline(args)
    specs = args.get("clips")
    if not isinstance(specs, list) or not specs or not all(isinstance(s, dict) for s in specs):
        raise HostError("clips must be a non-empty list")
    if len(specs) > 50:
        raise HostError("At most 50 clips at a time")
    media_pool = project.GetMediaPool()
    fps = _frame_rate(timeline)
    origin = int(timeline.GetStartFrame())
    by_id = {clip.GetUniqueId(): clip for _bin, clip in _walk(media_pool)}
    sources = [_source(media_pool, by_id, spec, i) for i, spec in enumerate(specs)]
    paths = [s["path"] for s, src in zip(specs, sources) if src is None]
    if paths:
        ensure_in_pool(media_pool, list(dict.fromkeys(paths)))
        pool = _pool_by_path(media_pool)
        sources = [src if src is not None else pool[spec["path"]] for spec, src in zip(specs, sources)]

    counts = {k: int(timeline.GetTrackCount(k) or 0) for k in ("video", "audio")}
    # Tracks as they'll be once this call's new ones are added: each new track may only be the next.
    planned_counts = dict(counts)
    planned: dict[tuple[str, int], list[tuple[int, int]]] = {}

    def spans(kind: str, index: int) -> list[tuple[int, int]]:
        key = (kind, index)
        if key not in planned:
            planned[key] = _busy(timeline, kind, index) if index <= counts[kind] else []
        return planned[key]

    def track(kind: str, wanted: Any, start: int, end: int, i: int) -> int:
        if wanted is not None:
            index = int(_number(wanted, f"clips[{i}].{kind}Track"))
            if index < 1 or index > planned_counts[kind] + 1:
                have = planned_counts[kind]
                raise HostError(
                    f"clips[{i}]: {kind} track {index} doesn't exist (there are {have}; {have + 1} would be added)"
                )
            if not _free(spans(kind, index), start, end):
                raise HostError(
                    f"clips[{i}]: {kind[0].upper()}{index} isn't free from {_seconds(start - origin, fps)} s to {_seconds(end - origin, fps)} s; nothing is overwritten. "
                    f"Leave {kind}Track out and VibeCut picks a free track (adding one if needed)"
                )
        else:
            index = 1
            while not _free(spans(kind, index), start, end):
                index += 1
        planned_counts[kind] = max(planned_counts[kind], index)
        return index

    plans = []
    for i, (spec, clip) in enumerate(zip(specs, sources)):
        kind_of = str(clip.GetClipProperty("Type") or "")
        if kind_of == "Timeline":
            raise HostError(f"clips[{i}]: {clip.GetName()!r} is a timeline, not a clip")
        has_picture, has_sound = (
            "Video" in kind_of or kind_of == "Still",
            "Audio" in kind_of,
        )
        picture = spec.get("picture", has_picture) is not False and has_picture
        sound = spec.get("sound", has_sound) is not False and has_sound
        if not picture and not sound:
            raise HostError(
                f"clips[{i}]: nothing to place ({clip.GetName()} has {kind_of or 'no picture or sound'})"
            )
        source_in = _number(spec.get("sourceIn", 0), f"clips[{i}].sourceIn")
        source_out = _number(spec.get("sourceOut"), f"clips[{i}].sourceOut")
        at = _number(spec.get("at"), f"clips[{i}].at")
        if source_in < 0 or source_out <= source_in or at < 0:
            raise HostError(f"clips[{i}]: needs 0 <= sourceIn < sourceOut and at >= 0")
        clip_fps = _clip_fps(clip, fps)
        first, last = _to_frame(source_in, clip_fps), _to_frame(source_out, clip_fps)
        frames = _clip_frames(clip, clip_fps)
        if frames is not None and last > frames:
            raise HostError(f"clips[{i}]: {clip.GetName()} is only {_seconds(frames, clip_fps)} s long")
        start = origin + _to_frame(at, fps)
        end = start + max(1, _to_frame(source_out - source_in, fps))
        volume = spec.get("volumeDb")
        if volume is not None:
            volume = min(MAX_DB, max(MIN_DB, _number(volume, f"clips[{i}].volumeDb")))
        video = track("video", spec.get("videoTrack"), start, end, i) if picture else None
        audio = track("audio", spec.get("audioTrack"), start, end, i) if sound else None
        for kind, index in (("video", video), ("audio", audio)):
            if index is not None:
                spans(kind, index).append((start, end))
        plans.append((clip, first, last, start, end, video, audio, volume))

    changes, refused, added_tracks = [], [], []
    for i, (clip, first, last, start, end, video, audio, volume) in enumerate(plans):
        placed, new_tracks = [], []
        for kind, index, media_type in (("video", video, 1), ("audio", audio, 2)):
            if index is None:
                continue
            while counts[kind] < index:
                if not timeline.AddTrack(kind):
                    break
                counts[kind] += 1
                added_tracks.append(f"{kind[0].upper()}{counts[kind]}")
                new_tracks.append([kind, counts[kind]])
            items = media_pool.AppendToTimeline([{
                "mediaPoolItem": clip, "startFrame": first, "endFrame": last,
                "mediaType": media_type, "trackIndex": index, "recordFrame": start,
            }])  # fmt: skip
            item = (items or [None])[0]
            if _alive(item):
                placed.append(item)
            else:
                refused.append(
                    {
                        "clip": i,
                        "reason": f"Resolve didn't place {clip.GetName()} on {kind[0].upper()}{index}",
                    }
                )
        if len(placed) == 2:
            timeline.SetClipsLinked(placed, True)
        if volume is not None:
            for item in placed:
                if item.GetTrackTypeAndIndex()[0] == "audio":
                    item.SetProperty("AudioVolume", volume)
        if placed:
            changes.append({
                "kind": "added",
                "itemIds": [item.GetUniqueId() for item in placed],
                "name": clip.GetName(),
                "at": _seconds(start - origin, fps),
                "end": _seconds(end - origin, fps),
                "tracks": [f"{t[0][0].upper()}{t[1]}" for t in (item.GetTrackTypeAndIndex() for item in placed)],
                # Tracks made for this clip; a revert removes them again while they're empty and last.
                "newTracks": new_tracks,
            })  # fmt: skip
    return {"changes": changes, "refused": refused, "addedTracks": added_tracks}


# ------------------------------------------------------------------------------- deleting


def _record(item_id: str, kind: str, index: int, item: Any, origin: int, fps: float) -> dict[str, Any]:
    """Everything needed to put a lifted clip back from its source."""
    media = item.GetMediaPoolItem()
    left = item.GetLeftOffset()
    speed = _speed(item)
    record = {
        "kind": "deleted",
        "itemId": item_id,
        "name": item.GetName(),
        "track": [kind, index],
        "start": _seconds(int(item.GetStart()) - origin, fps),
        "end": _seconds(int(item.GetEnd()) - origin, fps),
        "mediaId": media.GetUniqueId() if media else None,
        "sourceStartFrame": round(left * speed) if left is not None else None,
        "enabled": bool(item.GetClipEnabled()),
    }
    if kind == "audio":
        record["volumeDb"] = _volume(item)
    if speed != 1.0:
        record["speed"] = speed
    return record


def delete_clips(host: Any, args: dict[str, Any]) -> dict[str, Any]:
    """{timeline, itemIds, withLinked (default true: a picture's linked sound and the other way round)}
    -> lifts them out, leaving gaps. Transitions and generators can't be put back, so they're refused."""
    _project, timeline = host._timeline(args)
    found = _items(timeline)
    chosen = _chosen(found, args.get("itemIds"))
    if args.get("withLinked") is not False:
        extra: list[Any] = []
        for _item_id, _kind, _index, item in chosen:
            for other in _linked(item):
                other_id = other.GetUniqueId()
                if other_id in found and all(other_id != c[0] for c in chosen + extra):
                    extra.append((other_id, *found[other_id]))
        chosen += extra
    for item_id, _kind, _index, item in chosen:
        if item.GetLeftOffset() is None or item.GetMediaPoolItem() is None:
            raise HostError(
                f"{item.GetName()!r} ({item_id}) is a transition, generator or title; delete it in Resolve"
            )
    fps = _frame_rate(timeline)
    origin = int(timeline.GetStartFrame())
    records = [_record(item_id, kind, index, item, origin, fps) for item_id, kind, index, item in chosen]
    group = [r["itemId"] for r in records]
    for record in records:
        record["deletedWith"] = [g for g in group if g != record["itemId"]]
    if not timeline.DeleteClips([item for _i, _k, _x, item in chosen], False):
        return {
            "changes": [],
            "refused": [{"itemId": i, "reason": "Resolve didn't delete it"} for i in group],
        }
    return {"changes": records, "refused": []}


# ------------------------------------------------------------------------------- enabled and level


# ------------------------------------------------------------------------------- nesting (13f)

MAX_NAME = 120


def nest_clips(host: Any, args: dict[str, Any]) -> dict[str, Any]:
    """{timeline, start, end, name} -> every clip from start to end (seconds from the timeline's start),
    on every track, becomes one compound clip in their place. A clip across either edge is refused
    (split it first), and so are transitions, generators and titles inside. Recorded as the clips
    deleted and the compound added, so a revert takes the compound out and puts the clips back from
    their sources (grades and effects aren't restored; the compound stays in the Media Pool).

    Checked live (PLAN.md, "13f probe"): `Timeline.CreateCompoundClip(items, {"name"})` makes it on the
    picture and sound tracks of the items given, but returns None even when it worked, so the compound
    is found by reading the range back. There is no call to take a compound apart again."""
    _project, timeline = host._timeline(args)
    fps = _frame_rate(timeline)
    origin = int(timeline.GetStartFrame())
    start_s = _number(args.get("start"), "start")
    end_s = _number(args.get("end"), "end")
    if start_s < 0 or end_s - start_s < 1 / fps:
        raise HostError("start must be 0 or later and end after it")
    raw_name = args.get("name")
    name = raw_name if isinstance(raw_name, str) and raw_name.strip() else "Nested clips"
    name = name.strip()[:MAX_NAME]
    a, b = origin + _to_frame(start_s, fps), origin + _to_frame(end_s, fps)
    inside, across = [], []
    for item_id, (kind, index, item) in _items(timeline).items():
        s, e = int(item.GetStart()), int(item.GetEnd())
        if e <= a or s >= b:
            continue
        if s >= a and e <= b:
            inside.append((item_id, kind, index, item))
        else:
            across.append(item.GetName())
    if across:
        raise HostError(
            f"{', '.join(repr(n) for n in across[:3])} run across the edge of the range; split them at "
            f"{start_s:g} s and {end_s:g} s first (split_clip), or change the range"
        )
    if not inside:
        raise HostError(f"There's nothing between {start_s:g} s and {end_s:g} s")
    for item_id, _kind, _index, item in inside:
        if item.GetLeftOffset() is None or item.GetMediaPoolItem() is None:
            raise HostError(
                f"{item.GetName()!r} ({item_id}) is a transition, generator or title; nest it in Resolve"
            )
    records = [_record(item_id, kind, index, item, origin, fps) for item_id, kind, index, item in inside]
    group = [r["itemId"] for r in records]
    for record in records:
        record["deletedWith"] = [g for g in group if g != record["itemId"]]
    timeline.CreateCompoundClip([item for _i, _k, _x, item in inside], {"name": name})
    made = []
    for item_id, (kind, index, item) in _items(timeline).items():
        media = item.GetMediaPoolItem()
        if (
            int(item.GetStart()) >= a
            and int(item.GetEnd()) <= b
            and media is not None
            and media.GetClipProperty("Type") == "Compound"
            and item_id not in group
        ):
            made.append((item_id, kind, index))
    if not made:
        return {
            "changes": [],
            "refused": [{"itemId": i, "reason": "Resolve didn't make the compound clip"} for i in group],
        }
    added = {
        "kind": "added",
        "itemIds": [i for i, _k, _x in made],
        "name": name,
        "at": _seconds(a - origin, fps),
        "end": _seconds(b - origin, fps),
        "tracks": [f"{k[0].upper()}{x}" for _i, k, x in made],
        "newTracks": [],
        "nested": len(records),
    }
    return {"changes": [*records, added], "refused": []}


def set_clips_enabled(host: Any, args: dict[str, Any]) -> dict[str, Any]:
    """{timeline, itemIds, enabled} -> switches the clips on or off."""
    enabled = args.get("enabled")
    if not isinstance(enabled, bool):
        raise HostError("enabled must be true or false")
    _project, timeline = host._timeline(args)
    changes, refused = [], []
    for item_id, _kind, _index, item in _chosen(_items(timeline), args.get("itemIds")):
        before = bool(item.GetClipEnabled())
        if before == enabled:
            continue
        if item.SetClipEnabled(enabled):
            changes.append(
                {
                    "kind": "enabled",
                    "itemId": item_id,
                    "name": item.GetName(),
                    "before": before,
                    "after": enabled,
                }
            )
        else:
            refused.append({"itemId": item_id, "reason": "Resolve didn't switch it"})
    return {"changes": changes, "refused": refused}


def set_clip_levels(host: Any, args: dict[str, Any]) -> dict[str, Any]:
    """{timeline, levels: [{itemId, volumeDb}]} -> sets sound clips' level (-100 to +30 dB). A picture
    clip's id means its linked sound."""
    levels = args.get("levels")
    if not isinstance(levels, list) or not levels or not all(isinstance(lv, dict) for lv in levels):
        raise HostError("levels must be a non-empty list of {itemId, volumeDb}")
    _project, timeline = host._timeline(args)
    found = _items(timeline)
    wanted: dict[str, float] = {}
    for i, level in enumerate(levels):
        volume = min(MAX_DB, max(MIN_DB, _number(level.get("volumeDb"), f"levels[{i}].volumeDb")))
        ((item_id, kind, _index, item),) = _chosen(found, [level.get("itemId")])
        if kind == "video":
            sounds = [
                o.GetUniqueId()
                for o in _linked(item)
                if o.GetUniqueId() in found and found[o.GetUniqueId()][0] == "audio"
            ]
            if not sounds:
                raise HostError(f"{item.GetName()!r} ({item_id}) is picture with no linked sound")
            for sound in sounds:
                wanted[sound] = volume
        else:
            wanted[item_id] = volume
    changes, refused = [], []
    for item_id, volume in wanted.items():
        item = found[item_id][2]
        before = _volume(item)
        if before is not None and abs(before - volume) < 0.005:
            continue
        if item.SetProperty("AudioVolume", float(volume)):
            changes.append(
                {
                    "kind": "level",
                    "itemId": item_id,
                    "name": item.GetName(),
                    "before": before,
                    "after": round(volume, 2),
                }
            )
        else:
            refused.append({"itemId": item_id, "reason": "Resolve didn't set the level"})
    return {"changes": changes, "refused": refused}


# ------------------------------------------------------------------------------- captions (13h)

CAPTION_LANGUAGES = (
    "auto", "english", "spanish", "french", "german", "italian", "portuguese", "japanese", "korean",
    "chinese", "russian", "dutch", "danish", "swedish", "norwegian", "finnish", "polish", "turkish", "ukrainian",
)  # fmt: skip


# ------------------------------------------------------------------------------- reverting


def _put_back(
    timeline: Any,
    media_pool: Any,
    by_id: dict[str, Any],
    record: dict[str, Any],
    fps: float,
    origin: int,
) -> Any:
    kind, index = record["track"]
    clip = by_id.get(str(record.get("mediaId")))
    if clip is None or record.get("sourceStartFrame") is None:
        return None
    start = origin + _to_frame(record["start"], fps)
    end = origin + _to_frame(record["end"], fps)
    if index > int(timeline.GetTrackCount(kind) or 0) or not _free(_busy(timeline, kind, index), start, end):
        return False
    speed = record.get("speed", 1.0)
    first = int(record["sourceStartFrame"])
    last = first + round((end - start) * speed)
    items = media_pool.AppendToTimeline([{
        "mediaPoolItem": clip, "startFrame": first, "endFrame": last,
        "mediaType": 1 if kind == "video" else 2, "trackIndex": index, "recordFrame": start,
    }])  # fmt: skip
    item = (items or [None])[0]
    if not _alive(item):
        return None
    if not record.get("enabled", True):
        item.SetClipEnabled(False)
    if kind == "audio" and isinstance(record.get("volumeDb"), (int, float)):
        item.SetProperty("AudioVolume", float(record["volumeDb"]))
    return item


# The change kinds VibeCut Agent's edit commands make (VibeCut's captions, speed, track, grade, link and
# trackOptions edits aren't ported).
REVERTIBLE = ("added", "deleted", "enabled", "level", "reshaped", "fade", "transition", "split", "link")


def revert_timeline_changes(host: Any, args: dict[str, Any]) -> dict[str, Any]:
    """{timeline, changes (oldest first)} -> undoes them newest first where the timeline still has what
    each left: an added clip still where it was put is removed; a deleted clip goes back from its
    source where its place is still free (its grade and effects aren't restored, so `lost` says so);
    an enabled or level change goes back if nothing changed it since; a reshaped clip is reshaped back
    (resolve_reshape.py); a fade or transition goes back if the clip still has what it left
    (resolve_effects.py). With `backup` (the request's backup timeline), a deleted clip put back gets its
    grade from its copy there. What can't be undone is in `changedSince` or `failed`, and left as it is."""
    changes = args.get("changes")
    if not isinstance(changes, list) or not all(
        isinstance(c, dict) and c.get("kind") in REVERTIBLE for c in changes
    ):
        raise HostError("changes must be a list of the changes the edit commands returned")
    project, timeline = host._timeline(args)
    media_pool = project.GetMediaPool()
    fps = _frame_rate(timeline)
    origin = int(timeline.GetStartFrame())
    by_id = {clip.GetUniqueId(): clip for _bin, clip in _walk(media_pool)}
    reverted, changed_since, failed, lost, graded = [], [], [], [], []
    restored: dict[str, Any] = {}
    # Clips a reshape replaced, old id -> new id (strings, unlike `restored`).
    renamed: dict[str, str] = {}
    backup = _backup_items(host, project, args.get("backup"))

    # A reshape replaced its clips, so later changes name the new ids: older changes follow them there.
    for change in changes:
        if change["kind"] in ("reshaped", "split"):
            for entry in change.get("items", []):
                renamed[entry["before"]["id"]] = entry["after"]["id"]

    # A clip put back or reshaped has a new id; older changes to it follow it there.
    def current(item_id: Any) -> Any:
        for _hop in range(100):
            if item_id in restored:
                item_id = restored[item_id].GetUniqueId()
            elif item_id in renamed and renamed[item_id] != item_id:
                item_id = renamed[item_id]
            else:
                break
        return item_id

    for change in reversed(changes):
        kind = change["kind"]
        found = _items(timeline)
        label = change.get("name") or change.get("itemId") or ""
        if kind == "added":
            present = [found[current(i)][2] for i in change.get("itemIds", []) if current(i) in found]
            if len(present) != len(change.get("itemIds", [])):
                changed_since.append({"name": label, "reason": "it isn't on the timeline any more"})
            elif not present:
                continue
            elif (
                abs(_seconds(int(present[0].GetStart()) - origin, fps) - float(change.get("at", 0)))
                > 0.5 / fps
            ):
                changed_since.append({"name": label, "reason": "it was moved since"})
            elif timeline.DeleteClips(present, False):
                reverted.append({"kind": kind, "name": label})
                for track_kind, index in reversed(change.get("newTracks") or []):
                    count = int(timeline.GetTrackCount(track_kind) or 0)
                    if index == count and not timeline.GetItemListInTrack(track_kind, index):
                        timeline.DeleteTrack(track_kind, index)
            else:
                failed.append({"name": label, "reason": "Resolve didn't remove it"})
        elif kind == "reshaped":
            from vibecut_agent.nle import resolve_reshape

            followed = {
                **change,
                "items": [
                    {**i, "after": {**i["after"], "id": current(i["after"]["id"])}}
                    for i in change.get("items", [])
                ],
            }
            try:
                outcome, ids = resolve_reshape.reshape_back(project, timeline, followed, origin, fps)
            except HostError as error:
                failed.append({"name": label, "reason": str(error)})
                continue
            if outcome == "reverted":
                reverted.append({"kind": kind, "name": label})
                renamed.update(ids)
            else:
                reason = "it was changed since" if outcome == "changed" else "its old place is taken now"
                changed_since.append({"name": label, "reason": reason})
        elif kind == "link":
            # VibeCut's revert of a link change (Phase 6c: links.py), ids followed to the clips' current ones.
            from vibecut_agent.nle import links

            followed = {
                **change,
                "groupsBefore": [[current(i) for i in g] for g in change.get("groupsBefore") or []],
                "groupsAfter": [[current(i) for i in g] for g in change.get("groupsAfter") or []],
            }
            outcome = links.resolve_revert_links(timeline, followed)
            if outcome == "reverted":
                reverted.append({"kind": kind, "name": label})
            elif outcome == "changed":
                changed_since.append({"name": label, "reason": "it was changed since"})
            else:
                failed.append({"name": label, "reason": "Resolve didn't link them back as they were"})
        elif kind == "split":
            from vibecut_agent.nle import resolve_timing

            followed = {
                **change,
                "items": [
                    {**i, "after": {**i["after"], "id": current(i["after"]["id"])}}
                    for i in change.get("items", [])
                ],
            }
            outcome, ids = resolve_timing.revert_split(project, timeline, followed, origin, fps)
            if outcome == "reverted":
                reverted.append({"kind": kind, "name": label})
                renamed.update(ids)
            elif outcome == "failed":
                failed.append({"name": label, "reason": "Resolve didn't put it back"})
            else:
                reason = "its old place is taken now" if outcome == "taken" else "it was changed since"
                changed_since.append({"name": label, "reason": reason})
        elif kind in ("fade", "transition"):
            from vibecut_agent.nle import resolve_effects

            if current(change.get("itemId")) not in found:
                changed_since.append({"name": label, "reason": "it isn't on the timeline any more"})
                continue
            item = found[current(change["itemId"])][2]
            outcome = (
                resolve_effects.revert_fade(item, change, fps)
                if kind == "fade"
                else resolve_effects.revert_transition(timeline, item, change, origin, fps)
            )
            if outcome == "reverted":
                reverted.append({"kind": kind, "name": label})
            elif outcome == "changed":
                changed_since.append({"name": label, "reason": "it was changed since"})
            else:
                failed.append({"name": label, "reason": "Resolve didn't put it back"})
        elif kind == "deleted":
            item = _put_back(timeline, media_pool, by_id, change, fps, origin)
            if item is False:
                changed_since.append({"name": label, "reason": "its place is taken now"})
            elif item is None:
                failed.append({"name": label, "reason": "Resolve didn't put it back"})
            else:
                restored[change["itemId"]] = item
                reverted.append({"kind": kind, "name": label})
                lost.append(label)
                source = backup.get(
                    (
                        tuple(change["track"]),
                        _to_frame(change["start"], fps),
                        change.get("mediaId"),
                    )
                )
                if change["track"][0] == "video" and source is not None:
                    from vibecut_agent.nle.resolve_reshape import VIDEO_KEYS

                    # The backup's copy has the grade, transform and fades (not Fusion comps).
                    props = source.GetProperty() or {}
                    item.SetProperties({k: props[k] for k in VIDEO_KEYS if k in props})
                    item.SetFades(source.GetFades())
                    if source.CopyGrades([item]):
                        graded.append(label)
        else:
            if current(change.get("itemId")) not in found:
                changed_since.append({"name": label, "reason": "it isn't on the timeline any more"})
                continue
            item = found[current(change["itemId"])][2]
            now = bool(item.GetClipEnabled()) if kind == "enabled" else _volume(item)
            after, before = change.get("after"), change.get("before")
            same = (
                now == after
                if kind == "enabled"
                else now is not None and isinstance(after, (int, float)) and abs(now - after) < 0.005
            )
            if not same:
                changed_since.append({"name": label, "reason": "it was changed since"})
                continue
            ok = (
                item.SetClipEnabled(bool(before))
                if kind == "enabled"
                else item.SetProperty(
                    "AudioVolume",
                    float(before if isinstance(before, (int, float)) else 0.0),
                )
            )
            (reverted if ok else failed).append(
                {"kind": kind, "name": label}
                if ok
                else {"name": label, "reason": "Resolve didn't put it back"}
            )
    # Picture and sound deleted together go back linked.
    for change in changes:
        if change["kind"] == "deleted" and change["itemId"] in restored:
            partners = [restored[o] for o in change.get("deletedWith", []) if o in restored]
            if partners:
                timeline.SetClipsLinked([restored[change["itemId"]], *partners], True)
    return {
        "reverted": reverted,
        "changedSince": changed_since,
        "failed": failed,
        "lost": sorted(set(lost)),
        "gradedFromBackup": sorted(set(graded)),
        "restoredIds": {
            **{old: item.GetUniqueId() for old, item in restored.items()},
            **renamed,
        },
    }


def _backup_items(host: Any, project: Any, name: Any) -> dict[tuple, Any]:
    """The backup timeline's clips by (track, frame from its start, media id), to copy a put-back clip's
    grade from. Empty when there's no backup or it's gone."""
    if not isinstance(name, str) or not name:
        return {}
    timeline = next((t for t in host._timelines(project) if t and t.GetName() == name), None)
    if timeline is None:
        return {}
    origin = int(timeline.GetStartFrame())
    out = {}
    for kind, index, item in _items(timeline).values():
        media = item.GetMediaPoolItem()
        if media is not None and item.GetStart() is not None:
            out[((kind, index), int(item.GetStart()) - origin, media.GetUniqueId())] = item
    return out
