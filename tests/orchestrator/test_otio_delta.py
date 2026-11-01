"""OTIO deltas checked and lowered to bridge calls (orchestrator/otio_delta.py)."""

from __future__ import annotations

import copy

import pytest

from tests.orchestrator.timeline import delta, make_media, make_snapshot, op, ref, rt, tr
from vibecut_agent.orchestrator.otio_delta import compile_to_nle_commands, media_path_of, timeline_hash


@pytest.fixture
def media(tmp_path):
    return make_media(tmp_path)


@pytest.fixture
def snapshot(media):
    return make_snapshot(media)


def run(d, snapshot, duration=60.0):
    return compile_to_nle_commands(d, snapshot, lambda path: duration)


def codes(diagnostics):
    return [(d["severity"], d["code"], d["op_id"]) for d in diagnostics]


def calls(commands):
    return [(c["command"], {k: v for k, v in c["args"].items() if k != "timeline"}) for c in commands]


def test_linked_picture_and_sound_go_in_as_one_clip(media, snapshot):
    commands, diagnostics = run(
        delta(
            op(
                "op_001",
                "INSERT_CLIP",
                media_reference=ref(media["c d.mov"]),
                source_range=tr(25, 50),
                timeline_range=tr(200, 50),
                link_group_id="g1",
            ),
            op(
                "op_002",
                "INSERT_CLIP",
                "Audio",
                1,
                media_reference=ref(media["c d.mov"]),
                source_range=tr(25, 50),
                timeline_range=tr(200, 50),
                link_group_id="g1",
                audio_params={"gain_db": -3},
            ),
        ),
        snapshot,
    )
    assert diagnostics == []
    assert commands[0] == {
        "seq": 1,
        "source_op_id": "backup",
        "host": "premiere",
        "command": "backup_timeline",
        "args": {"timeline": "Cut"},
    }
    assert calls(commands[1:]) == [
        (
            "add_clips",
            {
                "clips": [
                    {
                        "path": media["c d.mov"],
                        "sourceIn": 1.0,
                        "sourceOut": 3.0,
                        "at": 8.0,
                        "videoTrack": 1,
                        "audioTrack": 1,
                        "picture": True,
                        "sound": True,
                        "volumeDb": -3,
                    }
                ]
            },
        )
    ]
    assert [c["seq"] for c in commands] == [1, 2]


def test_inserting_on_a_clip_collides(media, snapshot):
    _, diagnostics = run(
        delta(
            op(
                "op_001",
                "INSERT_CLIP",
                media_reference=ref(media["c d.mov"]),
                source_range=tr(0, 50),
                timeline_range=tr(75, 50),
            )
        ),
        snapshot,
    )
    assert codes(diagnostics) == [("ERROR", "TRACK_OVERLAP_COLLISION", "op_001")]
    assert "c1, c2" in diagnostics[0]["message"]


def test_overwrite_replaces_whole_clips_only(media, snapshot):
    whole = op(
        "op_001",
        "OVERWRITE_CLIP",
        media_reference=ref(media["c d.mov"]),
        source_range=tr(0, 100),
        timeline_range=tr(100, 100),
    )
    commands, diagnostics = run(delta(whole), snapshot)
    assert diagnostics == []
    assert [name for name, _ in calls(commands)] == ["backup_timeline", "delete_clips", "add_clips"]
    assert calls(commands)[1][1] == {"itemIds": ["c2"], "withLinked": False}
    partial = copy.deepcopy(whole)
    partial["timeline_range"] = tr(50, 100)
    _, diagnostics = run(delta(partial), snapshot)
    assert codes(diagnostics) == [("ERROR", "TRACK_OVERLAP_COLLISION", "op_001")]
    assert "partway" in diagnostics[0]["message"]


