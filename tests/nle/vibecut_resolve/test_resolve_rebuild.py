"""tests/test_resolve_rebuild.py -- `rebuild`: a new Resolve timeline from VibeCut's edited copy of the
connected one. The fake Media Pool imports the real OTIO the builder writes, laying its clips out by
the tracks' gaps, so grade pairing is checked against what Resolve would actually get."""

import json

import pytest

from tests.nle.compat import run_command
from tests.nle.vibecut_resolve.resolve_fakes import START, FakeItem, FakeProject, FakeResolve, FakeTimeline
from vibecut_agent.nle.errors import HostError
from vibecut_agent.nle.resolve import ResolveHost
from vibecut_agent.nle.resolve_rebuild import default_name, rebuild, unique_name, validate_tracks


class GradedItem(FakeItem):
    def __init__(self, *args, grade=None, **kwargs):
        super().__init__(*args, **kwargs)
        self.grade = grade

    def CopyGrades(self, targets):
        for target in targets:
            target.grade = self.grade
        return True


class PoolClip:
    def __init__(self, path, start_tc="00:00:00:00", fps="25", frames="750"):
        self.props = {
            "File Path": path,
            "Start TC": start_tc,
            "FPS": fps,
            "Frames": frames,
        }

    def GetClipProperty(self, key):
        return self.props.get(key)


class Folder:
    def __init__(self, clips, subfolders=(), name="Master"):
        self.clips, self.subfolders, self.name = clips, list(subfolders), name

    def GetName(self):
        return self.name

    def GetClipList(self):
        return self.clips

    def GetSubFolderList(self):
        return self.subfolders


class FakePool:
    def __init__(self, project, clips):
        self.project, self.root = project, Folder([], [Folder(clips, name="Footage")])
        self.current = self.root
        self.imported = None
        self.import_options = None
        self.fail = False
        self.refuse_media = set()
        self.deleted = []

    def GetRootFolder(self):
        return self.root

    def AddSubFolder(self, parent, name):
        folder = Folder([], name=name)
        parent.subfolders.append(folder)
        return folder

    def GetCurrentFolder(self):
        return self.current

    def SetCurrentFolder(self, folder):
        self.current = folder
        return True

    def ImportMedia(self, paths):
        added = [PoolClip(p) for p in paths if p not in self.refuse_media]
        self.current.clips.extend(added)
        return added

    def DeleteTimelines(self, timelines):
        self.deleted.extend(timelines)
        for t in timelines:
            self.project.timelines.remove(t)
        return True

    @staticmethod
    def _link(folders, file_name):
        """Like Resolve: the first clip in the given folders with that file name, ignoring case."""
        for folder in folders:
            for pool_clip in folder.GetClipList():
                path = pool_clip.GetClipProperty("File Path") or ""
                if path.rsplit("/", 1)[-1].lower() == file_name.lower():
                    return path
        return None

    def ImportTimelineFromFile(self, path, options):
        if self.fail:
            return None
        self.import_options = options
        with open(path, encoding="utf-8") as f:
            self.imported = json.load(f)
        timeline = FakeTimeline(options["timelineName"], fps="25")
        timeline.tracks = {"video": [], "audio": [], "subtitle": []}
        for track in self.imported["tracks"]["children"]:
            items, frame = [], 0
            for child in track["children"]:
                length = round(child["source_range"]["duration"]["value"]) if child.get("source_range") else 0
                if child["OTIO_SCHEMA"] == "Clip.1":
                    url = child["media_reference"]["target_url"]
                    items.append(
                        GradedItem(
                            f"new-{track['name']}-{frame}",
                            child["name"],
                            START + frame,
                            START + frame + length,
                            path=self._link(options["sourceClipsFolders"], url.rsplit("/", 1)[-1]),
                        )
                    )
                frame += length
            timeline.tracks["video" if track["kind"] == "Video" else "audio"].append(items)
        self.project.timelines.append(timeline)
        return timeline


class PoolProject(FakeProject):
    def GetMediaPool(self):
        return self.pool


@pytest.fixture
def media(tmp_path):
    paths = {}
    for name in ("a.mov", "b.mov", "new.mov"):
        path = tmp_path / name
        path.write_bytes(b"x")
        paths[name] = str(path)
    return paths


@pytest.fixture
def setup(media):
    original = FakeTimeline("Interview", fps="25", length=750)
    graded = GradedItem("v1", "a.mov", START, START + 250, left=0, path=media["a.mov"], grade="warm")
    original.tracks["video"] = [[graded]]
    project = PoolProject([original])
    # a.mov's own timecode starts at 01:00:00:00 in the pool; b.mov isn't in the pool yet.
    project.pool = FakePool(project, [PoolClip(media["a.mov"], start_tc="01:00:00:00")])
    host = ResolveHost(FakeResolve(project))
    return host, project, original


