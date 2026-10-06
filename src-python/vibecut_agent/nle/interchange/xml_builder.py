"""
xml_builder.py

Builds a Final Cut Pro XML Interchange Format (XMEML v5) file from a resolved
list of edit decisions. Premiere Pro imports this format directly
(File > Import) and populates a new sequence with the cuts already placed
on the timeline in order, referencing the original source media by file path.

No network access is required or used here; this is local XML generation.

Frame-rate note: timecodes are treated as non-drop-frame. If your source
footage uses drop-frame timecode (common at 29.97/59.94 fps on some cameras),
re-check the sequence settings after import.

Audio is always written as true stereo: two linked mono tracks per clip
group, each pulling one channel out of the source file via <sourcetrack>.
This is how Final Cut/Premiere's own XML export represents a stereo clip --
a single audio clipitem with channelcount=2 and no channel routing is not
enough; Premiere will import that as mono. See STEREO_CHANNELS below;
this isn't a tunable parameter.

Optional B-roll clips sit on a second video track (V2) at an explicit
timeline position -- or, if two B-roll clips overlap in time, on further
tracks (V3, V4, ...) via greedy lane assignment, since a single XMEML
track can't hold two overlapping clipitems. Each clip has an "audio_mode":
  - "silent" (default): no audio at all for the overlay -- the classic
    picture-only B-roll pattern.
  - "full": the overlay's own audio plays too, on its own stereo track
    pair (A3/A4), left untouched.
  - "duck_main": same as "full", but every MAIN clip the overlay's time
    range touches has its audio level reduced (a flat reduction for the
    clip's entire duration, not a frame-precise fade in/out around just
    the overlap -- see build_premiere_xml's docstring for why).
"""

import math
import os
import uuid
import xml.etree.ElementTree as ET
from typing import Any
from xml.dom import minidom

from vibecut_agent.nle.interchange.time_remap import speed_pieces

STEREO_CHANNELS = 2
# The most channels of one file written as separate clipitems (a poly WAV from a field recorder).
MAX_EXPORT_CHANNELS = 16

# Apple's FCP7/XMEML spec defines a fixed enum for <pixelaspectratio> --
# there's no free-form numeric option -- of which these are the two
# broadcast-SD non-square presets this app is likely to actually see
# (NTSC/PAL DV). (ratio, tolerance, label)
_XMEML_PAR_PRESETS = (
    (10 / 11, 0.005, "NTSC-601"),
    (59 / 54, 0.005, "PAL-601"),
)


def _uid():
    return uuid.uuid4().hex[:16].upper()


def _rate_elem(parent, fps: float):
    rate = ET.SubElement(parent, "rate")
    timebase = ET.SubElement(rate, "timebase")
    ntsc = fps not in (24, 25, 30, 50, 60)
    timebase.text = str(round(fps))
    ntsc_el = ET.SubElement(rate, "ntsc")
    ntsc_el.text = "TRUE" if ntsc else "FALSE"


def _par_label(par_num: int, par_den: int):
    """Maps a raw PAR fraction to one of XMEML's fixed pixelaspectratio
    enum values. Anything that doesn't match a known non-square preset
    within tolerance falls back to "square" rather than guessing --
    an unrecognized value risks Premiere rejecting or misreading the
    sequence, no worse than writing nothing at all, and this covers the
    common broadcast-SD case correctly."""
    if par_num <= 0 or par_den <= 0:
        return "square", False
    ratio = par_num / par_den
    if abs(ratio - 1.0) < 0.01:
        return "square", False
    for target_ratio, tolerance, label in _XMEML_PAR_PRESETS:
        if abs(ratio - target_ratio) < tolerance:
            return label, True
    return "square", False


def _pixel_aspect_elems(parent, par_num: int, par_den: int):
    label, anamorphic = _par_label(par_num, par_den)
    ET.SubElement(parent, "anamorphic").text = "TRUE" if anamorphic else "FALSE"
    ET.SubElement(parent, "pixelaspectratio").text = label


def _db_to_amplitude(db: float) -> float:
    return round(10 ** (db / 20.0), 4)


def _add_audio_levels_filter(clipitem_el, db: float):
    filt = ET.SubElement(clipitem_el, "filter")
    effect = ET.SubElement(filt, "effect")
    ET.SubElement(effect, "name").text = "Audio Levels"
    ET.SubElement(effect, "effectid").text = "audiolevels"
    ET.SubElement(effect, "effectcategory").text = "audiolevels"
    ET.SubElement(effect, "effecttype").text = "audiolevels"
    ET.SubElement(effect, "mediatype").text = "audio"
    parameter = ET.SubElement(effect, "parameter")
    ET.SubElement(parameter, "parameterid").text = "level"
    ET.SubElement(parameter, "name").text = "Level"
    ET.SubElement(parameter, "value").text = str(_db_to_amplitude(db))


