"""Ripple edits on the Premiere sequence (nle/premiere_ripple.py), against the fake Premiere of
test_premiere_edit.py: A.mov at 0-3 s and B.mov at 5-8 s, each picture on V1 linked to its stereo sound on
A1 and A2, at 25 fps."""

from __future__ import annotations

import pytest

from tests.nle.vibecut_premiere.test_premiere_edit import call, revert, setup  # noqa: F401 - the fixture
from vibecut_agent.nle.premiere import TICKS_PER_SECOND, HostError

T = TICKS_PER_SECOND


def spans(premiere, kind="video", track=0):
    """A track's clips as (name, start, end, source in) in seconds."""
    tracks = premiere.video if kind == "video" else premiere.audio
    return [
        (c["name"], int(c["startTicks"]) / T, int(c["endTicks"]) / T, int(c["inTicks"]) / T)
        for c in tracks[track]
    ]


def linked_names(premiere, clip):
    return sorted(
        (k, i, int(premiere.find(o)["startTicks"]) / T)
        for o in clip["linkedIds"]
        for k, i, c in premiere.everything()
        if c["id"] == o
    )


def test_taking_a_stretch_out_of_every_track(setup):  # noqa: F811
    host, premiere, _ = setup
    before = premiere.state()
    result = call(host, "ripple_delete", ranges=[{"start": 1, "end": 2}])
    # A is cut at 1 s and 2 s on V1, A1 and A2; 1-2 s goes; the rest of A and all of B move a second earlier.
    assert spans(premiere) == [("A.mov", 0, 1, 2), ("A.mov", 1, 2, 4), ("B.mov", 4, 7, 2)]
    for track in (0, 1):
        assert spans(premiere, "audio", track) == spans(premiere)
    assert result["removedSeconds"] == 1.0 and result["lifted"] == 3 and result["moved"] == 6
    # The pieces right of the cut are linked again, picture to its sound.
    right = premiere.video[0][1]
    assert linked_names(premiere, right) == [("audio", 0, 1.0), ("audio", 1, 1.0)]
    assert [c["kind"] for c in result["changes"]] == [
        "split",
        "split",
        "deleted",
        "deleted",
        "deleted",
        "shifted",
    ]
    out = revert(host, result)
    assert out["changedSince"] == [] and out["failed"] == []
    assert premiere.state() == before


def test_closing_a_gap_and_two_stretches_at_once(setup):  # noqa: F811
    host, premiere, _ = setup
    before = premiere.state()
    # The empty 3-5 s and B's last second, in either order and overlapping: merged and taken out together.
    result = call(
        host,
        "ripple_delete",
        ranges=[{"start": 7, "end": 8}, {"start": 3, "end": 4.5}, {"start": 4, "end": 5}],
    )
    assert spans(premiere) == [("A.mov", 0, 3, 2), ("B.mov", 3, 5, 2)]
    assert spans(premiere, "audio", 1) == spans(premiere)
    revert(host, result)
    assert premiere.state() == before


def test_opening_up_time(setup):  # noqa: F811
    host, premiere, _ = setup
    before = premiere.state()
    result = call(host, "insert_time", at=1, seconds=2)
    assert spans(premiere) == [("A.mov", 0, 1, 2), ("A.mov", 3, 5, 3), ("B.mov", 7, 10, 2)]
    assert spans(premiere, "audio", 0) == spans(premiere)
    assert linked_names(premiere, premiere.video[0][1]) == [("audio", 0, 3.0), ("audio", 1, 3.0)]
    revert(host, result)
    assert premiere.state() == before


def test_a_locked_track_or_a_transition_in_the_way_is_refused(setup):  # noqa: F811
    host, premiere, _ = setup
    before = premiere.state()
    premiere.flags("audio", 1)["locked"] = True
    with pytest.raises(HostError, match="locked"):
        call(host, "ripple_delete", ranges=[{"start": 1, "end": 2}])
    premiere.flags("audio", 1)["locked"] = False
    # A dissolve into B at 5 s, which a ripple at 1 s would have to move.
    premiere.transitions[id(premiere.video[0])] = [
        {"name": "Cross Dissolve", "startTicks": str(round(4.8 * T)), "endTicks": str(round(5.2 * T))}
    ]
    with pytest.raises(HostError, match="transition"):
        call(host, "insert_time", at=1, seconds=1)
    premiere.transitions.clear()
    assert premiere.state() == before


def test_nothing_after_the_stretch_is_refused(setup):  # noqa: F811
    host, premiere, _ = setup
    with pytest.raises(HostError, match="nothing"):
        call(host, "ripple_delete", ranges=[{"start": 9, "end": 10}])
    with pytest.raises(HostError, match="at least a frame"):
        call(host, "ripple_delete", ranges=[{"start": 2, "end": 2}])


def test_a_ripple_that_fails_part_way_is_undone(setup):  # noqa: F811
    host, premiere, _ = setup
    before = premiere.state()
    premiere.shift_fails = True
    with pytest.raises(HostError, match="didn't move them.*undone"):
        call(host, "ripple_delete", ranges=[{"start": 1, "end": 2}])
    assert premiere.state() == before


def test_a_shift_on_its_own(setup):  # noqa: F811
    host, premiere, _ = setup
    before = premiere.state()
    b = [c["id"] for _k, _i, c in premiere.everything() if c["name"] == "B.mov"]
    result = call(host, "shift_clips", moves=[{"itemId": i, "offset": -2} for i in b])
    assert spans(premiere) == [("A.mov", 0, 3, 2), ("B.mov", 3, 6, 2)]
    # One more second would run B into A.
    with pytest.raises(HostError, match="run it into"):
        call(host, "shift_clips", moves=[{"itemId": i, "offset": -1} for i in b])
    revert(host, result)
    assert premiere.state() == before
