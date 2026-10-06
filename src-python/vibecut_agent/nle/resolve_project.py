"""The Resolve project's timelines and the Media Pool selection (PLAN.md, "Phase 6a"), ported from
VibeCut's host-resolve/resolve_project.py (its "Phase 8c"). Importing files is media.py's (Phase 5).

What Resolve 21.1 does (checked live, PLAN.md "8c.0 probe"):
- `MediaPool.CreateEmptyTimeline(name)` makes an empty timeline at the project's frame rate (it can't
  be changed afterwards: SetSetting("timelineFrameRate") on it returns False) and makes it current; a
  name already taken returns None.
- `Timeline.DuplicateTimeline(name)` makes the copy current. `Timeline.SetName` refuses a name
  already taken. `Project.SetCurrentTimeline` opens one.
- `MediaPool.SetSelectedClip(clip)` selects one Media Pool clip. A timeline clip can't be selected
  from a script (no such method exists).
- `ImportMedia` goes into the current folder; `MediaPool.DeleteClips` removes a clip no timeline uses.
"""

from __future__ import annotations

from typing import Any

from vibecut_agent.nle.errors import HostError
from vibecut_agent.nle.resolve_pool import _walk
from vibecut_agent.nle.resolve_support import unique_name

MAX_NAME = 200


def _names(host: Any, project: Any) -> set[str]:
    return {t.GetName() for t in host._timelines(project) if t}


def _new_name(value: Any, fallback: str) -> str:
    name = value if isinstance(value, str) and value.strip() else fallback
    name = name.strip()
    if len(name) > MAX_NAME or "\n" in name:
        raise HostError("name must be one short line")
    return name


def create_timeline(host: Any, args: dict[str, Any]) -> dict[str, Any]:
    """{name?} -> an empty timeline at the project's frame rate, opened in Resolve."""
    project = host._project()
    name = unique_name(_new_name(args.get("name"), "Timeline (VibeCut)"), _names(host, project))
    timeline = project.GetMediaPool().CreateEmptyTimeline(name)
    if not timeline:
        raise HostError(f"Resolve didn't create the timeline {name!r}")
    project.SetCurrentTimeline(timeline)
    return {
        "timeline": timeline.GetName(),
        "fps": timeline.GetSetting("timelineFrameRate"),
    }


def duplicate_timeline(host: Any, args: dict[str, Any]) -> dict[str, Any]:
    """{timeline, name?} -> a copy (clips, grades, markers), opened in Resolve."""
    project, source = host._timeline(args)
    wanted = _new_name(args.get("name"), f"{source.GetName()} Copy")
    name = unique_name(wanted, _names(host, project))
    copy = source.DuplicateTimeline(name)
    if not copy:
        raise HostError(f"Resolve didn't copy {source.GetName()!r}")
    project.SetCurrentTimeline(copy)
    return {"timeline": copy.GetName()}


def open_timeline(host: Any, args: dict[str, Any]) -> dict[str, Any]:
    """{timeline} -> opened in Resolve."""
    project, timeline = host._timeline(args)
    if not project.SetCurrentTimeline(timeline):
        raise HostError(f"Resolve didn't open {timeline.GetName()!r}")
    return {"timeline": timeline.GetName()}


def rename_timeline(host: Any, args: dict[str, Any]) -> dict[str, Any]:
    """{timeline, name} -> renamed; a name already taken is refused."""
    project, timeline = host._timeline(args)
    name = _new_name(args.get("name"), "")
    if not name:
        raise HostError("name must not be empty")
    old = timeline.GetName()
    if name == old:
        return {"timeline": old, "before": old}
    if name in _names(host, project):
        raise HostError(f"There's already a timeline called {name!r}")
    if not timeline.SetName(name):
        raise HostError(f"Resolve didn't rename {old!r}")
    return {"timeline": timeline.GetName(), "before": old}


def _index(media_pool: Any) -> dict[str, tuple[str, Any]]:
    """Every Media Pool clip by its unique id: (bin path, clip). From VibeCut's resolve_organize._index."""
    return {clip.GetUniqueId(): (path, clip) for path, clip in _walk(media_pool)}


def select_pool_clips(host: Any, args: dict[str, Any]) -> dict[str, Any]:
    """{clipIds} -> the first selected in the Media Pool (Resolve's scripting selects one clip)."""
    ids = args.get("clipIds")
    if not isinstance(ids, list) or not ids or not all(isinstance(i, str) for i in ids):
        raise HostError("clipIds must list Media Pool clip ids")
    media_pool = host._project().GetMediaPool()
    index = _index(media_pool)
    if ids[0] not in index:
        raise HostError(f"There is no Media Pool clip {ids[0]!r}")
    if not media_pool.SetSelectedClip(index[ids[0]][1]):
        raise HostError("Resolve didn't select the clip")
    return {"selected": [ids[0]], "notSelected": ids[1:]}
