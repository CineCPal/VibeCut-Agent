"""Organising the Premiere project (premiere_organize.py, Phase 12e), VibeCut's tests against a fake project."""

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
    p.clip("B.mov", "Footage", id="b", columns={"Scene": "1"})
    return p


def call(project, command, args):
    return run_command(PremiereHost(project), command, args)


def test_create_bins_makes_missing_parents_and_reuses_what_exists(project):
    result = call(
        project,
        "create_bins",
        {"paths": ["B-roll/Day 1", "footage", "Interview/Music"]},
    )
    assert result["createdBins"] == [
        "Interview/B-roll",
        "Interview/B-roll/Day 1",
        "Interview/Music",
    ]
    assert result["existing"] == ["Interview/Footage"]
    assert [a["name"] for a in project.sent("create_bin")] == [
        "B-roll",
        "Day 1",
        "Music",
    ]
    with pytest.raises(HostError, match="the project itself"):
        call(project, "create_bins", {"paths": ["Interview"]})


def test_move_clips_records_each_bin_change(project):
    with pytest.raises(HostError, match="pass create"):
        call(project, "move_clips", {"clipIds": ["a"], "bin": "Selects"})
    result = call(
        project,
        "move_clips",
        {"clipIds": ["a", "b", "a"], "bin": "Selects", "create": True},
    )
    assert result["createdBins"] == ["Interview/Selects"]
    assert result["changes"] == [
        {
            "clipId": "a",
            "field": "bin",
            "before": "Interview/Footage",
            "after": "Interview/Selects",
        },
        {
            "clipId": "b",
            "field": "bin",
            "before": "Interview/Footage",
            "after": "Interview/Selects",
        },
    ]
    assert project.path_of("a") == "Interview/Selects"
    again = call(project, "move_clips", {"clipIds": ["a"], "bin": "selects"})
    assert again["changes"] == [] and again["alreadyThere"] == ["a"]


def test_one_bad_id_or_a_sequence_changes_nothing(project):
    seq = next(i for i, item in project.items.items() if item["sequence"])
    for ids, match in (
        (["a", "nope"], "no clip 'nope'"),
        (["a", seq], "is a sequence"),
    ):
        with pytest.raises(HostError, match=match):
            call(project, "move_clips", {"clipIds": ids, "bin": "Footage"})
    assert not project.sent("move_project_items")


def test_labels_change_by_name_and_cant_be_cleared(project):
    result = call(project, "set_clip_labels", {"clipIds": ["a", "b"], "color": "mango"})
    assert result["changes"] == [
        {"clipId": "a", "field": "color", "before": "Iris", "after": "Mango"},
        {"clipId": "b", "field": "color", "before": "Iris", "after": "Mango"},
    ]
    assert project.sent("set_project_items")[0]["items"][0] == {"id": "a", "label": 7}
    for args, match in (
        ({"color": None}, "not cleared"),
        ({"color": "None"}, "not cleared"),
        ({"color": "Orange"}, "Unknown label colour"),
        ({"addFlags": ["Red"]}, "no flags"),
        ({}, "Nothing to change"),
    ):
        with pytest.raises(HostError, match=match):
            call(project, "set_clip_labels", {"clipIds": ["a"], **args})


def test_premiere_refusing_a_change_is_reported(project):
    project.refuse.add("b")
    result = call(project, "set_clip_labels", {"clipIds": ["a", "b"], "color": "Forest"})
    assert [c["clipId"] for c in result["changes"]] == ["a"]
    assert result["refused"] == [{"clipId": "b", "reason": "Premiere didn't set the label Forest"}]


def test_metadata_sets_project_fields_only(project):
    result = call(
        project,
        "set_clip_metadata",
        {
            "clipIds": ["a", "b"],
            "fields": {"log note": "keeper", "Scene": "1", "good": True},
        },
    )
    assert result["changes"] == [
        {"clipId": "a", "field": "metadata:Log Note", "before": "", "after": "keeper"},
        {"clipId": "a", "field": "metadata:Scene", "before": "", "after": "1"},
        {"clipId": "a", "field": "metadata:Good", "before": "false", "after": "true"},
        {"clipId": "b", "field": "metadata:Log Note", "before": "", "after": "keeper"},
        {"clipId": "b", "field": "metadata:Good", "before": "false", "after": "true"},
    ]
    sent = project.sent("set_project_items")[0]["items"][1]
    assert sent == {
        "id": "b",
        "fields": [
            {"key": "LogNote", "value": "keeper"},
            {"key": "Good", "value": "true"},
        ],
    }
    with pytest.raises(HostError, match="settable: Description, Log Note, Scene, Shot, Good"):
        call(project, "set_clip_metadata", {"clipIds": ["a"], "fields": {"Comment": "x"}})
    with pytest.raises(HostError, match="doesn't write to"):
        call(
            project,
            "set_clip_metadata",
            {"clipIds": ["a"], "keywords": {"add": ["city"]}},
        )


