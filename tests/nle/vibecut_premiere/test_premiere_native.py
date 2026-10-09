"""Phase 12a: send_to_premiere built inside Premiere (premiere_native.py), against a fake panel that keeps
a real sequence: it clones, razors, lifts, moves and links clips the way Premiere 26.5.2 was seen to."""

from __future__ import annotations

import copy
from typing import Any

import pytest

from tests.nle.vibecut_premiere.premiere_fakes import TB_25
from vibecut_agent.nle import premiere_native, premiere_rebuild
from vibecut_agent.nle.premiere import HostError, PremiereHost

TPS = 254016000000


def t(sec: float) -> str:
    return str(round(sec * TPS))


def clip(
    cid: str,
    name: str,
    start: float,
    end: float,
    source_in: float,
    linked: list[str],
    level: float | None = None,
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
        "linkedIds": linked,
        "level": level,
    }


def interview() -> dict[str, Any]:
    """A 10 s sequence at 25 fps: A.mov (0–4 s, from 10 s in) then B.mov (4–10 s), each with its sound."""
    zero_db = 10 ** (-15 / 20)
    return {
        "project": "P",
        "name": "Interview",
        "timebase": str(TB_25),
        "zeroPoint": "0",
        "isActive": True,
        "video": [
            {
                "name": "Video 1",
                "clips": [clip("va", "A.mov", 0, 4, 10, ["aa"]), clip("vb", "B.mov", 4, 10, 0, ["ab"])],
                "transitions": [{"name": "Cross Dissolve", "startTicks": t(3.5), "endTicks": t(4.5)}],
            }
        ],
        "audio": [
            {
                "name": "Audio 1",
                "clips": [
                    clip("aa", "A.mov", 0, 4, 10, ["va"], zero_db),
                    clip("ab", "B.mov", 4, 10, 0, ["vb"], zero_db),
                ],
                "transitions": [],
            }
        ],
        "markers": [
            {"id": "m1", "name": "Old", "comments": "", "startTicks": "0", "endTicks": "0", "colorIndex": 0}
        ],
    }


class FakePremiere:
    """The panel's commands over sequences kept here. A move that lands on another clip fails, as it
    would leave Premiere's track overwritten."""

    def __init__(self, base: dict[str, Any]) -> None:
        self.sequences = {base["name"]: base}
        self.calls: list[tuple[str, dict[str, Any]]] = []
        self.next_id = 0
        self.razor_works = True

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

    def _end(self, name: str) -> int:
        return max((int(c["endTicks"]) for _k, _i, c in self._clips(name)), default=0)

    # --- reads
    def status(self, a):
        return {"sequences": list(self.sequences), "activeSequence": None}

    def read_sequence(self, a):
        seq = copy.deepcopy(self.sequences[a["timeline"]])
        for kind in ("video", "audio"):
            for tr in seq[kind]:
                tr["clips"].sort(key=lambda c: int(c["startTicks"]))
        seq["endTicks"] = str(self._end(a["timeline"]))
        return seq

    def sequence_info(self, a):
        seq = self.sequences[a["timeline"]]
        return {
            "timebase": seq["timebase"],
            "zeroPoint": "0",
            "endTicks": str(self._end(a["timeline"])),
            "isActive": True,
        }

    # --- Phase 12a
    def clone_sequence(self, a):
        copied = copy.deepcopy(self.sequences[a["timeline"]])
        ids = {
            c["id"]: self._new_id() for kind in ("video", "audio") for tr in copied[kind] for c in tr["clips"]
        }
        for kind in ("video", "audio"):
            for tr in copied[kind]:
                for c in tr["clips"]:
                    c["id"] = ids[c["id"]]
                    c["linkedIds"] = [ids[i] for i in c["linkedIds"]]
        copied["name"] = a["name"]
        self.sequences[a["name"]] = copied
        return {"name": a["name"]}

    def remove_transitions(self, a):
        for kind in ("video", "audio"):
            for tr in self.sequences[a["timeline"]][kind]:
                tr["transitions"] = []
        return {"removed": 1}

    def razor_cuts(self, a):
        for cut in a["cuts"]:
            hh, mm, ss, ff = (int(x) for x in cut["timecode"].split(":"))
            at = ((hh * 3600 + mm * 60 + ss) * 25 + ff) * TB_25
            track = self.sequences[a["timeline"]][cut["type"]][cut["track"]]
            for c in list(track["clips"]):
                start, end = int(c["startTicks"]), int(c["endTicks"])
                if self.razor_works and start < at < end:
                    right = {
                        **c,
                        "id": self._new_id(),
                        "startTicks": str(at),
                        "inTicks": str(int(c["inTicks"]) + at - start),
                        "linkedIds": [],
                    }
                    c["endTicks"] = str(at)
                    c["outTicks"] = right["inTicks"]
                    track["clips"].append(right)
        return {"cuts": len(a["cuts"])}

    def remove_items(self, a):
        gone = set(a["ids"])
        for _kind, _i, c in self._clips(a["timeline"]):
            c["linkedIds"] = [i for i in c["linkedIds"] if i not in gone]
        for kind in ("video", "audio"):
            for tr in self.sequences[a["timeline"]][kind]:
                tr["clips"] = [c for c in tr["clips"] if c["id"] not in gone]
        return {"removed": a["ids"], "notFound": []}

    def move_items(self, a):
        moves = a.get("moves") or [{"id": i, "offsetTicks": a["offsetTicks"]} for i in a["ids"]]
        for m in moves:
            kind, index, c = next(x for x in self._clips(a["timeline"]) if x[2]["id"] == m["id"])
            delta = int(m["offsetTicks"])
            start, end = int(c["startTicks"]) + delta, int(c["endTicks"]) + delta
            assert start >= 0, "moved before the start"
            for other in self.sequences[a["timeline"]][kind][index]["clips"]:
                if other is not c:
                    assert end <= int(other["startTicks"]) or start >= int(other["endTicks"]), (
                        f"{c['id']} landed on {other['id']}"
                    )
            c["startTicks"], c["endTicks"] = str(start), str(end)
        return {"items": []}

    def set_items(self, a):
        for item in a["items"]:
            c = next(x[2] for x in self._clips(a["timeline"]) if x[2]["id"] == item["id"])
            if "disabled" in item:
                c["disabled"] = item["disabled"]
            if "level" in item:
                c["level"] = item["level"]
        return {"items": []}

    def set_links(self, a):
        for group in a["groups"]:
            for _k, _i, c in self._clips(a["timeline"]):
                if c["id"] in group:
                    c["linkedIds"] = [i for i in group if i != c["id"]]
        return {"groups": len(a["groups"])}

    def add_tracks(self, a):
        seq = self.sequences[a["timeline"]]
        for kind in ("video", "audio"):
            for _ in range(a[kind]):
                seq[kind].append({"name": "", "clips": [], "transitions": []})
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
        raise AssertionError("the native rebuild must not import anything")


