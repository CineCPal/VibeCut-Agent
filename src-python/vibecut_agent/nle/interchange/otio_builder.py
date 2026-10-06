"""
otio_builder.py

Builds an OpenTimelineIO (.otio) document -- a JSON-based interchange
format (not XML like the other two exports) maintained by the Academy
Software Foundation. It's less a "yet another NLE format" and more a
neutral hub: DaVinci Resolve, Avid (via adapters), and most pipeline
tooling built in Python can read it directly, and tools that don't
support the .otio file itself can usually get there via `otioconvert`.

Structure (see https://opentimelineio.readthedocs.io for the full spec):
  Timeline -> tracks (a Stack) -> one or more Track (Video/Audio) ->
  Clip / Gap children. Every OTIO object carries an "OTIO_SCHEMA" key
  identifying its type and schema version, e.g. "Clip.1".

This module hand-builds that JSON directly rather than depending on the
`opentimelineio` PyPI package, matching how xml_builder.py and
fcpxml_builder.py hand-build their formats -- no extra dependency for
the person running the app, and one less thing that could be missing at
runtime. The schema itself was cross-checked against the current OTIO
docs, and this module's output is validated against the real reference
`opentimelineio` library during development.

Track model note: OTIO tracks are strictly sequential -- a clip's
position is implied by the cumulative duration of everything before it
on that track, not an absolute timestamp. So placing B-roll at an
explicit point means inserting a Gap to "push" the clip to the right
spot -- the standard OTIO idiom for this. If two B-roll clips would
overlap in time, they can't both live on one track (nothing in a single
OTIO track can occupy the same span twice), so overlapping clips are
spread across additional tracks (V2, V3, ...) via a greedy scheduling
pass -- the classic "minimum meeting rooms" approach -- so nothing is
silently dropped or corrupted.

Audio: OTIO doesn't model channel-level (L/R) routing the way XMEML
does -- it operates at the clip/track level. A parallel "A1" Audio-kind
track mirrors the main video track's clips (same source, same in/out)
for tools that expect an explicit audio track; B-roll audio_mode and any
ducking amount are recorded as metadata for reference, not as an
interpreted OTIO effect, since OTIO has no standardized volume-automation
primitive this app can confidently guarantee is portable across tools.

Media references (checked by importing into DaVinci Resolve 21.1, see PLAN.md "OTIO into Resolve"):
- A clip's source range is in its file's own timecode, the OTIO convention: a camera clip whose
  timecode starts at 18:40:32:17 reads from frame 2016977 onward, not from 0. `source_info` supplies
  each file's start (probed at export by headless.py); Resolve refuses the whole import when a range
  lies before the file's first frame. With no start known, ranges count from 0 as before.
- `target_url` is `file://` plus the plain path, spaces and all. Resolve fails the whole import on a
  percent-encoded URL (`%20`), even though that is the RFC form; Resolve's own OTIO export writes the
  plain path too.

No network access is used here; this is local JSON generation.
"""

import json
import math
import os
from typing import Any

from vibecut_agent.nle.interchange.time_remap import speed_pieces

# DaVinci Resolve's own OTIO export records a clip's level and links in `Resolve_OTIO` metadata, and
# its import reads them back (checked in Resolve 21.1); other OTIO readers ignore the key.
RESOLVE_MIN_DB = -100.0
RESOLVE_MAX_DB = 30.0


def _resolve_volume_effect(volume):
    """A clip level as Resolve's "Fairlight Clip Volume and Fades" effect, in dB."""
    db = 20 * math.log10(volume) if volume > 0 else RESOLVE_MIN_DB
    return {
        "OTIO_SCHEMA": "Effect.1",
        "name": "",
        "effect_name": "Resolve Effect",
        "metadata": {
            "Resolve_OTIO": {
                "Display Type": 1,
                "Effect Name": "Fairlight Clip Volume and Fades",
                "Enabled": True,
                "Name": "Volume",
                "Type": 62,
                "Parameters": [
                    {
                        "Default Parameter Value": 0.0,
                        "Key Frames": {},
                        "Parameter ID": "volume",
                        "Parameter Value": round(min(RESOLVE_MAX_DB, max(RESOLVE_MIN_DB, db)), 4),
                        "Variant Type": "Double",
                        "maxValue": RESOLVE_MAX_DB,
                        "minValue": RESOLVE_MIN_DB,
                    }
                ],
            }
        },
    }


