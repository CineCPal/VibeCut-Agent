"""colour.py -- the colour corrections both editors' set_clip_color and match_clip_color share (PLAN.md,
"Phase 19c"). Standard library only, as Resolve's own Python runs it.

A look is Lumetri's Basic Correction, in Lumetri's units: exposure (stops), contrast (-100 to 100),
temperature (-100 cool to 100 warm), tint (-100 green to 100 magenta) and saturation (0 to 200, 100 as
shot). Premiere sets those controls themselves; Resolve gets a CDL on the clip's node 1 (`cdl`), built so
each unit moves the picture about as far as it does in Lumetri (measured on a chart, 19c probe):

- exposure: Lumetri's -1 stop scaled display values by 0.749 (0.5 ** (1 / 2.4)), so a stop is a gain of
  2 ** (1 / GAMMA) on display values;
- temperature: ln(R / B) moves K_TEMPERATURE per unit; tint: ln(G / mean(R, B)) moves -K_TINT per unit;
- contrast: the slope through mid grey (0.5) is 1 + K_CONTRAST per unit;
- saturation: the CDL's saturation is saturation / 100 (Resolve's is around Rec. 709 luma, Lumetri's
  around linear light, so they differ a little on strong colours).

Matching is closed loop: the editor's own rendered frame (its grade included) is measured (`measure`),
a step is taken toward the reference (`step`), applied, and measured again, keeping the closest pass.
The measures compare overall brightness, contrast, warmth, tint and colourfulness, so it suits shots of
the same scene (two cameras on an interview), not shots of different places.
"""

from __future__ import annotations

import math
import subprocess
from collections.abc import Sequence
from typing import Any

FIELDS = ("exposure", "contrast", "temperature", "tint", "saturation")
NEUTRAL = {"exposure": 0.0, "contrast": 0.0, "temperature": 0.0, "tint": 0.0, "saturation": 100.0}
LIMITS = {
    "exposure": (-4.0, 4.0),
    "contrast": (-100.0, 100.0),
    "temperature": (-100.0, 100.0),
    "tint": (-100.0, 100.0),
    "saturation": (0.0, 200.0),
}
GAMMA = 2.4
K_TEMPERATURE = 0.0057
K_TINT = 0.0044
K_CONTRAST = 0.004
MAX_ITEMS = 50
# The frame measured: small, so the pixels are few and noise averages out.
SAMPLE_WIDTH, SAMPLE_HEIGHT = 160, 90
# Pixels this close to black or white are left out of the colour measures (clipped, they hold no cast).
CLIP_LOW, CLIP_HIGH = 0.03, 0.97
MATCH_PASSES = 3
# A pass this close to the reference stops the loop (see `error`).
GOOD_ENOUGH = 0.03


class ColourError(ValueError):
    """A request or frame the colour code can't use; its text is for the agent."""


def _number(value: Any, field: str) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
        raise ColourError(f"{field} must be a number")
    return float(value)


def clamp(look: dict[str, float]) -> dict[str, float]:
    return {k: round(min(max(look[k], LIMITS[k][0]), LIMITS[k][1]), 3) for k in FIELDS}


def look_of(entry: dict[str, Any], where: str) -> dict[str, float]:
    """A request's look: the fields given, neutral for the rest; a value out of range is refused."""
    look = dict(NEUTRAL)
    for key in FIELDS:
        if entry.get(key) is None:
            continue
        value = _number(entry[key], f"{where}.{key}")
        low, high = LIMITS[key]
        if not low <= value <= high:
            raise ColourError(f"{where}.{key} must be from {low:g} to {high:g}")
        look[key] = value
    return look


def look_wants(args: dict[str, Any]) -> list[dict[str, Any]]:
    """{looks: [{itemId, exposure?, contrast?, temperature?, tint?, saturation?}]} -> [{itemId, look}]."""
    raw = args.get("looks")
    if not isinstance(raw, list) or not raw or len(raw) > MAX_ITEMS:
        raise ColourError(f"looks must list 1 to {MAX_ITEMS} clips")
    out, seen = [], set()
    for i, entry in enumerate(raw):
        if not isinstance(entry, dict) or not isinstance(entry.get("itemId"), str) or not entry["itemId"]:
            raise ColourError(f"looks[{i}].itemId must be a timeline clip id")
        if entry["itemId"] in seen:
            raise ColourError(f"looks[{i}]: {entry['itemId']} is listed twice")
        seen.add(entry["itemId"])
        if not any(entry.get(k) is not None for k in FIELDS):
            raise ColourError(f"looks[{i}] must give exposure, contrast, temperature, tint or saturation")
        out.append({"itemId": entry["itemId"], "look": look_of(entry, f"looks[{i}]")})
    return out


