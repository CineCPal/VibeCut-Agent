"""Builds a new Resolve timeline from the agent's draft of one (PLAN.md, "Phase 6b"), ported from VibeCut's
host-resolve/resolve_rebuild.py (its "Connect page", phase 2). Runs under Resolve's own Python: standard
library only.

Resolve's API can't trim, move or split clips already on a timeline, so a cut, a rearrangement or
placed B-roll reaches Resolve as a whole new timeline: VibeCut sends the tracks (the same shape as
rough-cut-studio's `export` command), this builds OTIO with rough-cut-studio's own builder (checked
45/45 against Resolve in the round-trip check), imports it under a name no timeline has yet, copies
each picture clip's grade from the clip it came from, adds the markers and opens it. The connected
timeline is never changed.

What Resolve was checked to do (Studio 21.1, PLAN.md "Connect page, phase 2"):
- `TimelineItem.CopyGrades([item])` copies a grade into another timeline: the copy's grade, exported
  as a LUT, matched the original byte for byte.
- `ImportTimelineFromFile` doesn't follow an OTIO clip's absolute `target_url`: it looks for each
  file by searching (next to the OTIO file, or in `sourceClipsPath`), so an OTIO written to a temporary
  folder imports nothing and the call fails. So every source is put in the Media Pool first (new ones
  into a "VibeCut" bin with `ImportMedia`), and the timeline is imported with `importSourceClips:
  False` and `sourceClipsFolders`, which links it to those clips. That also never duplicates media.
- That link goes by file NAME, ignoring case, not by path (13b: a stale "Bakery-Interview.mov" in
  Master took the place of ~/Movies/.../bakery-interview.mov). So only the folders holding the needed
  files are searched, and every clip of the new timeline is checked against the paths it should use;
  a timeline linked to another file is deleted again and the rebuild refused.
- A file's own timecode comes from its Media Pool clip ("Start TC", "FPS"); one that isn't in the
  pool yet (new B-roll) is probed with ffprobe. OTIO addresses source frames in that timecode, and
  Resolve refuses the whole import when a range lies outside the file.
"""

from __future__ import annotations

import math
import os
import shutil
import tempfile
from typing import Any

from vibecut_agent.nle.interchange import otio_builder
from vibecut_agent.nle.interchange.time_remap import TimeMapError, parse_time_map
from vibecut_agent.nle.resolve import HostError, _color, _to_frame, marker_name, timecode_to_frames
from vibecut_agent.nle.resolve import frame_rate as _frame_rate

