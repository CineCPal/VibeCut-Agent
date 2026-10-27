"""resolve_colour.py -- colour on the connected Resolve timeline (PLAN.md, "Phase 19c"), with the same
requests and change records as premiere_colour.py.

A look (colour.py: Lumetri's Basic Correction, in its units) is a CDL on the clip's node 1 (`SetCDL`),
which Resolve applies exactly as the CDL formula says, in display values (checked on a chart, 19c probe).
Resolve can't read a CDL back, so a change records the look VibeCut set and Revert copies the clip's
grade back from the request's backup timeline, as a deleted clip's is (resolve_edit.py). That also takes
back anything done to the clip's grade since; the agent says so.

To measure a clip (`read_clip_color`, and each pass of `match_clip_color`), the playhead is put on it and
`ExportCurrentFrameAsStill` writes the frame as the viewer shows it, grade included; it works from the
Edit page (0.08 s a frame) and the page isn't changed. A moment where a clip on a higher track covers the
clip is avoided; a clip covered all through, switched off or on a track that's off is refused. The
playhead is put back afterwards.
"""

from __future__ import annotations

import os
import shutil
import tempfile
from typing import Any

from vibecut_agent.nle import colour
from vibecut_agent.nle.resolve import HostError, _seconds, _to_frame, frames_to_timecode, timecode_to_frames
from vibecut_agent.nle.resolve import frame_rate as _frame_rate
from vibecut_agent.nle.resolve_edit import _items


class _Viewer:
    """Frames of the connected timeline as Resolve shows them, the playhead put back on close."""

    def __init__(self, project: Any, timeline: Any) -> None:
        self.project, self.timeline = project, timeline
        current = project.GetCurrentTimeline()
        if not current or current.GetName() != timeline.GetName():
            raise HostError(
                f"{timeline.GetName()!r} must be the timeline open in Resolve to look at its colour"
            )
        self.fps = _frame_rate(timeline)
        self.origin = int(timeline.GetStartFrame())
        self.start_tc = timecode_to_frames(timeline.GetStartTimecode(), self.fps)
        self.playhead = timeline.GetCurrentTimecode()
        self.folder = tempfile.mkdtemp(prefix="vibecut-colour-")
        self.count = 0

    def frame(self, at: float) -> dict[str, float]:
        """The measures of the frame `at` seconds from the timeline's start."""
        tc = frames_to_timecode(self.start_tc + _to_frame(at, self.fps), self.fps)
        if not self.timeline.SetCurrentTimecode(tc):
            raise HostError("Resolve didn't move the playhead (open the Edit or Cut page)")
        self.count += 1
        path = os.path.join(self.folder, f"frame{self.count}.png")
        if not self.project.ExportCurrentFrameAsStill(path) or not os.path.isfile(path):
            raise HostError("Resolve didn't export the frame")
        try:
            return colour.measure(colour.frame_pixels(path))
        except colour.ColourError as exc:
            raise HostError(str(exc)) from None

    def close(self) -> None:
        if self.playhead:
            self.timeline.SetCurrentTimecode(self.playhead)
        shutil.rmtree(self.folder, ignore_errors=True)


def _covers(timeline: Any, index: int) -> list[tuple[int, int]]:
    """Frames (start, end) of the switched-on clips on switched-on video tracks above `index`."""
    out = []
    for above in range(index + 1, int(timeline.GetTrackCount("video") or 0) + 1):
        if timeline.GetIsTrackEnabled("video", above) is False:
            continue
        for item in timeline.GetItemListInTrack("video", above) or []:
            if item.GetClipEnabled() is not False:
                out.append((int(item.GetStart()), int(item.GetEnd())))
    return out


def _moment(
    timeline: Any, found: dict[str, tuple[str, int, Any]], item_id: str, fps: float
) -> tuple[Any, float]:
    """The picture clip `item_id` and the time (s from the timeline's start) to look at it."""
    if item_id not in found:
        raise HostError(f"There is no clip {item_id!r} on the connected timeline any more")
    kind, index, item = found[item_id]
    name = item.GetName()
    if kind != "video" or item.GetLeftOffset() is None:
        raise HostError(f"{name} has no picture to colour")
    if item.GetClipEnabled() is False or timeline.GetIsTrackEnabled("video", index) is False:
        raise HostError(f"{name} is switched off (or its track is), so it can't be seen")
    origin = int(timeline.GetStartFrame())
    at = colour.uncovered_moment(int(item.GetStart()), int(item.GetEnd()), _covers(timeline, index))
    if at is None:
        raise HostError(f"{name} is covered all through by clips on tracks above it")
    return item, _seconds(int(at) - origin, fps)