def clip(path, start, a, b, **extra):
    return {
        "sourcePath": path,
        "sourceName": path.rsplit("/", 1)[-1],
        "startTimeSeconds": start,
        "sourceInSeconds": a,
        "sourceOutSeconds": b,
        **extra,
    }


def probe_none(_path):
    return None


def test_rebuild_imports_a_new_timeline_copies_grades_and_markers(setup, media):
    host, project, original = setup
    result = rebuild(host, {
        "timeline": "Interview",
        "tracks": [
            {"type": "audio", "clips": [clip(media["a.mov"], 0, 6, 10, volume=0.5, linkGroup="g@0")]},
            {"type": "video", "clips": [clip(media["a.mov"], 0, 6, 10, linkGroup="g@0"), clip(media["a.mov"], 6, 0, 2)]},
        ],
        "grades": [{"originId": "v1", "trackIndex": 1, "start": 0}, {"originId": "v1", "trackIndex": 1, "start": 6}],
        "markers": [{"time": 1, "name": "", "note": "kept from the original"}, {"time": 6, "name": "Join", "color": "Blue"}],
    }, probe=probe_none)  # fmt: skip

    assert result["timeline"] == "Interview (VibeCut 1)"
    assert (
        result["clips"],
        result["gradesCopied"],
        result["gradesNotCopied"],
        result["markersAdded"],
    ) == (3, 2, 0, 2)
    new = project.timelines[-1]
    assert project.current is new and new.GetName() == "Interview (VibeCut 1)"
    assert [item.grade for item in new.tracks["video"][0]] == ["warm", "warm"]
    assert new.markers[25]["name"] == "kept from the original" and new.markers[150]["color"] == "Blue"
    assert original.tracks["video"][0][0].grade == "warm"  # the original is untouched
    # The OTIO addressed a.mov in its own timecode (01:00:00:00 = 90000 frames at 25 fps).
    v1 = next(t for t in project.pool.imported["tracks"]["children"] if t["kind"] == "Video")
    assert v1["children"][0]["source_range"]["start_time"]["value"] == 90000 + 150


def test_new_files_go_into_a_vibecut_bin_and_the_timeline_links_to_pool_clips(setup, media):
    host, project, _ = setup
    pool = project.pool
    rebuild(
        host,
        {
            "timeline": "Interview",
            "tracks": [
                {
                    "type": "video",
                    "clips": [
                        clip(media["a.mov"], 0, 0, 2),
                        clip(media["b.mov"], 2, 0, 2),
                    ],
                }
            ],
        },
        probe=probe_none,
    )
    vibecut = next(f for f in pool.root.subfolders if f.GetName() == "VibeCut")
    assert [c.GetClipProperty("File Path") for c in vibecut.clips] == [
        media["b.mov"]
    ]  # a.mov was already there
    assert pool.current is pool.root  # the user's current bin is put back
    assert pool.import_options["importSourceClips"] is False
    # Only the bins holding the files it needs: Resolve links by file name, not path.
    assert [f.GetName() for f in pool.import_options["sourceClipsFolders"]] == [
        "Footage",
        "VibeCut",
    ]
    # A second rebuild reuses the bin and the clip.
    rebuild(
        host,
        {
            "timeline": "Interview",
            "tracks": [{"type": "video", "clips": [clip(media["b.mov"], 0, 0, 2)]}],
        },
        probe=probe_none,
    )
    assert [f.GetName() for f in pool.root.subfolders].count("VibeCut") == 1 and len(vibecut.clips) == 1


def test_a_same_named_clip_elsewhere_is_not_searched(setup, media, tmp_path):
    host, project, _ = setup
    stale = tmp_path / "old"
    stale.mkdir()
    (stale / "A.MOV").write_bytes(b"x")
    # A stale clip with the same name (other case) sits in Master, ahead of Footage.
    project.pool.root.clips.append(PoolClip(str(stale / "A.MOV")))
    rebuild(
        host,
        {"timeline": "Interview", "tracks": [{"type": "video", "clips": [clip(media["a.mov"], 0, 0, 2)]}]},
        probe=probe_none,
    )
    new = project.timelines[-1]
    assert new.tracks["video"][0][0].GetMediaPoolItem().GetClipProperty("File Path") == media["a.mov"]