def test_media_is_checked(media, snapshot):
    missing = op(
        "op_001",
        "INSERT_CLIP",
        media_reference=ref("/nowhere/x.mov"),
        source_range=tr(0, 25),
        timeline_range=tr(500, 25),
    )
    no_ref = op("op_002", "INSERT_CLIP", source_range=tr(0, 25), timeline_range=tr(500, 25))
    past_end = op(
        "op_003",
        "INSERT_CLIP",
        media_reference=ref(media["c d.mov"]),
        source_range=tr(1500, 100),
        timeline_range=tr(600, 100),
    )
    speed = op(
        "op_004",
        "INSERT_CLIP",
        media_reference=ref(media["c d.mov"]),
        source_range=tr(0, 50),
        timeline_range=tr(700, 25),
    )
    available = op(
        "op_005",
        "INSERT_CLIP",
        media_reference={**ref(media["c d.mov"]), "available_range": tr(0, 100)},
        source_range=tr(80, 50),
        timeline_range=tr(800, 50),
    )
    _, diagnostics = run(delta(missing, no_ref, past_end, speed, available), snapshot)
    assert codes(diagnostics) == [
        ("ERROR", "MISSING_MEDIA_FILE", "op_001"),
        ("ERROR", "MISSING_MEDIA_FILE", "op_002"),
        ("ERROR", "SOURCE_OUT_OF_BOUNDS", "op_003"),
        ("ERROR", "RATE_MISMATCH", "op_004"),
        ("ERROR", "SOURCE_OUT_OF_BOUNDS", "op_005"),
    ]


def test_ntsc_source_on_a_25_timeline(media, snapshot):
    # 48 frames at 23.976 is 2.002 s: 50.05 timeline frames, within half a frame of 50.
    commands, diagnostics = run(
        delta(
            op(
                "op_001",
                "INSERT_CLIP",
                media_reference=ref(media["c d.mov"]),
                source_range=tr(0, 48, 23.976),
                timeline_range=tr(200, 50),
            )
        ),
        snapshot,
    )
    assert diagnostics == []
    assert calls(commands)[1][1]["clips"][0]["sourceOut"] == 2.002


def test_trim_moves_the_edges_that_changed(snapshot):
    commands, diagnostics = run(
        delta(op("op_001", "TRIM_CLIP", clip_id="c1", source_range=tr(275, 75))), snapshot
    )
    assert diagnostics == []
    assert calls(commands)[1:] == [("reshape_clip", {"itemId": "c1", "sourceIn": 11.0})]
    commands, diagnostics = run(
        delta(op("op_001", "TRIM_CLIP", clip_id="c2", source_range=tr(0, 150))), snapshot
    )
    assert diagnostics == []
    assert calls(commands)[1:] == [("reshape_clip", {"itemId": "c2", "sourceOut": 6.0})]
    _, diagnostics = run(delta(op("op_001", "TRIM_CLIP", clip_id="c1", source_range=tr(250, 125))), snapshot)
    assert codes(diagnostics) == [("ERROR", "TRACK_OVERLAP_COLLISION", "op_001")]
    _, diagnostics = run(delta(op("op_001", "TRIM_CLIP", clip_id="c1", source_range=tr(250, 100))), snapshot)
    assert codes(diagnostics) == [("WARNING", "NEGATIVE_OR_ZERO_DURATION", "op_001")]


def test_split_then_delete(snapshot):
    commands, diagnostics = run(
        delta(
            op("op_001", "SPLIT_CLIP", clip_id="c1", timeline_range=tr(50, 1)),
            op("op_002", "DELETE_CLIP", clip_id="c1"),
            op("op_003", "DELETE_CLIP", clip_id="c1"),
            op("op_004", "SPLIT_CLIP", clip_id="c2", timeline_range=tr(100, 1)),
        ),
        snapshot,
    )
    assert calls(commands)[1:] == [
        ("split_clips", {"itemIds": ["c1"], "time": 2.0}),
        ("delete_clips", {"itemIds": ["c1"], "withLinked": False}),
    ]
    assert codes(diagnostics) == [
        ("ERROR", "UNKNOWN_CLIP_ID", "op_003"),
        ("ERROR", "SOURCE_OUT_OF_BOUNDS", "op_004"),
    ]


