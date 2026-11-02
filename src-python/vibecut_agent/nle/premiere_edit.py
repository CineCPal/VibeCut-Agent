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
  with its sound as the audio clips its channel mapping makes, from that audio track on, all linked.
  How many is the project item's to say (`audio_clips`, its `getAudioChannelMapping().audioClipsNumber`):
  a stereo WAV, a stereo .mov and a .mov with two mono streams each laid one clip on one track (checked
  live, Phase 18e and the Phase 21 follow-up), and a file set to mono channels lays one per channel.
  It overwrites whatever is there, so free space on every one of those tracks is checked first. It can't add tracks; Premiere's unsupported QE layer can (phase 4f: `add_tracks` and
  `remove_tracks` in the panel), so a clip with no free track gets new ones at the end, removed again
  by Revert while they're the last and empty. Without QE, the old refusal stands.
- A clip's `start`, `end`, `inPoint` and `outPoint` are set independently: setting `start` alone
  doesn't move the source in. So a trim or slip sets all four, on the clip and each linked partner.
- `TrackItem.move(offset)` moves only that clip, so a move moves each partner too. Neither a move nor new
  points change a clip's place in its track's list, which Premiere's timeline expects in time order; a
  placement goes into it in its place. So a clip is never moved past another: it's placed again at its
  destination instead (see "Premiere's clip order", checked live 2026-11-02).
- `remove(false, false)` lifts only that clip; its partners stay, still linked to each other.
- `disabled` can be set. Level animation is on for every sound clip by default, so a level is set
  with `setValue` unless the clip has real keyframes.
- Premiere's own Undo isn't a dependable way back: a scripted placement is an undo step, but a
  scripted level change or move isn't. Revert and the backup are.
"""

from __future__ import annotations

import math
import os
import secrets
from collections.abc import Callable
from pathlib import Path
from typing import Any

from vibecut_agent.nle.premiere import (
    ID_PATTERN,
    TICKS_PER_SECOND,
    HostError,
    frame_rate,
    level_db,
    seconds,
)
from vibecut_agent.nle.premiere_support import BIN_NAME, Probe, estimated_audio_tracks, unique_name

MAX_ITEMS_PER_CALL = 200
MIN_DB, MAX_DB = -100.0, 30.0


def _number(value: Any, field: str, minimum: float | None = None) -> float:
    if not isinstance(value, (int, float)) or isinstance(value, bool) or not math.isfinite(value):
        raise HostError(f"{field} must be a number")
    if minimum is not None and value < minimum:
        raise HostError(f"{field} must be at least {minimum}")
    return float(value)


def media_probe() -> Any:
    """This module's Probe (tests fake premiere_edit.Probe), for premiere_effects' transitions."""
    return Probe()


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


def discard_backup(host: Any, args: dict[str, Any]) -> None:
    """{timeline, backup} -> deletes the backup a failed OTIO batch made and fully undid (bridge_runner.py).
    Not an edit command: only "<timeline> (before VibeCut n)" is ever deleted."""
    if not str(args["backup"]).startswith(f"{args['timeline']} (before VibeCut "):
        raise HostError(f"{args['backup']!r} isn't a VibeCut backup of {args['timeline']!r}")
    if host._send("delete_sequence", {"timeline": args["backup"]}).get("deleted") is not True:
        raise HostError(f"Premiere didn't delete {args['backup']!r}")


# ------------------------------------------------------------------------------- adding


AudioTracks = Callable[[str, str | None, int], int]


def _estimate(path: str, item_id: str | None, channels: int) -> int:
    return estimated_audio_tracks(channels)


def audio_tracks_from(host: Any) -> AudioTracks:
    """How many audio tracks the file's project item fills, asked of Premiere (importing it into the bin
    if the project hasn't got it, as placing it would); estimated when the panel can't say (before 0.17)."""

    def ask(path: str, item_id: str | None, channels: int) -> int:
        try:
            answer = host._send(
                "audio_clips", {"path": path, "bin": BIN_NAME, **({"itemId": item_id} if item_id else {})}
            )
        except HostError:
            return estimated_audio_tracks(channels)
        clips = answer.get("clips") if isinstance(answer, dict) else None
        if isinstance(clips, int) and not isinstance(clips, bool) and clips >= 1:
            return clips
        return estimated_audio_tracks(channels)

    return ask


def _plan_place(
    seq: Sequence,
    spec: dict[str, Any],
    probe: Any,
    extra: list,
    where: str,
    audio_tracks: AudioTracks = _estimate,
) -> dict[str, Any]:
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
    # The audio tracks its sound fills, from the one it's placed on (the module docstring).
    tracks = audio_tracks(path, item_id, channels) if channels else 0
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
                if all(seq.free("audio", i + c, at, end, extra=extra) for c in range(tracks))
            ),
            -1,
        )
        if audio_track < 0 and wanted is None:
            # The free tracks at the end are used first, and only the rest are added.
            total = len(seq.tracks["audio"]) + seq.new["audio"]
            audio_track = total + 1
            while audio_track > 1 and seq.free("audio", audio_track - 1, at, end, extra=extra):
                audio_track -= 1
            first_new = _new_track(seq, "audio", tracks - (total - audio_track + 1))
            new_tracks.extend(["audio", i] for i in range(first_new, audio_track + tracks))
        if audio_track < 0:
            raise HostError(
                f"{where}: {name}'s sound needs {tracks} free audio track(s) in a row from {seconds(at)} s to {seconds(end)} s"
                f"{' starting at A' + str(wanted) if wanted is not None else ''}. VibeCut won't overwrite: "
                + (
                    "leave audioTrack out and VibeCut picks a free track (adding one if needed), or use a draft"
                    if wanted is not None
                    else "free them, add tracks in Premiere, or use a draft"
                )
            )
    # Only the parts that stay hold their tracks for the clips after it: the rest is removed again
    # before the next clip is placed (_place), so a picture-only camera leaves A1 for its mic.
    occupied = ([("video", video_track, at, end)] if picture else []) + [
        ("audio", audio_track + c, at, end) for c in range(tracks if sound else 0)
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


def _clean_range(request: dict[str, Any]) -> dict[str, Any]:
    """The source range to the nanosecond. Seen live (Premiere 26.5.2, 2026-10-31, 25 fps): an out point
    of 0.6 + 4.8 s, sent as 5.3999999999999995, was set a frame early (5.36 s), so the clip came out a
    frame short; 13.399999999999999 and a plain 5.4 weren't. Rounding sends 5.4 and keeps every frame."""
    return {
        **request,
        "inSeconds": round(request["inSeconds"], 9),
        "outSeconds": round(request["outSeconds"], 9),
    }


