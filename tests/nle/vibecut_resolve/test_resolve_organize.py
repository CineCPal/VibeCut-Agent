"""Ported from VibeCut's tests/test_resolve_organize.py (Phase 12e): the agent organising the Media Pool: bins, moves, clip colour and
flags, logged fields and keywords, renames, and reverting them. The fake behaves as Resolve 21.1 did
when checked live (see resolve_organize.py)."""

import pytest

from tests.nle.compat import run_command
from tests.nle.vibecut_resolve.resolve_fakes import FakeProject, FakeResolve, FakeTimeline
from tests.nle.vibecut_resolve.test_resolve_pool import Bin, Pool, PoolItem
from vibecut_agent.nle.resolve import HostError, ResolveHost
from vibecut_agent.nle.resolve_organize import CLIP_COLORS

FLAGS = ("Blue", "Cyan", "Green", "Yellow", "Red", "Pink", "Purple", "Fuchsia")


class Clip(PoolItem):
    def __init__(self, uid, name, **kwargs):
        super().__init__(uid, name, **kwargs)
        self.color, self.flags = "", []
        self.refuse = set()

    def GetClipColor(self):
        return self.color

    def SetClipColor(self, color):
        match = next((c for c in CLIP_COLORS if c.lower() == color.lower()), None)
        if not match or "color" in self.refuse:
            return False
        self.color = match
        return True

    def ClearClipColor(self):
        self.color = ""
        return True

    def GetFlagList(self):
        return list(self.flags)

    def AddFlag(self, color):
        match = next((c for c in FLAGS if c.lower() == color.lower()), None)
        if not match:
            return False
        if match not in self.flags:
            self.flags.append(match)
        return True

    def ClearFlags(self, color):
        self.flags = [] if color == "All" else [f for f in self.flags if f != color]
        return True

    def SetMetadata(self, values):
        if "metadata" in self.refuse or "Good Take" in values:
            return False
        for key, value in values.items():
            if value:
                self.metadata[key] = value
            else:
                self.metadata.pop(key, None)
        return True

    def SetName(self, name):
        if not name:
            return False
        self.name = name
        self.props["Clip Name"] = name
        return True


class Folder(Bin):
    def AddSubFolder(self, name):
        sub = Folder(name)
        self.subs.append(sub)
        return sub


class OrganizingPool(Pool):
    def __init__(self, root, selected=()):
        super().__init__(root, selected)
        self.moves = 0

    def _parent(self, target, folder=None):
        folder = folder or self.root
        for sub in folder.subs:
            if sub is target:
                return folder
            found = self._parent(target, sub)
            if found:
                return found
        return None

    def _holder(self, clip, folder=None):
        folder = folder or self.root
        if clip in folder.clips:
            return folder
        for sub in folder.subs:
            found = self._holder(clip, sub)
            if found:
                return found
        return None

    def AddSubFolder(self, parent, name):
        return parent.AddSubFolder(name)

    def MoveClips(self, clips, folder):
        self.moves += 1
        for clip in clips:
            self._holder(clip).clips.remove(clip)
            folder.clips.append(clip)
        return True

    def DeleteFolders(self, folders):
        for folder in folders:
            self._parent(folder).subs.remove(folder)
        return True


@pytest.fixture
def pool():
    a = Clip("c-a", "A.mov", props={"File Path": "/m/A.mov"})
    b = Clip(
        "c-b",
        "B.mov",
        props={"File Path": "/m/B.mov"},
        metadata={"Keywords": "bread, oven"},
    )
    c = Clip("c-c", "C.mov", props={"File Path": "/m/C.mov"})
    timeline = Clip("c-t", "Assembly", props={"Type": "Timeline"})
    root = Folder("Master", [a, timeline], [Folder("Footage", [b, c])])
    project = FakeProject([FakeTimeline("Assembly")])
    project.pool = OrganizingPool(root)
    project.GetMediaPool = lambda: project.pool
    return ResolveHost(FakeResolve(project)), project.pool, {"a": a, "b": b, "c": c}


