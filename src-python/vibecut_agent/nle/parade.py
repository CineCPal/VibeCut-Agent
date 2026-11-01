"""parade.py -- matching and balancing by the histogram and the RGB parade (PLAN.md, "Phase 20b",
`match_clip_color` to a clip and `balance_clip_color`). Standard library only, as Resolve's own Python
runs it.

A frame's parade (`parade`) is each channel's levels, and luma's (the histogram), at PERCENTILES of its
pixels, as display values from 0 to 1: where its blacks, shadows, mids, highlights and whites sit, as a
waveform parade shows them. A clip is measured on FRAMES frames spread through it, pooled.

A look here is a curve per channel and a saturation (`neutral_look`): {"r" | "g" | "b": {black, white,
gamma}, "saturation": a multiple of the clip's own}. Each editor applies the curves its own way
(`CURVES`), the saturation after them:

- Resolve: a CDL on node 1 (`cdl`), per channel slope 1 / (white - black), offset -black / (white -
  black), power 1 / gamma, so black below 0 lifts the floor; the CDL's saturation;
- Premiere: the Levels effect's R, G and B controls (`levels_controls`, the formula checked live, 20b
  probe): black input max(black, 0), black output max(-black, 0), white input min(white, 1), white
  output 1 / white above 1, gamma x 100; Lumetri's Saturation, the clip's own times the multiple.

Curves on the channels can't put back colour a camera didn't record (a duller clip stays dull), so a
match also sets the saturation, each pass by how colourful the frame is against the reference
(`colourfulness`).

A curve on a channel moves each of its percentiles exactly as it moves a single value (it's monotone),
so the curve that takes a clip's parade to the reference's can be fitted straight from the two
(`fit`). The editor then renders it and the frame is measured again: what the editor does after the
curve (Lumetri after Levels, other nodes after node 1, 8-bit Levels) shows up as a difference, which
the next pass aims past (`close_in`), keeping the closest.

Balancing (`balance`) is the same with the clip's own greys: what's in the neutral areas named (a white
card, a grey wall, a white shirt), whose channels should read alike at every level, so a cast in the
shadows alone is taken out too when the areas span levels, and the exposure brought into
colour.BALANCE_BRIGHTNESS when it's outside. Picking the greys blind, as the least colourful pixels,
proved wrong on a colourful scene with a cast that varies with tone (Phase 20b, live in Resolve: it
took pale sky for grey), so the areas are named, by the user or by the agent from a look at the frame.
"""

from __future__ import annotations

import math
from collections.abc import Callable, Sequence
from typing import Any

from vibecut_agent.nle import colour

PERCENTILES = (0.02, 0.1, 0.25, 0.5, 0.75, 0.9, 0.98)
CHANNELS = ("r", "g", "b")
HISTOGRAM = "luma"
CURVE_FIELDS = ("black", "white", "gamma")
NEUTRAL_CURVE = {"black": 0.0, "white": 1.0, "gamma": 1.0}
SATURATION_LIMITS = (0.5, 2.0)
SATURATION_DAMPING = 0.8
CURVE_LIMITS = {"black": (-0.25, 0.4), "white": (0.5, 1.6), "gamma": (0.4, 2.5)}
# The narrowest a curve's black-to-white span may be.
MIN_SPAN = 0.2
# Frames a clip is measured on, at these shares of the part of it not under a higher track.
FRAMES = (0.25, 0.5, 0.75)
# Root mean square of the percentile differences (0-1): about 2.5 code values in 255.
GOOD_ENOUGH = 0.01
PASSES = 5
FIT_ITERATIONS = 60

Pixels = list[tuple[float, float, float]]
Look = dict[str, Any]
Parade = dict[str, list[float]]


def neutral_look() -> Look:
    return {**{c: dict(NEUTRAL_CURVE) for c in CHANNELS}, "saturation": 1.0}


def is_neutral(look: Look) -> bool:
    return abs(look.get("saturation", 1.0) - 1) < 1e-3 and all(
        abs(look[c][k] - NEUTRAL_CURVE[k]) < 1e-3 for c in CHANNELS for k in CURVE_FIELDS
    )


def percentiles(values: Sequence[float]) -> list[float]:
    """`values` at PERCENTILES, interpolating between the nearest two."""
    if not values:
        raise colour.ColourError("The frame has no pixels")
    ordered = sorted(values)
    out = []
    for q in PERCENTILES:
        at = (len(ordered) - 1) * q
        lo = int(at)
        hi = min(lo + 1, len(ordered) - 1)
        out.append(round(ordered[lo] + (ordered[hi] - ordered[lo]) * (at - lo), 4))
    return out


