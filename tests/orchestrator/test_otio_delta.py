"""OTIO deltas checked and lowered to bridge calls (orchestrator/otio_delta.py)."""

from __future__ import annotations

import copy
import math
from collections.abc import Mapping, Sequence
from fractions import Fraction

import pytest

from tests.orchestrator.timeline import delta, make_media, make_snapshot, op, ref, rt, tr
from vibecut_agent.orchestrator.otio_delta import (
    DeltaRejected,
    apply_delta_to_otio,
    compile_to_nle_commands,
    media_path_of,
    timeline_hash,
    write_otio,
)


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


def test_a_split_divides_the_source_so_a_later_trim_starts_from_the_cut(snapshot):
    # c1 plays a.mov 10-14 s; cut at 2 s, its left piece is 10-12 s, so trimming it to 10-12 s changes nothing.
    commands, diagnostics = run(
        delta(
            op("op_001", "SPLIT_CLIP", clip_id="c1", timeline_range=tr(50, 1)),
            op("op_002", "TRIM_CLIP", clip_id="c1", source_range=tr(250, 50)),
        ),
        snapshot,
    )
    assert calls(commands)[1:] == [("split_clips", {"itemIds": ["c1"], "time": 2.0})]
    assert codes(diagnostics) == [("WARNING", "NEGATIVE_OR_ZERO_DURATION", "op_002")]
    # Lengthening it would now run into the right piece.
    _, diagnostics = run(
        delta(
            op("op_001", "SPLIT_CLIP", clip_id="c1", timeline_range=tr(50, 1)),
            op("op_002", "TRIM_CLIP", clip_id="c1", source_range=tr(250, 60)),
        ),
        snapshot,
    )
    assert codes(diagnostics) == [("ERROR", "TRACK_OVERLAP_COLLISION", "op_002")]


# ------------------------------------------------------------------------------ apply_delta_to_otio


def edit(media):
    return delta(
        op("op_001", "SPLIT_CLIP", clip_id="c1", timeline_range=tr(50, 1)),
        op("op_002", "APPLY_TRANSITION", clip_id="c1", transition=transition("SMPTE_Dissolve", 5, 5)),
        op(
            "op_003",
            "SET_AUDIO_GAIN",
            "Audio",
            1,
            clip_id="a1",
            audio_params={"gain_db": -6, "fade_in_seconds": 0.5},
        ),
        op(
            "op_004",
            "INSERT_CLIP",
            index=2,
            media_reference=ref(media["c d.mov"]),
            source_range=tr(25, 50),
            timeline_range=tr(200, 50),
        ),
    )


def items(track):
    return [(type(item).__name__, item.name) for item in track]


def plain(value):
    """OTIO metadata (AnyDictionary, AnyVector) as plain dicts and lists."""
    if isinstance(value, Mapping):
        return {k: plain(v) for k, v in value.items()}
    if isinstance(value, Sequence) and not isinstance(value, str):
        return [plain(v) for v in value]
    return value


def test_the_otio_is_the_timeline_as_the_delta_leaves_it(media, snapshot):
    otio = pytest.importorskip("opentimelineio")
    timeline = apply_delta_to_otio(edit(media), snapshot, lambda path: 60.0)

    assert timeline.name == "Cut"
    assert plain(timeline.metadata["vibecut"]) == {
        "deltaId": "delta_0001",
        "host": "premiere",
        "basedOnTimelineHash": timeline_hash(snapshot),
    }
    assert [(t.name, t.kind) for t in timeline.tracks] == [
        ("V1", "Video"),
        ("V2", "Video"),
        ("A1", "Audio"),
        ("A2", "Audio"),
    ]
    v1, v2, a1, a2 = timeline.tracks
    # The snapshot names no clips, so each is called by its id; the piece split off has none yet.
    assert items(v1) == [
        ("Clip", "c1"),
        ("Transition", "SMPTE_Dissolve"),
        ("Clip", "c1:right"),
        ("Clip", "c2"),
    ]
    left, dissolve, right = v1[0], v1[1], v1[2]
    # a.mov 10-12 s and 12-14 s at 25 fps.
    assert (left.source_range.start_time.value, left.source_range.duration.value) == (250, 50)
    assert (right.source_range.start_time.value, right.source_range.duration.value) == (300, 50)
    assert plain(left.metadata["vibecut"]) == {"id": "c1", "madeBy": None, "linkedIds": ["a1"]}
    # The split cut c1's linked sound too, and linked the right pieces, as the editors do.
    assert plain(right.metadata["vibecut"]) == {"id": None, "madeBy": "op_001", "linkedIds": ["a1:right"]}
    assert items(a1) == [("Clip", "a1"), ("Clip", "a1:right"), ("Clip", "a2")]
    assert dissolve.transition_type == otio.schema.TransitionTypes.SMPTE_Dissolve
    assert (dissolve.in_offset.value, dissolve.out_offset.value) == (5, 5)
    assert left.media_reference.target_url == f"file://{media['a.mov']}"
    # The new clip on V2 starts at 8 s, after a gap.
    assert items(v2) == [("Gap", ""), ("Clip", "c d.mov")]
    assert v2[0].source_range.duration.value == 200
    assert v2[1].metadata["vibecut"]["madeBy"] == "op_004"
    assert v2[1].range_in_parent().start_time.value == 200
    assert plain(a1[0].metadata["vibecut"]) == {
        "id": "a1",
        "madeBy": None,
        "linkedIds": ["c1"],
        "levelDb": -6,
        "fadeIn": 0.5,
    }
    assert items(a2) == [("Clip", "m1")]


