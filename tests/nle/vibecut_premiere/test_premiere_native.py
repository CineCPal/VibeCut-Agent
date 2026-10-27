"""Phase 12a: send_to_premiere built inside Premiere (premiere_native.py), against a fake panel that keeps
a real sequence: it clones, lifts and places clips (a stereo file's sound fills two audio tracks), the
way Premiere 26.5.2 did, and never moves one."""

from __future__ import annotations

import copy
from typing import Any

import pytest

from tests.nle.vibecut_premiere.premiere_fakes import TB_25
from vibecut_agent.nle import premiere_native, premiere_rebuild
from vibecut_agent.nle.premiere import HostError, PremiereHost
from vibecut_agent.nle.premiere_edit import Sequence

TPS = 254016000000
ZERO_DB = 10 ** (-15 / 20)


def t(sec: float) -> str:
    return str(round(sec * TPS))


def clip(
    cid: str, name: str, start: float, end: float, source_in: float, item: str, level: float | None = None
) -> dict[str, Any]:
    return {
        "id": cid,
        "name": name,
        "startTicks": t(start),
        "endTicks": t(end),
        "inTicks": t(source_in),
        "outTicks": t(source_in + end - start),
        "disabled": False,
        "speed": 1,
        "mediaPath": f"/m/{name}",
        "projectItemId": item,
        "linkedIds": [],
        "level": level,
    }


def interview() -> dict[str, Any]:
    """10 s at 25 fps: A.mov (0–4 s, from 10 s in) then B.mov (4–10 s), each with stereo sound on A1+A2."""
    return {
        "project": "P",
        "name": "Interview",
        "timebase": str(TB_25),
        "zeroPoint": "0",
        "isActive": True,
        "video": [
            {
                "name": "Video 1",
                "clips": [clip("va", "A.mov", 0, 4, 10, "pa"), clip("vb", "B.mov", 4, 10, 0, "pb")],
                "transitions": [{"name": "Cross Dissolve", "startTicks": t(3.5), "endTicks": t(4.5)}],
            }
        ],
        "audio": [
            {
                "name": f"Audio {n}",
                "clips": [
                    clip(f"a{n}a", "A.mov", 0, 4, 10, "pa", ZERO_DB),
                    clip(f"a{n}b", "B.mov", 4, 10, 0, "pb", ZERO_DB),
                ],
                "transitions": [],
            }
            for n in (1, 2)
        ],
        "markers": [
            {"id": "m1", "name": "Old", "comments": "", "startTicks": "0", "endTicks": "0", "colorIndex": 0}
        ],
    }


def has_picture(path: str) -> bool:
    return not path.endswith(".wav")


def channels(path: str) -> int:
    """A .wav is a mono mic; every other file has picture and stereo sound."""
    return 1 if path.endswith(".wav") else 2


class FakeProbe:
    def video(self, path):
        return {"width": 1920, "height": 1080} if has_picture(path) else None

    def audio(self, path):
        return {"channels": channels(path)}


@pytest.fixture(autouse=True)
def fake_probe(monkeypatch):
    monkeypatch.setattr(premiere_native, "Probe", FakeProbe)