def build_premiere_xml(
    sequence_name: str,
    fps: float,
    resolved_segments: list,
    broll_segments: list | None = None,
    main_duck_db: dict | None = None,
    video_width: int = 1920,
    video_height: int = 1080,
    audio_sample_rate: int = 48000,
    audio_depth: int = 16,
    source_dims: dict | None = None,
):
    """Returns (xml_string, warnings_list).

    `source_dims` is an optional {source_path: {"width", "height",
    "par_num", "par_den"}} map of each source file's *actual* probed
    geometry (see api.py, which fills this in via
    rcs_utils.ffprobe_util.probe_video_dimensions). When a source_path
    isn't in the map (unlinked media, probing failed, or the caller
    passed nothing), its <file> falls back to the video_width/
    video_height/square-PAR defaults below -- same behavior as before
    this parameter existed. The sequence's own format uses the first
    main clip's real dimensions when known, since that's what Premiere
    itself derives a new sequence's settings from.
    """
    resolved_segments = sorted(resolved_segments, key=lambda s: s["order"])
    broll_segments = broll_segments or []
    main_duck_db = main_duck_db or {}
    source_dims = source_dims or {}
    warnings = []

    seq_dims = source_dims.get(resolved_segments[0]["source_path"]) if resolved_segments else None
    seq_dims = seq_dims or {}
    seq_width = seq_dims.get("width", video_width)
    seq_height = seq_dims.get("height", video_height)
    seq_par_num = seq_dims.get("par_num", 1)
    seq_par_den = seq_dims.get("par_den", 1)

    xmeml = ET.Element("xmeml", version="5")
    sequence = ET.SubElement(xmeml, "sequence", id=f"sequence-{_uid()}")
    ET.SubElement(sequence, "name").text = sequence_name
    ET.SubElement(sequence, "duration").text = "0"
    _rate_elem(sequence, fps)

    media = ET.SubElement(sequence, "media")

    video = ET.SubElement(media, "video")
    video_format = ET.SubElement(video, "format")
    vsc = ET.SubElement(video_format, "samplecharacteristics")
    _rate_elem(vsc, fps)
    ET.SubElement(vsc, "width").text = str(seq_width)
    ET.SubElement(vsc, "height").text = str(seq_height)
    _pixel_aspect_elems(vsc, seq_par_num, seq_par_den)
    video_track = ET.SubElement(video, "track")

    audio = ET.SubElement(media, "audio")
    ET.SubElement(audio, "numOutputChannels").text = str(STEREO_CHANNELS)
    audio_format = ET.SubElement(audio, "format")
    asc = ET.SubElement(audio_format, "samplecharacteristics")
    ET.SubElement(asc, "depth").text = str(audio_depth)
    ET.SubElement(asc, "samplerate").text = str(audio_sample_rate)
    ET.SubElement(audio_format, "channelcount").text = str(STEREO_CHANNELS)
    audio_track_left = ET.SubElement(audio, "track")
    audio_track_right = ET.SubElement(audio, "track")

    timeline_pos = 0
    file_id_cache = {}

    for i, seg in enumerate(resolved_segments):
        in_frames = max(0, round(seg["in_seconds"] * fps))
        out_frames = max(in_frames + 1, round(seg["out_seconds"] * fps))
        clip_len = out_frames - in_frames
        clip_name = seg.get("source_name", "Clip")
        source_path = seg["source_path"]
        clip_index = i + 1

        is_new_file = source_path not in file_id_cache
        if is_new_file:
            file_id_cache[source_path] = f"file-{_uid()}"
        file_id = file_id_cache[source_path]

        video_id = f"clipitem-V{clip_index}-{_uid()}"
        audio_l_id = f"clipitem-AL{clip_index}-{_uid()}"
        audio_r_id = f"clipitem-AR{clip_index}-{_uid()}"
        link_ids = (video_id, audio_l_id, audio_r_id)
        link_tracks = (1, 1, 2)

        v_clip = ET.SubElement(video_track, "clipitem", id=video_id)
        ET.SubElement(v_clip, "name").text = clip_name
        ET.SubElement(v_clip, "duration").text = str(clip_len)
        _rate_elem(v_clip, fps)
        ET.SubElement(v_clip, "start").text = str(timeline_pos)
        ET.SubElement(v_clip, "end").text = str(timeline_pos + clip_len)
        ET.SubElement(v_clip, "in").text = str(in_frames)
        ET.SubElement(v_clip, "out").text = str(out_frames)

        if is_new_file:
            file_dims = source_dims.get(source_path) or {}
            _build_file_element(
                v_clip,
                file_id,
                clip_name,
                source_path,
                fps,
                file_dims.get("width", video_width),
                file_dims.get("height", video_height),
                file_dims.get("par_num", 1),
                file_dims.get("par_den", 1),
                audio_sample_rate,
                audio_depth,
            )
        else:
            ET.SubElement(v_clip, "file", id=file_id)

        note = seg.get("note")
        if note:
            marker = ET.SubElement(v_clip, "marker")
            ET.SubElement(marker, "name").text = note[:80]
            ET.SubElement(marker, "comment").text = note
            ET.SubElement(marker, "in").text = "0"
            ET.SubElement(marker, "out").text = "-1"

        _add_stereo_links(v_clip, link_ids, link_tracks, clip_index)

        duck_db = main_duck_db.get(seg["order"])

        al_clip = _add_audio_channel_clip(
            audio_track_left,
            audio_l_id,
            file_id,
            clip_name,
            fps,
            timeline_pos,
            clip_len,
            in_frames,
            out_frames,
            source_channel=1,
            link_ids=link_ids,
            link_tracks=link_tracks,
            clip_index=clip_index,
        )
        ar_clip = _add_audio_channel_clip(
            audio_track_right,
            audio_r_id,
            file_id,
            clip_name,
            fps,
            timeline_pos,
            clip_len,
            in_frames,
            out_frames,
            source_channel=2,
            link_ids=link_ids,
            link_tracks=link_tracks,
            clip_index=clip_index,
        )
        if duck_db is not None:
            _add_audio_levels_filter(al_clip, duck_db)
            _add_audio_levels_filter(ar_clip, duck_db)

        timeline_pos += clip_len

    total_frames = timeline_pos

    if broll_segments:
        # Overlapping B-roll clips can't share a single XMEML track --
        # Premiere/Final Cut expect clipitems on one track to never overlap
        # in time. Assign each clip a "lane" with the same greedy interval-
        # scheduling approach otio_builder.py uses (process in start-time
        # order, reuse a lane once it's free, otherwise open a new one), so
        # overlapping B-roll spreads across additional video tracks
        # (V2, V3, ...) instead of colliding. Audio-bearing B-roll gets the
        # same treatment: each lane gets its own stereo track pair,
        # allocated lazily so silent B-roll never grows the audio section.
        # `video_track` (main) is always sequence track 1; broll video
        # lanes are 2, 3, ... in the order their tracks are created here.
        # `audio_track_left`/`audio_track_right` (main) are tracks 1/2;
        # broll audio lanes take the next free indices from there.
        next_broll_video_index = 2
        next_broll_audio_index = 3
        lanes: list[Any] = []  # each: {"cursor": int, "video_track": Element, "video_index": int,
        #        "audio_left": Element|None, "audio_right": Element|None, "audio_index": int|None}

        order_by_start = sorted(
            range(len(broll_segments)),
            key=lambda bi: broll_segments[bi].get("timeline_start_seconds") or 0.0,
        )

        for bi in order_by_start:
            seg = broll_segments[bi]
            in_frames = max(0, round(seg["in_seconds"] * fps))
            out_frames = max(in_frames + 1, round(seg["out_seconds"] * fps))
            clip_len = out_frames - in_frames
            start_frame = max(0, round(seg.get("timeline_start_seconds", 0) * fps))
            end_frame = start_frame + clip_len
            total_frames = max(total_frames, end_frame)

            lane = next((ln for ln in lanes if ln["cursor"] <= start_frame), None)
            if lane is None:
                lane = {
                    "cursor": 0,
                    "video_track": ET.SubElement(video, "track"),
                    "video_index": next_broll_video_index,
                    "audio_left": None,
                    "audio_right": None,
                    "audio_index": None,
                }
                if lanes:
                    warnings.append(
                        f"Premiere: B-roll '{seg.get('source_name')}' overlaps another B-roll clip in time -- "
                        f"placed on an additional track (V{next_broll_video_index}) rather than dropped or overlapped."
                    )
                next_broll_video_index += 1
                lanes.append(lane)
            lane["cursor"] = end_frame
            broll_track = lane["video_track"]
            broll_video_track_index = lane["video_index"]

            clip_name = f"{seg.get('source_name', 'B-Roll')} \u00b7 B-ROLL"
            source_path = seg["source_path"]
            is_new_file = source_path not in file_id_cache
            if is_new_file:
                file_id_cache[source_path] = f"file-{_uid()}"
            file_id = file_id_cache[source_path]

            audio_mode = seg.get("audio_mode", "silent")
            broll_clip_index = 1000 + bi
            video_id = f"clipitem-BR{bi}-{_uid()}"

            clip = ET.SubElement(broll_track, "clipitem", id=video_id)
            ET.SubElement(clip, "name").text = clip_name
            ET.SubElement(clip, "duration").text = str(clip_len)
            _rate_elem(clip, fps)
            ET.SubElement(clip, "start").text = str(start_frame)
            ET.SubElement(clip, "end").text = str(end_frame)
            ET.SubElement(clip, "in").text = str(in_frames)
            ET.SubElement(clip, "out").text = str(out_frames)

            if is_new_file:
                file_dims = source_dims.get(source_path) or {}
                _build_file_element(
                    clip,
                    file_id,
                    seg.get("source_name", "B-Roll"),
                    source_path,
                    fps,
                    file_dims.get("width", video_width),
                    file_dims.get("height", video_height),
                    file_dims.get("par_num", 1),
                    file_dims.get("par_den", 1),
                    audio_sample_rate,
                    audio_depth,
                )
            else:
                ET.SubElement(clip, "file", id=file_id)

            note = seg.get("note")
            if note:
                marker = ET.SubElement(clip, "marker")
                ET.SubElement(marker, "name").text = note[:80]
                ET.SubElement(marker, "comment").text = note
                ET.SubElement(marker, "in").text = "0"
                ET.SubElement(marker, "out").text = "-1"

            if audio_mode == "silent":
                continue

            if lane["audio_left"] is None:
                lane["audio_left"] = ET.SubElement(audio, "track")
                lane["audio_right"] = ET.SubElement(audio, "track")
                lane["audio_index"] = next_broll_audio_index
                next_broll_audio_index += 2

            audio_l_id = f"clipitem-BRAL{bi}-{_uid()}"
            audio_r_id = f"clipitem-BRAR{bi}-{_uid()}"
            link_ids = (video_id, audio_l_id, audio_r_id)
            link_tracks = (
                broll_video_track_index,
                lane["audio_index"],
                lane["audio_index"] + 1,
            )
            _add_stereo_links(clip, link_ids, link_tracks, broll_clip_index)

            _add_audio_channel_clip(
                lane["audio_left"],
                audio_l_id,
                file_id,
                clip_name,
                fps,
                start_frame,
                clip_len,
                in_frames,
                out_frames,
                source_channel=1,
                link_ids=link_ids,
                link_tracks=link_tracks,
                clip_index=broll_clip_index,
            )
            _add_audio_channel_clip(
                lane["audio_right"],
                audio_r_id,
                file_id,
                clip_name,
                fps,
                start_frame,
                clip_len,
                in_frames,
                out_frames,
                source_channel=2,
                link_ids=link_ids,
                link_tracks=link_tracks,
                clip_index=broll_clip_index,
            )

    sequence.find("duration").text = str(total_frames)  # type: ignore[union-attr]  # made above

    rough = ET.tostring(xmeml, encoding="unicode")
    pretty = minidom.parseString(rough).toprettyxml(indent="  ")
    lines = [ln for ln in pretty.split("\n") if ln.strip()]
    body = "\n".join(lines)
    xml_string = '<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE xmeml>\n' + body[body.find("\n") + 1 :]
    return xml_string, warnings


