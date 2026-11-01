"""resolve_colour.py -- colour on the connected Resolve timeline (PLAN.md, "Phase 19c"), with the same
requests and change records as premiere_colour.py.

A look (colour.py: Lumetri's Basic Correction, in its units) is a CDL (`SetCDL`), which Resolve applies
exactly as the CDL formula says, in display values (checked on a chart, 19c probe). Matching to a clip and
balancing (Phase 20b) go by the parade instead (parade.py): a CDL as a curve per channel (slope, offset
and power each) and its saturation, each clip measured on parade.FRAMES frames.

Which node (Phase 20b, the node probe): Resolve's API can't add or label a node, but reads labels and
which tools a node uses. Balancing goes in the node labelled "VC Balance", matching and set_clip_color in
"VC Match" (NODE_LABELS), wherever they are in the clip's grade. A clip with no grade at all gets
VibeCut's node template first when one has been saved (`save_node_template`: a still of a clip whose
nodes the user labelled, exported as a .drx; `ApplyGradeFromDRX` replaces a grade, so it only goes on an
ungraded clip). With neither, a clip of one unlabelled node is graded in node 1, as before; a clip with
more nodes and none labelled is refused rather than guessed at.

Resolve can't read a CDL back, so a change records the look VibeCut set and the node. Revert sets a
labelled node back to neutral (its other nodes, and anything done in them since, stay); node 1 of a
clip that had no grade is reset; otherwise the clip's grade is copied back from the request's backup
timeline, as a deleted clip's is (resolve_edit.py), which also takes back anything done to it since.

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
from pathlib import Path
from typing import Any

from vibecut_agent.nle import colour, parade
from vibecut_agent.nle.resolve import HostError, _seconds, _to_frame, frames_to_timecode, timecode_to_frames
from vibecut_agent.nle.resolve import frame_rate as _frame_rate
from vibecut_agent.nle.resolve_edit import _items

NODE_LABELS = {"balance": "VC Balance", "match": "VC Match"}
TEMPLATE_ENV = "VIBECUT_AGENT_NODE_TEMPLATE"
NEUTRAL_CDL = {"Slope": "1.00000 1.00000 1.00000", "Offset": "0.00000 0.00000 0.00000",
               "Power": "1.00000 1.00000 1.00000", "Saturation": "1.00000"}  # fmt: skip


def template_path() -> Path:
    """VibeCut's node template for Resolve (`TEMPLATE_ENV` overrides it, for tests)."""
    custom = os.environ.get(TEMPLATE_ENV)
    if custom:
        return Path(custom)
    return Path.home() / "Library" / "Application Support" / "VibeCut Agent" / "resolve-node-template.drx"


def _labelled(graph: Any, label: str) -> int | None:
    """The first node of `graph` labelled `label` (case and spaces round it aside), or None."""
    for index in range(1, int(graph.GetNumNodes() or 0) + 1):
        if str(graph.GetNodeLabel(index) or "").strip().lower() == label.lower():
            return index
    return None


def _graded(graph: Any) -> bool:
    """Whether any node of `graph` does anything (Resolve lists no tools on an untouched node)."""
    return any(graph.GetToolsInNode(i) for i in range(1, int(graph.GetNumNodes() or 0) + 1))


def _node(item: Any, role: str) -> dict[str, Any]:
    """Where VibeCut's CDL for `role` goes in `item`'s grade: {index, label, template, ungraded}."""
    name, want = item.GetName(), NODE_LABELS[role]
    graph = item.GetNodeGraph()
    if graph is None:
        raise HostError(f"Resolve didn't give {name}'s nodes")
    index = _labelled(graph, want)
    if index:
        return {"index": index, "label": want, "template": False, "ungraded": False}
    graded = _graded(graph)
    template = template_path()
    if not graded and template.is_file():
        if not graph.ApplyGradeFromDRX(str(template), 0):
            raise HostError(f"{name}: Resolve didn't put VibeCut's node template on")
        graph = item.GetNodeGraph()
        index = _labelled(graph, want)
        if index:
            return {"index": index, "label": want, "template": True, "ungraded": True}
        graph.ResetAllGrades()
        raise HostError(f"VibeCut's node template has no node labelled {want!r}: save it again")
    count = int(graph.GetNumNodes() or 0)
    if count == 1 and not str(graph.GetNodeLabel(1) or "").strip():
        return {"index": 1, "label": None, "template": False, "ungraded": not graded}
    raise HostError(
        f"{name}'s grade has no node labelled {want!r} for VibeCut to use: in the Color page, label one "
        f"(right-click it, Node Label), or save a node template with one (save_color_template)"
    )


