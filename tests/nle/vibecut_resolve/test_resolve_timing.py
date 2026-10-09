"""tests/test_resolve_timing.py -- speed, splits and tracks on the connected timeline (resolve_timing.py),
and reverting them. The fakes are test_resolve_edit.py's, with SetSpeed as Resolve 21.1 did it live."""

import pytest

from tests.nle.vibecut_resolve.test_resolve_edit import START, call, make_edit
from vibecut_agent.nle.resolve import HostError


@pytest.fixture
def edit():
    return make_edit()


def on(timeline, kind, index=1):
    return sorted(timeline.tracks[kind][index - 1], key=lambda i: i.start)


def span(item):
    return (item.start - START, item.end - START, item.left)


def revert(host, *changes):
    return call(host, "revert_timeline_changes", changes=list(changes))


def test_split_cuts_picture_and_sound_and_carries_the_look(edit):
    host, timeline, _project, c = edit
    c["v"].grade, c["v"].fades, c["v"].props["ZoomX"] = (
        "warm",
        {"FadeIn": 10.0, "FadeOut": 20.0},
        1.4,
    )
    result = call(host, "split_clips", itemIds=[c["v"].uid], time=4.0)
    (change,) = result["changes"]
    lv, rv = on(timeline, "video")
    la, ra = on(timeline, "audio")
    assert (span(lv), span(rv), span(la), span(ra)) == (
        (0, 100, 0),
        (100, 250, 100),
        (0, 100, 0),
        (100, 250, 100),
    )
    assert (lv.grade, rv.grade, rv.props["ZoomX"], ra.props["AudioVolume"]) == (
        "warm",
        "warm",
        1.4,
        -3.0,
    )
    assert (lv.fades, rv.fades) == (
        {"FadeIn": 10.0, "FadeOut": 0.0},
        {"FadeIn": 0.0, "FadeOut": 20.0},
    )
    assert lv.links == [la] and set(rv.links) == {ra}
    assert change["cut"] == 4.0 and change["notCarried"] == []
    assert result["renamed"] == {c["v"].uid: lv.uid, c["a"].uid: la.uid}
    assert change["items"][0]["right"] == {
        "id": rv.uid,
        "track": ["video", 1],
        "start": 4.0,
        "end": 10.0,
        "sourceStartFrame": 100,
    }
    # The holder's temporary track is gone.
    assert timeline.GetTrackCount("video") == 1

    assert revert(host, change)["reverted"] == [{"kind": "split", "name": "A.mov"}]
    (v,) = on(timeline, "video")
    (a,) = on(timeline, "audio")
    assert (span(v), span(a), v.grade, v.fades) == (
        (0, 250, 0),
        (0, 250, 0),
        "warm",
        {"FadeIn": 10.0, "FadeOut": 20.0},
    )


def test_split_keeps_unrelated_clips_unlinked(edit):
    # Splitting an interview pair and unlinked B-roll together leaves the B-roll on its own.
    host, timeline, _project, c = edit
    timeline.tracks["video"].append([])
    broll = timeline.place("video", 2, c["broll"], 0, 250)
    call(host, "split_clips", itemIds=[c["v"].uid, broll.uid], time=4.0)
    lv, rv = on(timeline, "video")
    lb, rb = on(timeline, "video", 2)
    la, ra = on(timeline, "audio")
    assert (lb.links, rb.links) == ([], [])
    assert (lv.links, rv.links) == ([la], [ra])


def test_split_refusals_and_a_revert_after_a_change(edit):
    host, timeline, _project, c = edit
    with pytest.raises(HostError, match="doesn't run across"):
        call(host, "split_clips", itemIds=[c["v"].uid], time=12.0)
    c["v"].speed = 50.0
    with pytest.raises(HostError, match="speed change"):
        call(host, "split_clips", itemIds=[c["v"].uid], time=4.0)
    c["v"].speed = 100.0
    (change,) = call(host, "split_clips", itemIds=[c["a"].uid], time=4.0)["changes"]
    _left, right = on(timeline, "video")
    right.start += 5
    assert revert(host, change)["changedSince"] == [{"name": "A.mov", "reason": "it was changed since"}]


# Phase 12b and 12d: VibeCut's speed and track tests.


def test_speed_keeps_the_clip_in_place_and_reverts(edit):
    host, timeline, _project, c = edit
    result = call(host, "set_clip_speed", itemId=c["v"].uid, speed=2)
    (change,) = result["changes"]
    assert change == {
        "kind": "speed", "itemId": c["v"].uid, "name": "A.mov", "before": 1.0, "after": 2.0,
        "ripple": False, "start": 0.0, "endBefore": 10.0, "end": 10.0,
    }  # fmt: skip
    assert (c["v"].speed, c["a"].speed, span(c["v"])) == (200.0, 200.0, (0, 250, 0))
    assert revert(host, change)["reverted"] == [{"kind": "speed", "name": "A.mov"}]
    assert (c["v"].speed, c["a"].speed) == (100.0, 100.0)


def test_speed_refusals_and_a_change_since(edit):
    host, _timeline, _project, c = edit
    with pytest.raises(HostError, match="from 0.05 to 20"):
        call(host, "set_clip_speed", itemId=c["v"].uid, speed=40)
    # 10 s of a 30 s file at 4x would need 40 s of source.
    with pytest.raises(HostError, match="source runs out"):
        call(host, "set_clip_speed", itemId=c["v"].uid, speed=4)
    assert call(host, "set_clip_speed", itemId=c["v"].uid, speed=1)["changes"] == []
    (change,) = call(host, "set_clip_speed", itemId=c["v"].uid, speed=2)["changes"]
    c["v"].speed = 150.0
    assert revert(host, change)["changedSince"] == [{"name": "A.mov", "reason": "it was changed since"}]


def test_speed_with_ripple_moves_later_clips_and_moves_them_back(edit):
    host, timeline, _project, c = edit
    later = timeline.place("video", 1, c["broll"], 250, 300)
    (change,) = call(host, "set_clip_speed", itemId=c["v"].uid, speed=0.5, ripple=True)["changes"]
    assert (span(c["v"])[:2], span(later)[:2], change["end"]) == (
        (0, 500),
        (500, 550),
        20.0,
    )
    assert revert(host, change)["reverted"]
    assert (span(c["v"])[:2], span(later)[:2]) == ((0, 250), (250, 300))


def test_tracks_are_added_and_removed_at_the_end_and_reverted(edit):
    host, timeline, _project, c = edit
    added = call(host, "add_track", type="video", count=2)
    assert added["addedTracks"] == ["V2", "V3"] and timeline.GetTrackCount("video") == 3
    with pytest.raises(HostError, match="Only the last"):
        call(host, "remove_track", type="video", index=2)
    (removed,) = call(host, "remove_track", type="video", index=3)["changes"]
    assert timeline.GetTrackCount("video") == 2
    assert revert(host, *added["changes"], removed)["reverted"] == [
        {"kind": "track", "name": "V3"},
        {"kind": "track", "name": "V2, V3"},
    ]
    assert timeline.GetTrackCount("video") == 1
    call(host, "add_track", type="audio")
    timeline.place("audio", 2, c["music"], 0, 50)
    with pytest.raises(HostError, match="has clips on it"):
        call(host, "remove_track", type="audio", index=2)
