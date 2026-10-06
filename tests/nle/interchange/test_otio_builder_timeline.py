"""
tests/test_otio_builder_timeline.py

Unit tests for otio_builder.py's build_otio_timeline: the general, multi-track exporter used by
VibeCut's "Export…" feature to export the CURRENT, hand-edited timeline. Unlike build_otio (one main
track + B-roll lanes), every VibeCut track becomes its own independent OTIO Track, in stacking order,
with a Gap inserted wherever a track has empty space.
"""

import json

import pytest

from vibecut_agent.nle.interchange.otio_builder import build_otio_timeline


def clip(name="A", path="/m/a.mov", start=0.0, in_s=0.0, out_s=2.0, has_audio=False, volume=1.0):
    return {
        "source_path": path,
        "source_name": name,
        "start_time_seconds": start,
        "source_in_seconds": in_s,
        "source_out_seconds": out_s,
        "has_audio": has_audio,
        "volume": volume,
    }


def _stack(otio_json):
    return json.loads(otio_json)["tracks"]


def test_requires_at_least_one_clip():
    with pytest.raises(ValueError):
        build_otio_timeline("Seq", 25.0, [])
    with pytest.raises(ValueError):
        build_otio_timeline("Seq", 25.0, [{"type": "video", "clips": []}])


def test_each_vibecut_track_becomes_its_own_independent_otio_track():
    tracks = [
        {"type": "video", "clips": [clip(name="Bottom")]},
        {"type": "video", "clips": [clip(name="Top", path="/m/b.mov")]},
        {"type": "audio", "clips": [clip(name="music", path="/m/m.mp3")]},
    ]
    otio_json, warnings = build_otio_timeline("Seq", 25.0, tracks)
    assert warnings == []
    stack = _stack(otio_json)
    names = [(t["name"], t["kind"]) for t in stack["children"]]
    assert names == [("V1", "Video"), ("V2", "Video"), ("A1", "Audio")]
    assert stack["children"][0]["children"][0]["name"] == "Bottom"
    assert stack["children"][1]["children"][0]["name"] == "Top"
    assert stack["children"][2]["children"][0]["name"] == "music"


def test_a_gap_is_inserted_before_a_clip_that_does_not_start_at_zero():
    tracks = [{"type": "video", "clips": [clip(start=2.0, in_s=2.0, out_s=3.0)]}]
    otio_json, _ = build_otio_timeline("Seq", 25.0, tracks)
    children = _stack(otio_json)["children"][0]["children"]
    assert children[0]["OTIO_SCHEMA"] == "Gap.1"
    assert children[0]["source_range"]["duration"]["value"] == 50  # 2s at 25fps
    assert children[1]["OTIO_SCHEMA"] == "Clip.1"


def test_a_gap_is_inserted_between_two_clips_on_the_same_track():
    tracks = [
        {
            "type": "video",
            "clips": [clip(name="A", start=0.0, out_s=1.0), clip(name="B", start=3.0, in_s=3.0, out_s=4.0)],
        }
    ]
    otio_json, _ = build_otio_timeline("Seq", 25.0, tracks)
    kinds = [c["OTIO_SCHEMA"] for c in _stack(otio_json)["children"][0]["children"]]
    assert kinds == ["Clip.1", "Gap.1", "Clip.1"]


def test_video_clip_audio_flag_and_volume_are_recorded_as_metadata():
    tracks = [{"type": "video", "clips": [clip(has_audio=True, volume=0.5)]}]
    otio_json, _ = build_otio_timeline("Seq", 25.0, tracks)
    meta = _stack(otio_json)["children"][0]["children"][0]["metadata"]["rough_cut_studio"]
    assert meta == {"has_audio": True, "volume": 0.5}


def test_video_clip_without_audio_records_no_volume():
    tracks = [{"type": "video", "clips": [clip(has_audio=False)]}]
    otio_json, _ = build_otio_timeline("Seq", 25.0, tracks)
    meta = _stack(otio_json)["children"][0]["children"][0]["metadata"]["rough_cut_studio"]
    assert meta == {"has_audio": False}