def piece(
    origin: str | None,
    path: str,
    start: float,
    end: float,
    source_in: float,
    group: str | None = None,
    **extra: Any,
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
    if group:
        out["linkGroup"] = group
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


def resequenced(files) -> dict[str, Any]:
    """rearrange_sections [6, 10], [0, 2], [4, 6]: B's last 4 s, A's first 2 s, then B's first 2 s."""

    def track(kind_ids: tuple[str, str]) -> list[dict[str, Any]]:
        a_id, b_id = kind_ids
        return [
            piece(b_id, "/m/B.mov", 0, 4, 2, "vb"),
            piece(a_id, "/m/A.mov", 4, 6, 10, "va"),
            piece(b_id, "/m/B.mov", 6, 8, 0, "vb"),
        ]

    return {"video": [track(("va", "vb"))], "audio": [track(("aa", "ab"))]}


def placed(fake: FakePremiere, name: str) -> list[tuple[str, str, float, float, float]]:
    out = []
    for kind, _i, c in fake._clips(name):
        out.append(
            (kind, c["name"], int(c["startTicks"]) / TPS, int(c["endTicks"]) / TPS, int(c["inTicks"]) / TPS)
        )
    return sorted(out, key=lambda x: (x[0], x[2]))


def test_resequence_is_cut_and_moved_in_a_clone_and_imports_nothing(files):
    fake = FakePremiere(interview())
    original = copy.deepcopy(fake.sequences["Interview"])
    result = premiere_rebuild.rebuild(
        PremiereHost(fake),
        request(files, resequenced(files), [{"time": 4, "name": "A here", "color": "Red"}]),
        files / "imports",
    )
    assert result["native"] is True
    assert result["timeline"] == "Interview (VibeCut 1)"
    assert (result["carried"], result["placed"], result["markersAdded"]) == (6, 0, 1)
    assert not fake.sent("import_sequence")
    assert fake.sequences["Interview"] == original
    assert placed(fake, "Interview (VibeCut 1)") == [
        ("audio", "B.mov", 0, 4, 2),
        ("audio", "A.mov", 4, 6, 10),
        ("audio", "B.mov", 6, 8, 0),
        ("video", "B.mov", 0, 4, 2),
        ("video", "A.mov", 4, 6, 10),
        ("video", "B.mov", 6, 8, 0),
    ]
    new = fake.sequences["Interview (VibeCut 1)"]
    by_start = {(kind, int(c["startTicks"])): c for kind, _i, c in fake._clips("Interview (VibeCut 1)")}
    for sec in (0, 4, 6):
        v, a = by_start[("video", round(sec * TPS))], by_start[("audio", round(sec * TPS))]
        assert v["linkedIds"] == [a["id"]] and a["linkedIds"] == [v["id"]]
    assert [m["name"] for m in new["markers"]] == ["A here"]
    assert new["video"][0]["transitions"] == []
    assert "Transitions weren't carried" in result["warnings"][0]
    assert fake.sent("clone_sequence")[0]["bin"] == "VibeCut"


def test_a_clip_from_outside_the_original_is_placed_from_the_project(files, monkeypatch):
    fake = FakePremiere(interview())
    added: list[dict[str, Any]] = []
    monkeypatch.setattr(
        premiere_native, "add_clips", lambda host, args: added.append(args) or {"changes": []}
    )
    layout = {
        "video": [[piece("va", "/m/A.mov", 0, 4, 10, "va")], [piece(None, "/m/C.mov", 1, 3, 5)]],
        "audio": [[piece("aa", "/m/A.mov", 0, 4, 10, "va")]],
    }
    result = premiere_rebuild.rebuild(PremiereHost(fake), request(files, layout), files / "imports")
    assert (result["carried"], result["placed"]) == (2, 1)
    assert fake.sent("add_tracks") == [{"timeline": "Interview (VibeCut 1)", "video": 1, "audio": 0}]
    assert added == [
        {
            "timeline": "Interview (VibeCut 1)",
            "clips": [
                {
                    "path": "/m/C.mov",
                    "sourceIn": 5,
                    "sourceOut": 7,
                    "at": 1,
                    "picture": True,
                    "sound": False,
                    "videoTrack": 2,
                }
            ],
        }
    ]
    # B was in the original but not in the draft, so it's gone from the new sequence.
    assert {c["name"] for _k, _i, c in fake._clips("Interview (VibeCut 1)")} == {"A.mov"}


def test_a_failed_cut_deletes_the_clone(files):
    fake = FakePremiere(interview())
    fake.razor_works = False
    with pytest.raises(HostError, match="didn't cut"):
        premiere_rebuild.rebuild(PremiereHost(fake), request(files, resequenced(files)), files / "imports")
    assert list(fake.sequences) == ["Interview"]
    assert fake.sent("delete_sequence") == [{"timeline": "Interview (VibeCut 1)"}]


def test_level_and_off_follow_the_draft(files):
    fake = FakePremiere(interview())
    layout = {
        "video": [[piece("va", "/m/A.mov", 0, 4, 10, "va", enabled=False)]],
        "audio": [[piece("aa", "/m/A.mov", 0, 4, 10, "va", volumeDb=-6.0)]],
    }
    premiere_rebuild.rebuild(PremiereHost(fake), request(files, layout), files / "imports")
    items = fake.sent("set_items")[0]["items"]
    by_id = {c["id"]: c for _k, _i, c in fake._clips("Interview (VibeCut 1)")}
    video = next(c for c in by_id.values() if c["name"] == "A.mov" and c["level"] is None)
    assert video["disabled"] is True
    assert any(abs(i.get("level", 0) - 10 ** ((-6 - 15) / 20)) < 1e-9 for i in items)


def test_plan_leaves_ramps_and_new_speeds_to_xml():
    from vibecut_agent.nle.premiere_edit import Sequence

    seq = Sequence(interview())
    view = {"va": {"id": "va", "start": 0, "sourceIn": 10}}
    ramp = premiere_native.layout_clips({"video": [[piece("va", "/m/A.mov", 0, 4, 10, ramp=True)]]})
    assert premiere_native.plan(seq, view, ramp) is None
    faster = premiere_native.layout_clips({"video": [[piece(None, "/m/C.mov", 0, 2, 0, speed=2)]]})
    assert premiere_native.plan(seq, view, faster) is None
    reused = premiere_native.layout_clips(
        {"video": [[piece("va", "/m/A.mov", 0, 2, 10), piece("va", "/m/A.mov", 2, 4, 10)]]}
    )
    steps = premiere_native.plan(seq, view, reused)
    assert steps is not None and len(steps["kept"]) == 1 and len(steps["placed"]) == 1
