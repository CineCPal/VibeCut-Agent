"""Matching and balancing by the histogram and the RGB parade (vibecut_agent/nle/parade.py, Phase 20b)."""

from __future__ import annotations

import pytest

from tests.nle.test_colour import chart, lumetri_render
from vibecut_agent.nle import colour, parade


def curved(pixels, look, editor):
    """The pixels through `look`'s curves as `editor` applies them."""
    curve = parade.CURVES[editor]
    sat = look.get("saturation", 1.0)
    out = []
    for p in pixels:
        rgb = [curve(look[c], p[i]) for i, c in enumerate(parade.CHANNELS)]
        luma = 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2]
        out.append(tuple(min(max(luma + sat * (v - luma), 0.0), 1.0) for v in rgb))
    return out


def shown(pixels, editor, after=None):
    """A clip in an editor: the curves, then (Premiere) whatever Lumetri does after Levels."""
    applied = []

    def show(look):
        applied.append(look)
        out = pixels if look is None else curved(pixels, look, editor)
        return after(out) if after else out

    return show, applied


def shadows_off() -> list[tuple[float, float, float]]:
    """The chart shot with crushed blacks, blue in the shadows only and highlights rolled warm."""
    out = []
    for r, g, b in chart():
        out.append(
            (
                min(max(r * 1.05 - 0.04, 0.0), 1.0) ** 1.1,
                max(g - 0.04, 0.0) ** 1.15,
                min(max(b + 0.06 * (1 - b) ** 3 - 0.03, 0.0), 1.0) ** 1.25,
            )
        )
    return out


def test_the_parade_and_histogram_are_levels_at_percentiles():
    ramp = [(v / 100, v / 200, 0.0) for v in range(101)]
    measured = parade.parade(ramp)
    assert measured["r"] == [0.02, 0.1, 0.25, 0.5, 0.75, 0.9, 0.98]
    assert measured["g"] == [0.01, 0.05, 0.125, 0.25, 0.375, 0.45, 0.49]
    assert measured["b"] == [0.0] * 7
    assert measured["luma"][3] == pytest.approx(0.2126 * 0.5 + 0.7152 * 0.25, abs=1e-3)
    assert measured["colour"] == [parade.colourfulness(ramp)]
    assert parade.error(measured, measured) == 0


def test_premiere_levels_follow_the_probe():
    # Live (20b probe): R white input 200 took 125 to 159, G gamma 150 took 125 to 158, B black output 30
    # took 124 to 139 (each of 255).
    look = parade.neutral_look()
    look["r"]["white"] = 200 / 255
    look["g"]["gamma"] = 1.5
    look["b"]["black"] = -30 / 255
    assert parade.premiere_curve(look["r"], 125 / 255) * 255 == pytest.approx(159, abs=1)
    assert parade.premiere_curve(look["g"], 125 / 255) * 255 == pytest.approx(158, abs=1)
    assert parade.premiere_curve(look["b"], 124 / 255) * 255 == pytest.approx(139, abs=1)
    controls = parade.levels_controls(look)
    assert (controls["r_white_in"], controls["g_gamma"], controls["b_black_out"]) == (200, 150, 30)
    assert controls["rgb_gamma"] == 100 and controls["b_black_in"] == 0
    back = parade.levels_look(controls)
    assert back is not None
    assert all(
        back[c][k] == pytest.approx(look[c][k], abs=1e-3)
        for c in parade.CHANNELS
        for k in parade.CURVE_FIELDS
    )
    # Whites pulled down: white output under 255.
    look["r"]["white"] = 1.25
    pulled = parade.levels_look(parade.levels_controls(look))
    assert pulled is not None and pulled["r"]["white"] == pytest.approx(1.25, abs=1e-3)
    # An RGB control moved by hand isn't a look VibeCut set.
    assert parade.levels_look({**controls, "rgb_gamma": 120}) is None


def test_resolve_cdl_is_the_curve():
    look = parade.neutral_look()
    look["r"] = {"black": -0.1, "white": 0.9, "gamma": 1.25}
    c = parade.cdl(look)
    slope, offset, power = (float(c[k].split()[0]) for k in ("Slope", "Offset", "Power"))
    for x in (0.0, 0.3, 0.8):
        assert min(max(x * slope + offset, 0), 1) ** power == pytest.approx(
            parade.resolve_curve(look["r"], x), abs=1e-4
        )
    assert parade.cdl(parade.neutral_look())["Slope"] == "1.00000 1.00000 1.00000"
    assert parade.cdl({**look, "saturation": 1.25})["Saturation"] == "1.25000"


@pytest.mark.parametrize("editor", ["resolve", "premiere"])
def test_a_curve_is_fitted_straight_from_the_percentiles(editor):
    look = {
        "r": {"black": 0.05, "white": 0.92, "gamma": 1.2},
        "g": {"black": -0.04, "white": 1.0, "gamma": 0.9},
        "b": {"black": 0.0, "white": 1.1, "gamma": 1.0},
    }
    source = parade.parade(chart())
    target = parade.parade(curved(chart(), look, editor))
    fitted = parade.fit(parade.CURVES[editor], source, target, parade.neutral_look())
    assert parade.error(target, parade.parade(curved(chart(), fitted, editor))) < 0.003


