"""OTIO deltas lowered to NLE bridge calls (ORCHESTRATOR_SPEC.md §3.3, §3.4 D; PLAN.md, "Phase 21").

`compile_to_nle_commands` checks a `vibecut.otio.delta.v1` payload against the timeline it was planned on
(a HostTimeline snapshot, as `list_timeline_clips` reads it) and turns it into the ordered bridge calls
that make it: `backup_timeline` first, then `add_clips`, `delete_clips`, `reshape_clip`, `split_clips`,
`set_clip_levels`, `set_clip_fades`, `set_transition` and `duck_clip`, with the arguments nle/edits.py takes.
It replays the operations on a frame-exact model of each track (at the delta's `timeline_fps`), so an
operation is checked against the timeline as the earlier operations leave it. `apply_delta_to_otio` lays
out that same replay's result as an OpenTimelineIO timeline (what the timeline will be once the delta has
run), and `write_otio` saves one; those two need the `orchestrator` extra.

What the bridges can do bounds what a delta can do. They never overwrite and never ripple, so `ripple`,
`INSERT_GAP` and an `OVERWRITE_CLIP` that would cut a clip partway are refused, as is a speed change (a
source and timeline range of different lengths). A clip made by this delta (a split's right piece, a new
clip) has no id until the delta runs, so later operations can't name it. Picture and sound in one
`link_group_id` placing the same media at the same time are placed as one linked clip.

The spec's diagnostic codes are a fixed list, so each problem takes the nearest one:

- NEGATIVE_OR_ZERO_DURATION: a range that is missing, empty or negative, or an operation with nothing to do.
- MISSING_MEDIA_FILE: no media reference, or its file isn't there.
- UNKNOWN_CLIP_ID: no such clip on the timeline (or not on that kind of track, or with no source media).
- SOURCE_OUT_OF_BOUNDS: past the media's ends or its `available_range`, a cut point outside the clip, or a
  value the editor doesn't take (a level, a duck depth, ducking in Resolve).
- TRACK_OVERLAP_COLLISION: clips would overlap, or the operation would ripple other clips.
- RATE_MISMATCH: a timeline range not at the timeline's rate, or a speed change.
- INVALID_TRANSITION_HANDLE: a transition with no clip to go into, or longer than the clips allow.
- STALE_TIMELINE_HASH: the timeline changed (or isn't the one named) since the delta was planned."""

from __future__ import annotations

import hashlib
import json
import math
import os
from collections.abc import Callable
from dataclasses import dataclass, field
from fractions import Fraction
from pathlib import Path
from typing import Any, Literal, TypedDict
from urllib.parse import unquote, urlparse

from vibecut_agent.broll import ffprobe_util
from vibecut_agent.core.timecode_math import exact_rate, rational_to_fraction, snap_rate

Severity = Literal["ERROR", "WARNING"]
MediaDuration = Callable[[str], float | None]

# What the bridges take (nle/premiere_effects.py, premiere_edit.py).
MIN_LEVEL_DB, MAX_LEVEL_DB = -100.0, 30.0
MIN_DUCK_DB, MAX_DUCK_DB = -40.0, -1.0
MIN_RAMP, MAX_RAMP = 0.05, 2.0
DEFAULT_DUCK_DB, DEFAULT_RAMP = -12.0, 0.3
BACKUP_OP_ID = "backup"


class Diagnostic(TypedDict):
    severity: Severity
    code: str
    op_id: str | None
    message: str
    remediation_hint: str


class NleCommand(TypedDict):
    seq: int
    source_op_id: str
    host: str
    command: str
    args: dict[str, Any]


def _number(value: Any) -> Any:
    """A number as one form whoever wrote it: JavaScript's JSON writes 0.0 as 0, Python's as 0.0."""
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        return round(float(value), 6)
    return value


