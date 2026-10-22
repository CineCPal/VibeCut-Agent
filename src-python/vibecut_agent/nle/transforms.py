"""Scale and position of clips on a timeline (PLAN.md, "Phase 16f"): the request check and the units
both editors' `set_clip_transform` share. Standard library only, as Resolve's own Python runs it.

A look is {scale, x, y}: scale in percent (100 is the clip as the editor sizes it unscaled), x and y in
the timeline's pixels from the frame's centre, x to the right and y up. An animated look is
{keys: [{at, scale, x, y}]}, `at` in seconds from the clip's start.
"""

from __future__ import annotations

import math
from collections.abc import Sequence
from itertools import pairwise
from typing import Any

from vibecut_agent.nle.errors import HostError

MAX_TRANSFORMS = 50
MAX_KEYS = 30
MIN_SCALE, MAX_SCALE = 1.0, 1000.0
MAX_OFFSET = 20000.0
FIELDS = ("scale", "x", "y")


def _value(raw: Any, field: str, where: str) -> float:
    if not isinstance(raw, (int, float)) or isinstance(raw, bool) or not math.isfinite(raw):
        raise HostError(f"{where}.{field} must be a number")
    value = float(raw)
    if field == "scale" and not MIN_SCALE <= value <= MAX_SCALE:
        raise HostError(f"{where}.scale must be from {MIN_SCALE:g} to {MAX_SCALE:g} percent")
    if field != "scale" and abs(value) > MAX_OFFSET:
        raise HostError(f"{where}.{field} must be within {MAX_OFFSET:g} pixels of the centre")
    return value


def _fields(raw: dict[str, Any], where: str) -> dict[str, float]:
    return {f: _value(raw[f], f, where) for f in FIELDS if raw.get(f) is not None}


def transform_wants(args: dict[str, Any]) -> list[dict[str, Any]]:
    """Checks `transforms` ([{itemId, scale?, x?, y?} or {itemId, keyframes: [{at, scale?, x?, y?}]}])
    -> [{itemId, set: {field: value}}] for a still look, or [{itemId, keys: [{at, field: value}]}] with
    the keys in time order, every key giving the same fields."""
    transforms = args.get("transforms")
    if not isinstance(transforms, list) or not transforms or len(transforms) > MAX_TRANSFORMS:
        raise HostError(f"transforms must list 1 to {MAX_TRANSFORMS} {{itemId, scale, x, y}}")
    wants: list[dict[str, Any]] = []
    for i, raw in enumerate(transforms):
        where = f"transforms[{i}]"
        if not isinstance(raw, dict) or not isinstance(raw.get("itemId"), str) or not raw["itemId"]:
            raise HostError(f"{where} must be {{itemId, scale, x, y}} or {{itemId, keyframes}}")
        still = _fields(raw, where)
        keyframes = raw.get("keyframes")
        if keyframes is None:
            if not still:
                raise HostError(f"{where} must give scale, x, y or keyframes")
            wants.append({"itemId": raw["itemId"], "set": still})
            continue
        if still:
            raise HostError(f"{where} gives keyframes, so scale, x and y belong in each keyframe")
        if not isinstance(keyframes, list) or not 2 <= len(keyframes) <= MAX_KEYS:
            raise HostError(f"{where}.keyframes must list 2 to {MAX_KEYS} {{at, scale, x, y}}")
        keys = []
        for k, key in enumerate(keyframes):
            at = f"{where}.keyframes[{k}]"
            if not isinstance(key, dict):
                raise HostError(f"{at} must be {{at, scale, x, y}}")
            time = key.get("at")
            if (
                not isinstance(time, (int, float))
                or isinstance(time, bool)
                or not math.isfinite(time)
                or time < 0
            ):
                raise HostError(f"{at}.at must be seconds from the clip's start (0 or more)")
            fields = _fields(key, at)
            if not fields:
                raise HostError(f"{at} must give scale, x or y")
            keys.append({"at": float(time), **fields})
        keys.sort(key=lambda k: k["at"])
        if any(b["at"] - a["at"] < 1e-6 for a, b in pairwise(keys)):
            raise HostError(f"{where}.keyframes must each be at a different time")
        if len({tuple(f for f in FIELDS if f in k) for k in keys}) != 1:
            raise HostError(f"{where}.keyframes must each give the same fields (scale, x, y)")
        wants.append({"itemId": raw["itemId"], "keys": keys})
    if len({w["itemId"] for w in wants}) != len(wants):
        raise HostError("Each clip may appear once in transforms")
    return wants


def interpolate(keys: Sequence[tuple[float, Any]], time: float) -> Any:
    """The value at `time` on linear keys [(time, value)], held before the first and after the last;
    a value is a number or a list of numbers."""
    if time <= keys[0][0]:
        return keys[0][1]
    for (t0, v0), (t1, v1) in pairwise(keys):
        if time <= t1:
            share = (time - t0) / (t1 - t0) if t1 > t0 else 1.0
            if isinstance(v0, list):
                return [a + (b - a) * share for a, b in zip(v0, v1)]
            return v0 + (v1 - v0) * share
    return keys[-1][1]


def rounded(look: dict[str, Any]) -> dict[str, Any]:
    """A look as the change log and the agent read it: percent to 0.01, pixels to 0.1."""

    def one(values: dict[str, Any]) -> dict[str, Any]:
        out = {f: round(float(values[f]), 2 if f == "scale" else 1) for f in FIELDS}
        if "at" in values:
            out = {"at": round(float(values["at"]), 3), **out}
        return out

    if "keys" in look:
        return {"keys": [one(k) for k in look["keys"]]}
    return one(look)


def _still(key: dict[str, Any]) -> dict[str, Any]:
    return {f: key[f] for f in FIELDS}


def first(look: dict[str, Any]) -> dict[str, float]:
    """A look's values at the clip's start."""
    return _still(look["keys"][0]) if "keys" in look else _still(look)