def match_wants(args: dict[str, Any]) -> tuple[str, list[str]]:
    """{referenceId, itemIds} -> (reference, targets)."""
    reference = args.get("referenceId")
    ids = args.get("itemIds")
    if not isinstance(reference, str) or not reference:
        raise ColourError("referenceId must be the timeline clip to match")
    if (
        not isinstance(ids, list)
        or not ids
        or len(ids) > MAX_ITEMS
        or not all(isinstance(i, str) and i for i in ids)
    ):
        raise ColourError(f"itemIds must list 1 to {MAX_ITEMS} timeline clips to change")
    targets = [i for i in dict.fromkeys(ids) if i != reference]
    if not targets:
        raise ColourError("itemIds must name clips other than the reference")
    return reference, targets


def is_neutral(look: dict[str, float]) -> bool:
    return all(abs(look[k] - NEUTRAL[k]) < 1e-3 for k in FIELDS)


def cdl(look: dict[str, float]) -> dict[str, str]:
    """Resolve's SetCDL request for node 1 that gives `look`."""
    gain = 2 ** (look["exposure"] / GAMMA)
    warm = look["temperature"] * K_TEMPERATURE
    magenta = look["tint"] * K_TINT
    slope = max(0.2, 1 + K_CONTRAST * look["contrast"])
    gains = (
        gain * math.exp(warm / 2 + magenta / 3),
        gain * math.exp(-2 * magenta / 3),
        gain * math.exp(-warm / 2 + magenta / 3),
    )
    offset = 0.5 * (1 - slope)
    return {
        "NodeIndex": "1",
        "Slope": " ".join(f"{g * slope:.5f}" for g in gains),
        "Offset": " ".join(f"{offset:.5f}" for _ in gains),
        "Power": "1 1 1",
        "Saturation": f"{look['saturation'] / 100:.5f}",
    }


def frame_pixels(path: str, timeout: float = 30.0) -> list[tuple[float, float, float]]:
    """The frame in an image file, SAMPLE_WIDTH x SAMPLE_HEIGHT, as display RGB from 0 to 1 (ffmpeg)."""
    try:
        done = subprocess.run(
            [
                "ffmpeg", "-v", "error", "-nostdin", "-i", path,
                "-vf", f"scale={SAMPLE_WIDTH}:{SAMPLE_HEIGHT}:flags=area",
                "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", "-",
            ],
            capture_output=True,
            timeout=timeout,
            check=False,
        )  # fmt: skip
    except (OSError, subprocess.TimeoutExpired) as exc:
        raise ColourError(f"ffmpeg couldn't read the frame: {exc}") from None
    data = done.stdout
    if done.returncode != 0 or len(data) < SAMPLE_WIDTH * SAMPLE_HEIGHT * 3:
        raise ColourError(
            done.stderr.decode(errors="ignore").strip()[-300:] or "ffmpeg couldn't read the frame"
        )
    return [
        (data[i] / 255, data[i + 1] / 255, data[i + 2] / 255)
        for i in range(0, SAMPLE_WIDTH * SAMPLE_HEIGHT * 3, 3)
    ]


def measure(pixels: list[tuple[float, float, float]]) -> dict[str, float]:
    """How a frame looks: `brightness` (mean Rec. 709 luma), `contrast` (luma's spread over its mean),
    `warmth` ln(R / B), `tint` ln(G / mean(R, B)) and `colour` (mean max - min channel), the last three
    over the pixels that aren't near black or white."""
    if not pixels:
        raise ColourError("The frame has no pixels")
    lumas = [0.2126 * r + 0.7152 * g + 0.0722 * b for r, g, b in pixels]
    mean = sum(lumas) / len(lumas)
    spread = math.sqrt(sum((v - mean) ** 2 for v in lumas) / len(lumas))
    mids = [p for p, v in zip(pixels, lumas, strict=True) if CLIP_LOW < v < CLIP_HIGH]
    if len(mids) < len(pixels) // 20:
        mids = pixels
    r = sum(p[0] for p in mids) / len(mids) + 1e-4
    g = sum(p[1] for p in mids) / len(mids) + 1e-4
    b = sum(p[2] for p in mids) / len(mids) + 1e-4
    return {
        "brightness": round(mean, 4),
        "contrast": round(spread / max(mean, 1e-3), 4),
        "warmth": round(math.log(r / b), 4),
        "tint": round(math.log(g / ((r + b) / 2)), 4),
        "colour": round(sum(max(p) - min(p) for p in mids) / len(mids), 4),
    }


