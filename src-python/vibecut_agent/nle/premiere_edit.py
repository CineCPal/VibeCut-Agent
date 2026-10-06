"""premiere_edit.py -- direct edits on the connected Premiere sequence (PLAN.md, "Connect page, phase 4c").

The same commands and change records as host-resolve's resolve_edit.py, so the Connect page's edit
log, Revert and the agent's tools (src/lib/connect/timelineEdits.ts) work unchanged:
- `backup_timeline` clones the sequence as "<name> (before VibeCut n)" (once per request).
- `add_clips` puts part of a media file into free space, picture and sound linked; never overwrites.
- `delete_clips` lifts clips out, leaving a gap (with their linked picture or sound by default).
- `set_clips_enabled`, `set_clip_levels` (dB).
- `reshape_clip` trims, slips or moves a clip and its linked partners in place. Unlike Resolve,
  Premiere can change a clip's points, so its effects stay on it and its id doesn't change. A picture
  clip moved to another track (phase 4f) is re-placed there from its project item instead, so it's
  refused when it has effects or keyframes that would be lost.
- `revert_timeline_changes` undoes them, newest first, where the sequence still has what each left.
- Fades and transitions are premiere_effects.py's, with the same change log and Revert.

Every decision is made here, on a read of the sequence, before the panel's small steps run
(src-premiere-panel/host.jsx). What Premiere 26.5.2 does (checked live on a scratch sequence):
- `Sequence.overwriteClip(item, time, videoTrack, audioTrack)` places the project item's In/Out range
  with its sound on that audio track and one more track per further channel (a stereo file fills A1
  and A2), all linked. It overwrites whatever is there, so free space on every one of those tracks is
  checked first. It can't add tracks; Premiere's unsupported QE layer can (phase 4f: `add_tracks` and
  `remove_tracks` in the panel), so a clip with no free track gets new ones at the end, removed again
  by Revert while they're the last and empty. Without QE, the old refusal stands.
- A clip's `start`, `end`, `inPoint` and `outPoint` are set independently: setting `start` alone
  doesn't move the source in. So a trim or slip sets all four, on the clip and each linked partner.
- `TrackItem.move(offset)` moves only that clip, so a move moves each partner too.
- `remove(false, false)` lifts only that clip; its partners stay, still linked to each other.
- `disabled` can be set. Level animation is on for every sound clip by default, so a level is set
  with `setValue` unless the clip has real keyframes.
- Premiere's own Undo isn't a dependable way back: a scripted placement is an undo step, but a
  scripted level change or move isn't. Revert and the backup are.
"""

from __future__ import annotations

import math
import os
from typing import Any

from vibecut_agent.nle.premiere import (
    ID_PATTERN,
    TICKS_PER_SECOND,
    HostError,
    frame_rate,
    level_db,
    seconds,
)
from vibecut_agent.nle.premiere_support import BIN_NAME, Probe, unique_name

MAX_ITEMS_PER_CALL = 200
MIN_DB, MAX_DB = -100.0, 30.0


def _number(value: Any, field: str, minimum: float | None = None) -> float:
    if not isinstance(value, (int, float)) or isinstance(value, bool) or not math.isfinite(value):
        raise HostError(f"{field} must be a number")
    if minimum is not None and value < minimum:
        raise HostError(f"{field} must be at least {minimum}")
    return float(value)


def gain(db: float) -> float:
    """Premiere's Level for a dB value: 0 dB is 10^(-15/20)."""
    return 10 ** ((db - 15) / 20)


class Sequence:
    """One read of the sequence in Premiere's own units: clips by id with their track and ticks."""

    def __init__(self, raw: dict[str, Any]) -> None:
        self.raw = raw
        # Tracks a plan will add at the end of each kind, before anything is placed.
        self.new: dict[str, int] = {"video": 0, "audio": 0}
        self.timebase = int(raw["timebase"])
        self.fps = frame_rate(self.timebase)
        self.clips: dict[str, dict[str, Any]] = {}
        self.tracks: dict[str, list[dict[str, Any]]] = {
            "video": raw.get("video", []),
            "audio": raw.get("audio", []),
        }
        for kind, tracks in self.tracks.items():
            for index, track in enumerate(tracks, start=1):
                for clip in track.get("clips", []):
                    self.clips[clip["id"]] = {**clip, "kind": kind, "index": index}

    def ticks(self, time: float) -> int:
        """The nearest frame's ticks."""
        return math.floor(time * TICKS_PER_SECOND / self.timebase + 0.5) * self.timebase

    def clip(self, item_id: Any) -> dict[str, Any]:
        if not isinstance(item_id, str) or item_id not in self.clips:
            raise HostError(f"There is no clip {item_id!r} on the connected sequence any more")
        return self.clips[item_id]

    def busy(
        self, kind: str, index: int, ignore: set[str] | frozenset[str] = frozenset()
    ) -> list[tuple[int, int]]:
        """Occupied spans (ticks) on a track: clips and transitions. A track still to be added has none."""
        if index > len(self.tracks[kind]):
            return []
        track = self.tracks[kind][index - 1]
        spans = [
            (int(c["startTicks"]), int(c["endTicks"]))
            for c in track.get("clips", [])
            if c["id"] not in ignore
        ]
        spans += [(int(t["startTicks"]), int(t["endTicks"])) for t in track.get("transitions", [])]
        return spans

    def locked(self, kind: str, index: int) -> bool:
        """Premiere's scripting edits a locked track anyway (8a.0 probe), so VibeCut keeps off it."""
        return 1 <= index <= len(self.tracks[kind]) and bool(self.tracks[kind][index - 1].get("locked"))

    def free(
        self,
        kind: str,
        index: int,
        start: int,
        end: int,
        ignore: set[str] | frozenset[str] = frozenset(),
        extra: list | None = None,
    ) -> bool:
        if index < 1 or index > len(self.tracks[kind]) + self.new[kind]:
            return False
        if self.locked(kind, index):
            return False
        spans = self.busy(kind, index, ignore) + [
            (s, e) for k, i, s, e in (extra or []) if (k, i) == (kind, index)
        ]
        return all(e <= start or s >= end for s, e in spans)

    def partners(self, item_id: str) -> list[str]:
        """The clip and every clip linked to it that's still on the sequence."""
        group = [item_id]
        for other in self.clips[item_id].get("linkedIds", []):
            if other in self.clips and other not in group:
                group.append(other)
        return group

    def channel(self, clip: dict[str, Any]) -> int:
        """Which channel of its file a sound clip plays: clips of one file at the same place and source
        point on several audio tracks are its channels, in track order (as premiere_host.number_channels)."""
        same = sorted(
            (c for c in self.clips.values() if c["kind"] == "audio" and c.get("mediaPath") == clip.get("mediaPath")
             and (c["startTicks"], c["endTicks"], c["inTicks"]) == (clip["startTicks"], clip["endTicks"], clip["inTicks"])),
            key=lambda c: c["index"],
        )  # fmt: skip
        return next((n for n, c in enumerate(same, start=1) if c["id"] == clip["id"]), 1)

    def touches_transition(self, clip: dict[str, Any]) -> bool:
        track = self.tracks[clip["kind"]][clip["index"] - 1]
        start, end = int(clip["startTicks"]), int(clip["endTicks"])
        return any(
            int(t["startTicks"]) <= start < int(t["endTicks"])
            or int(t["startTicks"]) < end <= int(t["endTicks"])
            for t in track.get("transitions", [])
        )