def _to_file_url(path: str) -> str:
    """`file://` plus the plain absolute path, deliberately not percent-encoded (see the module header)."""
    normalized = os.path.abspath(path).replace(os.sep, "/")
    if not normalized.startswith("/"):
        normalized = "/" + normalized
    return "file://" + normalized


def _rational_time(value, fps):
    return {"OTIO_SCHEMA": "RationalTime.1", "rate": fps, "value": value}


def _time_range(start_frames, duration_frames, fps):
    return {
        "OTIO_SCHEMA": "TimeRange.1",
        "start_time": _rational_time(start_frames, fps),
        "duration": _rational_time(duration_frames, fps),
    }


def _gap(duration_frames, fps):
    return {
        "OTIO_SCHEMA": "Gap.1",
        "name": "Gap",
        "source_range": _time_range(0, duration_frames, fps),
        "effects": [],
        "markers": [],
        "metadata": {},
    }


TRANSITION_NAMES = {"dissolve": "Cross Dissolve", "dipToBlack": "Dip to Black"}


def _transition(kind, seconds, fps):
    """An OTIO Transition centred on a cut: half its length before the cut, half after. A dissolve is
    OTIO's standard SMPTE_Dissolve; a dip to black has no standard type, so it is a custom one with
    the kind in metadata."""
    half = max(1, round(seconds * fps / 2))
    return {
        "OTIO_SCHEMA": "Transition.1",
        "name": TRANSITION_NAMES.get(kind, "Transition"),
        "transition_type": "SMPTE_Dissolve" if kind == "dissolve" else "Custom_Transition",
        "in_offset": _rational_time(half, fps),
        "out_offset": _rational_time(half, fps),
        "metadata": {"rough_cut_studio": {"kind": kind}},
    }


def _source_start_frames(source, fps):
    """Where the file's own timecode starts, in timeline frames (0 when unknown). Fractional when the
    file's rate differs from the timeline's; OTIO allows that."""
    seconds = (source or {}).get("start_timecode_seconds") or 0.0
    return seconds * fps


def _clip(seg, fps, extra_metadata=None, source=None):
    """`source`: the file's `source_info` entry; its `start_timecode_seconds` shifts the source range
    into the file's timecode and, with `duration_seconds`, gives the reference its available range."""
    in_frames = max(0, round(seg["in_seconds"] * fps))
    # The length from the span, rounded once: rounding the in and out points separately can lose or
    # gain a frame when both sit on a half frame (round() rounds halves to even), which opened
    # one-frame black gaps between back-to-back cuts in Resolve (PLAN.md, 13b).
    duration = max(1, round((seg["out_seconds"] - seg["in_seconds"]) * fps))
    start = _source_start_frames(source, fps)
    file_duration = (source or {}).get("duration_seconds")
    clip = {
        "OTIO_SCHEMA": "Clip.1",
        "name": seg.get("source_name", "Clip"),
        "media_reference": {
            "OTIO_SCHEMA": "ExternalReference.1",
            "name": seg.get("source_name", "Clip"),
            "target_url": _to_file_url(seg["source_path"]),
            "available_range": _time_range(start, file_duration * fps, fps) if file_duration else None,
            "metadata": {},
        },
        "source_range": _time_range(start + in_frames, duration, fps),
        "effects": [],
        "markers": [],
        "metadata": {"rough_cut_studio": extra_metadata or {}},
    }
    return clip, duration


