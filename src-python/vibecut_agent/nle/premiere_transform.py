"""premiere_transform.py -- scale and position of clips on the connected Premiere sequence (PLAN.md,
"Phase 16f"), with the same requests and change records as resolve_transform.py.

What the panel works on (src-premiere-panel/host.jsx, panel 0.13.0): a picture clip's Motion effect,
its Scale (percent) and Position (a fraction of the sequence's frame, [0.5, 0.5] the centre, y down).
Keys sit at source-file times, as a fade's do (premiere_effects.py), so a clip with a speed change can
take a still look but not keys. Scale Width is only used with Uniform Scale off, so such a clip's scale
is refused rather than half changed. A still value replaces any keys on that property; the other
property keeps its own.
"""

from __future__ import annotations

from typing import Any

from vibecut_agent.nle.premiere import TICKS_PER_SECOND, HostError
from vibecut_agent.nle.premiere_edit import Sequence, _read
from vibecut_agent.nle.transforms import first, interpolate, rounded, transform_wants

PROPERTIES = ("scale", "position")


def _motion_of(host: Any, timeline: str, ids: list[str]) -> dict[str, dict[str, Any]]:
    return {m["id"]: m for m in host._send("read_motion", {"timeline": timeline, "ids": ids})["items"]}


def _frame(seq: Sequence) -> tuple[float, float]:
    width, height = seq.raw.get("frameWidth"), seq.raw.get("frameHeight")
    if (
        not isinstance(width, (int, float))
        or not isinstance(height, (int, float))
        or width <= 0
        or height <= 0
    ):
        raise HostError("Premiere didn't say the sequence's frame size, so a position can't be set")
    return float(width), float(height)


def _keys(prop: dict[str, Any]) -> list[tuple[int, Any]]:
    """A property's keys as [(source ticks, value)], or [] when it holds one value (a single key, which
    Premiere can leave behind, counts as that value)."""
    keys = sorted(((int(k["ticks"]), k["value"]) for k in prop.get("keys") or []), key=lambda k: k[0])
    return keys if len(keys) > 1 else []


def _held(prop: dict[str, Any]) -> Any:
    keys = sorted(((int(k["ticks"]), k["value"]) for k in prop.get("keys") or []), key=lambda k: k[0])
    return keys[0][1] if len(keys) == 1 and prop.get("value") is None else prop.get("value")


def _look(clip: dict[str, Any], motion: dict[str, Any], seq: Sequence) -> dict[str, Any]:
    """The clip's look in transforms.py's units, keyed where either property has keys."""
    width, height = _frame(seq)
    src_in = int(clip["inTicks"])

    def at(ticks: int) -> dict[str, float]:
        values = {}
        for name in PROPERTIES:
            prop = motion[name]
            keys = _keys(prop)
            values[name] = interpolate(keys, ticks) if keys else _held(prop)
        nx, ny = (float(v) for v in values["position"])
        return {
            "scale": float(values["scale"]),
            "x": (nx - 0.5) * width,
            "y": (0.5 - ny) * height,
        }

    times = sorted({t for name in PROPERTIES for t, _v in _keys(motion[name])})
    if not times:
        return at(src_in)
    return {"keys": [{"at": (t - src_in) / TICKS_PER_SECOND, **at(t)} for t in times]}


def _saved(motion: dict[str, Any]) -> dict[str, Any]:
    """What a revert puts back: each property's value and keys as the panel reads them."""
    return {
        name: {"value": motion[name].get("value"), "keys": list(motion[name].get("keys") or [])}
        for name in PROPERTIES
    }


def _setting(saved: dict[str, Any]) -> dict[str, Any]:
    """The panel's set_motion entry for a saved property: its keys, or its one value."""
    keys = saved.get("keys") or []
    value = saved.get("value")
    if value is None and keys:
        value = keys[0]["value"]
    return {"keys": keys if len(keys) > 1 else [], "value": value}


def _normalised(seq: Sequence, x: float, y: float) -> list[float]:
    width, height = _frame(seq)
    return [0.5 + x / width, 0.5 - y / height]


def _plan(
    clip: dict[str, Any], motion: dict[str, Any], seq: Sequence, want: dict[str, Any]
) -> dict[str, Any]:
    """The set_motion entry for one clip, or a HostError saying why it's refused."""
    if clip["kind"] != "video":
        raise HostError("sound has no picture to scale or move")
    now = first(_look(clip, motion, seq))
    fields = set(want.get("set") or want["keys"][0]) - {"at"}
    if "scale" in fields and motion.get("uniform") is False:
        raise HostError("its Uniform Scale is off; change its scale in Premiere")
    entry: dict[str, Any] = {"id": clip["id"]}
    if "set" in want:
        values = {**now, **want["set"]}
        if "scale" in fields:
            entry["scale"] = {"keys": [], "value": values["scale"]}
        if fields & {"x", "y"}:
            entry["position"] = {"keys": [], "value": _normalised(seq, values["x"], values["y"])}
        return entry
    if clip.get("speed") not in (None, 1) or clip.get("reversed"):
        raise HostError(
            "it has a speed change, and Premiere's keyframes sit in the source; animate it in Premiere"
        )
    length = (int(clip["endTicks"]) - int(clip["startTicks"])) / TICKS_PER_SECOND
    if want["keys"][-1]["at"] > length + 0.5 / seq.fps:
        raise HostError(f"a keyframe is past its end ({length:.2f} s long)")
    src_in, src_out = int(clip["inTicks"]), int(clip["outTicks"])
    ticks = [min(src_out, src_in + seq.ticks(k["at"])) for k in want["keys"]]
    if len(set(ticks)) != len(ticks):
        raise HostError("two keyframes fall on the same frame")
    if "scale" in fields:
        entry["scale"] = {
            "keys": [{"ticks": str(t), "value": k["scale"]} for t, k in zip(ticks, want["keys"])],
            "value": want["keys"][0]["scale"],
        }
    if fields & {"x", "y"}:
        points = [_normalised(seq, k.get("x", now["x"]), k.get("y", now["y"])) for k in want["keys"]]
        entry["position"] = {
            "keys": [{"ticks": str(t), "value": p} for t, p in zip(ticks, points)],
            "value": points[0],
        }
    return entry