@pytest.mark.parametrize("editor", ["resolve", "premiere"])
def test_matching_by_the_parade_fixes_what_the_five_controls_cannot(editor):
    reference = parade.parade(chart())
    off = shadows_off()
    show, applied = shown(off, editor)
    look, seen, passes = parade.match(reference, show, parade.CURVES[editor])
    assert parade.error(reference, parade.parade(off)) > 0.03
    assert parade.error(reference, seen) < parade.GOOD_ENOUGH
    assert 1 <= passes <= parade.PASSES and applied[-1] == look
    # The five overall controls leave the shadows' cast and the crushed blacks: further off.
    five, _seen, _n = colour.match(
        colour.measure(chart()),
        dict(colour.NEUTRAL),
        lambda lk: colour.measure(lumetri_render(off, lk)),
    )
    assert parade.error(reference, parade.parade(lumetri_render(off, five))) > 2 * parade.error(
        reference, seen
    )


def test_what_the_editor_does_after_the_curves_is_aimed_past():
    # Premiere: Lumetri (here a little warmer and less saturated) after Levels.
    after = lambda px: lumetri_render(px, {**colour.NEUTRAL, "temperature": 12, "saturation": 92})
    reference = parade.parade(chart())
    show, _applied = shown(shadows_off(), "premiere", after)
    _look, seen, passes = parade.match(reference, show, parade.premiere_curve)
    first = parade.fit(
        parade.premiere_curve, parade.parade(after(shadows_off())), reference, parade.neutral_look()
    )
    assert parade.error(reference, seen) < parade.error(
        reference, parade.parade(after(curved(shadows_off(), first, "premiere")))
    )
    # Desaturation after the curves can't be undone channel by channel: close, not exact.
    assert parade.error(reference, seen) < 0.02 and passes >= 2


@pytest.mark.parametrize("editor", ["resolve", "premiere"])
def test_balancing_makes_the_greys_neutral_at_every_level(editor):
    # The chart with blue only in its shadows and its highlights warm: one temperature can't fix both.
    cast = [
        (min(r + 0.04 * r * r, 1.0), g, min(b + 0.08 * (1 - b) ** 2 - 0.03 * b * b, 1.0))
        for r, g, b in chart()
    ]
    show, applied = shown(cast, editor)
    result = parade.balance(show, parade.CURVES[editor])
    assert applied[0] is None and parade.is_neutral(applied[1])
    assert result["distance"] < parade.GOOD_ENOUGH
    greys = [p for p in curved(cast, result["look"], editor)[:11]]
    for r, g, b in greys[2:10]:
        assert abs(r - g) < 0.02 and abs(b - g) < 0.02


def test_a_balanced_clip_is_left_alone_and_a_frame_with_no_greys_is_refused():
    show, applied = shown(chart(), "resolve")
    assert parade.balance(show, parade.resolve_curve)["balanced"] is True
    assert applied == [None]
    card = [(0.9, 0.8, 0.1)] * 50 + [(0.1, 0.3, 0.9)] * 50
    show, applied = shown(card, "resolve")
    with pytest.raises(colour.ColourError, match="nothing in the frame is near grey"):
        parade.balance(show, parade.resolve_curve)
    assert applied == [None]


def test_balancing_brings_a_dark_clip_into_range():
    dark = [(r * 0.45, g * 0.45, b * 0.45) for r, g, b in chart()]
    show, _applied = shown(dark, "resolve")
    result = parade.balance(show, parade.resolve_curve)
    after = parade.brightness(curved(dark, result["look"], "resolve"))
    assert parade.brightness(dark) < colour.BALANCE_BRIGHTNESS[0] <= after + 0.02


def test_describe():
    look = parade.neutral_look()
    assert parade.describe(look) == "neutral"
    look["r"]["black"] = 0.02
    look["b"]["gamma"] = 1.1
    assert parade.describe(look) == "R black +0.02, B gamma 1.10"
    look["saturation"] = 1.2
    assert parade.describe(look) == "R black +0.02, B gamma 1.10, saturation x1.20"


def test_a_duller_clip_gets_its_colour_back():
    # The chart shot duller and darker: curves alone can't add colour, the saturation does.
    dull = [tuple(0.8 * (0.6 * v + 0.4 * sum(p) / 3) for v in p) for p in chart()]
    reference = parade.parade(chart())
    show, _applied = shown(dull, "resolve")
    look, seen, _passes = parade.match(reference, show, parade.resolve_curve)
    assert look["saturation"] > 1.3
    assert seen["colour"][0] == pytest.approx(reference["colour"][0], rel=0.05)
    # Curves alone get colour back only as far as contrast brings it.
    alone, _applied = shown(dull, "resolve")
    _look, curves_only, _n = parade.close_in(
        reference, parade.parade(dull), lambda lk: parade.parade(alone(lk)), parade.resolve_curve
    )
    # Dulled toward each pixel's mean, not its luma, so the hues don't all come back: closer, not exact.
    assert parade.error(reference, seen) < 0.6 * parade.error(reference, curves_only)
