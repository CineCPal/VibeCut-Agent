"""Scale and position on the connected sequence (premiere_transform.py, Phase 16f) against
test_premiere_edit.py's fake Premiere, which keeps each picture clip's Motion Scale and Position as the
panel reads them (Position a fraction of the 1920x1080 frame, y down; keys at source ticks)."""

import pytest

from tests.nle.vibecut_premiere.test_premiere_edit import (
    T,
    call,
    ids_of,
    revert,
    setup,  # noqa: F401  (a fixture)
)
from vibecut_agent.nle.premiere import HostError


def ticks(seconds):
    return str(round(seconds * T))


def test_a_still_scale_and_position_set_motion_and_revert(setup):  # noqa: F811
    host, premiere, _ = setup
    (picture,) = ids_of(premiere, "A.mov")
    result = call(
        host, "set_clip_transform", transforms=[{"itemId": picture, "scale": 120, "x": 96, "y": -54}]
    )
    (change,) = result["changes"]
    assert result["refused"] == []
    assert {k: change[k] for k in ("kind", "itemId", "name", "track", "before", "after")} == {
        "kind": "transform",
        "itemId": picture,
        "name": "A.mov",
        "track": ["video", 1],
        "before": {"scale": 100.0, "x": 0.0, "y": 0.0},
        "after": {"scale": 120.0, "x": 96.0, "y": -54.0},
    }
    motion = premiere.motions[picture]
    assert motion["scale"] == {"keys": [], "value": 120}
    # 96 px right of 1920 is 0.05 of the frame; 54 px down (y up is negative) is 0.05 of 1080.
    assert motion["position"]["keys"] == [] and motion["position"]["value"] == pytest.approx([0.55, 0.55])
    # The same again changes nothing.
    again = call(
        host, "set_clip_transform", transforms=[{"itemId": picture, "scale": 120, "x": 96, "y": -54}]
    )
    assert again["changes"] == []
    reverted = revert(host, result)
    assert reverted["reverted"] == [{"kind": "transform", "name": "A.mov"}]
    assert premiere.motions[picture]["scale"]["value"] == 100.0
    assert premiere.motions[picture]["position"]["value"] == [0.5, 0.5]


def test_only_the_fields_given_change(setup):  # noqa: F811
    host, premiere, _ = setup
    (picture,) = ids_of(premiere, "A.mov")
    premiere._motion(picture)["position"]["value"] = [0.25, 0.5]
    (change,) = call(host, "set_clip_transform", transforms=[{"itemId": picture, "y": 108}])["changes"]
    assert change["after"] == {"scale": 100.0, "x": -480.0, "y": 108.0}
    assert premiere.motions[picture]["position"]["value"] == pytest.approx([0.25, 0.4])
    assert premiere.motions[picture]["scale"] == {"keys": [], "value": 100.0}


def test_keyframes_animate_scale_at_source_times_and_revert(setup):  # noqa: F811
    host, premiere, _ = setup
    (picture,) = ids_of(premiere, "A.mov")
    result = call(
        host,
        "set_clip_transform",
        transforms=[{"itemId": picture, "keyframes": [{"at": 3, "scale": 120}, {"at": 0, "scale": 100}]}],
    )
    (change,) = result["changes"]
    # A.mov plays its file from 2 s, so its keys sit at 2 s and 5 s; Position is left alone.
    assert premiere.motions[picture]["scale"]["keys"] == [
        {"ticks": ticks(2), "value": 100},
        {"ticks": ticks(5), "value": 120},
    ]
    assert premiere.motions[picture]["position"] == {"keys": [], "value": [0.5, 0.5]}
    assert change["after"] == {
        "keys": [
            {"at": 0.0, "scale": 100.0, "x": 0.0, "y": 0.0},
            {"at": 3.0, "scale": 120.0, "x": 0.0, "y": 0.0},
        ]
    }
    assert revert(host, result)["reverted"] == [{"kind": "transform", "name": "A.mov"}]
    assert premiere.motions[picture]["scale"] == {"keys": [], "value": 100.0}


def test_keyframes_move_position_and_a_still_value_replaces_them(setup):  # noqa: F811
    host, premiere, _ = setup
    (picture,) = ids_of(premiere, "A.mov")
    moved = call(
        host,
        "set_clip_transform",
        transforms=[{"itemId": picture, "keyframes": [{"at": 0, "x": -192}, {"at": 1.6, "x": 192}]}],
    )
    keys = premiere.motions[picture]["position"]["keys"]
    assert [k["ticks"] for k in keys] == [ticks(2), ticks(3.6)]
    assert [k["value"] for k in keys] == [pytest.approx([0.4, 0.5]), pytest.approx([0.6, 0.5])]
    still = call(host, "set_clip_transform", transforms=[{"itemId": picture, "x": 0}])
    assert premiere.motions[picture]["position"] == {"keys": [], "value": pytest.approx([0.5, 0.5])}
    assert still["changes"][0]["before"]["keys"][1]["x"] == 192.0
    # Reverting both, newest first, leaves the clip as it started.
    assert len(revert(host, moved, still)["reverted"]) == 2
    assert premiere.motions[picture]["position"] == {"keys": [], "value": [0.5, 0.5]}


