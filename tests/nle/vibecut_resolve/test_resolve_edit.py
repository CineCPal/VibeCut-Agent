"""tests/test_resolve_edit.py -- direct edits on the connected timeline: backups, adding into free space,
lifting clips, switching them and setting levels, and reverting. The fakes behave as Resolve 21.1 did
when checked live (see resolve_edit.py): AppendToTimeline refuses an occupied place or a missing track
with an empty item, and DuplicateTimeline opens the copy."""

import itertools

import pytest

from tests.nle.compat import run_command
from tests.nle.vibecut_resolve.resolve_fakes import Bin, FakeProject, FakeResolve, Pool, PoolItem
from vibecut_agent.nle.resolve import HostError, ResolveHost

START = 90000  # 01:00:00:00 at 25 fps
ids = itertools.count(1)


class Item:
    def __init__(self, timeline, kind, media, start, end, left=0, enabled=True, volume=0.0):
        self.timeline, self.kind, self.media = timeline, kind, media
        self.start, self.end, self.left, self.enabled = start, end, left, enabled
        self.props = {"AudioVolume": volume} if kind == "audio" else {"ZoomX": 1.0, "Opacity": 100.0}
        self.links, self.uid = [], f"t{next(ids)}"
        self.color, self.fades, self.comps, self.grade, self.markers = (
            "",
            {"FadeIn": 0.0, "FadeOut": 0.0},
            [],
            None,
            {},
        )
        self.speed = 100.0
        self.transition = None  # Resolve's name for it, when the item is a transition

    def GetUniqueId(self):
        return self.uid

    def GetName(self):
        return self.media.GetName() if self.media else (self.transition or "Cross Dissolve")

    def GetStart(self):
        return self.start

    def GetEnd(self):
        return self.end

    def GetLeftOffset(self):
        return self.left

    def GetSpeed(self):
        return {"Percentage": self.speed}

    def SetSpeed(self, options):
        """As Resolve 21.1 did (PLAN.md, "7b.0 probe"): the linked clips follow; without ripple the
        length stays, with it the length changes and every later clip on every track moves."""
        percentage = float(options["Percentage"])
        group = [self, *self.links]
        if options.get("RippleTimeline") is True:
            old_end = self.end
            length = round((self.end - self.start) * self.speed / percentage)
            delta = self.start + length - old_end
            for tracks in self.timeline.tracks.values():
                for track in tracks:
                    for other in track:
                        if other not in group and other.start >= old_end:
                            other.start, other.end = other.start + delta, other.end + delta
            for item in group:
                item.end = item.start + length
        for item in group:
            item.speed = percentage
        return True

    def GetClipEnabled(self):
        return self.enabled

    def SetClipEnabled(self, value):
        self.enabled = value
        return True

    def GetProperty(self, key=None):
        return dict(self.props) if key is None else self.props.get(key)

    def SetProperties(self, values):
        self.props.update(values)
        return True

    def GetClipColor(self):
        return self.color

    def SetClipColor(self, color):
        self.color = color
        return True

    def GetType(self):
        return "transition" if self.transition else self.kind

    def AddTransition(self, options):
        """At the item's end, centred, as Resolve 21.1 did (resolve_effects.py)."""
        if options.get("position") != "end" or options.get("alignment") != "center":
            return None
        frames = int(options["duration"])
        track = next(t for t in self.timeline.tracks[self.kind] if self in t)
        made = Item(
            self.timeline, self.kind, None, self.end - frames // 2, self.end + frames - frames // 2, None
        )
        made.transition = options["type"]
        track.append(made)
        return made

    def GetFades(self):
        return dict(self.fades)

    def SetFades(self, fades):
        if sum(float(v) for v in fades.values()) > self.end - self.start:
            return False  # as 21.1 refuses a fade longer than the clip
        self.fades = dict(fades)
        return True

    def GetFusionCompNameList(self):
        return [name for name, _ in self.comps]

    def ExportFusionComp(self, path, index):
        with open(path, "w") as f:
            f.write(self.comps[index - 1][1])
        return True

    def ImportFusionComp(self, path):
        with open(path) as f:
            self.comps.append((f"Composition {len(self.comps) + 1}", f.read()))
        return True

    def CopyGrades(self, targets):
        for target in targets:
            target.grade = self.grade
        return self.grade is not None

    def GetMarkers(self):
        return dict(self.markers)

    def SetProperty(self, key, value):
        if key != "AudioVolume" or not isinstance(value, float):
            return False
        self.props[key] = value
        return True

    def GetLinkedItems(self):
        return list(self.links)

    def GetMediaPoolItem(self):
        return self.media

    def GetTrackTypeAndIndex(self):
        for index, track in enumerate(self.timeline.tracks[self.kind], 1):
            if self in track:
                return [self.kind, index]
        return [self.kind, 0]


