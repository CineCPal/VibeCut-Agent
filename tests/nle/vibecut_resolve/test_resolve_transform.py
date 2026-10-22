"""Scale and position on the connected timeline (resolve_transform.py, Phase 16f) against
test_resolve_edit.py's fakes: a still look in the Inspector, an animated one as a "VibeCut Move" Fusion
composition whose Transform keys are read back."""

import pytest

from tests.nle.vibecut_resolve.test_resolve_edit import FusionComp, call, make_edit
from vibecut_agent.nle.resolve_transform import MOVE_COMP, MOVE_TOOL


@pytest.fixture
def edit():
    host, timeline, project, c = make_edit()
    sizes = {"timelineResolutionWidth": "1920", "timelineResolutionHeight": "1080", "timelineFrameRate": "25"}
    timeline.GetSetting = lambda key: sizes.get(key, "")
    return host, timeline, project, c


def move_of(item):
    comp = item.GetFusionCompByName(MOVE_COMP)
    tool = comp.FindTool(MOVE_TOOL)
    return comp, tool


def test_a_still_look_sets_the_inspector_and_reverts(edit):
    host, _timeline, _project, c = edit
    result = call(
        host, "set_clip_transform", transforms=[{"itemId": c["v"].uid, "scale": 120, "x": 96, "y": -54}]
    )
    (change,) = result["changes"]
    assert (change["kind"], change["name"], change["track"]) == ("transform", "A.mov", ["video", 1])
    assert (change["before"], change["after"]) == (
        {"scale": 100.0, "x": 0.0, "y": 0.0},
        {"scale": 120.0, "x": 96.0, "y": -54.0},
    )
    assert {k: c["v"].props[k] for k in ("ZoomX", "ZoomY", "Pan", "Tilt")} == pytest.approx(
        {"ZoomX": 1.2, "ZoomY": 1.2, "Pan": 96.0, "Tilt": -54.0}
    )
    assert c["v"].comps == []
    assert (
        call(host, "set_clip_transform", transforms=[{"itemId": c["v"].uid, "scale": 120}])["changes"] == []
    )
    reverted = call(host, "revert_timeline_changes", changes=[change])
    assert reverted["reverted"] == [{"kind": "transform", "name": "A.mov"}]
    assert (c["v"].props["ZoomX"], c["v"].props["Pan"]) == (1.0, 0.0)


@pytest.mark.parametrize("start", [0, 1000])
def test_keyframes_make_a_fusion_move_at_the_clips_frames_and_revert(edit, start, monkeypatch):
    host, _timeline, _project, c = edit
    monkeypatch.setattr(FusionComp, "start", start)
    c["v"].props.update({"ZoomX": 1.5, "ZoomY": 1.5, "Pan": 100.0})
    result = call(
        host,
        "set_clip_transform",
        transforms=[{"itemId": c["v"].uid, "keyframes": [{"at": 0, "scale": 100}, {"at": 4, "scale": 120}]}],
    )
    (change,) = result["changes"]
    assert result["refused"] == []
    comp, tool = move_of(c["v"])
    assert [n for n, _ in c["v"].comps] == [MOVE_COMP]
    assert (
        tool.connected["Input"] is comp.FindTool("MediaIn1")
        and comp.FindTool("MediaOut1").connected["Input"] is tool
    )
    assert tool.splines["Size"] == {start: 1.0, start + 100: 1.2}
    # Position wasn't given, so it stays where the Inspector had it (100 px right), now in the move.
    assert tool.splines["Center"][start] == {1: pytest.approx(0.5 + 100 / 1920), 2: 0.5}
    # The Inspector goes back to 100% at the centre, so the move is the whole look.
    assert (c["v"].props["ZoomX"], c["v"].props["ZoomY"], c["v"].props["Pan"]) == (1.0, 1.0, 0.0)
    assert change["before"] == {"scale": 150.0, "x": 100.0, "y": 0.0}
    assert change["after"] == {
        "keys": [
            {"at": 0.0, "scale": 100.0, "x": 100.0, "y": 0.0},
            {"at": 4.0, "scale": 120.0, "x": 100.0, "y": 0.0},
        ]
    }
    read = call(host, "read_clip_transforms", itemIds=[c["v"].uid])
    assert read["clips"] == [{"itemId": c["v"].uid, "name": "A.mov", **change["after"]}]
    reverted = call(host, "revert_timeline_changes", changes=[change])
    assert reverted["reverted"] == [{"kind": "transform", "name": "A.mov"}]
    assert c["v"].comps == [] and (c["v"].props["ZoomX"], c["v"].props["Pan"]) == (1.5, 100.0)