def test_an_ntsc_delta_keeps_the_exact_rate(media, snapshot):
    pytest.importorskip("opentimelineio")
    ntsc = {**snapshot, "fps": 23.976}
    for track in ntsc["tracks"]:
        track["clips"] = []
    d = delta(
        op(
            "op_001",
            "INSERT_CLIP",
            media_reference=ref(media["b.mov"]),
            source_range=tr(0, 48, 23.976),
            timeline_range=tr(24, 48, 23.976),
        ),
        fps=23.976,
    )
    timeline = apply_delta_to_otio(d, ntsc, lambda path: 60.0)
    clip = timeline.tracks[0][1]
    assert clip.source_range.duration.rate == pytest.approx(24000 / 1001)
    assert clip.range_in_parent().start_time.value == 24


def test_a_delta_with_errors_is_not_applied(snapshot):
    pytest.importorskip("opentimelineio")
    with pytest.raises(DeltaRejected) as raised:
        apply_delta_to_otio(delta(op("op_001", "DELETE_CLIP", clip_id="nope")), snapshot, lambda path: 60.0)
    assert "UNKNOWN_CLIP_ID" in str(raised.value)
    assert raised.value.diagnostics[0]["op_id"] == "op_001"


def test_write_otio_saves_it_whole(media, snapshot, tmp_path):
    otio = pytest.importorskip("opentimelineio")
    timeline = apply_delta_to_otio(edit(media), snapshot, lambda path: 60.0)
    path = write_otio(timeline, tmp_path / "otio_deltas", "delta_0001")
    assert path == tmp_path / "otio_deltas" / "delta_0001.otio"
    assert [p.name for p in path.parent.iterdir()] == ["delta_0001.otio"]
    again = otio.adapters.read_from_file(str(path))
    assert again.name == "Cut"
    assert items(again.tracks[0]) == items(timeline.tracks[0])


def test_linked_picture_and_sound_deleted_together_go_in_one_call(snapshot):
    # c2 and a2 are linked: one call, so the editor records them as deleted together and Revert relinks them.
    commands, diagnostics = run(
        delta(
            op("op_001", "DELETE_CLIP", clip_id="c2"),
            op("op_002", "DELETE_CLIP", "Audio", 1, clip_id="a2"),
            op("op_003", "DELETE_CLIP", "Audio", 2, clip_id="m1"),
            op("op_004", "DELETE_CLIP", clip_id="c1"),
        ),
        snapshot,
    )
    assert diagnostics == []
    assert calls(commands)[1:] == [
        ("delete_clips", {"itemIds": ["c2", "a2"], "withLinked": False}),
        # The music isn't linked to them, and c1 isn't linked to the music: calls of their own.
        ("delete_clips", {"itemIds": ["m1"], "withLinked": False}),
        ("delete_clips", {"itemIds": ["c1"], "withLinked": False}),
    ]
    assert [c["source_op_id"] for c in commands[1:]] == ["op_001,op_002", "op_003", "op_004"]
    assert [c["seq"] for c in commands] == [1, 2, 3, 4]


def test_a_split_cuts_the_linked_sound_too_so_splitting_it_again_does_nothing(snapshot):
    # Seen live in Resolve: splitting V1 cut A1 as well, so a second split of A1 there failed in the editor.
    commands, diagnostics = run(
        delta(
            op("op_001", "SPLIT_CLIP", clip_id="c1", timeline_range=tr(50, 1)),
            op("op_002", "SPLIT_CLIP", "Audio", 1, clip_id="a1", timeline_range=tr(50, 1)),
            op("op_003", "TRIM_CLIP", "Audio", 1, clip_id="a1", source_range=tr(250, 25)),
        ),
        snapshot,
    )
    assert calls(commands)[1:] == [
        ("split_clips", {"itemIds": ["c1"], "time": 2.0}),
        # a1's left piece is 10-12 s now; trimming it to 10-11 s is a real change.
        ("reshape_clip", {"itemId": "a1", "sourceOut": 11.0}),
    ]
    assert codes(diagnostics) == [("WARNING", "NEGATIVE_OR_ZERO_DURATION", "op_002")]
    assert "already cut at 2 s" in diagnostics[0]["message"]


