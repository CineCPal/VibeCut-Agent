"""resolve_transform.py -- scale and position of clips on the connected Resolve timeline (PLAN.md,
"Phase 16f"), with the same requests and change records as premiere_transform.py.

A still look is the clip's Inspector transform: ZoomX and ZoomY (1.0 is 100%), Pan and Tilt (the
timeline's pixels from the centre, Tilt up), set with `SetProperties` and read back.

Resolve's scripting can't keyframe the Inspector (TimelineItem has no keyframe calls in 21.1), so an
animated look is a Fusion composition on the clip named "VibeCut Move": MediaIn1 -> a Transform named
VibeCutMove -> MediaOut1, its Size and Center keyed at the clip's frames (Center 0-1 across the frame,
y up). The Inspector transform is set back to 100% at the centre so the keys say the whole look. Every
key is read back; when Resolve didn't take them the comp is removed and the clip refused. A clip with
a Fusion composition of its own is refused rather than have it stacked on. A still look on a clip with
VibeCut's move replaces the move.

Seen live in 21.1: the keys are the modifiers' (BezierSpline) keys, in comp frames from
COMPN_RenderStart; the Transform's own GetKeyFrames() answers its valid range instead. And a clip's
active comp can't be deleted (DeleteFusionCompByName answers False), so a clip's only comp never can:
a move is removed by taking the Transform out and wiring MediaIn1 straight to MediaOut1, leaving a
pass-through "VibeCut Move" that counts as no move and is reused by the next one.

Also seen live: Resolve renders a comp changed by script calls as it was before them, though the comp
reads back and exports changed. So after each change the comp is exported and imported again
(`_reload`), which Resolve renders. An import onto the clip replaced its only comp in place.
"""

from __future__ import annotations

import os
import tempfile
from typing import Any

from vibecut_agent.nle.resolve import HostError, _frame_size, _speed, _to_frame
from vibecut_agent.nle.resolve import frame_rate as _frame_rate
from vibecut_agent.nle.resolve_edit import _items
from vibecut_agent.nle.transforms import first, rounded, transform_wants

MOVE_COMP = "VibeCut Move"
MOVE_TOOL = "VibeCutMove"
NEUTRAL = {"ZoomX": 1.0, "ZoomY": 1.0, "Pan": 0.0, "Tilt": 0.0}


def _frame(timeline: Any) -> tuple[float, float]:
    size = _frame_size(timeline)
    if not size:
        raise HostError("Resolve didn't say the timeline's resolution, so a position can't be set")
    return float(size["width"]), float(size["height"])


def _inspector(item: Any) -> dict[str, float]:
    props = item.GetProperty() or {}
    return {k: float(props[k]) if isinstance(props.get(k), (int, float)) else v for k, v in NEUTRAL.items()}


def _comps(item: Any) -> list[str]:
    return [str(n) for n in item.GetFusionCompNameList() or []]


def _start(comp: Any) -> int:
    """The comp frame of the clip's first frame."""
    attrs = comp.GetAttrs() or {}
    for key in ("COMPN_RenderStart", "COMPN_GlobalStart"):
        if isinstance(attrs.get(key), (int, float)):
            return round(float(attrs[key]))
    return 0


def _point(value: Any) -> list[float]:
    """Fusion's point, {1: x, 2: y, 3: z} or [x, y], as [x, y]."""
    if isinstance(value, dict):
        x, y = value.get(1, value.get(1.0)), value.get(2, value.get(2.0))
        return [float(x if x is not None else 0.5), float(y if y is not None else 0.5)]
    return [float(value[0]), float(value[1])]


def _passes_through(comp: Any) -> bool:
    """Whether the comp is only MediaIn -> MediaOut (a removed move)."""
    tools = (comp.GetToolList(False) or {}).values()
    return all((t.GetAttrs() or {}).get("TOOLS_RegID") in ("MediaIn", "MediaOut") for t in tools)