def error(reference: dict[str, float], current: dict[str, float]) -> float:
    """How far `current` is from `reference`, each measure scaled so about 0.01 is a just-visible step."""
    return max(
        abs(math.log((current["brightness"] + 1e-3) / (reference["brightness"] + 1e-3))) / 2,
        abs(math.log((current["contrast"] + 1e-3) / (reference["contrast"] + 1e-3))) / 2,
        abs(current["warmth"] - reference["warmth"]),
        abs(current["tint"] - reference["tint"]),
        abs(math.log((current["colour"] + 1e-3) / (reference["colour"] + 1e-3))) / 2,
    )


def step(reference: dict[str, float], current: dict[str, float], look: dict[str, float]) -> dict[str, float]:
    """The look that should move `current` (the frame as `look` renders it) to `reference`.

    A cast is colour too, so saturation scales it: warmth is about s * (w0 + K_TEMPERATURE * temperature),
    with s the saturation / 100 and w0 the picture's own warmth (tint likewise, its sign the other way).
    So w0 is taken from this pass, and the temperature solved for the new saturation; stepping the two
    apart made them fight (seen in the closed-loop test)."""
    nxt = dict(look)
    nxt["exposure"] += GAMMA * math.log2((reference["brightness"] + 1e-3) / (current["brightness"] + 1e-3))
    nxt["contrast"] += ((reference["contrast"] + 1e-3) / (current["contrast"] + 1e-3) - 1) / K_CONTRAST
    s = max(look["saturation"] / 100, 0.05)
    s_next = min(
        max(s * (reference["colour"] + 1e-3) / (current["colour"] + 1e-3), 0.05),
        LIMITS["saturation"][1] / 100,
    )
    nxt["saturation"] = s_next * 100
    own_warmth = current["warmth"] / s - K_TEMPERATURE * look["temperature"]
    nxt["temperature"] = (reference["warmth"] / s_next - own_warmth) / K_TEMPERATURE
    own_tint = current["tint"] / s + K_TINT * look["tint"]
    nxt["tint"] = (own_tint - reference["tint"] / s_next) / K_TINT
    return clamp(nxt)


def describe(look: dict[str, float]) -> str:
    """'exposure +0.5, temperature -12' (neutral fields left out), or 'neutral'."""
    parts = []
    for key in FIELDS:
        value = look[key]
        if abs(value - NEUTRAL[key]) < 1e-3:
            continue
        parts.append(f"{key} {value:g}" if key == "saturation" else f"{key} {value:+g}")
    return ", ".join(parts) or "neutral"


def uncovered_moment(start: float, end: float, covers: Sequence[tuple[float, float]]) -> float | None:
    """The time in [start, end) nearest its middle that no cover (a clip on a higher video track) is over,
    or None when it's all covered."""
    middle = (start + end) / 2
    free: list[tuple[float, float]] = []
    cursor = start
    for a, b in sorted((max(a, start), min(b, end)) for a, b in covers if b > start and a < end):
        if a > cursor:
            free.append((cursor, a))
        cursor = max(cursor, b)
    if cursor < end:
        free.append((cursor, end))
    if not free:
        return None
    best = min(
        free, key=lambda r: 0.0 if r[0] <= middle < r[1] else min(abs(r[0] - middle), abs(r[1] - middle))
    )
    if best[0] <= middle < best[1]:
        return middle
    return (best[0] + best[1]) / 2


def match(
    reference: dict[str, float],
    start: dict[str, float],
    render: Any,
) -> tuple[dict[str, float], dict[str, float], int]:
    """The closed loop: `render(look)` applies a look and returns the frame's measures. From `start`, takes
    up to MATCH_PASSES steps toward `reference` and returns (best look, its measures, passes), the best
    look left applied."""
    look = clamp(start)
    seen = render(look)
    best = (error(reference, seen), look, seen)
    passes = 0
    while passes < MATCH_PASSES and best[0] > GOOD_ENOUGH:
        look = step(reference, seen, look)
        seen = render(look)
        passes += 1
        score = error(reference, seen)
        if score < best[0]:
            best = (score, look, seen)
    if best[1] != look:
        render(best[1])
    return best[1], best[2], passes