def bins(folder, path="Master"):
    out = [path]
    for sub in folder.subs:
        out += bins(sub, f"{path}/{sub.name}")
    return out


def test_create_bins_makes_missing_parents_and_reports_existing_ones(pool):
    host, media_pool, _ = pool
    result = run_command(host, "create_bins", {"paths": ["B-roll/Bakery", "Master/footage", "/B-roll/"]})
    assert result["createdBins"] == ["Master/B-roll", "Master/B-roll/Bakery"]
    # "footage" matches "Footage" whatever its case; a second "B-roll" isn't made.
    assert result["existing"] == ["Master/Footage", "Master/B-roll"]
    assert bins(media_pool.root) == [
        "Master",
        "Master/Footage",
        "Master/B-roll",
        "Master/B-roll/Bakery",
    ]
    with pytest.raises(HostError, match="Master bin itself"):
        run_command(host, "create_bins", {"paths": ["Master"]})


def test_move_clips_records_the_old_bin_and_can_create_the_new_one(pool):
    host, media_pool, clips = pool
    with pytest.raises(HostError, match="pass create"):
        run_command(host, "move_clips", {"clipIds": ["c-a"], "bin": "B-roll"})
    result = run_command(
        host,
        "move_clips",
        {"clipIds": ["c-a", "c-b", "c-a"], "bin": "B-roll", "create": True},
    )
    assert result["changes"] == [
        {"clipId": "c-a", "field": "bin", "before": "Master", "after": "Master/B-roll"},
        {
            "clipId": "c-b",
            "field": "bin",
            "before": "Master/Footage",
            "after": "Master/B-roll",
        },
    ]
    assert result["createdBins"] == ["Master/B-roll"] and result["alreadyThere"] == []
    assert media_pool.root.subs[1].clips == [clips["a"], clips["b"]]
    again = run_command(host, "move_clips", {"clipIds": ["c-a"], "bin": "b-roll"})
    assert again["changes"] == [] and again["alreadyThere"] == ["c-a"]


def test_any_bad_clip_fails_the_whole_call_before_anything_changes(pool):
    host, media_pool, clips = pool
    for bad, message in (
        (["c-a", "nope"], "no Media Pool clip"),
        (["c-a", "c-t"], "is a timeline"),
    ):
        with pytest.raises(HostError, match=message):
            run_command(host, "set_clip_labels", {"clipIds": bad, "color": "Orange"})
        with pytest.raises(HostError, match=message):
            run_command(host, "move_clips", {"clipIds": bad, "bin": "Footage"})
    assert clips["a"].color == "" and media_pool.moves == 0
    with pytest.raises(HostError, match="Unknown clip colour"):
        run_command(host, "set_clip_labels", {"clipIds": ["c-a"], "color": "Mauve"})
    with pytest.raises(HostError, match="Unknown flag colour"):
        run_command(host, "set_clip_labels", {"clipIds": ["c-a"], "addFlags": ["Orange"]})
    with pytest.raises(HostError, match="Nothing to change"):
        run_command(host, "set_clip_labels", {"clipIds": ["c-a"]})
    with pytest.raises(HostError, match="clipIds"):
        run_command(host, "set_clip_labels", {"clipIds": [], "color": "Orange"})


def test_set_clip_labels_records_colour_and_flags(pool):
    host, _, clips = pool
    clips["b"].color, clips["b"].flags = "Orange", ["Red"]
    result = run_command(
        host,
        "set_clip_labels",
        {
            "clipIds": ["c-a", "c-b"],
            "color": "teal",
            "addFlags": ["green"],
            "clearFlags": ["Red"],
        },
    )
    assert result["changes"] == [
        {"clipId": "c-a", "field": "color", "before": "", "after": "Teal"},
        {"clipId": "c-a", "field": "flags", "before": [], "after": ["Green"]},
        {"clipId": "c-b", "field": "color", "before": "Orange", "after": "Teal"},
        {"clipId": "c-b", "field": "flags", "before": ["Red"], "after": ["Green"]},
    ]
    cleared = run_command(
        host,
        "set_clip_labels",
        {"clipIds": ["c-a"], "color": None, "clearFlags": ["all"]},
    )
    assert cleared["changes"] == [
        {"clipId": "c-a", "field": "color", "before": "Teal", "after": ""},
        {"clipId": "c-a", "field": "flags", "before": ["Green"], "after": []},
    ]
    # Leaving color out keeps it; no change means no record.
    assert run_command(host, "set_clip_labels", {"clipIds": ["c-b"], "addFlags": ["Green"]})["changes"] == []
    clips["c"].refuse.add("color")
    refused = run_command(host, "set_clip_labels", {"clipIds": ["c-c"], "color": "Navy"})
    assert refused["changes"] == [] and refused["refused"][0]["clipId"] == "c-c"


