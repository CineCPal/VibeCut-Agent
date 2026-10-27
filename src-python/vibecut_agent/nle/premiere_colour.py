"""premiere_colour.py -- colour on the connected Premiere sequence (PLAN.md, "Phase 19c"), with the same
requests and change records as resolve_colour.py.

A look (colour.py) is the clip's Lumetri Color Basic Correction: Exposure, Contrast, Temperature, Tint
and Saturation, set by the panel (host.jsx `vcSetLumetri`, panel 0.14.0), which first adds Lumetri Color
through QE to a clip without one. The other Lumetri controls are left as they are. The values before are
read, so Revert puts them back (a Lumetri VibeCut added stays, set neutral), and leaves a clip whose
values were changed since.

To measure a clip, the panel's `export_frame` writes the sequence's frame (Lumetri and effects included)
with QE's exportFramePNG into the bridge folder's frames/, the playhead put back after. A moment where a
clip on a higher track covers the clip is avoided; a clip covered all through or switched off, or on a
track whose output is off, is refused.
"""

from __future__ import annotations

import os
import time
import uuid
from typing import Any

from vibecut_agent.nle import colour
from vibecut_agent.nle.premiere import TICKS_PER_SECOND, HostError
from vibecut_agent.nle.premiere_bridge import default_dir
from vibecut_agent.nle.premiere_edit import Sequence, _read

FRAME_WAIT_S = 15.0


def _lumetri_of(host: Any, timeline: str, ids: list[str]) -> dict[str, dict[str, Any]]:
    return {m["id"]: m for m in host._send("read_lumetri", {"timeline": timeline, "ids": ids})["items"]}


def _look(read: dict[str, Any]) -> dict[str, float]:
    """The clip's look: its Lumetri values, neutral where it has no Lumetri."""
    values = read.get("values") or {}
    return colour.clamp({k: float(values.get(k, colour.NEUTRAL[k])) for k in colour.FIELDS})


def _set(host: Any, timeline: str, item_id: str, look: dict[str, float]) -> dict[str, Any]:
    items = host._send("set_lumetri", {"timeline": timeline, "items": [{"id": item_id, "values": look}]})[
        "items"
    ]
    return dict(items[0])


def _same(a: dict[str, float], b: dict[str, float]) -> bool:
    return all(abs(a[k] - b[k]) < 0.01 for k in colour.FIELDS)


def _moment(seq: Sequence, item_id: str) -> tuple[dict[str, Any], int]:
    """The picture clip and the ticks to look at it (not under a clip on a higher track)."""
    clip = seq.clip(item_id)
    if clip["kind"] != "video":
        raise HostError(f"{clip['name']} is sound, with no picture to colour")
    tracks = seq.tracks["video"]
    if clip.get("disabled") or tracks[clip["index"] - 1].get("muted"):
        raise HostError(f"{clip['name']} is switched off (or its track's output is), so it can't be seen")
    covers = [
        (int(c["startTicks"]), int(c["endTicks"]))
        for above in tracks[clip["index"] :]
        if not above.get("muted")
        for c in above.get("clips", [])
        if not c.get("disabled")
    ]
    at = colour.uncovered_moment(int(clip["startTicks"]), int(clip["endTicks"]), covers)
    if at is None:
        raise HostError(f"{clip['name']} is covered all through by clips on tracks above it")
    # On a frame, so the export shows this clip's frame and not a neighbour's.
    return clip, int(at) // seq.timebase * seq.timebase


def _frame(host: Any, timeline: str, ticks: int) -> dict[str, float]:
    """The measures of the sequence's frame at `ticks`, as Premiere renders it."""
    name = f"colour-{uuid.uuid4().hex[:12]}"
    path = str(host._send("export_frame", {"timeline": timeline, "ticks": str(ticks), "name": name})["path"])
    if os.path.dirname(path) != str(default_dir() / "frames"):
        raise HostError("Premiere wrote the frame somewhere unexpected")
    deadline = time.monotonic() + FRAME_WAIT_S
    size = -1
    try:
        # exportFramePNG can return before the file is whole.
        while True:
            now = os.path.getsize(path) if os.path.isfile(path) else -1
            if now > 0 and now == size:
                break
            if time.monotonic() > deadline:
                raise HostError("Premiere didn't write the frame")
            size = now
            time.sleep(0.15)
        return colour.measure(colour.frame_pixels(path))
    except colour.ColourError as exc:
        raise HostError(str(exc)) from None
    finally:
        if os.path.isfile(path):
            os.remove(path)


def _change(
    clip: dict[str, Any], before: dict[str, Any], after: dict[str, Any], **extra: Any
) -> dict[str, Any]:
    return {
        "kind": "color", "itemId": clip["id"], "name": clip["name"], "track": [clip["kind"], clip["index"]],
        "before": _look(before) if before.get("present") else None, "after": _look(after),
        "lumetri": {"before": before, "after": after}, **extra,
    }  # fmt: skip