def test_audio_track_clip_always_records_has_audio_true():
    tracks = [{"type": "audio", "clips": [clip(name="music", path="/m/m.mp3")]}]
    otio_json, _ = build_otio_timeline("Seq", 25.0, tracks)
    meta = _stack(otio_json)["children"][0]["children"][0]["metadata"]["rough_cut_studio"]
    assert meta["has_audio"] is True


def test_a_fade_is_recorded_as_metadata_and_reported_as_a_warning():
    tracks = [{"type": "video", "clips": [{**clip(), "fade_in_seconds": 0.5}]}]
    otio_json, warnings = build_otio_timeline("Seq", 25.0, tracks)
    assert len(warnings) == 1
    assert "fade" in warnings[0]
    meta = _stack(otio_json)["children"][0]["children"][0]["metadata"]["rough_cut_studio"]
    assert meta["fade_in_seconds"] == 0.5


def test_a_transition_on_a_cut_becomes_an_otio_transition_between_the_two_clips():
    first = clip(name="A", out_s=4.0)
    first["transition_out"] = {"kind": "dissolve", "seconds": 1.0}
    second = clip(name="B", path="/m/b.mov", start=4.0, in_s=1.0, out_s=3.0)
    otio_json, warnings = build_otio_timeline("Seq", 25.0, [{"type": "video", "clips": [first, second]}])
    assert warnings == []
    children = _stack(otio_json)["children"][0]["children"]
    assert [c["OTIO_SCHEMA"] for c in children] == ["Clip.1", "Transition.1", "Clip.1"]
    transition = children[1]
    assert transition["transition_type"] == "SMPTE_Dissolve"
    assert transition["name"] == "Cross Dissolve"
    # Centred: half a second (12.5 frames, rounded) either side of the cut.
    assert transition["in_offset"]["value"] == transition["out_offset"]["value"] == 12


def test_a_dip_to_black_is_a_custom_transition_with_its_kind_in_metadata():
    first = clip(name="A")
    first["transition_out"] = {"kind": "dipToBlack", "seconds": 0.4}
    second = clip(name="B", start=2.0)
    otio_json, _ = build_otio_timeline("Seq", 25.0, [{"type": "video", "clips": [first, second]}])
    transition = _stack(otio_json)["children"][0]["children"][1]
    assert transition["transition_type"] == "Custom_Transition"
    assert transition["metadata"]["rough_cut_studio"]["kind"] == "dipToBlack"


def test_a_transition_with_a_gap_after_it_is_not_written():
    first = clip(name="A")
    first["transition_out"] = {"kind": "dissolve", "seconds": 1.0}
    otio_json, _ = build_otio_timeline(
        "Seq", 25.0, [{"type": "video", "clips": [first, clip(name="B", start=3.0)]}]
    )
    schemas = [c["OTIO_SCHEMA"] for c in _stack(otio_json)["children"][0]["children"]]
    assert schemas == ["Clip.1", "Gap.1", "Clip.1"]


def test_source_ranges_sit_in_the_files_own_timecode_when_it_is_known():
    tracks = [{"type": "video", "clips": [clip(in_s=1.0, out_s=3.0)]}]
    info = {"/m/a.mov": {"start_timecode_seconds": 3600.0, "duration_seconds": 10.0}}
    otio_json, _ = build_otio_timeline("Seq", 25.0, tracks, source_info=info)
    otio_clip = _stack(otio_json)["children"][0]["children"][0]
    assert otio_clip["source_range"]["start_time"]["value"] == 3600 * 25 + 25
    assert otio_clip["source_range"]["duration"]["value"] == 50
    available = otio_clip["media_reference"]["available_range"]
    assert (available["start_time"]["value"], available["duration"]["value"]) == (3600 * 25, 250)


def test_without_a_known_timecode_source_ranges_count_from_zero():
    tracks = [{"type": "video", "clips": [clip(in_s=1.0, out_s=3.0)]}]
    otio_json, _ = build_otio_timeline("Seq", 25.0, tracks, source_info={"/m/a.mov": {"has_video": True}})
    otio_clip = _stack(otio_json)["children"][0]["children"][0]
    assert otio_clip["source_range"]["start_time"]["value"] == 25
    assert otio_clip["media_reference"]["available_range"] is None