def _label(kind: str, index: int) -> str:
    return f"{kind[0].upper()}{index}"


def _read(host: Any, timeline: str, effects: bool = False) -> Sequence:
    """effects: also learn whether each picture clip has effects (`custom`), which reads slower."""
    request: dict[str, Any] = {"timeline": timeline}
    if effects:
        request["effects"] = True
    return Sequence(host._send("read_sequence", request))


def _new_track(seq: Sequence, kind: str, count: int = 1) -> int:
    """Plans `count` tracks of a kind at the end; returns the first one's 1-based index."""
    first = len(seq.tracks[kind]) + seq.new[kind] + 1
    seq.new[kind] += count
    return first


def _add_tracks(host: Any, timeline: str, video: int, audio: int) -> None:
    """Adds tracks at the end through Premiere's QE layer, or refuses with why."""
    if not video and not audio:
        return
    before = _read(host, timeline)
    try:
        answer = host._send("add_tracks", {"timeline": timeline, "video": video, "audio": audio})
    except Exception as exc:  # the panel's refusal, or no QE
        raise HostError(
            f"There's no free track, and Premiere couldn't add one ({exc}). VibeCut won't overwrite: "
            "add a track in Premiere, or use a draft (place_broll)"
        ) from exc
    wanted = (len(before.tracks["video"]) + video, len(before.tracks["audio"]) + audio)
    if (answer.get("video"), answer.get("audio")) != wanted:
        added = {
            "video": list(range(len(before.tracks["video"]), int(answer.get("video") or 0))),
            "audio": list(range(len(before.tracks["audio"]), int(answer.get("audio") or 0))),
        }
        host._send("remove_tracks", {"timeline": timeline, **added})
        raise HostError("Premiere didn't add the tracks asked for, so nothing was placed")


def _remove_tracks(host: Any, timeline: str, tracks: list) -> None:
    """Removes tracks this module added (1-based [kind, index]) while they're the last and empty."""
    wanted: dict[str, list[int]] = {"video": [], "audio": []}
    for kind, index in tracks:
        wanted[kind].append(int(index) - 1)
    if wanted["video"] or wanted["audio"]:
        host._send("remove_tracks", {"timeline": timeline, **wanted})


def _ids(args: dict[str, Any], key: str = "itemIds") -> list[str]:
    ids = args.get(key)
    if not isinstance(ids, list) or not ids or not all(isinstance(i, str) and i for i in ids):
        raise HostError(f"{key} must be a non-empty list of sequence clip ids")
    ids = list(dict.fromkeys(ids))
    if len(ids) > MAX_ITEMS_PER_CALL:
        raise HostError(f"At most {MAX_ITEMS_PER_CALL} clips at a time")
    return ids


# ------------------------------------------------------------------------------- the backup


def backup_timeline(host: Any, args: dict[str, Any]) -> dict[str, Any]:
    """{timeline} -> clones it as "<name> (before VibeCut n)"; the open sequence stays open."""
    name = host._name(args)
    taken = set(host.status({})["timelines"])
    n = 1
    while f"{name} (before VibeCut {n})" in taken:
        n += 1
    wanted = unique_name(f"{name} (before VibeCut {n})", taken)
    return {"backup": host._send("backup_sequence", {"timeline": name, "name": wanted})["name"]}


# ------------------------------------------------------------------------------- adding


def _plan_place(seq: Sequence, spec: dict[str, Any], probe: Any, extra: list, where: str) -> dict[str, Any]:
    """Where one clip goes: checked against the sequence and the clips placed before it in the call. A
    clip with no free track gets new ones at the end (added before anything is placed)."""
    item_id = spec.get("itemId")
    if item_id is not None and (not isinstance(item_id, str) or not ID_PATTERN.fullmatch(item_id)):
        raise HostError(f"{where}.itemId must name a project clip")
    path = spec.get("path")
    if not isinstance(path, str) or not os.path.isabs(path) or not os.path.isfile(path):
        raise HostError(f"{where}.path is not a file on this computer: {path!r}")
    source_in = _number(spec.get("sourceIn", 0), f"{where}.sourceIn", 0)
    source_out = _number(spec.get("sourceOut"), f"{where}.sourceOut")
    if source_out <= source_in:
        raise HostError(f"{where} must end after it starts")
    at = seq.ticks(_number(spec.get("at"), f"{where}.at", 0))
    frames = max(1, round((source_out - source_in) * TICKS_PER_SECOND / seq.timebase))
    end = at + frames * seq.timebase
    has_video = probe.video(path) is not None
    audio = probe.audio(path) or {}
    channels = int(audio.get("channels") or 0)
    picture = spec.get("picture", has_video) is not False and has_video
    sound = spec.get("sound", channels > 0) is not False and channels > 0
    if not picture and not sound:
        raise HostError(
            f"{where}: nothing to place (the file has no {'picture' if not has_video else 'sound'})"
        )
    name = os.path.basename(path)
    # overwriteClip places the file's picture and all its sound, so every track it fills must be free,
    # even the part that's removed again afterwards.
    video_track = -1
    new_tracks: list[list[Any]] = []
    if has_video:
        wanted = spec.get("videoTrack")
        options = (
            [int(_number(wanted, f"{where}.videoTrack", 1))]
            if wanted is not None
            else range(1, len(seq.tracks["video"]) + 1)
        )
        video_track = next((i for i in options if seq.free("video", i, at, end, extra=extra)), -1)
        if video_track < 0 and wanted is None:
            video_track = _new_track(seq, "video")
            new_tracks.append(["video", video_track])
        if video_track < 0:
            raise HostError(
                f"{where}: {'V' + str(wanted) if wanted is not None else 'no video track'} is free from {seconds(at)} s to {seconds(end)} s. "
                + (
                    "VibeCut won't overwrite: leave videoTrack out and VibeCut picks a free track (adding one if needed), or use a draft (place_broll)"
                    if wanted is not None
                    else "VibeCut won't overwrite and Premiere can't add a track from a script: add one in Premiere, or use a draft (place_broll)"
                )
            )
    audio_track = -1
    if channels:
        wanted = spec.get("audioTrack")
        options = (
            [int(_number(wanted, f"{where}.audioTrack", 1))]
            if wanted is not None
            else range(1, len(seq.tracks["audio"]) + 1)
        )
        audio_track = next(
            (
                i
                for i in options
                if all(seq.free("audio", i + c, at, end, extra=extra) for c in range(channels))
            ),
            -1,
        )
        if audio_track < 0 and wanted is None:
            # The free tracks at the end are used first, and only the rest are added.
            total = len(seq.tracks["audio"]) + seq.new["audio"]
            audio_track = total + 1
            while audio_track > 1 and seq.free("audio", audio_track - 1, at, end, extra=extra):
                audio_track -= 1
            first_new = _new_track(seq, "audio", channels - (total - audio_track + 1))
            new_tracks.extend(["audio", i] for i in range(first_new, audio_track + channels))
        if audio_track < 0:
            raise HostError(
                f"{where}: {name}'s sound needs {channels} free audio track(s) in a row from {seconds(at)} s to {seconds(end)} s"
                f"{' starting at A' + str(wanted) if wanted is not None else ''}. VibeCut won't overwrite: "
                + (
                    "leave audioTrack out and VibeCut picks a free track (adding one if needed), or use a draft"
                    if wanted is not None
                    else "free them, add tracks in Premiere, or use a draft"
                )
            )
    occupied = ([("video", video_track, at, end)] if has_video else []) + [
        ("audio", audio_track + c, at, end) for c in range(channels)
    ]
    extra.extend(occupied)
    volume = spec.get("volumeDb")
    return {
        "path": path,
        "itemId": item_id,
        "newTracks": new_tracks,
        "name": name,
        "inSeconds": source_in,
        "outSeconds": source_in + frames * seq.timebase / TICKS_PER_SECOND,
        "atTicks": at,
        "endTicks": end,
        "videoTrack": video_track,
        "audioTrack": audio_track,
        "picture": picture,
        "sound": sound,
        "volumeDb": max(MIN_DB, min(MAX_DB, _number(volume, f"{where}.volumeDb")))
        if volume is not None
        else None,
    }