class _Grade:
    """VibeCut's CDL on one clip: the node is found (the template put on if need be) when it's first set."""

    def __init__(self, item: Any, role: str) -> None:
        self.item, self.role = item, role
        self.node: dict[str, Any] | None = None

    def set(self, cdl: dict[str, Any]) -> None:
        if self.node is None:
            self.node = _node(self.item, self.role)
        if not self.item.SetCDL({**cdl, "NodeIndex": str(self.node["index"])}):
            raise HostError(f"{self.item.GetName()}: Resolve didn't take the colour")

    def abandon(self) -> None:
        """A change that wasn't made: the template VibeCut put on for it is taken off again."""
        if self.node is not None and self.node["template"]:
            self.item.GetNodeGraph().ResetAllGrades()


def _timecode(timeline: Any, fps: float, at: float) -> str:
    """The timecode `at` seconds from the timeline's start."""
    return frames_to_timecode(timecode_to_frames(timeline.GetStartTimecode(), fps) + _to_frame(at, fps), fps)


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
        if not self.timeline.SetCurrentTimecode(_timecode(self.timeline, self.fps, at)):
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
    timeline: Any, item_id: str, index: int, grade: _Grade, after: dict[str, float], **extra: Any
) -> dict[str, Any]:
    item = grade.item
    media = item.GetMediaPoolItem()
    return {
        "kind": "color", "itemId": item_id, "name": item.GetName(), "track": ["video", index],
        "start": _seconds(int(item.GetStart()) - int(timeline.GetStartFrame()), _frame_rate(timeline)),
        "mediaId": media.GetUniqueId() if media is not None else None,
        "before": None, "after": after, "node": grade.node, **extra,
    }  # fmt: skip


def set_clip_color(host: Any, args: dict[str, Any]) -> dict[str, Any]:
    """{timeline, looks: [{itemId, exposure?, contrast?, temperature?, tint?, saturation?}]} -> sets each
    picture clip's look (fields left out neutral) as a CDL in its "VC Match" node (`_node`)."""
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
        grade = _Grade(item, "match")
        try:
            grade.set(colour.cdl(want["look"]))
        except HostError as exc:
            grade.abandon()
            refused.append({"itemId": item_id, "reason": str(exc)})
            continue
        changes.append(_change(timeline, item_id, index, grade, want["look"]))
    return {"changes": changes, "refused": refused}