def place_clip_exact(host: Any, timeline: str, request: dict[str, Any]) -> list[dict[str, Any]]:
    """place_clip, and for a file with no picture a check of its source range. Seen live (Premiere
    26.5.2, 2026-10-26, a 48 kHz WAV at 25 fps): such a file lands a frame earlier in it than asked, and
    from 0 a frame short, so every send or cleaned copy put a mic a frame off its picture. A placement
    that's off by up to two frames is lifted and placed again that much later."""
    request = _clean_range(request)
    placed: list[dict[str, Any]] = host._send("place_clip", request)["placed"]
    if not placed or any(p["type"] == "video" for p in placed):
        return placed
    after = _read(host, timeline)
    want_in = round(request["inSeconds"] * TICKS_PER_SECOND)
    want_out = round(request["outSeconds"] * TICKS_PER_SECOND)
    got = [after.clips[p["id"]] for p in placed if p["id"] in after.clips]
    offs = {(int(c["inTicks"]) - want_in, int(c["outTicks"]) - want_out) for c in got}
    if len(offs) != 1:
        return placed
    off_in, off_out = offs.pop()
    # From 0 the in point can't go earlier, so only the out point shows how far off it is.
    off = off_in or off_out
    if off == 0 or abs(off) > 2 * after.timebase or (off_in and abs(off_in - off_out) > after.timebase // 2):
        return placed
    host._send("remove_items", {"timeline": timeline, "ids": [p["id"] for p in placed]})
    shift = off / TICKS_PER_SECOND
    again = _clean_range(
        {
            **request,
            "inSeconds": request["inSeconds"] - shift,
            "outSeconds": request["outSeconds"] - shift,
        }
    )
    replaced: list[dict[str, Any]] = host._send("place_clip", again)["placed"]
    return replaced


def _place(host: Any, timeline: str, plan: dict[str, Any], before: Sequence) -> list[dict[str, Any]]:
    """Runs one planned placement; removes the half that wasn't wanted, sets the level, and checks
    that nothing that was there before changed."""
    request = {
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
    }
    placed = place_clip_exact(host, timeline, request)
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
    tracks = audio_tracks_from(host)
    plans = [
        _plan_place(seq, c if isinstance(c, dict) else {}, probe, extra, f"clips[{i}]", tracks)
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


def _srt_time(t: float) -> str:
    ms = max(0, round(t * 1000))
    return f"{ms // 3600000:02d}:{ms // 60000 % 60:02d}:{ms // 1000 % 60:02d},{ms % 1000:03d}"


def srt_text(cues: list[dict[str, Any]]) -> str:
    return "".join(
        f"{n}\n{_srt_time(c['start'])} --> {_srt_time(c['end'])}\n{c['text']}\n\n"
        for n, c in enumerate(cues, 1)
    )


def create_captions(host: Any, args: dict[str, Any], imports: Path | None = None) -> dict[str, Any]:
    """{timeline, cues: [{start, end, text}] (sequence seconds), name} -> an SRT of the cues in the
    bridge's imports/ folder, imported and made a caption track from the sequence's start
    (createCaptionTrack, VibeCut's 13h probe). Premiere's scripting can't remove a caption track, so a
    revert says to delete it there. Ported from VibeCut (Phase 15a); the imports folder is passed in, as
    for rebuild."""
    timeline = host._name(args)
    raw = args.get("cues")
    if not isinstance(raw, list) or not raw or len(raw) > MAX_CUES:
        raise HostError(f"cues must list 1 to {MAX_CUES} captions")
    cues = []
    for i, cue in enumerate(raw):
        if not isinstance(cue, dict):
            raise HostError(f"cues[{i}] must be an object")
        start, end = (
            _number(cue.get("start"), f"cues[{i}].start", 0),
            _number(cue.get("end"), f"cues[{i}].end", 0),
        )
        text = cue.get("text")
        if not isinstance(text, str) or not text.strip() or len(text) > 300 or end <= start:
            raise HostError(f"cues[{i}] needs text (at most 300 characters) and an end after its start")
        cues.append({"start": start, "end": end, "text": " ".join(text.split())})
    given = args.get("name")
    name = given.strip() if isinstance(given, str) and given.strip() else f"{timeline} captions"
    name = name[:120].replace("/", "-")
    if imports is None:
        raise HostError("This Premiere connection has no folder for caption files")
    folder = os.fspath(imports)
    os.makedirs(folder, exist_ok=True)
    path = os.path.join(folder, f"captions-{secrets.token_hex(4)}.srt")
    with open(path, "w", encoding="utf-8") as f:
        f.write(srt_text(cues))
    host._send("caption_track", {"timeline": timeline, "path": path, "name": name})
    return {
        "changes": [
            {
                "kind": "captions",
                "name": name,
                "count": len(cues),
                "trackName": "a caption track",
                "path": path,
            }
        ],
        "refused": [],
    }


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


def label_clips(host: Any, args: dict[str, Any]) -> dict[str, Any]:
    """{timeline, labels: [{itemId, name?, color?}]} -> names sequence clips and sets their label colour
    (Phase 16b). Every Premiere clip has a label, so a colour can be changed but not cleared. Only the
    named clip changes, not its linked partners. A Premiere whose scripting has no track item labels
    refuses the colour (panel 0.12.0 checks)."""
    from vibecut_agent.nle.labels import label_wants
    from vibecut_agent.nle.premiere_pool import PREMIERE_LABEL_COLORS, label_name

    timeline = host._name(args)
    wants = label_wants(args, PREMIERE_LABEL_COLORS, None)
    seq = _read(host, timeline)
    settings, befores, refused = [], {}, []
    for want in wants:
        clip = seq.clip(want["itemId"])
        before = {"name": clip.get("name", ""), "color": label_name(clip.get("label")) or ""}
        setting: dict[str, Any] = {"id": clip["id"]}
        if "name" in want and want["name"] != before["name"]:
            setting["name"] = want["name"]
        if "color" in want and not isinstance(clip.get("label"), int):
            # The read has no label: this Premiere (or a panel before 0.12.0) can't script one.
            refused.append(
                {
                    "itemId": clip["id"],
                    "reason": "Premiere can't set a sequence clip's colour from a script here",
                }
            )
        elif "color" in want and want["color"] != before["color"]:
            setting["label"] = PREMIERE_LABEL_COLORS.index(want["color"])
        if len(setting) > 1:
            settings.append(setting)
            befores[clip["id"]] = before
    if settings:
        host._send("set_items", {"timeline": timeline, "items": settings})
    now = _read(host, timeline)
    changes = []
    for setting in settings:
        before = befores[setting["id"]]
        clip = now.clips.get(setting["id"]) or {}
        after = {"name": clip.get("name", ""), "color": label_name(clip.get("label")) or ""}
        wanted_name = setting.get("name", before["name"])
        wanted_color = PREMIERE_LABEL_COLORS[setting["label"]] if "label" in setting else before["color"]
        if after != {"name": wanted_name, "color": wanted_color}:
            refused.append({"itemId": setting["id"], "reason": "Premiere didn't take the name or colour"})
        if after != before:
            changes.append(
                {
                    "kind": "label",
                    "itemId": setting["id"],
                    "name": before["name"],
                    "before": before,
                    "after": after,
                }
            )
    return {"changes": changes, "refused": refused}


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
    # Each clip against its own file: a camera's recorder is a file of its own, often longer.
    durations = {
        path: (probe.timecode(path) or {}).get("duration") for path in {m["mediaPath"] for m in members}
    }
    value = _number(args[given[0]], given[0])
    updates = []
    for m in members:
        duration = durations[m["mediaPath"]]
        length = int(duration * TICKS_PER_SECOND) if duration else None
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
    renamed: dict[str, str] = {}
    if how == "moved":
        # Past other clips, the group is placed again instead (see "Premiere's clip order").
        renamed = _move_groups(host, timeline, seq, [(group, updates[0]["delta"])], probe)
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
            "after": _placement(after.clip(renamed.get(m["id"], m["id"])), seq.fps),
        }
        for m in members
    ]
    back = [{**i["before"], "id": i["after"]["id"]} for i in items]
    # Premiere can drag linked clips along with an edit; those meant to stay must not have moved.
    stayed = [_placement(m, seq.fps) for m in left]
    if any(_placement(after.clip(p["id"]), seq.fps)["ticks"] != p["ticks"] for p in stayed):
        _put(host, timeline, after, back + stayed, probe)
        raise HostError(
            f"Premiere moved {clip['name']}'s linked clips with it, so it was put back; slip them together, or unlink them in Premiere first"
        )
    for u, item in zip(updates, items, strict=True):
        if item["after"]["ticks"] != {k: u[k] for k in ("startTicks", "endTicks", "inTicks", "outTicks")}:
            _put(host, timeline, after, back, probe)
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
        "renamed": renamed,
    }