def _db_for_volume(volume: float) -> float | None:
    """None means "no level filter needed" (unity gain)."""
    if volume == 1.0:
        return None
    if volume <= 0:
        return -96.0
    return round(20 * math.log10(volume), 2)


def _general_audio_channel_clip(
    track_el,
    clip_id,
    file_id,
    clip_name,
    fps,
    timeline_pos,
    clip_len,
    in_frames,
    out_frames,
    source_channel,
    link_entries,
    clip_index,
    write_file_element,
    file_kwargs,
    enabled=True,
):
    """Like `_add_audio_channel_clip`, but for `build_premiere_xml_timeline`: takes an explicit link
    entry list (2-way for an audio-only clip with no video sibling, 3-way otherwise) instead of
    always assuming a video/audio_l/audio_r triple, and can write the full <file> descriptor itself
    (needed when an audio-only track's clip is the first reference to its source file, since no video
    clipitem exists to have written it already)."""
    clip = ET.SubElement(track_el, "clipitem", id=clip_id)
    ET.SubElement(clip, "name").text = clip_name
    if not enabled:
        ET.SubElement(clip, "enabled").text = "FALSE"
    ET.SubElement(clip, "duration").text = str(clip_len)
    _rate_elem(clip, fps)
    ET.SubElement(clip, "start").text = str(timeline_pos)
    ET.SubElement(clip, "end").text = str(timeline_pos + clip_len)
    ET.SubElement(clip, "in").text = str(in_frames)
    ET.SubElement(clip, "out").text = str(out_frames)
    if write_file_element:
        _build_file_element(clip, file_id, clip_name, **file_kwargs)
    else:
        ET.SubElement(clip, "file", id=file_id)
    sourcetrack = ET.SubElement(clip, "sourcetrack")
    ET.SubElement(sourcetrack, "mediatype").text = "audio"
    ET.SubElement(sourcetrack, "trackindex").text = str(source_channel)
    _add_links(clip, link_entries, clip_index)
    return clip


