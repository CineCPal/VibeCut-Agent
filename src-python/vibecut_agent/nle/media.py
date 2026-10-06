"""The B-roll Library's editor calls (PLAN.md, "Phase 5"): ``import_media`` puts files in the project's
"VibeCut B-roll" bin, and ``source_preview`` opens a file in the editor's source viewer with a range
marked. Ported from VibeCut's host-premiere/premiere_project.py and host-resolve/resolve_project.py
(Phase 10b, checked live there on Premiere 26.5.2 and Resolve 21.1).

Imports are not timeline edits: they never go into the edit log, and Revert doesn't remove them.
Standard library only: the Resolve half runs under Resolve's own Python.
"""

from __future__ import annotations

import os
from collections.abc import Callable
from typing import Any

from vibecut_agent.nle.errors import HostError
from vibecut_agent.nle.resolve_support import _pool_by_path

BROLL_BIN = "VibeCut B-roll"
MAX_IMPORTS = 50

Call = Callable[[Any, dict[str, Any]], Any]


def _paths(args: dict[str, Any]) -> list[str]:
    paths = args.get("paths")
    if not isinstance(paths, list) or not paths or not all(isinstance(p, str) for p in paths):
        raise HostError("paths must list media files")
    unique = list(dict.fromkeys(paths))
    if len(unique) > MAX_IMPORTS:
        raise HostError(f"At most {MAX_IMPORTS} files at a time")
    for path in unique:
        if not os.path.isabs(path) or not os.path.isfile(path):
            raise HostError(f"{os.path.basename(path) or path!r} isn't reachable (is its drive attached?)")
    return unique


def _bin(args: dict[str, Any]) -> str:
    name = args.get("bin", BROLL_BIN)
    if not isinstance(name, str) or not name.strip() or "/" in name or len(name) > 255:
        raise HostError("bin must be one bin name, without '/'")
    return name.strip()


def _range(args: dict[str, Any]) -> tuple[str, float, float]:
    path = args.get("path")
    start, end = args.get("inSeconds"), args.get("outSeconds")
    if not isinstance(path, str) or not os.path.isabs(path) or not os.path.isfile(path):
        raise HostError("path must be an existing media file (is its drive attached?)")
    numbers = all(isinstance(t, (int, float)) and not isinstance(t, bool) and t >= 0 for t in (start, end))
    if not numbers or end <= start:  # type: ignore[operator]
        raise HostError("inSeconds and outSeconds must be a range in the file")
    return path, float(start), float(end)  # type: ignore[arg-type]


# ----------------------------------------------------------------------------------------- Premiere


def premiere_import_media(host: Any, args: dict[str, Any]) -> dict[str, Any]:
    """{paths, bin?} -> {bin, imported: [{path, clipId}], reused: [{path, clipId}]}. A file already in
    the project is reused wherever it is; the others go into the top-level bin (made if missing)."""
    paths, name = _paths(args), _bin(args)
    answer = host._send("import_media", {"paths": paths, "bin": name})
    imported: list[dict[str, Any]] = []
    reused: list[dict[str, Any]] = []
    for item in answer.get("items") or []:
        entry = {"path": item.get("path"), "clipId": item.get("id")}
        (imported if item.get("imported") else reused).append(entry)
    return {"bin": name, "imported": imported, "reused": reused}


def premiere_source_preview(host: Any, args: dict[str, Any]) -> dict[str, Any]:
    """{path, inSeconds, outSeconds} -> the file in the Source monitor, In/Out marked and the playhead at
    In. `sourceMonitor.openFilePath` opens a file without adding it to the project, so nothing is
    imported."""
    path, start, end = _range(args)
    answer = host._send("source_preview", {"path": path, "inSeconds": start, "outSeconds": end})
    return {
        "opened": True,
        "imported": False,
        "marked": bool(answer.get("marked")),
        "atIn": bool(answer.get("atIn")),
    }


def premiere_media() -> dict[str, Call]:
    return {"import_media": premiere_import_media, "source_preview": premiere_source_preview}


# ------------------------------------------------------------------------------------------ Resolve


def _resolve_bin(media_pool: Any, name: str) -> Any:
    root = media_pool.GetRootFolder()
    found = next((f for f in root.GetSubFolderList() or [] if f.GetName() == name), None)
    return found or media_pool.AddSubFolder(root, name)


def resolve_import_media(host: Any, args: dict[str, Any]) -> dict[str, Any]:
    """{paths, bin?} -> {bin, imported, reused, refused: [{path, reason}]}. A file already in the Media
    Pool is reused wherever it is; the others go into the top-level bin (made if missing)."""
    paths, name = _paths(args), _bin(args)
    media_pool = host._project().GetMediaPool()
    pool = _pool_by_path(media_pool)
    reused = [{"path": p, "clipId": pool[p].GetUniqueId()} for p in paths if p in pool]
    missing = [p for p in paths if p not in pool]
    imported: list[dict[str, Any]] = []
    refused: list[dict[str, Any]] = []
    if missing:
        previous = media_pool.GetCurrentFolder()
        try:
            folder = _resolve_bin(media_pool, name)
            if folder:
                media_pool.SetCurrentFolder(folder)
            media_pool.ImportMedia(missing)
        finally:
            if previous:
                media_pool.SetCurrentFolder(previous)
        now = _pool_by_path(media_pool)
        for path in missing:
            if path in now:
                imported.append({"path": path, "clipId": now[path].GetUniqueId()})
            else:
                refused.append({"path": path, "reason": "Resolve didn't import it"})
    return {"bin": name, "imported": imported, "reused": reused, "refused": refused}


def resolve_source_preview(host: Any, args: dict[str, Any]) -> dict[str, Any]:
    """{path, inSeconds, outSeconds, bin?} -> the clip in the source viewer with that range marked.
    Resolve shows only Media Pool clips there, so a file not in the pool yet is imported into the bin
    first (`imported` says so). Its viewer's playhead can't be moved by script; Shift+I goes to In."""
    path, start, end = _range(args)
    added = resolve_import_media(host, {"paths": [path], "bin": args.get("bin", BROLL_BIN)})
    if added["refused"]:
        raise HostError(f"Resolve didn't import {os.path.basename(path)}")
    media_pool = host._project().GetMediaPool()
    clip = _pool_by_path(media_pool).get(path)
    if clip is None:
        raise HostError(f"Resolve didn't import {os.path.basename(path)}")
    fps = float(clip.GetClipProperty("FPS") or 0) or 25.0
    marked = bool(clip.SetMarkInOut(round(start * fps), round(end * fps)))
    if not media_pool.SetSelectedClip(clip):
        raise HostError("Resolve didn't open the clip in the source viewer")
    return {
        "opened": True,
        "imported": bool(added["imported"]),
        "bin": added["bin"],
        "clipId": clip.GetUniqueId(),
        "marked": marked,
        "atIn": False,
        "page": host._resolve.GetCurrentPage(),
    }


def resolve_media() -> dict[str, Call]:
    return {"import_media": resolve_import_media, "source_preview": resolve_source_preview}