# ------------------------------------------------------------------------------- Premiere's clip order
#
# Premiere keeps each track's clips in a list it expects in time order, and draws and plays the sequence
# by walking it. A placement goes into the list in its place; nothing else changes a clip's place in it:
# `TrackItem.move` and new start or end points keep it where it was, even past other clips (checked live,
# Premiere 26.5.2, 2026-11-02). A clip moved past another was drawn missing but played, the one it passed
# was drawn but didn't play, and the project was saved that way. So moves may only leave each track's
# clips in the same order; a clip that would end up out of it is lifted and placed again at its
# destination. What happens to the order on the way doesn't matter: only where each clip ends up.


# A microsecond past each point of a range placed again: Premiere turns the seconds it's sent into ticks
# and floors them to a frame, so 21.021 s (630 frames at 29.97) could land on frame 629, or the out point a
# frame short (checked live, 2026-11-02). A microsecond never reaches the next frame.
NUDGE_SECONDS = 1e-6


def _misplaced(seq: Sequence, moving: dict[str, int]) -> set[str]:
    """The moving clips (id -> ticks moved) that would end up out of their track's list order. Clips that
    stay where they are keep their place, so a track already out of order is left as it is."""
    out: set[str] = set()
    for kind in ("video", "audio"):
        for track in seq.tracks[kind]:
            clips = track.get("clips", [])
            starts = [int(c["startTicks"]) + moving.get(c["id"], 0) for c in clips]
            # The heaviest run of the list that's in time order, a clip that stays outweighing every move.
            weight = [1 if c["id"] in moving else len(clips) + 1 for c in clips]
            best, prev = list(weight), [-1] * len(clips)
            for i in range(len(clips)):
                for j in range(i):
                    if starts[j] <= starts[i] and best[j] + weight[i] > best[i]:
                        best[i], prev[i] = best[j] + weight[i], j
            kept: set[int] = set()
            i = max(range(len(clips)), key=best.__getitem__, default=-1)
            while i >= 0:
                kept.add(i)
                i = prev[i]
            out |= {c["id"] for n, c in enumerate(clips) if n not in kept and c["id"] in moving}
    return out


