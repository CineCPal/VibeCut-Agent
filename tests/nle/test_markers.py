"""Markers and the playhead in both editors, ported from VibeCut's test_resolve_host.py and
test_premiere_host.py (the same cases, against this package's hosts)."""

import pytest

from tests.nle.fakes import START, TB_25, FakeItem, FakeProject, FakeRequests, FakeResolve, FakeTimeline, info
from vibecut_agent.nle.errors import HostError
from vibecut_agent.nle.premiere import TICKS_PER_SECOND, PremiereHost, to_ticks
from vibecut_agent.nle.resolve import ResolveHost


@pytest.fixture
def timeline():
    t = FakeTimeline("Interview")
    picture = FakeItem("v1", "A.mov", START + 48, START + 240, left=120)
    t.tracks["video"] = [[picture]]
    return t


@pytest.fixture
def host(timeline):
    return ResolveHost(FakeResolve(FakeProject("Doc", [timeline, FakeTimeline("Other", fps="29.97 DF")])))


def host_with(**answers):
    requests = FakeRequests(answers)
    return PremiereHost(requests), requests


# ----------------------------------------------------------------------------- Resolve


def test_add_markers_rounds_to_frames_and_keeps_an_existing_one(host, timeline):
    result = host.add_markers({"timeline": "Interview", "markers": [
        {"time": 1.01, "name": "Hook", "color": "red"},
        {"time": 4, "note": "check focus"},
    ]})  # fmt: skip
    assert [m["id"] for m in result["added"]] == ["f24", "f96"]
    assert timeline.markers[24]["color"] == "Red" and timeline.markers[24]["name"] == "Hook"
    assert timeline.markers[96]["color"] == "Green" and timeline.markers[96]["duration"] == 1
    assert timeline.markers[96]["name"] == "check focus"  # unnamed: named after its note
    again = host.add_markers({"timeline": "Interview", "markers": [{"time": 1.0}, {"time": 5}]})
    assert again == {
        "added": [{"id": "f120", "time": 5.0, "name": "Marker", "color": "Green"}],
        "alreadyThere": ["f24"],
        "refusedAt": [],
    }


def test_add_markers_reports_what_resolve_refused_and_keeps_the_rest(host, timeline):
    original_add = timeline.AddMarker
    timeline.AddMarker = lambda frame, *rest: False if frame == 48 else original_add(frame, *rest)
    result = host.add_markers(
        {
            "timeline": "Interview",
            "markers": [{"time": 1, "name": "a"}, {"time": 2, "name": "b"}],
        }
    )
    assert [m["id"] for m in result["added"]] == ["f24"] and result["refusedAt"] == [2.0]


def test_add_markers_checks_every_marker_before_adding_any(host, timeline):
    with pytest.raises(HostError, match="markers\\[1\\]"):
        host.add_markers(
            {
                "timeline": "Interview",
                "markers": [{"time": 1, "name": "ok"}, {"time": 999}],
            }
        )
    assert timeline.markers == {}


def test_add_markers_refuses_bad_input(host):
    with pytest.raises(HostError, match="outside the timeline"):
        host.add_markers({"timeline": "Interview", "markers": [{"time": 500}]})
    with pytest.raises(HostError, match="Unknown marker color"):
        host.add_markers({"timeline": "Interview", "markers": [{"time": 1, "color": "chartreuse"}]})
    with pytest.raises(HostError, match="non-empty list"):
        host.add_markers({"timeline": "Interview", "markers": []})
    with pytest.raises(HostError, match="must be a number"):
        host.add_markers({"timeline": "Interview", "markers": [{"time": "1"}]})


def test_list_markers_reports_them_in_seconds(host, timeline):
    timeline.markers[48] = {"color": "Blue", "name": "Q2", "note": "", "duration": 24}
    assert host.list_markers({"timeline": "Interview"})["markers"] == [
        {
            "id": "f48",
            "time": 2.0,
            "name": "Q2",
            "color": "Blue",
            "note": "",
            "duration": 1.0,
        }
    ]


def test_update_marker_moves_and_renames_keeping_the_rest(host, timeline):
    timeline.markers[48] = {
        "color": "Blue",
        "name": "Q2",
        "note": "keep",
        "duration": 24,
        "customData": "x",
    }
    result = host.update_marker({"timeline": "Interview", "markerId": "f48", "time": 3, "name": "Question 2"})
    assert result["id"] == "f72"
    assert 48 not in timeline.markers
    assert timeline.markers[72] == {
        "color": "Blue",
        "name": "Question 2",
        "note": "keep",
        "duration": 24,
        "customData": "x",
    }


def test_update_marker_puts_the_original_back_when_resolve_refuses(host, timeline):
    timeline.markers[48] = {"color": "Blue", "name": "Q2", "note": "", "duration": 1}
    original_add = timeline.AddMarker
    calls = []

    def refuse_first(*args):
        calls.append(args)
        return False if len(calls) == 1 else original_add(*args)

    timeline.AddMarker = refuse_first
    with pytest.raises(HostError, match="original is unchanged"):
        host.update_marker({"timeline": "Interview", "markerId": "f48", "name": "New"})
    assert timeline.markers[48]["name"] == "Q2"


def test_update_marker_refuses_unknown_ids_and_collisions(host, timeline):
    timeline.markers[48] = {"color": "Blue", "name": "a", "note": "", "duration": 1}
    timeline.markers[72] = {"color": "Blue", "name": "b", "note": "", "duration": 1}
    with pytest.raises(HostError, match="no marker"):
        host.update_marker({"timeline": "Interview", "markerId": "f50"})
    with pytest.raises(HostError, match="Unknown marker id"):
        host.update_marker({"timeline": "Interview", "markerId": "48"})
    with pytest.raises(HostError, match="already a marker"):
        host.update_marker({"timeline": "Interview", "markerId": "f48", "time": 3})