class Dead:
    """What AppendToTimeline returns when it placed nothing."""

    def GetName(self):
        return None

    def GetStart(self):
        return None


class EditTimeline:
    def __init__(self, name):
        self.name = name
        self.tracks = {"video": [[]], "audio": [[]]}

    def GetName(self):
        return self.name

    def GetSetting(self, key):
        return "25" if key == "timelineFrameRate" else ""

    def GetStartFrame(self):
        return START

    def GetTrackCount(self, kind):
        return len(self.tracks.get(kind, []))

    def GetTrackName(self, kind, index):
        return f"{kind.capitalize()} {index}"

    def GetItemListInTrack(self, kind, index):
        return sorted(self.tracks[kind][index - 1], key=lambda i: i.start)

    def AddTrack(self, kind):
        self.tracks[kind].append([])
        return True

    def DeleteClips(self, items, ripple):
        assert ripple is False
        if any(self.is_locked(*i.GetTrackTypeAndIndex()) for i in items):
            return False
        for item in items:
            for track in self.tracks[item.kind]:
                if item in track:
                    track.remove(item)
        return True

    def DeleteTrack(self, kind, index):
        assert not self.tracks[kind][index - 1]
        del self.tracks[kind][index - 1]
        return True

    def SetClipsLinked(self, items, linked):
        # As Resolve 21.1 did in the 8a.0 probe: linking regroups (the clips leave the groups they
        # were in), unlinking one clip alone does nothing, and an unlink leaves the other members of
        # the old group still listing the unlinked clips. A locked track's clips aren't touched.
        items = [i for i in items if not self.is_locked(*i.GetTrackTypeAndIndex())]
        if linked:
            for item in items:
                for old in item.links:
                    if old not in items:
                        old.links = [o for o in old.links if o is not item]
                item.links = [o for o in items if o is not item]
        elif len(items) > 1:
            for item in items:
                item.links = []
        return True

    # Track switches: Resolve reads and sets them only on the timeline open in it (8a.0 probe).
    def _is_current(self):
        project = getattr(self, "project", None)
        return project is None or project.current is self

    def is_locked(self, kind, index):
        return (kind, index) in getattr(self, "locked", set())

    def GetIsTrackLocked(self, kind, index):
        return self._is_current() and self.is_locked(kind, index)

    def SetTrackLock(self, kind, index, value):
        if not self._is_current():
            return False
        self.locked = getattr(self, "locked", set())
        (self.locked.add if value else self.locked.discard)((kind, index))
        return True

    def GetIsTrackEnabled(self, kind, index):
        return self._is_current() and (kind, index) not in getattr(self, "disabled", set())

    def SetTrackEnable(self, kind, index, value):
        if not self._is_current():
            return False
        self.disabled = getattr(self, "disabled", set())
        (self.disabled.discard if value else self.disabled.add)((kind, index))
        return True

    def DuplicateTimeline(self, name):
        copy = EditTimeline(name)
        self.project.timelines.append(copy)
        self.project.current = copy
        return copy

    def place(self, kind, index, media, start, end, left=0, **kwargs):
        while len(self.tracks[kind]) < index:
            self.tracks[kind].append([])
        item = Item(self, kind, media, START + start, START + end, left, **kwargs)
        self.tracks[kind][index - 1].append(item)
        return item