def test_a_still_look_replaces_vibecuts_move_and_revert_puts_it_back(edit):
    host, _timeline, _project, c = edit
    moved = call(
        host,
        "set_clip_transform",
        transforms=[{"itemId": c["v"].uid, "keyframes": [{"at": 0, "x": -192}, {"at": 2, "x": 192}]}],
    )
    still = call(host, "set_clip_transform", transforms=[{"itemId": c["v"].uid, "scale": 110}])
    assert c["v"].comps == []
    # x wasn't given, so it's the move's starting x.
    assert (c["v"].props["ZoomX"], c["v"].props["Pan"]) == (pytest.approx(1.1), pytest.approx(-192.0))
    reverted = call(host, "revert_timeline_changes", changes=[*moved["changes"], *still["changes"]])
    assert len(reverted["reverted"]) == 2 and c["v"].comps == []
    # Reverting only the still look rebuilds the move.
    again = call(
        host,
        "set_clip_transform",
        transforms=[{"itemId": c["v"].uid, "keyframes": [{"at": 0, "x": -192}, {"at": 2, "x": 192}]}],
    )
    still = call(host, "set_clip_transform", transforms=[{"itemId": c["v"].uid, "scale": 110}])
    assert call(host, "revert_timeline_changes", changes=still["changes"])["reverted"]
    _comp, tool = move_of(c["v"])
    assert sorted(tool.splines["Center"]) == [0, 50]
    assert again["changes"][0]["after"]["keys"][1]["x"] == 192.0


def test_resolve_not_taking_the_keys_removes_the_move_and_refuses(edit, monkeypatch):
    host, _timeline, _project, c = edit
    monkeypatch.setattr(FusionComp, "ignores_time", True)
    c["v"].props["Pan"] = 40.0
    result = call(
        host,
        "set_clip_transform",
        transforms=[{"itemId": c["v"].uid, "keyframes": [{"at": 0, "scale": 100}, {"at": 1, "scale": 130}]}],
    )
    assert result["changes"] == [] and "didn't take" in result["refused"][0]["reason"]
    assert c["v"].comps == [] and c["v"].props["Pan"] == 40.0


def test_refusals_leave_the_clip(edit):
    host, timeline, _project, c = edit
    other = timeline.place("video", 1, c["broll"], 300, 400)
    other.comps.append(("Composition 1", "the user's own"))
    sped = timeline.place("video", 1, c["broll"], 500, 600)
    sped.speed = 200.0
    uneven = timeline.place("video", 1, c["broll"], 700, 800)
    uneven.props.update({"ZoomX": 1.2, "ZoomY": 1.0})
    keyed = [{"at": 0, "scale": 100}, {"at": 1, "scale": 110}]
    result = call(
        host,
        "set_clip_transform",
        transforms=[
            {"itemId": c["a"].uid, "scale": 120},
            {"itemId": other.uid, "keyframes": keyed},
            {"itemId": sped.uid, "keyframes": keyed},
            {"itemId": uneven.uid, "scale": 130},
            {"itemId": c["v"].uid, "keyframes": [{"at": 0, "scale": 100}, {"at": 11, "scale": 110}]},
        ],
    )
    assert result["changes"] == []
    reasons = [r["reason"] for r in result["refused"]]
    assert "sound has no picture" in reasons[0]
    assert "Fusion composition of its own" in reasons[1]
    assert "speed change" in reasons[2]
    assert "Zoom X and Y differ" in reasons[3]
    assert "past its end" in reasons[4]
    # Still looks are fine on the comp and the sped-up clip; position is fine on the uneven one.
    ok = call(
        host,
        "set_clip_transform",
        transforms=[
            {"itemId": other.uid, "scale": 110},
            {"itemId": sped.uid, "x": 5},
            {"itemId": uneven.uid, "y": 5},
        ],
    )
    assert len(ok["changes"]) == 3 and other.comps == [("Composition 1", "the user's own")]


def test_revert_leaves_a_clip_changed_since(edit):
    host, _timeline, _project, c = edit
    result = call(host, "set_clip_transform", transforms=[{"itemId": c["v"].uid, "scale": 130}])
    c["v"].props["ZoomX"] = c["v"].props["ZoomY"] = 0.9
    reverted = call(host, "revert_timeline_changes", changes=result["changes"])
    assert reverted["reverted"] == [] and "changed since" in reverted["changedSince"][0]["reason"]
    assert c["v"].props["ZoomX"] == 0.9