def match_clip_color(host: Any, args: dict[str, Any]) -> dict[str, Any]:
    """{timeline, referenceId | referenceLook, itemIds} -> each clip made to match the reference: a clip
    as Resolve shows it by its parade, with a CDL as curves (`_match_parade`), or a look learned
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
            grade = _Grade(item, "match")

            def render(look: dict[str, float], grade: _Grade = grade, at: float = at) -> dict[str, float]:
                grade.set(colour.cdl(look))
                return viewer.frame(at)

            try:
                look, seen, passes = colour.match(
                    reference, dict(colour.NEUTRAL), render, colour.STYLE_LIMITS
                )
            except HostError as exc:
                grade.abandon()
                refused.append({"itemId": item_id, "reason": str(exc)})
                continue
            changes.append(
                _change(timeline, item_id, index, grade, look, reference=reference, seen=seen, passes=passes,
                        distance=round(colour.error(reference, seen), 4))
            )  # fmt: skip
    finally:
        viewer.close()
    return {"changes": changes, "refused": refused, "reference": reference}


def _parade_show(grade: _Grade, viewer: _Viewer, moments: list[float]) -> Any:
    """`show` for parade.match: the look set as `grade`'s CDL (None: left as it is), then the clip's
    frames, pooled."""

    def show(look: parade.Look | None) -> parade.Pixels:
        if look is not None:
            grade.set(parade.cdl(look))
        return viewer.pooled(moments)

    return show


def _match_parade(
    project: Any, timeline: Any, found: dict[str, tuple[str, int, Any]], reference_id: str, targets: list[str]
) -> dict[str, Any]:
    """Each clip's "VC Match" CDL set so its parade and histogram match the reference clip's
    (parade.match), measured on parade.FRAMES frames of each."""
    fps = _frame_rate(timeline)
    ref_moments = _moments(timeline, found, reference_id, fps, parade.FRAMES)[1]
    viewer = _Viewer(project, timeline)
    changes, refused = [], []
    try:
        reference = parade.parade(viewer.pooled(ref_moments))
        for item_id in targets:
            grade = None
            try:
                item, moments = _moments(timeline, found, item_id, fps, parade.FRAMES)
                grade = _Grade(item, "match")
                look, seen, passes = parade.match(
                    reference, _parade_show(grade, viewer, moments), parade.resolve_curve
                )
            except (HostError, colour.ColourError) as exc:
                if grade is not None:
                    grade.abandon()
                refused.append({"itemId": item_id, "reason": str(exc)})
                continue
            distance = round(parade.error(reference, seen), 4)
            changes.append(
                _change(timeline, item_id, found[item_id][1], grade, look, method="parade", reference=reference,
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
    its "VC Balance" CDL as curves that make what's there read alike in each channel, its exposure
    brought into range. A clip already there is left alone (`balanced`), its grade untouched."""
    project, timeline = host._timeline(args)
    fps = _frame_rate(timeline)
    found = _items(timeline)
    viewer = _Viewer(project, timeline)
    changes, refused, balanced = [], [], []
    try:
        for want in wants:
            item_id = want["itemId"]
            grade = None
            try:
                item, at = _balance_moment(timeline, found, item_id, fps, want["at"])
                grade = _Grade(item, "balance")

                def show(look: parade.Look | None, grade: _Grade = grade, at: float = at) -> parade.Pixels:
                    if look is not None:
                        grade.set(parade.cdl(look))
                    return viewer.pixels(at, trim=False)

                result = parade.balance(show, parade.resolve_curve, want["areas"])
            except (HostError, colour.ColourError) as exc:
                if grade is not None:
                    grade.abandon()
                refused.append({"itemId": item_id, "reason": str(exc)})
                continue
            if result.get("balanced"):
                balanced.append({"itemId": item_id, "name": item.GetName(), "was": result["was"]})
                continue
            changes.append(
                _change(timeline, item_id, found[item_id][1], grade, result["look"], method="parade",
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


def revert_color(item: Any, change: dict[str, Any], source: Any) -> tuple[str, str]:
    """("reverted" | "changed" | "failed", why not): a labelled node set back to neutral; node 1 of a
    clip that had no grade reset; otherwise the grade copied back from the clip's copy on the backup
    timeline (a change from before nodes were recorded, too)."""
    node = change.get("node") or {}
    name = item.GetName()
    if node.get("label"):
        index = _labelled(item.GetNodeGraph(), node["label"])
        if not index:
            return "changed", f"it has no node labelled {node['label']!r} any more"
        if not item.SetCDL({**NEUTRAL_CDL, "NodeIndex": str(index)}):
            return "failed", f"Resolve didn't set {name}'s {node['label']!r} node back"
        return "reverted", ""
    if node.get("ungraded"):
        graph = item.GetNodeGraph()
        if int(graph.GetNumNodes() or 0) == 1:
            done = graph.ResetAllGrades()
        else:
            done = item.SetCDL({**NEUTRAL_CDL, "NodeIndex": "1"})
        return ("reverted", "") if done else ("failed", f"Resolve didn't reset {name}'s grade")
    if source is None or not source.CopyGrades([item]):
        return "failed", "its grade couldn't be copied back from the backup timeline"
    return "reverted", ""


def save_node_template(host: Any, args: dict[str, Any]) -> dict[str, Any]:
    """{timeline, itemId} -> {saved, name, nodes, labels, otherNodes}: the clip's grade saved as VibeCut's
    node template (`template_path`), for clips with no grade of their own. The clip must have empty nodes
    labelled with NODE_LABELS; its other nodes go with it (a colour space transform, a node for the user's
    own grade). Resolve grabs stills only on the Color page, so the page is switched there for the grab
    and put back, as is the playhead; the still is taken out of the gallery again."""
    item_id = args.get("itemId")
    if not isinstance(item_id, str) or not item_id:
        raise HostError("itemId must be the timeline clip whose nodes to save")
    project, timeline = host._timeline(args)
    current = project.GetCurrentTimeline()
    if not current or current.GetName() != timeline.GetName():
        raise HostError(f"{timeline.GetName()!r} must be the timeline open in Resolve to save a clip's nodes")
    fps = _frame_rate(timeline)
    found = _items(timeline)
    item, at = _moment(timeline, found, item_id, fps)
    name = item.GetName()
    graph = item.GetNodeGraph()
    if graph is None:
        raise HostError(f"Resolve didn't give {name}'s nodes")
    labels: dict[str, int] = {}
    for label in NODE_LABELS.values():
        index = _labelled(graph, label)
        if not index:
            raise HostError(
                f"{name} has no node labelled {label!r}: in the Color page, add a node for it, right-click "
                "it and choose Node Label"
            )
        if graph.GetToolsInNode(index):
            raise HostError(f"{name}'s {label!r} node isn't empty: reset it (VibeCut fills it)")
        labels[label] = index
    others = [
        {"node": i, "label": str(graph.GetNodeLabel(i) or ""), "tools": list(graph.GetToolsInNode(i) or [])}
        for i in range(1, int(graph.GetNumNodes() or 0) + 1)
        if i not in labels.values()
    ]
    resolve = host._resolve
    page = resolve.GetCurrentPage()
    playhead = timeline.GetCurrentTimecode()
    folder = tempfile.mkdtemp(prefix="vibecut-template-")
    try:
        if page != "color" and not resolve.OpenPage("color"):
            raise HostError("Resolve didn't open the Color page to grab the clip's grade")
        timeline.SetCurrentTimecode(_timecode(timeline, fps, at))
        shown = timeline.GetCurrentVideoItem()
        if shown is None or shown.GetUniqueId() != item_id:
            raise HostError(f"Resolve's Color page didn't go to {name}")
        still = timeline.GrabStill()
        if not still:
            raise HostError(f"Resolve didn't grab a still of {name}'s grade")
        album = project.GetGallery().GetCurrentStillAlbum()
        try:
            exported = album.ExportStills([still], folder, "vibecut-node-template", "drx")
        finally:
            album.DeleteStills([still])
        drx = [f for f in os.listdir(folder) if f.lower().endswith(".drx")]
        if not exported or len(drx) != 1:
            raise HostError(f"Resolve didn't export {name}'s grade")
        saved = template_path()
        saved.parent.mkdir(parents=True, exist_ok=True)
        shutil.move(os.path.join(folder, drx[0]), saved)
    finally:
        if playhead:
            timeline.SetCurrentTimecode(playhead)
        if page and resolve.GetCurrentPage() != page:
            resolve.OpenPage(page)
        shutil.rmtree(folder, ignore_errors=True)
    return {"saved": str(saved), "name": name, "nodes": int(graph.GetNumNodes() or 0), "labels": labels,
            "otherNodes": others}  # fmt: skip
