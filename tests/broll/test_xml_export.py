"""
tests/test_xml_export.py
Unit tests for xml_export.py's frame/timecode math -- specifically that
export_xml()'s timeline-clipitem builders (_track_clipitem_xml /
_track_clipitem_xml_audio) use a single, uniform frame rate (the
SEQUENCE's rate) for every field of a timeline clipitem, regardless of
a given clip's own native frame rate.

This was confirmed the hard way: an earlier version tried expressing a
clipitem's <in>/<out>/<duration>/<rate> at the clip's own native rate
(to match its <file> block) while keeping <start>/<end> at the
sequence's rate. That produced clips that showed up in a real Premiere
Pro import with the diagonal-hash "insufficient media" warning -- turns
out Premiere reads a clipitem's <in>/<out> at the SEQUENCE's rate
regardless of what the clipitem's own <rate> (or its file's native
rate) declares, so mixing rates within one clipitem made the requested
in/out range resolve to a longer real-world duration than the source
file actually has. These tests pin the reverted, Premiere-verified
behavior so it doesn't drift back.

export_xml() (and _file_url underneath it) never opens or requires the
source media file to exist on disk -- it only does path string
manipulation and frame-count arithmetic -- so these tests build
ClipResult objects by hand (paths that don't exist are fine) and write
into pytest's `tmp_path` fixture. No real video files, ffmpeg, or GPU/
CLIP model needed.
"""

import re
import xml.etree.ElementTree as ET

from vibecut_agent.broll.analyzer import ClipResult, Segment
from vibecut_agent.broll.xml_export import export_xml, start_timecodes


def make_clip_result(**overrides):
    defaults = {
        "path": "/videos/clip.mp4",
        "filename": "clip.mp4",
        "duration": 10.0,
        "fps": 24.0,
        "width": 1920,
        "height": 1080,
        "overall_score": 80.0,
        "segments": [Segment(start=0.0, end=2.0, score=90.0)],
        "audio_channels": 2,
        "audio_samplerate": 48000,
        "audio_bit_depth": 16,
        "audio_channel_layout": "Stereo",
    }
    defaults.update(overrides)
    return ClipResult(**defaults)


def _extract_clipitem_block(xml_text: str, item_id: str) -> str:
    """Pull out a single <clipitem id="..."> ... </clipitem> block by id.
    Simple string/regex extraction is sufficient here -- no need for a
    full XML parser just to locate one element."""
    match = re.search(rf'<clipitem id="{re.escape(item_id)}">.*?</clipitem>', xml_text, re.DOTALL)
    assert match is not None, f"clipitem {item_id!r} not found in XML"
    return match.group(0)


def _field(block: str, tag: str) -> str:
    match = re.search(rf"<{tag}>(.*?)</{tag}>", block, re.DOTALL)
    assert match is not None, f"<{tag}> not found in block:\n{block}"
    return match.group(1)


class TestMixedFrameRateTimelinePlacement:
    """The batch's sequence_fps is chosen by majority vote across clips
    (see export_xml). Every clipitem on the sequence's track -- even one
    whose own native fps differs from that majority rate -- must have
    ALL of its own fields (<rate>, <in>, <out>, <duration>, <start>,
    <end>) expressed uniformly in the SEQUENCE's rate. Only the bin's
    master-clip <file> definition (a separate, non-timeline element)
    carries the clip's true native rate."""

    def test_odd_rate_clip_uses_sequence_fps_throughout_its_clipitem(self, tmp_path):
        # Two 24fps clips (majority) + one 30fps clip -> sequence_fps
        # resolves to 24.0. Each clip has a single 0.0-2.0s segment.
        clip_a = make_clip_result(path="/videos/a.mp4", filename="a.mp4", fps=24.0)
        clip_b = make_clip_result(path="/videos/b.mp4", filename="b.mp4", fps=24.0)
        clip_c = make_clip_result(path="/videos/c.mp4", filename="c.mp4", fps=30.0)

        output_path = str(tmp_path / "out.xml")
        export_xml([clip_a, clip_b, clip_c], output_path)

        with open(output_path, encoding="utf-8") as f:
            xml_text = f.read()

        # clip_c is the 3rd clip (idx=2) with its one segment (seg_idx=0)
        # -> item id "clipitem-3-1".
        block = _extract_clipitem_block(xml_text, "clipitem-3-1")

        # <in>/<out> must be computed at the SEQUENCE's rate (24fps),
        # not clip_c's own 30fps native rate: 0.0s -> 0, 2.0s -> 48
        # frames. Using 30fps here (0 -> 60) is exactly what caused
        # Premiere to report "insufficient media" on import.
        assert _field(block, "in") == "0"
        assert _field(block, "out") == "48"

        # This clipitem's own <rate> matches the sequence's rate, not
        # the clip's native rate -- consistent with <in>/<out> above.
        assert "<timebase>24</timebase>" in block

        # <start>/<end> describe this item's position on the shared
        # sequence timeline. The two preceding 24fps clips each occupy
        # a 2.0s segment = 48 timeline frames, so clip_c starts at 96
        # and, being a 2.0s segment at the same 24fps, ends at 144.
        assert _field(block, "start") == "96"
        assert _field(block, "end") == "144"

    def test_majority_rate_clips_are_internally_consistent(self, tmp_path):
        # Sanity check: for a clip whose native fps matches sequence_fps,
        # everything naturally agrees -- included just to pin the
        # "normal" (non-mixed) case alongside the odd-rate one above.
        clip_a = make_clip_result(path="/videos/a.mp4", filename="a.mp4", fps=24.0)
        clip_b = make_clip_result(path="/videos/b.mp4", filename="b.mp4", fps=24.0)
        clip_c = make_clip_result(path="/videos/c.mp4", filename="c.mp4", fps=30.0)

        output_path = str(tmp_path / "out2.xml")
        export_xml([clip_a, clip_b, clip_c], output_path)

        with open(output_path, encoding="utf-8") as f:
            xml_text = f.read()

        block = _extract_clipitem_block(xml_text, "clipitem-1-1")
        assert _field(block, "in") == "0"
        assert _field(block, "out") == "48"
        assert _field(block, "start") == "0"
        assert _field(block, "end") == "48"
        assert "<timebase>24</timebase>" in block

    def test_bin_file_definition_still_carries_the_clips_true_native_rate(self, tmp_path):
        # The bin's master-clip <file> block is a separate element from
        # the timeline clipitem -- it should still describe clip_c's
        # real 30fps, since that's informational metadata about the
        # source file, not a timeline placement value.
        clip_a = make_clip_result(path="/videos/a.mp4", filename="a.mp4", fps=24.0)
        clip_b = make_clip_result(path="/videos/b.mp4", filename="b.mp4", fps=24.0)
        clip_c = make_clip_result(path="/videos/c.mp4", filename="c.mp4", fps=30.0)

        output_path = str(tmp_path / "out3.xml")
        export_xml([clip_a, clip_b, clip_c], output_path)

        with open(output_path, encoding="utf-8") as f:
            xml_text = f.read()

        bin_block_match = re.search(r'<clip id="masterclip-3">.*?</clip>', xml_text, re.DOTALL)
        assert bin_block_match is not None
        assert "<timebase>30</timebase>" in bin_block_match.group(0)