def test_a_timeline_linked_to_another_file_is_deleted_and_refused(setup, media, tmp_path):
    host, project, _ = setup
    stale = tmp_path / "old"
    stale.mkdir()
    (stale / "A.MOV").write_bytes(b"x")
    # The same name in the SAME bin, ahead of the right clip: only the check can catch it.
    footage = project.pool.root.subfolders[0]
    footage.clips.insert(0, PoolClip(str(stale / "A.MOV")))
    before = list(project.timelines)
    with pytest.raises(HostError, match="same file name"):
        rebuild(
            host,
            {
                "timeline": "Interview",
                "tracks": [{"type": "video", "clips": [clip(media["a.mov"], 0, 0, 2)]}],
            },
            probe=probe_none,
        )
    assert project.timelines == before
    assert len(project.pool.deleted) == 1


def test_a_file_resolve_wont_import_stops_the_rebuild(setup, media):
    host, project, _ = setup
    project.pool.refuse_media.add(media["b.mov"])
    with pytest.raises(HostError, match="couldn't import 1 file.*b.mov"):
        rebuild(
            host,
            {
                "timeline": "Interview",
                "tracks": [{"type": "video", "clips": [clip(media["b.mov"], 0, 0, 2)]}],
            },
            probe=probe_none,
        )
    assert project.pool.imported is None


def test_a_grade_with_no_matching_clip_is_counted_not_fatal(setup, media):
    host, project, _ = setup
    result = rebuild(host, {
        "timeline": "Interview",
        "tracks": [{"type": "video", "clips": [clip(media["a.mov"], 0, 0, 4)]}],
        "grades": [{"originId": "gone", "trackIndex": 1, "start": 0}, {"originId": "v1", "trackIndex": 2, "start": 0}],
    }, probe=probe_none)  # fmt: skip
    assert (result["gradesCopied"], result["gradesNotCopied"]) == (0, 2)


def test_a_clip_past_its_files_end_is_refused_before_resolve_sees_it(setup, media):
    host, project, _ = setup
    # The pool knows a.mov is 750 frames, 30 s at 25 fps.
    with pytest.raises(HostError, match="a.mov is only 30.00 s long"):
        rebuild(
            host,
            {
                "timeline": "Interview",
                "tracks": [{"type": "video", "clips": [clip(media["a.mov"], 0, 28, 32)]}],
            },
            probe=probe_none,
        )
    assert project.pool.imported is None


def test_a_file_the_pool_cant_describe_is_probed(setup, media):
    host, project, _ = setup
    project.pool.root.subfolders[0].clips.append(PoolClip(media["new.mov"], fps="unknown"))
    probed = []

    def probe(path):
        probed.append(path)
        return {"seconds": 0.0, "timecode": None, "duration": 3.0}

    with pytest.raises(HostError, match="new.mov is only 3.00 s long"):
        rebuild(
            host,
            {
                "timeline": "Interview",
                "tracks": [{"type": "video", "clips": [clip(media["new.mov"], 0, 1, 5)]}],
            },
            probe=probe,
        )
    assert probed == [media["new.mov"]]


def test_an_unreadable_new_file_counts_from_zero_with_a_warning(setup, media):
    host, project, _ = setup
    project.pool.root.subfolders[0].clips.append(PoolClip(media["b.mov"], fps="unknown"))
    result = rebuild(
        host,
        {
            "timeline": "Interview",
            "tracks": [{"type": "video", "clips": [clip(media["b.mov"], 0, 0, 2)]}],
        },
        probe=probe_none,
    )
    assert any("timecode of 1 file" in w for w in result["warnings"])


def test_a_failed_import_says_the_original_is_unchanged(setup, media):
    host, project, _ = setup
    project.pool.fail = True
    with pytest.raises(HostError, match="connected timeline is unchanged"):
        rebuild(
            host,
            {
                "timeline": "Interview",
                "tracks": [{"type": "video", "clips": [clip(media["a.mov"], 0, 0, 2)]}],
            },
            probe=probe_none,
        )


def test_a_chosen_name_never_replaces_an_existing_timeline(setup, media):
    host, project, _ = setup
    result = rebuild(
        host,
        {
            "timeline": "Interview",
            "name": "Interview",
            "tracks": [{"type": "video", "clips": [clip(media["a.mov"], 0, 0, 2)]}],
        },
        probe=probe_none,
    )
    assert result["timeline"] == "Interview 2"


