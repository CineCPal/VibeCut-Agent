"""Builds a new Premiere sequence from the agent's draft of one (PLAN.md, "Phase 6b"), ported from VibeCut's
host-premiere/premiere_rebuild.py (its "Connect page, phase 4b").

Cuts, rearrangements and placed B-roll are made in a draft on the Connect page (src/lib/connect/hostDraft.ts),
which reaches Premiere as a whole new sequence: VibeCut sends the tracks (the same shape as
rough-cut-studio's `export` command), this writes Premiere XML with rough-cut-studio's own
`build_premiere_xml_timeline` (15/15 in the round-trip check; Premiere's OTIO import drops levels and
links), and the panel imports it into a "VibeCut" bin, names the new sequence and opens it. Markers are
added afterwards. The connected sequence is never changed.

Each source is probed the way `export` probes it (its picture size, its sound's channels and rate, and
its own start timecode), so the XML is the one VibeCut's File > Export would write for the same cut.
"""

from __future__ import annotations

import contextlib
import math
import os
import secrets
from pathlib import Path
from typing import Any

from vibecut_agent.nle.interchange import xml_builder
from vibecut_agent.nle.interchange.time_remap import TimeMapError, parse_time_map
from vibecut_agent.nle.premiere import PREMIERE_MARKER_COLORS, HostError, frame_rate, seconds

MAX_CLIPS = 5000
MAX_NAME = 200
MAX_MARKERS = 500
BIN_NAME = "VibeCut"
# Premiere imports a long sequence's XML in one blocking call; the Connect page waits 180 s.
IMPORT_TIMEOUT_S = 170.0


def _number(value: Any, field: str, minimum: float | None = None) -> float:
    if not isinstance(value, (int, float)) or isinstance(value, bool) or not math.isfinite(value):
        raise HostError(f"{field} must be a number")
    if minimum is not None and value < minimum:
        raise HostError(f"{field} must be at least {minimum}")
    return float(value)


def _fades_and_transition(c: dict[str, Any], clip: dict[str, Any]) -> None:
    """A pulled timeline's fades and the transition at a clip's end, checked as rough-cut-studio's
    `export` checks them. Conveniences: a malformed one is dropped rather than refusing the rebuild."""
    for key, out_key in (
        ("fadeInSeconds", "fade_in_seconds"),
        ("fadeOutSeconds", "fade_out_seconds"),
    ):
        value = c.get(key)
        if isinstance(value, (int, float)) and not isinstance(value, bool) and value > 0:
            clip[out_key] = float(value)
    transition = c.get("transitionOut")
    if isinstance(transition, dict) and transition.get("kind") in (
        "dissolve",
        "dipToBlack",
    ):
        seconds = transition.get("seconds")
        if isinstance(seconds, (int, float)) and not isinstance(seconds, bool) and seconds > 0:
            clip["transition_out"] = {
                "kind": transition["kind"],
                "seconds": float(seconds),
            }


def validate_tracks(raw: Any) -> list[dict[str, Any]]:
    """The request's tracks (camelCase, as rough-cut-studio's `export` takes them) in the builder's
    snake_case form. Every source must be an absolute path to a file that exists."""
    if not isinstance(raw, list) or not raw:
        raise HostError("tracks must be a non-empty list")
    tracks, total = [], 0
    for i, track in enumerate(raw):
        if not isinstance(track, dict) or track.get("type") not in ("video", "audio"):
            raise HostError(f'tracks[{i}] must be {{"type": "video" | "audio", "clips": [...]}}')
        clips_raw = track.get("clips")
        if not isinstance(clips_raw, list):
            raise HostError(f"tracks[{i}].clips must be a list")
        total += len(clips_raw)
        if total > MAX_CLIPS:
            raise HostError(f"At most {MAX_CLIPS} clips")
        clips = []
        for j, c in enumerate(clips_raw):
            where = f"tracks[{i}].clips[{j}]"
            if not isinstance(c, dict):
                raise HostError(f"{where} must be an object")
            path = c.get("sourcePath")
            if not isinstance(path, str) or not os.path.isabs(path) or not os.path.isfile(path):
                raise HostError(f"{where}.sourcePath is not a file on this computer: {path!r}")
            source_in = _number(c.get("sourceInSeconds"), f"{where}.sourceInSeconds", 0)
            source_out = _number(c.get("sourceOutSeconds"), f"{where}.sourceOutSeconds")
            if source_out <= source_in:
                raise HostError(f"{where} must end after it starts")
            clip: dict[str, Any] = {
                "source_path": path,
                "source_name": c["sourceName"]
                if isinstance(c.get("sourceName"), str)
                else os.path.basename(path),
                "start_time_seconds": _number(c.get("startTimeSeconds"), f"{where}.startTimeSeconds", 0),
                "source_in_seconds": source_in,
                "source_out_seconds": source_out,
                "has_audio": c.get("hasAudio") is True,
                "volume": _number(c.get("volume", 1.0), f"{where}.volume", 0),
            }
            if c.get("enabled") is False:
                clip["enabled"] = False
            _fades_and_transition(c, clip)
            if isinstance(c.get("linkGroup"), str) and c["linkGroup"]:
                clip["link_group"] = c["linkGroup"][:200]
            channels = c.get("audioChannels")
            if channels is not None:
                if (
                    not isinstance(channels, list)
                    or not all(
                        isinstance(ch, int) and not isinstance(ch, bool) and 1 <= ch <= 64 for ch in channels
                    )
                    or not channels
                ):
                    raise HostError(f"{where}.audioChannels must be channel numbers from 1")
                clip["audio_channels"] = sorted(set(channels))
            if c.get("timeMap") is not None:
                try:
                    clip["time_map"] = parse_time_map(c["timeMap"], source_in, source_out)
                except TimeMapError as exc:
                    raise HostError(f"{where}.timeMap {exc}") from exc
            clips.append(clip)
        tracks.append({"type": track["type"], "clips": clips})
    if total == 0:
        raise HostError("There is nothing to put on the new sequence")
    return tracks