def test_move_takes_its_linked_sound(snapshot):
    commands, diagnostics = run(
        delta(op("op_001", "MOVE_CLIP", clip_id="c2", timeline_range=tr(250, 100))), snapshot
    )
    assert diagnostics == []
    assert calls(commands)[1:] == [("reshape_clip", {"itemId": "c2", "start": 10.0})]
    _, diagnostics = run(delta(op("op_001", "MOVE_CLIP", clip_id="c1", timeline_range=tr(50, 100))), snapshot)
    assert codes(diagnostics) == [("ERROR", "TRACK_OVERLAP_COLLISION", "op_001")]
    commands, diagnostics = run(
        delta(op("op_001", "MOVE_CLIP", index=2, clip_id="c1", timeline_range=tr(0, 100))), snapshot
    )
    assert diagnostics == []
    assert calls(commands)[1:] == [("reshape_clip", {"itemId": "c1", "start": 0.0, "videoTrack": 2})]
    _, diagnostics = run(
        delta(op("op_001", "MOVE_CLIP", "Audio", 3, clip_id="c1", timeline_range=tr(0, 100))), snapshot
    )
    assert codes(diagnostics) == [("ERROR", "UNKNOWN_CLIP_ID", "op_001")]


def transition(kind, before, after):
    return {
        "OTIO_SCHEMA": "Transition.1",
        "transition_type": kind,
        "in_offset": rt(before),
        "out_offset": rt(after),
    }


def test_transitions(snapshot):
    commands, diagnostics = run(
        delta(
            op("op_001", "APPLY_TRANSITION", clip_id="c1", transition=transition("SMPTE_Dissolve", 12, 12))
        ),
        snapshot,
    )
    assert diagnostics == []
    assert calls(commands)[1:] == [("set_transition", {"itemId": "c1", "kind": "dissolve", "seconds": 0.96})]
    commands, diagnostics = run(
        delta(
            op(
                "op_001",
                "APPLY_TRANSITION",
                "Audio",
                1,
                clip_id="a1",
                transition=transition("Audio_Crossfade", 5, 10),
            )
        ),
        snapshot,
    )
    assert codes(diagnostics) == [("WARNING", "INVALID_TRANSITION_HANDLE", "op_001")]
    assert calls(commands)[1:] == [("set_transition", {"itemId": "a1", "kind": "dissolve", "seconds": 0.6})]
    _, diagnostics = run(
        delta(
            op("op_001", "APPLY_TRANSITION", clip_id="c2", transition=transition("SMPTE_Dissolve", 5, 5)),
            op("op_002", "APPLY_TRANSITION", clip_id="c1", transition=transition("SMPTE_Dissolve", 60, 60)),
            op(
                "op_003",
                "APPLY_TRANSITION",
                "Audio",
                1,
                clip_id="a1",
                transition=transition("Dip_To_Black", 5, 5),
            ),
            op("op_004", "APPLY_TRANSITION", clip_id="c1"),
        ),
        snapshot,
    )
    assert [c for _, c, _ in codes(diagnostics)] == ["INVALID_TRANSITION_HANDLE"] * 4


