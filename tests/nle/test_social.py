"""Phase 14d: vertical, square and 4:5 versions (nle/social.py, resolve_project / premiere_project
`make_social_version`), against fakes that answer as Resolve 21.1 did in the 14d probe: a timeline takes
its own frame size once useCustomSettings is "1", "scaleToCrop" fills the frame, and SmartReframe answers
True. Premiere's side is checked against a fake panel (its Auto Reframe was not probed from here)."""

from __future__ import annotations

from typing import Any

import pytest

from tests.nle.compat import run_command
from tests.nle.vibecut_premiere.test_premiere_project import SequenceProject
from tests.nle.vibecut_resolve.resolve_fakes import FakeProject, FakeResolve
from vibecut_agent.nle import premiere
from vibecut_agent.nle.errors import HostError
from vibecut_agent.nle.premiere import PremiereHost
from vibecut_agent.nle.resolve import ResolveHost
from vibecut_agent.nle.social import social_size

MODES = {"scaleToFit", "scaleToCrop", "centerCrop", "stretch"}


@pytest.mark.parametrize(
    ("size", "aspect", "made"),
    [
        ((1920, 1080), "9:16", (1080, 1920)),
        ((3840, 2160), "9:16", (2160, 3840)),
        ((1920, 1080), "1:1", (1080, 1080)),
        ((1920, 1080), "4:5", (1080, 1350)),
        ((1280, 720), "4:5", (720, 900)),
        ((1080, 1920), "1:1", (1080, 1080)),
        ((1001, 563), "9:16", (564, 1000)),
    ],
)
def test_sizes_keep_the_short_side_and_are_even(
    size: tuple[int, int], aspect: str, made: tuple[int, int]
) -> None:
    assert social_size(*size, aspect) == made


class Item:
    def __init__(
        self, name: str, media: bool = True, enabled: bool = True, smart: bool | None = True
    ) -> None:
        self.name, self.media, self.enabled, self.smart = name, media, enabled, smart
        self.reframed = 0
        if smart is not None:
            self.SmartReframe = lambda: self._smart(smart)

    def _smart(self, answer: bool) -> bool:
        self.reframed += 1
        return answer

    def GetName(self) -> str:
        return self.name

    def GetClipEnabled(self) -> bool:
        return self.enabled

    def GetMediaPoolItem(self) -> object | None:
        return object() if self.media else None


class Timeline:
    def __init__(
        self, name: str, project: Project, items: list[Item], width: int = 1920, height: int = 1080
    ) -> None:
        self.name, self.project, self.items = name, project, items
        self.settings = {
            "useCustomSettings": "0",
            "timelineResolutionWidth": str(width),
            "timelineResolutionHeight": str(height),
            "timelineInputResMismatchBehavior": "scaleToFit",
        }
        self.takes_size = True

    def GetName(self) -> str:
        return self.name

    def GetSetting(self, key: str) -> str:
        if key.startswith("timelineResolution") and self.settings["useCustomSettings"] != "1":
            return self.project.settings[key]
        return self.settings.get(key, "")

    def SetSetting(self, key: str, value: str) -> bool:
        if key == "timelineInputResMismatchBehavior" and value not in MODES:
            return False
        if key.startswith("timelineResolution") and not self.takes_size:
            return False
        self.settings[key] = value
        return True

    def GetTrackCount(self, kind: str) -> int:
        return 1 if kind == "video" else 0

    def GetItemListInTrack(self, kind: str, index: int) -> list[Item]:
        return self.items

    def DuplicateTimeline(self, name: str) -> Timeline:
        copy = Timeline(name, self.project, [Item(i.name, i.media, i.enabled, i.smart) for i in self.items])
        copy.settings = dict(self.settings)
        copy.takes_size = self.takes_size
        self.project.timelines.append(copy)
        self.project.current = copy
        return copy


class Project(FakeProject):
    def __init__(self) -> None:
        super().__init__([])
        self.settings = {"timelineResolutionWidth": "1920", "timelineResolutionHeight": "1080"}


def resolve(items: list[Item]) -> tuple[ResolveHost, Project, Timeline]:
    project = Project()
    timeline = Timeline("Promo", project, items)
    project.timelines.append(timeline)
    project.current = timeline
    return ResolveHost(FakeResolve(project)), project, timeline


