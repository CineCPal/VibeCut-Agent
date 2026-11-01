"""resolve_colour.py -- colour on the connected Resolve timeline (PLAN.md, "Phase 19c"), with the same
requests and change records as premiere_colour.py.

A look (colour.py: Lumetri's Basic Correction, in its units) is a CDL on the clip's node 1 (`SetCDL`),
which Resolve applies exactly as the CDL formula says, in display values (checked on a chart, 19c probe).
Resolve can't read a CDL back, so a change records the look VibeCut set and Revert copies the clip's
grade back from the request's backup timeline, as a deleted clip's is (resolve_edit.py). That also takes
back anything done to the clip's grade since; the agent says so.

Matching to a clip and balancing (Phase 20b) go by the parade instead (parade.py): node 1's CDL as a
curve per channel (slope, offset and power each) and its saturation, each clip measured on
parade.FRAMES frames.

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

from vibecut_agent.nle import colour, parade
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

    def frame(self, at: float, measuring: Any = colour.measure) -> dict[str, float]:
        """The measures (`measuring`'s) of the frame `at` seconds from the timeline's start."""
        return dict(measuring(self.pixels(at)))

    def pooled(self, moments: list[float]) -> parade.Pixels:
        return [p for at in moments for p in self.pixels(at)]

    def pixels(self, at: float, trim: bool = True) -> parade.Pixels:
        """The frame `at` seconds from the timeline's start, as Resolve shows it (`trim`: its black
        borders left out)."""
        tc = frames_to_timecode(self.start_tc + _to_frame(at, self.fps), self.fps)
        if not self.timeline.SetCurrentTimecode(tc):
            raise HostError("Resolve didn't move the playhead (open the Edit or Cut page)")
        self.count += 1
        path = os.path.join(self.folder, f"frame{self.count}.png")
        if not self.project.ExportCurrentFrameAsStill(path) or not os.path.isfile(path):
            raise HostError("Resolve didn't export the frame")
        try:
            return colour.frame_pixels(path, trim=trim)
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
    item, moments = _moments(timeline, found, item_id, fps, (0.5,))
    return item, moments[0]


def _moments(
    timeline: Any, found: dict[str, tuple[str, int, Any]], item_id: str, fps: float, shares: tuple[float, ...]
) -> tuple[Any, list[float]]:
    """The picture clip `item_id` and the times (s from the timeline's start) to look at it, at each
    of `shares` of it as near as it's clear."""
    if item_id not in found:
        raise HostError(f"There is no clip {item_id!r} on the connected timeline any more")
    kind, index, item = found[item_id]
    name = item.GetName()
    if kind != "video" or item.GetLeftOffset() is None:
        raise HostError(f"{name} has no picture to colour")
    if item.GetClipEnabled() is False or timeline.GetIsTrackEnabled("video", index) is False:
        raise HostError(f"{name} is switched off (or its track is), so it can't be seen")
    origin = int(timeline.GetStartFrame())
    moments = colour.uncovered_moments(
        int(item.GetStart()), int(item.GetEnd()), _covers(timeline, index), shares
    )
    if not moments:
        raise HostError(f"{name} is covered all through by clips on tracks above it")
    return item, list(dict.fromkeys(_seconds(int(at) - origin, fps) for at in moments))


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
    """{timeline, referenceId | referenceLook, itemIds} -> each clip made to match the reference: a clip
    as Resolve shows it by its parade, with node 1's CDL as curves (`_match_parade`), or a look learned
    from a reference edit with the five-control CDL (colour.match). {timeline, balance: true, itemIds}
    balances each clip to its own neutral instead (`_balance`)."""
    try:
        balancing = colour.balance_wants(args)
    except colour.ColourError as exc:
        raise HostError(str(exc)) from None
    if balancing is not None:
        return _balance(host, args, balancing)
    try:
        reference_id, targets, wanted = colour.match_wants(args)
    except colour.ColourError as exc:
        raise HostError(str(exc)) from None
    project, timeline = host._timeline(args)
    fps = _frame_rate(timeline)
    found = _items(timeline)
    if wanted is None:
        assert reference_id is not None  # match_wants gives a clip or a look
        return _match_parade(project, timeline, found, reference_id, targets)
    # A learned style is five overall measures, matched with the calibrated five-control CDL.
    viewer = _Viewer(project, timeline)
    changes, refused = [], []
    reference = wanted
    try:
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
                look, seen, passes = colour.match(
                    reference, dict(colour.NEUTRAL), render, colour.STYLE_LIMITS
                )
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


def _parade_show(item: Any, viewer: _Viewer, moments: list[float]) -> Any:
    """`show` for parade.match and parade.balance: node 1's CDL set to the look (None: left as it is),
    then the clip's frames, pooled."""

    def show(look: parade.Look | None) -> parade.Pixels:
        if look is not None and not item.SetCDL(parade.cdl(look)):
            raise HostError(f"{item.GetName()}: Resolve didn't take the colour")
        return viewer.pooled(moments)

    return show


def _match_parade(
    project: Any, timeline: Any, found: dict[str, tuple[str, int, Any]], reference_id: str, targets: list[str]
) -> dict[str, Any]:
    """Each clip's node 1 CDL set so its parade and histogram match the reference clip's
    (parade.match), measured on parade.FRAMES frames of each."""
    fps = _frame_rate(timeline)
    ref_moments = _moments(timeline, found, reference_id, fps, parade.FRAMES)[1]
    viewer = _Viewer(project, timeline)
    changes, refused = [], []
    try:
        reference = parade.parade(viewer.pooled(ref_moments))
        for item_id in targets:
            try:
                item, moments = _moments(timeline, found, item_id, fps, parade.FRAMES)
                look, seen, passes = parade.match(
                    reference, _parade_show(item, viewer, moments), parade.resolve_curve
                )
            except (HostError, colour.ColourError) as exc:
                refused.append({"itemId": item_id, "reason": str(exc)})
                continue
            distance = round(parade.error(reference, seen), 4)
            changes.append(
                _change(timeline, item_id, found[item_id][1], item, look, method="parade", reference=reference,
                        seen=seen, passes=passes, distance=distance, close=distance <= parade.GOOD_ENOUGH)
            )  # fmt: skip
    finally:
        viewer.close()
    return {"changes": changes, "refused": refused, "reference": reference}


def _balance_moment(
    timeline: Any, found: dict[str, tuple[str, int, Any]], item_id: str, fps: float, at: float | None
) -> tuple[Any, float]:
    """The clip and the time to balance it at: `at` seconds (refused when the clip isn't there or a clip
    on a higher track covers it), or its middle."""
    item, middle = _moment(timeline, found, item_id, fps)
    if at is None:
        return item, middle
    origin = int(timeline.GetStartFrame())
    frame = origin + _to_frame(at, fps)
    if not int(item.GetStart()) <= frame < int(item.GetEnd()):
        raise HostError(f"{item.GetName()} isn't at {at:g} s")
    clear = colour.uncovered_moment(
        int(item.GetStart()), int(item.GetEnd()), _covers(timeline, found[item_id][1]), frame
    )
    if clear != frame:
        raise HostError(f"{item.GetName()} is under a clip on a higher track at {at:g} s")
    return item, _seconds(frame - origin, fps)


def _balance(host: Any, args: dict[str, Any], wants: list[dict[str, Any]]) -> dict[str, Any]:
    """Each clip balanced to its own neutral, read from the areas named in its frame (parade.balance):
    node 1's CDL as curves that make what's there read alike in each channel, its exposure brought into
    range. A clip already there is left alone (`balanced`), its grade untouched."""
    project, timeline = host._timeline(args)
    fps = _frame_rate(timeline)
    found = _items(timeline)
    viewer = _Viewer(project, timeline)
    changes, refused, balanced = [], [], []
    try:
        for want in wants:
            item_id = want["itemId"]
            try:
                item, at = _balance_moment(timeline, found, item_id, fps, want["at"])

                def show(look: parade.Look | None, item: Any = item, at: float = at) -> parade.Pixels:
                    if look is not None and not item.SetCDL(parade.cdl(look)):
                        raise HostError(f"{item.GetName()}: Resolve didn't take the colour")
                    return viewer.pixels(at, trim=False)

                result = parade.balance(show, parade.resolve_curve, want["areas"])
            except (HostError, colour.ColourError) as exc:
                refused.append({"itemId": item_id, "reason": str(exc)})
                continue
            if result.get("balanced"):
                balanced.append({"itemId": item_id, "name": item.GetName(), "was": result["was"]})
                continue
            changes.append(
                _change(timeline, item_id, found[item_id][1], item, result["look"], method="parade",
                        reference=result["target"], was=result["was"], seen=result["seen"],
                        passes=result["passes"], distance=result["distance"],
                        close=result["distance"] <= parade.GOOD_ENOUGH, at=round(at, 3))
            )  # fmt: skip
    finally:
        viewer.close()
    return {"changes": changes, "refused": refused, "balanced": balanced}


def read_clip_color(host: Any, args: dict[str, Any]) -> dict[str, Any]:
    """{timeline, itemIds} -> {clips: [{itemId, name, at, brightness, contrast, warmth, tint, colour, parade}],
    refused}: each clip's frame as Resolve shows it, measured (its parade and histogram too, parade.parade)."""
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
                pixels = viewer.pixels(at)
                out.append(
                    {"itemId": item_id, "name": item.GetName(), "at": round(at, 3), **colour.measure(pixels),
                     "parade": parade.parade(pixels)}
                )  # fmt: skip
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