class EditPool(Pool):
    def __init__(self, root, timeline):
        super().__init__(root)
        self.timeline, self.appended, self.imported = timeline, [], []

    def AppendToTimeline(self, infos):
        out = []
        for info in infos:
            kind = "video" if info["mediaType"] == 1 else "audio"
            index = info["trackIndex"]
            start = info["recordFrame"]
            end = start + info["endFrame"] - info["startFrame"]
            self.appended.append(info)
            tracks = self.timeline.tracks[kind]
            if (
                index > len(tracks)
                or self.timeline.is_locked(kind, index)
                or any(not (end <= i.start or start >= i.end) for i in tracks[index - 1])
            ):
                out.append(Dead())
                continue
            item = Item(
                self.timeline,
                kind,
                info["mediaPoolItem"],
                start,
                end,
                info["startFrame"],
            )
            tracks[index - 1].append(item)
            out.append(item)
        return out

    def GetCurrentFolder(self):
        return self.root

    def SetCurrentFolder(self, folder):
        return True

    def AddSubFolder(self, parent, name):
        sub = Bin(name)
        parent.subs.append(sub)
        return sub

    def ImportMedia(self, paths):
        for path in paths:
            self.root.clips.append(
                PoolItem(
                    f"m-{path}",
                    path.rsplit("/", 1)[-1],
                    props={"File Path": path, "Type": "Video"},
                )
            )
        self.imported += paths
        return True


def make_edit():
    """A connected "Interview" with A.mov on V1 and A1 (0-10 s, linked) and another timeline open."""
    interview = PoolItem("m-a", "A.mov", props={"File Path": "/m/A.mov"})  # Video + Audio, 30 s at 25 fps
    broll = PoolItem("m-b", "B.mov", props={"File Path": "/m/B.mov", "Type": "Video"})
    music = PoolItem("m-s", "Song.wav", props={"File Path": "/m/Song.wav", "Type": "Audio"})
    timeline = EditTimeline("Interview")
    other = EditTimeline("Other")
    project = FakeProject([timeline, other])
    project.current = other  # the user has another timeline open in Resolve
    timeline.project = project
    project.pool = EditPool(Bin("Master", [interview, broll, music]), timeline)
    project.GetMediaPool = lambda: project.pool
    v = timeline.place("video", 1, interview, 0, 250)
    a = timeline.place("audio", 1, interview, 0, 250, volume=-3.0)
    v.links, a.links = [a], [v]
    return (
        ResolveHost(FakeResolve(project)),
        timeline,
        project,
        {"v": v, "a": a, "interview": interview, "broll": broll, "music": music},
    )


@pytest.fixture
def edit():
    return make_edit()


def call(host, command, **args):
    return run_command(host, command, {"timeline": "Interview", **args})


def test_backup_duplicates_and_leaves_the_users_timeline_open(edit):
    host, _timeline, project, _ = edit
    assert call(host, "backup_timeline") == {"backup": "Interview (before VibeCut 1)"}
    assert call(host, "backup_timeline") == {"backup": "Interview (before VibeCut 2)"}
    assert project.current.GetName() == "Other"


def test_add_clips_puts_picture_and_sound_in_free_space_linked(edit):
    host, timeline, project, c = edit
    result = call(
        host,
        "add_clips",
        clips=[{"clipId": "m-a", "sourceIn": 2, "sourceOut": 4, "at": 12, "volumeDb": -6}],
    )
    (change,) = result["changes"]
    assert change["tracks"] == ["V1", "A1"] and (change["at"], change["end"]) == (
        12.0,
        14.0,
    )
    v, a = (
        next(i for i in timeline.tracks[k][0] if i.uid == u)
        for k, u in zip(("video", "audio"), change["itemIds"])
    )
    assert (v.start - START, v.end - START, v.left) == (300, 350, 50)
    assert v.links == [a] and a.props["AudioVolume"] == -6.0
    appended = project.pool.appended
    assert [i["mediaType"] for i in appended] == [1, 2] and appended[0]["recordFrame"] == START + 300