def set_clip_color(host: Any, args: dict[str, Any]) -> dict[str, Any]:
    """{timeline, looks: [{itemId, exposure?, contrast?, temperature?, tint?, saturation?}]} -> sets each
    picture clip's Lumetri Basic Correction (fields left out neutral)."""
    try:
        wants = colour.look_wants(args)
    except colour.ColourError as exc:
        raise HostError(str(exc)) from None
    timeline = host._name(args)
    seq = _read(host, timeline)
    clips = [seq.clip(w["itemId"]) for w in wants]
    pictures = [c["id"] for c in clips if c["kind"] == "video"]
    befores = _lumetri_of(host, timeline, pictures) if pictures else {}
    changes, refused = [], []
    for want, clip in zip(wants, clips, strict=True):
        if clip["kind"] != "video":
            refused.append(
                {"itemId": clip["id"], "reason": f"{clip['name']} is sound, with no picture to colour"}
            )
            continue
        before = befores[clip["id"]]
        if before.get("keyed"):
            refused.append(
                {
                    "itemId": clip["id"],
                    "reason": f"{clip['name']}: its Lumetri {', '.join(before['keyed'])} has keyframes",
                }
            )
            continue
        after = _set(host, timeline, clip["id"], want["look"])
        if not _same(_look(after), want["look"]):
            refused.append(
                {"itemId": clip["id"], "reason": f"{clip['name']}: Premiere didn't take the colour"}
            )
        changes.append(_change(clip, before, after))
    return {"changes": changes, "refused": refused}


def match_clip_color(host: Any, args: dict[str, Any]) -> dict[str, Any]:
    """{timeline, referenceId, itemIds} -> each clip's Lumetri set to match the reference as Premiere
    renders it (colour.match: measure, step, apply, up to colour.MATCH_PASSES passes)."""
    try:
        reference_id, targets = colour.match_wants(args)
    except colour.ColourError as exc:
        raise HostError(str(exc)) from None
    timeline = host._name(args)
    seq = _read(host, timeline)
    _ref, ref_at = _moment(seq, reference_id)
    reference = _frame(host, timeline, ref_at)
    changes, refused = [], []
    for item_id in targets:
        try:
            clip, at = _moment(seq, item_id)
        except HostError as exc:
            refused.append({"itemId": item_id, "reason": str(exc)})
            continue
        before = _lumetri_of(host, timeline, [item_id])[item_id]
        if before.get("keyed"):
            refused.append(
                {
                    "itemId": item_id,
                    "reason": f"{clip['name']}: its Lumetri {', '.join(before['keyed'])} has keyframes",
                }
            )
            continue
        last: dict[str, Any] = {}

        def render(
            look: dict[str, float], item_id: str = item_id, at: int = at, last: dict[str, Any] = last
        ) -> dict[str, float]:
            # match() leaves its best look applied last, so this is what the clip ends with.
            last["after"] = _set(host, timeline, item_id, look)
            return _frame(host, timeline, at)

        try:
            _best, seen, passes = colour.match(reference, _look(before), render)
        except HostError as exc:
            if "after" in last:
                _set(host, timeline, item_id, _look(before))
            refused.append({"itemId": item_id, "reason": f"{clip['name']}: {exc}"})
            continue
        changes.append(
            _change(clip, before, last["after"], reference=reference, seen=seen, passes=passes,
                    distance=round(colour.error(reference, seen), 4))
        )  # fmt: skip
    return {"changes": changes, "refused": refused, "reference": reference}


def read_clip_color(host: Any, args: dict[str, Any]) -> dict[str, Any]:
    """{timeline, itemIds} -> {clips: [{itemId, name, at, brightness, contrast, warmth, tint, colour,
    look}], refused}: each clip's frame as Premiere renders it, measured, and its Lumetri look."""
    ids = args.get("itemIds")
    if (
        not isinstance(ids, list)
        or not ids
        or len(ids) > colour.MAX_ITEMS
        or not all(isinstance(i, str) and i for i in ids)
    ):
        raise HostError(f"itemIds must list 1 to {colour.MAX_ITEMS} timeline clip ids")
    timeline = host._name(args)
    seq = _read(host, timeline)
    out, refused = [], []
    for item_id in dict.fromkeys(ids):
        try:
            clip, at = _moment(seq, item_id)
            read = _lumetri_of(host, timeline, [item_id])[item_id]
            measured = _frame(host, timeline, at)
        except HostError as exc:
            refused.append({"itemId": item_id, "reason": str(exc)})
            continue
        out.append({
            "itemId": item_id, "name": clip["name"], "at": round(at / TICKS_PER_SECOND, 3),
            **measured, "look": _look(read),
        })  # fmt: skip
    return {"clips": out, "refused": refused}


def revert_color(host: Any, timeline: str, seq: Sequence, item_id: str, change: dict[str, Any]) -> str:
    """ "reverted" or "changed" (its Lumetri isn't what the change left)."""
    saved = change.get("lumetri") or {}
    if not all(isinstance(saved.get(k), dict) for k in ("before", "after")):
        return "changed"
    now = _lumetri_of(host, timeline, [item_id]).get(item_id)
    if now is None or not now.get("present") or not _same(_look(now), _look(saved["after"])):
        return "changed"
    after = _set(host, timeline, item_id, _look(saved["before"]))
    return "reverted" if _same(_look(after), _look(saved["before"])) else "failed"
