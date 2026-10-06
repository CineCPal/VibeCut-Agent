"""The project calls each editor's watcher can run (PLAN.md, "Phase 6a"): its timelines (create, duplicate,
open, rename), selection, reading the Project panel / Media Pool, and (Phase 6b) `rebuild`, which makes a
new timeline from the agent's draft. Ported from VibeCut's
premiere_project/premiere_pool and resolve_project/resolve_pool. None of these edits a timeline, so none
is logged for Revert; the agent keeps the "(before VibeCut n)" backups out of reach (projectTools.ts).
"""

from __future__ import annotations

from collections.abc import Callable
from pathlib import Path
from typing import Any

Call = Callable[[Any, dict[str, Any]], Any]


def premiere_project(imports: Path | None = None) -> dict[str, Call]:
    """`imports` is the bridge folder's imports/, the only folder the panel imports a sequence from."""
    from vibecut_agent.nle import premiere_pool, premiere_project, premiere_rebuild

    calls: dict[str, Call] = {
        "create_timeline": premiere_project.create_timeline,
        "duplicate_timeline": premiere_project.duplicate_timeline,
        "open_timeline": premiere_project.open_timeline,
        "rename_timeline": premiere_project.rename_timeline,
        "select_items": premiere_project.select_items,
        "select_pool_clips": premiere_project.select_pool_clips,
        "read_media_pool": premiere_pool.read_media_pool,
        "get_clip_info": premiere_pool.get_clip_info,
        "search_media_pool": premiere_pool.search_media_pool,
    }
    if imports is not None:
        # A draft becomes a new sequence (Phase 6b): Premiere XML imported by the panel.
        calls["rebuild"] = lambda host, args: premiere_rebuild.rebuild(host, args, imports)
    return calls


def resolve_project() -> dict[str, Call]:
    from vibecut_agent.nle import resolve_pool, resolve_project, resolve_rebuild

    return {
        "create_timeline": resolve_project.create_timeline,
        "duplicate_timeline": resolve_project.duplicate_timeline,
        "open_timeline": resolve_project.open_timeline,
        "rename_timeline": resolve_project.rename_timeline,
        "select_pool_clips": resolve_project.select_pool_clips,
        "read_media_pool": resolve_pool.read_media_pool,
        "get_clip_info": resolve_pool.get_clip_info,
        "search_media_pool": resolve_pool.search_media_pool,
        # A draft becomes a new timeline (Phase 6b): OTIO imported into the Media Pool.
        "rebuild": resolve_rebuild.rebuild,
    }