def _luma(p: tuple[float, float, float]) -> float:
    return 0.2126 * p[0] + 0.7152 * p[1] + 0.0722 * p[2]


def colourfulness(pixels: Pixels) -> float:
    """Mean max - min channel over the pixels not near black or white (colour.measure's `colour`)."""
    mids = [p for p in pixels if colour.CLIP_LOW < _luma(p) < colour.CLIP_HIGH] or pixels
    return round(sum(max(p) - min(p) for p in mids) / len(mids), 4)


def parade(pixels: Pixels) -> Parade:
    """Each channel's levels at PERCENTILES (the parade), luma's (the histogram), and `colour`, the
    frame's colourfulness."""
    out = {c: percentiles([p[i] for p in pixels]) for i, c in enumerate(CHANNELS)}
    out[HISTOGRAM] = percentiles([_luma(p) for p in pixels])
    out["colour"] = [colourfulness(pixels)]
    return out


def error(reference: Parade, seen: Parade) -> float:
    """Root mean square of the differences at every percentile of the parade and histogram the
    reference has (0-1 units)."""
    keys = [k for k in (*CHANNELS, HISTOGRAM) if k in reference]
    diffs = [s - r for k in keys for r, s in zip(reference[k], seen[k], strict=True)]
    return math.sqrt(sum(d * d for d in diffs) / len(diffs))


def _clamped(curve: dict[str, float]) -> dict[str, float]:
    out = {k: min(max(curve[k], CURVE_LIMITS[k][0]), CURVE_LIMITS[k][1]) for k in CURVE_FIELDS}
    if out["white"] - out["black"] < MIN_SPAN:
        out["white"] = out["black"] + MIN_SPAN
    return {k: round(v, 4) for k, v in out.items()}


def resolve_curve(curve: dict[str, float], x: float) -> float:
    """What a CDL from `cdl` (or `cdl_controls`) does to a display value: Resolve's, and Premiere's ASC CDL
    effect, which follows the same formula on display values (20b probe: within 0.003 on average)."""
    t = (x - curve["black"]) / (curve["white"] - curve["black"])
    return float(min(max(t, 0.0), 1.0) ** (1 / curve["gamma"]))


def premiere_curve(curve: dict[str, float], x: float) -> float:
    """What Premiere's Levels, set by `levels_controls`, does to a display value (20b probe: a white
    input of 200, a gamma of 150 and a black output of 30 each within a code value of this)."""
    black_in, black_out = max(curve["black"], 0.0), max(-curve["black"], 0.0)
    white_in = min(curve["white"], 1.0)
    white_out = 1 / curve["white"] if curve["white"] > 1 else 1.0
    t = min(max((x - black_in) / (white_in - black_in), 0.0), 1.0)
    return float(black_out + (white_out - black_out) * t ** (1 / curve["gamma"]))


CURVES: dict[str, Callable[[dict[str, float], float], float]] = {
    "resolve": resolve_curve,
    "premiere": premiere_curve,
}


def cdl(look: Look) -> dict[str, str]:
    """Resolve's SetCDL request for node 1 that gives `look` (saturation as shot)."""
    spans = [look[c]["white"] - look[c]["black"] for c in CHANNELS]
    return {
        "NodeIndex": "1",
        "Slope": " ".join(f"{1 / s:.5f}" for s in spans),
        "Offset": " ".join(f"{-look[c]['black'] / s:.5f}" for c, s in zip(CHANNELS, spans, strict=True)),
        "Power": " ".join(f"{1 / look[c]['gamma']:.5f}" for c in CHANNELS),
        "Saturation": f"{look.get('saturation', 1.0):.5f}",
    }


# Premiere's ASC CDL effect (balancing, 20b), by the keys the panel takes (host.jsx `VC_CDL`).
CDL_PARTS = ("slope", "offset", "power")


def cdl_controls(look: Look, saturation: float = 1.0) -> dict[str, float]:
    """Premiere's ASC CDL controls for `look`'s curves (as `cdl`), its Saturation `saturation`."""
    out: dict[str, float] = {}
    for c in CHANNELS:
        curve = look[c]
        span = curve["white"] - curve["black"]
        out[f"{c}_slope"] = round(1 / span, 5)
        out[f"{c}_offset"] = round(-curve["black"] / span, 5)
        out[f"{c}_power"] = round(1 / curve["gamma"], 5)
    out["saturation"] = round(saturation, 5)
    return out