def _out_of_order(seq: Sequence) -> set[str]:
    """The tracks ("V1", "A2") whose list isn't in time order."""
    return {
        _label(kind, index)
        for kind in ("video", "audio")
        for index, track in enumerate(seq.tracks[kind], start=1)
        if [int(c["startTicks"]) for c in track.get("clips", [])]
        != sorted(int(c["startTicks"]) for c in track.get("clips", []))
    }


def _check_order(host: Any, timeline: str, before: Sequence) -> None:
    """Raises when a track has fallen out of time order since `before`, rather than leave Premiere's
    timeline showing and playing the wrong clips."""
    broken = _out_of_order(_read(host, timeline)) - _out_of_order(before)
    if broken:
        raise HostError(
            f"Premiere's clip order on {', '.join(sorted(broken))} broke, so its timeline may not show or "
            "play some clips there. Revert this edit, or use the request's backup"
        )


def _refuse_unplaceable(host: Any, timeline: str, ids: list[str]) -> None:
    """Placing a clip again from its file keeps only its range, switch, level, name and label; refuses
    clips that would lose more."""
    seq = _read(host, timeline, effects=True)
    for item_id in ids:
        clip = seq.clip(item_id)
        problem = None
        if clip.get("speed") not in (None, 1) or clip.get("reversed"):
            problem = "has a speed change"
        elif (
            clip.get("adjustment")
            or clip.get("nested")
            or not clip.get("mediaPath")
            or not clip.get("projectItemId")
        ):
            problem = "has no media file to place again"
        elif seq.touches_transition(clip):
            problem = "has a transition at an edge"
        elif clip.get("custom"):
            problem = "has effects, keyframes or a changed Motion or Opacity"
        if problem:
            raise HostError(
                f"{clip['name']} {problem}. Moving it past other clips means placing it again (Premiere's "
                "scripting can't reorder a track's clips), which would lose that. Move it in Premiere, or use a draft"
            )
    from vibecut_agent.nle.premiere_effects import has_fades

    faded = has_fades(host, timeline, seq, ids)
    if faded:
        raise HostError(
            f"{faded} has a fade or keyframes. Moving it past other clips means placing it again (Premiere's "
            "scripting can't reorder a track's clips), which would lose them. Remove the fade first, or use a draft"
        )


