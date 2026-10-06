"""
tests/test_xml_builder_timeline.py

Unit tests for xml_builder.py's build_premiere_xml_timeline: the general, multi-track exporter used
by VibeCut's "Export…" feature to export the CURRENT, hand-edited timeline (as opposed to
build_premiere_xml, which only understands the narrow "one main track + B-roll overlay" model an
Auto-Cut/Story Editor result produces). Output is parsed back with ElementTree rather than
string-matched, so assertions survive pretty-printing changes.
"""

import xml.etree.ElementTree as ET

import pytest

from vibecut_agent.nle.interchange.xml_builder import build_premiere_xml_timeline


def video_clip(name="A", path="/m/a.mov", start=0.0, in_s=0.0, out_s=2.0, has_audio=False, volume=1.0):
    return {
        "source_path": path,
        "source_name": name,
        "start_time_seconds": start,
        "source_in_seconds": in_s,
        "source_out_seconds": out_s,
        "has_audio": has_audio,
        "volume": volume,
    }


def audio_clip(name="music", path="/m/music.mp3", start=0.0, in_s=0.0, out_s=5.0, volume=1.0):
    return {
        "source_path": path,
        "source_name": name,
        "start_time_seconds": start,
        "source_in_seconds": in_s,
        "source_out_seconds": out_s,
        "volume": volume,
    }


def test_gaps_between_clips_need_no_special_handling():
    tracks = [
        {
            "type": "video",
            "clips": [video_clip(start=0.0, out_s=1.0), video_clip(name="B", start=5.0, in_s=5.0, out_s=6.0)],
        }
    ]
    xml_string, warnings = build_premiere_xml_timeline("Seq", 25.0, tracks)
    assert warnings == []
    root = ET.fromstring(xml_string)
    clips = root.find("sequence/media/video/track").findall("clipitem")
    assert [c.find("start").text for c in clips] == ["0", "125"]
    assert [c.find("end").text for c in clips] == ["25", "150"]
    assert root.find("sequence/duration").text == "150"


def test_each_vibecut_track_maps_to_its_own_output_track_in_order():
    tracks = [
        {"type": "video", "clips": [video_clip(name="Bottom")]},
        {"type": "video", "clips": [video_clip(name="Top", path="/m/b.mov")]},
    ]
    xml_string, _ = build_premiere_xml_timeline("Seq", 25.0, tracks)
    root = ET.fromstring(xml_string)
    video_tracks = root.find("sequence/media/video").findall("track")
    assert len(video_tracks) == 2
    assert video_tracks[0].find("clipitem/name").text == "Bottom"
    assert video_tracks[1].find("clipitem/name").text == "Top"


def test_video_clip_without_audio_gets_no_link_and_no_audio_track():
    tracks = [{"type": "video", "clips": [video_clip(has_audio=False)]}]
    xml_string, _ = build_premiere_xml_timeline("Seq", 25.0, tracks)
    root = ET.fromstring(xml_string)
    clip = root.find("sequence/media/video/track/clipitem")
    assert clip.findall("link") == []
    assert root.find("sequence/media/audio").findall("track") == []


def test_video_clip_with_audio_gets_two_linked_mono_audio_clips_not_channelcount_two():
    tracks = [{"type": "video", "clips": [video_clip(has_audio=True)]}]
    xml_string, _ = build_premiere_xml_timeline("Seq", 25.0, tracks)
    root = ET.fromstring(xml_string)
    audio_tracks = root.find("sequence/media/audio").findall("track")
    assert len(audio_tracks) == 2
    assert audio_tracks[0].find("clipitem/sourcetrack/trackindex").text == "1"
    assert audio_tracks[1].find("clipitem/sourcetrack/trackindex").text == "2"
    for clip in root.iter("clipitem"):
        assert clip.find("channelcount") is None
    video_clip_el = root.find("sequence/media/video/track/clipitem")
    links = {(l.find("mediatype").text, l.find("trackindex").text) for l in video_clip_el.findall("link")}
    assert links == {("video", "1"), ("audio", "1"), ("audio", "2")}


def test_standalone_audio_track_clip_links_only_to_its_own_channel_pair():
    tracks = [{"type": "audio", "clips": [audio_clip()]}]
    xml_string, _ = build_premiere_xml_timeline("Seq", 25.0, tracks)
    root = ET.fromstring(xml_string)
    assert root.find("sequence/media/video/track") is None
    audio_tracks = root.find("sequence/media/audio").findall("track")
    assert len(audio_tracks) == 2
    left = audio_tracks[0].find("clipitem")
    right = audio_tracks[1].find("clipitem")
    # The first reference to this source file must carry the full <file> descriptor since no video
    # clipitem exists to have written it.
    assert left.find("file/pathurl") is not None
    assert right.find("file/pathurl") is None
    assert right.find("file").get("id") == left.find("file").get("id")
    links = {(l.find("mediatype").text, l.find("trackindex").text) for l in left.findall("link")}
    assert links == {("audio", "1"), ("audio", "2")}


def test_audio_track_indices_continue_after_a_video_tracks_own_audio_pair():
    tracks = [
        {"type": "video", "clips": [video_clip(has_audio=True)]},
        {"type": "audio", "clips": [audio_clip()]},
    ]
    xml_string, _ = build_premiere_xml_timeline("Seq", 25.0, tracks)
    root = ET.fromstring(xml_string)
    audio_tracks = root.find("sequence/media/audio").findall("track")
    assert len(audio_tracks) == 4
    music_left = audio_tracks[2].find("clipitem")
    links = {(l.find("mediatype").text, l.find("trackindex").text) for l in music_left.findall("link")}
    assert links == {("audio", "3"), ("audio", "4")}


def test_volume_becomes_an_audio_levels_filter_matching_the_linear_gain():
    tracks = [{"type": "audio", "clips": [audio_clip(volume=0.5)]}]
    xml_string, _ = build_premiere_xml_timeline("Seq", 25.0, tracks)
    root = ET.fromstring(xml_string)
    left, right = root.find("sequence/media/audio").findall("track")
    for track in (left, right):
        value = float(track.find("clipitem/filter/effect/parameter/value").text)
        assert value == pytest.approx(0.5, abs=1e-3)


def test_unity_volume_gets_no_filter_at_all():
    tracks = [{"type": "audio", "clips": [audio_clip(volume=1.0)]}]
    xml_string, _ = build_premiere_xml_timeline("Seq", 25.0, tracks)
    root = ET.fromstring(xml_string)
    for track in root.find("sequence/media/audio").findall("track"):
        assert track.find("clipitem/filter") is None


def test_a_fade_is_reported_as_a_warning_not_represented():
    tracks = [{"type": "video", "clips": [{**video_clip(), "fade_in_seconds": 0.5}]}]
    _, warnings = build_premiere_xml_timeline("Seq", 25.0, tracks)
    assert len(warnings) == 1
    assert "fade" in warnings[0]


def test_multiple_clips_reusing_the_same_source_file_share_one_file_id():
    tracks = [
        {
            "type": "video",
            "clips": [
                video_clip(name="A1", start=0.0, out_s=1.0),
                video_clip(name="A2", start=2.0, in_s=1.0, out_s=2.0),
            ],
        }
    ]
    xml_string, _ = build_premiere_xml_timeline("Seq", 25.0, tracks)
    root = ET.fromstring(xml_string)
    clips = root.find("sequence/media/video/track").findall("clipitem")
    assert clips[0].find("file").get("id") == clips[1].find("file").get("id")
    assert clips[1].find("file/pathurl") is None  # only the first clip carries the full descriptor