class FakePremiere:
    """The panel's commands over sequences kept here. place_clip overwrites like overwriteClip: the file's
    picture on its video track and its channels on the audio track and the ones after, where a track of
    -1 is the first one (as Premiere 26.5.2 did live)."""

    def __init__(self, base: dict[str, Any]) -> None:
        self.sequences = {base["name"]: base}
        self.calls: list[tuple[str, dict[str, Any]]] = []
        self.next_id = 0
        self.drop: set[str] = set()
        self.sound_early = 0.0  # seconds a .wav lands earlier in its file than asked (0 clamps), as live

    def __call__(self, command: str, args: dict[str, Any], timeout_s: float) -> Any:
        self.calls.append((command, copy.deepcopy(args)))
        return getattr(self, command)(args)

    def sent(self, command: str) -> list[dict[str, Any]]:
        return [a for c, a in self.calls if c == command]

    def _new_id(self) -> str:
        self.next_id += 1
        return f"n{self.next_id}"

    def _clips(self, name: str) -> list[tuple[str, int, dict[str, Any]]]:
        seq = self.sequences[name]
        return [
            (kind, i, c) for kind in ("video", "audio") for i, tr in enumerate(seq[kind]) for c in tr["clips"]
        ]

    def status(self, a):
        return {"sequences": list(self.sequences), "activeSequence": None}

    def read_sequence(self, a):
        seq = copy.deepcopy(self.sequences[a["timeline"]])
        seq["endTicks"] = str(
            max((int(c["endTicks"]) for _k, _i, c in self._clips(a["timeline"])), default=0)
        )
        return seq

    def sequence_info(self, a):
        seq = self.read_sequence(a)
        return {"timebase": seq["timebase"], "zeroPoint": "0", "endTicks": seq["endTicks"], "isActive": True}

    def clone_sequence(self, a):
        copied = copy.deepcopy(self.sequences[a["timeline"]])
        for kind in ("video", "audio"):
            for tr in copied[kind]:
                for c in tr["clips"]:
                    c["id"] = self._new_id()
        copied["name"] = a["name"]
        self.sequences[a["name"]] = copied
        return {"name": a["name"]}

    def remove_transitions(self, a):
        for kind in ("video", "audio"):
            for tr in self.sequences[a["timeline"]][kind]:
                tr["transitions"] = []
        return {"removed": 1}

    def remove_items(self, a):
        gone = set(a["ids"])
        for kind in ("video", "audio"):
            for tr in self.sequences[a["timeline"]][kind]:
                tr["clips"] = [c for c in tr["clips"] if c["id"] not in gone]
        return {"removed": a["ids"], "notFound": []}

    def place_clip(self, a):
        seq = self.sequences[a["timeline"]]
        if a["path"] in self.drop:
            return {"placed": []}
        start = int(a["atTicks"])
        src_in, src_out = a["inSeconds"], a["outSeconds"]
        if not has_picture(a["path"]):
            src_in, src_out = max(0.0, src_in - self.sound_early), src_out - self.sound_early
        length = round((src_out - src_in) * TPS)
        name = a["path"].rsplit("/", 1)[-1]
        first_audio = max(0, a["audioTrack"])
        spots = ([("video", max(0, a["videoTrack"]))] if has_picture(a["path"]) else []) + [
            ("audio", first_audio + c) for c in range(channels(a["path"]))
        ]
        placed = []
        for kind, index in spots:
            while len(seq[kind]) <= index:
                seq[kind].append({"name": "", "clips": [], "transitions": []})
            track = seq[kind][index]
            # overwriteClip: what was there in that range goes.
            track["clips"] = [
                c
                for c in track["clips"]
                if int(c["endTicks"]) <= start or int(c["startTicks"]) >= start + length
            ]
            new = clip(
                self._new_id(),
                name,
                0,
                0,
                0,
                a.get("itemId") or "imported",
                ZERO_DB if kind == "audio" else None,
            )
            new.update(
                startTicks=str(start),
                endTicks=str(start + length),
                inTicks=t(src_in),
                outTicks=t(src_out),
            )
            track["clips"].append(new)
            placed.append({"id": new["id"], "type": kind, "track": index})
        return {"placed": placed}

    def set_items(self, a):
        for item in a["items"]:
            c = next(x[2] for x in self._clips(a["timeline"]) if x[2]["id"] == item["id"])
            if "disabled" in item:
                c["disabled"] = item["disabled"]
            if "level" in item:
                c["level"] = item["level"]
        return {"items": []}

    def add_tracks(self, a):
        seq = self.sequences[a["timeline"]]
        for kind in ("video", "audio"):
            for _ in range(a[kind]):
                seq[kind].append({"name": "", "clips": [], "transitions": []})
        return {}

    def remove_tracks(self, a):
        seq = self.sequences[a["timeline"]]
        for kind in ("video", "audio"):
            for index in sorted(a.get(kind) or [], reverse=True):
                if index == len(seq[kind]) - 1 and not seq[kind][index]["clips"]:
                    seq[kind].pop()
        return {}

    def open_sequence(self, a):
        return {"name": a["timeline"]}

    def delete_sequence(self, a):
        del self.sequences[a["timeline"]]
        return {"deleted": True}

    def remove_markers(self, a):
        self.sequences[a["timeline"]]["markers"] = []
        return {"removed": [], "notFound": []}

    def add_markers(self, a):
        added = []
        for m in a["markers"]:
            marker = {
                "id": self._new_id(),
                "name": m["name"],
                "comments": m["comments"],
                "startTicks": m["ticks"],
                "endTicks": m["ticks"],
                "colorIndex": m["colorIndex"],
            }
            self.sequences[a["timeline"]]["markers"].append(marker)
            added.append(marker)
        return {"added": added}

    def import_sequence(self, a):
        raise AssertionError("the native rebuild must not import a sequence")