def test_metadata_per_clip_sets_each_clip_its_own_values(project):
    result = call(
        project,
        "set_clip_metadata",
        {"perClip": {"a": {"Log Note": "B-roll score 80"}, "b": {"logNote": "B-roll score 60"}}},
    )
    assert result["changes"] == [
        {"clipId": "a", "field": "metadata:Log Note", "before": "", "after": "B-roll score 80"},
        {"clipId": "b", "field": "metadata:Log Note", "before": "", "after": "B-roll score 60"},
    ]
    items = project.sent("set_project_items")[0]["items"]
    assert [i["fields"] for i in items] == [
        [{"key": "LogNote", "value": "B-roll score 80"}],
        [{"key": "LogNote", "value": "B-roll score 60"}],
    ]
    with pytest.raises(HostError, match="on its own"):
        call(project, "set_clip_metadata", {"perClip": {"a": {"Scene": "1"}}, "clipIds": ["a"]})
    with pytest.raises(HostError, match="perClip must be"):
        call(project, "set_clip_metadata", {"perClip": {}})
    with pytest.raises(HostError, match="Nothing to change"):
        call(project, "set_clip_metadata", {"perClip": {"a": {}}})


def test_rename(project):
    result = call(
        project,
        "rename_clips",
        {
            "renames": [
                {"clipId": "a", "name": " Interview A "},
                {"clipId": "b", "name": "B.mov"},
            ]
        },
    )
    assert result["changes"] == [{"clipId": "a", "field": "name", "before": "A.mov", "after": "Interview A"}]
    with pytest.raises(HostError, match="one line"):
        call(
            project,
            "rename_clips",
            {"renames": [{"clipId": "a", "name": "two\nlines"}]},
        )


def test_revert_puts_everything_back_and_removes_the_bin_it_made(project):
    moved = call(
        project,
        "move_clips",
        {"clipIds": ["a"], "bin": "Selects/Day 1", "create": True},
    )
    labelled = call(project, "set_clip_labels", {"clipIds": ["a"], "color": "Rose"})
    logged = call(
        project,
        "set_clip_metadata",
        {"clipIds": ["b"], "fields": {"Scene": "", "Description": "wide"}},
    )
    renamed = call(project, "rename_clips", {"renames": [{"clipId": "b", "name": "Wide"}]})
    changes = moved["changes"] + labelled["changes"] + logged["changes"] + renamed["changes"]
    result = call(
        project,
        "revert_pool_changes",
        {"changes": changes, "createdBins": moved["createdBins"]},
    )
    assert [r["field"] for r in result["reverted"]] == [
        "name",
        "metadata:Description",
        "metadata:Scene",
        "color",
        "bin",
    ]
    assert result["changedSince"] == [] and result["failed"] == []
    assert result["binsRemoved"] == ["Interview/Selects/Day 1", "Interview/Selects"]
    a, b = project.items["a"], project.items["b"]
    assert project.path_of("a") == "Interview/Footage" and a["label"] == 1
    assert b["name"] == "B.mov" and b["columns"].get("Scene") == "1" and "Description" not in b["columns"]


def test_revert_leaves_what_changed_since_and_keeps_a_bin_in_use(project):
    moved = call(project, "move_clips", {"clipIds": ["a", "b"], "bin": "Selects", "create": True})
    labelled = call(project, "set_clip_labels", {"clipIds": ["a"], "color": "Rose"})
    project.items["a"]["label"] = 13  # changed by hand in Premiere since
    project.refuse.add("b")  # and b can't be moved back
    result = call(
        project,
        "revert_pool_changes",
        {
            "changes": moved["changes"] + labelled["changes"],
            "createdBins": moved["createdBins"],
        },
    )
    assert result["changedSince"] == [{"clipId": "a", "field": "color"}]
    assert result["failed"] == [{"clipId": "b", "field": "bin", "reason": "Premiere didn't put it back"}]
    assert result["binsKept"] == ["Interview/Selects"]


def test_revert_checks_its_arguments(project):
    for args in (
        {"changes": [{"clipId": "a"}]},
        {"changes": [{"clipId": "a", "field": "flags"}]},
        {"createdBins": [1]},
    ):
        with pytest.raises(HostError):
            call(project, "revert_pool_changes", args)