def _place_parts(
    host: Any,
    timeline: str,
    source: dict[str, Any],
    at: int,
    parts: list[dict[str, Any]],
    probe: Any,
) -> dict[str, str]:
    """Places part of a file again from its project item. `source` is {path, itemId, name, inTicks,
    length}; each part is {id, kind, index, channel} and gets the placed clip on that track. A placement
    lays the file's picture and all its sound at once, so the parts no one wants go on tracks free there
    (else scratch tracks added at the end and removed again) and are lifted at once. Never moves a clip:
    a placement goes into each track's list in its place. Returns part id -> placed clip id."""
    seq = _read(host, timeline)
    path, name, length = source["path"], source["name"], int(source["length"])
    end = at + length
    has_video = probe.video(path) is not None
    channels = int((probe.audio(path) or {}).get("channels") or 0)
    sounds = audio_tracks_from(host)(path, source.get("itemId"), channels) if channels else 0
    pictures = [p for p in parts if p["kind"] == "video"]
    heard = [p for p in parts if p["kind"] == "audio"]
    for p in parts:
        if not seq.free(p["kind"], p["index"], at, end, ignore={p["id"]}):
            raise HostError(
                f"{_label(p['kind'], p['index'])} isn't free from {seconds(at)} s to {seconds(end)} s; VibeCut won't overwrite"
            )
    counts = {kind: len(seq.tracks[kind]) for kind in ("video", "audio")}

    def spare(kind: str, many: int) -> int:
        """The first of `many` tracks in a row free over the span: existing ones, else new ones at the end."""
        for first in range(1, counts[kind] - many + 2):
            if all(seq.free(kind, t, at, end) for t in range(first, first + many)):
                return first
        return counts[kind] + 1

    if len(pictures) > 1 or (pictures and not has_video):
        raise HostError(f"{name} can't be placed again as asked")
    v_track = pictures[0]["index"] if pictures else (spare("video", 1) if has_video else 0)
    if heard:
        firsts = {p["index"] - int(p.get("channel") or 1) + 1 for p in heard}
        if len(firsts) != 1 or min(firsts) < 1:
            raise HostError(f"{name}'s channels aren't on tracks in a row, so it can't be placed again")
        a_track = firsts.pop()
        mine = {p["index"] for p in heard}
        for t in range(a_track, a_track + sounds):
            if t not in mine and not seq.free("audio", t, at, end):
                raise HostError(f"Placing {name} again would lay its sound over A{t}, so it wasn't moved")
    else:
        a_track = spare("audio", sounds) if sounds else 0
    added = {
        "video": max(0, v_track - counts["video"]),
        "audio": max(0, a_track + sounds - 1 - counts["audio"]),
    }
    _add_tracks(host, timeline, added["video"], added["audio"])
    in_ticks = int(source["inTicks"])
    request = {
        "timeline": timeline,
        "path": path,
        "inSeconds": round(in_ticks / TICKS_PER_SECOND + NUDGE_SECONDS, 9),
        "outSeconds": round((in_ticks + length) / TICKS_PER_SECOND + NUDGE_SECONDS, 9),
        "atTicks": str(at),
        # The panel's tracks are 0-based; -1 is none.
        "videoTrack": v_track - 1 if v_track else -1,
        "audioTrack": a_track - 1 if a_track else -1,
        "bin": BIN_NAME,
        **({"itemId": source["itemId"]} if source.get("itemId") else {}),
    }
    placed: list[dict[str, Any]] = host._send("place_clip", request)["placed"]
    wanted = {(p["kind"], p["index"]): p["id"] for p in parts}
    got = {
        wanted[(q["type"], q["track"] + 1)]: q["id"] for q in placed if (q["type"], q["track"] + 1) in wanted
    }
    extra = [q["id"] for q in placed if (q["type"], q["track"] + 1) not in wanted]
    if extra:
        host._send("remove_items", {"timeline": timeline, "ids": extra})
    _remove_tracks(
        host,
        timeline,
        [["video", counts["video"] + n] for n in range(added["video"], 0, -1)]
        + [["audio", counts["audio"] + n] for n in range(added["audio"], 0, -1)],
    )
    after = _read(host, timeline)
    for item_id, clip in seq.clips.items():
        now = after.clips.get(item_id)
        if now is None or any(now[k] != clip[k] for k in ("startTicks", "endTicks", "inTicks")):
            raise HostError(
                f"Premiere changed {clip['name']} on {_label(clip['kind'], clip['index'])} while placing {name} again. "
                "Check the sequence; its backup has it as it was"
            )
    exact = {
        "startTicks": str(at),
        "endTicks": str(end),
        "inTicks": str(in_ticks),
        "outTicks": str(in_ticks + length),
    }
    off = [
        i for i in got.values() if i in after.clips and any(after.clips[i][k] != v for k, v in exact.items())
    ]
    # A frame or two off where it lands: its points are set exactly there, which passes no other clip.
    if off and all(
        abs(int(after.clips[i][k]) - int(v)) <= 2 * seq.timebase for i in off for k, v in exact.items()
    ):
        host._send("set_items", {"timeline": timeline, "items": [{"id": i, **exact} for i in off]})
        after = _read(host, timeline)
    if len(got) != len(parts) or any(
        i not in after.clips or any(after.clips[i][k] != v for k, v in exact.items()) for i in got.values()
    ):
        raise HostError(
            f"Premiere didn't place {name} again where asked; check the sequence, its backup has it as it was"
        )
    return got