def test_a_retimed_piece_is_placed_in_the_files_timecode_too():
    retimed = {**clip(in_s=10.0, out_s=14.0), "time_map": [(0.0, 10.0), (2.0, 14.0)]}
    info = {"/m/a.mov": {"start_timecode_seconds": 100.0}}
    otio_json, _ = build_otio_timeline("Seq", 25.0, [{"type": "video", "clips": [retimed]}], source_info=info)
    otio_clip = _stack(otio_json)["children"][0]["children"][0]
    assert otio_clip["effects"][0]["time_scalar"] == 2.0
    assert otio_clip["source_range"]["start_time"]["value"] == (100 + 10) * 25


def test_target_url_is_the_plain_path_because_resolve_rejects_percent_encoding():
    tracks = [{"type": "video", "clips": [clip(path="/Volumes/Drive/ Current/Piano - 0926/a b.mov")]}]
    otio_json, _ = build_otio_timeline("Seq", 25.0, tracks)
    reference = _stack(otio_json)["children"][0]["children"][0]["media_reference"]
    assert reference["target_url"] == "file:///Volumes/Drive/ Current/Piano - 0926/a b.mov"
    assert reference["name"] == "A"


def test_a_video_clips_own_sound_gets_an_audio_track_after_vibecuts_audio_tracks():
    # Resolve imports a Video track's clips as picture only (round-trip check, Resolve 21.1), so the
    # sound needs an Audio track of its own; VibeCut's A1 stays A1.
    tracks = [
        {"type": "audio", "clips": [clip(name="music", path="/m/m.mp3", out_s=6.0)]},
        {
            "type": "video",
            "clips": [
                clip(name="A", has_audio=True, volume=0.5),
                clip(name="B", start=4.0, in_s=1.0, out_s=2.0),
            ],
        },
    ]
    otio_json, warnings = build_otio_timeline("Seq", 25.0, tracks)
    assert warnings == []
    stack = _stack(otio_json)["children"]
    assert [(t["name"], t["kind"]) for t in stack] == [("V1", "Video"), ("A1", "Audio"), ("A2", "Audio")]
    assert stack[1]["children"][0]["name"] == "music"
    sound = stack[2]["children"]
    assert [c["OTIO_SCHEMA"] for c in sound] == ["Clip.1"]  # B has no sound, so nothing after A
    assert sound[0]["name"] == "A"
    assert sound[0]["source_range"] == stack[0]["children"][0]["source_range"]
    assert sound[0]["metadata"]["rough_cut_studio"]["volume"] == 0.5


def test_a_video_track_without_sound_gets_no_audio_track():
    otio_json, _ = build_otio_timeline("Seq", 25.0, [{"type": "video", "clips": [clip(has_audio=False)]}])
    assert [t["kind"] for t in _stack(otio_json)["children"]] == ["Video"]


def test_the_sound_track_keeps_gaps_and_a_faded_clip_warns_once():
    tracks = [
        {
            "type": "video",
            "clips": [
                {**clip(name="A", has_audio=True, out_s=1.0), "fade_in_seconds": 0.5},
                clip(name="B", start=3.0, in_s=3.0, out_s=4.0, has_audio=True),
            ],
        }
    ]
    otio_json, warnings = build_otio_timeline("Seq", 25.0, tracks)
    assert len(warnings) == 1
    sound = _stack(otio_json)["children"][1]
    assert [c["OTIO_SCHEMA"] for c in sound["children"]] == ["Clip.1", "Gap.1", "Clip.1"]


def _resolve_volume_db(otio_clip):
    effect = next(e for e in otio_clip["effects"] if e.get("effect_name") == "Resolve Effect")
    return effect["metadata"]["Resolve_OTIO"]["Parameters"][0]["Parameter Value"]