def cdl_look(controls: dict[str, Any]) -> Look:
    """The curves Premiere's ASC CDL controls give (the inverse of `cdl_controls`); its Saturation as the
    look's saturation."""
    look: Look = {}
    for c in CHANNELS:
        slope, offset = max(float(controls[f"{c}_slope"]), 1e-6), float(controls[f"{c}_offset"])
        look[c] = {
            "black": round(-offset / slope, 4),
            "white": round((1 - offset) / slope, 4),
            "gamma": round(1 / max(float(controls[f"{c}_power"]), 1e-6), 4),
        }
    look["saturation"] = round(float(controls.get("saturation", 1.0)), 4)
    return look


# Premiere's Levels controls, by the keys the panel takes (host.jsx `VC_LEVELS`), 0-255 and gamma x 100.
LEVELS_PARTS = ("black_in", "white_in", "black_out", "white_out", "gamma")
LEVELS_NEUTRAL = {"black_in": 0.0, "white_in": 255.0, "black_out": 0.0, "white_out": 255.0, "gamma": 100.0}


def levels_controls(look: Look) -> dict[str, float]:
    """Premiere's Levels controls for `look` (its RGB controls kept neutral, so only R, G and B curve)."""
    out = {f"rgb_{part}": value for part, value in LEVELS_NEUTRAL.items()}
    for c in CHANNELS:
        curve = look[c]
        out[f"{c}_black_in"] = round(max(curve["black"], 0.0) * 255, 2)
        out[f"{c}_black_out"] = round(max(-curve["black"], 0.0) * 255, 2)
        out[f"{c}_white_in"] = round(min(curve["white"], 1.0) * 255, 2)
        out[f"{c}_white_out"] = round((1 / curve["white"] if curve["white"] > 1 else 1.0) * 255, 2)
        out[f"{c}_gamma"] = round(curve["gamma"] * 100, 2)
    return out


def levels_look(controls: dict[str, Any]) -> Look | None:
    """The look Premiere's Levels controls give, or None when they aren't one VibeCut sets (an RGB
    control moved, or both a black input and a black output)."""
    try:
        if any(abs(float(controls[f"rgb_{p}"]) - v) > 0.01 for p, v in LEVELS_NEUTRAL.items()):
            return None
        look = {}
        for c in CHANNELS:
            black_in, black_out = (
                float(controls[f"{c}_black_in"]) / 255,
                float(controls[f"{c}_black_out"]) / 255,
            )
            if black_in > 1e-3 and black_out > 1e-3:
                return None
            white_in, white_out = (
                float(controls[f"{c}_white_in"]) / 255,
                float(controls[f"{c}_white_out"]) / 255,
            )
            white = white_in if white_out >= 0.999 else 1 / max(white_out, 1e-3)
            look[c] = {
                "black": round(black_in - black_out, 4),
                "white": round(white, 4),
                "gamma": round(float(controls[f"{c}_gamma"]) / 100, 4),
            }
        return look
    except (KeyError, TypeError, ValueError):
        return None


def _solve3(a: list[list[float]], b: list[float]) -> list[float] | None:
    return colour._solve(a, b)


def fit_channel(
    curve: Callable[[dict[str, float], float], float],
    xs: Sequence[float],
    ys: Sequence[float],
    start: dict[str, float],
) -> dict[str, float]:
    """The black, white and gamma (inside CURVE_LIMITS) that take `xs` nearest to `ys` through `curve`:
    damped least squares (Levenberg-Marquardt), slopes by small steps."""
    here = _clamped(start)

    def cost(c: dict[str, float]) -> list[float]:
        return [curve(c, x) - y for x, y in zip(xs, ys, strict=True)]

    off = cost(here)
    total = sum(v * v for v in off)
    damping = 1e-3
    for _ in range(FIT_ITERATIONS):
        jacobian = []
        for k in CURVE_FIELDS:
            nudged = {**here, k: here[k] + 1e-4}
            jacobian.append([(a - b) / 1e-4 for a, b in zip(cost(nudged), off, strict=True)])
        normal = [
            [sum(p * q for p, q in zip(jacobian[i], jacobian[j], strict=True)) for j in range(3)]
            for i in range(3)
        ]
        gradient = [-sum(p * r for p, r in zip(jacobian[i], off, strict=True)) for i in range(3)]
        improved = False
        while damping < 1e6:
            damped = [
                [normal[i][j] + (damping * (normal[i][i] + 1e-9) if i == j else 0.0) for j in range(3)]
                for i in range(3)
            ]
            moves = _solve3(damped, gradient)
            if moves is None:
                damping *= 10
                continue
            trial = _clamped({k: here[k] + m for k, m in zip(CURVE_FIELDS, moves, strict=True)})
            trial_off = cost(trial)
            trial_total = sum(v * v for v in trial_off)
            if trial_total < total:
                here, off, total = trial, trial_off, trial_total
                damping = max(damping / 10, 1e-7)
                improved = True
                break
            damping *= 10
        if not improved or total < 1e-10:
            break
    return here