def build_premiere_xml_timeline(
    sequence_name: str,
    fps: float,
    tracks: list,
    video_width: int = 1920,
    video_height: int = 1080,
    audio_sample_rate: int = 48000,
    audio_depth: int = 16,
    source_dims: dict | None = None,
    source_info: dict | None = None,
):
    """Builds a Premiere XML (XMEML) sequence directly from a general, multi-track timeline (e.g.
    VibeCut's own live timeline), independent of build_premiere_xml's "one main track + B-roll
    overlay" model above.

    `tracks`: ordered bottom-to-top (index 0 renders below every other video track -- the reverse of
    a "topmost track wins" UI convention). Each entry: {"type": "video" | "audio", "clips": [...]}.
    Each clip: {"source_path", "source_name", "start_time_seconds", "source_in_seconds",
    "source_out_seconds", "has_audio" (only consulted for a "video" track's clips -- an "audio"
    track's clips always carry sound), "volume" (linear gain, 1.0 = unity), "fade_in_seconds" and
    "fade_out_seconds" (optional, not represented in this export -- see below), and optionally
    "link_group" (clips sharing it are linked, so they move together in Premiere: a camera clip,
    its separately recorded sound and its own muted sound), "enabled" (False writes the clip
    switched off, at full level, so it can be switched back on) and "audio_channels" (the 1-based
    source channels to write, when not all of them).

    `source_info`: optional {source_path: {"has_video", "width", "height", "audio_channels",
    "sample_rate"}} as VibeCut probed each file. An audio-only file's <file> gets no video block, and
    every file its real channel count and sample rate. Without it a file is a 1920x1080 picture with
    stereo 48 kHz sound, as before.

    Unlike build_premiere_xml, every clip is placed at its own absolute timeline position (XMEML
    clipitems carry their own <start>/<end> frame numbers), so gaps between clips need no special
    handling, and no lane-scheduling is needed either: a VibeCut track's own clips never overlap by
    construction. Each clip's sound is written as one mono clipitem per source channel (Premiere
    imports a single channelcount=2 clipitem as mono), so a VibeCut track that carries sound becomes
    as many XMEML audio tracks as its widest clip has channels: two for stereo, one for a mono
    recorder, more for a poly WAV. Every clipitem of a link group links to every other one.

    Fades are not represented here (a real keyframed opacity/level ramp is a separate, larger
    undertaking) -- a clip with a fade produces a warning instead of being silently dropped.

    Returns (xml_string, warnings_list).
    """
    source_dims = source_dims or {}
    source_info = source_info or {}
    warnings: list[str] = []

    def info_for(path):
        return source_info.get(path) or {}

    def dims_for(path):
        return source_dims.get(path) or {k: v for k, v in info_for(path).items() if k in ("width", "height")}

    first_video_clip = next((c for t in tracks if t.get("type") == "video" for c in t.get("clips", [])), None)
    seq_dims = dims_for(first_video_clip["source_path"]) if first_video_clip else {}
    seq_width = seq_dims.get("width", video_width)
    seq_height = seq_dims.get("height", video_height)
    seq_par_num = seq_dims.get("par_num", 1)
    seq_par_den = seq_dims.get("par_den", 1)

    xmeml = ET.Element("xmeml", version="5")
    sequence = ET.SubElement(xmeml, "sequence", id=f"sequence-{_uid()}")
    ET.SubElement(sequence, "name").text = sequence_name
    ET.SubElement(sequence, "duration").text = "0"
    _rate_elem(sequence, fps)
    media = ET.SubElement(sequence, "media")

    video = ET.SubElement(media, "video")
    video_format = ET.SubElement(video, "format")
    vsc = ET.SubElement(video_format, "samplecharacteristics")
    _rate_elem(vsc, fps)
    ET.SubElement(vsc, "width").text = str(seq_width)
    ET.SubElement(vsc, "height").text = str(seq_height)
    _pixel_aspect_elems(vsc, seq_par_num, seq_par_den)

    audio = ET.SubElement(media, "audio")
    ET.SubElement(audio, "numOutputChannels").text = str(STEREO_CHANNELS)
    audio_format = ET.SubElement(audio, "format")
    asc = ET.SubElement(audio_format, "samplecharacteristics")
    ET.SubElement(asc, "depth").text = str(audio_depth)
    ET.SubElement(asc, "samplerate").text = str(audio_sample_rate)
    ET.SubElement(audio_format, "channelcount").text = str(STEREO_CHANNELS)

    def emitted_channels(clip):
        count = info_for(clip["source_path"]).get("audio_channels") or STEREO_CHANNELS
        count = max(1, min(int(count), MAX_EXPORT_CHANNELS))
        chosen = [ch for ch in clip.get("audio_channels") or [] if 1 <= ch <= count]
        return chosen or list(range(1, count + 1))

    file_id_cache: dict[str, str] = {}
    total_frames = 0
    video_track_index = 0
    audio_track_index = 0
    clip_counter = 0
    # Every clipitem written, per link group: (mediatype, id, xmeml track index, clipindex, element).
    groups: dict[str, list] = {}

    # `tracks` runs bottom-to-top, which is right for picture (V1 underneath), but audio tracks are
    # numbered top-down in every editor: VibeCut's A1 must be Premiere's A1, not its last track.
    ordered = [t for t in tracks if t.get("type") == "video"] + [
        t for t in reversed(tracks) if t.get("type") != "video"
    ]
    for track in ordered:
        # A clip with speed changes becomes consecutive pieces, each at one speed (Time Remap).
        clips = [piece for c in track.get("clips", []) for piece in speed_pieces(c, fps)]
        is_video_track = track.get("type") == "video"

        video_track_el = None
        this_video_index = None
        video_clip_count = 0
        if is_video_track:
            video_track_index += 1
            this_video_index = video_track_index
            video_track_el = ET.SubElement(video, "track")

        sounding = clips if not is_video_track else [c for c in clips if c.get("has_audio")]
        width = max((len(emitted_channels(c)) for c in sounding), default=0)
        audio_tracks: list[list[Any]] = []  # (element, xmeml index, clips written so far)
        for _ in range(width):
            audio_track_index += 1
            audio_tracks.append([ET.SubElement(audio, "track"), audio_track_index, 0])

        for clip in clips:
            if clip.get("fade_in_seconds") or clip.get("fade_out_seconds"):
                warnings.append(
                    f"Premiere: '{clip.get('source_name', 'Clip')}' has a fade, which this export does not represent."
                )
            if clip.get("transition_out"):
                warnings.append(
                    f"Premiere: the transition after '{clip.get('source_name', 'Clip')}' is not written; "
                    "the cut is exported as a straight cut (OTIO export keeps it)."
                )

            speed = clip.get("speed", 1.0)
            start_frame = max(0, round(clip["start_time_seconds"] * fps))
            if speed == 1.0:
                in_frames = max(0, round(clip["source_in_seconds"] * fps))
                out_frames = max(in_frames + 1, round(clip["source_out_seconds"] * fps))
                clip_len = out_frames - in_frames
            else:
                # A clip at another speed: like Premiere's own XML, <in>/<out> count frames of the
                # clip as retimed (source frames divided by the speed), and a Time Remap filter
                # carries the speed.
                end_frame = max(
                    start_frame + 1, round((clip["start_time_seconds"] + clip["length_seconds"]) * fps)
                )
                clip_len = end_frame - start_frame
                in_frames = max(0, round(clip["source_in_seconds"] * fps / speed))
                out_frames = in_frames + clip_len
            end_frame = start_frame + clip_len
            total_frames = max(total_frames, end_frame)

            source_path = clip["source_path"]
            clip_name = clip.get("source_name", "Clip")
            enabled = clip.get("enabled", True) is not False
            is_new_file = source_path not in file_id_cache
            if is_new_file:
                file_id_cache[source_path] = f"file-{_uid()}"
            file_id = file_id_cache[source_path]
            clip_counter += 1
            group = groups.setdefault(clip.get("link_group") or f"clip-{clip_counter}", [])

            info = info_for(source_path)
            dims = dims_for(source_path)
            file_kwargs = {
                "source_path": source_path,
                "fps": fps,
                "video_width": dims.get("width", video_width),
                "video_height": dims.get("height", video_height),
                "par_num": dims.get("par_num", 1),
                "par_den": dims.get("par_den", 1),
                "audio_sample_rate": info.get("sample_rate", audio_sample_rate),
                "audio_depth": audio_depth,
                "has_video": info.get("has_video", True),
                "audio_channels": info.get("audio_channels", STEREO_CHANNELS),
            }
            # The <file> element's full descriptor is written once, by whichever clipitem is the
            # first to reference this source path.
            file_written = not is_new_file

            if video_track_el is not None:
                video_clip_count += 1
                video_id = f"clipitem-V{clip_counter}-{_uid()}"
                v_clip = ET.SubElement(video_track_el, "clipitem", id=video_id)
                ET.SubElement(v_clip, "name").text = clip_name
                if not enabled:
                    ET.SubElement(v_clip, "enabled").text = "FALSE"
                ET.SubElement(v_clip, "duration").text = str(clip_len)
                _rate_elem(v_clip, fps)
                ET.SubElement(v_clip, "start").text = str(start_frame)
                ET.SubElement(v_clip, "end").text = str(end_frame)
                ET.SubElement(v_clip, "in").text = str(in_frames)
                ET.SubElement(v_clip, "out").text = str(out_frames)
                if not file_written:
                    _build_file_element(v_clip, file_id, clip_name, **file_kwargs)
                    file_written = True
                else:
                    ET.SubElement(v_clip, "file", id=file_id)
                if speed != 1.0:
                    _add_time_remap_filter(v_clip, speed, "video")
                group.append(("video", video_id, this_video_index, video_clip_count, v_clip))

            contributes_audio = (not is_video_track) or bool(clip.get("has_audio"))
            if not contributes_audio:
                continue
            # A clip switched off keeps its level, so switching it back on brings the sound back.
            db = _db_for_volume(clip.get("volume", 1.0)) if enabled else None
            for slot, channel in enumerate(emitted_channels(clip)):
                track_el, track_index, _ = audio_tracks[slot]
                audio_tracks[slot][2] += 1
                a_id = f"clipitem-A{clip_counter}c{channel}-{_uid()}"
                a_clip = _general_audio_channel_clip(
                    track_el,
                    a_id,
                    file_id,
                    clip_name,
                    fps,
                    start_frame,
                    clip_len,
                    in_frames,
                    out_frames,
                    source_channel=channel,
                    link_entries=(),
                    clip_index=audio_tracks[slot][2],
                    write_file_element=not file_written,
                    file_kwargs=file_kwargs,
                    enabled=enabled,
                )
                file_written = True
                if speed != 1.0:
                    _add_time_remap_filter(a_clip, speed, "audio")
                else:
                    # Premiere's own sub-frame source points: a synced recording's in point rarely falls
                    # on a frame, and rounding it would shift the sound by up to half a frame.
                    _add_ppro_ticks(
                        a_clip, clip["source_in_seconds"], clip["source_in_seconds"] + clip_len / fps
                    )
                if db is not None:
                    _add_audio_levels_filter(a_clip, db)
                group.append(("audio", a_id, track_index, audio_tracks[slot][2], a_clip))

    # Every clipitem of a group lists every member, itself included: that is how Premiere/FCP7 XML
    # represents "these move together" (see _add_links).
    for members in groups.values():
        if len(members) < 2:
            continue
        for _mediatype, _id, _track, _index, element in members:
            for mediatype, linkref, track_index, clip_index, _el in members:
                link = ET.SubElement(element, "link")
                ET.SubElement(link, "linkclipref").text = linkref
                ET.SubElement(link, "mediatype").text = mediatype
                ET.SubElement(link, "trackindex").text = str(track_index)
                ET.SubElement(link, "clipindex").text = str(clip_index)

    sequence.find("duration").text = str(total_frames)  # type: ignore[union-attr]  # made above

    rough = ET.tostring(xmeml, encoding="unicode")
    pretty = minidom.parseString(rough).toprettyxml(indent="  ")
    lines = [ln for ln in pretty.split("\n") if ln.strip()]
    body = "\n".join(lines)
    xml_string = '<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE xmeml>\n' + body[body.find("\n") + 1 :]
    return xml_string, warnings