def timeline_hash(snapshot: dict[str, Any]) -> str:
    """SHA-256 of the timeline's edit-relevant state: its name, rate and every clip's id, place and
    source, track by track. Playhead, selection and markers don't change it. Numbers are hashed in one
    form, so the app's reading (through JavaScript) and the editor's own (Python) hash the same."""
    tracks = []
    for track in snapshot.get("tracks", []):
        clips = [
            {
                key: _number(clip.get(key))
                for key in ("id", "start", "end", "sourceIn", "sourceOut", "filePath", "enabled")
            }
            for clip in track.get("clips", [])
        ]
        tracks.append({"type": track.get("type"), "index": _number(track.get("index")), "clips": clips})
    canonical = {"timeline": snapshot.get("timeline"), "fps": _number(snapshot.get("fps")), "tracks": tracks}
    encoded = json.dumps(canonical, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    return hashlib.sha256(encoded.encode("utf-8")).hexdigest()


def media_path_of(target_url: str) -> str:
    """The plain path of a `file:///` URL (percent-encoded or not)."""
    return unquote(urlparse(target_url).path)


@dataclass
class _Clip:
    id: str
    track: tuple[str, int]
    first: int
    last: int
    source_in: float | None
    source_out: float | None
    path: str | None
    linked: list[str] = field(default_factory=list)
    name: str | None = None
    # What SET_AUDIO_GAIN and DUCK_REGION leave on it (levelDb, fadeIn, fadeOut, ducks), for the OTIO.
    effects: dict[str, Any] = field(default_factory=dict)
    # The op that made it, for a clip this delta places or splits off (it has no editor id yet).
    made_by: str | None = None


class _Compiler:
    def __init__(
        self, delta: dict[str, Any], snapshot: dict[str, Any], media_duration: MediaDuration
    ) -> None:
        self.delta = delta
        self.host: str = delta["target_host"]
        self.timeline: str = delta["target_timeline"]
        self.rate: float = delta["timeline_fps"]
        self.frames = exact_rate(self.rate)
        self.media_duration = media_duration
        self._durations: dict[str, float | None] = {}
        self.commands: list[NleCommand] = []
        self.diagnostics: list[Diagnostic] = []
        self.clips: dict[str, _Clip] = {}
        self.link_groups: dict[str, tuple[NleCommand, dict[str, Any]]] = {}
        # (clip id, transition spec as given, total seconds) for each APPLY_TRANSITION that compiles.
        self.transitions: list[tuple[str, dict[str, Any], Fraction]] = []
        self.track_names: dict[tuple[str, int], str] = {}
        # The latest delete_clips call, and the clips linked to what it removes (see `delete`).
        self._last_delete: NleCommand | None = None
        self._last_delete_links: set[str] = set()
        # (clip id, frame) for linked clips a split has already cut there (see `split`).
        self._split_with: set[tuple[str, int]] = set()
        for track in snapshot.get("tracks", []):
            kind = track.get("type")
            if kind not in ("video", "audio"):
                continue
            key = (kind, int(track["index"]))
            if track.get("name"):
                self.track_names[key] = str(track["name"])
            for clip in track.get("clips", []):
                self.clips[str(clip["id"])] = _Clip(
                    id=str(clip["id"]),
                    track=key,
                    first=self._frame(clip["start"]),
                    last=self._frame(clip["end"]),
                    source_in=clip.get("sourceIn"),
                    source_out=clip.get("sourceOut"),
                    path=clip.get("filePath"),
                    linked=[str(i) for i in clip.get("linkedIds") or []],
                    name=clip.get("name"),
                )

    # Helpers.

    def _frame(self, seconds: float) -> int:
        return math.floor(Fraction(seconds) * self.frames + Fraction(1, 2))

    def _seconds(self, frame: int) -> float:
        return round(float(Fraction(frame) / self.frames), 6)

    def _flag(self, severity: Severity, code: str, op_id: str | None, message: str, hint: str) -> None:
        self.diagnostics.append(
            {"severity": severity, "code": code, "op_id": op_id, "message": message, "remediation_hint": hint}
        )

    def _error(self, code: str, op_id: str | None, message: str, hint: str) -> None:
        self._flag("ERROR", code, op_id, message, hint)

    def _emit(self, op_id: str, command: str, args: dict[str, Any]) -> NleCommand:
        entry: NleCommand = {
            "seq": len(self.commands) + 1,
            "source_op_id": op_id,
            "host": self.host,
            "command": command,
            "args": {"timeline": self.timeline, **args},
        }
        self.commands.append(entry)
        return entry

    def _duration_of(self, path: str) -> float | None:
        if path not in self._durations:
            self._durations[path] = self.media_duration(path)
        return self._durations[path]

    def _timeline_range(self, op: dict[str, Any], op_id: str) -> tuple[int, int] | None:
        """The op's timeline_range as [first, last) frames, or None (flagged) when it can't be used."""
        span = op.get("timeline_range")
        if span is None:
            self._error(
                "NEGATIVE_OR_ZERO_DURATION",
                op_id,
                f"{op['op_type']} needs a timeline_range",
                "Give where on the timeline it goes",
            )
            return None
        for part in ("start_time", "duration"):
            if span[part]["rate"] != self.rate:
                self._error(
                    "RATE_MISMATCH",
                    op_id,
                    f"timeline_range.{part} is at {span[part]['rate']:g} fps; the timeline is {self.rate:g}",
                    f"Give timeline times at {self.rate:g} fps",
                )
                return None
        first, length = span["start_time"]["value"], span["duration"]["value"]
        if first != int(first) or length != int(length):
            self._error(
                "RATE_MISMATCH",
                op_id,
                "timeline_range isn't on whole frames",
                "Snap timeline times to frames",
            )
            return None
        if first < 0 or length <= 0:
            self._error(
                "NEGATIVE_OR_ZERO_DURATION",
                op_id,
                "timeline_range has no length (or starts before 0)",
                "Give a positive duration from 0 or later",
            )
            return None
        return int(first), int(first + length)

    def _source_range(
        self, op: dict[str, Any], op_id: str, path: str | None
    ) -> tuple[Fraction, Fraction] | None:
        """The op's source_range as exact (in, out) seconds, checked against the media's ends."""
        span = op.get("source_range")
        if span is None:
            self._error(
                "NEGATIVE_OR_ZERO_DURATION",
                op_id,
                f"{op['op_type']} needs a source_range",
                "Give the in point and duration in the source media",
            )
            return None
        start = rational_to_fraction(span["start_time"])
        length = rational_to_fraction(span["duration"])
        if start < 0 or length <= 0:
            self._error(
                "NEGATIVE_OR_ZERO_DURATION",
                op_id,
                "source_range has no length (or starts before 0)",
                "Give a positive duration from 0 or later",
            )
            return None
        end = start + length
        available = (op.get("media_reference") or {}).get("available_range")
        if available is not None:
            low = rational_to_fraction(available["start_time"])
            high = low + rational_to_fraction(available["duration"])
            if start < low or end > high:
                self._error(
                    "SOURCE_OUT_OF_BOUNDS",
                    op_id,
                    f"source_range {float(start):.3f}-{float(end):.3f} s is outside the media's available_range "
                    f"{float(low):.3f}-{float(high):.3f} s",
                    "Keep the source range inside the media",
                )
                return None
        if path is not None:
            duration = self._duration_of(path)
            # Half a frame of slack: containers round their duration.
            if duration is not None and float(end) > duration + 0.5 / float(self.frames):
                self._error(
                    "SOURCE_OUT_OF_BOUNDS",
                    op_id,
                    f"source_range ends at {float(end):.3f} s; {os.path.basename(path)} is {duration:.3f} s long",
                    "End the source range at or before the media's end",
                )
                return None
        return start, end

    def _clip(self, op: dict[str, Any], op_id: str, kind: str | None = None) -> _Clip | None:
        clip_id = op.get("clip_id")
        if not clip_id:
            self._error(
                "UNKNOWN_CLIP_ID",
                op_id,
                f"{op['op_type']} needs a clip_id",
                "Name the timeline clip it changes",
            )
            return None
        clip = self.clips.get(str(clip_id))
        if clip is None:
            self._error(
                "UNKNOWN_CLIP_ID",
                op_id,
                f"There's no clip {clip_id} on {self.timeline} (or this delta removed it)",
                "Read the timeline's clips again and use their ids; clips this delta makes can't be named yet",
            )
            return None
        if kind is not None and clip.track[0] != kind:
            self._error(
                "UNKNOWN_CLIP_ID",
                op_id,
                f"Clip {clip_id} is on a {clip.track[0]} track, not {kind}",
                "Choose a clip on the right kind of track",
            )
            return None
        return clip

    def _collisions(self, track: tuple[str, int], first: int, last: int, ignore: set[str]) -> list[str]:
        return [
            c.id
            for c in self.clips.values()
            if c.track == track and c.id not in ignore and c.first < last and first < c.last
        ]

    def _no_ripple(self, op: dict[str, Any], op_id: str) -> bool:
        if op.get("ripple"):
            self._error(
                "TRACK_OVERLAP_COLLISION",
                op_id,
                "Ripple edits would move the clips after it, which the editor bridges don't do",
                "Set ripple to false and move later clips with MOVE_CLIP if needed",
            )
            return False
        return True

    @staticmethod
    def _track(op: dict[str, Any]) -> tuple[str, int]:
        selector = op["track_Selector"]
        return selector["kind"].lower(), int(selector["index"])

    # Operations.

    def place(self, op: dict[str, Any], op_id: str) -> None:
        """INSERT_CLIP and OVERWRITE_CLIP."""
        if not self._no_ripple(op, op_id):
            return
        reference = op.get("media_reference")
        if not reference:
            self._error(
                "MISSING_MEDIA_FILE",
                op_id,
                f"{op['op_type']} needs a media_reference",
                "Give the media file as a file:/// URL",
            )
            return
        path = media_path_of(reference["target_url"])
        if not os.path.isfile(path):
            self._error(
                "MISSING_MEDIA_FILE",
                op_id,
                f"{path} isn't there",
                "Check the path, or that its drive is attached",
            )
            return
        span = self._timeline_range(op, op_id)
        source = self._source_range(op, op_id, path)
        if span is None or source is None:
            return
        first, last = span
        timeline_length = Fraction(last - first) / self.frames
        if abs((source[1] - source[0]) - timeline_length) > Fraction(1, 2) / self.frames:
            self._error(
                "RATE_MISMATCH",
                op_id,
                f"The source range is {float(source[1] - source[0]):.3f} s but the timeline range is "
                f"{float(timeline_length):.3f} s; that would be a speed change",
                "Make both ranges the same length",
            )
            return
        track = self._track(op)
        group = op.get("link_group_id")
        partner = self.link_groups.get(group) if group else None
        busy = self._collisions(track, first, last, set())
        if busy and op["op_type"] == "OVERWRITE_CLIP":
            partial = [c for c in busy if not (first <= self.clips[c].first and self.clips[c].last <= last)]
            if partial:
                self._error(
                    "TRACK_OVERLAP_COLLISION",
                    op_id,
                    f"Overwriting would cut clip(s) {', '.join(partial)} partway",
                    "Split those clips at the range's edges in an earlier delta, or overwrite whole clips",
                )
                return
            self._emit(op_id, "delete_clips", {"itemIds": busy, "withLinked": False})
            for clip_id in busy:
                del self.clips[clip_id]
        elif busy:
            self._error(
                "TRACK_OVERLAP_COLLISION",
                op_id,
                f"{track[0].title()} {track[1]} already has clip(s) {', '.join(busy)} there",
                "Place it on a free track or time, or use OVERWRITE_CLIP to replace whole clips",
            )
            return
        side = "picture" if track[0] == "video" else "sound"
        track_arg = "videoTrack" if track[0] == "video" else "audioTrack"
        gain = (op.get("audio_params") or {}).get("gain_db")
        if partner is not None:
            _, clip = partner
            same = (
                clip["path"] == path
                and clip["sourceIn"] == round(float(source[0]), 6)
                and clip["at"] == self._seconds(first)
                and not clip.get(side)
            )
            if not same:
                self._error(
                    "SOURCE_OUT_OF_BOUNDS",
                    op_id,
                    f"link group {group}'s clips must place the same media at the same time, one picture and one sound",
                    "Give linked picture and sound the same media, source and timeline ranges",
                )
                return
            clip[side] = True
            clip[track_arg] = track[1]
            if gain is not None and track[0] == "audio":
                clip["volumeDb"] = gain
        else:
            clip = {
                "path": path,
                "sourceIn": round(float(source[0]), 6),
                "sourceOut": round(float(source[1]), 6),
                "at": self._seconds(first),
                track_arg: track[1],
                "picture": side == "picture",
                "sound": side == "sound",
            }
            if gain is not None and track[0] == "audio":
                clip["volumeDb"] = gain
            command = self._emit(op_id, "add_clips", {"clips": [clip]})
            if group:
                self.link_groups[group] = (command, clip)
        made = _Clip(
            f"{op_id}:new",
            track,
            first,
            last,
            float(source[0]),
            float(source[1]),
            path,
            name=os.path.basename(path),
            made_by=op_id,
        )
        if gain is not None and track[0] == "audio":
            made.effects["levelDb"] = gain
        self.clips[made.id] = made

    def trim(self, op: dict[str, Any], op_id: str) -> None:
        if not self._no_ripple(op, op_id):
            return
        clip = self._clip(op, op_id)
        if clip is None:
            return
        if clip.source_in is None or clip.source_out is None or clip.path is None:
            self._error(
                "UNKNOWN_CLIP_ID",
                op_id,
                f"Clip {clip.id} has no source media to trim",
                "Trim a clip of a media file",
            )
            return
        source = self._source_range(op, op_id, clip.path)
        if source is None:
            return
        new_in, new_out = float(source[0]), float(source[1])
        # Within half a frame is the same point: an editor rounds what it reports.
        half = 0.5 / float(self.frames)
        moves_in = abs(new_in - clip.source_in) >= half
        moves_out = abs(new_out - clip.source_out) >= half
        new_in = new_in if moves_in else clip.source_in
        new_out = new_out if moves_out else clip.source_out
        # Trimming the start moves the clip's start on the timeline with it; its end stays. The editors trim
        # the clip's linked picture or sound with it (reshape_clip), so they move the same way.
        shift_first = self._frame(new_in - clip.source_in) if moves_in else 0
        shift_last = self._frame(new_out - clip.source_out) if moves_out else 0
        first, last = clip.first + shift_first, clip.last + shift_last
        if first < 0 or last <= first:
            self._error(
                "NEGATIVE_OR_ZERO_DURATION",
                op_id,
                f"The trim leaves clip {clip.id} with no length",
                "Keep the clip's out after its in",
            )
            return
        group = [clip, *(self.clips[i] for i in clip.linked if i in self.clips)]
        ignore = {member.id for member in group}
        for member in group:
            busy = self._collisions(
                member.track, member.first + shift_first, member.last + shift_last, ignore
            )
            if busy:
                self._error(
                    "TRACK_OVERLAP_COLLISION",
                    op_id,
                    f"Extending clip {member.id} would run into clip(s) {', '.join(busy)}",
                    "Make room first, or trim less",
                )
                return
        if moves_in:
            self._emit(op_id, "reshape_clip", {"itemId": clip.id, "sourceIn": round(new_in, 6)})
        if moves_out:
            self._emit(op_id, "reshape_clip", {"itemId": clip.id, "sourceOut": round(new_out, 6)})
        if not (moves_in or moves_out):
            self._flag(
                "WARNING",
                "NEGATIVE_OR_ZERO_DURATION",
                op_id,
                f"Clip {clip.id} already has that source range (a trim of a linked clip trims it too)",
                "Leave this operation out",
            )
            return
        delta_in, delta_out = new_in - clip.source_in, new_out - clip.source_out
        for member in group:
            member.first += shift_first
            member.last += shift_last
            if member.source_in is not None:
                member.source_in = round(member.source_in + delta_in, 6)
            if member.source_out is not None:
                member.source_out = round(member.source_out + delta_out, 6)
        clip.source_in, clip.source_out = new_in, new_out

    def split(self, op: dict[str, Any], op_id: str) -> None:
        clip = self._clip(op, op_id)
        span = op.get("timeline_range")
        if clip is None:
            return
        if span is None:
            self._error(
                "NEGATIVE_OR_ZERO_DURATION",
                op_id,
                "SPLIT_CLIP needs a timeline_range (its start is the cut)",
                "Give the cut point as timeline_range.start_time",
            )
            return
        if span["start_time"]["rate"] != self.rate:
            self._error(
                "RATE_MISMATCH",
                op_id,
                f"The cut point isn't at the timeline's {self.rate:g} fps",
                f"Give it at {self.rate:g} fps",
            )
            return
        cut = int(span["start_time"]["value"])
        if (clip.id, cut) in self._split_with:
            self._flag(
                "WARNING",
                "NEGATIVE_OR_ZERO_DURATION",
                op_id,
                f"Clip {clip.id} is already cut at {self._seconds(cut):g} s: splitting a clip splits its linked "
                "picture or sound too",
                "Leave this operation out",
            )
            return
        if not clip.first < cut < clip.last:
            self._error(
                "SOURCE_OUT_OF_BOUNDS",
                op_id,
                f"The cut point isn't inside clip {clip.id}",
                "Cut between the clip's first and last frames",
            )
            return
        self._emit(op_id, "split_clips", {"itemIds": [clip.id], "time": self._seconds(cut)})
        # The editors cut the clip's linked picture or sound too, where it runs across the cut, and link
        # the right pieces to each other.
        group = [clip, *(self.clips[i] for i in clip.linked if i in self.clips)]
        group = [member for member in group if member.first < cut < member.last]
        rights = [self._split_piece(member, cut, op_id) for member in group]
        for right in rights:
            right.linked = [other.id for other in rights if other is not right]
            self.clips[right.id] = right
        self._split_with.update((member.id, cut) for member in group[1:])

    def _split_piece(self, clip: _Clip, cut: int, op_id: str) -> _Clip:
        """Cuts `clip` at frame `cut`: it keeps the left piece; the right one is returned."""
        # The cut divides the source too: the left piece now ends where the right one starts.
        at = None
        if clip.source_in is not None:
            at = round(float(Fraction(clip.source_in) + Fraction(cut - clip.first) / self.frames), 6)
        right_id = f"{clip.id}:right"
        if right_id in self.clips:
            right_id = f"{clip.id}:right@{cut}"
        right = _Clip(
            right_id,
            clip.track,
            cut,
            clip.last,
            at,
            clip.source_out,
            clip.path,
            name=clip.name,
            effects=dict(clip.effects),
            made_by=op_id,
        )
        clip.last = cut
        if at is not None:
            clip.source_out = at
        return right

    def delete(self, op: dict[str, Any], op_id: str) -> None:
        if not self._no_ripple(op, op_id):
            return
        clip = self._clip(op, op_id)
        if clip is None:
            return
        # A clip linked to the ones the delete just before removed (its picture or sound) goes in the same
        # call: the editor records clips deleted together, and Revert links exactly those again. Unlinked
        # clips get their own call, or Revert would link them to each other.
        last = self.commands[-1] if self.commands else None
        if last is not None and last is self._last_delete and clip.id in self._last_delete_links:
            last["args"]["itemIds"].append(clip.id)
            last["source_op_id"] = f"{last['source_op_id']},{op_id}"
        else:
            self._last_delete = self._emit(op_id, "delete_clips", {"itemIds": [clip.id], "withLinked": False})
            self._last_delete_links = set()
        self._last_delete_links |= set(clip.linked)
        del self.clips[clip.id]

    def move(self, op: dict[str, Any], op_id: str) -> None:
        clip = self._clip(op, op_id)
        span = self._timeline_range(op, op_id) if clip is not None else None
        if clip is None or span is None:
            return
        track = self._track(op)
        if track[0] != clip.track[0]:
            self._error(
                "UNKNOWN_CLIP_ID",
                op_id,
                f"Clip {clip.id} is on a {clip.track[0]} track, not {track[0]}",
                "Move it to a track of its own kind",
            )
            return
        shift = span[0] - clip.first
        # Its linked partners move with it, on their own tracks.
        moving = [clip] + [self.clips[i] for i in clip.linked if i in self.clips]
        ignore = {c.id for c in moving}
        for member in moving:
            target = track if member is clip else member.track
            busy = self._collisions(target, member.first + shift, member.last + shift, ignore)
            if busy:
                self._error(
                    "TRACK_OVERLAP_COLLISION",
                    op_id,
                    f"Moving clip {member.id} would land on clip(s) {', '.join(busy)}",
                    "Move it to a free place, or clear the place first",
                )
                return
        args: dict[str, Any] = {"itemId": clip.id, "start": self._seconds(span[0])}
        if track != clip.track:
            args["videoTrack" if track[0] == "video" else "audioTrack"] = track[1]
        self._emit(op_id, "reshape_clip", args)
        for member in moving:
            member.first += shift
            member.last += shift
        clip.track = track

    def transition(self, op: dict[str, Any], op_id: str) -> None:
        clip = self._clip(op, op_id)
        spec = op.get("transition")
        if clip is None:
            return
        if not spec:
            self._error(
                "INVALID_TRANSITION_HANDLE",
                op_id,
                "APPLY_TRANSITION needs a transition",
                "Give its type and offsets",
            )
            return
        kind = {"SMPTE_Dissolve": "dissolve", "Dip_To_Black": "dipToBlack", "Audio_Crossfade": "dissolve"}[
            spec["transition_type"]
        ]
        if spec["transition_type"] == "Dip_To_Black" and clip.track[0] != "video":
            self._error(
                "INVALID_TRANSITION_HANDLE",
                op_id,
                "A dip to black is for picture",
                "Use Audio_Crossfade on sound",
            )
            return
        if spec["transition_type"] == "Audio_Crossfade" and clip.track[0] != "audio":
            self._error(
                "INVALID_TRANSITION_HANDLE",
                op_id,
                "An audio crossfade is for sound",
                "Use SMPTE_Dissolve on picture",
            )
            return
        following = [
            c
            for c in self.clips.values()
            if c.track == clip.track and c.first == clip.last and c.id != clip.id
        ]
        if not following:
            self._error(
                "INVALID_TRANSITION_HANDLE",
                op_id,
                f"No clip starts where clip {clip.id} ends on its track, so there's no cut to put it on",
                "Give the clip before a cut",
            )
            return
        before = rational_to_fraction(spec["in_offset"])
        after = rational_to_fraction(spec["out_offset"])
        if before < 0 or after < 0 or before + after <= 0:
            self._error(
                "INVALID_TRANSITION_HANDLE", op_id, "The transition has no length", "Give positive offsets"
            )
            return
        shortest = Fraction(min(clip.last - clip.first, following[0].last - following[0].first)) / self.frames
        if max(before, after) > shortest / 2:
            self._error(
                "INVALID_TRANSITION_HANDLE",
                op_id,
                f"Each side may be at most half the shorter clip ({float(shortest / 2):.3f} s)",
                "Shorten the transition",
            )
            return
        if before != after:
            self._flag(
                "WARNING",
                "INVALID_TRANSITION_HANDLE",
                op_id,
                "The editors centre transitions on the cut; it will be centred",
                "Give equal in and out offsets",
            )
        self._emit(
            op_id,
            "set_transition",
            {"itemId": clip.id, "kind": kind, "seconds": round(float(before + after), 6)},
        )
        self.transitions.append((clip.id, spec, before + after))

    def gain(self, op: dict[str, Any], op_id: str) -> None:
        clip = self._clip(op, op_id)
        if clip is None:
            return
        params = op.get("audio_params") or {}
        changes = 0
        if "gain_db" in params:
            level = params["gain_db"]
            if not MIN_LEVEL_DB <= level <= MAX_LEVEL_DB:
                self._error(
                    "SOURCE_OUT_OF_BOUNDS",
                    op_id,
                    f"gain_db must be {MIN_LEVEL_DB:g} to {MAX_LEVEL_DB:g}",
                    "Choose a level in range",
                )
                return
            self._emit(op_id, "set_clip_levels", {"levels": [{"itemId": clip.id, "volumeDb": level}]})
            clip.effects["levelDb"] = level
            changes += 1
        for key, which in (("fade_in_seconds", "fadeIn"), ("fade_out_seconds", "fadeOut")):
            if key in params:
                self._emit(
                    op_id, "set_clip_fades", {"itemIds": [clip.id], "which": which, "seconds": params[key]}
                )
                clip.effects[which] = params[key]
                changes += 1
        if not changes:
            self._error(
                "NEGATIVE_OR_ZERO_DURATION",
                op_id,
                "SET_AUDIO_GAIN has nothing to change",
                "Give audio_params.gain_db, fade_in_seconds or fade_out_seconds",
            )

    def duck(self, op: dict[str, Any], op_id: str) -> None:
        if self.host != "premiere":
            self._error(
                "SOURCE_OUT_OF_BOUNDS",
                op_id,
                "Resolve can't duck a clip from a script",
                "Lower the music with SET_AUDIO_GAIN on split pieces instead",
            )
            return
        clip = self._clip(op, op_id, "audio")
        span = self._timeline_range(op, op_id) if clip is not None else None
        if clip is None or span is None:
            return
        params = op.get("audio_params") or {}
        depth = params.get("duck_Floor_db", DEFAULT_DUCK_DB)
        ramp = params.get("fade_in_seconds", DEFAULT_RAMP)
        if not MIN_DUCK_DB <= depth <= MAX_DUCK_DB:
            self._error(
                "SOURCE_OUT_OF_BOUNDS",
                op_id,
                f"duck_Floor_db must be {MIN_DUCK_DB:g} to {MAX_DUCK_DB:g} dB here",
                "Choose a depth in range",
            )
            return
        if not MIN_RAMP <= ramp <= MAX_RAMP:
            self._error(
                "SOURCE_OUT_OF_BOUNDS",
                op_id,
                f"The ramp (fade_in_seconds) must be {MIN_RAMP:g} to {MAX_RAMP:g} s",
                "Choose a ramp in range",
            )
            return
        first, last = max(span[0], clip.first), min(span[1], clip.last)
        if last <= first:
            self._error(
                "SOURCE_OUT_OF_BOUNDS",
                op_id,
                f"The region doesn't overlap clip {clip.id}",
                "Duck where the clip plays",
            )
            return
        spans = [{"start": self._seconds(first), "end": self._seconds(last)}]
        self._emit(
            op_id, "duck_clip", {"itemId": clip.id, "spans": spans, "duckDb": depth, "rampSeconds": ramp}
        )
        clip.effects.setdefault("ducks", []).append({**spans[0], "duckDb": depth, "rampSeconds": ramp})

    def gap(self, op: dict[str, Any], op_id: str) -> None:
        self._error(
            "TRACK_OVERLAP_COLLISION",
            op_id,
            "INSERT_GAP pushes later clips along, which the editor bridges don't do",
            "Move the later clips with MOVE_CLIP instead",
        )

    def run(self, snapshot: dict[str, Any]) -> None:
        self._emit(BACKUP_OP_ID, "backup_timeline", {})
        if snapshot.get("timeline") not in (None, self.timeline):
            self._error(
                "STALE_TIMELINE_HASH",
                None,
                f"The delta is for {self.timeline} but the snapshot is of {snapshot.get('timeline')}",
                "Plan against the open timeline",
            )
        fps = snapshot.get("fps")
        if isinstance(fps, (int, float)):
            try:
                actual = snap_rate(float(fps))
            except ValueError:
                actual = None
            if actual != self.rate:
                self._error(
                    "RATE_MISMATCH",
                    None,
                    f"The delta's timeline_fps is {self.rate:g} but {self.timeline} runs at {fps:g}",
                    "Give the timeline's own rate",
                )
        handlers: dict[str, Callable[[dict[str, Any], str], None]] = {
            "INSERT_CLIP": self.place,
            "OVERWRITE_CLIP": self.place,
            "TRIM_CLIP": self.trim,
            "SPLIT_CLIP": self.split,
            "DELETE_CLIP": self.delete,
            "MOVE_CLIP": self.move,
            "INSERT_GAP": self.gap,
            "APPLY_TRANSITION": self.transition,
            "SET_AUDIO_GAIN": self.gain,
            "DUCK_REGION": self.duck,
        }
        seen: set[str] = set()
        for op in self.delta["operations"]:
            op_id = op["op_id"]
            if op_id in seen:
                self._flag(
                    "WARNING",
                    "UNKNOWN_CLIP_ID",
                    op_id,
                    f"op_id {op_id} is used twice",
                    "Give each operation its own op_id",
                )
            seen.add(op_id)
            handlers[op["op_type"]](op, op_id)


def compile_to_nle_commands(
    delta: dict[str, Any],
    snapshot: dict[str, Any],
    media_duration: MediaDuration = ffprobe_util.probe_duration_seconds,
) -> tuple[list[NleCommand], list[Diagnostic]]:
    """(the bridge calls, the diagnostics) for a schema-valid delta on this timeline snapshot. The calls are
    only usable when no diagnostic is an ERROR."""
    compiler = _Compiler(delta, snapshot, media_duration)
    compiler.run(snapshot)
    return compiler.commands, compiler.diagnostics


class DeltaRejected(ValueError):
    """A delta with ERROR diagnostics, which can't be applied; `.diagnostics` has them all."""

    def __init__(self, diagnostics: list[Diagnostic]) -> None:
        self.diagnostics = diagnostics
        errors = [d for d in diagnostics if d["severity"] == "ERROR"]
        super().__init__("; ".join(f"{d['code']}: {d['message']}" for d in errors))


def apply_delta_to_otio(
    delta: dict[str, Any],
    snapshot: dict[str, Any],
    media_duration: MediaDuration = ffprobe_util.probe_duration_seconds,
) -> Any:
    """The timeline as the delta leaves it, as an `opentimelineio.schema.Timeline`: the same replay as
    `compile_to_nle_commands`, its result laid out as OTIO tracks (gaps between clips, transitions on the
    cuts they were applied to). Each clip's `metadata["vibecut"]` keeps its editor id (None for a clip
    this delta makes, with `madeBy` naming the op), its linked ids and the levels, fades and ducks the
    delta set. Raises DeltaRejected for a delta with errors. Needs the `orchestrator` extra."""
    import opentimelineio as otio

    compiler = _Compiler(delta, snapshot, media_duration)
    compiler.run(snapshot)
    if any(d["severity"] == "ERROR" for d in compiler.diagnostics):
        raise DeltaRejected(compiler.diagnostics)

    rate = float(compiler.frames)

    def frames(count: int | Fraction) -> Any:
        return otio.opentime.RationalTime(float(count), rate)

    timeline = otio.schema.Timeline(name=compiler.timeline, global_start_time=frames(0))
    timeline.metadata["vibecut"] = {
        "deltaId": delta["delta_id"],
        "host": compiler.host,
        "basedOnTimelineHash": timeline_hash(snapshot),
    }
    transitions = {clip_id: (spec, seconds) for clip_id, spec, seconds in compiler.transitions}
    keys = set(compiler.track_names) | {clip.track for clip in compiler.clips.values()}
    for kind, index in sorted(keys, key=lambda key: (key[0] != "video", key[1])):
        track = otio.schema.Track(
            name=compiler.track_names.get((kind, index), f"{kind[0].upper()}{index}"),
            kind=otio.schema.TrackKind.Video if kind == "video" else otio.schema.TrackKind.Audio,
        )
        placed = sorted(
            (c for c in compiler.clips.values() if c.track == (kind, index)), key=lambda c: c.first
        )
        cursor = 0
        pending: Any = None
        for clip in placed:
            if clip.first > cursor:
                track.append(
                    otio.schema.Gap(
                        source_range=otio.opentime.TimeRange(frames(0), frames(clip.first - cursor))
                    )
                )
                pending = None
            if pending is not None:
                track.append(pending)
            source_start = (
                Fraction(clip.source_in) * compiler.frames if clip.source_in is not None else Fraction(0)
            )
            reference = (
                otio.schema.ExternalReference(target_url=Path(clip.path).as_uri())
                if clip.path
                else otio.schema.MissingReference()
            )
            item = otio.schema.Clip(
                name=clip.name or clip.id,
                media_reference=reference,
                source_range=otio.opentime.TimeRange(frames(source_start), frames(clip.last - clip.first)),
            )
            item.metadata["vibecut"] = {
                "id": None if clip.made_by else clip.id,
                "madeBy": clip.made_by,
                "linkedIds": list(clip.linked),
                **clip.effects,
            }
            track.append(item)
            cursor = clip.last
            pending = None
            if clip.id in transitions:
                spec, seconds = transitions[clip.id]
                # The editors centre a transition on the cut, so the OTIO does too.
                half = seconds / 2 * compiler.frames
                pending = otio.schema.Transition(
                    name=spec["transition_type"],
                    transition_type=(
                        otio.schema.TransitionTypes.SMPTE_Dissolve
                        if spec["transition_type"] == "SMPTE_Dissolve"
                        else spec["transition_type"]
                    ),
                    in_offset=frames(half),
                    out_offset=frames(half),
                )
        timeline.tracks.append(track)
    return timeline


def write_otio(timeline: Any, directory: str | os.PathLike[str], name: str) -> Path:
    """Writes the OTIO timeline to `<directory>/<name>.otio` atomically (a temporary file renamed into
    place) and returns its path."""
    import opentimelineio as otio

    folder = Path(directory)
    folder.mkdir(parents=True, exist_ok=True)
    target = folder / f"{name}.otio"
    temporary = folder / f".{name}.otio.{os.getpid()}.tmp"
    try:
        temporary.write_text(otio.adapters.write_to_string(timeline, "otio_json"), encoding="utf-8")
        os.replace(temporary, target)
    finally:
        temporary.unlink(missing_ok=True)
    return target
