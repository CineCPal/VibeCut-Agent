"""The Story Editor's cut (vibecut_agent/story/assemble.py), ported from VibeCut's rough-cut-studio
tests/test_api_assemble.py (the parts this port keeps: loading inline transcripts, checking the
model's main and B-roll picks, and the cut end to end without the network)."""

import pytest

from vibecut_agent.story.assemble import Story, parse_duration_string, seconds_to_smpte

TRANSCRIPTS = [
    {
        "sourceId": "interview",
        "segments": [
            {"start": 1.0, "end": 4.0, "text": "Hello and welcome.", "speaker": "Jane"},
            {"start": 5.0, "end": 9.0, "text": "Today we talk about editing.", "speaker": "Jane"},
        ],
    }
]

CATALOG = [
    {
        "broll_id": "clip-a",
        "path": "/media/broll/sunset.mp4",
        "duration_seconds": 8.0,
        "caption": "sunset",
        "tags": [],
        "technical_score": 80.0,
    },
]


def loaded() -> Story:
    story = Story(25.0)
    story.load_sources(TRANSCRIPTS)
    story.media_paths["interview"] = "/media/interview.mov"
    return story


# ------------------------------------------------------------------------------------- load_sources


def test_load_sources_builds_segments():
    story = Story()
    assert story.load_sources(TRANSCRIPTS) == ["interview"]
    segments = story.sources["interview"]["segments"]
    assert [s.text for s in segments] == ["Hello and welcome.", "Today we talk about editing."]
    assert (segments[0].start_seconds, segments[0].end_seconds, segments[0].speaker) == (1.0, 4.0, "Jane")
    assert segments[0].start_tc == "00:00:01:00"


def test_load_sources_skips_malformed_entries():
    story = Story()
    got = story.load_sources(
        [
            {"sourceId": "", "segments": [{"start": 0, "end": 1, "text": "x"}]},
            {"sourceId": "bad-times", "segments": [{"start": 5, "end": 1, "text": "x"}]},
            {"sourceId": "not-a-list", "segments": "oops"},
            {"sourceId": "empty", "segments": []},
            {"sourceId": "ok", "segments": [{"start": 0.0, "end": 2.0, "text": "fine"}]},
            "nonsense",
        ]
    )
    assert got == ["ok"]
    assert set(story.sources) == {"ok"}


def test_load_sources_defaults_missing_speaker_and_text():
    story = Story()
    story.load_sources([{"sourceId": "s", "segments": [{"start": 0.0, "end": 1.0}]}])
    seg = story.sources["s"]["segments"][0]
    assert seg.speaker is None and seg.text == ""


# --------------------------------------------------------------------------- resolve_main_segments


def test_main_picks_are_checked_against_the_transcript():
    story = loaded()
    kept, problems = story.resolve_main_segments(
        [
            {"order": 1, "source_id": "interview", "segment_index": 1, "in_offset_seconds": 0.5},
            {"order": 0, "source_id": "interview", "segment_index": 0, "out_offset_seconds": 2.9},
            {"order": 2, "source_id": "nobody", "segment_index": 0},
            {"order": 3, "source_id": "interview", "segment_index": 9},
            "junk",
        ]
    )
    # Sorted by order and renumbered; the over-trimmed line falls back to the whole segment.
    assert [(s["order"], s["in_seconds"], s["out_seconds"]) for s in kept] == [(0, 1.0, 4.0), (1, 5.5, 9.0)]
    assert (
        kept[0]["source_name"] == "interview.mov" and kept[1]["source_text"] == "Today we talk about editing."
    )
    assert len(problems) == 4
    assert any("too short" in p for p in problems)
    assert any("unknown source_id 'nobody'" in p for p in problems)
    assert any("isn't a valid index" in p for p in problems)


def test_numbers_written_as_text_are_read():
    kept, _ = loaded().resolve_main_segments(
        [{"order": "0", "source_id": "interview", "segment_index": "1.0"}]
    )
    assert kept[0]["source_text"] == "Today we talk about editing."


# --------------------------------------------------------------------------- resolve_broll_segments


def main_list_at():
    """One main cut, 0..3 s on the timeline."""
    return [{"order": 0, "track": "main", "source_id": "interview", "in_seconds": 1.0, "out_seconds": 4.0}]


def test_broll_places_a_valid_pick():
    story = Story()
    raw = {
        "broll_segments": [
            {
                "broll_id": "clip-a",
                "anchor_order": 0,
                "anchor_offset_seconds": 0.5,
                "duration_seconds": 2.0,
                "audio_mode": "duck_main",
                "duck_db": -9.0,
                "editorial_note": "cutaway",
            }
        ]
    }
    resolved, problems = story.resolve_broll_segments(raw, CATALOG, main_list_at())
    assert problems == []
    clip = resolved[0]
    assert (clip["source_id"], clip["track"], clip["out_seconds"], clip["audio_mode"], clip["duck_db"]) == (
        "clip-a",
        "broll",
        2.0,
        "duck_main",
        -9.0,
    )
    assert clip["timeline_start_seconds"] == pytest.approx(0.5)
    assert story.media_paths["clip-a"] == "/media/broll/sunset.mp4"


def test_broll_rejects_an_unknown_id_and_an_out_of_range_anchor():
    story = Story()
    resolved, problems = story.resolve_broll_segments(
        {
            "broll_segments": [
                {"broll_id": "nope", "anchor_order": 0},
                {"broll_id": "clip-a", "anchor_order": 7},
            ]
        },
        CATALOG,
        main_list_at(),
    )
    assert resolved == []
    assert "unknown broll_id" in problems[0] and "doesn't match a main cut" in problems[1]


