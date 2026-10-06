"""The Premiere project as the Connect page's pool (premiere_pool.py), against a fake project."""

from __future__ import annotations

import pytest

from tests.nle.compat import run_command
from tests.nle.vibecut_premiere.premiere_fakes import FakeProject
from vibecut_agent.nle.premiere import HostError, PremiereHost


@pytest.fixture
def project():
    p = FakeProject()
    p.sequence("Assembly")
    p.clip("A.mov", "Footage", id="a")
    p.clip(
        "ROLL.wav",
        "Footage",
        id="roll",
        columns={"VideoInfo": "", "MediaTimebase": "", "Label": "Caribbean"},
        label=2,
    )
    p.clip(
        "City.mov",
        "Footage/B-roll",
        id="city",
        label=7,
        inSeconds=1.0,
        outSeconds=4.0,
        columns={
            "Label": "Mango",
            "Description": "night pan",
            "LogNote": "nice",
            "Scene": "12A",
            "Good": "true",
        },
    )
    p.clip(
        "Lost.mov",
        "Footage/B-roll",
        id="lost",
        offline=True,
        columns={"Status": "Offline"},
    )
    p.usage = {"a": 2}
    p.selected = ["city"]
    return p


def call(project, command, args=None):
    return run_command(PremiereHost(project), command, args or {})


def test_the_project_reads_as_a_pool(project):
    pool = call(project, "read_media_pool", {"timeline": "Assembly"})
    assert project.sent("read_project") == [{"timeline": "Assembly"}]
    assert pool["bins"] == [
        {"path": "Interview", "clips": 1},
        {"path": "Interview/Footage", "clips": 2},
        {"path": "Interview/Footage/B-roll", "clips": 2},
    ]
    assert pool["timelines"] == ["Assembly"]
    assert pool["truncated"] is False
    assert pool["selection"] == {
        "pool": ["city"],
        "timeline": [],
        "underPlayhead": None,
    }
    a, roll, city, lost = pool["clips"]
    assert a == {
        "id": "a",
        "name": "A.mov",
        "bin": "Interview/Footage",
        "type": "Video + Audio",
        "duration": 30.0,
        "fps": 25.0,
        "resolution": "1920x1080",
        "filePath": "/media/A.mov",
        "clipColor": "Iris",
        "usage": 2,
    }
    assert (roll["type"], roll["clipColor"], "fps" in roll) == (
        "Audio",
        "Caribbean",
        False,
    )
    # Marked In/Out, the label and the logged fields; Good only shows when it's ticked.
    assert (city["markIn"], city["markOut"], city["clipColor"]) == (1.0, 4.0, "Mango")
    assert city["metadata"] == {
        "Description": "night pan",
        "Log Note": "nice",
        "Scene": "12A",
        "Good": "true",
    }
    assert "metadata" not in a and "markIn" not in a
    assert lost["offline"] is True


def test_clip_info_has_every_column_and_the_clips_markers(project):
    info = call(project, "get_clip_info", {"clipId": "city"})
    assert info["name"] == "City.mov"
    assert info["markers"] == [{"time": 2.0, "name": "Laugh", "color": "Red", "note": "", "duration": 0.0}]
    assert info["properties"]["Scene"] == "12A"
    with pytest.raises(HostError, match="must name a clip"):
        call(project, "get_clip_info", {"clipId": "../x"})


def test_a_sequence_isnt_clip_info(project):
    seq = next(i for i, item in project.items.items() if item["sequence"])
    with pytest.raises(HostError, match="is a sequence"):
        call(project, "get_clip_info", {"clipId": seq})


@pytest.mark.parametrize(
    ("args", "found"),
    [
        ({"text": "night"}, ["city"]),
        ({"text": "b-roll city"}, ["city"]),
        ({"clipColor": "mango"}, ["city"]),
        ({"type": "audio"}, ["roll"]),
        ({"type": "video+audio", "bin": "b-roll"}, ["city", "lost"]),
        ({"unused": True}, ["roll", "city", "lost"]),
        ({"marked": True}, ["city"]),
        ({}, ["a", "roll", "city", "lost"]),
    ],
)
def test_search(project, args, found):
    result = call(project, "search_media_pool", args)
    assert [c["id"] for c in result["clips"]] == found
    assert result["total"] == len(found)


def test_search_refuses_what_premiere_doesnt_have(project):
    with pytest.raises(HostError, match="no keywords"):
        call(project, "search_media_pool", {"keyword": "city"})
    with pytest.raises(HostError, match="no flags"):
        call(project, "search_media_pool", {"flag": "Red"})