def test_a_sound_clips_level_is_written_as_resolves_volume_effect():
    # Resolve's OTIO import reads the level only from this effect, the shape its own export writes.
    tracks = [
        {
            "type": "audio",
            "clips": [
                clip(name="music", path="/m/m.mp3", volume=0.5),
                clip(name="vo", path="/m/v.wav", start=3.0),
            ],
        },
        {"type": "video", "clips": [clip(name="A", has_audio=True, volume=0.5)]},
    ]
    stack = _stack(build_otio_timeline("Seq", 25.0, tracks)[0])["children"]
    music, vo = stack[1]["children"][0], stack[1]["children"][2]
    assert _resolve_volume_db(music) == pytest.approx(-6.0206, abs=1e-3)
    assert vo["effects"] == []  # unity gain needs no effect
    assert stack[0]["children"][0]["effects"] == []  # the picture carries no level
    assert _resolve_volume_db(stack[2]["children"][0]) == pytest.approx(-6.0206, abs=1e-3)


def test_a_switched_off_clip_gets_no_volume_effect():
    tracks = [{"type": "audio", "clips": [{**clip(path="/m/m.mp3", volume=0.0), "enabled": False}]}]
    otio_clip = _stack(build_otio_timeline("Seq", 25.0, tracks)[0])["children"][0]["children"][0]
    assert otio_clip["enabled"] is False
    assert otio_clip["effects"] == []


def _link_id(otio_clip):
    return otio_clip["metadata"].get("Resolve_OTIO", {}).get("Link Group ID")


def test_each_picture_is_linked_to_its_own_sound_and_nothing_else():
    tracks = [
        {
            "type": "video",
            "clips": [
                clip(name="A", has_audio=True, out_s=1.0),
                clip(name="B", start=2.0, has_audio=True, out_s=1.0),
                clip(name="C", start=4.0, has_audio=False, out_s=1.0),
            ],
        }
    ]
    stack = _stack(build_otio_timeline("Seq", 25.0, tracks)[0])["children"]
    picture = [c for c in stack[0]["children"] if c["OTIO_SCHEMA"] == "Clip.1"]
    sound = [c for c in stack[1]["children"] if c["OTIO_SCHEMA"] == "Clip.1"]
    assert [_link_id(c) for c in picture] == [1, 2, None]
    assert [_link_id(c) for c in sound] == [1, 2]


def test_a_link_group_links_picture_recording_and_muted_camera_sound():
    base = {"start_time_seconds": 2.0, "link_group": "L1"}
    tracks = [
        {
            "type": "audio",
            "clips": [
                {**clip(name="A", path="/m/a.mov", in_s=5.0, out_s=9.0, volume=0.0), **base, "enabled": False}
            ],
        },
        {
            "type": "audio",
            "clips": [{**clip(name="ROLL", path="/m/roll.wav", in_s=12.0, out_s=16.0), **base}],
        },
        {"type": "video", "clips": [{**clip(name="A", path="/m/a.mov", in_s=5.0, out_s=9.0), **base}]},
    ]
    stack = _stack(build_otio_timeline("Seq", 25.0, tracks)[0])["children"]
    clips = [c for t in stack for c in t["children"] if c["OTIO_SCHEMA"] == "Clip.1"]
    assert len(clips) == 3
    assert {_link_id(c) for c in clips} == {1}


def test_back_to_back_cuts_with_half_frame_source_points_leave_no_gap():
    # Source in points on half frames (0.02s at 25 fps): rounding in and out separately rounded
    # 95.5 -> 96 and 182.5 -> 182, a frame short, which Resolve showed as a one-frame black gap.
    tracks = [
        {
            "type": "video",
            "clips": [
                clip(start=0.0, in_s=0.02, out_s=3.78),
                clip(start=3.76, in_s=3.82, out_s=7.30),
                clip(start=7.24, in_s=7.30, out_s=11.02),
            ],
        }
    ]
    otio_json, _ = build_otio_timeline("Seq", 25.0, tracks)
    children = _stack(otio_json)["children"][0]["children"]
    assert [c["OTIO_SCHEMA"] for c in children] == ["Clip.1"] * 3
    assert [round(c["source_range"]["duration"]["value"]) for c in children] == [94, 87, 93]