def test_set_clip_metadata_sets_fields_and_edits_keywords(pool):
    host, _, clips = pool
    result = run_command(
        host,
        "set_clip_metadata",
        {
            "clipIds": ["c-b"],
            "fields": {"comments": "warm light", "Scene": "3"},
            "keywords": {"add": ["Bread", "hero"], "remove": ["OVEN"]},
        },
    )
    assert result["changes"] == [
        {
            "clipId": "c-b",
            "field": "metadata:Comments",
            "before": "",
            "after": "warm light",
        },
        {"clipId": "c-b", "field": "metadata:Scene", "before": "", "after": "3"},
        {
            "clipId": "c-b",
            "field": "metadata:Keywords",
            "before": "bread, oven",
            "after": "bread,hero",
        },
    ]
    assert clips["b"].metadata == {
        "Keywords": "bread,hero",
        "Comments": "warm light",
        "Scene": "3",
    }
    replaced = run_command(
        host,
        "set_clip_metadata",
        {"clipIds": ["c-b"], "keywords": {"replace": "night, city"}},
    )
    assert replaced["changes"][0]["after"] == "night,city"
    cleared = run_command(host, "set_clip_metadata", {"clipIds": ["c-b"], "fields": {"Comments": ""}})
    assert cleared["changes"] == [
        {
            "clipId": "c-b",
            "field": "metadata:Comments",
            "before": "warm light",
            "after": "",
        }
    ]
    with pytest.raises(HostError, match="Good Take"):
        run_command(
            host,
            "set_clip_metadata",
            {"clipIds": ["c-b"], "fields": {"Good Take": "1"}},
        )
    with pytest.raises(HostError, match="comma"):
        run_command(
            host,
            "set_clip_metadata",
            {"clipIds": ["c-b"], "keywords": {"add": ["a,b"]}},
        )
    with pytest.raises(HostError, match="Nothing to change"):
        run_command(host, "set_clip_metadata", {"clipIds": ["c-b"]})


def test_rename_clips(pool):
    host, _, clips = pool
    result = run_command(
        host,
        "rename_clips",
        {
            "renames": [
                {"clipId": "c-a", "name": " Wide – street "},
                {"clipId": "c-c", "name": "C.mov"},
            ]
        },
    )
    assert result["changes"] == [
        {"clipId": "c-a", "field": "name", "before": "A.mov", "after": "Wide – street"}
    ]
    assert clips["a"].GetName() == "Wide – street" and clips["a"].props["File Path"] == "/m/A.mov"
    with pytest.raises(HostError, match="non-empty name"):
        run_command(host, "rename_clips", {"renames": [{"clipId": "c-a", "name": "  "}]})
    with pytest.raises(HostError, match="no Media Pool clip"):
        run_command(host, "rename_clips", {"renames": [{"clipId": "zz", "name": "X"}]})