def _add_time_remap_filter(clipitem_el, speed, mediatype):
    """Premiere/FCP7's constant speed change on a clipitem: the "Time Remap" motion filter with its
    speed in percent (Premiere writes the same filter on a clip set with Speed/Duration)."""
    filter_el = ET.SubElement(clipitem_el, "filter")
    effect = ET.SubElement(filter_el, "effect")
    ET.SubElement(effect, "name").text = "Time Remap"
    ET.SubElement(effect, "effectid").text = "timeremap"
    ET.SubElement(effect, "effectcategory").text = "motion"
    ET.SubElement(effect, "effecttype").text = "motion"
    ET.SubElement(effect, "mediatype").text = mediatype
    for parameter_id, value in (
        ("variablespeed", "0"),
        ("speed", f"{speed * 100:.4f}".rstrip("0").rstrip(".")),
        ("reverse", "FALSE"),
        ("frameblending", "FALSE"),
    ):
        parameter = ET.SubElement(effect, "parameter", authoringApp="PremierePro")
        ET.SubElement(parameter, "parameterid").text = parameter_id
        ET.SubElement(parameter, "name").text = parameter_id
        ET.SubElement(parameter, "value").text = value


# Premiere Pro's internal time base (ticks per second), used by its own XML for sub-frame positions.
PPRO_TICKS_PER_SECOND = 254016000000