def _place(host: Any, timeline: str, plan: dict[str, Any], before: Sequence) -> list[dict[str, Any]]:
    """Runs one planned placement; removes the half that wasn't wanted, sets the level, and checks
    that nothing that was there before changed."""
    placed = host._send(
        "place_clip",
        {
            "timeline": timeline,
            "path": plan["path"],
            "inSeconds": plan["inSeconds"],
            "outSeconds": plan["outSeconds"],
            "atTicks": str(plan["atTicks"]),
            # The panel's tracks are 0-based; -1 is none.
            "videoTrack": plan["videoTrack"] - 1 if plan["videoTrack"] > 0 else -1,
            "audioTrack": plan["audioTrack"] - 1 if plan["audioTrack"] > 0 else -1,
            "bin": BIN_NAME,
            **({"itemId": plan["itemId"]} if plan.get("itemId") else {}),
        },
    )["placed"]
    unwanted = [
        p["id"]
        for p in placed
        if (p["type"] == "video" and not plan["picture"]) or (p["type"] == "audio" and not plan["sound"])
    ]
    if unwanted:
        host._send("remove_items", {"timeline": timeline, "ids": unwanted})
    kept = [p for p in placed if p["id"] not in unwanted]
    if plan["volumeDb"] is not None:
        audio = [{"id": p["id"], "level": gain(plan["volumeDb"])} for p in kept if p["type"] == "audio"]
        if audio:
            host._send("set_items", {"timeline": timeline, "items": audio})
    after = _read(host, timeline)
    for item_id, clip in before.clips.items():
        now = after.clips.get(item_id)
        if now is None or any(now[k] != clip[k] for k in ("startTicks", "endTicks", "inTicks")):
            raise HostError(
                f"Premiere changed {clip['name']} on {_label(clip['kind'], clip['index'])} while placing {plan['name']}. "
                "Check the sequence; its backup has it as it was"
            )
    return kept


def add_clips(host: Any, args: dict[str, Any], probe: Any = None) -> dict[str, Any]:
    probe = probe or Probe()
    timeline = host._name(args)
    clips = args.get("clips")
    if not isinstance(clips, list) or not clips:
        raise HostError("clips must be a non-empty list")
    if len(clips) > 50:
        raise HostError("At most 50 clips at a time")
    seq = _read(host, timeline)
    extra: list = []
    # Every clip is checked before any is placed, so a bad one leaves the sequence unchanged.
    plans = [
        _plan_place(seq, c if isinstance(c, dict) else {}, probe, extra, f"clips[{i}]")
        for i, c in enumerate(clips)
    ]
    # New tracks first, all at once: if Premiere can't add them, nothing has been placed.
    _add_tracks(host, timeline, seq.new["video"], seq.new["audio"])
    seq = _read(host, timeline)
    changes = []
    for plan in plans:
        kept = _place(host, timeline, plan, seq)
        seq = _read(host, timeline)
        changes.append({
            "kind": "added",
            "name": plan["name"],
            "itemIds": [p["id"] for p in kept],
            "at": seconds(plan["atTicks"]),
            "end": seconds(plan["endTicks"]),
            "tracks": [_label(p["type"], p["track"] + 1) for p in kept],
            "newTracks": plan["newTracks"],
        })  # fmt: skip
    added = [_label(k, i) for plan in plans for k, i in plan["newTracks"]]
    return {"changes": changes, "refused": [], "addedTracks": added}


# ------------------------------------------------------------------------------- deleting


def _deleted(clip: dict[str, Any], group: list[str], channel: int = 1) -> dict[str, Any]:
    """Everything needed to put a lifted clip back from its file."""
    record = {
        "kind": "deleted",
        "itemId": clip["id"],
        "name": clip.get("name", ""),
        "track": [clip["kind"], clip["index"]],
        "start": seconds(clip["startTicks"]),
        "end": seconds(clip["endTicks"]),
        "startTicks": clip["startTicks"],
        "endTicks": clip["endTicks"],
        "inTicks": clip["inTicks"],
        "filePath": clip.get("mediaPath"),
        "enabled": not clip.get("disabled", False),
        "deletedWith": [i for i in group if i != clip["id"]],
        # Partners left on the sequence, to link it to again when it's put back.
        "linkedIds": [i for i in clip.get("linkedIds", []) if i not in group],
    }
    if clip.get("speed") not in (None, 1):
        record["speed"] = clip["speed"]
    if clip["kind"] == "audio":
        record["volumeDb"] = level_db(clip.get("level"))
        record["channel"] = channel
    return record


def delete_clips(host: Any, args: dict[str, Any]) -> dict[str, Any]:
    timeline = host._name(args)
    seq = _read(host, timeline)
    chosen: list[str] = []
    for item_id in _ids(args):
        if item_id.startswith("tr-"):
            raise HostError("Transitions can't be removed here; remove them in Premiere")
        seq.clip(item_id)
        for member in seq.partners(item_id) if args.get("withLinked", True) is not False else [item_id]:
            if member not in chosen:
                chosen.append(member)
    changes = [_deleted(seq.clips[i], chosen, seq.channel(seq.clips[i])) for i in chosen]
    removed = host._send("remove_items", {"timeline": timeline, "ids": chosen})
    gone = set(removed.get("removed", []))
    return {
        "changes": [c for c in changes if c["itemId"] in gone],
        "refused": [{"itemId": i, "reason": "Premiere didn't remove it"} for i in chosen if i not in gone],
    }


# ------------------------------------------------------------------------------- nesting (13f)

MAX_NEST_NAME = 120


