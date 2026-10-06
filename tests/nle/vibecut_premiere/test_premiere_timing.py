"""Speed, splits and tracks on the connected sequence (premiere_timing.py) against test_premiere_edit.py's
fake Premiere, which sets speed per item and razors tracks the way 26.5.2 did in the 7b.0 probe."""

import pytest

from tests.nle.vibecut_premiere.test_premiere_edit import (
    T,
    call,
    ids_of,
    revert,
    setup,  # noqa: F401  (a fixture)
)
from vibecut_agent.nle.premiere import HostError
from vibecut_agent.nle.premiere_timing import timecode


@pytest.fixture
def timing(setup):  # noqa: F811
    # VibeCut's version also faked premiere_timing.Probe, which only its (unported) speed edits use.
    return setup


def a_mov(premiere):
    return [c for _k, _i, c in premiere.everything() if c["name"] == "A.mov"]


def test_split_cuts_picture_and_sound_links_the_right_pieces_and_reverts(timing):
    host, premiere, _ = timing
    before = premiere.state()
    result = call(host, "split_clips", itemIds=[ids_of(premiere, "A.mov")[0]], time=1)
    (change,) = result["changes"]
    pieces = sorted(
        (
            k,
            i,
            int(c["startTicks"]) // T,
            int(c["endTicks"]) // T,
            int(c["inTicks"]) // T,
        )
        for k, i, c in premiere.everything()
        if c["name"] == "A.mov"
    )
    assert pieces == [
        ("audio", 0, 0, 1, 2),
        ("audio", 0, 1, 3, 3),
        ("audio", 1, 0, 1, 2),
        ("audio", 1, 1, 3, 3),
        ("video", 0, 0, 1, 2),
        ("video", 0, 1, 3, 3),
    ]
    rights = {e["right"]["id"] for e in change["items"]}
    assert all(set(premiere.find(r)["linkedIds"]) == rights - {r} for r in rights)
    assert change["cut"] == 1.0 and len(change["items"]) == 3
    assert revert(host, result)["reverted"] == [{"kind": "split", "name": "A.mov"}]
    assert premiere.state() == before


def test_split_keeps_unrelated_clips_unlinked(timing):
    # Splitting A.mov and an unlinked ROLL.wav together leaves ROLL.wav's pieces on their own.
    host, premiere, media = timing
    roll = premiere.clip(media["ROLL"], "audio", 3, 0, 3, 0)["id"]
    result = call(host, "split_clips", itemIds=[ids_of(premiere, "A.mov")[0], roll], time=1)
    (change,) = result["changes"]
    rights = {e["before"]["id"]: e["right"]["id"] for e in change["items"]}
    assert premiere.find(rights[roll])["linkedIds"] == []
    a_rights = set(rights.values()) - {rights[roll]}
    assert len(a_rights) == 3
    assert all(set(premiere.find(r)["linkedIds"]) == a_rights - {r} for r in a_rights)


def test_split_puts_back_a_razor_that_missed_and_refuses_outside_the_clip(timing):
    host, premiere, _ = timing
    before = premiere.state()
    picture = ids_of(premiere, "A.mov")[0]
    with pytest.raises(HostError, match="doesn't run across"):
        call(host, "split_clips", itemIds=[picture], time=4)
    premiere.razor_offset = 3 * 254016000000 // 25
    with pytest.raises(HostError, match="didn't cut"):
        call(host, "split_clips", itemIds=[picture], time=1)
    assert premiere.state() == before


def test_timecode_counts_frames_with_the_zero_point(timing):
    host, _premiere, _ = timing
    from vibecut_agent.nle.premiere_edit import _read

    seq = _read(host, "Main")
    assert timecode(seq, seq.ticks(61.48)) == "00:01:01:12"
    seq.raw["zeroPoint"] = str(3600 * T)
    assert timecode(seq, seq.ticks(1)) == "01:00:01:00"