def _key_frames(comp: Any) -> list[int]:
    """The comp frames its splines are keyed at."""
    splines = (comp.GetToolList(False, "BezierSpline") or {}).values()
    return sorted({round(float(f)) for s in splines for f in (s.GetKeyFrames() or {})})


def _move(item: Any) -> list[dict[str, Any]] | None:
    """VibeCut's move on the clip as [{frame (from the clip's start), size, center: [x, y]}], or None."""
    if MOVE_COMP not in _comps(item):
        return None
    comp = item.GetFusionCompByName(MOVE_COMP)
    tool = comp.FindTool(MOVE_TOOL) if comp else None
    if tool is None:
        if comp and _passes_through(comp):
            return None
        raise HostError(f"its {MOVE_COMP} composition was changed in Fusion; change it there")
    start = _start(comp)
    frames = _key_frames(comp)
    if not frames:
        frames = [start]
    return [
        {
            "frame": f - start,
            "size": float(tool.GetInput("Size", f)),
            "center": _point(tool.GetInput("Center", f)),
        }
        for f in frames
    ]


def _state(item: Any) -> dict[str, Any]:
    """What a revert puts back: the Inspector transform and VibeCut's move."""
    return {"inspector": _inspector(item), "move": _move(item)}


def _look(state: dict[str, Any], width: float, height: float, fps: float) -> dict[str, Any]:
    """The look in transforms.py's units (the Inspector applies after the move)."""
    inspector = state["inspector"]
    zoom, pan, tilt = inspector["ZoomX"], inspector["Pan"], inspector["Tilt"]
    if not state["move"]:
        return {"scale": zoom * 100, "x": pan, "y": tilt}
    return {
        "keys": [
            {
                "at": k["frame"] / fps,
                "scale": k["size"] * zoom * 100,
                "x": (k["center"][0] - 0.5) * width * zoom + pan,
                "y": (k["center"][1] - 0.5) * height * zoom + tilt,
            }
            for k in state["move"]
        ]
    }


def _same_state(a: dict[str, Any], b: dict[str, Any]) -> bool:
    if any(abs(a["inspector"][k] - b["inspector"][k]) > 1e-4 for k in NEUTRAL):
        return False
    ma, mb = a.get("move") or [], b.get("move") or []
    return len(ma) == len(mb) and all(
        x["frame"] == y["frame"]
        and abs(x["size"] - y["size"]) < 1e-4
        and all(abs(p - q) < 1e-4 for p, q in zip(x["center"], y["center"]))
        for x, y in zip(ma, mb)
    )


def _remove_move(item: Any) -> bool:
    """Deletes VibeCut's comp, or, when Resolve won't, leaves it passing the clip through."""
    if item.DeleteFusionCompByName(MOVE_COMP):
        return True
    comp = item.GetFusionCompByName(MOVE_COMP)
    if comp is None:
        return False
    comp.Lock()
    try:
        tool, source, sink = comp.FindTool(MOVE_TOOL), comp.FindTool("MediaIn1"), comp.FindTool("MediaOut1")
        if tool is not None:
            tool.Delete()
        if source is None or sink is None:
            return False
        sink.ConnectInput("Input", source)
    finally:
        comp.Unlock()
    if not _reload(item):
        return False
    comp = item.GetFusionCompByName(MOVE_COMP)
    return comp is not None and _passes_through(comp)


def _reload(item: Any) -> bool:
    """Exports VibeCut's comp and imports it again, so Resolve renders it as it now is."""
    before = _comps(item)
    with tempfile.TemporaryDirectory(prefix="vibecut-move-") as folder:
        path = os.path.join(folder, "move.comp")
        if not item.ExportFusionComp(path, before.index(MOVE_COMP) + 1) or not item.ImportFusionComp(path):
            return False
    after = _comps(item)
    if len(after) > len(before):
        # Added beside the old one, which is no longer the active comp and so can be deleted.
        added = [n for n in after if n not in before] or after[-1:]
        if not item.DeleteFusionCompByName(MOVE_COMP):
            return False
        return added[0] == MOVE_COMP or bool(item.RenameFusionCompByName(added[0], MOVE_COMP))
    return MOVE_COMP in after


