"""The project's sequences, selection and imports (premiere_project.py) against fakes.py's project, with
the sequence commands answering as 26.5.2 did in the 8c.0 probe: names that are taken are accepted by
Premiere (so VibeCut makes them unique), and a single project item can't be removed."""

import pytest

from tests.nle.compat import run_command
from tests.nle.vibecut_premiere.premiere_fakes import FakeProject
from vibecut_agent.nle import premiere_project
from vibecut_agent.nle.premiere import HostError, PremiereHost

TB_25 = 254016000000 // 25


class SequenceProject(FakeProject):
    def __init__(self):
        super().__init__()
        self.sequences = ["Interview", "Interview (before VibeCut 1)"]
        self.active = "Interview"
        self.timebases: dict[str, int] = {}
        self.selection: list[str] = []
        self.view: list[str] = []

    def status(self, _a):
        return {"sequences": list(self.sequences), "activeSequence": self.active}

    def sequence_info(self, a):
        if a["timeline"] not in self.sequences:
            raise HostError(f"There's no sequence called {a['timeline']!r} in this project")
        return {
            "timebase": str(self.timebases.get(a["timeline"], TB_25)),
            "zeroPoint": "0",
            "endTicks": "0",
            "isActive": True,
        }

    def create_sequence(self, a):
        self.sequences.append(a["name"])
        self.active = a["name"]
        return {"name": a["name"], "timebase": str(TB_25)}

    def duplicate_sequence(self, a):
        assert a["timeline"] in self.sequences
        self.sequences.append(a["name"])
        self.active = a["name"]
        return {"name": a["name"]}

    def open_sequence(self, a):
        self.active = a["timeline"]
        return {"name": a["timeline"], "isActive": True}

    def rename_sequence(self, a):
        self.sequences[self.sequences.index(a["timeline"])] = a["name"]
        return {"name": a["name"]}

    def select_items(self, a):
        self.selection = (self.selection if a["additive"] else []) + a["ids"]
        return {"selected": list(self.selection)}

    def select_project_items(self, a):
        # select() replaces the Project panel's selection, so only the last one stays.
        self.view = a["ids"][-1:]
        return {"selected": list(self.view)}

    def import_files(self, a):
        bin_path = self.bins[a["binId"]][len(self.root) + 1 :]
        out = []
        for path in a["paths"]:
            item_id = self.clip(path.rsplit("/", 1)[-1], bin_path, mediaPath=path)
            out.append({"path": path, "id": item_id})
        return {"items": out}


@pytest.fixture
def project(tmp_path, monkeypatch):
    preset = tmp_path / "HD 1080p 25 fps.sqpreset"
    preset.write_text("x")
    monkeypatch.setenv("VIBECUT_PREMIERE_PRESETS", str(preset))
    p = SequenceProject()
    p.clip("A.mov", "Footage", id="a")
    return p


def call(project, command, **args):
    return run_command(PremiereHost(project), command, args)


def test_create_and_duplicate_make_unique_names_and_open_them(project, tmp_path):
    made = call(project, "create_timeline", timeline="Interview", name="Cutdown")
    assert made == {"timeline": "Cutdown", "fps": 25.0}
    assert project.sent("create_sequence")[0]["preset"] == str(tmp_path / "HD 1080p 25 fps.sqpreset")
    assert call(project, "create_timeline", name="Cutdown")["timeline"] == "Cutdown 2"
    assert call(project, "duplicate_timeline", timeline="Interview") == {"timeline": "Interview Copy"}
    assert project.active == "Interview Copy"
    assert call(project, "open_timeline", timeline="Interview") == {"timeline": "Interview"}


def test_a_new_sequence_doesnt_need_the_connected_one_to_still_exist(project, monkeypatch):
    """Live, 2026-10-06: "Sequence 03" was deleted after the agent connected, and every create_timeline
    failed on its frame rate. Now the rate comes from the sequence open in Premiere, else any other."""
    rates: list[float] = []
    real = premiere_project.preset_for
    monkeypatch.setattr(premiere_project, "preset_for", lambda fps: (rates.append(round(fps, 3)), real(fps))[1])
    project.timebases["Interview"] = 254016000000 * 1001 // 30000
    made = call(project, "create_timeline", timeline="Sequence 03", name="Campus Video")
    assert made["timeline"] == "Campus Video"
    assert rates == [29.97], "the open sequence's rate, since the connected one is gone"
    project.sequences = []
    project.active = None
    assert call(project, "create_timeline", timeline="Gone")["timeline"] == "Sequence (VibeCut)"
    assert rates[-1] == 25.0, "no sequence to copy: 25 fps"


def test_rename_refuses_a_taken_name(project):
    assert call(project, "rename_timeline", timeline="Interview", name="Main") == {
        "timeline": "Main",
        "before": "Interview",
    }
    with pytest.raises(HostError, match="already a sequence"):
        call(
            project,
            "rename_timeline",
            timeline="Main",
            name="Interview (before VibeCut 1)",
        )


def test_selection_in_the_sequence_and_the_project(project):
    assert call(project, "select_items", timeline="Interview", itemIds=["x1", "x2"]) == {
        "selected": ["x1", "x2"]
    }
    assert call(project, "select_items", timeline="Interview", itemIds=["x3"], additive=True)["selected"] == [
        "x1",
        "x2",
        "x3",
    ]
    b = project.clip("B.mov", "Footage")
    assert call(project, "select_pool_clips", clipIds=["a", b]) == {
        "selected": [b],
        "notSelected": ["a"],
    }