def _retimed_clip(c, fps, meta, start_frame, source=None):
    """A piece of a clip playing at one speed other than normal: its source range starts at the source
    in point and runs for its length on the timeline, with a LinearTimeWarp carrying the speed (how
    OTIO's own adapters write a speed change). Returns (clip, frames it takes on the track)."""
    end_frame = max(start_frame + 1, round((c["start_time_seconds"] + c["length_seconds"]) * fps))
    duration = end_frame - start_frame
    in_frames = max(0, round(c["source_in_seconds"] * fps))
    clip, _ = _clip({**_general_clip_seg(c)}, fps, meta, source)
    clip["source_range"] = _time_range(_source_start_frames(source, fps) + in_frames, duration, fps)
    clip["effects"] = [
        {
            "OTIO_SCHEMA": "LinearTimeWarp.1",
            "name": "Speed",
            "effect_name": "LinearTimeWarp",
            "time_scalar": c["speed"],
            "metadata": {},
        }
    ]
    return clip, duration


def _track(name, kind, children):
    return {
        "OTIO_SCHEMA": "Track.1",
        "name": name,
        "kind": kind,
        "children": children,
        "source_range": None,
        "markers": [],
        "effects": [],
        "metadata": {},
    }


def build_otio(
    sequence_name: str,
    fps: float,
    resolved_segments: list,
    broll_segments: list | None = None,
    video_width: int = 1920,
    video_height: int = 1080,
):
    """
    resolved_segments / broll_segments: same shapes used by xml_builder
    and fcpxml_builder (order/source_path/source_name/in_seconds/
    out_seconds/note, plus timeline_start_seconds and audio_mode for
    B-roll).

    Returns (otio_json_string, warnings_list).
    """
    resolved_segments = sorted(resolved_segments, key=lambda s: s["order"])
    broll_segments = broll_segments or []
    warnings = []

    if not resolved_segments:
        raise ValueError("build_otio requires at least one main cut.")

    v1_children = []
    a1_children = []
    for seg in resolved_segments:
        meta = {}
        if seg.get("note"):
            meta["editorial_note"] = seg["note"]
        if seg.get("on_screen_text"):
            meta["on_screen_text"] = seg["on_screen_text"]
        v_clip, _ = _clip(seg, fps, meta)
        v1_children.append(v_clip)
        a_clip, _ = _clip(seg, fps, meta)
        a1_children.append(a_clip)

    tracks_children = [_track("V1", "Video", v1_children)]

    if broll_segments:
        sorted_broll = sorted(broll_segments, key=lambda s: s.get("timeline_start_seconds") or 0.0)
        lanes: list[Any] = []

        for seg in sorted_broll:
            start_frame = max(0, round((seg.get("timeline_start_seconds") or 0.0) * fps))
            meta = {"audio_mode": seg.get("audio_mode", "silent")}
            if seg.get("duck_db") is not None and seg.get("audio_mode") == "duck_main":
                meta["duck_db"] = seg["duck_db"]
            if seg.get("note"):
                meta["editorial_note"] = seg["note"]
            clip, duration = _clip(seg, fps, meta)
            end_frame = start_frame + duration

            placed_lane = next((lane for lane in lanes if lane["cursor_frames"] <= start_frame), None)
            if placed_lane is None:
                placed_lane = {"cursor_frames": 0, "children": []}
                lanes.append(placed_lane)
                if len(lanes) > 1:
                    warnings.append(
                        f"OTIO: B-roll '{seg.get('source_name')}' overlaps another B-roll clip in time -- "
                        f"placed on an additional track (V{len(lanes) + 1}) rather than dropped or overlapped."
                    )

            gap_frames = start_frame - placed_lane["cursor_frames"]
            if gap_frames > 0:
                placed_lane["children"].append(_gap(gap_frames, fps))
            placed_lane["children"].append(clip)
            placed_lane["cursor_frames"] = end_frame

        for i, lane in enumerate(lanes):
            tracks_children.append(_track(f"V{i + 2}", "Video", lane["children"]))

    tracks_children.append(_track("A1", "Audio", a1_children))

    timeline = {
        "OTIO_SCHEMA": "Timeline.1",
        "name": sequence_name,
        "global_start_time": _rational_time(0, fps),
        "tracks": {
            "OTIO_SCHEMA": "Stack.1",
            "name": "tracks",
            "children": tracks_children,
            "source_range": None,
            "markers": [],
            "effects": [],
            "metadata": {},
        },
        "metadata": {
            "rough_cut_studio": {
                "video_width": video_width,
                "video_height": video_height,
                "fps": fps,
            }
        },
    }

    return json.dumps(timeline, indent=2), warnings