def piece(
    origin: str | None, path: str, start: float, end: float, source_in: float, **extra: Any
) -> dict[str, Any]:
    out = {
        "sourcePath": path,
        "start": start,
        "end": end,
        "sourceIn": source_in,
        "sourceOut": source_in + end - start,
        "speed": 1,
        "enabled": True,
        "volumeDb": None,
        **extra,
    }
    if origin:
        out["originId"] = origin
    return out


@pytest.fixture
def files(tmp_path):
    for name in ("A.mov", "B.mov", "C.mov"):
        (tmp_path / name).write_bytes(b"x")
    return tmp_path


def request(files, layout: dict[str, Any], markers: list | None = None) -> dict[str, Any]:
    """A rebuild request whose XML tracks name real files (validate_tracks checks them first)."""
    tracks = [
        {
            "type": "video",
            "clips": [
                {
                    "sourcePath": str(files / "A.mov"),
                    "startTimeSeconds": 0,
                    "sourceInSeconds": 0,
                    "sourceOutSeconds": 1,
                }
            ],
        }
    ]
    return {"timeline": "Interview", "tracks": tracks, "layout": layout, "markers": markers or []}


def resequenced() -> dict[str, Any]:
    """rearrange_sections [6, 10], [0, 2], [4, 6]: B's last 4 s, A's first 2 s, then B's first 2 s."""

    def track(a_id: str, b_id: str) -> list[dict[str, Any]]:
        return [
            piece(b_id, "/m/B.mov", 0, 4, 2),
            piece(a_id, "/m/A.mov", 4, 6, 10),
            piece(b_id, "/m/B.mov", 6, 8, 0),
        ]

    return {"video": [track("va", "vb")], "audio": [track("a1a", "a1b"), track("a2a", "a2b")]}


def laid_out(fake: FakePremiere, name: str) -> list[tuple[Any, ...]]:
    out = [
        (
            kind,
            i + 1,
            c["name"],
            int(c["startTicks"]) / TPS,
            int(c["endTicks"]) / TPS,
            int(c["inTicks"]) / TPS,
            c["projectItemId"],
        )
        for kind, i, c in fake._clips(name)
    ]
    return sorted(out, key=lambda x: (x[0], x[1], x[3]))


def test_resequence_places_the_projects_own_clips_in_a_copy_and_imports_nothing(files):
    fake = FakePremiere(interview())
    original = copy.deepcopy(fake.sequences["Interview"])
    result = premiere_rebuild.rebuild(
        PremiereHost(fake),
        request(files, resequenced(), [{"time": 4, "name": "A here", "color": "Red"}]),
        files / "imports",
    )
    assert result["native"] is True
    assert (result["timeline"], result["clips"], result["markersAdded"]) == ("Interview (VibeCut 1)", 9, 1)
    assert not fake.sent("import_sequence") and not fake.sent("move_items")
    assert fake.sequences["Interview"] == original
    pieces = (("B.mov", 0, 4, 2, "pb"), ("A.mov", 4, 6, 10, "pa"), ("B.mov", 6, 8, 0, "pb"))
    assert laid_out(fake, "Interview (VibeCut 1)") == [("audio", n, *p) for n in (1, 2) for p in pieces] + [
        ("video", 1, *p) for p in pieces
    ]
    # One placement per picture-and-sound, each from its project item.
    assert [(p["itemId"], p["videoTrack"], p["audioTrack"]) for p in fake.sent("place_clip")] == [
        ("pb", 0, 0),
        ("pa", 0, 0),
        ("pb", 0, 0),
    ]
    new = fake.sequences["Interview (VibeCut 1)"]
    assert [m["name"] for m in new["markers"]] == ["A here"]
    assert new["video"][0]["transitions"] == []


def test_a_picture_without_its_sound_on_a_new_track(files):
    fake = FakePremiere(interview())
    layout = {"video": [[piece("va", "/m/A.mov", 0, 4, 10)], [piece(None, "/m/C.mov", 1, 3, 5)]], "audio": []}
    result = premiere_rebuild.rebuild(PremiereHost(fake), request(files, layout), files / "imports")
    assert result["clips"] == 2
    assert fake.sent("add_tracks") == [{"timeline": "Interview (VibeCut 1)", "video": 1, "audio": 0}]
    assert [x[:4] for x in laid_out(fake, "Interview (VibeCut 1)")] == [
        ("video", 1, "A.mov", 0),
        ("video", 2, "C.mov", 1),
    ]
    # C.mov has no clip in the original, so the panel finds (or imports) its file by path.
    assert "itemId" not in fake.sent("place_clip")[1]


