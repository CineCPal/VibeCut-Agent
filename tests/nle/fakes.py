"""Stand-ins for the editors, ported from VibeCut's host-premiere and host-resolve test fakes."""

from __future__ import annotations

import json
import os
import threading
import time
from collections.abc import Callable
from pathlib import Path
from typing import Any, Self

TPS = 254016000000
TB_23976 = 10594584000  # ticks per frame at 23.976
TB_25 = 10160640000


def info(timebase: int = TB_23976, seconds_long: int = 10) -> dict[str, Any]:
    """sequence_info's answer."""
    return {
        "timebase": str(timebase),
        "zeroPoint": "0",
        "endTicks": str(TPS * seconds_long),
        "isActive": True,
    }


class FakeRequests:
    """A ``request(command, args, timeout_s)`` for PremiereHost that records each call."""

    def __init__(self, answers: dict[str, Any]) -> None:
        self.answers = answers
        self.calls: list[tuple[str, dict[str, Any]]] = []

    def __call__(self, command: str, args: dict[str, Any], timeout_s: float) -> Any:
        self.calls.append((command, args))
        answer = self.answers[command]
        return answer(args) if callable(answer) else answer

    def sent(self, command: str) -> list[dict[str, Any]]:
        return [args for name, args in self.calls if name == command]


class FakePanel:
    """Answers request files the way src-premiere-panel/bridge.js does, in a thread.
    ``handlers[command](args)`` returns a result or raises."""

    def __init__(self, folder: Path, handlers: dict[str, Callable[[dict[str, Any]], Any]]) -> None:
        self.folder = folder
        self.handlers = handlers
        self.seen: list[dict[str, Any]] = []
        self.answering = True
        self.instance = "inst-1"
        self._stop = threading.Event()
        self._thread = threading.Thread(target=self._run, daemon=True)

    def __enter__(self) -> Self:
        (self.folder / "jobs").mkdir(parents=True, exist_ok=True)
        (self.folder / "replies").mkdir(parents=True, exist_ok=True)
        self.beat()
        self._thread.start()
        return self

    def __exit__(self, *_exc: object) -> None:
        self._stop.set()
        self._thread.join(timeout=2)

    def beat(self, at: float | None = None) -> None:
        stamp = {
            "time": time.time() if at is None else at,
            "busy": False,
            "panelVersion": "0.1.0",
            "instance": self.instance,
        }
        alive = self.folder / "alive.json"
        # One temporary name per thread: tests beat from their own thread while the panel's runs.
        tmp = alive.with_name(f"alive.json.{threading.get_ident()}.tmp")
        tmp.write_text(json.dumps(stamp))
        os.replace(tmp, alive)

    def _run(self) -> None:
        while not self._stop.is_set():
            self.beat()
            if self.answering:
                for job in sorted((self.folder / "jobs").glob("*.json")):
                    self._answer(job)
            time.sleep(0.01)

    def _answer(self, job: Path) -> None:
        try:
            request = json.loads(job.read_text())
        except (FileNotFoundError, ValueError):
            return
        job.unlink()
        self.seen.append(request)
        try:
            reply = {
                "id": request["id"],
                "ok": True,
                "result": self.handlers[request["command"]](request["args"]),
            }
        except Exception as exc:  # noqa: BLE001 - any handler failure becomes an error reply
            reply = {"id": request["id"], "ok": False, "error": str(exc)}
        out = self.folder / "replies" / f"{request['id']}.json"
        tmp = out.with_name(out.name + ".tmp")
        tmp.write_text(json.dumps(reply))
        os.replace(tmp, out)


def sequence() -> dict[str, Any]:
    """read_sequence's answer for a 23.976 sequence starting at 01:00:00:00, 10 s long."""
    return {
        "project": "Interview",
        "name": "Main",
        "timebase": str(TB_23976),
        "zeroPoint": str(TB_23976 * 86400),
        "endTicks": str(TPS * 10),
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
                        "endTicks": str(TPS * 3),
                        "inTicks": str(TPS * 2),
                        "outTicks": str(TPS * 5),
                        "disabled": False,
                        "speed": 1,
                        "mediaPath": "/media/A.mov",
                        "linkedIds": ["a1a"],
                    },
                    {
                        "id": "adj",
                        "name": "Adjustment Layer",
                        "startTicks": str(TPS * 4),
                        "endTicks": str(TPS * 5),
                        "inTicks": "0",
                        "outTicks": str(TPS),
                        "adjustment": True,
                    },
                    {
                        "id": "v1b",
                        "name": "B.mov",
                        "startTicks": str(TPS * 5),
                        "endTicks": str(TPS * 6),
                        "inTicks": str(TPS),
                        "outTicks": str(TPS * 2),
                        "speed": 2,
                        "reversed": True,
                        "mediaPath": "/media/B.mov",
                    },
                ],
                "transitions": [
                    {"name": "Cross Dissolve", "startTicks": str(TPS * 2), "endTicks": str(TPS * 3)}
                ],
            },
            {"name": "Video 2", "muted": True, "clips": [], "transitions": []},
        ],
        "audio": [
            {
                "name": f"Audio {n}",
                "muted": False,
                "clips": [
                    {
                        "id": f"a{n}a",
                        "name": "A.mov",
                        "startTicks": "0",
                        "endTicks": str(TPS * 3),
                        "inTicks": str(TPS * 2),
                        "outTicks": str(TPS * 5),
                        "mediaPath": "/media/A.mov",
                        "level": 10 ** (-15 / 20) / 2,
                    }
                ],
                "transitions": [],
            }
            for n in (1, 2)
        ],
        "markers": [
            {
                "id": "m2",
                "name": "B",
                "comments": "",
                "startTicks": str(TPS * 4),
                "endTicks": str(TPS * 4),
                "colorIndex": 1,
            },
            {
                "id": "m1",
                "name": "A",
                "comments": "note",
                "startTicks": str(TPS),
                "endTicks": str(TPS * 2),
                "colorIndex": 99,
            },
        ],
    }


