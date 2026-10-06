"""tests/test_resolve_reshape.py -- trimming, slipping and moving a clip on the connected timeline by
replacing it (resolve_reshape.py), carrying its look, and reverting that. The fakes are the ones in
test_resolve_edit.py, which refuse an occupied place or a missing track the way Resolve 21.1 does."""

import pytest

from tests.nle.compat import run_command
from tests.nle.vibecut_resolve.test_resolve_edit import START, call, make_edit
from vibecut_agent.nle.resolve import HostError


@pytest.fixture
def edit():
    return make_edit()


def dress(item):
    item.props.update({"ZoomX": 1.3, "Opacity": 80.0})
    item.color, item.fades, item.grade = (
        "Orange",
        {"FadeIn": 5.0, "FadeOut": 10.0},
        "warm grade",
    )
    item.comps = [("Composition 1", "comp data")]


def on(timeline, kind, index=1):
    return timeline.tracks[kind][index - 1]


def test_trim_start_replaces_picture_and_sound_and_carries_the_look(edit):
    host, timeline, _project, c = edit
    dress(c["v"])
    result = call(host, "reshape_clip", itemId=c["v"].uid, sourceIn=2.0)
    (change,) = result["changes"]
    assert change["how"] == "trimmed" and change["name"] == "A.mov" and change["notCarried"] == []
    (v,) = on(timeline, "video")
    (a,) = on(timeline, "audio")
    assert (v.start - START, v.end - START, v.left) == (50, 250, 50)
    assert (a.start - START, a.left, a.props["AudioVolume"]) == (50, 50, -3.0)
    assert (v.props["ZoomX"], v.props["Opacity"], v.color, v.fades, v.grade) == (
        1.3,
        80.0,
        "Orange",
        {"FadeIn": 5.0, "FadeOut": 10.0},
        "warm grade",
    )
    assert [name for name, _ in v.comps] == ["Composition 1"] and v.links == [a]
    # The holder and its temporary track are gone.
    assert timeline.GetTrackCount("video") == 1
    assert result["renamed"] == {c["v"].uid: v.uid, c["a"].uid: a.uid}
    assert change["items"][0]["before"] == {
        "id": c["v"].uid,
        "track": ["video", 1],
        "start": 0.0,
        "end": 10.0,
        "sourceStartFrame": 0,
    }


def test_trim_end_slip_and_move(edit):
    host, timeline, _project, c = edit
    call(host, "reshape_clip", itemId=c["v"].uid, sourceOut=6.0)
    (v,) = on(timeline, "video")
    assert (v.start - START, v.end - START, v.left) == (0, 150, 0)
    call(host, "reshape_clip", itemId=v.uid, slip=1.0)
    (v,) = on(timeline, "video")
    assert (v.start - START, v.end - START, v.left) == (0, 150, 25)
    timeline.AddTrack("video")
    moved = call(host, "reshape_clip", itemId=v.uid, start=20.0, videoTrack=2)
    assert moved["changes"][0]["how"] == "moved"
    (v,) = on(timeline, "video", 2)
    (a,) = on(timeline, "audio")
    assert (v.start - START, v.left, a.start - START) == (500, 25, 500) and on(timeline, "video") == []


def test_refuses_what_it_cant_do_faithfully_before_touching_anything(edit):
    host, timeline, _project, c = edit
    c["v"].speed = 200.0
    with pytest.raises(HostError, match="speed change"):
        call(host, "reshape_clip", itemId=c["v"].uid, sourceIn=1.0)
    c["v"].speed = 100.0
    timeline.place("video", 1, None, 250, 260, left=None)  # a transition at the out edge
    with pytest.raises(HostError, match="transition"):
        call(host, "reshape_clip", itemId=c["v"].uid, slip=1.0)
    timeline.tracks["video"][0].pop()
    with pytest.raises(HostError, match="only 30.0 s long"):
        call(host, "reshape_clip", itemId=c["v"].uid, slip=25.0)
    with pytest.raises(HostError, match="of source before its start"):
        call(host, "reshape_clip", itemId=c["v"].uid, slip=-1.0)
    with pytest.raises(HostError, match="one kind of change"):
        call(host, "reshape_clip", itemId=c["v"].uid, slip=1.0, start=3.0)
    with pytest.raises(HostError, match="goes with start"):
        call(host, "reshape_clip", itemId=c["v"].uid, slip=1.0, videoTrack=1)
    blocker = timeline.place("video", 1, c["broll"], 300, 400)
    with pytest.raises(HostError, match="V1 isn't free"):
        call(host, "reshape_clip", itemId=c["v"].uid, start=5.0)
    assert on(timeline, "video")[0] is c["v"] and blocker in on(timeline, "video")