def nest_clips(host: Any, args: dict[str, Any]) -> dict[str, Any]:
    """{timeline, start, end, name} -> everything from start to end (seconds), on every track, becomes
    one nested sequence in its place (Premiere's Nest: a sequence made from the range, the clips
    lifted, and the sequence overwritten into the gap on V1 and A1). A clip across either edge is
    refused (split it first), and so is one without a media file (a title, an adjustment layer, a
    nested sequence), which a revert couldn't put back. Recorded as the clips deleted and the nest
    added, so a revert takes the nest out and puts the clips back from their files (their effects
    aren't restored; the nested sequence stays in the project). The sequence must be the open one."""
    timeline = host._name(args)
    seq = _read(host, timeline)
    start_s = _number(args.get("start"), "start", 0)
    end_s = _number(args.get("end"), "end", 0)
    a, b = seq.ticks(start_s), seq.ticks(end_s)
    if b - a < seq.timebase:
        raise HostError("end must be at least a frame after start")
    raw = args.get("name")
    name = (raw.strip() if isinstance(raw, str) and raw.strip() else "Nested clips")[:MAX_NEST_NAME].replace(
        "/", "-"
    )
    inside: list[Any] = []
    across: list[Any] = []
    for item_id, clip in seq.clips.items():
        s, e = int(clip["startTicks"]), int(clip["endTicks"])
        if e <= a or s >= b:
            continue
        (inside if s >= a and e <= b else across).append(item_id)
    if across:
        names = ", ".join(repr(seq.clips[i].get("name", "")) for i in across[:3])
        raise HostError(
            f"{names} run across the edge of the range; split them at {start_s:g} s and {end_s:g} s first (split_clip), or change the range"
        )
    if not inside:
        raise HostError(f"There's nothing between {start_s:g} s and {end_s:g} s")
    for item_id in inside:
        if not seq.clips[item_id].get("mediaPath"):
            raise HostError(
                f"{seq.clips[item_id].get('name')!r} has no media file (a title, adjustment layer or nested sequence); nest it in Premiere"
            )
    deleted = [_deleted(seq.clips[i], inside, seq.channel(seq.clips[i])) for i in inside]
    result = host._send(
        "nest_range",
        {"timeline": timeline, "inTicks": str(a), "outTicks": str(b), "ids": inside, "name": name},
    )
    if not isinstance(result, dict):
        # Seen once live (13p): Premiere answered with nothing after making the "<sequence>_Sub_01" copy.
        raise HostError(
            f'Premiere didn\'t say what it nested. It may have made a sequence named "{timeline}_Sub_…" in the project '
            "without changing this one; check the sequence, then try again"
        )
    gone = set(result.get("removed", []))
    placed = result.get("placed", [])
    changes = [d for d in deleted if d["itemId"] in gone]
    if placed:
        changes.append({
            "kind": "added",
            "name": result.get("sequence") or name,
            "itemIds": [p["id"] for p in placed],
            "at": seconds(a),
            "end": seconds(b),
            "tracks": [_label(p["type"], p["track"] + 1) for p in placed],
            "newTracks": [],
            "nested": len(changes),
        })  # fmt: skip
    return {
        "changes": changes,
        "refused": [{"itemId": i, "reason": "Premiere didn't lift it"} for i in inside if i not in gone],
    }


# ------------------------------------------------------------------------------- captions (13h)

MAX_CUES = 5000


# ------------------------------------------------------------------------------- switches and levels


def set_clips_enabled(host: Any, args: dict[str, Any]) -> dict[str, Any]:
    timeline = host._name(args)
    enabled = args.get("enabled")
    if not isinstance(enabled, bool):
        raise HostError("enabled must be true or false")
    seq = _read(host, timeline)
    targets = [seq.clip(i) for i in _ids(args)]
    changing = [c for c in targets if (not c.get("disabled", False)) != enabled]
    if changing:
        host._send(
            "set_items",
            {
                "timeline": timeline,
                "items": [{"id": c["id"], "disabled": not enabled} for c in changing],
            },
        )
    return {
        "changes": [
            {
                "kind": "enabled",
                "itemId": c["id"],
                "name": c.get("name", ""),
                "before": not enabled,
                "after": enabled,
            }
            for c in changing
        ],
        "refused": [],
    }


def set_clip_levels(host: Any, args: dict[str, Any]) -> dict[str, Any]:
    timeline = host._name(args)
    levels = args.get("levels")
    if not isinstance(levels, list) or not levels or len(levels) > MAX_ITEMS_PER_CALL:
        raise HostError("levels must be a list of {itemId, volumeDb}")
    seq = _read(host, timeline)
    wanted: dict[str, float] = {}
    for i, level in enumerate(levels):
        if not isinstance(level, dict):
            raise HostError(f"levels[{i}] must be an object")
        db = _number(level.get("volumeDb"), f"levels[{i}].volumeDb")
        if not MIN_DB <= db <= MAX_DB:
            raise HostError(f"levels[{i}].volumeDb must be from {MIN_DB} to {MAX_DB} dB")
        clip = seq.clip(level.get("itemId"))
        # A picture clip's id means its linked sound.
        sound = (
            [clip["id"]]
            if clip["kind"] == "audio"
            else [p for p in seq.partners(clip["id"]) if seq.clips[p]["kind"] == "audio"]
        )
        if not sound:
            raise HostError(f"{clip.get('name')} has no sound to set")
        for item_id in sound:
            wanted[item_id] = round(db, 2)
    changing = {i: db for i, db in wanted.items() if level_db(seq.clips[i].get("level")) != db}
    if changing:
        host._send(
            "set_items",
            {
                "timeline": timeline,
                "items": [{"id": i, "level": gain(db)} for i, db in changing.items()],
            },
        )
    return {
        "changes": [
            {
                "kind": "level",
                "itemId": i,
                "name": seq.clips[i].get("name", ""),
                "before": level_db(seq.clips[i].get("level")),
                "after": db,
            }
            for i, db in changing.items()
        ],
        "refused": [],
    }


# ------------------------------------------------------------------------------- trim, slip and move


def _placement(clip: dict[str, Any], fps: float) -> dict[str, Any]:
    """A ClipPlacement (src/types/connect.ts), plus the exact ticks to put it back."""
    return {
        "id": clip["id"],
        "track": [clip["kind"], clip["index"]],
        "start": seconds(clip["startTicks"]),
        "end": seconds(clip["endTicks"]),
        "sourceStartFrame": round(int(clip["inTicks"]) * fps / TICKS_PER_SECOND),
        "ticks": {k: clip[k] for k in ("startTicks", "endTicks", "inTicks", "outTicks")},
    }


def _same_recording(a: dict[str, Any], b: dict[str, Any]) -> bool:
    """Two channels of one recording: sound clips of the same file at the same place and source point."""
    keys = ("startTicks", "endTicks", "inTicks")
    return (
        a["kind"] == b["kind"] == "audio"
        and a.get("mediaPath") == b.get("mediaPath")
        and all(a[k] == b[k] for k in keys)
    )


