"""The project calls each editor's watcher can run (PLAN.md, "Phase 6a"): its timelines (create, duplicate,
open, rename), selection, reading the Project panel / Media Pool, and (Phase 6b) `rebuild`, which makes a
new timeline from the agent's draft. Ported from VibeCut's
premiere_project/premiere_pool and resolve_project/resolve_pool. None of these edits a timeline, so none
is logged for Revert; the agent keeps the "(before VibeCut n)" backups out of reach (projectTools.ts).
Phase 12e adds organizing the project (premiere_organize / resolve_organize): bins, moves, label colours,
logged fields and names, each returning {clipId, field, before, after} records that `revert_pool_changes`
puts back, and the app logs like timeline edits.
"""

from __future__ import annotations

from collections.abc import Callable
from pathlib import Path
from typing import Any

Call = Callable[[Any, dict[str, Any]], Any]


def _organize(module: Any) -> dict[str, Call]:
    """Phase 12e: the same six commands on each editor."""
    names = ("create_bins", "move_clips", "set_clip_labels", "set_clip_metadata", "rename_clips", "revert_pool_changes")
    return {name: getattr(module, name) for name in names}


def premiere_project(imports: Path | None = None) -> dict[str, Call]:
    """`imports` is the bridge folder's imports/, the only folder the panel imports a sequence from."""
    from vibecut_agent.nle import premiere_organize, premiere_pool, premiere_project, premiere_rebuild

    calls: dict[str, Call] = {
        "create_timeline": premiere_project.create_timeline,
        "duplicate_timeline": premiere_project.duplicate_timeline,
        # Phase 14d: Premiere's Auto Reframe Sequence.
        "make_social_version": premiere_project.make_social_version,
        "open_timeline": premiere_project.open_timeline,
        "rename_timeline": premiere_project.rename_timeline,
        "select_items": premiere_project.select_items,
        "select_pool_clips": premiere_project.select_pool_clips,
        "read_media_pool": premiere_pool.read_media_pool,
        "get_clip_info": premiere_pool.get_clip_info,
        "search_media_pool": premiere_pool.search_media_pool,
        **_organize(premiere_organize),
    }
    if imports is not None:
        # A draft becomes a new sequence (Phase 6b): Premiere XML imported by the panel.
        calls["rebuild"] = lambda host, args: premiere_rebuild.rebuild(host, args, imports)
    return calls


def resolve_project() -> dict[str, Call]:
    from vibecut_agent.nle import resolve_organize, resolve_pool, resolve_project, resolve_rebuild

    return {
        "create_timeline": resolve_project.create_timeline,
        "duplicate_timeline": resolve_project.duplicate_timeline,
        # Phase 14d: a vertical, square or 4:5 copy.
        "make_social_version": resolve_project.make_social_version,
        "open_timeline": resolve_project.open_timeline,
        "rename_timeline": resolve_project.rename_timeline,
        "select_pool_clips": resolve_project.select_pool_clips,
        "read_media_pool": resolve_pool.read_media_pool,
        "get_clip_info": resolve_pool.get_clip_info,
        "search_media_pool": resolve_pool.search_media_pool,
        # A draft becomes a new timeline (Phase 6b): OTIO imported into the Media Pool.
        "rebuild": resolve_rebuild.rebuild,
        **_organize(resolve_organize),
    }
