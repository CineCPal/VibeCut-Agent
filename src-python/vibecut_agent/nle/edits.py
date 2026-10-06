"""The direct edits each editor's watcher can run (PLAN.md, Phase 4b), ported from VibeCut's
premiere_edit/effects/timing and resolve_edit/effects/timing/reshape modules.

Every edit returns its change records ({changes, refused, ...}); the app keeps them as the edit log and
sends them back to ``revert_timeline_changes``. Nothing is remembered here between calls.
"""

from __future__ import annotations

from collections.abc import Callable
from typing import Any

Edit = Callable[[Any, dict[str, Any]], Any]


def premiere_edits() -> dict[str, Edit]:
    from vibecut_agent.nle import links, premiere_edit, premiere_effects, premiere_timing

    return {
        "backup_timeline": premiere_edit.backup_timeline,
        "add_clips": premiere_edit.add_clips,
        "delete_clips": premiere_edit.delete_clips,
        "nest_clips": premiere_edit.nest_clips,
        "set_clips_enabled": premiere_edit.set_clips_enabled,
        "set_clip_levels": premiere_edit.set_clip_levels,
        "reshape_clip": premiere_edit.reshape_clip,
        "set_clip_fades": premiere_effects.set_clip_fades,
        "duck_clip": premiere_effects.duck_clip,
        "split_clips": premiere_timing.split_clips,
        "set_links": links.premiere_set_links,
        "revert_timeline_changes": premiere_edit.revert_timeline_changes,
    }


def resolve_edits() -> dict[str, Edit]:
    from vibecut_agent.nle import links, resolve_edit, resolve_effects, resolve_reshape, resolve_timing

    return {
        "backup_timeline": resolve_edit.backup_timeline,
        "add_clips": resolve_edit.add_clips,
        "delete_clips": resolve_edit.delete_clips,
        "nest_clips": resolve_edit.nest_clips,
        "set_clips_enabled": resolve_edit.set_clips_enabled,
        "set_clip_levels": resolve_edit.set_clip_levels,
        "reshape_clip": resolve_reshape.reshape_clip,
        "set_clip_fades": resolve_effects.set_clip_fades,
        # Resolve's duck is made of splits, levels and dissolves (src/lib/agent/duck.ts).
        "set_transition": resolve_effects.set_transition,
        "split_clips": resolve_timing.split_clips,
        "set_links": links.resolve_set_links,
        "revert_timeline_changes": resolve_edit.revert_timeline_changes,
    }


EDIT_COMMANDS = {
    "premiere": tuple(sorted(premiere_edits())),
    "resolve": tuple(sorted(resolve_edits())),
}