def test_puts_everything_back_when_resolve_refuses_the_new_place(edit):
    host, timeline, project, c = edit
    dress(c["v"])
    real = project.pool.AppendToTimeline

    def refuse_moves(infos):
        # Refuse the new range; allow the holder (1 frame) and putting it back at source 0.
        if infos[0]["endFrame"] - infos[0]["startFrame"] not in (1, 250):
            from tests.nle.vibecut_resolve.test_resolve_edit import Dead

            return [Dead()]
        return real(infos)

    project.pool.AppendToTimeline = refuse_moves
    with pytest.raises(HostError, match="put back where it was"):
        call(host, "reshape_clip", itemId=c["v"].uid, sourceIn=2.0)
    (v,) = on(timeline, "video")
    assert (v.start - START, v.end - START, v.left, v.grade, v.color) == (
        0,
        250,
        0,
        "warm grade",
        "Orange",
    )
    assert timeline.GetTrackCount("video") == 1


def test_revert_reshapes_back_following_each_replacement(edit):
    host, timeline, _project, c = edit
    dress(c["v"])
    log = []
    for args in ({"sourceIn": 2.0}, {"sourceOut": 8.0}, {"slip": 0.4}):
        current = on(timeline, "video")[0]
        log += call(host, "reshape_clip", itemId=current.uid, **args)["changes"]
    result = call(host, "revert_timeline_changes", changes=log)
    assert [r["kind"] for r in result["reverted"]] == ["reshaped"] * 3 and result["changedSince"] == []
    (v,) = on(timeline, "video")
    (a,) = on(timeline, "audio")
    assert (v.start - START, v.end - START, v.left, a.left) == (0, 250, 0, 0)
    assert (v.grade, v.props["ZoomX"], v.links) == ("warm grade", 1.3, [a])


def test_revert_leaves_a_reshaped_clip_that_was_moved_since(edit):
    host, timeline, _project, c = edit
    change = call(host, "reshape_clip", itemId=c["v"].uid, sourceIn=2.0)["changes"]
    on(timeline, "video")[0].start += 5  # moved by hand
    result = call(host, "revert_timeline_changes", changes=change)
    assert result["changedSince"] == [{"name": "A.mov", "reason": "it was changed since"}]


def test_a_deleted_clip_gets_its_look_back_from_the_backup(edit):
    host, timeline, project, c = edit
    dress(c["v"])
    backup = project.timelines[-1] = type(timeline)("Interview (before VibeCut 1)")  # a stand-in copy
    project.timelines.append(timeline)  # keep the connected one findable
    backup.project = project
    copy = backup.place("video", 1, c["interview"], 0, 250)
    copy.grade, copy.props["ZoomX"], copy.fades = (
        "warm grade",
        1.3,
        {"FadeIn": 5.0, "FadeOut": 10.0},
    )
    deleted = call(host, "delete_clips", itemIds=[c["v"].uid])["changes"]
    result = run_command(
        host,
        "revert_timeline_changes",
        {
            "timeline": "Interview",
            "changes": deleted,
            "backup": "Interview (before VibeCut 1)",
        },
    )
    assert result["gradedFromBackup"] == ["A.mov"]
    (v,) = on(timeline, "video")
    assert (v.grade, v.props["ZoomX"], v.fades["FadeIn"]) == ("warm grade", 1.3, 5.0)


def test_a_sound_slipped_alone_stays_linked_to_its_picture(edit):
    host, timeline, _project, c = edit
    result = call(host, "reshape_clip", itemId=c["a"].uid, slip=0.2, withLinked=False)
    (change,) = result["changes"]
    assert change["how"] == "slipped" and len(change["items"]) == 1
    (v,) = on(timeline, "video")
    (a,) = on(timeline, "audio")
    # The picture is the same item, untouched; the new sound is linked to it.
    assert v is c["v"] and (v.start - START, v.left) == (0, 0)
    assert (a.start - START, a.left) == (0, 5)
    assert v.links == [a] and a.links == [v]

    # Reverted, the sound comes back and is linked to the picture again.
    reverted = call(host, "revert_timeline_changes", changes=result["changes"])
    assert [r["kind"] for r in reverted["reverted"]] == ["reshaped"]
    (a,) = on(timeline, "audio")
    assert a.left == 0 and v.links == [a] and a.links == [v]


def test_only_a_slip_leaves_the_linked_clips_behind(edit):
    host, timeline, _project, c = edit
    with pytest.raises(HostError, match="withLinked false goes with slip only"):
        call(host, "reshape_clip", itemId=c["a"].uid, sourceIn=1.0, withLinked=False)
    with pytest.raises(HostError, match="withLinked false goes with slip only"):
        call(host, "reshape_clip", itemId=c["a"].uid, start=3.0, withLinked=False)
    assert on(timeline, "audio") == [c["a"]]