def _add_ppro_ticks(clipitem_el, source_in_seconds, source_out_seconds):
    """Adds Premiere's <pproTicksIn>/<pproTicksOut> right after <out>, for a sample-accurate in point."""
    children = list(clipitem_el)
    out_el = clipitem_el.find("out")
    at = children.index(out_el) + 1 if out_el is not None else len(children)
    for offset, (tag, seconds) in enumerate(
        (("pproTicksIn", source_in_seconds), ("pproTicksOut", source_out_seconds))
    ):
        el = ET.Element(tag)
        el.text = str(round(max(0.0, seconds) * PPRO_TICKS_PER_SECOND))
        clipitem_el.insert(at + offset, el)


def _add_audio_channel_clip(
    track_el,
    clip_id,
    file_id,
    clip_name,
    fps,
    timeline_pos,
    clip_len,
    in_frames,
    out_frames,
    source_channel,
    link_ids,
    link_tracks,
    clip_index,
):
    clip = ET.SubElement(track_el, "clipitem", id=clip_id)
    ET.SubElement(clip, "name").text = clip_name
    ET.SubElement(clip, "duration").text = str(clip_len)
    _rate_elem(clip, fps)
    ET.SubElement(clip, "start").text = str(timeline_pos)
    ET.SubElement(clip, "end").text = str(timeline_pos + clip_len)
    ET.SubElement(clip, "in").text = str(in_frames)
    ET.SubElement(clip, "out").text = str(out_frames)
    ET.SubElement(clip, "file", id=file_id)
    sourcetrack = ET.SubElement(clip, "sourcetrack")
    ET.SubElement(sourcetrack, "mediatype").text = "audio"
    ET.SubElement(sourcetrack, "trackindex").text = str(source_channel)
    _add_stereo_links(clip, link_ids, link_tracks, clip_index)
    return clip