def _make_move(item: Any, move: list[dict[str, Any]]) -> None:
    comp = item.GetFusionCompByName(MOVE_COMP) if MOVE_COMP in _comps(item) else None
    if comp is None:
        before = set(_comps(item))
        comp = item.AddFusionComp()
        if not comp:
            raise HostError("Resolve didn't add a Fusion composition")
        added = [n for n in _comps(item) if n not in before]
        if added and added[0] != MOVE_COMP:
            item.RenameFusionCompByName(added[0], MOVE_COMP)
    comp.Lock()
    try:
        source, sink = comp.FindTool("MediaIn1"), comp.FindTool("MediaOut1")
        if source is None or sink is None:
            raise HostError("Resolve's new Fusion composition has no MediaIn1 and MediaOut1")
        tool = comp.AddTool("Transform", -32768, -32768)
        tool.SetAttrs({"TOOLS_Name": MOVE_TOOL})
        tool.ConnectInput("Input", source)
        sink.ConnectInput("Input", tool)
        start = _start(comp)
        if len(move) > 1:
            tool.AddModifier("Size", "BezierSpline")
            tool.AddModifier("Center", "XYPath")
        for key in move:
            at = start + key["frame"]
            tool.SetInput("Size", key["size"], at)
            tool.SetInput("Center", {1: key["center"][0], 2: key["center"][1]}, at)
    finally:
        comp.Unlock()
    if not _reload(item):
        raise HostError("Resolve didn't load the move")


def _apply(item: Any, state: dict[str, Any]) -> bool:
    """Puts the clip in `state`; whether Resolve took it all."""
    ok = bool(item.SetProperties(dict(state["inspector"])))
    if MOVE_COMP in _comps(item):
        ok = _remove_move(item) and ok
    if state["move"]:
        _make_move(item, state["move"])
    try:
        return ok and _same_state(_state(item), state)
    except HostError:
        return False


def _wanted(
    item: Any, state: dict[str, Any], want: dict[str, Any], fps: float, width: float, height: float
) -> dict[str, Any]:
    """The state the clip should end in, or a HostError saying why it's refused."""
    now = first(_look(state, width, height, fps))
    fields = set(want.get("set") or want["keys"][0]) - {"at"}
    inspector = state["inspector"]
    uneven = abs(inspector["ZoomX"] - inspector["ZoomY"]) > 1e-4
    if uneven and ("scale" in fields or "keys" in want):
        raise HostError("its Zoom X and Y differ; change its zoom in Resolve")
    if "set" in want:
        values = {**now, **want["set"]}
        zoom = values["scale"] / 100
        return {
            "inspector": {**inspector, "ZoomX": zoom, "ZoomY": zoom, "Pan": values["x"], "Tilt": values["y"]},
            "move": None,
        }
    if any(n != MOVE_COMP for n in _comps(item)):
        raise HostError("it has a Fusion composition of its own; animate it in Resolve's Fusion page")
    if abs(_speed(item) - 1) > 1e-6:
        raise HostError("it has a speed change; animate it in Resolve")
    length = int(item.GetEnd()) - int(item.GetStart())
    frames = [_to_frame(k["at"], fps) for k in want["keys"]]
    if frames[-1] > length:
        raise HostError(f"a keyframe is past its end ({length / fps:.2f} s long)")
    if len(set(frames)) != len(frames):
        raise HostError("two keyframes fall on the same frame")
    move = []
    for frame, key in zip(frames, want["keys"]):
        values = {**now, **{f: key[f] for f in fields}}
        move.append(
            {
                "frame": frame,
                "size": values["scale"] / 100,
                "center": [0.5 + values["x"] / width, 0.5 + values["y"] / height],
            }
        )
    return {"inspector": dict(NEUTRAL), "move": move}