def test_broll_duration_is_clamped_and_defaulted_and_its_sound_mode_checked():
    story = Story()
    resolved, problems = story.resolve_broll_segments(
        {
            "broll_segments": [
                {
                    "broll_id": "clip-a",
                    "anchor_order": 0,
                    "duration_seconds": 999.0,
                    "audio_mode": "loud",
                    "duck_db": -500,
                },
                {"broll_id": "clip-a", "anchor_order": 0, "anchor_offset_seconds": 99},
            ]
        },
        CATALOG,
        main_list_at(),
    )
    assert problems == []
    assert (
        resolved[0]["out_seconds"] == 8.0
        and resolved[0]["audio_mode"] == "silent"
        and resolved[0]["duck_db"] == -60.0
    )
    assert resolved[1]["out_seconds"] == 4.0
    # An offset past the end of its cut is pulled back inside it.
    assert resolved[1]["timeline_start_seconds"] == pytest.approx(2.9)


def test_broll_is_optional_and_needs_a_path():
    story = Story()
    assert story.resolve_broll_segments({}, CATALOG, main_list_at()) == ([], [])
    resolved, problems = story.resolve_broll_segments(
        {"broll_segments": [{"broll_id": "clip-a", "anchor_order": 0, "duration_seconds": 2.0}]},
        [{"broll_id": "clip-a", "duration_seconds": 4.0}],
        main_list_at(),
    )
    assert resolved == [] and "no file path" in problems[0]


# --------------------------------------------------------------------------------------- result


STORY = {
    "sequence_name": "Story Cut",
    "narrative_summary": "A quick opener.",
    "script_segments": [
        {"order": 0, "source_id": "interview", "segment_index": 0},
        {"order": 1, "source_id": "interview", "segment_index": 1},
    ],
    "broll_segments": [
        {
            "broll_id": "clip-a",
            "anchor_order": 0,
            "anchor_offset_seconds": 1.0,
            "duration_seconds": 2.0,
            "audio_mode": "silent",
            "editorial_note": "b-roll",
        }
    ],
}


def test_the_result_combines_main_and_broll_in_the_shape_the_app_reads():
    result = loaded().result(STORY, CATALOG, "Fallback", None)
    segs = result["resolvedSegments"]
    main = [s for s in segs if s["track"] == "main"]
    broll = [s for s in segs if s["track"] == "broll"]
    assert [s["timeline_start_seconds"] for s in main] == [0.0, 3.0]
    assert broll[0]["timeline_start_seconds"] == pytest.approx(1.0)
    assert result["sequenceName"] == "Story Cut" and result["narrativeSummary"] == "A quick opener."
    assert result["media"] == {"interview": "/media/interview.mov", "clip-a": "/media/broll/sunset.mp4"}
    assert result["duration"] == {"main_runtime_seconds": 7.0, "main_runtime_label": "7s"}
    assert result["files"] == {} and result["warnings"] == []


def test_a_repeated_line_is_kept_once_and_broll_follows_the_models_own_order():
    raw = {
        "sequence_name": "",
        "script_segments": [
            {"order": 0, "source_id": "interview", "segment_index": 0},
            {"order": 2, "source_id": "interview", "segment_index": 0},
            {"order": 3, "source_id": "interview", "segment_index": 1},
        ],
        "broll_segments": [
            {
                "broll_id": "clip-a",
                "anchor_order": 3,
                "anchor_offset_seconds": 1.0,
                "duration_seconds": 2.0,
                "audio_mode": "silent",
            }
        ],
    }
    result = loaded().result(raw, CATALOG, "Fallback", None)
    main = [s for s in result["resolvedSegments"] if s["track"] == "main"]
    broll = [s for s in result["resolvedSegments"] if s["track"] == "broll"]
    assert [s["order"] for s in main] == [0, 1]
    assert broll[0]["timeline_start_seconds"] == pytest.approx(4.0)
    assert any("already used earlier" in w for w in result["warnings"])
    assert result["sequenceName"] == "Fallback"


def test_a_cut_far_from_its_target_says_so():
    result = loaded().result(STORY, CATALOG, "x", 120.0)
    assert result["duration"]["target_label"] == "2m 0s"
    assert any("under the 2m 0s target" in w for w in result["warnings"])
    assert loaded().result(STORY, CATALOG, "x", 8.0)["warnings"] == []


def test_a_cut_with_nothing_usable_is_refused_with_the_reasons():
    with pytest.raises(ValueError, match="didn't reference any valid transcript segments"):
        loaded().result({"script_segments": [], "broll_segments": []}, CATALOG, "x", None)
    with pytest.raises(ValueError, match="unknown source_id 'ghost'"):
        loaded().result(
            {"script_segments": [{"order": 0, "source_id": "ghost", "segment_index": 0}]}, CATALOG, "x", None
        )
    with pytest.raises(ValueError, match="no 'script_segments' array"):
        loaded().result({}, CATALOG, "x", None)


# --------------------------------------------------------------------------------------- helpers


@pytest.mark.parametrize(
    ("text", "seconds"),
    [
        ("90", 90.0),
        ("90s", 90.0),
        ("2 min", 120.0),
        ("1m 30s", 90.0),
        ("2-minute cut", 120.0),
        ("a 2-minute cut", 120.0),
        ("1:30", 90.0),
        ("01:02:03", 3723.0),
        ("~ 2 minutes", 120.0),
        ("", None),
        (None, None),
    ],
)
def test_durations_are_read_as_people_write_them(text, seconds):
    assert parse_duration_string(text) == seconds


def test_an_unreadable_duration_is_an_error():
    with pytest.raises(ValueError, match="as a duration"):
        parse_duration_string("soonish")


def test_timecodes_are_non_drop_frame():
    assert seconds_to_smpte(61.48, 25) == "00:01:01:12"
    assert seconds_to_smpte(-3, 25) == "00:00:00:00"