def fit(curve: Callable[[dict[str, float], float], float], source: Parade, aim: Parade, start: Look) -> Look:
    """The look whose curves take each channel of `source` to `aim` (`start`'s saturation kept)."""
    return {
        **{c: fit_channel(curve, source[c], aim[c], start[c]) for c in CHANNELS},
        "saturation": start.get("saturation", 1.0),
    }


def close_in(
    reference: Parade,
    source: Parade,
    show: Callable[[Look], Parade],
    curve: Callable[[dict[str, float], float], float],
    saturate: bool = False,
) -> tuple[Look, Parade, int]:
    """From the clip as it is with no curve (`source`), up to PASSES passes: fit the curves that take
    it to `aim` (at first the reference), `show` them (apply, render, measure), then move the aim by
    what's still off, keeping the closest. Returns (best look, its measures, passes), the best look
    left applied. Only the reference's channels are fitted; its luma (when it has one) is judged. With
    `saturate`, the saturation is set each pass by the reference's `colour` against the frame's."""
    best = (error(reference, source), neutral_look(), source)
    aim = {c: list(reference[c]) for c in CHANNELS}
    look = neutral_look()
    shown = look
    passes = 0
    while passes < PASSES and best[0] > GOOD_ENOUGH:
        look = fit(curve, source, aim, look)
        if passes and look == shown:
            break
        seen = show(look)
        shown = look
        passes += 1
        score = error(reference, seen)
        if score < best[0]:
            best = (score, look, seen)
        aim = {
            c: [
                min(max(a + r - s, -0.25), 1.25)
                for a, r, s in zip(aim[c], reference[c], seen[c], strict=True)
            ]
            for c in CHANNELS
        }
        if saturate:
            # After the curves (which move colourfulness too), damped: a cast reads as colour.
            look = {**look, "saturation": _saturation(look["saturation"], reference, seen)}
    if best[1] != shown:
        show(best[1])
    return best[1], best[2], passes


def _saturation(now: float, reference: Parade, seen: Parade) -> float:
    """The saturation that should bring `seen`'s colourfulness to the reference's."""
    wanted = now * ((reference["colour"][0] + 1e-3) / (seen["colour"][0] + 1e-3)) ** SATURATION_DAMPING
    return round(float(min(max(wanted, SATURATION_LIMITS[0]), SATURATION_LIMITS[1])), 4)


def match(
    reference: Parade,
    show: Callable[[Look | None], Pixels],
    curve: Callable[[dict[str, float], float], float],
) -> tuple[Look, Parade, int]:
    """The curves that make a clip's parade and histogram the reference's. `show(look)` applies the
    look (None: as it is) and returns the clip's pooled pixels as the editor shows them."""
    source = parade(show(neutral_look()))
    return close_in(reference, source, lambda look: parade(show(look)), curve, saturate=True)