def test_set_clip_metadata_per_clip_gives_each_its_own_value_and_reverts(pool):
    host, _, clips = pool
    clips["b"].metadata["Comments"] = "warm light"
    result = run_command(
        host,
        "set_clip_metadata",
        {
            "perClip": {
                "c-a": {"Comments": "B-roll score 80"},
                "c-b": {"comments": "warm light\nB-roll score 60"},
            }
        },
    )
    assert result["changes"] == [
        {"clipId": "c-a", "field": "metadata:Comments", "before": "", "after": "B-roll score 80"},
        {
            "clipId": "c-b",
            "field": "metadata:Comments",
            "before": "warm light",
            "after": "warm light\nB-roll score 60",
        },
    ]
    reverted = run_command(host, "revert_pool_changes", {"changes": result["changes"], "createdBins": []})
    assert len(reverted["reverted"]) == 2 and reverted["failed"] == []
    assert clips["a"].metadata.get("Comments", "") == ""
    assert clips["b"].metadata["Comments"] == "warm light"
    with pytest.raises(HostError, match="on its own"):
        run_command(
            host,
            "set_clip_metadata",
            {"perClip": {"c-a": {"Comments": "x"}}, "keywords": {"add": ["y"]}},
        )
    with pytest.raises(HostError, match="perClip must be"):
        run_command(host, "set_clip_metadata", {"perClip": []})


def test_revert_puts_everything_back_and_removes_the_bins_it_made(pool):
    host, media_pool, clips = pool
    log = []
    for command, args in (
        (
            "move_clips",
            {"clipIds": ["c-a", "c-b"], "bin": "B-roll/Bakery", "create": True},
        ),
        (
            "set_clip_labels",
            {"clipIds": ["c-a"], "color": "Orange", "addFlags": ["Green"]},
        ),
        ("set_clip_metadata", {"clipIds": ["c-b"], "keywords": {"add": ["hero"]}}),
        ("rename_clips", {"renames": [{"clipId": "c-a", "name": "Hero"}]}),
    ):
        log.append(run_command(host, command, args))
    result = run_command(
        host,
        "revert_pool_changes",
        {
            "changes": [c for entry in log for c in entry["changes"]],
            "createdBins": [b for entry in log for b in entry["createdBins"]],
        },
    )
    assert len(result["reverted"]) == 6 and result["changedSince"] == [] and result["failed"] == []
    assert result["binsRemoved"] == ["Master/B-roll/Bakery", "Master/B-roll"] and result["binsKept"] == []
    assert (clips["a"].name, clips["a"].color, clips["a"].flags) == ("A.mov", "", [])
    assert clips["b"].metadata == {"Keywords": "bread, oven"}
    assert bins(media_pool.root) == ["Master", "Master/Footage"]
    assert clips["a"] in media_pool.root.clips and clips["b"] in media_pool.root.subs[0].clips


def test_revert_leaves_what_changed_since_and_keeps_a_bin_that_isnt_empty(pool):
    host, media_pool, clips = pool
    moved = run_command(host, "move_clips", {"clipIds": ["c-a"], "bin": "Selects", "create": True})
    coloured = run_command(host, "set_clip_labels", {"clipIds": ["c-a", "c-c"], "color": "Orange"})
    clips["c"].color = "Navy"  # changed by hand in Resolve
    media_pool.root.subs[1].clips.append(Clip("c-new", "New.mov"))  # the user added to the new bin
    result = run_command(
        host,
        "revert_pool_changes",
        {
            "changes": moved["changes"] + coloured["changes"],
            "createdBins": moved["createdBins"],
        },
    )
    assert result["changedSince"] == [{"clipId": "c-c", "field": "color"}]
    assert {(r["clipId"], r["field"]) for r in result["reverted"]} == {
        ("c-a", "color"),
        ("c-a", "bin"),
    }
    assert clips["c"].color == "Navy" and clips["a"].color == ""
    assert result["binsKept"] == ["Master/Selects"] and result["binsRemoved"] == []


def test_revert_checks_its_arguments(pool):
    host, _, _ = pool
    with pytest.raises(HostError, match="changes must be"):
        run_command(host, "revert_pool_changes", {"changes": [{"field": "color"}]})
    with pytest.raises(HostError, match="Unknown field"):
        run_command(
            host,
            "revert_pool_changes",
            {"changes": [{"clipId": "c-a", "field": "evil"}]},
        )
    gone = run_command(
        host,
        "revert_pool_changes",
        {"changes": [{"clipId": "zz", "field": "color", "before": "", "after": "Orange"}]},
    )
    assert gone["failed"][0]["clipId"] == "zz"