def _same_motion(a: dict[str, Any], b: dict[str, Any], half: int) -> bool:
    def close(x: Any, y: Any) -> bool:
        if isinstance(x, list) or isinstance(y, list):
            return (
                isinstance(x, list)
                and isinstance(y, list)
                and len(x) == len(y)
                and all(close(p, q) for p, q in zip(x, y))
            )
        return isinstance(x, (int, float)) and isinstance(y, (int, float)) and abs(float(x) - float(y)) < 1e-4

    for name in PROPERTIES:
        ka, kb = _keys(a[name]), _keys(b[name])
        if len(ka) != len(kb) or not all(
            abs(t1 - t2) <= half and close(v1, v2) for (t1, v1), (t2, v2) in zip(ka, kb)
        ):
            return False
        if not ka and not close(_held(a[name]), _held(b[name])):
            return False
    return True


def set_clip_transform(host: Any, args: dict[str, Any]) -> dict[str, Any]:
    """{timeline, transforms: [{itemId, scale?, x?, y?} | {itemId, keyframes: [{at, scale?, x?, y?}]}]}
    -> sets each picture clip's Motion Scale and Position, still or keyed (transforms.py's units)."""
    wants = transform_wants(args)
    timeline = host._name(args)
    seq = _read(host, timeline)
    clips = [seq.clip(w["itemId"]) for w in wants]
    pictures = [c["id"] for c in clips if c["kind"] == "video"]
    motions = _motion_of(host, timeline, pictures) if pictures else {}
    plans, befores, refused = [], {}, []
    for want, clip in zip(wants, clips, strict=True):
        try:
            plan = _plan(clip, motions.get(clip["id"], {}), seq, want)
        except HostError as exc:
            refused.append({"itemId": clip["id"], "reason": f"{clip['name']}: {exc}"})
            continue
        plans.append(plan)
        befores[clip["id"]] = motions[clip["id"]]
    if plans:
        host._send("set_motion", {"timeline": timeline, "items": plans})
    afters = _motion_of(host, timeline, [p["id"] for p in plans]) if plans else {}
    half = seq.timebase // 2
    changes = []
    for plan in plans:
        clip, before, after = seq.clips[plan["id"]], befores[plan["id"]], afters[plan["id"]]
        wanted = {**before, **{name: plan[name] for name in PROPERTIES if name in plan}}
        if not _same_motion(after, wanted, half):
            refused.append(
                {
                    "itemId": clip["id"],
                    "reason": f"{clip['name']}: Premiere didn't take the scale or position",
                }
            )
        if _same_motion(after, before, half):
            continue
        changes.append({
            "kind": "transform", "itemId": clip["id"], "name": clip["name"], "track": [clip["kind"], clip["index"]],
            "before": rounded(_look(clip, before, seq)), "after": rounded(_look(clip, after, seq)),
            "motion": {"before": _saved(before), "after": _saved(after)},
        })  # fmt: skip
    return {"changes": changes, "refused": refused}


def read_clip_transforms(host: Any, args: dict[str, Any]) -> dict[str, Any]:
    """{timeline, itemIds} -> {clips: [{itemId, name, scale, x, y} or {itemId, name, keys}]}; a sound
    clip or one Premiere can't read says so in `refused`."""
    ids = args.get("itemIds")
    if (
        not isinstance(ids, list)
        or not ids
        or len(ids) > 200
        or not all(isinstance(i, str) and i for i in ids)
    ):
        raise HostError("itemIds must list 1 to 200 timeline clip ids")
    timeline = host._name(args)
    seq = _read(host, timeline)
    clips = [seq.clip(i) for i in dict.fromkeys(ids)]
    pictures = [c["id"] for c in clips if c["kind"] == "video"]
    motions = _motion_of(host, timeline, pictures) if pictures else {}
    out, refused = [], []
    for clip in clips:
        if clip["id"] not in motions:
            refused.append(
                {"itemId": clip["id"], "reason": f"{clip['name']} is sound, with no picture to scale or move"}
            )
            continue
        out.append(
            {"itemId": clip["id"], "name": clip["name"], **rounded(_look(clip, motions[clip["id"]], seq))}
        )
    return {"clips": out, "refused": refused}


def revert_transform(host: Any, timeline: str, seq: Sequence, item_id: str, change: dict[str, Any]) -> str:
    """ "reverted" or "changed" (its Scale or Position isn't what the change left)."""
    saved = change.get("motion") or {}
    if not all(isinstance(saved.get(k), dict) for k in ("before", "after")):
        return "changed"
    now = _motion_of(host, timeline, [item_id]).get(item_id)
    if now is None or not _same_motion(now, saved["after"], seq.timebase // 2):
        return "changed"
    host._send(
        "set_motion",
        {
            "timeline": timeline,
            "items": [{"id": item_id, **{n: _setting(saved["before"][n]) for n in PROPERTIES}}],
        },
    )
    return "reverted"
