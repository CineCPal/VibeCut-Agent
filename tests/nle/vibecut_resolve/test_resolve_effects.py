"""tests/test_resolve_effects.py -- fades and transitions on the connected timeline (resolve_effects.py) and
reverting them. The fakes are test_resolve_edit.py's, which behave as Resolve 21.1 did in the 6e.0 probe."""

import pytest

from tests.nle.vibecut_resolve.test_resolve_edit import START, call, make_edit
from vibecut_agent.nle.resolve import HostError


@pytest.fixture
def edit():
    """A.mov on V1/A1 at 0-10 s (from its start, 30 s long), then B.mov on V1 at 10-20 s from 2 s in."""
    host, timeline, project, c = make_edit()
    c["b"] = timeline.place("video", 1, c["broll"], 250, 500, left=50)
    return host, timeline, project, c


def transitions(timeline, kind="video"):
    return [i for i in timeline.tracks[kind][0] if i.transition]


def test_fades_in_frames_cut_to_fit_and_revert(edit):
    host, _timeline, _project, c = edit
    result = call(host, "set_clip_fades", itemIds=[c["v"].uid, c["a"].uid], which="fadeIn", seconds=1)
    assert [ch["after"] for ch in result["changes"]] == [1.0, 1.0]
    assert c["v"].fades == {"FadeIn": 25, "FadeOut": 0} and c["a"].fades["FadeIn"] == 25
    out = call(host, "set_clip_fades", itemIds=[c["v"].uid], which="fadeOut", seconds=60)
    (change,) = out["changes"]
    assert change == {
        "kind": "fade", "itemId": c["v"].uid, "name": "A.mov", "track": ["video", 1], "which": "fadeOut",
        "before": 0.0, "after": 9.0, "clamped": True,
    }  # fmt: skip
    reverted = call(host, "revert_timeline_changes", changes=result["changes"] + out["changes"])
    assert [r["kind"] for r in reverted["reverted"]] == ["fade"] * 3
    assert c["v"].fades == {"FadeIn": 0, "FadeOut": 0} and c["a"].fades["FadeIn"] == 0


def test_a_fade_changed_since_is_left(edit):
    host, _timeline, _project, c = edit
    result = call(host, "set_clip_fades", itemIds=[c["v"].uid], which="fadeIn", seconds=1)
    c["v"].fades["FadeIn"] = 10.0
    reverted = call(host, "revert_timeline_changes", changes=result["changes"])
    assert reverted["changedSince"] == [{"name": "A.mov", "reason": "it was changed since"}]
    assert c["v"].fades["FadeIn"] == 10.0


def test_a_dissolve_sits_centred_on_the_cut_cut_to_the_handles_and_reverts(edit):
    host, timeline, _project, c = edit
    result = call(host, "set_transition", itemId=c["v"].uid, kind="dissolve", seconds=6)
    (change,) = result["changes"]
    # B.mov has only 2 s of its file before its in point: 4 s at most, centred.
    (t,) = transitions(timeline)
    assert (t.transition, t.start - START, t.end - START) == ("Cross Dissolve", 200, 300)
    assert change["name"] == "A.mov → B.mov" and change["cut"] == 10.0 and change["clamped"] is True
    assert (
        change["before"] is None
        and change["after"]["kind"] == "dissolve"
        and change["after"]["seconds"] == 4.0
    )
    reverted = call(host, "revert_timeline_changes", changes=result["changes"])
    assert [r["kind"] for r in reverted["reverted"]] == ["transition"] and transitions(timeline) == []


def test_changing_and_removing_a_transition_and_putting_the_old_one_back(edit):
    host, timeline, _project, c = edit
    first = call(host, "set_transition", itemId=c["v"].uid, kind="dissolve")
    dip = call(host, "set_transition", itemId=c["v"].uid, kind="dipToBlack")
    (t,) = transitions(timeline)
    assert (t.transition, t.end - t.start) == ("Dip To Color Dissolve", 25), (
        "the length stays when only the kind changes"
    )
    assert dip["changes"][0]["before"]["type"] == "Cross Dissolve"
    gone = call(host, "set_transition", itemId=c["v"].uid, kind="none")
    assert transitions(timeline) == [] and gone["changes"][0]["after"] is None
    reverted = call(
        host, "revert_timeline_changes", changes=first["changes"] + dip["changes"] + gone["changes"]
    )
    assert len(reverted["reverted"]) == 3 and transitions(timeline) == []


def test_transitions_are_refused_without_a_cut_or_room_and_dips_on_sound(edit):
    host, timeline, _project, c = edit
    with pytest.raises(HostError, match="No clip starts where 'B.mov' ends"):
        call(host, "set_transition", itemId=c["b"].uid, kind="dissolve")
    c["b"].left = 0
    with pytest.raises(HostError, match="No room for a dissolve"):
        call(host, "set_transition", itemId=c["v"].uid, kind="dissolve")
    # A dip needs no handles.
    assert call(host, "set_transition", itemId=c["v"].uid, kind="dipToBlack")["changes"]
    with pytest.raises(HostError, match="no cut"):
        call(host, "set_transition", itemId=c["a"].uid, kind="dissolve")
    timeline.place("audio", 1, c["music"], 250, 500)
    with pytest.raises(HostError, match="A dip to black is for picture"):
        call(host, "set_transition", itemId=c["a"].uid, kind="dipToBlack")
    with pytest.raises(HostError, match="kind must be"):
        call(host, "set_transition", itemId=c["v"].uid, kind="wipe")


def test_a_transition_changed_since_is_left(edit):
    host, timeline, _project, c = edit
    result = call(host, "set_transition", itemId=c["v"].uid, kind="dissolve")
    (t,) = transitions(timeline)
    t.start -= 5  # the user lengthened it in Resolve
    reverted = call(host, "revert_timeline_changes", changes=result["changes"])
    assert reverted["changedSince"] == [{"name": "A.mov → B.mov", "reason": "it was changed since"}]
    assert transitions(timeline) == [t]