MAX_CLIPS = 5000
MAX_NAME = 200


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
    """The request's tracks (camelCase, as rough-cut-studio's `export` takes them) in the builders'
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
            if c.get("timeMap") is not None:
                try:
                    clip["time_map"] = parse_time_map(c["timeMap"], source_in, source_out)
                except TimeMapError as exc:
                    raise HostError(f"{where}.timeMap {exc}") from exc
            clips.append(clip)
        tracks.append({"type": track["type"], "clips": clips})
    if total == 0:
        raise HostError("There is nothing to put on the new timeline")
    return tracks


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


def _pool_index(media_pool: Any) -> dict[str, tuple[Any, Any]]:
    """Each file path in the Media Pool: its (first) clip and the folder holding it."""
    found: dict[str, tuple[Any, Any]] = {}
    stack = [media_pool.GetRootFolder()]
    while stack:
        folder = stack.pop()
        for clip in folder.GetClipList() or []:
            path = clip.GetClipProperty("File Path")
            if path:
                found.setdefault(path, (clip, folder))
        stack.extend(folder.GetSubFolderList() or [])
    return found


def _pool_by_path(media_pool: Any) -> dict[str, Any]:
    return {path: clip for path, (clip, _) in _pool_index(media_pool).items()}


def _source_folders(media_pool: Any, paths: list[str]) -> list[Any]:
    """The pool folders holding `paths`, once each, for `sourceClipsFolders`."""
    index = _pool_index(media_pool)
    folders: list[Any] = []
    for path in paths:
        folder = index[path][1] if path in index else None
        if folder is not None and all(folder is not f for f in folders):
            folders.append(folder)
    return folders


def _linked_elsewhere(timeline: Any, paths: set[str]) -> list[str]:
    """Files the timeline's clips link to that aren't among `paths` (offline clips aren't counted)."""
    wrong: list[str] = []
    for kind in ("video", "audio"):
        for index in range(1, (timeline.GetTrackCount(kind) or 0) + 1):
            for item in timeline.GetItemListInTrack(kind, index) or []:
                media = item.GetMediaPoolItem()
                path = media.GetClipProperty("File Path") if media else None
                if path and path not in paths and path not in wrong:
                    wrong.append(path)
    return wrong


BIN_NAME = "VibeCut"


def ensure_in_pool(media_pool: Any, paths: list[str]) -> None:
    """Imports the files that aren't in the Media Pool yet into a "VibeCut" bin."""
    pool = _pool_by_path(media_pool)
    missing = [p for p in paths if p not in pool]
    if not missing:
        return
    root = media_pool.GetRootFolder()
    target = next(
        (f for f in root.GetSubFolderList() or [] if f.GetName() == BIN_NAME), None
    ) or media_pool.AddSubFolder(root, BIN_NAME)
    previous = media_pool.GetCurrentFolder()
    try:
        if target:
            media_pool.SetCurrentFolder(target)
        media_pool.ImportMedia(missing)
    finally:
        if previous:
            media_pool.SetCurrentFolder(previous)
    still = [p for p in missing if p not in _pool_by_path(media_pool)]
    if still:
        names = ", ".join(os.path.basename(p) for p in still[:5])
        raise HostError(f"Resolve couldn't import {len(still)} file(s) into the Media Pool: {names}")


def _pool_source_info(clip: Any) -> dict[str, float] | None:
    """Where a pool clip's own timecode starts, and how long it is, in seconds."""
    try:
        fps = float(str(clip.GetClipProperty("FPS")).split()[0])
        start = timecode_to_frames(str(clip.GetClipProperty("Start TC")), fps) / fps
    except (ValueError, IndexError, HostError):
        return None
    info = {"start_timecode_seconds": start}
    try:
        frames = int(str(clip.GetClipProperty("Frames")))
        if frames > 0:
            info["duration_seconds"] = frames / fps
    except ValueError:
        pass
    return info


def source_info(
    tracks: list[dict[str, Any]], media_pool: Any, probe: Any
) -> tuple[dict[str, dict], list[str]]:
    """Each source's start timecode and length: from the Media Pool, else ffprobe. Refuses a clip
    that reaches past its file's end, which would make Resolve refuse the whole timeline."""
    pool = _pool_by_path(media_pool)
    info: dict[str, dict] = {}
    unknown: list[str] = []
    for path in dict.fromkeys(c["source_path"] for t in tracks for c in t["clips"]):
        entry = _pool_source_info(pool[path]) if path in pool else None
        if entry is None:
            probed = probe(path)
            if probed is None:
                unknown.append(path)
                continue
            entry = {"start_timecode_seconds": probed["seconds"]}
            if probed.get("duration"):
                entry["duration_seconds"] = probed["duration"]
        info[path] = entry
    for track in tracks:
        for c in track["clips"]:
            length = info.get(c["source_path"], {}).get("duration_seconds")
            if length is not None and c["source_out_seconds"] > length + 0.05:
                raise HostError(
                    f"{c['source_name']} is only {length:.2f} s long, but a clip uses it up to {c['source_out_seconds']:.2f} s"
                )
    return info, unknown


def _items_by_id(timeline: Any) -> dict[str, Any]:
    items = {}
    for index in range(1, int(timeline.GetTrackCount("video") or 0) + 1):
        for item in timeline.GetItemListInTrack("video", index) or []:
            items[item.GetUniqueId()] = item
    return items


def copy_grades(original: Any, new: Any, pairs: Any, fps: float) -> tuple[int, int]:
    """Copies each new picture clip's grade from the clip it was cut from. `pairs`: [{originId,
    trackIndex (the new timeline's video track), start, end? (seconds)}]. With `end`, every clip on
    that track starting from `start` to before `end` gets it: a speed ramp is built as several pieces
    (PLAN.md, "Phase 8b"). Returns (copied, not copied)."""
    if not isinstance(pairs, list) or not pairs:
        return 0, 0
    originals = _items_by_id(original)
    start = int(new.GetStartFrame())
    placed: dict[int, list[tuple[int, Any]]] = {}
    for index in range(1, int(new.GetTrackCount("video") or 0) + 1):
        for item in new.GetItemListInTrack("video", index) or []:
            placed.setdefault(index, []).append((round(item.GetStart() - start), item))
    copied = missed = 0
    for pair in pairs:
        if not isinstance(pair, dict):
            continue
        source = originals.get(pair.get("originId"))  # type: ignore[arg-type]  # a missing id finds nothing
        index, at, until = pair.get("trackIndex"), pair.get("start"), pair.get("end")  # type: ignore[assignment]  # checked below
        targets: list[Any] = []
        if isinstance(index, int) and isinstance(at, (int, float)):
            first = _to_frame(at, fps)
            last = _to_frame(until, fps) if isinstance(until, (int, float)) else first + 1
            targets = [item for frame, item in placed.get(index, []) if first <= frame < last]
        if source is not None and targets and source.CopyGrades(targets):
            copied += 1
        else:
            missed += 1
    return copied, missed


def add_markers(timeline: Any, markers: Any, fps: float) -> int:
    if not isinstance(markers, list):
        return 0
    added = 0
    for m in markers[:2000]:
        if not isinstance(m, dict) or not isinstance(m.get("time"), (int, float)):
            continue
        note = m["note"] if isinstance(m.get("note"), str) else ""
        name = marker_name(m["name"] if isinstance(m.get("name"), str) else "", note)
        try:
            color = _color(m.get("color"))
        except HostError:
            color = "Green"
        duration = max(1, _to_frame(float(m.get("duration") or 0), fps))
        if timeline.AddMarker(_to_frame(float(m["time"]), fps), color, name, note, duration):
            added += 1
    return added


def rebuild(host: Any, args: dict[str, Any], probe: Any = None) -> dict[str, Any]:
    """Command `rebuild`: {timeline (the connected one), name (optional), tracks, markers, grades}."""
    if probe is None:
        from vibecut_agent.broll.ffprobe_util import probe_start_timecode as probe
    project, original = host._timeline(args)
    fps = _frame_rate(original)
    tracks = validate_tracks(args.get("tracks"))
    taken = {t.GetName() for t in host._timelines(project) if t}
    wanted = args.get("name")
    name = (
        unique_name(wanted.strip()[:MAX_NAME], taken)
        if isinstance(wanted, str) and wanted.strip()
        else default_name(original.GetName(), taken)
    )
    media_pool = project.GetMediaPool()
    sources = list(dict.fromkeys(c["source_path"] for t in tracks for c in t["clips"]))
    ensure_in_pool(media_pool, sources)
    info, unknown = source_info(tracks, media_pool, probe)
    text, warnings = otio_builder.build_otio_timeline(name, fps, tracks, source_info=info)

    folder = tempfile.mkdtemp(prefix="vibecut-rebuild-")
    try:
        path = os.path.join(folder, "timeline.otio")
        with open(path, "w", encoding="utf-8") as f:
            f.write(text)
        new = media_pool.ImportTimelineFromFile(
            path,
            {
                "timelineName": name,
                "importSourceClips": False,
                "sourceClipsFolders": _source_folders(media_pool, sources),
            },
        )
    finally:
        shutil.rmtree(folder, ignore_errors=True)
    if not new:
        raise HostError("Resolve couldn't import the rebuilt timeline. The connected timeline is unchanged.")
    wrong = _linked_elsewhere(new, set(sources))
    if wrong:
        media_pool.DeleteTimelines([new])
        names = ", ".join(f'"{os.path.basename(p)}" ({p})' for p in wrong[:3])
        raise HostError(
            f"Resolve linked the new timeline to {names}, another Media Pool clip with the same file "
            "name as one it needed (Resolve matches by name). Rename that clip's file or remove it "
            "from the Media Pool, then try again. The connected timeline is unchanged."
        )

    copied, missed = copy_grades(original, new, args.get("grades"), fps)
    markers = add_markers(new, args.get("markers"), fps)
    project.SetCurrentTimeline(new)
    notes = list(warnings)
    if unknown:
        notes.append(f"Couldn't read the timecode of {len(unknown)} file(s); Resolve may show them offline.")
    try:
        new_fps = _frame_rate(new)
        if abs(new_fps - fps) > 0.001:
            notes.append(f"The new timeline runs at {new_fps} fps (the project's rate), not {fps} fps.")
    except HostError:
        pass
    return {
        "timeline": name,
        "clips": sum(len(t["clips"]) for t in tracks),
        "gradesCopied": copied,
        "gradesNotCopied": missed,
        "markersAdded": markers,
        "warnings": notes,
    }