def refuse_sound_on_picture(tracks: list[dict[str, Any]], sources: dict[str, Any]) -> None:
    """Premiere imports an XML with a sound-only file on a video track as nothing at all, and says
    nothing (found live, 2026-10-06: a Story Editor draft cut from WAV transcripts). Refuse it here, by
    name, instead."""
    for track in tracks:
        if track["type"] != "video":
            continue
        for clip in track["clips"]:
            info = sources.get(clip["source_path"]) or {}
            if info.get("has_video") is False:
                raise HostError(
                    f"{os.path.basename(clip['source_path'])} is sound only, but the draft puts it on a picture "
                    "track, which Premiere can't import. The connected sequence is unchanged"
                )


def unique_name(wanted: str, taken: set[str]) -> str:
    if wanted not in taken:
        return wanted
    n = 2
    while f"{wanted} {n}" in taken:
        n += 1
    return f"{wanted} {n}"


def default_name(original: str, taken: set[str]) -> str:
    """ "Interview (VibeCut 1)", then 2, 3 ...; a rebuild of a rebuild counts on from its own base."""
    base = original
    if base.endswith(")") and " (VibeCut " in base:
        base = base[: base.rindex(" (VibeCut ")]
    n = 1
    while f"{base} (VibeCut {n})" in taken:
        n += 1
    return f"{base} (VibeCut {n})"


class Probe:
    """ffprobe, as rough-cut-studio's `export` uses it (vibecut_agent.broll.ffprobe_util). Tests pass a fake."""

    def video(self, path: str) -> dict | None:
        from vibecut_agent.broll.ffprobe_util import probe_video_dimensions

        return probe_video_dimensions(path)

    def audio(self, path: str) -> dict | None:
        from vibecut_agent.broll.ffprobe_util import probe_audio_format

        return probe_audio_format(path)

    def timecode(self, path: str) -> dict | None:
        from vibecut_agent.broll.ffprobe_util import probe_start_timecode

        return probe_start_timecode(path)


def source_info(tracks: list[dict[str, Any]], probe: Any) -> tuple[dict[str, dict], list[str]]:
    """Each source's picture, sound and start timecode, in the builder's `source_info` form (as
    rough-cut-studio's `_validate_export_sources` and `_add_source_timecodes` make it). Returns it and
    the files whose timecode couldn't be read."""
    info: dict[str, dict] = {}
    unreadable: list[str] = []
    for path in dict.fromkeys(c["source_path"] for t in tracks for c in t["clips"]):
        entry: dict[str, Any] = {}
        video = probe.video(path)
        entry["has_video"] = video is not None
        if video:
            entry.update({k: video[k] for k in ("width", "height", "par_num", "par_den") if video.get(k)})
        audio = probe.audio(path)
        if audio and audio.get("channels"):
            entry["audio_channels"] = audio["channels"]
        if audio and audio.get("sample_rate"):
            entry["sample_rate"] = audio["sample_rate"]
        tc = probe.timecode(path)
        if tc is None:
            unreadable.append(path)
        else:
            entry["start_timecode_seconds"] = tc["seconds"]
            if tc.get("duration"):
                entry["duration_seconds"] = tc["duration"]
        info[path] = entry
    return info, unreadable