def test_resolve_makes_a_filled_copy_at_the_new_size_and_smart_reframes_its_clips() -> None:
    host, project, original = resolve(
        [Item("A.mov"), Item("Title", media=False), Item("Off.mov", enabled=False), Item("B.mov")]
    )
    out = run_command(host, "make_social_version", {"timeline": "Promo", "aspect": "9:16"})
    assert out == {
        "timeline": "Promo (9x16)",
        "original": "Promo",
        "width": 1080,
        "height": 1920,
        "from": [1920, 1080],
        "fill": True,
        "reframe": "auto",
        "reframed": 2,
    }
    copy = project.current
    assert copy is not original and copy.GetName() == "Promo (9x16)"
    assert (
        copy.settings["useCustomSettings"] == "1"
        and copy.settings["timelineInputResMismatchBehavior"] == "scaleToCrop"
    )
    assert [i.reframed for i in copy.items] == [1, 0, 0, 1], "titles and switched-off clips are left alone"
    # The original and the project keep their size.
    assert (
        original.GetSetting("timelineResolutionWidth") == "1920"
        and project.settings["timelineResolutionHeight"] == "1080"
    )
    again = run_command(host, "make_social_version", {"timeline": "Promo", "aspect": "9:16"})
    assert again["timeline"] == "Promo (9x16) 2"


def test_resolve_centre_only_and_without_studio() -> None:
    host, project, _ = resolve([Item("A.mov")])
    out = run_command(
        host,
        "make_social_version",
        {"timeline": "Promo", "aspect": "1:1", "reframe": "center", "name": "Square"},
    )
    assert out["timeline"] == "Square" and (out["width"], out["height"]) == (1080, 1080)
    assert "reframed" not in out and project.current.items[0].reframed == 0

    host, project, _ = resolve([Item("A.mov", smart=None), Item("B.mov", smart=None)])
    out = run_command(host, "make_social_version", {"timeline": "Promo", "aspect": "4:5"})
    assert out["reframed"] == 0 and out["notReframed"] == ["A.mov", "B.mov"]
    assert "needs DaVinci Resolve Studio" in out["note"]


def test_resolve_says_when_the_copy_kept_its_size() -> None:
    host, _project, original = resolve([Item("A.mov")])
    original.takes_size = False
    with pytest.raises(HostError, match=r"made the copy 'Promo \(9x16\)' but kept it at 1920x1080"):
        run_command(host, "make_social_version", {"timeline": "Promo", "aspect": "9:16"})
    with pytest.raises(HostError, match="aspect must be one of"):
        run_command(host, "make_social_version", {"timeline": "Promo", "aspect": "21:9"})
    with pytest.raises(HostError, match="reframe must be auto or center"):
        run_command(host, "make_social_version", {"timeline": "Promo", "aspect": "9:16", "reframe": "tight"})


class ReframeProject(SequenceProject):
    def __init__(self) -> None:
        super().__init__()
        self.reframed: list[dict[str, Any]] = []

    def auto_reframe(self, a: dict[str, Any]) -> dict[str, Any]:
        self.reframed.append(a)
        self.sequences.append(a["name"])
        self.active = a["name"]
        return {"name": a["name"], "width": 1080, "height": 1920}


def test_premiere_uses_auto_reframe_sequence_and_refuses_centre() -> None:
    project = ReframeProject()
    out = run_command(
        PremiereHost(project), "make_social_version", {"timeline": "Interview", "aspect": "9:16"}
    )
    assert out == {
        "timeline": "Interview (9x16)",
        "original": "Interview",
        "reframe": "auto",
        "width": 1080,
        "height": 1920,
    }
    assert project.reframed == [
        {
            "timeline": "Interview",
            "name": "Interview (9x16)",
            "numerator": 9,
            "denominator": 16,
            "motion": "default",
        }
    ]
    with pytest.raises(HostError, match="only make a social version with Auto Reframe"):
        run_command(
            PremiereHost(project),
            "make_social_version",
            {"timeline": "Interview", "aspect": "1:1", "reframe": "center"},
        )


def test_both_editors_read_the_frame_size() -> None:
    raw = {
        "name": "S",
        "timebase": str(254016000000 // 25),
        "zeroPoint": "0",
        "endTicks": "0",
        "isActive": True,
        "video": [],
        "audio": [],
        "markers": [],
    }
    assert "width" not in premiere.timeline(raw), "an older panel sends no size"
    sized = premiere.timeline({**raw, "frameWidth": 1080, "frameHeight": 1920})
    assert (sized["width"], sized["height"]) == (1080, 1920)

    from vibecut_agent.nle import resolve as resolve_module

    class Sized:
        def GetSetting(self, key: str) -> str:
            return {"timelineResolutionWidth": "3840", "timelineResolutionHeight": "2160"}.get(key, "")

    assert resolve_module._frame_size(Sized()) == {"width": 3840, "height": 2160}

    class Unsized:
        def GetSetting(self, key: str) -> str:
            return ""

    assert resolve_module._frame_size(Unsized()) == {}
