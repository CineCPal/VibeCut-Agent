"""Ported from VibeCut (PLAN.md, "Phase 6c"): links on the connected timeline (links.py, VibeCut's
timeline (resolve_structure.py), and reverting them. The fakes are test_resolve_edit.py's, with links and
track switches as Resolve 21.1 did them in the 8a.0 probe."""

import pytest

from tests.nle.vibecut_resolve.test_resolve_edit import START, call, make_edit
from vibecut_agent.nle.errors import HostError


@pytest.fixture
def edit():
    host, timeline, project, c = make_edit()
    timeline.tracks["video"].append([])
    c["b"] = timeline.place("video", 2, c["broll"], 0, 100)
    return host, timeline, project, c


def revert(host, *changes):
    return call(host, "revert_timeline_changes", changes=list(changes))


def span(item):
    return (item.start - START, item.end - START)


def on(timeline, kind, index=1):
    return sorted(timeline.tracks[kind][index - 1], key=lambda i: i.start)


def test_link_merges_the_groups_and_reverts(edit):
    host, timeline, _project, c = edit
    v, a, b = c["v"], c["a"], c["b"]
    (change,) = call(host, "set_links", itemIds=[v.uid, b.uid], action="link")[
        "changes"
    ]
    assert change["kind"] == "link" and change["action"] == "linked"
    assert change["groupsBefore"] == sorted([sorted([v.uid, a.uid]), [b.uid]])
    assert change["groupsAfter"] == [sorted([v.uid, a.uid, b.uid])]
    assert set(b.links) == {v, a} and set(v.links) == {a, b}
    assert revert(host, change)["reverted"] == [{"kind": "link", "name": "A.mov"}]
    assert (v.links, a.links, b.links) == ([a], [v], [])


def test_unlink_takes_a_clip_out_and_leaves_the_rest_linked(edit):
    host, timeline, _project, c = edit
    v, a, b = c["v"], c["a"], c["b"]
    call(host, "set_links", itemIds=[v.uid, b.uid], action="link")
    (change,) = call(host, "set_links", itemIds=[b.uid], action="unlink")["changes"]
    assert change["groupsAfter"] == sorted([sorted([v.uid, a.uid]), [b.uid]])
    assert (set(v.links), set(a.links), b.links) == ({a}, {v}, [])
    # Unlinking what's already alone changes nothing.
    assert call(host, "set_links", itemIds=[b.uid], action="unlink")["changes"] == []
    assert revert(host, change)["reverted"]
    assert set(b.links) == {v, a}


def test_stale_one_way_links_dont_count(edit):
    host, _timeline, _project, c = edit
    v, a, b = c["v"], c["a"], c["b"]
    # What Resolve left in the probe: a still lists v and b, which don't list it back.
    v.links, a.links, b.links = [], [v, b], []
    (change,) = call(host, "set_links", itemIds=[v.uid, a.uid], action="link")[
        "changes"
    ]
    assert change["groupsBefore"] == sorted([[v.uid], [a.uid]])
    assert (v.links, a.links) == ([a], [v])


def test_links_refused_on_a_locked_track_and_a_changed_revert(edit):
    host, timeline, project, c = edit
    v, a, b = c["v"], c["a"], c["b"]
    project.current = timeline
    timeline.SetTrackLock("video", 2, True)
    with pytest.raises(HostError, match="V2 is locked"):
        call(host, "set_links", itemIds=[v.uid, b.uid], action="link")
    timeline.SetTrackLock("video", 2, False)
    with pytest.raises(HostError, match="at least two"):
        call(host, "set_links", itemIds=[v.uid], action="link")
    (change,) = call(host, "set_links", itemIds=[a.uid], action="unlink")["changes"]
    timeline.SetClipsLinked([v, a], True)
    assert revert(host, change)["changedSince"] == [
        {"name": "A.mov", "reason": "it was changed since"}
    ]
