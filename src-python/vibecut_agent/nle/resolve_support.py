"""Helpers the Resolve edit modules share, copied out of VibeCut's resolve_rebuild.py, resolve_pool.py
and resolve_color.py so the edits don't pull in its rebuild (OTIO) and colour code. Standard library
only: this runs under Resolve's own Python."""

from __future__ import annotations

import os
from typing import Any

from vibecut_agent.nle.errors import HostError

BIN_NAME = "VibeCut"
# VibeCut's own grade versions are named "VibeCut n"; carry_grades keeps them apart (VibeCut 7d).
VERSION_PREFIX = "VibeCut"


def unique_name(wanted: str, taken: set[str]) -> str:
    if wanted not in taken:
        return wanted
    n = 2
    while f"{wanted} {n}" in taken:
        n += 1
    return f"{wanted} {n}"


def _pool_index(media_pool: Any) -> dict[str, tuple[Any, Any]]:
    """Each file path in the Media Pool: its (first) clip and the folder holding it."""
    found: dict[str, tuple[Any, Any]] = {}
    stack = [media_pool.GetRootFolder()]
    while stack:
        folder = stack.pop()
        for clip in folder.GetClipList() or []:
            path = clip.GetClipProperty("File Path")
            if path:
                found.setdefault(path, (clip, folder))
        stack.extend(folder.GetSubFolderList() or [])
    return found


def _pool_by_path(media_pool: Any) -> dict[str, Any]:
    return {path: clip for path, (clip, _) in _pool_index(media_pool).items()}


def ensure_in_pool(media_pool: Any, paths: list[str]) -> None:
    """Imports the files that aren't in the Media Pool yet into a "VibeCut" bin."""
    pool = _pool_by_path(media_pool)
    missing = [p for p in paths if p not in pool]
    if not missing:
        return
    root = media_pool.GetRootFolder()
    target = next(
        (f for f in root.GetSubFolderList() or [] if f.GetName() == BIN_NAME), None
    ) or media_pool.AddSubFolder(root, BIN_NAME)
    previous = media_pool.GetCurrentFolder()
    try:
        if target:
            media_pool.SetCurrentFolder(target)
        media_pool.ImportMedia(missing)
    finally:
        if previous:
            media_pool.SetCurrentFolder(previous)
    still = [p for p in missing if p not in _pool_by_path(media_pool)]
    if still:
        names = ", ".join(os.path.basename(p) for p in still[:5])
        raise HostError(f"Resolve couldn't import {len(still)} file(s) into the Media Pool: {names}")


def _walk(media_pool: Any) -> list[tuple[str, Any]]:
    """(bin path, clip) for every clip, folders depth-first in the pool's own order."""
    found: list[tuple[str, Any]] = []

    def visit(folder: Any, path: str) -> None:
        for clip in folder.GetClipList() or []:
            found.append((path, clip))
        for sub in folder.GetSubFolderList() or []:
            visit(sub, f"{path}/{sub.GetName()}")

    root = media_pool.GetRootFolder()
    visit(root, root.GetName() or "Master")
    return found


def _current(item: Any) -> str:
    return str((item.GetCurrentVersion() or {}).get("versionName") or "")


def carry_grades(source: Any, target: Any) -> bool:
    """Copies source's grade onto target, for reshape and split (resolve_reshape.replace). CopyGrades
    copies only the current version, so a clip on one of VibeCut's versions would give the new clip
    VibeCut's look as its own; then every local version is carried under its own name instead, and
    the same one is made current, so a revert still finds the user's grade and VibeCut's (checked live
    by VibeCut, 7d). Returns whether any grade was copied (an ungraded version's CopyGrades returns False)."""
    try:
        names = [str(n) for n in (source.GetVersionNameList(0) or [])]
    except (AttributeError, TypeError):
        names = []
    if not any(n.startswith(f"{VERSION_PREFIX} ") for n in names):
        return bool(source.CopyGrades([target]))
    current = _current(source)
    first = _current(target)
    copied = False
    for i, name in enumerate(names):
        source.LoadVersionByName(name, 0)
        if i == 0:
            target.LoadVersionByName(first, 0)
        elif name in (target.GetVersionNameList(0) or []):
            target.LoadVersionByName(name, 0)
        else:
            target.AddVersion(name, 0)
        copied = bool(source.CopyGrades([target])) or copied
    source.LoadVersionByName(current, 0)
    target.LoadVersionByName(current if current != names[0] else first, 0)
    return copied