def test_names():
    assert default_name("Interview", {"Interview"}) == "Interview (VibeCut 1)"
    assert default_name("Interview", {"Interview (VibeCut 1)"}) == "Interview (VibeCut 2)"
    assert (
        default_name("Interview (VibeCut 2)", {"Interview (VibeCut 1)", "Interview (VibeCut 2)"})
        == "Interview (VibeCut 3)"
    )
    assert unique_name("Cut", {"Cut", "Cut 2"}) == "Cut 3"


def test_validate_tracks_refuses_what_resolve_couldnt_import(media, tmp_path):
    with pytest.raises(HostError, match="not a file on this computer"):
        validate_tracks([{"type": "video", "clips": [clip(str(tmp_path / "missing.mov"), 0, 0, 1)]}])
    with pytest.raises(HostError, match="not a file on this computer"):
        validate_tracks([{"type": "video", "clips": [clip("relative.mov", 0, 0, 1)]}])
    with pytest.raises(HostError, match="end after it starts"):
        validate_tracks([{"type": "video", "clips": [clip(media["a.mov"], 0, 2, 2)]}])
    with pytest.raises(HostError, match="timeMap"):
        validate_tracks(
            [
                {
                    "type": "video",
                    "clips": [
                        clip(
                            media["a.mov"],
                            0,
                            0,
                            4,
                            timeMap=[{"t": 0, "s": 1}, {"t": 2, "s": 4}],
                        )
                    ],
                }
            ]
        )
    with pytest.raises(HostError, match="nothing to put"):
        validate_tracks([{"type": "video", "clips": []}])
    tracks = validate_tracks(
        [
            {
                "type": "video",
                "clips": [
                    clip(
                        media["a.mov"],
                        1,
                        0,
                        4,
                        timeMap=[{"t": 0, "s": 0}, {"t": 2, "s": 4}],
                        enabled=False,
                    )
                ],
            }
        ]
    )
    assert (
        tracks[0]["clips"][0]["time_map"] == [(0.0, 0.0), (2.0, 4.0)]
        and tracks[0]["clips"][0]["enabled"] is False
    )


def test_rebuild_is_a_listed_command(setup, media, monkeypatch):
    host, _, _ = setup
    from vibecut_agent.nle import resolve_rebuild

    monkeypatch.setattr(resolve_rebuild, "rebuild", lambda h, a: {"ran": a["timeline"]})
    assert run_command(host, "rebuild", {"timeline": "Interview"}) == {"ran": "Interview"}


def test_validate_tracks_carries_fades_and_transitions(media):
    # A timeline pulled into VibeCut and sent back (PLAN.md, phase 5) keeps VibeCut's fades and
    # dissolves; a malformed one is dropped, not refused.
    tracks = validate_tracks(
        [
            {
                "type": "video",
                "clips": [
                    clip(
                        media["a.mov"],
                        0,
                        0,
                        2,
                        fadeInSeconds=0.5,
                        transitionOut={"kind": "dissolve", "seconds": 1},
                    ),
                    clip(
                        media["a.mov"],
                        2,
                        2,
                        4,
                        fadeOutSeconds=-1,
                        transitionOut={"kind": "wipe", "seconds": 1},
                    ),
                ],
            }
        ]
    )
    first, second = tracks[0]["clips"]
    assert first["fade_in_seconds"] == 0.5
    assert first["transition_out"] == {"kind": "dissolve", "seconds": 1.0}
    assert "fade_out_seconds" not in second and "transition_out" not in second


def test_a_ramped_clip_built_as_pieces_gets_its_grade_on_every_piece():
    # A ramp is rebuilt as constant-speed pieces (PLAN.md, "Phase 8b"): with an end, every piece on the
    # track in the clip's range is graded; a clip after it isn't.
    from vibecut_agent.nle.resolve_rebuild import copy_grades

    class Piece:
        def __init__(self, start):
            self.start = start

        def GetStart(self):
            return 1000 + self.start

    class Source:
        def __init__(self):
            self.targets = []

        def GetUniqueId(self):
            return "v1"

        def CopyGrades(self, targets):
            self.targets += targets
            return True

    source = Source()

    class Original:
        def GetTrackCount(self, kind):
            return 1 if kind == "video" else 0

        def GetItemListInTrack(self, kind, index):
            return [source]

    pieces = [Piece(0), Piece(50), Piece(120), Piece(250)]

    class New:
        def GetStartFrame(self):
            return 1000

        def GetTrackCount(self, kind):
            return 1 if kind == "video" else 0

        def GetItemListInTrack(self, kind, index):
            return pieces

    pairs = [{"originId": "v1", "trackIndex": 1, "start": 0, "end": 10}]
    assert copy_grades(Original(), New(), pairs, 25.0) == (1, 0)
    assert source.targets == pieces[:3]
