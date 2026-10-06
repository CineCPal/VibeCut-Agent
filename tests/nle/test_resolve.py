import pytest

from tests.nle.fakes import START, FakeItem, FakeProject, FakeResolve, FakeTimeline
from vibecut_agent.nle.errors import HostError
from vibecut_agent.nle.resolve import ResolveHost, frame_rate


@pytest.fixture
def interview() -> FakeTimeline:
    t = FakeTimeline("Interview")
    picture = FakeItem("v1", "A.mov", START + 48, START + 240, left=120)
    sound = FakeItem("a1", "A.mov", START + 48, START + 240, left=120, volume=-6.0206)
    picture.linked, sound.linked = [sound], [picture]
    picture.fades = {"FadeIn": 12.0}
    dissolve = FakeItem("x1", "Cross Dissolve", START + 228, START + 252, left=None, path=None)
    t.tracks["video"] = [[picture, dissolve]]
    t.tracks["audio"] = [[sound]]
    t.markers = {48: {"name": "Start", "color": "Blue", "note": "", "duration": 1}}
    return t


@pytest.fixture
def host(interview: FakeTimeline) -> ResolveHost:
    return ResolveHost(FakeResolve(FakeProject("Doc", [interview, FakeTimeline("Other", fps="29.97 DF")])))


def test_status(host):
    assert host.status({}) == {
        "product": "DaVinci Resolve Studio",
        "version": "21.1.0.17",
        "project": "Doc",
        "timelines": ["Interview", "Other"],
        "currentTimeline": "Interview",
    }


def test_status_without_a_project():
    assert ResolveHost(FakeResolve(None)).status({})["project"] is None


def test_read_timeline(host):
    t = host.read_timeline({"timeline": "Interview"})
    assert (t["fps"], t["duration"], t["isCurrent"]) == (24.0, 100.0, True)
    video, audio = t["tracks"]
    picture, dissolve = video["clips"]
    assert picture == {
        "id": "v1",
        "name": "A.mov",
        "start": 2.0,
        "end": 10.0,
        "enabled": True,
        "sourceIn": 5.0,
        "sourceOut": 13.0,
        "fadeIn": 0.5,
        "filePath": "/m/a.mov",
        "linkedIds": ["a1"],
    }
    assert dissolve["kind"] == "effect"
    assert audio["clips"][0]["volumeDb"] == -6.02
    assert t["markers"] == [
        {"id": "f48", "time": 2.0, "name": "Start", "color": "Blue", "note": "", "duration": 0.042}
    ]


def test_track_switches_are_only_read_from_the_open_timeline(host):
    t = host.read_timeline({"timeline": "Other"})
    assert t["isCurrent"] is False
    assert t["tracks"][0]["enabled"] is None and t["tracks"][0]["locked"] is None


def test_unknown_timeline_and_rate(host):
    with pytest.raises(HostError, match="no timeline called 'Gone'"):
        host.read_timeline({"timeline": "Gone"})
    assert frame_rate(FakeTimeline("x", fps="29.97 DF")) == 29.97
    with pytest.raises(HostError, match="frame rate"):
        frame_rate(FakeTimeline("x", fps=""))
