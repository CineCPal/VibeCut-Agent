"""VibeCut's host-premiere tests/fakes.py FakeRequests and FakeProject (a Premiere project read through the
panel), for the project and pool tests (PLAN.md, "Phase 6a")."""

from __future__ import annotations

from typing import Any

TB_23976 = 10594584000  # ticks per frame at 23.976
TB_25 = 10160640000


class FakeRequests:
    """A `request(command, args, timeout_s)` for PremiereHost that records each call."""

    def __init__(self, answers: dict[str, Any]) -> None:
        self.answers = answers
        self.calls: list[tuple[str, dict[str, Any]]] = []

    def __call__(self, command: str, args: dict[str, Any], timeout_s: float) -> Any:
        self.calls.append((command, args))
        answer = self.answers[command]
        return answer(args) if callable(answer) else answer

    def sent(self, command: str) -> list[dict[str, Any]]:
        return [args for name, args in self.calls if name == command]


class FakeProject:
    """The panel's project commands over a bin tree, as 26.5.2 was seen to answer them: nodeIds stay
    the same across moves, labels are indexes, columns are short keys ("LogNote") and only set ones
    are listed."""

    def __init__(self, root: str = "Interview") -> None:
        self.root = root
        self.ids = (f"n{i}" for i in range(100, 10_000))
        self.bins: dict[str, str] = {"n1": root}  # id -> path
        self.items: dict[str, dict[str, Any]] = {}
        self.selected: list[str] = []
        self.usage: dict[str, int] = {}
        self.refuse: set[str] = set()  # item ids Premiere won't change
        self.calls: list[tuple[str, dict[str, Any]]] = []

    # -------------------------------------------------------------- setting up

    def bin(self, path: str) -> str:
        for bin_id, p in self.bins.items():
            if p == f"{self.root}/{path}" or (path == "" and p == self.root):
                return bin_id
        parent = self.bin(path.rsplit("/", 1)[0]) if "/" in path else "n1"
        bin_id = next(self.ids)
        self.bins[bin_id] = f"{self.bins[parent]}/{path.rsplit('/', 1)[-1]}"
        return bin_id

    def clip(self, name: str, bin_path: str = "", **extra: Any) -> str:
        item_id = extra.pop("id", None) or next(self.ids)
        columns = {
            "Label": "Iris",
            "MediaTimebase": "25.00 fps",
            "MediaDuration": str(254016000000 * 30),
            "VideoInfo": "1920 x 1080 (1.0)",
            "AudioInfo": "48000 Hz - 16-bit - Stereo",
            "Status": "Online",
            "Good": "false",
        }
        columns.update(extra.pop("columns", {}))
        self.items[item_id] = {
            "id": item_id,
            "name": name,
            "binId": self.bin(bin_path),
            "sequence": False,
            "label": 1,
            "mediaPath": f"/media/{name}",
            "offline": False,
            "inSeconds": 0,
            "outSeconds": 30,
            "columns": {k: v for k, v in columns.items() if v != ""},
            **extra,
        }
        return item_id

    def sequence(self, name: str, bin_path: str = "") -> str:
        item_id = next(self.ids)
        self.items[item_id] = {
            "id": item_id,
            "name": name,
            "binId": self.bin(bin_path),
            "sequence": True,
            "label": 5,
        }
        return item_id

    def path_of(self, item_id: str) -> str:
        return self.bins[self.items[item_id]["binId"]]

    def _read(self, item: dict[str, Any]) -> dict[str, Any]:
        out = {k: v for k, v in item.items() if k != "binId"}
        out["bin"] = self.bins[item["binId"]]
        if not item["sequence"]:
            out["columns"] = dict(item["columns"])
        return out

    # -------------------------------------------------------------- the panel

    def __call__(self, command: str, args: dict[str, Any], timeout_s: float) -> Any:
        self.calls.append((command, args))
        return getattr(self, command)(args)

    def sent(self, command: str) -> list[dict[str, Any]]:
        return [args for name, args in self.calls if name == command]

    def read_project(self, a: dict[str, Any]) -> dict[str, Any]:
        bins = sorted(self.bins.items(), key=lambda b: (b[1] != self.root, b[1]))
        return {
            "root": self.root,
            "bins": [
                {
                    "id": bin_id,
                    "path": path,
                    "items": sum(1 for i in self.items.values() if i["binId"] == bin_id),
                }
                for bin_id, path in bins
            ],
            "items": [self._read(i) for i in self.items.values()],
            "truncated": False,
            "usage": {} if a.get("usage") is False else dict(self.usage),
            "selection": {
                "project": list(self.selected),
                "timeline": [],
                "underPlayhead": None,
            },
        }

    def project_item_info(self, a: dict[str, Any]) -> dict[str, Any]:
        if a["id"] not in self.items:
            raise RuntimeError(f"There is no project item {a['id']} any more")
        out = self._read(self.items[a["id"]])
        out["usage"] = self.usage.get(a["id"], 0)
        out["markers"] = [
            {
                "id": "pm1",
                "name": "Laugh",
                "comments": "",
                "startTicks": str(254016000000 * 2),
                "endTicks": str(254016000000 * 2),
                "colorIndex": 1,
            }
        ]
        return out

    def create_bin(self, a: dict[str, Any]) -> dict[str, Any]:
        bin_id = next(self.ids)
        self.bins[bin_id] = f"{self.bins[a['parentId']]}/{a['name']}"
        return {"id": bin_id, "name": a["name"]}

    def move_project_items(self, a: dict[str, Any]) -> dict[str, Any]:
        moved = [i for i in a["ids"] if i not in self.refuse]
        for item_id in moved:
            self.items[item_id]["binId"] = a["binId"]
        return {"moved": moved, "failed": [i for i in a["ids"] if i in self.refuse]}

    def set_project_items(self, a: dict[str, Any]) -> dict[str, Any]:
        out = []
        for want in a["items"]:
            item = self.items[want["id"]]
            if want["id"] not in self.refuse:
                if "name" in want:
                    item["name"] = want["name"]
                if "label" in want:
                    item["label"] = want["label"]
                    from premiere_pool import PREMIERE_LABEL_COLORS

                    item["columns"]["Label"] = PREMIERE_LABEL_COLORS[want["label"]]
                for field in want.get("fields", []):
                    if field["value"] == "":
                        item["columns"].pop(field["key"], None)
                    else:
                        item["columns"][field["key"]] = field["value"]
            out.append(
                {
                    "id": want["id"],
                    "name": item["name"],
                    "label": item["label"],
                    "columns": dict(item["columns"]),
                }
            )
        return {"items": out}

    def delete_bin(self, a: dict[str, Any]) -> dict[str, Any]:
        path = self.bins[a["id"]]
        if any(i["binId"] == a["id"] for i in self.items.values()) or any(
            p.startswith(path + "/") for p in self.bins.values()
        ):
            return {"deleted": False}
        del self.bins[a["id"]]
        return {"deleted": True}


