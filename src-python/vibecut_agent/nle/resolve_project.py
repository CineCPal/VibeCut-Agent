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
from vibecut_agent.nle.social import SUFFIX, social_args, social_size

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


# Smart Reframe takes Resolve 1-6 s a clip (21.1); past this many the rest are left centred.
MAX_REFRAMED = 60
# "Scale full frame with crop": the picture fills the new frame, cropped at the sides.
FILL = "scaleToCrop"


def _size(timeline: Any) -> tuple[int, int]:
    try:
        return int(timeline.GetSetting("timelineResolutionWidth")), int(
            timeline.GetSetting("timelineResolutionHeight")
        )
    except (TypeError, ValueError):
        raise HostError("Resolve didn't say the timeline's frame size") from None


def make_social_version(host: Any, args: dict[str, Any]) -> dict[str, Any]:
    """{timeline, aspect: 9:16 | 1:1 | 4:5, name?, reframe: auto | center} -> a copy at that frame size,
    opened; the original is unchanged.

    What Resolve 21.1 does (probed live, PLAN.md "14d"): a timeline takes its own frame size once
    `useCustomSettings` is "1" (the project and the original keep theirs); `timelineInputResMismatchBehavior`
    "scaleToCrop" fills the frame; `TimelineItem.SmartReframe()` (Studio) moves each clip's framing onto
    its subject, though Pan and Zoom read the same after it.
    """
    aspect, reframe = social_args(args)
    project, source = host._timeline(args)
    width, height = _size(source)
    new_width, new_height = social_size(width, height, aspect)
    wanted = _new_name(args.get("name"), f"{source.GetName()} ({SUFFIX[aspect]})")
    name = unique_name(wanted, _names(host, project))
    copy = source.DuplicateTimeline(name)
    if not copy:
        raise HostError(f"Resolve didn't copy {source.GetName()!r}")
    project.SetCurrentTimeline(copy)
    for key, value in (
        ("useCustomSettings", "1"),
        ("timelineResolutionWidth", str(new_width)),
        ("timelineResolutionHeight", str(new_height)),
        ("timelineInputResMismatchBehavior", FILL),
    ):
        copy.SetSetting(key, value)
    if _size(copy) != (new_width, new_height):
        raise HostError(
            f"Resolve made the copy {copy.GetName()!r} but kept it at {width}x{height}; set its frame size in "
            "Timeline Settings (or delete the copy)"
        )
    out: dict[str, Any] = {
        "timeline": copy.GetName(),
        "original": source.GetName(),
        "width": new_width,
        "height": new_height,
        "from": [width, height],
        "fill": copy.GetSetting("timelineInputResMismatchBehavior") == FILL,
        "reframe": reframe,
    }
    if reframe == "auto":
        clips = [
            item
            for index in range(1, int(copy.GetTrackCount("video") or 0) + 1)
            for item in copy.GetItemListInTrack("video", index) or []
            if item.GetClipEnabled() and item.GetMediaPoolItem() is not None
        ]
        reframed, missed = 0, []
        for item in clips[:MAX_REFRAMED]:
            smart = getattr(item, "SmartReframe", None)
            try:
                done = bool(smart and smart())
            except Exception:  # noqa: BLE001 - one clip that won't reframe stays centred
                done = False
            if done:
                reframed += 1
            else:
                missed.append(item.GetName())
        out["reframed"] = reframed
        if missed:
            out["notReframed"] = missed[:20]
        if len(clips) > MAX_REFRAMED:
            out["note"] = (
                f"Smart Reframe ran on the first {MAX_REFRAMED} of {len(clips)} clips; the rest are centred"
            )
        elif clips and not reframed:
            out["note"] = (
                "Smart Reframe didn't run (it needs DaVinci Resolve Studio), so every clip is centred"
            )
    return out


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