def test_add_clips_takes_the_lowest_free_track_and_adds_one_when_needed(edit):
    host, timeline, _project, _ = edit
    result = call(
        host,
        "add_clips",
        clips=[
            {"clipId": "m-b", "sourceIn": 0, "sourceOut": 2, "at": 1},
            {"clipId": "m-b", "sourceIn": 5, "sourceOut": 6, "at": 2},
        ],
    )
    assert [c["tracks"] for c in result["changes"]] == [["V2"], ["V3"]]
    assert result["addedTracks"] == ["V2", "V3"] and timeline.GetTrackCount("video") == 3
    song = call(
        host,
        "add_clips",
        clips=[{"clipId": "m-s", "sourceIn": 0, "sourceOut": 5, "at": 0}],
    )
    assert song["changes"][0]["tracks"] == ["A2"]


def test_add_clips_never_overwrites_and_checks_everything_first(edit):
    host, _timeline, project, _ = edit
    with pytest.raises(HostError, match="V1 isn't free.*Leave videoTrack out"):
        call(
            host,
            "add_clips",
            clips=[
                {"clipId": "m-b", "sourceIn": 0, "sourceOut": 1, "at": 20},
                {
                    "clipId": "m-b",
                    "sourceIn": 0,
                    "sourceOut": 2,
                    "at": 5,
                    "videoTrack": 1,
                },
            ],
        )
    with pytest.raises(HostError, match="only 30.0 s long"):
        call(
            host,
            "add_clips",
            clips=[{"clipId": "m-a", "sourceIn": 29, "sourceOut": 31, "at": 20}],
        )
    with pytest.raises(HostError, match="video track 5 doesn't exist"):
        call(
            host,
            "add_clips",
            clips=[
                {
                    "clipId": "m-b",
                    "sourceIn": 0,
                    "sourceOut": 1,
                    "at": 0,
                    "videoTrack": 5,
                }
            ],
        )
    with pytest.raises(HostError, match="not both"):
        call(
            host,
            "add_clips",
            clips=[
                {
                    "clipId": "m-b",
                    "path": "/m/B.mov",
                    "sourceIn": 0,
                    "sourceOut": 1,
                    "at": 0,
                }
            ],
        )
    with pytest.raises(HostError, match="nothing to place"):
        call(
            host,
            "add_clips",
            clips=[
                {
                    "clipId": "m-s",
                    "sound": False,
                    "sourceIn": 0,
                    "sourceOut": 1,
                    "at": 0,
                }
            ],
        )
    assert project.pool.appended == []


def test_add_clips_imports_a_file_first(edit, tmp_path):
    host, _timeline, project, _ = edit
    path = tmp_path / "NEW.mov"
    path.write_bytes(b"x")
    result = call(
        host,
        "add_clips",
        clips=[{"path": str(path), "sourceIn": 0, "sourceOut": 1, "at": 20}],
    )
    assert project.pool.imported == [str(path)] and result["changes"][0]["name"] == "NEW.mov"
    with pytest.raises(HostError, match="no file"):
        call(
            host,
            "add_clips",
            clips=[
                {
                    "path": str(tmp_path / "missing.mov"),
                    "sourceIn": 0,
                    "sourceOut": 1,
                    "at": 0,
                }
            ],
        )


def test_delete_lifts_the_clip_with_its_linked_sound_and_records_how_to_put_it_back(
    edit,
):
    host, timeline, _project, c = edit
    result = call(host, "delete_clips", itemIds=[c["v"].uid])
    assert [r["track"] for r in result["changes"]] == [["video", 1], ["audio", 1]]
    assert result["changes"][1] | {"itemId": "x", "deletedWith": []} == {
        "kind": "deleted", "itemId": "x", "name": "A.mov", "track": ["audio", 1], "start": 0.0, "end": 10.0,
        "mediaId": "m-a", "sourceStartFrame": 0, "enabled": True, "volumeDb": -3.0, "deletedWith": [],
    }  # fmt: skip
    assert timeline.tracks["video"][0] == [] and timeline.tracks["audio"][0] == []
    v2 = timeline.place("video", 1, c["interview"], 300, 400)
    only = call(host, "delete_clips", itemIds=[v2.uid], withLinked=False)
    assert len(only["changes"]) == 1