def _change(
    timeline: Any, item_id: str, index: int, item: Any, after: dict[str, float], **extra: Any
) -> dict[str, Any]:
    media = item.GetMediaPoolItem()
    return {
        "kind": "color", "itemId": item_id, "name": item.GetName(), "track": ["video", index],
        "start": _seconds(int(item.GetStart()) - int(timeline.GetStartFrame()), _frame_rate(timeline)),
        "mediaId": media.GetUniqueId() if media is not None else None,
        "before": None, "after": after, **extra,
    }  # fmt: skip


def set_clip_color(host: Any, args: dict[str, Any]) -> dict[str, Any]:
    """{timeline, looks: [{itemId, exposure?, contrast?, temperature?, tint?, saturation?}]} -> sets each
    picture clip's look (fields left out neutral) as a CDL on node 1."""
    try:
        wants = colour.look_wants(args)
    except colour.ColourError as exc:
        raise HostError(str(exc)) from None
    _project, timeline = host._timeline(args)
    found = _items(timeline)
    changes, refused = [], []
    for want in wants:
        item_id = want["itemId"]
        if item_id not in found:
            raise HostError(f"There is no clip {item_id!r} on the connected timeline any more")
        kind, index, item = found[item_id]
        if kind != "video" or item.GetLeftOffset() is None:
            refused.append({"itemId": item_id, "reason": f"{item.GetName()} has no picture to colour"})
            continue
        if not item.SetCDL(colour.cdl(want["look"])):
            refused.append({"itemId": item_id, "reason": f"{item.GetName()}: Resolve didn't take the colour"})
            continue
        changes.append(_change(timeline, item_id, index, item, want["look"]))
    return {"changes": changes, "refused": refused}


def match_clip_color(host: Any, args: dict[str, Any]) -> dict[str, Any]:
    """{timeline, referenceId, itemIds} -> each clip's look made to match the reference as Resolve shows it
    (colour.match: measure, step, apply, up to colour.MATCH_PASSES passes)."""
    try:
        reference_id, targets = colour.match_wants(args)
    except colour.ColourError as exc:
        raise HostError(str(exc)) from None
    project, timeline = host._timeline(args)
    fps = _frame_rate(timeline)
    found = _items(timeline)
    _ref_item, ref_at = _moment(timeline, found, reference_id, fps)
    viewer = _Viewer(project, timeline)
    changes, refused = [], []
    try:
        reference = viewer.frame(ref_at)
        for item_id in targets:
            try:
                item, at = _moment(timeline, found, item_id, fps)
            except HostError as exc:
                refused.append({"itemId": item_id, "reason": str(exc)})
                continue
            index = found[item_id][1]

            def render(look: dict[str, float], item: Any = item, at: float = at) -> dict[str, float]:
                if not item.SetCDL(colour.cdl(look)):
                    raise HostError(f"{item.GetName()}: Resolve didn't take the colour")
                return viewer.frame(at)

            try:
                look, seen, passes = colour.match(reference, dict(colour.NEUTRAL), render)
            except HostError as exc:
                refused.append({"itemId": item_id, "reason": str(exc)})
                continue
            changes.append(
                _change(timeline, item_id, index, item, look, reference=reference, seen=seen, passes=passes,
                        distance=round(colour.error(reference, seen), 4))
            )  # fmt: skip
    finally:
        viewer.close()
    return {"changes": changes, "refused": refused, "reference": reference}


def read_clip_color(host: Any, args: dict[str, Any]) -> dict[str, Any]:
    """{timeline, itemIds} -> {clips: [{itemId, name, at, brightness, contrast, warmth, tint, colour}],
    refused}: each clip's frame as Resolve shows it, measured."""
    ids = args.get("itemIds")
    if (
        not isinstance(ids, list)
        or not ids
        or len(ids) > colour.MAX_ITEMS
        or not all(isinstance(i, str) and i for i in ids)
    ):
        raise HostError(f"itemIds must list 1 to {colour.MAX_ITEMS} timeline clip ids")
    project, timeline = host._timeline(args)
    fps = _frame_rate(timeline)
    found = _items(timeline)
    viewer = _Viewer(project, timeline)
    out, refused = [], []
    try:
        for item_id in dict.fromkeys(ids):
            try:
                item, at = _moment(timeline, found, item_id, fps)
                out.append(
                    {"itemId": item_id, "name": item.GetName(), "at": round(at, 3), **viewer.frame(at)}
                )
            except HostError as exc:
                refused.append({"itemId": item_id, "reason": str(exc)})
    finally:
        viewer.close()
    return {"clips": out, "refused": refused}


def revert_color(item: Any, change: dict[str, Any], source: Any) -> str:
    """ "reverted" or "failed": the grade is copied back from the clip's copy on the backup timeline."""
    if source is None:
        return "failed"
    return "reverted" if source.CopyGrades([item]) else "failed"