def test_refusals_name_the_clip_and_leave_it(setup):  # noqa: F811
    host, premiere, _ = setup
    (a,) = ids_of(premiere, "A.mov")
    (b,) = ids_of(premiere, "B.mov")
    sound = ids_of(premiere, "A.mov", "audio")[0]
    premiere._motion(b)["uniform"] = False
    premiere.find(a)["speed"] = 2
    result = call(
        host,
        "set_clip_transform",
        transforms=[
            {"itemId": a, "keyframes": [{"at": 0, "scale": 100}, {"at": 1, "scale": 110}]},
            {"itemId": b, "scale": 150},
            {"itemId": sound, "scale": 150},
        ],
    )
    assert result["changes"] == []
    reasons = [r["reason"] for r in result["refused"]]
    assert "speed change" in reasons[0] and "Uniform Scale" in reasons[1] and "sound" in reasons[2]
    # A still look on the sped-up clip is fine, and so is Position on the non-uniform one.
    ok = call(host, "set_clip_transform", transforms=[{"itemId": a, "scale": 110}, {"itemId": b, "x": 10}])
    assert len(ok["changes"]) == 2 and ok["refused"] == []


def test_a_keyframe_past_the_clip_is_refused(setup):  # noqa: F811
    host, premiere, _ = setup
    (picture,) = ids_of(premiere, "A.mov")
    result = call(
        host,
        "set_clip_transform",
        transforms=[{"itemId": picture, "keyframes": [{"at": 0, "scale": 100}, {"at": 4, "scale": 110}]}],
    )
    assert "past its end" in result["refused"][0]["reason"]


def test_premiere_not_taking_it_is_refused(setup):  # noqa: F811
    host, premiere, _ = setup
    (picture,) = ids_of(premiere, "A.mov")
    premiere.motion_ignored = True
    result = call(host, "set_clip_transform", transforms=[{"itemId": picture, "scale": 130}])
    assert result["changes"] == [] and "didn't take" in result["refused"][0]["reason"]


def test_revert_leaves_a_clip_changed_since(setup):  # noqa: F811
    host, premiere, _ = setup
    (picture,) = ids_of(premiere, "A.mov")
    result = call(host, "set_clip_transform", transforms=[{"itemId": picture, "scale": 130}])
    premiere.motions[picture]["scale"]["value"] = 90.0
    reverted = revert(host, result)
    assert reverted["reverted"] == [] and premiere.motions[picture]["scale"]["value"] == 90.0


def test_read_clip_transforms_reports_still_and_keyed_looks(setup):  # noqa: F811
    host, premiere, _ = setup
    (a,) = ids_of(premiere, "A.mov")
    (b,) = ids_of(premiere, "B.mov")
    sound = ids_of(premiere, "A.mov", "audio")[0]
    premiere._motion(a)["scale"] = {
        "keys": [{"ticks": ticks(2), "value": 100.0}, {"ticks": ticks(4), "value": 150.0}],
        "value": 100.0,
    }
    premiere._motion(b)["position"]["value"] = [0.5, 0.25]
    read = call(host, "read_clip_transforms", itemIds=[a, b, sound])
    assert read["clips"] == [
        {
            "itemId": a,
            "name": "A.mov",
            "keys": [
                {"at": 0.0, "scale": 100.0, "x": 0.0, "y": 0.0},
                {"at": 2.0, "scale": 150.0, "x": 0.0, "y": 0.0},
            ],
        },
        {"itemId": b, "name": "B.mov", "scale": 100.0, "x": 0.0, "y": 270.0},
    ]
    assert "sound" in read["refused"][0]["reason"]


@pytest.mark.parametrize(
    "transforms, message",
    [
        ([], "transforms must list"),
        ([{"itemId": "x"}], "must give scale, x, y or keyframes"),
        ([{"itemId": "x", "scale": 0}], "scale must be from"),
        ([{"itemId": "x", "x": "left"}], "x must be a number"),
        ([{"itemId": "x", "scale": 110, "keyframes": []}], "belong in each keyframe"),
        ([{"itemId": "x", "keyframes": [{"at": 0, "scale": 100}]}], "2 to 30"),
        (
            [{"itemId": "x", "keyframes": [{"at": 0, "scale": 100}, {"at": 0, "scale": 110}]}],
            "different time",
        ),
        ([{"itemId": "x", "keyframes": [{"at": 0, "scale": 100}, {"at": 1, "x": 10}]}], "same fields"),
        (
            [{"itemId": "x", "keyframes": [{"at": -1, "scale": 100}, {"at": 1, "scale": 110}]}],
            "at must be seconds",
        ),
        ([{"itemId": "x", "scale": 110}, {"itemId": "x", "x": 1}], "once"),
    ],
)
def test_bad_requests_are_refused_before_anything_is_read(setup, transforms, message):  # noqa: F811
    host, premiere, _ = setup
    with pytest.raises(HostError, match=message):
        call(host, "set_clip_transform", transforms=transforms)
    assert "read_motion" not in premiere.calls
