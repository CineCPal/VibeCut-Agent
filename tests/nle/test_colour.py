"""The colour maths both editors share (vibecut_agent/nle/colour.py, Phase 19c)."""

from __future__ import annotations

import math
import shutil
import subprocess
from pathlib import Path

import pytest

from vibecut_agent.nle import colour


def chart() -> list[tuple[float, float, float]]:
    """A grey ramp and some colours, as display RGB."""
    greys = [(v / 10, v / 10, v / 10) for v in range(11)]
    colours = [
        (0.71, 0.16, 0.16),
        (0.16, 0.63, 0.24),
        (0.16, 0.24, 0.71),
        (0.78, 0.59, 0.47),
        (0.78, 0.75, 0.2),
    ]
    return (greys + colours) * 20


def resolve_render(pixels, look):
    """What Resolve shows with colour.cdl(look) on node 1: (in * slope + offset) ** power, then saturation
    around Rec. 709 luma, clipped (as checked on a chart, 19c probe)."""
    c = colour.cdl(look)
    slope = [float(v) for v in c["Slope"].split()]
    offset = [float(v) for v in c["Offset"].split()]
    sat = float(c["Saturation"])
    out = []
    for p in pixels:
        rgb = [min(max(p[i] * slope[i] + offset[i], 0.0), 1.0) for i in range(3)]
        luma = 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2]
        out.append(tuple(min(max(luma + sat * (v - luma), 0.0), 1.0) for v in rgb))
    return out


def test_requests_are_checked_and_fields_left_out_are_neutral():
    (want,) = colour.look_wants({"looks": [{"itemId": "v1", "exposure": 0.5}]})
    assert want == {"itemId": "v1", "look": {**colour.NEUTRAL, "exposure": 0.5}}
    for bad, message in [
        ({"looks": []}, "looks must list"),
        ({"looks": [{"itemId": "v1"}]}, "must give exposure"),
        ({"looks": [{"itemId": "v1", "temperature": 150}]}, "temperature must be from -100 to 100"),
        ({"looks": [{"itemId": "v1", "tint": True}]}, "tint must be a number"),
        ({"looks": [{"itemId": "v1", "tint": 1}, {"itemId": "v1", "tint": 2}]}, "listed twice"),
    ]:
        with pytest.raises(colour.ColourError, match=message):
            colour.look_wants(bad)
    assert colour.match_wants({"referenceId": "v1", "itemIds": ["v1", "v2", "v2"]}) == ("v1", ["v2"])
    with pytest.raises(colour.ColourError, match="other than the reference"):
        colour.match_wants({"referenceId": "v1", "itemIds": ["v1"]})


def test_the_cdl_moves_the_picture_as_lumetri_does():
    assert colour.cdl(colour.NEUTRAL) == {
        "NodeIndex": "1", "Slope": "1.00000 1.00000 1.00000", "Offset": "0.00000 0.00000 0.00000",
        "Power": "1 1 1", "Saturation": "1.00000",
    }  # fmt: skip
    # -1 stop is Lumetri's 0.749 on display values.
    assert float(colour.cdl({**colour.NEUTRAL, "exposure": -1})["Slope"].split()[1]) == pytest.approx(
        0.749, abs=1e-3
    )
    warm = colour.measure(resolve_render(chart(), {**colour.NEUTRAL, "temperature": 50}))
    neutral = colour.measure(chart())
    # Lumetri's +50 moved ln(R/B) by about 0.29.
    assert warm["warmth"] - neutral["warmth"] == pytest.approx(50 * colour.K_TEMPERATURE, abs=0.05)
    magenta = colour.measure(resolve_render(chart(), {**colour.NEUTRAL, "tint": 50}))
    assert magenta["tint"] < neutral["tint"] - 0.15
    flat = colour.measure(resolve_render(chart(), {**colour.NEUTRAL, "contrast": -50}))
    assert flat["contrast"] < neutral["contrast"]
    grey = colour.measure(resolve_render(chart(), {**colour.NEUTRAL, "saturation": 0}))
    assert grey["colour"] == pytest.approx(0, abs=1e-3)


def test_matching_closes_in_on_the_reference():
    reference = colour.measure(chart())
    # The same chart shot darker, warmer, a little green and duller.
    off = [(min(r * 0.8 * 1.08, 1), g * 0.8 * 1.03, b * 0.8 * 0.85) for r, g, b in chart()]
    off = [tuple(0.6 * v + 0.4 * sum(p) / 3 for v in p) for p in off]
    passes = []

    def render(look):
        passes.append(look)
        return colour.measure(resolve_render(off, look))

    look, seen, count = colour.match(reference, dict(colour.NEUTRAL), render)
    assert colour.error(reference, colour.measure(off)) > 0.1
    assert colour.error(reference, seen) < colour.GOOD_ENOUGH
    assert look["exposure"] > 0 and look["temperature"] < 0 and look["saturation"] > 100
    assert 1 <= count <= colour.MATCH_PASSES
    # The best look is the one left applied.
    assert passes[-1] == look


def test_a_match_already_close_takes_no_step():
    reference = colour.measure(chart())
    looks = []
    look, _seen, count = colour.match(
        reference, dict(colour.NEUTRAL), lambda lk: looks.append(lk) or reference
    )
    assert (look, count, len(looks)) == (colour.NEUTRAL, 0, 1)


def test_the_moment_to_look_at_avoids_covers():
    assert colour.uncovered_moment(0, 10, []) == 5
    assert colour.uncovered_moment(0, 10, [(4, 6)]) in (2.0, 8.0)
    assert colour.uncovered_moment(0, 10, [(0, 8)]) == 9
    assert colour.uncovered_moment(0, 10, [(-1, 4), (3, 11)]) is None
    assert colour.uncovered_moment(0, 10, [(20, 30)]) == 5


def test_describe_and_measure():
    assert (
        colour.describe({**colour.NEUTRAL, "exposure": 0.5, "saturation": 120})
        == "exposure +0.5, saturation 120"
    )
    assert colour.describe(colour.NEUTRAL) == "neutral"
    measured = colour.measure([(0.6, 0.5, 0.4)] * 10)
    assert measured["warmth"] == pytest.approx(math.log(0.6001 / 0.4001), abs=1e-3)
    assert measured["contrast"] == 0


@pytest.mark.skipif(shutil.which("ffmpeg") is None, reason="needs ffmpeg")
def test_a_frame_is_read_small_with_ffmpeg(tmp_path: Path):
    path = tmp_path / "frame.png"
    subprocess.run(
        [
            "ffmpeg",
            "-v",
            "error",
            "-y",
            "-f",
            "lavfi",
            "-i",
            "color=c=0x806040:s=640x360",
            "-frames:v",
            "1",
            str(path),
        ],
        check=True,
    )
    pixels = colour.frame_pixels(str(path))
    assert len(pixels) == colour.SAMPLE_WIDTH * colour.SAMPLE_HEIGHT
    assert pixels[0] == pytest.approx((0x80 / 255, 0x60 / 255, 0x40 / 255), abs=2 / 255)
    with pytest.raises(colour.ColourError):
        colour.frame_pixels(str(tmp_path / "missing.png"))