def test_levels_fades_and_ducking(snapshot):
    commands, diagnostics = run(
        delta(
            op(
                "op_001",
                "SET_AUDIO_GAIN",
                "Audio",
                1,
                clip_id="a1",
                audio_params={"gain_db": -6, "fade_out_seconds": 0.5},
            ),
            op(
                "op_002",
                "DUCK_REGION",
                "Audio",
                2,
                clip_id="m1",
                timeline_range=tr(25, 75),
                audio_params={"duck_Floor_db": -18},
            ),
        ),
        snapshot,
    )
    assert diagnostics == []
    assert calls(commands)[1:] == [
        ("set_clip_levels", {"levels": [{"itemId": "a1", "volumeDb": -6}]}),
        ("set_clip_fades", {"itemIds": ["a1"], "which": "fadeOut", "seconds": 0.5}),
        (
            "duck_clip",
            {"itemId": "m1", "spans": [{"start": 1.0, "end": 4.0}], "duckDb": -18, "rampSeconds": 0.3},
        ),
    ]
    _, diagnostics = run(
        delta(
            op("op_001", "SET_AUDIO_GAIN", "Audio", 1, clip_id="a1"),
            op(
                "op_002",
                "DUCK_REGION",
                "Audio",
                2,
                clip_id="m1",
                timeline_range=tr(25, 75),
                audio_params={"duck_Floor_db": -60},
            ),
            op("op_003", "DUCK_REGION", "Audio", 2, clip_id="c1", timeline_range=tr(25, 75)),
        ),
        snapshot,
    )
    assert codes(diagnostics) == [
        ("ERROR", "NEGATIVE_OR_ZERO_DURATION", "op_001"),
        ("ERROR", "SOURCE_OUT_OF_BOUNDS", "op_002"),
        ("ERROR", "UNKNOWN_CLIP_ID", "op_003"),
    ]
    _, diagnostics = run(
        delta(
            op("op_001", "DUCK_REGION", "Audio", 2, clip_id="m1", timeline_range=tr(25, 75)), host="resolve"
        ),
        snapshot,
    )
    assert codes(diagnostics) == [("ERROR", "SOURCE_OUT_OF_BOUNDS", "op_001")]


def test_what_the_bridges_cant_do(media, snapshot):
    _, diagnostics = run(
        delta(
            op("op_001", "INSERT_GAP", timeline_range=tr(0, 25)),
            op("op_002", "DELETE_CLIP", clip_id="c2", ripple=True),
            op(
                "op_003",
                "INSERT_CLIP",
                media_reference=ref(media["c d.mov"]),
                source_range=tr(0, 25),
                timeline_range=tr(300, 25),
                ripple=True,
            ),
        ),
        snapshot,
    )
    assert codes(diagnostics) == [("ERROR", "TRACK_OVERLAP_COLLISION", f"op_00{i}") for i in (1, 2, 3)]


def test_rates_and_timelines(media, snapshot):
    _, diagnostics = run(
        delta(op("op_001", "MOVE_CLIP", clip_id="c2", timeline_range=tr(300, 120, 29.97)), fps=29.97),
        snapshot,
    )
    # A 29.97 delta for a 25 fps timeline.
    assert codes(diagnostics) == [("ERROR", "RATE_MISMATCH", None)]
    _, diagnostics = run(
        delta(op("op_001", "MOVE_CLIP", clip_id="c2", timeline_range=tr(300, 120, 29.97))), snapshot
    )
    assert codes(diagnostics) == [("ERROR", "RATE_MISMATCH", "op_001")]
    other = {**snapshot, "timeline": "Other"}
    _, diagnostics = run(delta(op("op_001", "DELETE_CLIP", clip_id="c2")), other)
    assert codes(diagnostics) == [("ERROR", "STALE_TIMELINE_HASH", None)]


def test_duplicate_op_ids_are_flagged(snapshot):
    _, diagnostics = run(
        delta(op("op_001", "DELETE_CLIP", clip_id="c1"), op("op_001", "DELETE_CLIP", clip_id="c2")), snapshot
    )
    assert codes(diagnostics) == [("WARNING", "UNKNOWN_CLIP_ID", "op_001")]


def test_timeline_hash(snapshot):
    first = timeline_hash(snapshot)
    assert len(first) == 64
    assert timeline_hash({**snapshot, "playhead": 9.0, "markers": [{"name": "x"}]}) == first
    moved = copy.deepcopy(snapshot)
    moved["tracks"][0]["clips"][1]["start"] = 4.04
    assert timeline_hash(moved) != first


def test_media_path_of():
    assert media_path_of("file:///Volumes/Shoot/Day%201/a.mov") == "/Volumes/Shoot/Day 1/a.mov"
    assert media_path_of("file:///Volumes/Shoot/Day 1/a.mov") == "/Volumes/Shoot/Day 1/a.mov"
