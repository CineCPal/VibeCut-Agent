"""The B-roll Library's import_media and source_preview for both editors (nle/media.py)."""

from __future__ import annotations

from pathlib import Path
from typing import Any

import pytest

from vibecut_agent.nle import media
from vibecut_agent.nle.errors import HostError
from vibecut_agent.nle.premiere_bridge import PremiereBridge
from vibecut_agent.nle.watch import PremiereAdapter, ResolveAdapter

# ----------------------------------------------------------------------------------------- Premiere


class Sent:
    """A PremiereHost stand-in: records what goes to the panel and answers from `answers`."""

    def __init__(self, answers: dict[str, Any]) -> None:
        self.answers = answers
        self.sent: list[tuple[str, dict[str, Any]]] = []

    def _send(self, command: str, args: dict[str, Any]) -> Any:
        self.sent.append((command, args))
        return self.answers[command]


@pytest.fixture
def clips(tmp_path: Path) -> list[str]:
    paths = []
    for name in ("a.mov", "b.mov"):
        (tmp_path / name).write_bytes(b"x")
        paths.append(str(tmp_path / name))
    return paths


def test_premiere_import_sends_the_files_once_into_the_broll_bin(clips: list[str]) -> None:
    host = Sent(
        {
            "import_media": {
                "items": [
                    {"path": clips[0], "id": "n1", "imported": True},
                    {"path": clips[1], "id": "n2", "imported": False},
                ]
            }
        }
    )
    result = media.premiere_import_media(host, {"paths": [clips[0], clips[1], clips[0]]})
    assert host.sent == [("import_media", {"paths": clips, "bin": "VibeCut B-roll"})]
    assert result == {
        "bin": "VibeCut B-roll",
        "imported": [{"path": clips[0], "clipId": "n1"}],
        "reused": [{"path": clips[1], "clipId": "n2"}],
    }


@pytest.mark.parametrize(
    ("args", "message"),
    [
        ({"paths": []}, "paths must list media files"),
        ({"paths": ["relative.mov"]}, "isn't reachable"),
        ({"paths": ["/Volumes/Gone/x.mov"]}, "isn't reachable"),
    ],
)
def test_premiere_import_refuses_what_it_cannot_import_without_calling_premiere(
    args: dict[str, Any], message: str
) -> None:
    host = Sent({})
    with pytest.raises(HostError, match=message):
        media.premiere_import_media(host, args)
    assert host.sent == []


def test_a_bin_is_one_name(clips: list[str]) -> None:
    with pytest.raises(HostError, match="one bin name"):
        media.premiere_import_media(Sent({}), {"paths": clips, "bin": "a/b"})


def test_premiere_preview_opens_the_range_without_importing(clips: list[str]) -> None:
    host = Sent({"source_preview": {"marked": True, "atIn": True}})
    result = media.premiere_source_preview(host, {"path": clips[0], "inSeconds": 2, "outSeconds": 6.5})
    assert host.sent == [("source_preview", {"path": clips[0], "inSeconds": 2.0, "outSeconds": 6.5})]
    assert result == {"opened": True, "imported": False, "marked": True, "atIn": True}


@pytest.mark.parametrize(("start", "end"), [(5, 5), (6, 2), (-1, 3), (True, 3)])
def test_a_preview_needs_a_real_range(clips: list[str], start: Any, end: Any) -> None:
    with pytest.raises(HostError, match="range"):
        media.premiere_source_preview(Sent({}), {"path": clips[0], "inSeconds": start, "outSeconds": end})


# ------------------------------------------------------------------------------------------ Resolve


class Clip:
    def __init__(self, path: str, uid: str) -> None:
        self.path, self.uid = path, uid
        self.marks: tuple[int, int] | None = None

    def GetClipProperty(self, key: str) -> Any:
        return {"File Path": self.path, "FPS": "25"}.get(key)

    def GetUniqueId(self) -> str:
        return self.uid

    def SetMarkInOut(self, start: int, end: int) -> bool:
        self.marks = (start, end)
        return True


class Folder:
    def __init__(self, name: str) -> None:
        self.name = name
        self.clips: list[Clip] = []
        self.subs: list[Folder] = []

    def GetName(self) -> str:
        return self.name

    def GetClipList(self) -> list[Clip]:
        return self.clips

    def GetSubFolderList(self) -> list[Folder]:
        return self.subs


class Pool:
    def __init__(self, refuse: set[str] | None = None) -> None:
        self.root = Folder("Master")
        self.current = self.root
        self.refuse = refuse or set()
        self.selected: Clip | None = None

    def GetRootFolder(self) -> Folder:
        return self.root

    def GetCurrentFolder(self) -> Folder:
        return self.current

    def SetCurrentFolder(self, folder: Folder) -> bool:
        self.current = folder
        return True

    def AddSubFolder(self, parent: Folder, name: str) -> Folder:
        folder = Folder(name)
        parent.subs.append(folder)
        return folder

    def ImportMedia(self, paths: list[str]) -> list[Clip]:
        made = [
            Clip(p, f"u{len(self.current.clips) + i}") for i, p in enumerate(paths) if p not in self.refuse
        ]
        self.current.clips.extend(made)
        return made

    def SetSelectedClip(self, clip: Clip) -> bool:
        self.selected = clip
        return True


class ResolveApi:
    """A ResolveHost stand-in with the two things media.py uses: _project() and _resolve."""

    def __init__(self, pool: Pool) -> None:
        self.pool = pool
        self._resolve = self

    def _project(self) -> Any:
        return self

    def GetMediaPool(self) -> Pool:
        return self.pool

    def GetCurrentPage(self) -> str:
        return "edit"


def test_resolve_import_reuses_pool_clips_and_imports_the_rest_into_the_bin(clips: list[str]) -> None:
    pool = Pool()
    pool.root.clips.append(Clip(clips[0], "old"))
    result = media.resolve_import_media(ResolveApi(pool), {"paths": clips})
    assert result["reused"] == [{"path": clips[0], "clipId": "old"}]
    assert result["imported"] == [{"path": clips[1], "clipId": "u0"}]
    assert result["refused"] == []
    assert [f.name for f in pool.root.subs] == ["VibeCut B-roll"]
    assert pool.root.subs[0].clips[0].path == clips[1]
    assert pool.current is pool.root  # the user's folder is put back


def test_resolve_import_reports_a_file_resolve_would_not_take(clips: list[str]) -> None:
    result = media.resolve_import_media(ResolveApi(Pool(refuse={clips[1]})), {"paths": clips})
    assert [r["path"] for r in result["refused"]] == [clips[1]]


def test_resolve_preview_imports_then_marks_and_selects_the_clip(clips: list[str]) -> None:
    pool = Pool()
    result = media.resolve_source_preview(
        ResolveApi(pool), {"path": clips[0], "inSeconds": 2, "outSeconds": 4}
    )
    clip = pool.root.subs[0].clips[0]
    assert clip.marks == (50, 100) and pool.selected is clip
    assert result == {
        "opened": True,
        "imported": True,
        "bin": "VibeCut B-roll",
        "clipId": clip.uid,
        "marked": True,
        "atIn": False,
        "page": "edit",
    }


def test_both_watchers_answer_the_library_calls(tmp_path: Path) -> None:
    for adapter in (PremiereAdapter(PremiereBridge(tmp_path)), ResolveAdapter(connect=lambda: None)):
        assert {"import_media", "source_preview"} <= set(adapter.calls)