def test_a_trim_moves_the_linked_sound_too_so_trimming_it_again_does_nothing(snapshot):
    # Seen live in Resolve: reshape_clip trims the clip's linked partner with it.
    commands, diagnostics = run(
        delta(
            op("op_001", "TRIM_CLIP", clip_id="c1", source_range=tr(275, 75)),
            op("op_002", "TRIM_CLIP", "Audio", 1, clip_id="a1", source_range=tr(275, 75)),
        ),
        snapshot,
    )
    assert calls(commands)[1:] == [("reshape_clip", {"itemId": "c1", "sourceIn": 11.0})]
    assert codes(diagnostics) == [("WARNING", "NEGATIVE_OR_ZERO_DURATION", "op_002")]


def test_a_trim_within_half_a_frame_of_the_current_point_leaves_it(snapshot):
    # Seen live: Claude's out point was 45.011633 s where Resolve reported 45.012 s, and a no-op call went out.
    nudged = copy.deepcopy(snapshot)
    nudged["tracks"][0]["clips"][0]["sourceOut"] = 14.004
    commands, diagnostics = run(
        delta(op("op_001", "TRIM_CLIP", clip_id="c1", source_range=tr(275, 75))), nudged
    )
    assert calls(commands)[1:] == [("reshape_clip", {"itemId": "c1", "sourceIn": 11.0})]
    assert diagnostics == []


def test_a_trimmed_clips_linked_sound_must_have_room_too(snapshot):
    # With c2 gone, V1 has room for c1 to run a second longer, but its linked a1 would run into a2 on A1.
    _, diagnostics = run(
        delta(
            op("op_001", "DELETE_CLIP", clip_id="c2"),
            op("op_002", "TRIM_CLIP", clip_id="c1", source_range=tr(250, 125)),
        ),
        snapshot,
    )
    assert codes(diagnostics) == [("ERROR", "TRACK_OVERLAP_COLLISION", "op_002")]
    assert "Extending clip a1 would run into clip(s) a2" in diagnostics[0]["message"]
    # With a2 gone as well, there's room on both tracks.
    commands, diagnostics = run(
        delta(
            op("op_001", "DELETE_CLIP", clip_id="c2"),
            op("op_002", "DELETE_CLIP", "Audio", 1, clip_id="a2"),
            op("op_003", "TRIM_CLIP", clip_id="c1", source_range=tr(250, 125)),
        ),
        snapshot,
    )
    assert diagnostics == []
    assert calls(commands)[-1:] == [("reshape_clip", {"itemId": "c1", "sourceOut": 15.0})]


def test_the_hash_is_the_same_however_the_numbers_were_written(snapshot):
    # Seen live: the app's reading came through JavaScript, whose JSON writes 0.0 as 0 and 25.0 as 25.
    as_floats = copy.deepcopy(snapshot)
    as_floats["fps"] = 25.0
    for track in as_floats["tracks"]:
        track["index"] = float(track["index"])
        for clip in track["clips"]:
            for key in ("start", "end", "sourceIn", "sourceOut"):
                clip[key] = float(clip[key])
    assert timeline_hash(as_floats) == timeline_hash(snapshot)
    assert timeline_hash({**snapshot, "fps": 24}) != timeline_hash(snapshot)


def test_frame_times_are_sent_rounded_up_so_premiere_lands_on_the_frame(media, snapshot):
    # Seen live in Premiere: frame 899 at 29.97 sent as 29.996633 s (a hair before the frame) became 898.
    ntsc = {**snapshot, "fps": 29.97}
    for track in ntsc["tracks"]:
        track["clips"] = []
    commands, diagnostics = run(
        delta(
            op(
                "op_001",
                "INSERT_CLIP",
                media_reference=ref(media["a.mov"]),
                source_range=tr(899, 450, 29.97),
                timeline_range=tr(0, 450, 29.97),
            ),
            fps=29.97,
        ),
        ntsc,
    )
    assert diagnostics == []
    [clip] = commands[1]["args"]["clips"]
    assert clip["sourceIn"] == 29.996634
    exact = Fraction(899 * 1001, 30000)
    assert 0 <= Fraction(clip["sourceIn"]) - exact < Fraction(1, 1_000_000)
    assert math.floor(Fraction(clip["sourceIn"]) * Fraction(30000, 1001)) == 899