def _build_file_element(
    parent,
    file_id,
    clip_name,
    source_path,
    fps,
    video_width,
    video_height,
    par_num,
    par_den,
    audio_sample_rate,
    audio_depth,
    has_video=True,
    audio_channels=STEREO_CHANNELS,
):
    """A source file's full <file> descriptor. `has_video=False` (a sound recorder's WAV) leaves out
    the picture block, and `audio_channels` is the file's real channel count."""
    file_el = ET.SubElement(parent, "file", id=file_id)
    ET.SubElement(file_el, "name").text = clip_name
    ET.SubElement(file_el, "pathurl").text = _to_pathurl(source_path)
    _rate_elem(file_el, fps)
    fmedia = ET.SubElement(file_el, "media")

    if has_video:
        fvideo = ET.SubElement(fmedia, "video")
        fvchar = ET.SubElement(fvideo, "samplecharacteristics")
        ET.SubElement(fvchar, "width").text = str(video_width)
        ET.SubElement(fvchar, "height").text = str(video_height)
        _pixel_aspect_elems(fvchar, par_num, par_den)

    faudio = ET.SubElement(fmedia, "audio")
    fachar = ET.SubElement(faudio, "samplecharacteristics")
    ET.SubElement(fachar, "depth").text = str(audio_depth)
    ET.SubElement(fachar, "samplerate").text = str(audio_sample_rate)
    ET.SubElement(faudio, "channelcount").text = str(audio_channels)