def _general_clip_seg(c):
    """Maps a build_otio_timeline clip (source_path/source_name/source_in_seconds/
    source_out_seconds) onto the field names `_clip` expects (source_path/source_name/in_seconds/
    out_seconds) -- the two builders' clip shapes differ only in these names."""
    return {
        "source_path": c["source_path"],
        "source_name": c.get("source_name", "Clip"),
        "in_seconds": c["source_in_seconds"],
        "out_seconds": c["source_out_seconds"],
    }


def build_otio_timeline(
    sequence_name: str,
    fps: float,
    tracks: list,
    video_width: int = 1920,
    video_height: int = 1080,
    source_info: dict | None = None,
):
    """Builds an OpenTimelineIO document directly from a general, multi-track timeline (e.g.
    VibeCut's own live timeline), independent of build_otio's "one main track + B-roll overlay"
    model above.

    OTIO has no links: a clip's "link_group" (a camera clip, its synced sound and its own muted sound
    share one) is kept in its metadata, and "enabled": False writes the clip switched off. Every clip
    keeps its own file reference, so a separately recorded sound file relinks on its own.
    `source_info` ({path: {..., "start_timecode_seconds", "duration_seconds"}}) places each clip's
    source range in its file's own timecode (see the module header); a path missing from it counts
    from 0.

    `tracks`: ordered bottom-to-top (index 0 renders below every other video track). Each entry:
    {"type": "video" | "audio", "clips": [...]}. Each clip: {"source_path", "source_name",
    "start_time_seconds", "source_in_seconds", "source_out_seconds", "has_audio" (only consulted for
    a "video" track's clips), "volume" (linear gain), "fade_in_seconds"/"fade_out_seconds" (optional),
    "transition_out" (optional {"kind": "dissolve" | "dipToBlack", "seconds"}: the transition on the cut
    at the clip's end, written as an OTIO Transition when the next clip starts right there).

    OTIO is the natural fit for a general N-track timeline: every VibeCut track becomes its own OTIO
    Track (in the same stacking order), independent of every other one -- unlike the FCPXML/XMEML
    exports, there's no host-clip or shared-lane model to work around, since OTIO's Stack simply
    holds an arbitrary number of parallel tracks. Each track's own clips are placed in order with a
    Gap inserted wherever there is empty space, exactly like build_otio's B-roll lanes already do.

    Fades aren't applied as an effect (OTIO has no standardized, portable volume/opacity-ramp
    primitive this app can confidently guarantee round-trips elsewhere -- see this module's header
    comment), but are recorded as metadata and reported as a warning so they aren't silently lost.

    Returns (otio_json_string, warnings_list).
    """
    warnings: list[str] = []
    if not any(t.get("clips") for t in tracks):
        raise ValueError("build_otio_timeline requires at least one clip.")

    source_info = source_info or {}
    link_ids: dict[Any, Any] = {}

    def link_id(key):
        return link_ids.setdefault(key, len(link_ids) + 1)

    def track_children(clips, is_video, warn=True, own_sound_of=None):
        """`own_sound_of`: the index of the video track whose clips' own sound this is (or, on that
        video track, will get), so each picture is linked to its sound in Resolve."""
        # A clip with speed changes becomes consecutive pieces, each at one speed (LinearTimeWarp).
        clips_sorted = sorted(
            (piece for c in clips for piece in speed_pieces(c, fps)),
            key=lambda c: c["start_time_seconds"],
        )
        children = []
        cursor_frames = 0
        previous = None
        for c in clips_sorted:
            start_frame = max(0, round(c["start_time_seconds"] * fps))
            gap_frames = start_frame - cursor_frames
            if gap_frames > 0:
                children.append(_gap(gap_frames, fps))
                cursor_frames += gap_frames
            elif previous is not None and previous.get("transition_out"):
                transition = previous["transition_out"]
                children.append(_transition(transition["kind"], transition["seconds"], fps))
            previous = c

            contributes_audio = bool(c.get("has_audio")) if is_video else True
            meta = {"has_audio": contributes_audio}
            if contributes_audio:
                meta["volume"] = c.get("volume", 1.0)
            if c.get("fade_in_seconds"):
                meta["fade_in_seconds"] = c["fade_in_seconds"]
            if c.get("fade_out_seconds"):
                meta["fade_out_seconds"] = c["fade_out_seconds"]
            if warn and (c.get("fade_in_seconds") or c.get("fade_out_seconds")):
                warnings.append(
                    f"OTIO: '{c.get('source_name', 'Clip')}' has a fade, which this export does not apply "
                    "(recorded as metadata only)."
                )

            if c.get("link_group"):
                meta["link_group"] = c["link_group"]
            speed = c.get("speed", 1.0)
            source = source_info.get(c["source_path"])
            if speed == 1.0:
                otio_clip, duration = _clip(_general_clip_seg(c), fps, meta, source)
            else:
                otio_clip, duration = _retimed_clip(c, fps, meta, start_frame, source)
            if c.get("enabled") is False:
                otio_clip["enabled"] = False
            if not is_video and c.get("enabled") is not False and c.get("volume", 1.0) != 1.0:
                otio_clip["effects"].append(_resolve_volume_effect(c.get("volume", 1.0)))
            if c.get("link_group"):
                otio_clip["metadata"]["Resolve_OTIO"] = {"Link Group ID": link_id(("group", c["link_group"]))}
            elif own_sound_of is not None and contributes_audio:
                otio_clip["metadata"]["Resolve_OTIO"] = {
                    "Link Group ID": link_id(("own", own_sound_of, start_frame))
                }
            children.append(otio_clip)
            cursor_frames += duration
        return children

    tracks_children = []
    next_index = {"video": 0, "audio": 0}
    # `tracks` runs bottom-to-top; audio tracks are numbered top-down, so VibeCut's A1 stays A1.
    video_tracks = [t for t in tracks if t.get("type") == "video"]
    for track in video_tracks + [t for t in reversed(tracks) if t.get("type") != "video"]:
        is_video = track.get("type") == "video"
        next_index["video" if is_video else "audio"] += 1
        name = f"{'V' if is_video else 'A'}{next_index['video' if is_video else 'audio']}"
        own = video_tracks.index(track) if is_video else None
        tracks_children.append(
            _track(
                name,
                "Video" if is_video else "Audio",
                track_children(track.get("clips", []), is_video, own_sound_of=own),
            )
        )

    # A video clip's own sound gets an Audio track of its own after VibeCut's audio tracks, the same
    # clips at the same in and out points. OTIO tracks are only Video or Audio, and DaVinci Resolve
    # imports a Video track's clips as picture only (checked in Resolve 21.1), so without it the
    # sound is lost.
    for i, track in enumerate(video_tracks):
        sounding = [c for c in track.get("clips", []) if c.get("has_audio")]
        if sounding:
            next_index["audio"] += 1
            tracks_children.append(
                _track(
                    f"A{next_index['audio']}",
                    "Audio",
                    track_children(sounding, False, warn=False, own_sound_of=i),
                )
            )

    timeline = {
        "OTIO_SCHEMA": "Timeline.1",
        "name": sequence_name,
        "global_start_time": _rational_time(0, fps),
        "tracks": {
            "OTIO_SCHEMA": "Stack.1",
            "name": "tracks",
            "children": tracks_children,
            "source_range": None,
            "markers": [],
            "effects": [],
            "metadata": {},
        },
        "metadata": {
            "rough_cut_studio": {"video_width": video_width, "video_height": video_height, "fps": fps}
        },
    }

    return json.dumps(timeline, indent=2), warnings