def set_clip_transform(host: Any, args: dict[str, Any]) -> dict[str, Any]:
    """{timeline, transforms: [{itemId, scale?, x?, y?} | {itemId, keyframes: [{at, scale?, x?, y?}]}]}
    -> sets each picture clip's scale and position, still in the Inspector or keyed in a Fusion move."""
    wants = transform_wants(args)
    _project, timeline = host._timeline(args)
    fps = _frame_rate(timeline)
    width, height = _frame(timeline)
    found = _items(timeline)
    changes, refused = [], []
    for want in wants:
        item_id = want["itemId"]
        if item_id not in found:
            raise HostError(f"There is no clip {item_id!r} on the connected timeline any more")
        kind, index, item = found[item_id]
        name = item.GetName()
        if kind != "video" or item.GetLeftOffset() is None:
            what = "sound has" if kind != "video" else "a transition or generator has"
            refused.append({"itemId": item_id, "reason": f"{name}: {what} no picture to scale or move"})
            continue
        try:
            before = _state(item)
            target = _wanted(item, before, want, fps, width, height)
        except HostError as exc:
            refused.append({"itemId": item_id, "reason": f"{name}: {exc}"})
            continue
        if _same_state(before, target):
            continue
        try:
            took = _apply(item, target)
        except HostError:
            took = False
        if not took:
            try:
                _apply(item, before)
            except HostError:
                pass  # the request's backup timeline still has the clip as it was
            refused.append(
                {"itemId": item_id, "reason": f"{name}: Resolve didn't take the scale or position"}
            )
            continue
        changes.append({
            "kind": "transform", "itemId": item_id, "name": name, "track": [kind, index],
            "before": rounded(_look(before, width, height, fps)), "after": rounded(_look(target, width, height, fps)),
            "state": {"before": before, "after": target},
        })  # fmt: skip
    return {"changes": changes, "refused": refused}


def read_clip_transforms(host: Any, args: dict[str, Any]) -> dict[str, Any]:
    """{timeline, itemIds} -> {clips: [{itemId, name, scale, x, y} or {itemId, name, keys}], refused}."""
    ids = args.get("itemIds")
    if (
        not isinstance(ids, list)
        or not ids
        or len(ids) > 200
        or not all(isinstance(i, str) and i for i in ids)
    ):
        raise HostError("itemIds must list 1 to 200 timeline clip ids")
    _project, timeline = host._timeline(args)
    fps = _frame_rate(timeline)
    width, height = _frame(timeline)
    found = _items(timeline)
    out, refused = [], []
    for item_id in dict.fromkeys(ids):
        if item_id not in found:
            raise HostError(f"There is no clip {item_id!r} on the connected timeline any more")
        kind, _index, item = found[item_id]
        name = item.GetName()
        if kind != "video" or item.GetLeftOffset() is None:
            refused.append({"itemId": item_id, "reason": f"{name} has no picture to scale or move"})
            continue
        try:
            look = _look(_state(item), width, height, fps)
        except HostError as exc:
            refused.append({"itemId": item_id, "reason": f"{name}: {exc}"})
            continue
        out.append({"itemId": item_id, "name": name, **rounded(look)})
    return {"clips": out, "refused": refused}


def revert_transform(item: Any, change: dict[str, Any]) -> str:
    """ "reverted", "changed" (its transform isn't what the change left) or "failed"."""
    saved = change.get("state") or {}
    if not all(isinstance(saved.get(k), dict) for k in ("before", "after")):
        return "changed"
    try:
        if not _same_state(_state(item), saved["after"]):
            return "changed"
    except HostError:
        return "changed"
    try:
        return "reverted" if _apply(item, saved["before"]) else "failed"
    except HostError:
        return "failed"