def _add_links(clipitem_el, entries, clip_index):
    """Writes one <link> per (mediatype, linkref, track_index) entry -- the same entry list is
    written identically onto every clipitem in the linked group (that's how Premiere/FCP7 XML
    represents "these clipitems move together": each one lists every member, itself included)."""
    for mediatype, linkref, track_index in entries:
        link = ET.SubElement(clipitem_el, "link")
        ET.SubElement(link, "linkclipref").text = linkref
        ET.SubElement(link, "mediatype").text = mediatype
        ET.SubElement(link, "trackindex").text = str(track_index)
        ET.SubElement(link, "clipindex").text = str(clip_index)


def _add_stereo_links(clipitem_el, link_ids, link_tracks, clip_index):
    video_id, audio_l_id, audio_r_id = link_ids
    video_track, audio_l_track, audio_r_track = link_tracks
    _add_links(
        clipitem_el,
        (
            ("video", video_id, video_track),
            ("audio", audio_l_id, audio_l_track),
            ("audio", audio_r_id, audio_r_track),
        ),
        clip_index,
    )


def _to_pathurl(path: str) -> str:
    abspath = os.path.abspath(path)
    normalized = abspath.replace(os.sep, "/")
    if not normalized.startswith("/"):
        normalized = "/" + normalized
    return "file://localhost" + normalized