START = 86400  # 01:00:00:00 at 24 fps


class FakeMedia:
    def __init__(self, path: str) -> None:
        self.path = path

    def GetClipProperty(self, key: str) -> str | None:
        return self.path if key == "File Path" else None


class FakeItem:
    def __init__(
        self,
        uid: str,
        name: str,
        start: int,
        end: int,
        left: int | None = 0,
        path: str | None = "/m/a.mov",
        volume: float | None = None,
    ) -> None:
        self.uid, self.name, self.start, self.end, self.left = uid, name, start, end, left
        self.media = FakeMedia(path) if path else None
        self.volume = volume
        self.linked: list[FakeItem] = []
        self.speed = 1.0
        self.fades: dict[str, float] = {}

    def GetSpeed(self) -> dict[str, float]:
        return {"Percentage": self.speed * 100}

    def GetFusionCompCount(self) -> int:
        return 0

    def GetUniqueId(self) -> str:
        return self.uid

    def GetName(self) -> str:
        return self.name

    def GetStart(self) -> float:
        return float(self.start)

    def GetEnd(self) -> float:
        return float(self.end)

    def GetLeftOffset(self) -> float | None:
        return None if self.left is None else float(self.left)

    def GetClipEnabled(self) -> bool:
        return True

    def GetMediaPoolItem(self) -> FakeMedia | None:
        return self.media

    def GetProperty(self) -> dict[str, float]:
        return {} if self.volume is None else {"AudioVolume": self.volume}

    def GetLinkedItems(self) -> list[FakeItem]:
        return self.linked

    def GetFades(self) -> dict[str, float]:
        return self.fades


class FakeTimeline:
    def __init__(self, name: str, fps: str = "24") -> None:
        self.name, self.fps = name, fps
        self.tracks: dict[str, list[list[FakeItem]]] = {"video": [[]], "audio": [[]], "subtitle": []}
        self.markers: dict[int, dict[str, Any]] = {}
        self.is_open = True
        self.timecode = "01:00:00:00"

    def GetName(self) -> str:
        return self.name

    def GetSetting(self, key: str) -> str:
        return self.fps if key == "timelineFrameRate" else ""

    def GetStartFrame(self) -> int:
        return START

    def GetEndFrame(self) -> int:
        return START + 2400

    def GetStartTimecode(self) -> str:
        return "01:00:00:00"

    def GetTrackCount(self, kind: str) -> int:
        return len(self.tracks[kind])

    def GetItemListInTrack(self, kind: str, index: int) -> list[FakeItem]:
        return self.tracks[kind][index - 1]

    def GetTrackName(self, kind: str, index: int) -> str:
        return f"{kind[0].upper()}{index}"

    def GetIsTrackEnabled(self, _kind: str, _index: int) -> bool:
        return self.is_open

    def GetIsTrackLocked(self, _kind: str, _index: int) -> bool:
        return False

    def GetMarkers(self) -> dict[int, dict[str, Any]]:
        return dict(self.markers)

    def AddMarker(
        self, frame: int, color: str, name: str, note: str, duration: int, custom: str = ""
    ) -> bool:
        # Resolve 21.1 refuses an unnamed marker, and one on a frame that already has one.
        if not name or frame in self.markers:
            return False
        self.markers[frame] = {
            "color": color,
            "name": name,
            "note": note,
            "duration": duration,
            "customData": custom,
        }
        return True

    def DeleteMarkerAtFrame(self, frame: int) -> bool:
        return self.markers.pop(frame, None) is not None

    def GetCurrentTimecode(self) -> str:
        return self.timecode

    def SetCurrentTimecode(self, timecode: str) -> bool:
        self.timecode = timecode
        return True


class FakeProject:
    def __init__(self, name: str, timelines: list[FakeTimeline]) -> None:
        self.name = name
        self.timelines = timelines
        self.current: FakeTimeline | None = timelines[0] if timelines else None

    def GetName(self) -> str:
        return self.name

    def GetTimelineCount(self) -> int:
        return len(self.timelines)

    def GetTimelineByIndex(self, i: int) -> FakeTimeline:
        return self.timelines[i - 1]

    def GetCurrentTimeline(self) -> FakeTimeline | None:
        return self.current

    def SetCurrentTimeline(self, timeline: FakeTimeline) -> bool:
        self.current = timeline
        return True


class FakeResolve:
    def __init__(self, project: FakeProject | None) -> None:
        self.project = project
        self.quit = False

    def GetProjectManager(self) -> Any:
        # A connection to a Resolve that has quit answers None.
        return None if self.quit else self

    def GetCurrentProject(self) -> FakeProject | None:
        return self.project

    def GetProductName(self) -> str | None:
        return None if self.quit else "DaVinci Resolve Studio"

    def GetVersionString(self) -> str:
        return "21.1.0.17"