def test_resolve_remove_markers_by_id_or_all(host, timeline):
    timeline.markers.update({24: {}, 48: {}, 72: {}})
    assert host.remove_markers({"timeline": "Interview", "markerIds": ["f24", "f30"]}) == {
        "removed": ["f24"],
        "notFound": ["f30"],
    }
    assert host.remove_markers({"timeline": "Interview", "all": True})["removed"] == [
        "f48",
        "f72",
    ]
    with pytest.raises(HostError, match="markerIds"):
        host.remove_markers({"timeline": "Interview"})


def test_playhead_reads_and_moves_in_seconds(host, timeline):
    timeline.timecode = "01:00:02:12"
    assert host.get_playhead({"timeline": "Interview"}) == {"time": 2.5}
    assert host.set_playhead({"timeline": "Interview", "time": 10}) == {"time": 10.0}
    assert timeline.timecode == "01:00:10:00"


def test_set_playhead_opens_the_connected_timeline_and_clamps(host):
    other = host._resolve.project.timelines[1]
    result = host.set_playhead({"timeline": "Other", "time": 9999})
    assert host._resolve.project.current is other
    assert result["time"] == round(2400 / 29.97, 3)


def test_get_playhead_needs_the_timeline_to_be_open(host):
    with pytest.raises(HostError, match="isn't the timeline open"):
        host.get_playhead({"timeline": "Other"})


# ----------------------------------------------------------------------------- Premiere


def test_markers_are_checked_and_rounded_before_premiere_sees_them():
    added = {
        "added": [
            {
                "id": "g1",
                "name": "Hook",
                "comments": "",
                "startTicks": str(to_ticks(1.02, TB_25)),
                "endTicks": str(to_ticks(1.02, TB_25)),
                "colorIndex": 4,
            }
        ],
        "alreadyThere": ["g0"],
        "refusedAt": [],
    }
    host, requests = host_with(sequence_info=info(TB_25), add_markers=added)
    result = host.add_markers(
        {
            "timeline": "Main",
            "markers": [
                {"time": 1.02, "name": "Hook", "color": "yellow", "duration": 2},
                {"time": 0, "name": "Start"},
            ],
        }
    )
    sent = requests.sent("add_markers")[0]["markers"]
    assert sent[0]["ticks"] == str(26 * TB_25)  # 1.02 s is frame 25.5, rounded up
    assert sent[0]["endSeconds"] == 76 * TB_25 / TICKS_PER_SECOND == 3.04
    assert sent[0]["colorIndex"] == 4 and sent[1]["colorIndex"] == 0 and sent[1]["endSeconds"] is None
    assert result == {
        "added": [{"id": "g1", "time": 1.04, "name": "Hook", "color": "Yellow"}],
        "alreadyThere": ["g0"],
        "refusedAt": [],
    }


@pytest.mark.parametrize(
    ("markers", "message"),
    [
        ([], "non-empty"),
        ([{"time": 11, "name": "x"}], "outside the sequence"),
        ([{"time": 1, "name": "x", "color": "Teal"}], "Unknown marker color"),
        ([{"time": 1, "name": 3}], "name must be text"),
    ],
)
def test_a_bad_marker_sends_nothing(markers, message):
    host, requests = host_with(sequence_info=info(), add_markers={})
    with pytest.raises(HostError, match=message):
        host.add_markers({"timeline": "Main", "markers": markers})
    assert requests.sent("add_markers") == []


def test_update_marker_sends_only_what_changes():
    moved = {
        "id": "g1",
        "name": "Hook",
        "comments": "n",
        "startTicks": str(2 * TICKS_PER_SECOND),
        "endTicks": str(2 * TICKS_PER_SECOND),
        "colorIndex": 6,
    }
    host, requests = host_with(sequence_info=info(TB_25), update_marker=moved)
    result = host.update_marker({"timeline": "Main", "markerId": "g1", "color": "Blue", "time": 2})
    assert requests.sent("update_marker") == [
        {
            "timeline": "Main",
            "id": "g1",
            "colorIndex": 6,
            "ticks": str(2 * TICKS_PER_SECOND),
            "seconds": 2.0,
        }
    ]
    assert result == {
        "id": "g1",
        "time": 2.0,
        "name": "Hook",
        "color": "Blue",
        "note": "n",
    }
    with pytest.raises(HostError, match="Unknown marker id"):
        host.update_marker({"timeline": "Main", "markerId": "a b"})


def test_premiere_remove_markers_by_id_or_all():
    host, requests = host_with(remove_markers={"removed": ["g1"], "notFound": ["g2"]})
    assert host.remove_markers({"timeline": "Main", "markerIds": ["g1", "g2"]}) == {
        "removed": ["g1"],
        "notFound": ["g2"],
    }
    host.remove_markers({"timeline": "Main", "all": True})
    assert requests.sent("remove_markers") == [
        {"timeline": "Main", "ids": ["g1", "g2"]},
        {"timeline": "Main", "all": True},
    ]
    with pytest.raises(HostError, match="Pass markerIds"):
        host.remove_markers({"timeline": "Main"})


def test_the_playhead_is_clamped_to_the_sequence():
    host, _requests = host_with(
        sequence_info=info(TB_25, 10),
        set_playhead=lambda a: {"ticks": a["ticks"]},
        get_playhead={"ticks": str(3 * TICKS_PER_SECOND)},
    )
    assert host.set_playhead({"timeline": "Main", "time": 99}) == {"time": 10.0}
    assert host.set_playhead({"timeline": "Main", "time": -1}) == {"time": 0.0}
    assert host.get_playhead({"timeline": "Main"}) == {"time": 3.0}