def _place_again(
    host: Any, timeline: str, seq: Sequence, ids: list[str], delta: int, probe: Any
) -> dict[str, str]:
    """Places clips that are already lifted (read in `seq`) again, `delta` ticks along their own tracks, with
    their switch, level, name and label, linked as before. Returns old id -> new id."""
    clips = [seq.clip(i) for i in ids]
    units: dict[tuple, list[dict[str, Any]]] = {}
    for c in clips:
        units.setdefault((c.get("mediaPath"), c["startTicks"], c["endTicks"], c["inTicks"]), []).append(c)
    renamed: dict[str, str] = {}
    for unit in units.values():
        first = unit[0]
        source = {
            "path": first["mediaPath"],
            "itemId": first.get("projectItemId"),
            "name": first["name"],
            "inTicks": first["inTicks"],
            "length": int(first["endTicks"]) - int(first["startTicks"]),
        }
        parts = [
            {
                "id": c["id"],
                "kind": c["kind"],
                "index": c["index"],
                "channel": seq.channel(c) if c["kind"] == "audio" else 1,
            }
            for c in unit
        ]
        renamed.update(_place_parts(host, timeline, source, int(first["startTicks"]) + delta, parts, probe))
    now = _restore_settings(host, timeline, clips, renamed)
    # Each clip linked again to what it was linked to: the others placed again, and partners that stayed.
    groups: list[list[str]] = []
    for c in clips:
        group = [
            renamed.get(i, i) for i in [c["id"], *c.get("linkedIds", [])] if i in renamed or i in now.clips
        ]
        if len(group) > 1 and set(group) not in [set(g) for g in groups]:
            groups.append(group)
    for group in groups:
        host._send("link_items", {"timeline": timeline, "ids": group})
    return renamed


def _restore_settings(
    host: Any, timeline: str, clips: list[dict[str, Any]], renamed: dict[str, str]
) -> Sequence:
    """Gives clips placed again (old -> new id) the switch, level, name and label the old ones had.
    Returns the sequence as it is then."""
    now = _read(host, timeline)
    settings, labels = [], []
    for c in clips:
        new = now.clip(renamed[c["id"]])
        item: dict[str, Any] = {"id": new["id"]}
        if c.get("disabled"):
            item["disabled"] = True
        if c["kind"] == "audio" and c.get("level") is not None and c.get("level") != new.get("level"):
            item["level"] = c["level"]
        if c.get("name") and c["name"] != new.get("name"):
            item["name"] = c["name"]
        if len(item) > 1:
            settings.append(item)
        if isinstance(c.get("label"), int) and c["label"] != new.get("label"):
            labels.append({"id": new["id"], "label": c["label"]})
    if settings:
        host._send("set_items", {"timeline": timeline, "items": settings})
    if labels:
        # A Premiere that can't set a clip's label colour from a script refuses; the clip is placed all the same.
        try:
            host._send("set_items", {"timeline": timeline, "items": labels})
        except HostError:
            pass
    return now


# ------------------------------------------------------------------------------- moving to another track
#
# Premiere's scripting moves a clip only along its track. To change track, the picture is placed again
# from its project item on the new track, where it goes (overwriteClip lays down its sound too, on tracks
# free there, else scratch ones, and that sound is lifted again), and the old one removed; its sound
# stays on its tracks, moved by the same amount, linked to the new picture. What a fresh placement
# wouldn't have (effects, changed Motion or Opacity, keyframes, a speed change) would be lost, so such
# clips are refused.


