"""Ported from VibeCut (PLAN.md, "Phase 6c"): links on the connected sequence (links.py, VibeCut's premiere_structure.py)
against test_premiere_edit.py's fake Premiere, which links whole selections and moves one clip at a
time the way 26.5.2 did in the 8a.0 probe."""

import pytest

from tests.nle.vibecut_premiere.test_premiere_edit import (
    T,
    call,
    ids_of,
    revert,
    setup,  # noqa: F401  (a fixture)
)
from vibecut_agent.nle.premiere import HostError


def group_of(premiere, item_id):
    return set(premiere.find(item_id)["linkedIds"]) | {item_id}


def span(premiere, item_id):
    clip = premiere.find(item_id)
    return (int(clip["startTicks"]) // T, int(clip["endTicks"]) // T)


def test_link_merges_the_groups_and_reverts(setup):  # noqa: F811
    host, premiere, _ = setup
    before = premiere.state()
    a, b = ids_of(premiere, "A.mov")[0], ids_of(premiere, "B.mov")[0]
    result = call(host, "set_links", itemIds=[a, b], action="link")
    (change,) = result["changes"]
    assert change["kind"] == "link" and change["action"] == "linked"
    assert len(change["groupsBefore"]) == 2 and len(change["groupsAfter"][0]) == 6
    assert len(group_of(premiere, a)) == 6
    assert revert(host, result)["reverted"] == [{"kind": "link", "name": "A.mov"}]
    assert premiere.state() == before


def test_unlink_takes_one_channel_out_and_reverts(setup):  # noqa: F811
    host, premiere, _ = setup
    before = premiere.state()
    picture = ids_of(premiere, "A.mov")[0]
    left, right = ids_of(premiere, "A.mov", "audio")
    result = call(host, "set_links", itemIds=[right], action="unlink")
    assert group_of(premiere, right) == {right}
    assert group_of(premiere, picture) == {picture, left}
    assert call(host, "set_links", itemIds=[right], action="unlink")["changes"] == []
    assert revert(host, result)["reverted"]
    assert premiere.state() == before


def test_locked_tracks_are_left_alone(setup):  # noqa: F811
    host, premiere, _ = setup
    a, b = ids_of(premiere, "A.mov")[0], ids_of(premiere, "B.mov")[0]
    premiere.flags("video", 0)["locked"] = True
    with pytest.raises(HostError, match="V1 is locked"):
        call(host, "set_links", itemIds=[a, b], action="link")