def _markers(raw: Any, duration: float) -> list[dict[str, Any]]:
    """The draft's markers that fit the new sequence, in add_markers' form; an unknown colour is Green."""
    if not isinstance(raw, list):
        return []
    out = []
    for m in raw[:MAX_MARKERS]:
        if (
            not isinstance(m, dict)
            or not isinstance(m.get("time"), (int, float))
            or not 0 <= m["time"] <= duration
        ):
            continue
        color = m.get("color") if m.get("color") in PREMIERE_MARKER_COLORS else "Green"
        marker = {
            "time": float(m["time"]),
            "name": m.get("name") if isinstance(m.get("name"), str) else "",
            "color": color,
        }
        if isinstance(m.get("note"), str):
            marker["note"] = m["note"]
        if isinstance(m.get("duration"), (int, float)) and m["duration"] > 0:
            marker["duration"] = float(m["duration"])
        out.append(marker)
    return out


def _add_markers(host: Any, name: str, raw: Any, notes: list[str]) -> int:
    """Adds the draft's markers that fit the new sequence; a failure is a note, not an error."""
    markers = _markers(raw, seconds(host._info({"timeline": name})["endTicks"]))
    if not markers:
        return 0
    try:
        return len(host.add_markers({"timeline": name, "markers": markers})["added"])
    except HostError as exc:
        notes.append(f"The markers weren't added: {exc}")
        return 0


def rebuild(host: Any, args: dict[str, Any], imports: Path, probe: Any = None) -> dict[str, Any]:
    """Command `rebuild`: {timeline (the connected one), name (optional), tracks, markers, layout}.
    With `layout` (the draft's own clips, Phase 12a) the sequence is built inside Premiere from the
    project's own clips (premiere_native.py); without it, or when that can't be done, from XML.
    `imports` is the bridge folder's imports/, which the panel will only import from."""
    probe = probe or Probe()
    original = host._name(args)
    info = host._info(args)
    fps = frame_rate(info["timebase"])
    tracks = validate_tracks(args.get("tracks"))
    taken = set(host.status({})["timelines"])
    wanted = args.get("name")
    name = (
        unique_name(wanted.strip()[:MAX_NAME], taken)
        if isinstance(wanted, str) and wanted.strip()
        else default_name(original, taken)
    )

    xml_note = None
    if args.get("layout") is not None:
        from vibecut_agent.nle import premiere_native
        from vibecut_agent.nle.premiere_edit import _read

        clips = premiere_native.layout_clips(args["layout"])
        seq = _read(host, original)
        steps = premiere_native.plan(seq, premiere_native.view_of(host, original), clips)
        if steps is not None:
            built = premiere_native.build(host, original, name, BIN_NAME, seq, steps)
            notes = list(built["warnings"])
            # The clone came with the original's markers; the draft's replace them.
            host._send("remove_markers", {"timeline": built["timeline"], "all": True})
            added = _add_markers(host, built["timeline"], args.get("markers"), notes)
            return {
                "timeline": built["timeline"],
                "clips": built["clips"],
                "markersAdded": added,
                "bin": BIN_NAME,
                "warnings": notes,
                "native": True,
                "carried": built["carried"],
                "placed": built["placed"],
            }
        xml_note = (
            "A speed ramp (or a new clip at another speed) can't be built inside Premiere, so this sequence came in "
            f'as XML, and Premiere imported copies of its media into the "{BIN_NAME}" bin.'
        )

    sources, unreadable = source_info(tracks, probe)
    refuse_sound_on_picture(tracks, sources)
    text, warnings = xml_builder.build_premiere_xml_timeline(name, fps, tracks, source_info=sources)
    imports.mkdir(parents=True, exist_ok=True)
    path = imports / f"rebuild-{secrets.token_hex(6)}.xml"
    path.write_text(text, encoding="utf-8")
    try:
        imported = host._request(
            "import_sequence",
            {"path": str(path), "name": name, "bin": BIN_NAME},
            IMPORT_TIMEOUT_S,
        )
    finally:
        with contextlib.suppress(FileNotFoundError):
            path.unlink()
    name = imported.get("name", name)

    notes = list(warnings) + ([xml_note] if xml_note else [])
    added = _add_markers(host, name, args.get("markers"), notes)
    for source in unreadable:
        notes.append(
            f"Couldn't read the start timecode of {os.path.basename(source)}, so its clips count from 00:00:00:00."
        )
    return {
        "timeline": name,
        "clips": sum(len(t["clips"]) for t in tracks),
        "markersAdded": added,
        "bin": BIN_NAME,
        "warnings": notes,
    }
