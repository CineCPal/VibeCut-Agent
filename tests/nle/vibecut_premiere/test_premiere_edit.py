"""Ported from VibeCut's host-premiere tests: direct edits against a fake Premiere that behaves as 26.5.2 was seen to (premiere_edit.py's docstring)."""

from __future__ import annotations

import copy
import itertools

import pytest

from tests.nle.compat import run_command
from tests.nle.fakes import TB_25
from vibecut_agent.nle.premiere import TICKS_PER_SECOND, HostError, PremiereHost
from vibecut_agent.nle.premiere_edit import gain

T = TICKS_PER_SECOND


class FakePremiere:
    """One sequence ("Main", 25 fps) with V1, V2 and A1-A3, answering the panel's commands."""

    def __init__(self, media: dict[str, dict]) -> None:
        self.media = media  # path -> {"channels": n, "video": bool}
        self.ids = (f"n{i}" for i in itertools.count(1))
        self.video = [[], []]
        self.audio = [[], [], []]
        self.sequences = ["Main"]
        self.calls: list[str] = []
        self.qe = True  # whether Premiere's QE layer can add and remove tracks
        self.drags_links = False  # whether set_items also slips a clip's linked clips
        self.transitions: dict[int, list[dict]] = {}  # id(track list) -> its transitions
        self.fades: dict[str, dict] = {}  # clip id -> {"keys": [...], "value": v}
        self.speed_ignored = False  # as if Premiere answered but kept the old speed
        self.razor_offset = 0  # ticks a razor lands off the asked frame
        self.effects: set[str] = set()  # clip ids with effects a re-placement would lose
        # (kind, 0-based index) -> {muted, locked, targeted, syncLocked}
        self.track_flags: dict[tuple[str, int], dict[str, bool]] = {}

    # -------------------------------------------------------------- setting up

    def clip(self, path, track_kind, track, start, end, src_in, linked=(), level=None):
        clip = {
            "id": next(self.ids),
            "name": path.rsplit("/", 1)[-1],
            "startTicks": str(round(start * T)),
            "endTicks": str(round(end * T)),
            "inTicks": str(round(src_in * T)),
            "outTicks": str(round((src_in + end - start) * T)),
            "disabled": False,
            "speed": 1,
            "mediaPath": path,
            "projectItemId": "pi-" + path.rsplit("/", 1)[-1].replace(".", "-"),
            "linkedIds": [],
            "level": (gain(0) if level is None else level) if track_kind == "audio" else None,
        }
        (self.video if track_kind == "video" else self.audio)[track - 1].append(clip)
        return clip

    def link(self, *clips):
        for c in clips:
            c["linkedIds"] = [o["id"] for o in clips if o is not c]

    def everything(self):
        return [
            (k, i, c)
            for k, tracks in (("video", self.video), ("audio", self.audio))
            for i, t in enumerate(tracks)
            for c in t
        ]

    def state(self):
        """The sequence without ids: what a revert must give back."""
        names = {c["id"]: (k, i, c["startTicks"]) for k, i, c in self.everything()}
        return sorted(
            (k, i, c["name"], c["startTicks"], c["endTicks"], c["inTicks"], c["outTicks"], c["disabled"], round(c["level"] or 0, 6), tuple(sorted(names[l] for l in c["linkedIds"] if l in names)))
            for k, i, c in self.everything()
        )  # fmt: skip

    # -------------------------------------------------------------- the panel

    def __call__(self, command, args, timeout_s):
        self.calls.append(command)
        return getattr(self, command)(args)

    def status(self, _a):
        return {"sequences": list(self.sequences), "activeSequence": "Main"}

    def read_sequence(self, a):
        assert a["timeline"] == "Main"
        # Effects are only reported when asked for, as the panel does.
        custom = lambda c: {"custom": c["id"] in self.effects if a.get("effects") else None}
        flags = lambda clips: self.flags(*next(
            (k, i) for k, ts in (("video", self.video), ("audio", self.audio)) for i, t in enumerate(ts) if t is clips
        ))  # fmt: skip
        track = lambda clips: {
            "name": "",
            "muted": flags(clips)["muted"],
            "locked": flags(clips)["locked"],
            "targeted": flags(clips)["targeted"],
            "clips": [{**c, **custom(c)} for c in sorted(clips, key=lambda c: int(c["startTicks"]))],
            "transitions": sorted(self.transitions.get(id(clips), []), key=lambda t: int(t["startTicks"])),
        }
        return {
            "name": "Main",
            "timebase": str(TB_25),
            "zeroPoint": "0",
            "endTicks": str(60 * T),
            "isActive": True,
            "video": [track(t) for t in self.video],
            "audio": [track(t) for t in self.audio],
            "markers": [],
        }

    def backup_sequence(self, a):
        self.sequences.append(a["name"])
        return {"name": a["name"]}

    def place_clip(self, a):
        if "itemId" in a:
            assert a["itemId"] == "pi-" + a["path"].rsplit("/", 1)[-1].replace(".", "-")
        media = self.media[a["path"]]
        start = int(a["atTicks"])
        length = round((a["outSeconds"] - a["inSeconds"]) * T)
        placed = []
        targets = ([("video", a["videoTrack"])] if media["video"] else []) + [
            ("audio", a["audioTrack"] + c) for c in range(media["channels"])
        ]
        for kind, index in targets:
            tracks = self.video if kind == "video" else self.audio
            # Overwrite: anything there is cut away (the fake just drops it, which the edit module must never let happen).
            tracks[index] = [
                c
                for c in tracks[index]
                if int(c["endTicks"]) <= start or int(c["startTicks"]) >= start + length
            ]
            clip = self.clip(
                a["path"],
                kind,
                index + 1,
                start / T,
                (start + length) / T,
                a["inSeconds"],
            )
            placed.append({**clip, "type": kind, "track": index})
        self.link(*[self.find(p["id"]) for p in placed])
        return {"placed": [{**p, "linkedIds": self.find(p["id"])["linkedIds"]} for p in placed]}

    def find(self, item_id):
        return next(c for _k, _i, c in self.everything() if c["id"] == item_id)

    def remove_items(self, a):
        removed = []
        for tracks in (self.video, self.audio):
            for t in tracks:
                for c in [c for c in t if c["id"] in a["ids"]]:
                    t.remove(c)
                    removed.append(c["id"])
        for _k, _i, c in self.everything():
            c["linkedIds"] = [l for l in c["linkedIds"] if l not in removed]
        return {
            "removed": removed,
            "notFound": [i for i in a["ids"] if i not in removed],
        }

    def nest_range(self, a):
        """As Premiere 26.5.2 did in the 13f probe: the clips lifted, the new sequence on V1 and A1."""
        removed = self.remove_items({"ids": a["ids"]})["removed"]
        start, end = int(a["inTicks"]) / T, int(a["outTicks"]) / T
        placed = []
        for kind in ("video", "audio"):
            clip = self.clip(f"/nested/{a['name']}", kind, 1, start, end, 0)
            clip["name"], clip["mediaPath"] = a["name"], None
            placed.append({**clip, "type": kind, "track": 0})
        self.link(*[self.find(p["id"]) for p in placed])
        return {"sequence": a["name"], "removed": removed, "placed": placed}

    def set_items(self, a):
        for want in a["items"]:
            clip = self.find(want["id"])
            if self.drags_links and "inTicks" in want:
                # As if Premiere slipped linked clips too.
                for other in clip["linkedIds"]:
                    moved = self.find(other)
                    shift = int(want["inTicks"]) - int(clip["inTicks"])
                    moved["inTicks"], moved["outTicks"] = (
                        str(int(moved["inTicks"]) + shift),
                        str(int(moved["outTicks"]) + shift),
                    )
            if "disabled" in want:
                clip["disabled"] = want["disabled"]
            if "level" in want:
                clip["level"] = want["level"]
            for key in ("inTicks", "outTicks", "startTicks", "endTicks"):
                if key in want:
                    clip[key] = want[key]
        return {"items": []}

    # -------------------------------------------------------------- fades and transitions (6e3)

    def _fade(self, clip_id):
        clip = self.find(clip_id)
        default = (
            {"keys": [{"ticks": clip["inTicks"], "value": clip["level"]}], "value": None}
            if clip["level"] is not None
            else {"keys": [], "value": 100.0}
        )
        return {"id": clip_id, **self.fades.get(clip_id, default)}

    def read_fades(self, a):
        return {"items": [self._fade(i) for i in a["ids"]]}

    def set_fades(self, a):
        for want in a["items"]:
            self.fades[want["id"]] = {
                "keys": list(want["keys"]),
                "value": None if want["keys"] else want["value"],
            }
        return {"items": [self._fade(w["id"]) for w in a["items"]]}

    def _track_of(self, clip_id):
        for tracks in (self.video, self.audio):
            for t in tracks:
                if any(c["id"] == clip_id for c in t):
                    return t
        raise KeyError(clip_id)

    def add_transition(self, a):
        """At the clip's end, centred (as QE's addTransition(…, false, frames, "0", 0.5, …) did)."""
        track = self._track_of(a["id"])
        end = int(self.find(a["id"])["endTicks"])
        frames = a["frames"]
        self.transitions.setdefault(id(track), []).append(
            {
                "name": a["name"],
                "startTicks": str(end - (frames // 2) * TB_25),
                "endTicks": str(end + (frames - frames // 2) * TB_25),
            }
        )
        return {"added": True, "transitions": list(self.transitions[id(track)])}

    def remove_transition(self, a):
        track = (self.audio if a["type"] == "audio" else self.video)[a["track"]]
        before = self.transitions.get(id(track), [])
        self.transitions[id(track)] = [t for t in before if t["startTicks"] != a["startTicks"]]
        return {
            "removed": len(before) != len(self.transitions[id(track)]),
            "transitions": list(self.transitions[id(track)]),
        }

    def flags(self, kind, index):
        return self.track_flags.setdefault(
            (kind, index),
            {"muted": False, "locked": False, "targeted": True, "syncLocked": True},
        )

    def set_track_options(self, a):
        flags = self.flags(a["kind"], a["index"])
        before = {k: flags[k] for k in a["keys"]}
        flags.update(a["options"])
        return {"before": before, "after": {k: flags[k] for k in a["keys"]}}

    def set_links(self, a):
        """Unlinks every clip asked, then links each group, as the panel does (8a.0 probe)."""
        for item_id in a["unlink"]:
            clip = self.find(item_id)
            for other in clip["linkedIds"]:
                o = self.find(other)
                o["linkedIds"] = [i for i in o["linkedIds"] if i != item_id]
            clip["linkedIds"] = []
        for group in a["groups"]:
            self.link(*[self.find(i) for i in group])
        return {"groups": len(a["groups"])}

    def link_items(self, a):
        present = [i for i in a["ids"] if any(c["id"] == i for _k, _i, c in self.everything())]
        self.link(*[self.find(i) for i in present])
        return {"linked": len(present) - 1, "answer": True}

    def add_tracks(self, a):
        if not self.qe:
            raise RuntimeError("Premiere's QE scripting, which adds and removes tracks, isn't available")
        self.video += [[] for _ in range(a["video"])]
        self.audio += [[] for _ in range(a["audio"])]
        return {"video": len(self.video), "audio": len(self.audio)}

    def remove_tracks(self, a):
        removed = {"video": [], "audio": []}
        for kind, tracks in (("video", self.video), ("audio", self.audio)):
            for i in sorted(a.get(kind, []), reverse=True):
                if i == len(tracks) - 1 and not tracks[i]:
                    tracks.pop()
                    removed[kind].append(i)
        return {"removed": removed}

    # -------------------------------------------------------------- speed and razor (7b)

    def set_speed(self, a):
        """Each item alone, keeping its length, as QE's setSpeed did (7b.0 probe)."""
        for want in a["items"]:
            if not self.speed_ignored:
                self.find(want["id"])["speed"] = want["speed"]
        return {"speeds": {w["id"]: self.find(w["id"])["speed"] for w in a["items"]}}

    def razor(self, a):
        """Cuts each clip's track at the timecode; the right piece is new and unlinked (7b.0 probe)."""
        hh, mm, ss, ff = (int(x) for x in a["timecode"].split(":"))
        cut = ((hh * 3600 + mm * 60 + ss) * 25 + ff) * TB_25 + self.razor_offset
        tracks = {id(self._track_of(i)): self._track_of(i) for i in a["ids"]}
        for track in tracks.values():
            for c in list(track):
                start, end = int(c["startTicks"]), int(c["endTicks"])
                if start < cut < end:
                    right = {**copy.deepcopy(c), "id": next(self.ids), "linkedIds": []}
                    right["startTicks"], right["inTicks"] = str(cut), str(int(c["inTicks"]) + cut - start)
                    c["endTicks"], c["outTicks"] = str(cut), str(int(c["inTicks"]) + cut - start)
                    track.append(right)
        return {"tracks": len(tracks)}

    def move_items(self, a):
        # One clip at a time, as vcMoveItems does. Premiere would let a clip land on another and
        # overlap them (8a.0 probe), so the fake refuses it: VibeCut must order or stage its moves.
        for item_id in a["ids"]:
            clip = self.find(item_id)
            for key in ("startTicks", "endTicks"):
                clip[key] = str(int(clip[key]) + int(a["offsetTicks"]))
            track = self._track_of(item_id)
            start, end = int(clip["startTicks"]), int(clip["endTicks"])
            assert not any(
                o is not clip and int(o["startTicks"]) < end and int(o["endTicks"]) > start for o in track
            ), f"{clip['name']} was moved onto another clip"
        return {"items": []}


class FakeProbe:
    def __init__(self, media):
        self.media = media

    def video(self, path):
        return {"width": 1920, "height": 1080} if self.media[path]["video"] else None

    def audio(self, path):
        return {"channels": self.media[path]["channels"], "sample_rate": 48000}

    def timecode(self, path):
        return {"seconds": 0.0, "duration": 30.0}


@pytest.fixture
def setup(tmp_path, monkeypatch):
    a, b, roll = (str(tmp_path / n) for n in ("A.mov", "B.mov", "ROLL.wav"))
    for p in (a, b, roll):
        open(p, "wb").close()
    media = {
        a: {"channels": 2, "video": True},
        b: {"channels": 2, "video": True},
        roll: {"channels": 1, "video": False},
    }
    premiere = FakePremiere(media)
    # A.mov at 0-3 s and C... B.mov at 5-8 s, each with its stereo sound on A1+A2.
    for path, start in ((a, 0), (b, 5)):
        v = premiere.clip(path, "video", 1, start, start + 3, 2)
        l = premiere.clip(path, "audio", 1, start, start + 3, 2)
        r = premiere.clip(path, "audio", 2, start, start + 3, 2)
        premiere.link(v, l, r)
    from vibecut_agent.nle import premiere_edit

    monkeypatch.setattr(premiere_edit, "Probe", lambda: FakeProbe(media))
    host = PremiereHost(premiere)
    return host, premiere, {"A": a, "B": b, "ROLL": roll}


def call(host, command, **args):
    return run_command(host, command, {"timeline": "Main", **args})


def revert(host, *results):
    changes = [c for r in results for c in r["changes"]]
    return call(host, "revert_timeline_changes", changes=changes)


def ids_of(premiere, name, kind="video"):
    return [c["id"] for k, _i, c in premiere.everything() if c["name"] == name and k == kind]


def test_backup_names_the_copy_and_counts_on(setup):
    host, premiere, _ = setup
    assert call(host, "backup_timeline") == {"backup": "Main (before VibeCut 1)"}
    assert call(host, "backup_timeline") == {"backup": "Main (before VibeCut 2)"}


def test_add_into_free_space_on_enough_tracks_and_revert(setup):
    host, premiere, media = setup
    before = premiere.state()
    result = call(
        host,
        "add_clips",
        clips=[
            {
                "path": media["ROLL"],
                "sourceIn": 1,
                "sourceOut": 2,
                "at": 3,
                "volumeDb": -6,
            },
            {"path": media["B"], "sourceIn": 0, "sourceOut": 1, "at": 3.6},
        ],
    )
    roll, b = result["changes"]
    assert (roll["tracks"], roll["at"], roll["end"]) == (["A1"], 3.0, 4.0)
    # 3.6-4.6 s: V1 is free there, but A1 has ROLL now, so B's stereo sound goes on A2+A3.
    assert b["tracks"] == ["V1", "A2", "A3"]
    assert round(premiere.find(roll["itemIds"][0])["level"], 6) == round(gain(-6), 6)
    revert(host, result)
    assert premiere.state() == before


def test_add_never_overwrites_and_checks_every_clip_first(setup):
    host, premiere, media = setup
    before = premiere.state()
    with pytest.raises(HostError, match="won't overwrite: leave videoTrack out"):
        call(
            host,
            "add_clips",
            clips=[
                {
                    "path": media["B"],
                    "sourceIn": 0,
                    "sourceOut": 2,
                    "at": 4,
                    "videoTrack": 1,
                }
            ],
        )
    with pytest.raises(HostError, match="needs 2 free audio track.*leave audioTrack out"):
        # A track asked for that isn't free isn't swapped for a new one.
        call(
            host,
            "add_clips",
            clips=[
                {
                    "path": media["B"],
                    "sourceIn": 0,
                    "sourceOut": 1,
                    "at": 1,
                    "audioTrack": 1,
                }
            ],
        )
    premiere.qe = False
    with pytest.raises(HostError, match="Premiere couldn't add one"):
        # Two stereo clips at the same place: the second needs new tracks, which Premiere can't add.
        call(
            host,
            "add_clips",
            clips=[
                {"path": media["B"], "sourceIn": 0, "sourceOut": 1, "at": 3},
                {"path": media["A"], "sourceIn": 0, "sourceOut": 1, "at": 3},
            ],
        )
    with pytest.raises(HostError, match="must name a project clip"):
        call(
            host,
            "add_clips",
            clips=[{"itemId": "../x", "path": media["B"], "sourceOut": 1, "at": 3}],
        )
    assert premiere.state() == before and "place_clip" not in premiere.calls


def test_picture_only_removes_the_sound_it_had_to_place(setup):
    host, premiere, media = setup
    result = call(
        host,
        "add_clips",
        clips=[
            {
                "path": media["B"],
                "sourceIn": 0,
                "sourceOut": 1,
                "at": 3.6,
                "videoTrack": 2,
                "sound": False,
            }
        ],
    )
    assert result["changes"][0]["tracks"] == ["V2"]
    assert [k for k, _i, c in premiere.everything() if c["startTicks"] == str(90 * TB_25)] == ["video"]


def test_delete_with_linked_then_revert_puts_the_group_back_linked(setup):
    host, premiere, _ = setup
    call(
        host,
        "set_clip_levels",
        levels=[{"itemId": ids_of(premiere, "B.mov")[0], "volumeDb": -10}],
    )
    call(host, "set_clips_enabled", itemIds=ids_of(premiere, "B.mov"), enabled=False)
    before = premiere.state()
    result = call(host, "delete_clips", itemIds=ids_of(premiere, "B.mov"))
    assert len(result["changes"]) == 3 and not ids_of(premiere, "B.mov")
    reverted = revert(host, result)
    assert premiere.state() == before, "back in place, linked, switched off, at -10 dB"
    assert reverted["lost"] == ["B.mov"] and set(reverted["restoredIds"]) == {
        c["itemId"] for c in result["changes"]
    }


def test_a_lifted_right_channel_comes_back_as_the_right_channel(setup):
    host, premiere, _ = setup
    right = next(c for k, i, c in premiere.everything() if k == "audio" and i == 1 and c["name"] == "A.mov")
    before = premiere.state()
    result = call(host, "delete_clips", itemIds=[right["id"]], withLinked=False)
    assert result["changes"][0]["channel"] == 2
    # A1 still has the left channel: the placement is made past the end, its left channel and picture
    # removed, and the right channel moved back onto A2, linked to the picture and left channel again.
    revert(host, result)
    assert premiere.state() == before
    # Both channels lifted separately, under a picture that stayed, go back together.
    right = next(c for k, i, c in premiere.everything() if k == "audio" and i == 1 and c["name"] == "A.mov")
    result = call(host, "delete_clips", itemIds=[right["id"]], withLinked=False)
    left = next(c for k, i, c in premiere.everything() if k == "audio" and i == 0 and c["name"] == "A.mov")
    second = call(host, "delete_clips", itemIds=[left["id"]], withLinked=False)
    revert(host, result, second)
    assert premiere.state() == before


def test_levels_and_switches_revert_unless_changed_since(setup):
    host, premiere, _ = setup
    before = premiere.state()
    picture = ids_of(premiere, "A.mov")[0]
    levels = call(host, "set_clip_levels", levels=[{"itemId": picture, "volumeDb": -6}])
    assert [c["after"] for c in levels["changes"]] == [-6.0, -6.0], "a picture's id sets its linked sound"
    switch = call(host, "set_clips_enabled", itemIds=[picture], enabled=False)
    premiere.find(levels["changes"][0]["itemId"])["level"] = gain(-20)  # the user changed one since
    reverted = revert(host, levels, switch)
    assert len(reverted["changedSince"]) == 1 and len(reverted["reverted"]) == 2
    premiere.find(levels["changes"][0]["itemId"])["level"] = gain(0)
    assert premiere.state() == before


@pytest.mark.parametrize(
    ("args", "expect"),
    [
        ({"sourceIn": 2.6}, {"start": 0.6, "end": 3.0, "in": 2.6}),
        ({"sourceOut": 4.0}, {"start": 0.0, "end": 2.0, "in": 2.0}),
        ({"slip": 1.0}, {"start": 0.0, "end": 3.0, "in": 3.0}),
        ({"start": 3.6}, {"start": 3.6, "end": 6.6, "in": 2.0}),
    ],
)
def test_trim_slip_and_move_change_the_group_in_place_and_revert(setup, args, expect):
    host, premiere, _ = setup
    if "start" in args:
        call(host, "delete_clips", itemIds=ids_of(premiere, "B.mov"))
    before = premiere.state()
    picture = ids_of(premiere, "A.mov")[0]
    result = call(host, "reshape_clip", itemId=picture, **args)
    group = [c for _k, _i, c in premiere.everything() if c["name"] == "A.mov"]
    for c in group:
        assert {
            "start": int(c["startTicks"]) / T,
            "end": int(c["endTicks"]) / T,
            "in": int(c["inTicks"]) / T,
        } == expect
    change = result["changes"][0]
    assert len(change["items"]) == 3 and result["renamed"] == {}, "ids stay; effects stay on the clip"
    revert(host, result)
    assert premiere.state() == before


def test_a_sound_slips_alone_with_its_other_channel_and_reverts(setup):
    host, premiere, _ = setup
    before = premiere.state()
    sound = ids_of(premiere, "A.mov", "audio")[0]
    result = call(host, "reshape_clip", itemId=sound, slip=0.2, withLinked=False)
    (change,) = result["changes"]
    assert change["how"] == "slipped" and len(change["items"]) == 2, "both channels, not the picture"
    (picture,) = [c for k, _i, c in premiere.everything() if c["name"] == "A.mov" and k == "video"]
    assert int(picture["inTicks"]) / T == 2.0
    for c in (c for k, _i, c in premiere.everything() if c["name"] == "A.mov" and k == "audio"):
        assert (int(c["startTicks"]) / T, int(c["inTicks"]) / T) == (0.0, 2.2)
    revert(host, result)
    assert premiere.state() == before


def test_a_sound_slipped_alone_is_put_back_if_premiere_drags_its_picture(setup):
    host, premiere, _ = setup
    before = premiere.state()
    premiere.drags_links = True
    sound = ids_of(premiere, "A.mov", "audio")[0]
    with pytest.raises(HostError, match="moved A.mov's linked clips with it, so it was put back"):
        call(host, "reshape_clip", itemId=sound, slip=0.2, withLinked=False)
    premiere.drags_links = False
    assert premiere.state() == before


def test_only_a_slip_leaves_the_picture_behind(setup):
    host, premiere, _ = setup
    sound = ids_of(premiere, "A.mov", "audio")[0]
    with pytest.raises(HostError, match="withLinked false goes with slip only"):
        call(host, "reshape_clip", itemId=sound, sourceIn=2.5, withLinked=False)


def test_reshape_refuses_what_it_cant_do_cleanly(setup):
    host, premiere, _ = setup
    before = premiere.state()
    picture = ids_of(premiere, "A.mov")[0]
    with pytest.raises(HostError, match="isn't free"):
        call(host, "reshape_clip", itemId=picture, start=4)
    with pytest.raises(HostError, match="doesn't reach"):
        call(host, "reshape_clip", itemId=picture, slip=-5)
    premiere.find(picture)["speed"] = 2
    with pytest.raises(HostError, match="speed change"):
        call(host, "reshape_clip", itemId=picture, sourceIn=2.5)
    premiere.find(picture)["speed"] = 1
    assert premiere.state() == before


def test_a_full_request_reverts_newest_first_back_to_the_original(setup):
    host, premiere, media = setup
    original = copy.deepcopy(premiere.state())
    steps = [
        call(
            host,
            "add_clips",
            clips=[{"path": media["ROLL"], "sourceIn": 0, "sourceOut": 1, "at": 3.2}],
        ),
        call(host, "reshape_clip", itemId=ids_of(premiere, "A.mov")[0], sourceOut=4.5),
        call(host, "delete_clips", itemIds=ids_of(premiere, "B.mov")),
        call(host, "set_clips_enabled", itemIds=ids_of(premiere, "A.mov"), enabled=False),
    ]
    reverted = revert(host, *steps)
    assert reverted["changedSince"] == [] and reverted["failed"] == []
    assert premiere.state() == original


# ------------------------------------------------------------------------------- phase 4f


def test_add_from_a_project_item_and_with_new_tracks_then_revert(setup):
    host, premiere, media = setup
    before = premiere.state()
    # B.mov at 1-2 s: V1 and A1+A2 are taken there (A.mov 0-3 s) and V2 is free; its stereo sound
    # uses the free A3 and one new A4.
    result = call(
        host,
        "add_clips",
        clips=[
            {
                "path": media["B"],
                "itemId": "pi-B-mov",
                "sourceIn": 0,
                "sourceOut": 1,
                "at": 1,
                "videoTrack": 2,
            }
        ],
    )
    change = result["changes"][0]
    assert change["tracks"] == ["V2", "A3", "A4"]
    assert change["newTracks"] == [["audio", 4]] and result["addedTracks"] == ["A4"]
    assert len(premiere.audio) == 4
    revert(host, result)
    assert premiere.state() == before
    assert (len(premiere.video), len(premiere.audio)) == (2, 3)


def test_new_tracks_come_first_so_a_bad_clip_changes_nothing(setup):
    host, premiere, media = setup
    with pytest.raises(HostError, match="must end after it starts"):
        call(
            host,
            "add_clips",
            clips=[
                {"path": media["B"], "sourceIn": 0, "sourceOut": 1, "at": 1},
                {"path": media["A"], "sourceIn": 2, "sourceOut": 1, "at": 1},
            ],
        )
    assert "add_tracks" not in premiere.calls and (
        len(premiere.video),
        len(premiere.audio),
    ) == (2, 3)


def test_a_picture_moves_to_another_track_and_back(setup):
    host, premiere, media = setup
    before = premiere.state()
    a_id = ids_of(premiere, "A.mov")[0]
    sound = ids_of(premiere, "A.mov", "audio")
    result = call(host, "reshape_clip", itemId=a_id, start=10, videoTrack=2)
    change = result["changes"][0]
    new_id = result["renamed"][a_id]
    moved = premiere.find(new_id)
    assert (moved["startTicks"], premiere.video[1][0]["id"]) == (str(10 * T), new_id)
    assert not premiere.video[0] or all(c["id"] != a_id for c in premiere.video[0])
    # Its sound moved with it along A1+A2 and is linked to the new picture.
    assert all(premiere.find(i)["startTicks"] == str(10 * T) for i in sound)
    assert sorted(moved["linkedIds"]) == sorted(sound)
    assert change["retracked"]["newTracks"] == [] and result["addedTracks"] == []
    host_changes = [{**change, "items": [{**i, "after": {**i["after"]}} for i in change["items"]]}]
    reverted = call(host, "revert_timeline_changes", changes=host_changes)
    assert reverted["reverted"] == [{"kind": "reshaped", "name": "A.mov"}]
    assert premiere.state() == before


def test_a_move_to_the_next_track_adds_it_and_revert_removes_it(setup):
    host, premiere, media = setup
    b_id = ids_of(premiere, "B.mov")[0]
    result = call(host, "reshape_clip", itemId=b_id, start=5, videoTrack=3)
    assert result["addedTracks"] == ["V3"] and len(premiere.video) == 3
    revert(host, result)
    assert len(premiere.video) == 2 and ids_of(premiere, "B.mov")


def test_a_track_change_is_refused_when_it_would_lose_something(setup):
    host, premiere, media = setup
    before = premiere.state()
    a_id = ids_of(premiere, "A.mov")[0]
    premiere.effects.add(a_id)
    with pytest.raises(HostError, match="would lose"):
        call(host, "reshape_clip", itemId=a_id, start=0, videoTrack=2)
    premiere.effects.clear()
    with pytest.raises(HostError, match="Only a picture clip"):
        call(
            host,
            "reshape_clip",
            itemId=ids_of(premiere, "A.mov", "audio")[0],
            start=0,
            audioTrack=3,
        )
    with pytest.raises(HostError, match="There's no V4"):
        call(host, "reshape_clip", itemId=a_id, start=0, videoTrack=4)
    with pytest.raises(HostError, match="Only a move"):
        call(host, "reshape_clip", itemId=a_id, slip=1, videoTrack=2)
    premiere.qe = False
    with pytest.raises(HostError, match="couldn't add one"):
        call(host, "reshape_clip", itemId=a_id, start=0, videoTrack=3)
    assert premiere.state() == before


# ------------------------------------------------------------------------------- nesting (13f)


def test_nest_lifts_the_range_into_a_nested_sequence_and_reverts_to_the_clips(setup):
    host, premiere, _ = setup
    result = call(host, "nest_clips", start=0, end=3, name="Opening")
    kinds = [c["kind"] for c in result["changes"]]
    assert kinds == ["deleted", "deleted", "deleted", "added"]
    assert result["changes"][-1] | {"itemIds": []} == {
        "kind": "added", "name": "Opening", "itemIds": [], "at": 0.0, "end": 3.0, "tracks": ["V1", "A1"], "newTracks": [], "nested": 3,
    }  # fmt: skip
    assert [c["name"] for _k, _i, c in premiere.everything() if float(c["startTicks"]) < 3 * T] == [
        "Opening",
        "Opening",
    ]
    reverted = revert(host, result)
    assert reverted["failed"] == [] and reverted["changedSince"] == []
    assert sorted(c["name"] for _k, _i, c in premiere.everything() if float(c["startTicks"]) < 3 * T) == [
        "A.mov",
        "A.mov",
        "A.mov",
    ]


def test_nest_refuses_a_clip_across_the_edge_and_an_empty_range(setup):
    host, _premiere, _ = setup
    with pytest.raises(HostError, match="run across the edge"):
        call(host, "nest_clips", start=0, end=2)
    with pytest.raises(HostError, match="nothing between"):
        call(host, "nest_clips", start=3.5, end=4.5)


# ------------------------------------------------------------------------------- captions (13h)


def test_nest_says_what_to_check_when_premiere_answers_with_nothing(setup):
    host, premiere, _ = setup
    premiere.nest_range = lambda a: None
    with pytest.raises(HostError, match="didn't say what it nested"):
        call(host, "nest_clips", start=0, end=3)