def test_delete_refuses_transitions_and_unknown_ids(edit):
    host, timeline, _project, _ = edit
    effect = timeline.place("video", 1, None, 240, 260, left=None)
    with pytest.raises(HostError, match="transition"):
        call(host, "delete_clips", itemIds=[effect.uid])
    with pytest.raises(HostError, match="no clip"):
        call(host, "delete_clips", itemIds=["nope"])


def test_enabled_and_levels(edit):
    host, _timeline, _project, c = edit
    off = call(host, "set_clips_enabled", itemIds=[c["v"].uid, c["a"].uid], enabled=False)
    assert [(x["before"], x["after"]) for x in off["changes"]] == [
        (True, False),
        (True, False),
    ]
    assert call(host, "set_clips_enabled", itemIds=[c["v"].uid], enabled=False)["changes"] == []
    # A picture clip's id sets its linked sound.
    levels = call(host, "set_clip_levels", levels=[{"itemId": c["v"].uid, "volumeDb": -120}])
    assert levels["changes"] == [
        {
            "kind": "level",
            "itemId": c["a"].uid,
            "name": "A.mov",
            "before": -3.0,
            "after": -100.0,
        }
    ]
    with pytest.raises(HostError, match="enabled must be"):
        call(host, "set_clips_enabled", itemIds=[c["v"].uid], enabled="no")


def test_revert_undoes_each_kind_newest_first(edit):
    host, timeline, _project, c = edit
    log = [
        call(host, "set_clip_levels", levels=[{"itemId": c["a"].uid, "volumeDb": -10}]),
        call(host, "set_clips_enabled", itemIds=[c["v"].uid], enabled=False),
        call(
            host,
            "add_clips",
            clips=[{"clipId": "m-b", "sourceIn": 0, "sourceOut": 2, "at": 3}],
        ),
        call(host, "delete_clips", itemIds=[c["v"].uid]),
    ]
    result = call(
        host,
        "revert_timeline_changes",
        changes=[x for entry in log for x in entry["changes"]],
    )
    assert [r["kind"] for r in result["reverted"]] == [
        "deleted",
        "deleted",
        "added",
        "enabled",
        "level",
    ]
    assert result["changedSince"] == [] and result["failed"] == [] and result["lost"] == ["A.mov"]
    (v,) = timeline.tracks["video"][0]
    (a,) = timeline.tracks["audio"][0]
    assert (v.start, v.end, v.enabled, a.props["AudioVolume"]) == (
        START,
        START + 250,
        True,
        -3.0,
    )
    # The V2 that the B-roll needed is gone again.
    assert v.links == [a] and timeline.GetTrackCount("video") == 1
    assert set(result["restoredIds"]) == {c["v"].uid, c["a"].uid}


def test_revert_leaves_what_changed_since(edit):
    host, timeline, _project, c = edit
    level = call(host, "set_clip_levels", levels=[{"itemId": c["a"].uid, "volumeDb": -10}])
    deleted = call(host, "delete_clips", itemIds=[c["v"].uid], withLinked=False)
    added = call(
        host,
        "add_clips",
        clips=[{"clipId": "m-b", "sourceIn": 0, "sourceOut": 2, "at": 20}],
    )
    c["a"].props["AudioVolume"] = -20.0  # changed by hand in Resolve
    timeline.place("video", 1, c["interview"], 100, 200)  # something now sits where the deleted clip was
    added_item = next(
        i for t in timeline.tracks["video"] for i in t if i.uid == added["changes"][0]["itemIds"][0]
    )
    added_item.start += 25  # the user moved it
    result = call(
        host,
        "revert_timeline_changes",
        changes=level["changes"] + deleted["changes"] + added["changes"],
    )
    assert [x["reason"] for x in result["changedSince"]] == [
        "it was moved since",
        "its place is taken now",
        "it was changed since",
    ]
    assert result["reverted"] == [] and c["a"].props["AudioVolume"] == -20.0