class TestResolveLinking:
    """What DaVinci Resolve's File > Import > Timeline needs to link the sources (Phase 16a, seen
    live): each file's own start timecode, and a path URL that reads back exactly."""

    def test_the_path_is_percent_encoded_under_file_localhost(self, tmp_path):
        # "e" + combining accent (as macOS may hand it over) is written as the composed é.
        clip = make_clip_result(path="/Vol/Rough Cut #2/Shot 100%/cafe\u0301.mov", filename="café.mov")
        out = str(tmp_path / "x.xml")
        export_xml([clip], out)
        (url,) = [p.text for p in ET.parse(out).getroot().iter("pathurl")]
        assert url == "file://localhost/Vol/Rough%20Cut%20%232/Shot%20100%25/caf%C3%A9.mov"

    def test_each_file_carries_its_own_start_timecode_and_clipitems_stay_relative(self, tmp_path):
        camera = make_clip_result(
            path="/v/cam.mov", filename="cam.mov", fps=25.0, segments=[Segment(start=2.0, end=4.0, score=0)]
        )
        plain = make_clip_result(path="/v/plain.mov", filename="plain.mov", fps=25.0)
        out = str(tmp_path / "x.xml")
        starts = {"/v/cam.mov": {"seconds": 50602.0, "timecode": "14:03:22:00"}}
        export_xml([camera, plain], out, timecodes=starts)
        root = ET.parse(out).getroot()
        files = {f.find("name").text: f for f in root.iter("file") if f.find("name") is not None}
        assert files["cam.mov"].find("timecode/string").text == "14:03:22:00"
        assert files["cam.mov"].find("timecode/frame").text == str(50602 * 25)
        assert files["plain.mov"].find("timecode/string").text == "00:00:00:00"
        first = root.find("project/children/sequence/media/video/track/clipitem")
        assert (first.find("in").text, first.find("out").text) == ("50", "100")

    def test_a_drop_frame_start_is_kept_as_written(self, tmp_path):
        clip = make_clip_result(path="/v/df.mov", filename="df.mov", fps=29.97)
        out = str(tmp_path / "x.xml")
        export_xml([clip], out, timecodes={"/v/df.mov": {"seconds": 3600.0, "timecode": "01:00:00;00"}})
        tc = next(f for f in ET.parse(out).getroot().iter("file") if f.find("name") is not None).find(
            "timecode"
        )
        assert (tc.find("string").text, tc.find("displayformat").text) == ("01:00:00;00", "DF")

    def test_start_timecodes_probes_each_source_once_and_names_the_unreadable(self):
        probed = []

        def probe(path):
            probed.append(path)
            return None if path.endswith("bad.mov") else {"seconds": 10.0, "timecode": "00:00:10:00"}

        clips = [
            make_clip_result(path="/v/a.mov", filename="a.mov"),
            make_clip_result(path="/v/a.mov", filename="a.mov"),
            make_clip_result(path="/v/bad.mov", filename="bad.mov"),
        ]
        starts, warnings = start_timecodes(clips, probe)
        assert probed == ["/v/a.mov", "/v/bad.mov"]
        assert starts == {"/v/a.mov": {"seconds": 10.0, "timecode": "00:00:10:00"}}
        assert warnings == [
            (
                "Couldn't read the start timecode of bad.mov, so the XML starts it at 00:00:00:00; "
                "Resolve may not link it."
            )
        ]
