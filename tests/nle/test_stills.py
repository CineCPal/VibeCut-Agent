"""Stills of the connected timeline (nle/stills.py, Phase 20d), against the colour tests' fake editors, whose
frames are rendered with their grade: Resolve's ExportCurrentFrameAsStill, Premiere's export_frame."""

import os
import shutil

import pytest

from tests.nle.vibecut_premiere.test_premiere_colour import setup  # noqa: F401
from tests.nle.vibecut_premiere.test_premiere_edit import call as premiere_call
from tests.nle.vibecut_premiere.test_premiere_edit import setup as edit_setup  # noqa: F401
from tests.nle.vibecut_resolve.test_resolve_colour import edit, keep_looks  # noqa: F401
from tests.nle.vibecut_resolve.test_resolve_edit import call as resolve_call
from vibecut_agent.nle.resolve import HostError

pytestmark = pytest.mark.skipif(shutil.which("ffmpeg") is None, reason="needs ffmpeg")


@pytest.fixture(autouse=True)
def renders(tmp_path, monkeypatch):
    monkeypatch.setenv("VIBECUT_RENDERS_DIR", str(tmp_path / "renders"))
    return tmp_path / "renders"


def test_resolve_saves_frames_as_shown_into_the_renders_folder(edit, renders):  # noqa: F811
    host, timeline, _project, c = edit
    before = timeline.timecode
    result = resolve_call(host, "export_stills", times=[2, 12.5], name="Hook")
    folder = str(renders / "Doc")
    assert result["folder"] == folder
    assert [os.path.basename(s["path"]) for s in result["stills"]] == [
        "Interview - Hook 0m02s.png",
        "Interview - Hook 0m12.5s.png",
    ]
    assert all(os.path.getsize(s["path"]) > 0 for s in result["stills"]) and timeline.timecode == before
    # Frames 50 and 312 (at 25 fps) were exported.
    assert c["exports"][-2:] == [50, 312]
    # Never overwritten; without a name, "thumbnail".
    again = resolve_call(host, "export_stills", times=[2])
    assert os.path.basename(again["stills"][0]["path"]) == "Interview thumbnail 0m02s.png"
    third = resolve_call(host, "export_stills", times=[2], name="Hook")
    assert os.path.basename(third["stills"][0]["path"]) == "Interview - Hook 0m02s 2.png"
    with pytest.raises(HostError, match="times must list 1 to 12"):
        resolve_call(host, "export_stills", times=[])


def test_resolve_needs_the_timeline_open(edit):  # noqa: F811
    host, _timeline, project, _c = edit
    project.current = project.timelines[1]
    with pytest.raises(HostError, match="must be the timeline open in Resolve"):
        resolve_call(host, "export_stills", times=[1])


def test_premiere_moves_the_panels_frame_into_the_renders_folder(setup, renders):  # noqa: F811
    host, _premiere, c = setup
    result = premiere_call(host, "export_stills", times=[1.5])
    (still,) = result["stills"]
    assert still["path"] == str(renders / "Premiere project" / "Main thumbnail 0m01.5s.png")
    assert os.path.getsize(still["path"]) > 0
    # Taken out of the bridge's frames/ folder.
    assert list(c["folder"].iterdir()) == []
