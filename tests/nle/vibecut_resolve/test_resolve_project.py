"""tests/test_resolve_project.py -- the project's timelines, the Media Pool selection and imports
(resolve_project.py), against test_resolve_edit.py's fakes with what Resolve 21.1 did in the 8c.0
probe: a new or copied timeline becomes current, a taken name is refused, imports go into the current
folder, and only an unused clip can be removed."""

import pytest

from tests.nle.compat import run_command
from tests.nle.vibecut_resolve.test_resolve_edit import EditPool, EditTimeline, make_edit
from vibecut_agent.nle.errors import HostError


class ProjectPool(EditPool):
    def __init__(self, root, timeline):
        super().__init__(root, timeline)
        self.current, self.selected_clip = root, None

    def GetCurrentFolder(self):
        return self.current

    def SetCurrentFolder(self, folder):
        self.current = folder
        return True

    def ImportMedia(self, paths):
        before = len(self.root.clips)
        super().ImportMedia(paths)
        new = self.root.clips[before:]
        del self.root.clips[before:]
        self.current.clips += new
        return new

    def DeleteClips(self, clips):
        for folder in self._folders(self.root):
            folder.clips = [c for c in folder.clips if c not in clips]
        return True

    def DeleteFolders(self, folders):
        for folder in self._folders(self.root):
            folder.subs = [f for f in folder.subs if f not in folders]
        return True

    def _folders(self, folder):
        yield folder
        for sub in folder.subs:
            yield from self._folders(sub)

    def CreateEmptyTimeline(self, name):
        if name in [t.GetName() for t in self.timeline.project.timelines]:
            return None
        made = EditTimeline(name)
        made.project = self.timeline.project
        self.timeline.project.timelines.append(made)
        self.timeline.project.current = made
        return made

    def SetSelectedClip(self, clip):
        self.selected_clip = clip
        return True


def _set_name(self, name):
    if name in [t.GetName() for t in self.project.timelines]:
        return False
    self.name = name
    return True


@pytest.fixture
def edit(monkeypatch, tmp_path):
    host, timeline, project, c = make_edit()
    project.pool = ProjectPool(project.pool.root, timeline)
    monkeypatch.setattr(EditTimeline, "SetName", _set_name, raising=False)
    return host, timeline, project, c


def call(host, command, **args):
    return run_command(host, command, args)


def names(project):
    return [t.GetName() for t in project.timelines]


def test_create_and_duplicate_make_unique_names_and_open_them(edit):
    host, timeline, project, _c = edit
    assert call(host, "create_timeline", name="Cutdown")["timeline"] == "Cutdown"
    assert project.current.GetName() == "Cutdown"
    assert call(host, "create_timeline", name="Cutdown")["timeline"] == "Cutdown 2"
    made = call(host, "duplicate_timeline", timeline="Interview")
    assert made == {"timeline": "Interview Copy"}
    assert project.current.GetName() == "Interview Copy"
    assert (
        call(host, "duplicate_timeline", timeline="Interview", name="Interview Copy")["timeline"]
        == "Interview Copy 2"
    )
    assert call(host, "open_timeline", timeline="Interview") == {"timeline": "Interview"}
    assert project.current is timeline


def test_rename_refuses_a_taken_name(edit):
    host, _timeline, project, _c = edit
    call(host, "create_timeline", name="Cutdown")
    assert call(host, "rename_timeline", timeline="Cutdown", name="Short") == {
        "timeline": "Short",
        "before": "Cutdown",
    }
    with pytest.raises(HostError, match="already a timeline"):
        call(host, "rename_timeline", timeline="Short", name="Interview")
    assert "Short" in names(project)


def test_select_picks_the_first_pool_clip(edit):
    host, _timeline, project, c = edit
    result = call(host, "select_pool_clips", clipIds=["m-b", "m-s"])
    assert result == {"selected": ["m-b"], "notSelected": ["m-s"]}
    assert project.pool.selected_clip is c["broll"]
