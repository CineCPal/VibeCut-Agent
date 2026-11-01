"""premiere_colour.py -- colour on the connected Premiere sequence (PLAN.md, "Phase 19c"), with the same
requests and change records as resolve_colour.py.

A look (colour.py) is the clip's Lumetri Color Basic Correction: Exposure, Contrast, Temperature, Tint
and Saturation, set by the panel (host.jsx `vcSetLumetri`, panel 0.14.0), which first adds Lumetri Color
through QE to a clip without one. The other Lumetri controls are left as they are. The values before are
read, so Revert puts them back, or takes off a Lumetri VibeCut added (panel 0.16.0 `remove_effect`), and
leaves a clip whose values were changed since.

Matching to a clip and balancing (Phase 20b) go by the parade instead (parade.py), each in an effect of
its own (EFFECTS), so a match doesn't overwrite a balance: matching sets a curve per channel in the Levels
effect (host.jsx `vcSetLevels`, panel 0.15.0), its RGB controls left neutral, and Lumetri's Saturation;
balancing sets the ASC CDL effect (`vcSetCdl`, panel 0.16.0: slope, offset and power per channel, the CDL
formula on display values as Resolve's, so parade.resolve_curve). Premiere's scripting can't name an
effect, so the kind of effect tells them apart. Each is added through QE when the clip has none, where
Premiere puts it in the stack (not always last; the fit measures the clip as shown, so it closes in
wherever it is). Revert puts the values back the same way, or takes off the effect the change added.

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

from vibecut_agent.nle import colour, parade
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
    clip, moments = _moments(seq, item_id, (0.5,))
    return clip, moments[0]


def _moments(seq: Sequence, item_id: str, shares: tuple[float, ...]) -> tuple[dict[str, Any], list[int]]:
    """The picture clip and the ticks to look at it at each of `shares` of it (as near as it's clear)."""
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
    moments = colour.uncovered_moments(int(clip["startTicks"]), int(clip["endTicks"]), covers, shares)
    if not moments:
        raise HostError(f"{clip['name']} is covered all through by clips on tracks above it")
    # On a frame, so the export shows this clip's frame and not a neighbour's.
    return clip, list(dict.fromkeys(int(at) // seq.timebase * seq.timebase for at in moments))


def _frame(host: Any, timeline: str, ticks: int, measuring: Any = colour.measure) -> dict[str, float]:
    """The measures (`measuring`'s) of the sequence's frame at `ticks`, as Premiere renders it."""
    return dict(measuring(_pixels(host, timeline, ticks)))


def _pixels(host: Any, timeline: str, ticks: int, trim: bool = True) -> parade.Pixels:
    """The sequence's frame at `ticks` as Premiere renders it (colour.frame_pixels; `trim` its black
    borders)."""
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
        return colour.frame_pixels(path, trim=trim)
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
    """{timeline, referenceId | referenceLook, itemIds} -> each clip made to match the reference: a clip
    as Premiere renders it by its parade, with Levels curves (`_match_parade`), or a look learned from a
    reference edit with Lumetri's Basic Correction (colour.match). {timeline, balance: true, itemIds}
    balances each clip to its own neutral instead (`_balance`)."""
    try:
        balancing = colour.balance_wants(args)
    except colour.ColourError as exc:
        raise HostError(str(exc)) from None
    if balancing is not None:
        return _balance(host, host._name(args), balancing)
    try:
        reference_id, targets, look = colour.match_wants(args)
    except colour.ColourError as exc:
        raise HostError(str(exc)) from None
    timeline = host._name(args)
    seq = _read(host, timeline)
    if look is None:
        assert reference_id is not None  # match_wants gives a clip or a look
        return _match_parade(host, timeline, seq, reference_id, targets)
    # A learned style is five overall measures, matched with Lumetri's Basic Correction.
    reference = look
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
            _best, seen, passes = colour.match(reference, _look(before), render, colour.STYLE_LIMITS)
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


# The effects matching and balancing by the parade set: the panel's commands, the effect's name, and the
# curve it applies (parade.py).
EFFECTS: dict[str, dict[str, Any]] = {
    "levels": {"name": "Levels", "read": "read_levels", "set": "set_levels", "curve": parade.premiere_curve},
    "cdl": {"name": "ASC CDL", "read": "read_cdl", "set": "set_cdl", "curve": parade.resolve_curve},
}


def _effect_of(host: Any, timeline: str, item_id: str, effect: str) -> dict[str, Any]:
    return dict(host._send(EFFECTS[effect]["read"], {"timeline": timeline, "ids": [item_id]})["items"][0])


def _set_values(
    host: Any, timeline: str, item_id: str, effect: str, values: dict[str, float]
) -> dict[str, Any]:
    items = host._send(
        EFFECTS[effect]["set"], {"timeline": timeline, "items": [{"id": item_id, "values": values}]}
    )
    return dict(items["items"][0])


def _set_effect(
    host: Any, timeline: str, item_id: str, effect: str, look: parade.Look, before: dict[str, Any]
) -> dict[str, Any]:
    """`look`'s curves set in the clip's `effect` (an ASC CDL keeps the Saturation it had)."""
    if effect == "levels":
        values = parade.levels_controls(look)
    else:
        own = float(before["values"].get("saturation", 1.0)) if before.get("present") else 1.0
        values = parade.cdl_controls(look, own)
    return _set_values(host, timeline, item_id, effect, values)


def _effect_look(effect: str, read: dict[str, Any]) -> parade.Look | None:
    """The look a clip's `effect` gives (neutral without one; None for Levels set some other way)."""
    if not read.get("present"):
        return parade.neutral_look()
    return parade.levels_look(read["values"]) if effect == "levels" else parade.cdl_look(read["values"])


def _remove(host: Any, timeline: str, item_id: str, effect: str) -> bool:
    """`effect` ("lumetri", "levels" or "cdl") taken off the clip; whether it's gone."""
    return bool(
        host._send("remove_effect", {"timeline": timeline, "id": item_id, "effect": effect})["removed"]
    )


def _pooled(host: Any, timeline: str, moments: list[int]) -> parade.Pixels:
    return [p for at in moments for p in _pixels(host, timeline, at)]


def _parade_target(
    host: Any, timeline: str, seq: Sequence, item_id: str, effect: str
) -> tuple[dict[str, Any], list[int], dict[str, Any]]:
    """A clip to change by the parade in `effect`: (clip, moments, the effect before). Refused
    (HostError) when it can't be seen, or the effect is keyframed or (Levels) set in a way VibeCut
    doesn't."""
    clip, moments = _moments(seq, item_id, parade.FRAMES)
    before = _effect_of(host, timeline, item_id, effect)
    name = EFFECTS[effect]["name"]
    if before.get("keyed"):
        raise HostError(f"{clip['name']}: its {name} {', '.join(before['keyed'])} has keyframes")
    if _effect_look(effect, before) is None:
        raise HostError(
            f"{clip['name']}: its Levels are set by hand (an RGB control, or a black input and output)"
        )
    return clip, moments, before


def _parade_change(
    clip: dict[str, Any], effect: str, before: dict[str, Any], after: dict[str, Any], **extra: Any
) -> dict[str, Any]:
    return {
        "kind": "color", "itemId": clip["id"], "name": clip["name"], "track": [clip["kind"], clip["index"]],
        "method": "parade", "effect": effect,
        "before": _effect_look(effect, before) if before.get("present") else None,
        "after": _effect_look(effect, after), effect: {"before": before, "after": after}, **extra,
    }  # fmt: skip


def _restore(host: Any, timeline: str, item_id: str, effect: str, before: dict[str, Any]) -> bool:
    """`effect` as it was: its values put back, or taken off when the clip had none."""
    if not before.get("present"):
        return _remove(host, timeline, item_id, effect)
    after = _set_values(host, timeline, item_id, effect, dict(before["values"]))
    return _same_levels(after["values"], before["values"])


def _restore_lumetri(host: Any, timeline: str, item_id: str, before: dict[str, Any]) -> bool:
    if not before.get("present"):
        return _remove(host, timeline, item_id, "lumetri")
    return _same(_look(_set(host, timeline, item_id, _look(before))), _look(before))


def _put_back(
    host: Any, timeline: str, item_id: str, effect: str, before: dict[str, Any], last: dict[str, Any]
) -> None:
    if "after" in last:
        _restore(host, timeline, item_id, effect, before)
    if "lumetri" in last:
        _restore_lumetri(host, timeline, item_id, last["lumetri_before"])


def _saturate(host: Any, timeline: str, item_id: str, multiple: float, last: dict[str, Any]) -> None:
    """Lumetri's Saturation set to the clip's own (before the match) times `multiple`, when that's
    not what it is now; what it was is kept in `last` for the change and for putting back."""
    if "lumetri_before" not in last:
        read = _lumetri_of(host, timeline, [item_id])[item_id]
        if "saturation" in read.get("keyed", []):
            raise HostError("its Lumetri Saturation has keyframes")
        last["lumetri_before"] = read
        last["saturation"] = _look(read)["saturation"]
    own = _look(last["lumetri_before"])["saturation"]
    want = round(min(max(own * multiple, colour.LIMITS["saturation"][0]), colour.LIMITS["saturation"][1]), 1)
    if abs(want - last["saturation"]) < 0.05:
        return
    items = host._send(
        "set_lumetri", {"timeline": timeline, "items": [{"id": item_id, "values": {"saturation": want}}]}
    )["items"]
    last["lumetri"] = dict(items[0])
    last["saturation"] = want


def _match_parade(
    host: Any, timeline: str, seq: Sequence, reference_id: str, targets: list[str]
) -> dict[str, Any]:
    """Each clip's Levels curves set so its parade and histogram match the reference clip's
    (parade.match), measured on parade.FRAMES frames of each."""
    _ref, ref_moments = _moments(seq, reference_id, parade.FRAMES)
    reference = parade.parade(_pooled(host, timeline, ref_moments))
    changes, refused = [], []
    for item_id in targets:
        try:
            clip, moments, before = _parade_target(host, timeline, seq, item_id, "levels")
        except HostError as exc:
            refused.append({"itemId": item_id, "reason": str(exc)})
            continue
        last: dict[str, Any] = {}

        def show(
            look: parade.Look | None,
            item_id: str = item_id,
            moments: list[int] = moments,
            last: dict[str, Any] = last,
            before: dict[str, Any] = before,
        ) -> parade.Pixels:
            if look is not None:
                last["after"] = _set_effect(host, timeline, item_id, "levels", look, before)
                _saturate(host, timeline, item_id, look.get("saturation", 1.0), last)
            return _pooled(host, timeline, moments)

        try:
            look_set, seen, passes = parade.match(reference, show, parade.premiere_curve)
        except (HostError, colour.ColourError) as exc:
            _put_back(host, timeline, item_id, "levels", before, last)
            refused.append({"itemId": item_id, "reason": f"{clip['name']}: {exc}"})
            continue
        distance = round(parade.error(reference, seen), 4)
        change = _parade_change(clip, "levels", before, last["after"], reference=reference, seen=seen, passes=passes,
                                distance=distance, close=distance <= parade.GOOD_ENOUGH)  # fmt: skip
        if change["after"] is not None:
            change["after"]["saturation"] = look_set.get("saturation", 1.0)
        if "lumetri" in last:
            change["lumetri"] = {"before": last["lumetri_before"], "after": last["lumetri"]}
        changes.append(change)
    return {"changes": changes, "refused": refused, "reference": reference}


def _balance_moment(seq: Sequence, item_id: str, at: float | None) -> int:
    """The ticks to balance a clip at: `at` seconds (on a frame; refused when the clip isn't there or a
    clip on a higher track covers it), or its middle."""
    if at is None:
        return _moment(seq, item_id)[1]
    clip = seq.clip(item_id)
    start, end = int(clip["startTicks"]), int(clip["endTicks"])
    ticks = round(at * TICKS_PER_SECOND) // seq.timebase * seq.timebase
    if not start <= ticks < end:
        raise HostError(f"{clip['name']} isn't at {at:g} s")
    nearest = _moments(seq, item_id, ((ticks - start) / (end - start),))[1][0]
    if nearest != ticks:
        raise HostError(f"{clip['name']} is under a clip on a higher track at {at:g} s")
    return ticks


def _balance(host: Any, timeline: str, wants: list[dict[str, Any]]) -> dict[str, Any]:
    """Each clip balanced to its own neutral, read from the areas named in its frame (parade.balance):
    ASC CDL curves (its own effect, apart from a match's Levels) that make what's there read alike in each
    channel, its exposure brought into range. A clip already there is left alone (`balanced`), nothing
    set."""
    seq = _read(host, timeline)
    changes, refused, balanced = [], [], []
    for want in wants:
        item_id = want["itemId"]
        try:
            clip, _frames, before = _parade_target(host, timeline, seq, item_id, "cdl")
            at = _balance_moment(seq, item_id, want["at"])
        except HostError as exc:
            refused.append({"itemId": item_id, "reason": str(exc)})
            continue
        last: dict[str, Any] = {}

        def show(
            look: parade.Look | None,
            item_id: str = item_id,
            at: int = at,
            last: dict[str, Any] = last,
            before: dict[str, Any] = before,
        ) -> parade.Pixels:
            if look is not None:
                last["after"] = _set_effect(host, timeline, item_id, "cdl", look, before)
            return _pixels(host, timeline, at, trim=False)

        try:
            result = parade.balance(show, EFFECTS["cdl"]["curve"], want["areas"])
        except (HostError, colour.ColourError) as exc:
            _put_back(host, timeline, item_id, "cdl", before, last)
            refused.append({"itemId": item_id, "reason": f"{clip['name']}: {exc}"})
            continue
        if result.get("balanced"):
            balanced.append({"itemId": item_id, "name": clip["name"], "was": result["was"]})
            continue
        changes.append(
            _parade_change(clip, "cdl", before, last["after"], reference=result["target"], was=result["was"],
                           seen=result["seen"], passes=result["passes"], distance=result["distance"],
                           close=result["distance"] <= parade.GOOD_ENOUGH, at=round(at / TICKS_PER_SECOND, 3))
        )  # fmt: skip
    return {"changes": changes, "refused": refused, "balanced": balanced}


def read_clip_color(host: Any, args: dict[str, Any]) -> dict[str, Any]:
    """{timeline, itemIds} -> {clips: [{itemId, name, at, brightness, contrast, warmth, tint, colour,
    parade, look}], refused}: each clip's frame as Premiere renders it, measured (its parade and histogram
    too, parade.parade), and its Lumetri look."""
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
            pixels = _pixels(host, timeline, at)
        except HostError as exc:
            refused.append({"itemId": item_id, "reason": str(exc)})
            continue
        out.append({
            "itemId": item_id, "name": clip["name"], "at": round(at / TICKS_PER_SECOND, 3),
            **colour.measure(pixels), "parade": parade.parade(pixels), "look": _look(read),
        })  # fmt: skip
    return {"clips": out, "refused": refused}


def revert_color(host: Any, timeline: str, seq: Sequence, item_id: str, change: dict[str, Any]) -> str:
    """ "reverted", "changed" (its Lumetri, Levels or ASC CDL isn't what the change left) or "failed"."""
    if change.get("method") == "parade":
        return _revert_effect(host, timeline, item_id, change)
    saved = change.get("lumetri") or {}
    if not all(isinstance(saved.get(k), dict) for k in ("before", "after")):
        return "changed"
    now = _lumetri_of(host, timeline, [item_id]).get(item_id)
    if now is None or not now.get("present") or not _same(_look(now), _look(saved["after"])):
        return "changed"
    return "reverted" if _restore_lumetri(host, timeline, item_id, saved["before"]) else "failed"


def _same_levels(a: dict[str, Any], b: dict[str, Any]) -> bool:
    return all(abs(float(a.get(k, 0)) - float(b.get(k, 0))) < 0.02 for k in set(a) | set(b))


def _revert_effect(host: Any, timeline: str, item_id: str, change: dict[str, Any]) -> str:
    """The change's Levels or ASC CDL put back (taken off when it added it), and Lumetri's Saturation
    when the match set it; "changed" if either isn't what the change left."""
    effect = change.get("effect", "levels")
    saved = change.get(effect) or {}
    if effect not in EFFECTS or not all(isinstance(saved.get(k), dict) for k in ("before", "after")):
        return "changed"
    now = _effect_of(host, timeline, item_id, effect)
    if not now.get("present") or not _same_levels(now["values"], saved["after"].get("values") or {}):
        return "changed"
    lumetri = change.get("lumetri")
    if lumetri is not None:
        if not all(isinstance(lumetri.get(k), dict) for k in ("before", "after")):
            return "changed"
        read = _lumetri_of(host, timeline, [item_id]).get(item_id)
        if read is None or not read.get("present") or not _same(_look(read), _look(lumetri["after"])):
            return "changed"
    ok = _restore(host, timeline, item_id, effect, saved["before"])
    if lumetri is not None:
        ok = _restore_lumetri(host, timeline, item_id, lumetri["before"]) and ok
    return "reverted" if ok else "failed"