def reshape_clip(host: Any, args: dict[str, Any], probe: Any = None) -> dict[str, Any]:
    """{timeline, itemId, sourceIn | sourceOut | slip | start (+ videoTrack/audioTrack), withLinked}
    -> trims the start or end to a new source point, slips the source, or moves the clip, with its
    linked partners, in place. withLinked false (a slip only) leaves the linked picture where it is and
    slips just this sound, with the other channels of its recording (Premiere's split stereo)."""
    probe = probe or Probe()
    timeline = host._name(args)
    seq = _read(host, timeline)
    clip = seq.clip(args.get("itemId"))
    given = [k for k in ("sourceIn", "sourceOut", "slip", "start") if args.get(k) is not None]
    if len(given) != 1:
        raise HostError("Give one of sourceIn, sourceOut, slip or start")
    how = {
        "sourceIn": "trimmed",
        "sourceOut": "trimmed",
        "slip": "slipped",
        "start": "moved",
    }[given[0]]
    if args.get("videoTrack") is not None or args.get("audioTrack") is not None:
        track = args.get("videoTrack") if clip["kind"] == "video" else args.get("audioTrack")
        if track is not None and int(_number(track, "track", 1)) != clip["index"]:
            if clip["kind"] != "video":
                raise HostError(
                    "Only a picture clip can change track directly; move sound to another track in a draft"
                )
            if how != "moved":
                raise HostError("Only a move can change a clip's track")
            return _retrack(host, timeline, clip, int(track), args["start"], probe)
    group = seq.partners(clip["id"])
    if args.get("withLinked") is False:
        if how != "slipped":
            raise HostError(
                "withLinked false goes with slip only; a trim or move keeps linked clips together"
            )
        group = [i for i in group if i == clip["id"] or _same_recording(seq.clips[i], clip)]
    left = [seq.clips[i] for i in seq.partners(clip["id"]) if i not in group]
    members = [seq.clips[i] for i in group]
    for m in members:
        if m.get("speed") not in (None, 1) or m.get("reversed"):
            raise HostError(f"{m['name']} has a speed change; reshape it in a draft")
        if m.get("adjustment") or not m.get("mediaPath"):
            raise HostError(f"{m['name']} has no media file to trim")
        if seq.touches_transition(m):
            raise HostError(
                f"{m['name']} has a transition at an edge; remove it in Premiere first, or use a draft"
            )
    # Fade keys sit in the source file, so a slip or trim would leave them behind (premiere_effects.py).
    from vibecut_agent.nle.premiere_effects import has_fades

    faded = has_fades(host, timeline, seq, group)
    if faded:
        raise HostError(
            f"{faded} has a fade or keyframes, which would stay where they are in the file; remove the fade first, or use a draft"
        )
    duration = (probe.timecode(clip["mediaPath"]) or {}).get("duration")
    length = int(duration * TICKS_PER_SECOND) if duration else None
    value = _number(args[given[0]], given[0])
    updates = []
    for m in members:
        start, end, src_in, src_out = (int(m[k]) for k in ("startTicks", "endTicks", "inTicks", "outTicks"))
        if given[0] == "sourceIn":
            delta = seq.ticks(value) - int(clip["inTicks"])
            start, src_in = start + delta, src_in + delta
        elif given[0] == "sourceOut":
            delta = seq.ticks(value) - int(clip["outTicks"])
            end, src_out = end + delta, src_out + delta
        elif given[0] == "slip":
            delta = seq.ticks(value)
            src_in, src_out = src_in + delta, src_out + delta
        else:
            delta = seq.ticks(value) - int(clip["startTicks"])
            start, end = start + delta, end + delta
        if end - start < seq.timebase:
            raise HostError(f"{m['name']} would be shorter than a frame")
        if src_in < 0 or (length is not None and src_out > length + seq.timebase):
            raise HostError(f"{m['name']}'s file doesn't reach that far ({seconds(length or 0)} s long)")
        if start < 0:
            raise HostError("That would start before the sequence")
        if not seq.free(m["kind"], m["index"], start, end, ignore=set(group)):
            raise HostError(
                f"{_label(m['kind'], m['index'])} isn't free from {seconds(start)} s to {seconds(end)} s; VibeCut won't overwrite"
            )
        updates.append(
            {
                "id": m["id"],
                "startTicks": str(start),
                "endTicks": str(end),
                "inTicks": str(src_in),
                "outTicks": str(src_out),
                "delta": delta,
            }
        )
    if how == "moved":
        host._send(
            "move_items",
            {
                "timeline": timeline,
                "ids": group,
                "offsetTicks": str(updates[0]["delta"]),
            },
        )
    else:
        host._send(
            "set_items",
            {
                "timeline": timeline,
                "items": [{k: v for k, v in u.items() if k != "delta"} for u in updates],
            },
        )
    after = _read(host, timeline)
    items = [
        {
            "before": _placement(m, seq.fps),
            "after": _placement(after.clip(m["id"]), seq.fps),
        }
        for m in members
    ]
    # Premiere can drag linked clips along with an edit; those meant to stay must not have moved.
    stayed = [_placement(m, seq.fps) for m in left]
    if any(_placement(after.clip(p["id"]), seq.fps)["ticks"] != p["ticks"] for p in stayed):
        _put(host, timeline, after, [i["before"] for i in items] + stayed)
        raise HostError(
            f"Premiere moved {clip['name']}'s linked clips with it, so it was put back; slip them together, or unlink them in Premiere first"
        )
    for u, item in zip(updates, items, strict=True):
        if item["after"]["ticks"] != {k: u[k] for k in ("startTicks", "endTicks", "inTicks", "outTicks")}:
            _put(host, timeline, after, [i["before"] for i in items])
            verb = {"trimmed": "trim", "slipped": "slip", "moved": "move"}[how]
            raise HostError(f"Premiere didn't {verb} {clip['name']} as asked; it was put back")
    return {
        "changes": [
            {
                "kind": "reshaped",
                "how": how,
                "name": clip.get("name", ""),
                "items": items,
                "notCarried": [],
            }
        ],
        "refused": [],
        "renamed": {},
    }


# ------------------------------------------------------------------------------- moving to another track
#
# Premiere's scripting moves a clip only along its track. To change track, the picture is placed again
# from its project item on the new track (overwriteClip lays down its sound too, so that's done past the
# sequence's end, where every track is free, and the sound removed), moved into place, and the old one
# removed; its sound stays where it was, linked to the new picture. What a fresh placement wouldn't
# have (effects, changed Motion or Opacity, keyframes, a speed change) would be lost, so such clips are
# refused.


