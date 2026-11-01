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

Balancing (`balance_target`, `match(..., balance=True)`) is the same loop with a clip's own neutral as
its reference: the cast of its least colourful pixels (`neutral_cast`) taken out with temperature and
tint, and exposure brought into BALANCE_BRIGHTNESS when it's outside; contrast and saturation are left
as they are.
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
# Matching to a learned style (Phase 20b) stays a nudge: the style is an average over a reference's
# shots, so going all the way could drive a clip to a control's end.
STYLE_LIMITS = {
    "exposure": (-1.0, 1.0),
    "contrast": (-40.0, 40.0),
    "temperature": (-50.0, 50.0),
    "tint": (-30.0, 30.0),
    "saturation": (60.0, 140.0),
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
# A row or column at the frame's edge with no channel above this is a border, not picture.
BORDER_BLACK = 0.03
MATCH_PASSES = 3
# When the model's passes fall short, each control is nudged this far to measure the clip's own response,
# then solved for in SOLVE_PASSES passes (`match`); STEP_SCALE is a comparable step of each control.
PROBE_STEP = {"exposure": 0.25, "contrast": 15.0, "temperature": 15.0, "tint": 15.0, "saturation": 15.0}
STEP_SCALE = {"exposure": 0.25, "contrast": 10.0, "temperature": 10.0, "tint": 10.0, "saturation": 10.0}
SOLVE_PASSES = 3
# A pass this close to the reference stops the loop (see `error`).
GOOD_ENOUGH = 0.03
# Balancing: the measures it aims at and the controls it moves (the others are kept as they are).
BALANCE_MEASURES = ("greyWarmth", "greyTint", "brightness")
BALANCE_CONTROLS = ("exposure", "temperature", "tint")
# A shot darker or brighter than this is brought to its nearer end; one inside keeps its brightness
# (a night scene stays dark, only less so). About 0.4 is a normal exposure (`measure`).
BALANCE_BRIGHTNESS = (0.3, 0.5)
# The share of a frame's mid pixels, the least colourful, that the cast is read from: what's grey in
# the scene shows the cast alone, where averaging every pixel would call a red wall a warm cast.
GREY_SHARE = 0.3
# ... and how colourful those may be, on average ((max - min) / max), for the shot to have greys at
# all: a strong cast on a grey reads about 0.3. Over this (a colour card, a test chart of bars, a stage
# in coloured light; seen live, Phase 20b), there's nothing to balance by and the clip is refused.
GREY_MAX_CHROMA = 0.4
# A balance only corrects: a cast or exposure needing more than this is past what it can judge.
BALANCE_LIMITS = {
    "exposure": (-2.0, 2.0),
    "contrast": LIMITS["contrast"],
    "temperature": (-60.0, 60.0),
    "tint": (-60.0, 60.0),
    "saturation": LIMITS["saturation"],
}


class ColourError(ValueError):
    """A request or frame the colour code can't use; its text is for the agent."""


def _number(value: Any, field: str) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
        raise ColourError(f"{field} must be a number")
    return float(value)


def clamp(look: dict[str, float], limits: dict[str, tuple[float, float]] = LIMITS) -> dict[str, float]:
    return {k: round(min(max(look[k], limits[k][0]), limits[k][1]), 3) for k in FIELDS}


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


MEASURES = ("brightness", "contrast", "warmth", "tint", "colour")
# Measures compared as ratios (on a log scale); the rest (casts, already logs) as differences.
_RATIO_MEASURES = ("brightness", "contrast", "colour")


def _item_ids(args: dict[str, Any]) -> list[str]:
    ids = args.get("itemIds")
    if (
        not isinstance(ids, list)
        or not ids
        or len(ids) > MAX_ITEMS
        or not all(isinstance(i, str) and i for i in ids)
    ):
        raise ColourError(f"itemIds must list 1 to {MAX_ITEMS} timeline clips to change")
    return list(dict.fromkeys(ids))


def balance_wants(args: dict[str, Any]) -> list[str] | None:
    """{balance: true, itemIds} -> the clips to balance, each to its own neutral; None when the request
    isn't a balance (it's a match)."""
    if args.get("balance") is None:
        return None
    if args["balance"] is not True:
        raise ColourError("balance must be true")
    if args.get("referenceId") is not None or args.get("referenceLook") is not None:
        raise ColourError("A balance has no reference: give balance or referenceId/referenceLook, not both")
    return _item_ids(args)


def match_wants(args: dict[str, Any]) -> tuple[str | None, list[str], dict[str, float] | None]:
    """{referenceId | referenceLook, itemIds} -> (reference clip, targets, reference look). A look is a
    set of measures (as `measure` gives them) to match instead of a clip's frame: a style learned from a
    reference edit (Phase 20b)."""
    reference = args.get("referenceId")
    wanted = args.get("referenceLook")
    look: dict[str, float] | None = None
    if wanted is not None:
        if not isinstance(wanted, dict):
            raise ColourError(f"referenceLook must give {', '.join(MEASURES)}")
        look = {k: _number(wanted.get(k), f"referenceLook.{k}") for k in MEASURES}
        if not 0 < look["brightness"] <= 1 or look["contrast"] < 0 or look["colour"] < 0:
            raise ColourError(
                "referenceLook's brightness must be over 0 and at most 1, its contrast and colour 0 or more"
            )
        reference = None
    elif not isinstance(reference, str) or not reference:
        raise ColourError("referenceId must be the timeline clip to match")
    targets = [i for i in _item_ids(args) if i != reference]
    if not targets:
        raise ColourError("itemIds must name clips other than the reference")
    return reference, targets, look


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


def frame_pixels(
    path: str, timeout: float = 30.0, at: float | None = None
) -> list[tuple[float, float, float]]:
    """The frame in an image file (or a video's frame at `at` seconds, Phase 20b), SAMPLE_WIDTH x
    SAMPLE_HEIGHT, as display RGB from 0 to 1 (ffmpeg), without black borders (`without_borders`)."""
    seek = ["-ss", f"{at:.3f}"] if at is not None else []
    try:
        done = subprocess.run(
            [
                "ffmpeg", "-v", "error", "-nostdin", *seek, "-i", path,
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
    pixels = [
        (data[i] / 255, data[i + 1] / 255, data[i + 2] / 255)
        for i in range(0, SAMPLE_WIDTH * SAMPLE_HEIGHT * 3, 3)
    ]
    return without_borders(pixels, SAMPLE_WIDTH, SAMPLE_HEIGHT)


def without_borders(
    pixels: list[tuple[float, float, float]], width: int, height: int
) -> list[tuple[float, float, float]]:
    """The pixels inside the black rows and columns at the frame's edges (a clip smaller than the
    frame, letterboxing), and the blended row or column next to them, so the borders don't count as
    the picture's (seen live: a 720p clip in a 1080p Premiere sequence measured at 44% of its
    brightness, Phase 20b). A frame left with under a quarter of its area is a dark picture, not
    borders: it's kept whole."""

    def black(line: list[tuple[float, float, float]]) -> bool:
        return all(max(p) <= BORDER_BLACK for p in line)

    def row(y: int) -> list[tuple[float, float, float]]:
        return pixels[y * width : (y + 1) * width]

    def col(x: int, top: int, bottom: int) -> list[tuple[float, float, float]]:
        return [pixels[y * width + x] for y in range(top, bottom)]

    top, bottom = 0, height
    while top < bottom and black(row(top)):
        top += 1
    while bottom > top and black(row(bottom - 1)):
        bottom -= 1
    left, right = 0, width
    while left < right and black(col(left, top, bottom)):
        left += 1
    while right > left and black(col(right - 1, top, bottom)):
        right -= 1
    # The row or column the scale blended with the border.
    top, bottom = top + (top > 0), bottom - (bottom < height)
    left, right = left + (left > 0), right - (right < width)
    if (right - left) * (bottom - top) < width * height / 4:
        return pixels
    if (top, bottom, left, right) == (0, height, 0, width):
        return pixels
    return [pixels[y * width + x] for y in range(top, bottom) for x in range(left, right)]


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


def neutral_cast(pixels: list[tuple[float, float, float]]) -> dict[str, float]:
    """The cast of what's grey in the frame: `greyWarmth` ln(R / B) and `greyTint` ln(G / mean(R, B)) over
    the GREY_SHARE least colourful pixels (by (max - min) / max) that aren't near black or white, and
    `greyChroma`, how colourful those are on average. 0 and 0 is a neutral balance."""
    if not pixels:
        raise ColourError("The frame has no pixels")
    mids = [p for p in pixels if CLIP_LOW < 0.2126 * p[0] + 0.7152 * p[1] + 0.0722 * p[2] < CLIP_HIGH]
    if len(mids) < len(pixels) // 20:
        mids = pixels
    chroma = sorted(((max(p) - min(p)) / max(max(p), 1e-3), p) for p in mids)
    greys = [p for _c, p in chroma[: max(1, int(len(mids) * GREY_SHARE))]]
    grey_chroma = sum(c for c, _p in chroma[: len(greys)]) / len(greys)
    r = sum(p[0] for p in greys) / len(greys) + 1e-4
    g = sum(p[1] for p in greys) / len(greys) + 1e-4
    b = sum(p[2] for p in greys) / len(greys) + 1e-4
    return {
        "greyWarmth": round(math.log(r / b), 4),
        "greyTint": round(math.log(g / ((r + b) / 2)), 4),
        "greyChroma": round(grey_chroma, 4),
    }


def measure_balance(pixels: list[tuple[float, float, float]]) -> dict[str, float]:
    """`measure` and `neutral_cast` together, for balancing."""
    return {**measure(pixels), **neutral_cast(pixels)}


def balance_target(seen: dict[str, float]) -> dict[str, float]:
    """A clip's own neutral, from its frame as it is (`measure_balance`): no cast in its greys, its
    brightness brought into BALANCE_BRIGHTNESS. A frame with nothing near grey is refused."""
    if seen["greyChroma"] > GREY_MAX_CHROMA:
        raise ColourError(
            "nothing in the frame is near grey (it's all strong colour), so there's no neutral to balance by"
        )
    low, high = BALANCE_BRIGHTNESS
    return {
        "greyWarmth": 0.0,
        "greyTint": 0.0,
        "brightness": round(min(max(seen["brightness"], low), high), 4),
    }


def residual(
    reference: dict[str, float], seen: dict[str, float], measures: Sequence[str] = MEASURES
) -> list[float]:
    """How far `seen` is from `reference` in each of `measures`, signed (seen minus reference), scaled so
    about 0.01 is a just-visible step: ratios on a log scale, halved; casts as differences."""
    return [
        math.log((seen[k] + 1e-3) / (reference[k] + 1e-3)) / 2
        if k in _RATIO_MEASURES
        else seen[k] - reference[k]
        for k in measures
    ]


def error(
    reference: dict[str, float], current: dict[str, float], measures: Sequence[str] = MEASURES
) -> float:
    """How far `current` is from `reference`: the largest of `residual`'s terms."""
    return max(abs(v) for v in residual(reference, current, measures))


def step(
    reference: dict[str, float],
    current: dict[str, float],
    look: dict[str, float],
    limits: dict[str, tuple[float, float]] = LIMITS,
) -> dict[str, float]:
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
    return clamp(nxt, limits)


def balance_step(
    reference: dict[str, float],
    current: dict[str, float],
    look: dict[str, float],
    limits: dict[str, tuple[float, float]] = LIMITS,
) -> dict[str, float]:
    """`step` for balancing: exposure toward the reference brightness, and temperature and tint to take
    the greys' cast out (a cast scales with saturation, as in `step`); contrast and saturation kept."""
    nxt = dict(look)
    nxt["exposure"] += GAMMA * math.log2((reference["brightness"] + 1e-3) / (current["brightness"] + 1e-3))
    s = max(look["saturation"] / 100, 0.05)
    nxt["temperature"] -= (current["greyWarmth"] - reference["greyWarmth"]) / (s * K_TEMPERATURE)
    nxt["tint"] += (current["greyTint"] - reference["greyTint"]) / (s * K_TINT)
    return clamp(nxt, limits)


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


def _solve(a: list[list[float]], b: list[float]) -> list[float] | None:
    """`a x = b` by Gaussian elimination with partial pivoting (5 unknowns at most); None if singular."""
    n = len(b)
    m = [row[:] + [b[i]] for i, row in enumerate(a)]
    for c in range(n):
        p = max(range(c, n), key=lambda r: abs(m[r][c]))
        if abs(m[p][c]) < 1e-12:
            return None
        m[c], m[p] = m[p], m[c]
        for r in range(n):
            if r != c:
                f = m[r][c] / m[c][c]
                m[r] = [x - f * y for x, y in zip(m[r], m[c], strict=True)]
    return [m[i][n] / m[i][i] for i in range(n)]


def solve_step(
    jacobian: list[list[float]],
    off: list[float],
    look: dict[str, float],
    limits: dict[str, tuple[float, float]] = LIMITS,
    controls: Sequence[str] = FIELDS,
) -> dict[str, float] | None:
    """The look that should cancel `off` (a `residual`) by `jacobian` (each measure's change per
    STEP_SCALE of each control, rows in `residual`'s order, columns in `controls`'): damped least
    squares for the controls together, a control that would pass a limit pinned to it and the rest
    solved again; the other controls are kept. None when they can't be solved."""
    free = list(controls)
    pinned: dict[str, float] = {}
    rows = range(len(off))
    new = dict(look)
    for _ in controls:
        cols = [controls.index(k) for k in free]
        left = [off[i] + sum(jacobian[i][controls.index(k)] * d for k, d in pinned.items()) for i in rows]
        normal = [[sum(jacobian[i][a] * jacobian[i][b] for i in rows) for b in cols] for a in cols]
        damping = 1e-3 * sum(normal[i][i] for i in range(len(cols))) / max(len(cols), 1) + 1e-9
        for i in range(len(cols)):
            normal[i][i] += damping
        moves = _solve(normal, [-sum(jacobian[i][a] * left[i] for i in rows) for a in cols])
        if moves is None:
            return None
        new = dict(look)
        for k, d in [*zip(free, moves, strict=True), *pinned.items()]:
            new[k] = look[k] + d * STEP_SCALE[k]
        over = [k for k in free if not limits[k][0] <= new[k] <= limits[k][1]]
        if not over:
            break
        for k in over:
            pinned[k] = (min(max(new[k], limits[k][0]), limits[k][1]) - look[k]) / STEP_SCALE[k]
            free.remove(k)
    return clamp(new, limits)


def match(
    reference: dict[str, float],
    start: dict[str, float],
    render: Any,
    limits: dict[str, tuple[float, float]] = LIMITS,
    balance: bool = False,
) -> tuple[dict[str, float], dict[str, float], int]:
    """The closed loop: `render(look)` applies a look and returns the frame's measures. From `start`, steps
    toward `reference` (each control kept inside `limits`) and returns (best look, its measures,
    passes), the best look left applied.

    First `step`'s model, up to MATCH_PASSES passes while each at least halves the distance: it fits
    Resolve's CDL, calibrated to it. When that leaves the clip short of GOOD_ENOUGH, the clip's own
    response is measured instead (Phase 20b, live: Lumetri's saturation works in linear light, so on
    a colourful clip it moved brightness, contrast and tint as much as colour, and contrast barely
    moved contrast): each control nudged by PROBE_STEP from the best look so far, one render each, gives
    how every measure moves with every control. Then up to SOLVE_PASSES solves for all five together
    (`solve_step`), each pass's result folding into that estimate (Broyden's update).

    With `balance`, `reference` is a `balance_target` and `render` gives `measure_balance`'s measures:
    only BALANCE_MEASURES count and only BALANCE_CONTROLS move (`balance_step` is the model)."""
    measures = BALANCE_MEASURES if balance else MEASURES
    controls = BALANCE_CONTROLS if balance else FIELDS
    model = balance_step if balance else step
    look = clamp(start, limits)
    seen = render(look)
    best = (error(reference, seen, measures), look, seen)
    passes = 0
    while passes < MATCH_PASSES and best[0] > GOOD_ENOUGH:
        before = best[0]
        look = model(reference, seen, look, limits)
        seen = render(look)
        passes += 1
        score = error(reference, seen, measures)
        if score < best[0]:
            best = (score, look, seen)
        if score > before / 2:
            break
    if best[0] > GOOD_ENOUGH:
        here, off = best[1], residual(reference, best[2], measures)
        jacobian = [[0.0] * len(controls) for _ in off]
        for j, k in enumerate(controls):
            nudge = PROBE_STEP[k] if here[k] + PROBE_STEP[k] <= limits[k][1] else -PROBE_STEP[k]
            look = {**here, k: here[k] + nudge}
            seen = render(look)
            moved = residual(reference, seen, measures)
            for i in range(len(off)):
                jacobian[i][j] = (moved[i] - off[i]) / (nudge / STEP_SCALE[k])
        for _ in range(SOLVE_PASSES):
            nxt = solve_step(jacobian, off, here, limits, controls)
            if nxt is None or nxt == here:
                break
            look, seen = nxt, render(nxt)
            passes += 1
            now = residual(reference, seen, measures)
            moves = [(nxt[k] - here[k]) / STEP_SCALE[k] for k in controls]
            size = sum(m * m for m in moves)
            if size > 1e-12:
                guessed = [
                    sum(jacobian[i][j] * moves[j] for j in range(len(controls))) for i in range(len(off))
                ]
                for i in range(len(off)):
                    for j in range(len(controls)):
                        jacobian[i][j] += (now[i] - off[i] - guessed[i]) * moves[j] / size
            score = error(reference, seen, measures)
            if score < best[0]:
                best = (score, nxt, seen)
                here, off = nxt, now
            if best[0] <= GOOD_ENOUGH:
                break
    if best[1] != look:
        render(best[1])
    return best[1], best[2], passes