def test_edit_commands_need_the_connected_timeline(edit):
    host, _timeline, _project, c = edit
    with pytest.raises(HostError, match="no timeline called"):
        run_command(
            host,
            "set_clips_enabled",
            {"timeline": "Gone", "itemIds": [c["v"].uid], "enabled": False},
        )
    with pytest.raises(HostError, match="changes must be"):
        call(host, "revert_timeline_changes", changes=[{"kind": "evil"}])


# ------------------------------------------------------------------------------- nesting (13f)


def compound_maker(timeline):
    """CreateCompoundClip as Resolve 21.1 did in the 13f probe: the items go, a compound clip takes their
    place on the lowest picture and sound track among them, and the call returns None."""

    def create(items, options):
        compound = PoolItem("m-compound", options["name"], props={"Type": "Compound"})
        for kind in ("video", "audio"):
            mine = [i for i in items if i.kind == kind]
            if not mine:
                continue
            index = min(i.GetTrackTypeAndIndex()[1] for i in mine)
            start, end = min(i.start for i in mine), max(i.end for i in mine)
            for i in mine:
                for track in timeline.tracks[kind]:
                    if i in track:
                        track.remove(i)
            timeline.tracks[kind][index - 1].append(Item(timeline, kind, compound, start, end, 0))

    return create


def test_nest_makes_one_compound_from_the_range_and_reverts_to_the_clips(edit):
    host, timeline, _project, c = edit
    b = timeline.place("video", 2, c["broll"], 50, 150)
    timeline.CreateCompoundClip = compound_maker(timeline)
    result = call(host, "nest_clips", start=0, end=10, name="Opening")
    kinds = [x["kind"] for x in result["changes"]]
    assert kinds == ["deleted", "deleted", "deleted", "added"]
    added = result["changes"][-1]
    assert added["tracks"] == ["V1", "A1"] and added["name"] == "Opening" and added["nested"] == 3
    assert [i.media.name for i in timeline.tracks["video"][0]] == ["Opening"] and timeline.tracks["video"][
        1
    ] == []
    reverted = call(host, "revert_timeline_changes", changes=result["changes"])
    assert [r["kind"] for r in reverted["reverted"]] == ["added", "deleted", "deleted", "deleted"]
    assert [i.media.name for i in timeline.tracks["video"][0]] == ["A.mov"]
    assert [(i.media.name, i.start, i.end) for i in timeline.tracks["video"][1]] == [
        ("B.mov", b.start, b.end)
    ]


def test_nest_refuses_a_clip_across_the_edge_and_an_empty_range(edit):
    host, timeline, _project, _c = edit
    timeline.CreateCompoundClip = compound_maker(timeline)
    with pytest.raises(HostError, match="run across the edge"):
        call(host, "nest_clips", start=0, end=5)
    with pytest.raises(HostError, match="nothing between"):
        call(host, "nest_clips", start=20, end=25)


# ------------------------------------------------------------------------------- captions (13h)

CAPTION_CONSTANTS = (
    "SUBTITLE_LANGUAGE", "SUBTITLE_CAPTION_PRESET", "SUBTITLE_CHARS_PER_LINE", "SUBTITLE_LINE_BREAK", "SUBTITLE_GAP",
    "AUTO_CAPTION_AUTO", "AUTO_CAPTION_ENGLISH", "AUTO_CAPTION_SUBTITLE_DEFAULT", "AUTO_CAPTION_LINE_SINGLE", "AUTO_CAPTION_LINE_DOUBLE",
)  # fmt: skip


def captioning(host, timeline, made=True):
    for name in CAPTION_CONSTANTS:
        setattr(host._resolve, name, name)
    seen = {}

    def create(settings):
        seen.update(settings)
        if made:
            timeline.tracks["subtitle"] = [
                [
                    Item(timeline, "subtitle", None, START + 25, START + 75),
                    Item(timeline, "subtitle", None, START + 100, START + 150),
                ]
            ]
        return made

    timeline.CreateSubtitlesFromAudio = create
    return seen