def _past_end(seq: Sequence) -> int:
    """A frame past everything on the sequence, where every track is free."""
    last = max([int(seq.raw.get("endTicks") or 0)] + [int(c["endTicks"]) for c in seq.clips.values()])
    return -(-last // seq.timebase) * seq.timebase + seq.timebase


def _replace(
    host: Any,
    timeline: str,
    seq: Sequence,
    clip: dict[str, Any],
    track: int,
    start: int,
    channels: int,
) -> str:
    """Places the picture of `clip`'s project item on video track `track` (1-based) from `start`, same
    source range and switch, removes `clip`, and returns the new clip's id."""
    length = int(clip["endTicks"]) - int(clip["startTicks"])
    at = _past_end(seq)
    plan = {
        "path": clip["mediaPath"],
        "itemId": clip.get("projectItemId"),
        "name": clip["name"],
        "inSeconds": int(clip["inTicks"]) / TICKS_PER_SECOND,
        "outSeconds": (int(clip["inTicks"]) + length) / TICKS_PER_SECOND,
        "atTicks": at,
        "endTicks": at + length,
        "videoTrack": track,
        "audioTrack": 1 if channels else -1,
        "picture": True,
        "sound": False,
        "volumeDb": None,
    }
    placed = _place(host, timeline, plan, seq)
    picture = [p for p in placed if p["type"] == "video"]
    if len(picture) != 1:
        host._send("remove_items", {"timeline": timeline, "ids": [p["id"] for p in placed]})
        raise HostError(f"Premiere didn't place {clip['name']} on V{track}; nothing was changed")
    new_id = picture[0]["id"]
    host._send(
        "move_items",
        {"timeline": timeline, "ids": [new_id], "offsetTicks": str(start - at)},
    )
    if clip.get("disabled"):
        host._send(
            "set_items",
            {"timeline": timeline, "items": [{"id": new_id, "disabled": True}]},
        )
    host._send("remove_items", {"timeline": timeline, "ids": [clip["id"]]})
    return new_id


def _retrack(
    host: Any,
    timeline: str,
    clip_ref: dict[str, Any],
    track: int,
    start_time: Any,
    probe: Any,
) -> dict[str, Any]:
    """move_clip to another video track: the picture is re-placed there (adding the track if it's the
    next one), its linked sound moves along its own tracks by the same amount and stays linked."""
    seq = _read(host, timeline, effects=True)
    clip = seq.clip(clip_ref["id"])
    if clip.get("speed") not in (None, 1) or clip.get("reversed"):
        raise HostError(f"{clip['name']} has a speed change; move it to another track in a draft")
    if (
        clip.get("adjustment")
        or clip.get("nested")
        or not clip.get("mediaPath")
        or not clip.get("projectItemId")
    ):
        raise HostError(f"{clip['name']} has no media file to place again; move it in Premiere")
    if seq.touches_transition(clip):
        raise HostError(
            f"{clip['name']} has a transition at an edge; remove it in Premiere first, or use a draft"
        )
    if clip.get("custom") is not False:
        raise HostError(
            f"{clip['name']} has effects, keyframes or a changed Motion or Opacity, which changing its track "
            "from a script would lose. Move it in Premiere, or use a draft"
        )
    count = len(seq.tracks["video"])
    if track > count + 1:
        raise HostError(
            f"There's no V{track}; the sequence has {count} video track(s), and VibeCut adds at most the next one"
        )
    start = seq.ticks(_number(start_time, "start", 0))
    delta = start - int(clip["startTicks"])
    end = int(clip["endTicks"]) + delta
    group = seq.partners(clip["id"])
    partners = [seq.clips[i] for i in group if i != clip["id"]]
    if not seq.free("video", track, start, end, ignore=set(group)) and track <= count:
        raise HostError(
            f"V{track} isn't free from {seconds(start)} s to {seconds(end)} s; VibeCut won't overwrite"
        )
    for p in partners if delta else []:
        s0, e0 = int(p["startTicks"]) + delta, int(p["endTicks"]) + delta
        if s0 < 0 or not seq.free(p["kind"], p["index"], s0, e0, ignore=set(group)):
            raise HostError(
                f"{_label(p['kind'], p['index'])} isn't free from {seconds(s0)} s to {seconds(e0)} s; VibeCut won't overwrite"
            )
    channels = int((probe.audio(clip["mediaPath"]) or {}).get("channels") or 0)
    if channels > len(seq.tracks["audio"]):
        raise HostError(
            f"Placing {clip['name']} again needs {channels} audio tracks; the sequence has {len(seq.tracks['audio'])}"
        )
    new_tracks: list[tuple[str, int]] = [("video", track)] if track == count + 1 else []
    _add_tracks(host, timeline, len(new_tracks), 0)
    seq = _read(host, timeline)
    new_id = _replace(host, timeline, seq, clip, track, start, channels)
    if delta and partners:
        host._send(
            "move_items",
            {
                "timeline": timeline,
                "ids": [p["id"] for p in partners],
                "offsetTicks": str(delta),
            },
        )
    if partners:
        host._send(
            "link_items",
            {"timeline": timeline, "ids": [new_id, *[p["id"] for p in partners]]},
        )
    after = _read(host, timeline)
    moved = after.clips.get(new_id)
    if moved is None or (
        moved["index"],
        int(moved["startTicks"]),
        moved["inTicks"],
    ) != (track, start, clip["inTicks"]):
        raise HostError(
            f"Premiere didn't put {clip['name']} on V{track} as asked; check the sequence, its backup has it as it was"
        )
    items = [{"before": _placement(clip, seq.fps), "after": _placement(moved, seq.fps)}]
    items += [
        {
            "before": _placement(p, seq.fps),
            "after": _placement(after.clip(p["id"]), seq.fps),
        }
        for p in partners
    ]
    return {
        "changes": [
            {
                "kind": "reshaped",
                "how": "moved",
                "name": clip.get("name", ""),
                "items": items,
                "notCarried": [],
                # Changed track by being placed again: Revert does the same the other way.
                "retracked": {
                    "projectItemId": clip["projectItemId"],
                    "filePath": clip["mediaPath"],
                    "disabled": bool(clip.get("disabled")),
                    "newTracks": new_tracks,
                },
            }
        ],
        "refused": [],
        "renamed": {clip["id"]: new_id},
        "addedTracks": [_label(k, i) for k, i in new_tracks],
    }


def _retrack_back(
    host: Any,
    timeline: str,
    seq: Sequence,
    change: dict[str, Any],
    ids: dict[str, str],
    probe: Any,
) -> str:
    """Undoes a move to another track: the picture placed again on its old track and place, its sound
    moved back. `ids` maps each item's `after` id to the clip there now. Returns the picture's new id."""
    picture, *partners = change["items"]
    now = seq.clip(ids[picture["after"]["id"]])
    info = change["retracked"]
    clip = {
        **now,
        "projectItemId": info.get("projectItemId"),
        "mediaPath": now.get("mediaPath") or info.get("filePath"),
    }
    channels = int((probe.audio(clip["mediaPath"]) or {}).get("channels") or 0)
    if channels > len(seq.tracks["audio"]):
        raise HostError(f"putting it back needs {channels} audio tracks")
    start = int(picture["before"]["ticks"]["startTicks"])
    new_id = _replace(host, timeline, seq, clip, int(picture["before"]["track"][1]), start, channels)
    stayed = [ids[p["after"]["id"]] for p in partners]
    delta = start - int(picture["after"]["ticks"]["startTicks"])
    if delta and stayed:
        host._send(
            "move_items",
            {"timeline": timeline, "ids": stayed, "offsetTicks": str(delta)},
        )
    if stayed:
        host._send("link_items", {"timeline": timeline, "ids": [new_id, *stayed]})
    _remove_tracks(host, timeline, info.get("newTracks") or [])
    return new_id


def _move_groups(host: Any, timeline: str, seq: Sequence, moves: list[tuple[list[str], int]]) -> None:
    """Moves each list of clips along its tracks by its own ticks. A move onto a clip still to move
    would overlap them in Premiere for a moment, so one amount goes latest clip first (or earliest
    first, moving back); different amounts (a swap) take each group past the end of the sequence
    first, then to its place."""
    moves = [(ids, delta) for ids, delta in moves if ids and delta]
    if not moves:
        return
    if len({delta for _ids, delta in moves}) == 1:
        delta = moves[0][1]
        ids = sorted(
            (i for group, _d in moves for i in group),
            key=lambda i: int(seq.clips[i]["startTicks"]),
            reverse=delta > 0,
        )
        host._send("move_items", {"timeline": timeline, "ids": ids, "offsetTicks": str(delta)})
        return
    furthest = max(int(seq.clips[i]["endTicks"]) + delta for ids, delta in moves for i in ids)
    park = max(_past_end(seq), -(-furthest // seq.timebase) * seq.timebase + seq.timebase)
    parked = []
    for ids, delta in moves:
        first = min(int(seq.clips[i]["startTicks"]) for i in ids)
        last = max(int(seq.clips[i]["endTicks"]) for i in ids)
        host._send(
            "move_items",
            {"timeline": timeline, "ids": ids, "offsetTicks": str(park - first)},
        )
        parked.append((ids, delta - (park - first)))
        park += -(-(last - first) // seq.timebase) * seq.timebase + seq.timebase
    for ids, rest in parked:
        host._send("move_items", {"timeline": timeline, "ids": ids, "offsetTicks": str(rest)})


def _put(host: Any, timeline: str, now: Sequence, places: list[dict[str, Any]]) -> None:
    """Sets clips back to placements (same tracks): moves when only the place differs (each clip by
    its own amount: a swap's two groups go back by opposite ones), else all four points."""
    same_shape = all(
        int(p["ticks"]["endTicks"]) - int(p["ticks"]["startTicks"])
        == int(now.clip(p["id"])["endTicks"]) - int(now.clip(p["id"])["startTicks"])
        and p["ticks"]["inTicks"] == now.clip(p["id"])["inTicks"]
        for p in places
    )
    by_delta: dict[int, list[str]] = {}
    for p in places:
        delta = int(p["ticks"]["startTicks"]) - int(now.clip(p["id"])["startTicks"])
        by_delta.setdefault(delta, []).append(p["id"])
    if same_shape and any(by_delta):
        _move_groups(host, timeline, now, [(ids, d) for d, ids in by_delta.items()])
    else:
        host._send(
            "set_items",
            {
                "timeline": timeline,
                "items": [{"id": p["id"], **p["ticks"]} for p in places],
            },
        )


# ------------------------------------------------------------------------------- reverting


def _put_back(
    host: Any, timeline: str, seq: Sequence, group: list[dict[str, Any]], probe: Any
) -> tuple[str, dict[str, str]]:
    """Puts a group of clips lifted together back from their file, in one placement. Returns
    ("reverted" | "taken" | "failed: why", old id -> new id).

    A placement always lays down the file's picture and every channel of its sound. When only some of
    them were lifted (the sound under a picture that stayed, or one channel), it's made past the
    sequence's end, where every track is free, the parts that stayed are removed, and the rest moved
    along their tracks into their old places."""
    first = group[0]
    if first.get("speed"):
        return "failed: it had a speed change; the backup has it", {}
    path = first.get("filePath")
    if not path or not os.path.isfile(path):
        return "failed: its media file isn't there any more", {}
    video = [g for g in group if g["track"][0] == "video"]
    audio = [g for g in group if g["track"][0] == "audio"]
    start, end = int(first["startTicks"]), int(first["endTicks"])
    in_ticks = int(first["inTicks"])
    channels = int((probe.audio(path) or {}).get("channels") or 0)
    has_video = probe.video(path) is not None
    if any(not seq.free(g["track"][0], g["track"][1], start, end) for g in group):
        return "taken", {}
    v_track = video[0]["track"][1] if video else (1 if has_video else -1)
    # A file's first channel goes on the track it's placed on, so a lifted right channel (A2) is placed
    # from A1.
    a_track = (
        min(g["track"][1] - g.get("channel", 1) + 1 for g in audio) if audio else (1 if channels else -1)
    )
    if channels and (a_track < 1 or a_track + channels - 1 > len(seq.tracks["audio"])):
        return (
            f"failed: putting {first['name']} back needs {channels} audio tracks from A{max(a_track, 1)}",
            {},
        )
    whole = (not has_video or bool(video)) and len(audio) == channels
    at = start
    if not whole:
        last = max([int(seq.raw.get("endTicks") or 0)] + [int(c["endTicks"]) for c in seq.clips.values()])
        at = -(-last // seq.timebase) * seq.timebase + seq.timebase
    plan = {
        "path": path,
        "name": first["name"],
        "inSeconds": in_ticks / TICKS_PER_SECOND,
        "outSeconds": (in_ticks + end - start) / TICKS_PER_SECOND,
        "atTicks": at,
        "endTicks": at + end - start,
        "videoTrack": v_track,
        "audioTrack": a_track,
        "picture": True,
        "sound": True,
        "volumeDb": None,
    }
    try:
        placed = _place(host, timeline, plan, seq)
    except HostError as exc:
        return f"failed: {exc}", {}
    # Only the tracks that were lifted are kept.
    wanted = {(g["track"][0], g["track"][1]): g for g in group}
    restored: dict[str, str] = {}
    extra = []
    settings = []
    for p in placed:
        record = wanted.get((p["type"], p["track"] + 1))
        if record is None:
            extra.append(p["id"])
            continue
        restored[record["itemId"]] = p["id"]
        item: dict[str, Any] = {"id": p["id"]}
        if not record.get("enabled", True):
            item["disabled"] = True
        if record.get("volumeDb") is not None and record["volumeDb"] != 0:
            item["level"] = gain(record["volumeDb"])
        if len(item) > 1:
            settings.append(item)
    if extra:
        host._send("remove_items", {"timeline": timeline, "ids": extra})
    if at != start and restored:
        host._send(
            "move_items",
            {
                "timeline": timeline,
                "ids": list(restored.values()),
                "offsetTicks": str(start - at),
            },
        )
    if settings:
        host._send("set_items", {"timeline": timeline, "items": settings})
    stayed = list(dict.fromkeys(i for g in group for i in g.get("linkedIds", []) if i in seq.clips))
    if stayed and restored:
        host._send("link_items", {"timeline": timeline, "ids": [*restored.values(), *stayed]})
    return "reverted", restored


def _recording(change: dict[str, Any]) -> tuple:
    """One take of one file at one place: its channels share this."""
    return (
        change.get("filePath"),
        change.get("startTicks"),
        change.get("endTicks"),
        change.get("inTicks"),
    )


# The change kinds VibeCut Agent's edit commands make (VibeCut's transitions, captions, speed, track,
# grade, link and trackOptions edits aren't ported).
REVERTIBLE = ("added", "deleted", "enabled", "level", "reshaped", "fade", "duck", "split", "link")


def revert_timeline_changes(host: Any, args: dict[str, Any], probe: Any = None) -> dict[str, Any]:
    """{timeline, changes (oldest first)} -> undoes them newest first where the sequence still has what
    each left. A clip put back comes from its file without its effects (`lost`); the request's backup
    still has them."""
    probe = probe or Probe()
    timeline = host._name(args)
    changes = args.get("changes")
    if not isinstance(changes, list) or not all(
        isinstance(c, dict) and c.get("kind") in REVERTIBLE for c in changes
    ):
        raise HostError("changes must be a list of the changes the edit commands returned")
    reverted, changed_since, failed, lost = [], [], [], []
    restored: dict[str, str] = {}

    def current(item_id: Any) -> Any:
        for _hop in range(100):
            if item_id not in restored:
                break
            item_id = restored[item_id]
        return item_id

    done: set[str] = set()
    for change in reversed(changes):
        seq = _read(host, timeline)
        kind = change["kind"]
        label = change.get("name") or change.get("itemId") or ""
        if kind == "added":
            ids = [current(i) for i in change.get("itemIds", [])]
            present = [i for i in ids if i in seq.clips]
            if len(present) != len(ids):
                changed_since.append({"name": label, "reason": "it isn't on the sequence any more"})
            elif (
                present
                and abs(seconds(seq.clips[present[0]]["startTicks"]) - float(change.get("at", 0)))
                > 0.5 / seq.fps
            ):
                changed_since.append({"name": label, "reason": "it was moved since"})
            elif present:
                host._send("remove_items", {"timeline": timeline, "ids": present})
                reverted.append({"kind": kind, "name": label})
                _remove_tracks(host, timeline, change.get("newTracks") or [])
        elif kind == "deleted":
            if change["itemId"] in done:
                continue
            group_ids = [change["itemId"], *change.get("deletedWith", [])]
            recording = _recording(change)
            # Clips lifted together go back together, and so do channels of one recording lifted
            # separately: Premiere places a file's channels from its first, so they can't go back apart.
            group = [
                c
                for c in changes
                if c["kind"] == "deleted"
                and c["itemId"] not in done
                and (c["itemId"] in group_ids or _recording(c) == recording)
            ]
            done.update(c["itemId"] for c in group)
            outcome, put_ids = _put_back(host, timeline, seq, group, probe)
            if outcome == "reverted":
                restored.update(put_ids)
                reverted.extend({"kind": kind, "name": c.get("name", "")} for c in group)
                lost.append(label)
            elif outcome == "taken":
                changed_since.append({"name": label, "reason": "its place is taken now"})
            else:
                failed.append({"name": label, "reason": outcome.removeprefix("failed: ")})
        elif kind == "link":
            # VibeCut's revert of a link change (Phase 6c: links.py), ids followed to the clips' current ones.
            from vibecut_agent.nle import links

            followed = {
                **change,
                "groupsBefore": [[current(i) for i in g] for g in change.get("groupsBefore") or []],
                "groupsAfter": [[current(i) for i in g] for g in change.get("groupsAfter") or []],
            }
            outcome = links.premiere_revert_links(host, timeline, followed)
            if outcome == "reverted":
                reverted.append({"kind": kind, "name": label})
            elif outcome == "changed":
                changed_since.append({"name": label, "reason": "it was changed since"})
            else:
                failed.append({"name": label, "reason": "Premiere didn't put it back"})
        elif kind == "split":
            from vibecut_agent.nle import premiere_timing

            outcome = premiere_timing.revert_split(host, timeline, seq, change, current)
            if outcome == "reverted":
                reverted.append({"kind": kind, "name": label})
            elif outcome == "changed":
                changed_since.append({"name": label, "reason": "it was changed since"})
            else:
                failed.append({"name": label, "reason": "Premiere didn't put it back"})
        elif kind in ("fade", "duck"):
            from vibecut_agent.nle import premiere_effects

            item_id = current(change.get("itemId"))
            if item_id not in seq.clips:
                changed_since.append({"name": label, "reason": "it isn't on the sequence any more"})
                continue
            revert = {"fade": premiere_effects.revert_fade, "duck": premiere_effects.revert_duck}[kind]
            outcome = revert(host, timeline, seq, item_id, change)
            if outcome == "reverted":
                reverted.append({"kind": kind, "name": label})
            elif outcome == "changed":
                changed_since.append({"name": label, "reason": "it was changed since"})
            else:
                failed.append({"name": label, "reason": "Premiere didn't put it back"})
        elif kind == "reshaped":
            items = change.get("items", [])
            if not items or any(current(i["after"]["id"]) not in seq.clips for i in items):
                changed_since.append({"name": label, "reason": "it isn't on the sequence any more"})
                continue
            now = {i["after"]["id"]: seq.clips[current(i["after"]["id"])] for i in items}
            if any(
                {k: now[i["after"]["id"]][k] for k in ("startTicks", "endTicks", "inTicks", "outTicks")}
                != i["after"].get("ticks")
                for i in items
            ):
                changed_since.append({"name": label, "reason": "it was changed since"})
                continue
            moving = {current(i["after"]["id"]) for i in items}
            if not all(
                seq.free(
                    i["before"]["track"][0],
                    i["before"]["track"][1],
                    int(i["before"]["ticks"]["startTicks"]),
                    int(i["before"]["ticks"]["endTicks"]),
                    ignore=moving,
                )
                for i in items
            ):
                changed_since.append({"name": label, "reason": "its old place is taken now"})
                continue
            if change.get("retracked"):
                after_ids = {i["after"]["id"]: current(i["after"]["id"]) for i in items}
                try:
                    new_id = _retrack_back(host, timeline, seq, change, after_ids, probe)
                except HostError as exc:
                    failed.append({"name": label, "reason": str(exc)})
                    continue
                restored[after_ids[items[0]["after"]["id"]]] = new_id
                reverted.append({"kind": kind, "name": label})
                continue
            _put(
                host,
                timeline,
                seq,
                [{**i["before"], "id": current(i["after"]["id"])} for i in items],
            )
            reverted.append({"kind": kind, "name": label})
        else:
            item_id = current(change.get("itemId"))
            if item_id not in seq.clips:
                changed_since.append({"name": label, "reason": "it isn't on the sequence any more"})
                continue
            clip = seq.clips[item_id]
            after, before = change.get("after"), change.get("before")
            if kind == "enabled":
                same = (not clip.get("disabled", False)) == after
                setting = {"id": item_id, "disabled": not before}
            else:
                now_db = level_db(clip.get("level"))
                same = now_db is not None and isinstance(after, (int, float)) and abs(now_db - after) < 0.01
                setting = {
                    "id": item_id,
                    "level": gain(float(before if isinstance(before, (int, float)) else 0.0)),
                }
            if not same:
                changed_since.append({"name": label, "reason": "it was changed since"})
                continue
            host._send("set_items", {"timeline": timeline, "items": [setting]})
            reverted.append({"kind": kind, "name": label})
    return {
        "reverted": reverted,
        "changedSince": changed_since,
        "failed": failed,
        "lost": sorted(set(lost)),
        "gradedFromBackup": [],
        "restoredIds": restored,
    }