def area_pixels(
    pixels: Pixels, areas: Sequence[tuple[float, float, float, float]]
) -> tuple[list[int], float]:
    """(indices, chroma): the pixels of a whole SAMPLE_WIDTH x SAMPLE_HEIGHT frame inside `areas` ((x, y,
    width, height), fractions from its top left; a pixel only partly inside left out), not near black
    or white, and how colourful they are on average ((max - min) / max). Refused (ColourError) when
    they're too few (clipped, or an area under a pixel) or not near grey."""
    width, height = colour.SAMPLE_WIDTH, colour.SAMPLE_HEIGHT
    if len(pixels) != width * height:
        raise colour.ColourError("The frame isn't the size areas are measured on")
    inside: list[int] = []
    for x, y, w, h in areas:
        left, right = math.ceil(x * width - 1e-6), math.floor((x + w) * width + 1e-6)
        top, bottom = math.ceil(y * height - 1e-6), math.floor((y + h) * height + 1e-6)
        inside += [r * width + c for r in range(top, bottom) for c in range(left, right)]
    greys = [i for i in dict.fromkeys(inside) if colour.CLIP_LOW < _luma(pixels[i]) < colour.CLIP_HIGH]
    if len(greys) < 4:
        raise colour.ColourError(
            "the neutral area is too small, or clipped to black or white: name a bigger one, not blown out"
        )
    chroma = sum((max(pixels[i]) - min(pixels[i])) / max(max(pixels[i]), 1e-3) for i in greys) / len(greys)
    if chroma > colour.GREY_MAX_CHROMA:
        raise colour.ColourError(
            "the area named isn't near grey (it's strongly coloured): name something white, grey or black"
        )
    return greys, round(chroma, 4)


def grey_parade(pixels: Pixels, greys: Sequence[int]) -> Parade:
    """The parade of the pixels at `greys`."""
    return {c: percentiles([pixels[i][n] for i in greys]) for n, c in enumerate(CHANNELS)}


def brightness(pixels: Pixels) -> float:
    return round(sum(_luma(p) for p in pixels) / len(pixels), 4)


def balance_target(greys: Parade, bright: float) -> Parade:
    """The greys' parade with its channels alike at each level (their luma-weighted mean), scaled to
    bring the frame's mean brightness into colour.BALANCE_BRIGHTNESS when it's outside."""
    low, high = colour.BALANCE_BRIGHTNESS
    gain = min(max(bright, low), high) / max(bright, 1e-3)
    # Within about 6% of the range (colour.GOOD_ENOUGH on `colour.error`'s scale) is in it.
    if abs(math.log(gain)) <= 2 * colour.GOOD_ENOUGH:
        gain = 1.0
    level = [
        min((0.2126 * r + 0.7152 * g + 0.0722 * b) * gain, 1.0)
        for r, g, b in zip(greys["r"], greys["g"], greys["b"], strict=True)
    ]
    return {c: [round(v, 4) for v in level] for c in CHANNELS}


def balance(
    show: Callable[[Look | None], Pixels],
    curve: Callable[[dict[str, float], float], float],
    areas: Sequence[tuple[float, float, float, float]],
) -> dict[str, Any]:
    """Balances a clip to its own neutral, read from `areas` of its frame (`show` gives the whole frame,
    untrimmed). {"balanced": True, "was"} when it's there already (nothing applied); else {"look",
    "seen", "target", "was", "passes", "distance"}, the look left applied. Areas that can't be used
    raise ColourError, nothing applied."""
    as_is = show(None)
    greys, chroma = area_pixels(as_is, areas)
    trimmed = colour.without_borders(as_is, colour.SAMPLE_WIDTH, colour.SAMPLE_HEIGHT)
    was = {**grey_parade(as_is, greys), "brightness": [brightness(trimmed)], "greyChroma": [chroma]}
    target = balance_target(was, was["brightness"][0])
    current = {c: was[c] for c in CHANNELS}
    if error(target, current) <= GOOD_ENOUGH:
        return {"balanced": True, "was": was}
    neutral = show(neutral_look())
    source = grey_parade(neutral, greys)
    # The target is fixed from the clip as it was; the greys are the same pixels in every frame.
    look, seen, passes = close_in(target, source, lambda look: grey_parade(show(look), greys), curve)
    return {
        "look": look,
        "seen": seen,
        "target": target,
        "was": was,
        "passes": passes,
        "distance": round(error(target, seen), 4),
    }


def describe(look: Look) -> str:
    """'R black +0.02 white 0.95, B gamma 1.10' (neutral parts left out), or 'neutral'."""
    parts = []
    for c in CHANNELS:
        bits = []
        for k in CURVE_FIELDS:
            v = look[c][k]
            if abs(v - NEUTRAL_CURVE[k]) < 5e-3:
                continue
            bits.append(f"{k} {v:+.2f}" if k == "black" else f"{k} {v:.2f}")
        if bits:
            parts.append(f"{c.upper()} {' '.join(bits)}")
    if abs(look.get("saturation", 1.0) - 1) >= 5e-3:
        parts.append(f"saturation x{look['saturation']:.2f}")
    return ", ".join(parts) or "neutral"
