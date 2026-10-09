"""Speed, splits and tracks on the connected sequence (premiere_timing.py) against test_premiere_edit.py's
fake Premiere, which sets speed per item and razors tracks the way 26.5.2 did in the 7b.0 probe."""

import pytest

from tests.nle.vibecut_premiere.test_premiere_edit import (
    FakeProbe,
    T,
    call,
    ids_of,
    revert,
    setup,  # noqa: F401  (a fixture)
)
from vibecut_agent.nle.premiere import HostError
from vibecut_agent.nle.premiere_timing import timecode


@pytest.fixture
def timing(setup, monkeypatch):  # noqa: F811
    from vibecut_agent.nle import premiere_timing

    host, premiere, media = setup
    monkeypatch.setattr(premiere_timing, "Probe", lambda: FakeProbe(premiere.media))
    return host, premiere, media


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


# Phase 12b and 12d: VibeCut's speed and track tests.


def test_speed_sets_the_clip_and_its_partners_and_reverts(timing):
    host, premiere, _ = timing
    picture = ids_of(premiere, "A.mov")[0]
    result = call(host, "set_clip_speed", itemId=picture, speed=2)
    (change,) = result["changes"]
    assert (
        change["kind"],
        change["before"],
        change["after"],
        change["ripple"],
        len(change["speeds"]),
    ) == ("speed", 1.0, 2.0, False, 3)
    assert [c["speed"] for c in a_mov(premiere)] == [2, 2, 2]
    assert revert(host, result)["reverted"] == [{"kind": "speed", "name": "A.mov"}]
    assert [c["speed"] for c in a_mov(premiere)] == [1, 1, 1]


def test_speed_refusals(timing):
    host, premiere, _ = timing
    picture = ids_of(premiere, "A.mov")[0]
    with pytest.raises(HostError, match="in a draft"):
        call(host, "set_clip_speed", itemId=picture, speed=2, ripple=True)
    # 3 s from 2 s into a 30 s file at 10x would need 32 s.
    with pytest.raises(HostError, match="runs out"):
        call(host, "set_clip_speed", itemId=picture, speed=10)
    premiere.fades[picture] = {
        "keys": [{"ticks": "0", "value": 0.0}, {"ticks": str(T), "value": 100.0}],
        "value": None,
    }
    with pytest.raises(HostError, match="fade or keyframes"):
        call(host, "set_clip_speed", itemId=picture, speed=2)
    del premiere.fades[picture]
    premiere.speed_ignored = True
    with pytest.raises(HostError, match="put back"):
        call(host, "set_clip_speed", itemId=picture, speed=2)


def test_speed_revert_leaves_a_clip_changed_since(timing):
    host, premiere, _ = timing
    result = call(host, "set_clip_speed", itemId=ids_of(premiere, "A.mov")[0], speed=2)
    a_mov(premiere)[0]["speed"] = 1.5
    assert revert(host, result)["changedSince"] == [{"name": "A.mov", "reason": "it was changed since"}]


def test_split_reverts_after_a_speed_set_and_set_back_left_its_ticks_a_hair_off(timing):
    host, premiere, _ = timing
    before = premiere.state()
    result = call(host, "split_clips", itemIds=[ids_of(premiere, "A.mov")[0]], time=1)
    right = result["changes"][0]["items"][0]["right"]["id"]
    premiere.find(right)["inTicks"] = str(int(premiere.find(right)["inTicks"]) + 1081533)
    assert revert(host, result)["reverted"] == [{"kind": "split", "name": "A.mov"}]
    assert premiere.state() == before


def test_tracks_add_and_remove_at_the_end_and_revert(timing):
    host, premiere, _ = timing
    added = call(host, "add_track", type="audio", count=2)
    assert added["addedTracks"] == ["A4", "A5"] and len(premiere.audio) == 5
    with pytest.raises(HostError, match="Only the last"):
        call(host, "remove_track", type="audio", index=4)
    removed = call(host, "remove_track", type="audio", index=5)
    assert len(premiere.audio) == 4
    assert revert(host, added, removed)["reverted"] == [
        {"kind": "track", "name": "A5"},
        {"kind": "track", "name": "A4, A5"},
    ]
    assert len(premiere.audio) == 3
    premiere.clip(next(iter(premiere.media)), "audio", 3, 20, 21, 0)
    with pytest.raises(HostError, match="has clips on it"):
        call(host, "remove_track", type="audio", index=3)