def _past_end(seq: Sequence) -> int:
    """A frame past everything on the sequence, where every track is free."""
    last = max([int(seq.raw.get("endTicks") or 0)] + [int(c["endTicks"]) for c in seq.clips.values()])
    return -(-last // seq.timebase) * seq.timebase + seq.timebase


def _replace(
    host: Any,
    timeline: str,
    clip: dict[str, Any],
    track: int,
    start: int,
    probe: Any,
) -> str:
    """Places the picture of `clip`'s project item on video track `track` (1-based) from `start`, same
    source range and switch, removes `clip`, and returns the new clip's id. It's placed where it goes,
    never moved there, so it takes its place in the track's list (see "Premiere's clip order")."""
    source = {
        "path": clip["mediaPath"],
        "itemId": clip.get("projectItemId"),
        "name": clip["name"],
        "inTicks": clip["inTicks"],
        "length": int(clip["endTicks"]) - int(clip["startTicks"]),
    }
    try:
        placed = _place_parts(
            host, timeline, source, start, [{"id": clip["id"], "kind": "video", "index": track}], probe
        )
    except HostError as exc:
        raise HostError(f"Premiere didn't place {clip['name']} on V{track}: {exc}") from exc
    new_id = placed[clip["id"]]
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
    new_tracks: list[tuple[str, int]] = [("video", track)] if track == count + 1 else []
    _add_tracks(host, timeline, len(new_tracks), 0)
    new_id = _replace(host, timeline, clip, track, start, probe)
    # The sound moves along its tracks, placed again too if that would take it past other clips.
    renamed = _move_groups(
        host, timeline, _read(host, timeline), [([p["id"] for p in partners], delta)], probe
    )
    sound = [renamed.get(p["id"], p["id"]) for p in partners]
    if partners:
        host._send(
            "link_items",
            {"timeline": timeline, "ids": [new_id, *sound]},
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
            "after": _placement(after.clip(renamed.get(p["id"], p["id"])), seq.fps),
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
        "renamed": {clip["id"]: new_id, **renamed},
        "addedTracks": [_label(k, i) for k, i in new_tracks],
    }


def _retrack_back(
    host: Any,
    timeline: str,
    seq: Sequence,
    change: dict[str, Any],
    ids: dict[str, str],
    probe: Any,
) -> dict[str, str]:
    """Undoes a move to another track: the picture placed again on its old track and place, its sound
    moved back. `ids` maps each item's `after` id to the clip there now. Returns the clips' current ids
    -> their new ones (the picture's, and any sound placed again to keep its track's order)."""
    picture, *partners = change["items"]
    now = seq.clip(ids[picture["after"]["id"]])
    info = change["retracked"]
    clip = {
        **now,
        "projectItemId": info.get("projectItemId"),
        "mediaPath": now.get("mediaPath") or info.get("filePath"),
    }
    start = int(picture["before"]["ticks"]["startTicks"])
    new_id = _replace(host, timeline, clip, int(picture["before"]["track"][1]), start, probe)
    stayed = [ids[p["after"]["id"]] for p in partners]
    delta = start - int(picture["after"]["ticks"]["startTicks"])
    renamed = _move_groups(host, timeline, _read(host, timeline), [(stayed, delta)], probe)
    if stayed:
        host._send(
            "link_items", {"timeline": timeline, "ids": [new_id, *[renamed.get(i, i) for i in stayed]]}
        )
    _remove_tracks(host, timeline, info.get("newTracks") or [])
    return {now["id"]: new_id, **renamed}


def _move_groups(
    host: Any, timeline: str, seq: Sequence, moves: list[tuple[list[str], int]], probe: Any = None
) -> dict[str, str]:
    """Moves each list of clips along its tracks by its own ticks; returns old id -> new id for clips
    placed again. A list with a clip that would end up out of its track's order (see "Premiere's clip
    order") is lifted first and placed again at its destination once the rest have moved. A move onto a
    clip still to move would overlap them in Premiere for a moment, so one amount goes latest clip first
    (or earliest first, moving back); different amounts (a swap) take each group past the end of the
    sequence first, then to its place."""
    moves = [(ids, delta) for ids, delta in moves if ids and delta]
    if not moves:
        return {}
    misplaced = _misplaced(seq, {i: delta for ids, delta in moves for i in ids})
    again = [(ids, delta) for ids, delta in moves if misplaced & set(ids)]
    moves = [(ids, delta) for ids, delta in moves if not misplaced & set(ids)]
    if again:
        _refuse_unplaceable(host, timeline, [i for ids, _d in again for i in ids])
        host._send("remove_items", {"timeline": timeline, "ids": [i for ids, _d in again for i in ids]})
    _shift_groups(host, timeline, seq, moves)
    renamed: dict[str, str] = {}
    for ids, delta in again:
        renamed.update(_place_again(host, timeline, seq, ids, delta, probe or Probe()))
    _check_order(host, timeline, seq)
    return renamed


def _shift_groups(host: Any, timeline: str, seq: Sequence, moves: list[tuple[list[str], int]]) -> None:
    """The moves that keep every track's order, by `TrackItem.move` (see `_move_groups`)."""
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


def _put(
    host: Any, timeline: str, now: Sequence, places: list[dict[str, Any]], probe: Any = None
) -> dict[str, str]:
    """Sets clips back to placements (same tracks): moves when only the place differs (each clip by
    its own amount: a swap's two groups go back by opposite ones), else all four points. Returns old id
    -> new id for clips placed again to keep their track's order."""
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
        return _move_groups(host, timeline, now, [(ids, d) for d, ids in by_delta.items()], probe)
    host._send(
        "set_items",
        {
            "timeline": timeline,
            "items": [{"id": p["id"], **p["ticks"]} for p in places],
        },
    )
    _check_order(host, timeline, now)
    return {}


# ------------------------------------------------------------------------------- reverting


def _put_back(
    host: Any, timeline: str, seq: Sequence, group: list[dict[str, Any]], probe: Any
) -> tuple[str, dict[str, str]]:
    """Puts a group of clips lifted together back from their file, in one placement. Returns
    ("reverted" | "taken" | "failed: why", old id -> new id).

    A placement always lays down the file's picture and every channel of its sound. When only some of
    them were lifted (the sound under a picture that stayed, or one channel), the rest goes on tracks
    free there (else scratch ones) and is lifted again at once: the clips are placed where they were,
    never moved there, so they take their places in the tracks' lists (see "Premiere's clip order")."""
    first = group[0]
    if first.get("speed"):
        return "failed: it had a speed change; the backup has it", {}
    path = first.get("filePath")
    if not path or not os.path.isfile(path):
        return "failed: its media file isn't there any more", {}
    start, end = int(first["startTicks"]), int(first["endTicks"])
    if any(not seq.free(g["track"][0], g["track"][1], start, end) for g in group):
        return "taken", {}
    source = {"path": path, "name": first["name"], "inTicks": first["inTicks"], "length": end - start}
    parts = [
        {"id": g["itemId"], "kind": g["track"][0], "index": g["track"][1], "channel": g.get("channel", 1)}
        for g in group
    ]
    # Channels of the recording that stayed (the left one, when only the right was lifted) are where the
    # placement lays its other channels, so they're placed again with it.
    lifted = {g["itemId"] for g in group}
    siblings = [
        c
        for c in seq.clips.values()
        if c["kind"] == "audio"
        and c["id"] not in lifted
        and c.get("mediaPath") == path
        and (c["startTicks"], c["endTicks"], c["inTicks"])
        == (first["startTicks"], first["endTicks"], first["inTicks"])
    ]
    try:
        if siblings:
            _refuse_unplaceable(host, timeline, [c["id"] for c in siblings])
            host._send("remove_items", {"timeline": timeline, "ids": [c["id"] for c in siblings]})
            parts += [
                {"id": c["id"], "kind": "audio", "index": c["index"], "channel": seq.channel(c)}
                for c in siblings
            ]
        restored = _place_parts(host, timeline, source, start, parts, probe)
    except HostError as exc:
        return f"failed: {exc}", {}
    if siblings:
        _restore_settings(host, timeline, siblings, restored)
    settings = []
    for record in group:
        item: dict[str, Any] = {"id": restored[record["itemId"]]}
        if not record.get("enabled", True):
            item["disabled"] = True
        if record.get("volumeDb") is not None and record["volumeDb"] != 0:
            item["level"] = gain(record["volumeDb"])
        if len(item) > 1:
            settings.append(item)
    if settings:
        host._send("set_items", {"timeline": timeline, "items": settings})
    stayed = list(
        dict.fromkeys(
            i
            for g in [*group, *siblings]
            for i in (g.get("linkedIds") or [])
            if i in seq.clips and i not in restored
        )
    )
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
REVERTIBLE = (
    "added", "deleted", "enabled", "level", "reshaped", "fade", "duck", "split", "link",
    # Phase 12b-12d, as VibeCut reverts them.
    "speed", "transition", "track", "trackOptions",
    # Phase 15a: Premiere can't remove a caption track from a script, so a revert reports it.
    "captions",
    # Phase 16b.
    "label",
    # Phase 16f.
    "transform",
    # Phase 19c.
    "color",
)  # fmt: skip


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
        elif kind in ("speed", "track", "trackOptions"):
            # Phase 12b and 12d (VibeCut's premiere_timing and premiere_structure).
            from vibecut_agent.nle import premiere_structure, premiere_timing

            if kind == "speed":
                outcome = premiere_timing.revert_speed(host, timeline, seq, change, current)
            elif kind == "track":
                outcome = premiere_timing.revert_track(host, timeline, seq, change)
            else:
                outcome = premiere_structure.revert_track_options(host, timeline, change)
            if outcome == "reverted":
                reverted.append({"kind": kind, "name": label})
            elif outcome == "changed":
                changed_since.append({"name": label, "reason": "it was changed since"})
            else:
                failed.append({"name": label, "reason": "Premiere didn't put it back"})
        elif kind == "captions":
            failed.append(
                {
                    "name": label,
                    "reason": "Premiere's scripting can't remove a caption track; delete it in Premiere",
                }
            )
        elif kind == "split":
            from vibecut_agent.nle import premiere_timing

            outcome = premiere_timing.revert_split(host, timeline, seq, change, current)
            if outcome == "reverted":
                reverted.append({"kind": kind, "name": label})
            elif outcome == "changed":
                changed_since.append({"name": label, "reason": "it was changed since"})
            else:
                failed.append({"name": label, "reason": "Premiere didn't put it back"})
        elif kind in ("fade", "duck", "transition", "transform", "color"):
            from vibecut_agent.nle import premiere_colour, premiere_effects, premiere_transform

            item_id = current(change.get("itemId"))
            if item_id not in seq.clips:
                changed_since.append({"name": label, "reason": "it isn't on the sequence any more"})
                continue
            revert = {
                "fade": premiere_effects.revert_fade,
                "duck": premiere_effects.revert_duck,
                "transition": premiere_effects.revert_transition,
                # Phase 16f.
                "transform": premiere_transform.revert_transform,
                # Phase 19c.
                "color": premiere_colour.revert_color,
            }[kind]
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
                    restored.update(_retrack_back(host, timeline, seq, change, after_ids, probe))
                except HostError as exc:
                    failed.append({"name": label, "reason": str(exc)})
                    continue
                reverted.append({"kind": kind, "name": label})
                continue
            try:
                restored.update(
                    _put(
                        host,
                        timeline,
                        seq,
                        [{**i["before"], "id": current(i["after"]["id"])} for i in items],
                        probe,
                    )
                )
            except HostError as exc:
                failed.append({"name": label, "reason": str(exc)})
                continue
            reverted.append({"kind": kind, "name": label})
        else:
            item_id = current(change.get("itemId"))
            if item_id not in seq.clips:
                changed_since.append({"name": label, "reason": "it isn't on the sequence any more"})
                continue
            clip = seq.clips[item_id]
            after, before = change.get("after"), change.get("before")
            if kind == "label":
                from vibecut_agent.nle.premiere_pool import PREMIERE_LABEL_COLORS, label_name

                was: dict[str, Any] = before if isinstance(before, dict) else {}
                labelled = {"name": clip.get("name", ""), "color": label_name(clip.get("label")) or ""}
                if labelled != after:
                    changed_since.append({"name": label, "reason": "its name or colour was changed since"})
                    continue
                setting: dict[str, Any] = {"id": item_id}
                if was.get("name") != labelled["name"]:
                    setting["name"] = was.get("name") or ""
                if was.get("color") != labelled["color"] and was.get("color") in PREMIERE_LABEL_COLORS:
                    setting["label"] = PREMIERE_LABEL_COLORS.index(was["color"])
                host._send("set_items", {"timeline": timeline, "items": [setting]})
                reverted.append({"kind": kind, "name": label})
                continue
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
