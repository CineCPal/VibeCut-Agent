"""The direct edits each editor's watcher can run (PLAN.md, Phase 4b), ported from VibeCut's
premiere_edit/effects/timing and resolve_edit/effects/timing/reshape modules.

Every edit returns its change records ({changes, refused, ...}); the app keeps them as the edit log and
sends them back to ``revert_timeline_changes``. Nothing is remembered here between calls.
"""

from __future__ import annotations

from collections.abc import Callable
from pathlib import Path
from typing import Any

Edit = Callable[[Any, dict[str, Any]], Any]


def premiere_edits(imports: Path | None = None) -> dict[str, Edit]:
    """`imports` is the bridge folder's imports/, where create_captions writes its SRT (Phase 15a)."""
    from vibecut_agent.nle import links, premiere_edit, premiere_effects, premiere_structure, premiere_timing

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
        # Phase 12b-12d.
        "set_clip_speed": premiere_timing.set_clip_speed,
        "set_transition": premiere_effects.set_transition,
        "add_track": premiere_timing.add_track,
        "remove_track": premiere_timing.remove_track,
        "set_track_options": premiere_structure.set_track_options,
        "revert_timeline_changes": premiere_edit.revert_timeline_changes,
        # Phase 15a.
        "create_captions": lambda host, args: premiere_edit.create_captions(host, args, imports),
    }


def resolve_edits() -> dict[str, Edit]:
    from vibecut_agent.nle import (
        links,
        resolve_edit,
        resolve_effects,
        resolve_reshape,
        resolve_structure,
        resolve_timing,
    )

    return {
        "backup_timeline": resolve_edit.backup_timeline,
        "add_clips": resolve_edit.add_clips,
        "delete_clips": resolve_edit.delete_clips,
        "nest_clips": resolve_edit.nest_clips,
        "set_clips_enabled": resolve_edit.set_clips_enabled,
        "set_clip_levels": resolve_edit.set_clip_levels,
        "reshape_clip": resolve_reshape.reshape_clip,
        "set_clip_fades": resolve_effects.set_clip_fades,
        # Resolve's duck is made of splits, levels and dissolves (src/lib/agent/duck.ts); also a tool (12c).
        "set_transition": resolve_effects.set_transition,
        "split_clips": resolve_timing.split_clips,
        "set_links": links.resolve_set_links,
        # Phase 12b-12d.
        "set_clip_speed": resolve_timing.set_clip_speed,
        "add_track": resolve_timing.add_track,
        "remove_track": resolve_timing.remove_track,
        "set_track_options": resolve_structure.set_track_options,
        "revert_timeline_changes": resolve_edit.revert_timeline_changes,
        # Phase 15a.
        "create_captions": resolve_edit.create_captions,
    }


EDIT_COMMANDS = {
    "premiere": tuple(sorted(premiere_edits())),
    "resolve": tuple(sorted(resolve_edits())),
}