# VibeCut's sequence() and info() fixtures (its fakes.py), for the tests written against them.
def sequence(**overrides: Any) -> dict[str, Any]:
    """read_sequence's answer for a 23.976 sequence starting at 01:00:00:00, 10 s long."""
    raw = {
        "project": "Interview",
        "name": "Main",
        "timebase": str(TB_23976),
        "zeroPoint": str(TB_23976 * 86400),
        "endTicks": str(254016000000 * 10),
        "isActive": True,
        "video": [
            {
                "name": "Video 1",
                "muted": False,
                "clips": [
                    {
                        "id": "v1a",
                        "name": "A.mov",
                        "startTicks": "0",
                        "endTicks": str(254016000000 * 3),
                        "inTicks": str(254016000000 * 2),
                        "outTicks": str(254016000000 * 5),
                        "disabled": False,
                        "speed": 1,
                        "mediaPath": "/media/A.mov",
                        "linkedIds": ["a1a"],
                        "level": None,
                    },
                    {
                        "id": "adj",
                        "name": "Adjustment Layer",
                        "startTicks": str(254016000000 * 4),
                        "endTicks": str(254016000000 * 5),
                        "inTicks": "0",
                        "outTicks": str(254016000000),
                        "adjustment": True,
                    },
                ],
                "transitions": [
                    {
                        "name": "Cross Dissolve",
                        "startTicks": str(254016000000 * 2),
                        "endTicks": str(254016000000 * 3),
                    }
                ],
            },
            {"name": "Video 2", "muted": True, "clips": [], "transitions": []},
        ],
        "audio": [
            {
                "name": "Audio 1",
                "muted": False,
                "clips": [
                    {
                        "id": "a1a",
                        "name": "A.mov",
                        "startTicks": "0",
                        "endTicks": str(254016000000 * 3),
                        "inTicks": str(254016000000 * 2),
                        "outTicks": str(254016000000 * 5),
                        "disabled": True,
                        "speed": 2.0,
                        "mediaPath": "/media/A.mov",
                        "linkedIds": ["v1a"],
                        # -6.02 dB as Premiere stores it.
                        "level": 10 ** ((-6.02 - 15) / 20),
                    }
                ],
                "transitions": [],
            }
        ],
        "markers": [
            {
                "id": "m-2",
                "name": "Later",
                "comments": "",
                "startTicks": str(254016000000 * 5),
                "endTicks": str(254016000000 * 5),
                "colorIndex": 1,
            },
            {
                "id": "m-1",
                "name": "Start",
                "comments": "first",
                "startTicks": "0",
                "endTicks": str(254016000000),
                "colorIndex": 7,
            },
        ],
    }
    raw.update(overrides)
    return raw


def info(timebase: int = TB_23976, seconds_long: int = 10) -> dict[str, Any]:
    return {
        "timebase": str(timebase),
        "zeroPoint": "0",
        "endTicks": str(254016000000 * seconds_long),
        "isActive": True,
    }