def test_sound_the_draft_doesnt_have_is_lifted_again(files):
    fake = FakePremiere(interview())
    # A picture whose stereo sound is wanted on A1 only.
    layout = {"video": [[piece("va", "/m/A.mov", 0, 4, 10)]], "audio": [[piece("a1a", "/m/A.mov", 0, 4, 10)]]}
    premiere_rebuild.rebuild(PremiereHost(fake), request(files, layout), files / "imports")
    assert [x[:3] for x in laid_out(fake, "Interview (VibeCut 1)")] == [
        ("audio", 1, "A.mov"),
        ("video", 1, "A.mov"),
    ]


def test_a_piece_premiere_didnt_place_deletes_the_copy(files):
    fake = FakePremiere(interview())
    fake.drop = {"/m/A.mov"}
    with pytest.raises(HostError, match=r"didn't place A.mov at 4.0 s"):
        premiere_rebuild.rebuild(PremiereHost(fake), request(files, resequenced()), files / "imports")
    assert list(fake.sequences) == ["Interview"]
    assert fake.sent("delete_sequence") == [{"timeline": "Interview (VibeCut 1)"}]


def test_level_and_off_follow_the_draft(files):
    fake = FakePremiere(interview())
    layout = {
        "video": [[piece("va", "/m/A.mov", 0, 4, 10, enabled=False)]],
        "audio": [
            [piece("a1a", "/m/A.mov", 0, 4, 10, volumeDb=-6.0)],
            [piece("a2a", "/m/A.mov", 0, 4, 10, volumeDb=-6.0)],
        ],
    }
    premiere_rebuild.rebuild(PremiereHost(fake), request(files, layout), files / "imports")
    by_kind = {kind: c for kind, _i, c in fake._clips("Interview (VibeCut 1)")}
    assert by_kind["video"]["disabled"] is True
    assert abs(by_kind["audio"]["level"] - 10 ** ((-6 - 15) / 20)) < 1e-9


def test_plan_leaves_ramps_and_speeds_to_xml():
    seq = Sequence(interview())
    ramp = {"video": [[piece("va", "/m/A.mov", 0, 4, 10, ramp=True)]]}
    faster = {"video": [[piece(None, "/m/C.mov", 0, 2, 0, speed=2)]]}
    assert premiere_native.plan(seq, premiere_native.layout_clips(ramp)) is None
    assert premiere_native.plan(seq, premiere_native.layout_clips(faster)) is None


@pytest.mark.parametrize("early", [0.0, 0.04])
def test_picture_only_angles_leave_the_mics_under_them_whole(files, early):
    # Seen live (2026-10-26): a multicam cut by speaker, its angles picture-only over a mic on A1. Each
    # angle's own sound was laid on A1 (overwriteClip's -1) and lifted, cutting the mic to the first shot.
    # And Premiere laid the mic (a WAV, from 0) a frame short, so it's placed again.
    fake = FakePremiere(interview())
    fake.sound_early = early
    layout = {
        "video": [
            [piece("va", "/m/A.mov", 0, 4, 10), piece("va", "/m/A.mov", 4, 8, 14, enabled=False)],
            [piece("vb", "/m/B.mov", 0, 4, 0, enabled=False), piece("vb", "/m/B.mov", 4, 8, 4)],
        ],
        "audio": [[piece(None, "/m/M.wav", 0, 8, 0)]],
    }
    result = premiere_rebuild.rebuild(PremiereHost(fake), request(files, layout), files / "imports")
    assert result["clips"] == 5
    assert laid_out(fake, "Interview (VibeCut 1)")[0][:6] == ("audio", 1, "M.wav", 0, 8, 0)
    assert [x[:5] for x in laid_out(fake, "Interview (VibeCut 1)")] == [
        ("audio", 1, "M.wav", 0, 8),
        ("video", 1, "A.mov", 0, 4),
        ("video", 1, "A.mov", 4, 8),
        ("video", 2, "B.mov", 0, 4),
        ("video", 2, "B.mov", 4, 8),
    ]
    # The angles' stereo sound went on scratch tracks past the draft's A1 (A2, and A3 added for it) ...
    assert len([p for p in fake.sent("place_clip") if p["path"] == "/m/M.wav"]) == (2 if early else 1)
    pictures = [p for p in fake.sent("place_clip") if p["path"] != "/m/M.wav"]
    assert {p["audioTrack"] for p in pictures} == {1}
    # ... and the track added for it is gone again, leaving the copy's own two.
    assert fake.sent("remove_tracks") == [{"timeline": "Interview (VibeCut 1)", "video": [], "audio": [2]}]
    assert len(fake.sequences["Interview (VibeCut 1)"]["audio"]) == 2
