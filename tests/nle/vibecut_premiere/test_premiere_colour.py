"""Colour on the connected sequence (premiere_colour.py, Phase 19c) against test_premiere_edit.py's fake
Premiere, given the panel's read_lumetri, set_lumetri and export_frame: Lumetri values per clip, and a
frame rendered through them (as a CDL, test_colour.resolve_render) into the bridge folder's frames/."""

import shutil

import pytest
from PIL import Image

from tests.nle.test_colour import chart, resolve_render
from tests.nle.vibecut_premiere.test_premiere_edit import T, call, ids_of, revert
from tests.nle.vibecut_premiere.test_premiere_edit import setup as edit_setup  # noqa: F401
from vibecut_agent.nle import colour, parade
from vibecut_agent.nle.premiere import HostError

pytestmark = pytest.mark.skipif(shutil.which("ffmpeg") is None, reason="needs ffmpeg")

OFF = [
    tuple(0.6 * v + 0.4 * sum(p) / 3 for v in (min(p[0] * 0.85, 1), p[1] * 0.8, p[2] * 0.68)) for p in chart()
]


@pytest.fixture
def setup(edit_setup, tmp_path, monkeypatch):  # noqa: F811
    host, premiere, media = edit_setup
    monkeypatch.setenv("VIBECUT_AGENT_PREMIERE_BRIDGE_DIR", str(tmp_path / "bridge"))
    (a,) = ids_of(premiere, "A.mov")
    (b,) = ids_of(premiere, "B.mov")
    shots = {a: chart(), b: OFF}
    lumetri: dict[str, dict] = {}
    levels: dict[str, dict] = {}
    cdl: dict[str, dict] = {}
    frames: list[float] = []

    def read_lumetri(args):
        return {
            "items": [
                {"id": i, "present": i in lumetri, "values": dict(lumetri.get(i, {})), "keyed": []}
                for i in args["ids"]
            ]
        }

    def set_lumetri(args):
        for want in args["items"]:
            lumetri.setdefault(want["id"], dict(colour.NEUTRAL)).update(want["values"])
        return read_lumetri({"ids": [w["id"] for w in args["items"]]})

    def read_levels(args):
        return {
            "items": [
                {"id": i, "present": i in levels, "values": dict(levels.get(i, {})), "keyed": []}
                for i in args["ids"]
            ]
        }

    def set_levels(args):
        for want in args["items"]:
            levels.setdefault(want["id"], parade.levels_controls(parade.neutral_look())).update(
                want["values"]
            )
        return read_levels({"ids": [w["id"] for w in args["items"]]})

    def read_cdl(args):
        return {
            "items": [
                {"id": i, "present": i in cdl, "values": dict(cdl.get(i, {})), "keyed": []}
                for i in args["ids"]
            ]
        }

    def set_cdl(args):
        for want in args["items"]:
            cdl.setdefault(want["id"], parade.cdl_controls(parade.neutral_look())).update(want["values"])
        return read_cdl({"ids": [w["id"] for w in args["items"]]})

    def remove_effect(args):
        held = {"lumetri": lumetri, "levels": levels, "cdl": cdl}[args["effect"]]
        held.pop(args["id"], None)
        return {"removed": True}

    def export_frame(args):
        ticks = int(args["ticks"])
        frames.append(ticks / T)
        shown = [
            c
            for track in reversed(premiere.video)
            for c in track
            if int(c["startTicks"]) <= ticks < int(c["endTicks"]) and not c["disabled"]
        ]
        pixels = shots.get(shown[0]["id"], chart()) if shown else [(0.0, 0.0, 0.0)] * 16
        if shown and shown[0]["id"] in cdl:
            # The CDL's curves, then its saturation about Rec.709 luma (as Resolve's, test_parade.curved).
            values = cdl[shown[0]["id"]]
            look = parade.cdl_look(values)
            sat = float(values["saturation"])
            out = []
            for p in pixels:
                rgb = [parade.resolve_curve(look[c], p[i]) for i, c in enumerate("rgb")]
                luma = 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2]
                out.append(tuple(min(max(luma + sat * (v - luma), 0.0), 1.0) for v in rgb))
            pixels = out
        if shown and shown[0]["id"] in levels:
            look = parade.levels_look(levels[shown[0]["id"]])
            pixels = [
                tuple(parade.premiere_curve(look[c], p[i]) for i, c in enumerate("rgb")) for p in pixels
            ]
        if shown and shown[0]["id"] in lumetri:
            pixels = resolve_render(pixels, lumetri[shown[0]["id"]])
        folder = tmp_path / "bridge" / "frames"
        folder.mkdir(parents=True, exist_ok=True)
        image = Image.new("RGB", (16, len(pixels) // 16))
        image.putdata([tuple(round(v * 255) for v in p) for p in pixels[: 16 * (len(pixels) // 16)]])
        image.save(folder / f"{args['name']}.png")
        return {"path": str(folder / args["name"]) + ".png"}

    premiere.read_lumetri, premiere.set_lumetri, premiere.export_frame = (
        read_lumetri,
        set_lumetri,
        export_frame,
    )
    premiere.read_levels, premiere.set_levels = read_levels, set_levels
    premiere.read_cdl, premiere.set_cdl, premiere.remove_effect = read_cdl, set_cdl, remove_effect
    return (
        host,
        premiere,
        {
            "A": a,
            "B": b,
            "lumetri": lumetri,
            "levels": levels,
            "cdl": cdl,
            "frames": frames,
            "folder": tmp_path / "bridge" / "frames",
        },
    )


def test_set_clip_color_sets_lumetri_and_reverts(setup):
    host, premiere, c = setup
    (sound,) = ids_of(premiere, "A.mov", "audio")[:1]
    result = call(
        host,
        "set_clip_color",
        looks=[{"itemId": c["A"], "exposure": 0.5, "saturation": 120}, {"itemId": sound, "tint": 5}],
    )
    (change,) = result["changes"]
    assert (change["kind"], change["name"], change["track"], change["before"]) == (
        "color",
        "A.mov",
        ["video", 1],
        None,
    )
    assert change["after"] == {**colour.NEUTRAL, "exposure": 0.5, "saturation": 120.0}
    assert c["lumetri"][c["A"]] == {**colour.NEUTRAL, "exposure": 0.5, "saturation": 120}
    assert result["refused"] == [{"itemId": sound, "reason": "A.mov is sound, with no picture to colour"}]
    reverted = revert(host, result)
    assert reverted["reverted"] == [{"kind": "color", "name": "A.mov"}]
    # The Lumetri VibeCut added is taken off again.
    assert c["A"] not in c["lumetri"]
    # Changed since, it's left alone.
    again = call(host, "set_clip_color", looks=[{"itemId": c["A"], "contrast": 20}])
    c["lumetri"][c["A"]]["contrast"] = 35
    assert revert(host, again)["changedSince"][0]["name"] == "A.mov"


def test_match_closes_in_on_the_reference_by_the_parade(setup):
    host, _premiere, c = setup
    result = call(host, "match_clip_color", referenceId=c["A"], itemIds=[c["B"]])
    (change,) = result["changes"]
    assert change["name"] == "B.mov" and change["method"] == "parade"
    assert set(result["reference"]) == {"r", "g", "b", "luma", "colour"}
    # OFF was dulled toward each pixel's mean, which saturation (about luma) can't wholly undo: much
    # closer, not exact.
    assert change["distance"] < 0.25 * parade.error(result["reference"], parade.parade(OFF))
    # Levels curves: OFF is darker and warmer, so blue is pulled up more than red; its colour back
    # with Lumetri's Saturation, the rest of its Lumetri untouched.
    after = change["after"]
    assert after["b"]["white"] < after["r"]["white"] < 1 and change["before"] is None
    assert after["saturation"] > 1.2
    assert c["lumetri"][c["B"]] == {
        **colour.NEUTRAL,
        "saturation": pytest.approx(100 * after["saturation"], abs=0.1),
    }
    assert {c_: v for c_, v in parade.levels_look(c["levels"][c["B"]]).items() if c_ != "saturation"} == {
        c_: v for c_, v in after.items() if c_ != "saturation"
    }
    # Each clip on three frames, at a quarter, half and three quarters (A.mov 0-3 s, B.mov 5-8 s).
    assert [round(f, 2) for f in c["frames"][:3]] == [0.72, 1.48, 2.24]
    assert {round(f, 1) for f in c["frames"][3:]} == {5.7, 6.5, 7.2}
    assert list(c["folder"].iterdir()) == []
    assert change["effect"] == "levels" and c["B"] not in c["cdl"]
    # Revert takes off the Levels and Lumetri the match added.
    assert revert(host, result)["reverted"] == [{"kind": "color", "name": "B.mov"}]
    assert c["B"] not in c["levels"] and c["B"] not in c["lumetri"]
    # Changed since, it's left alone.
    again = call(host, "match_clip_color", referenceId=c["A"], itemIds=[c["B"]])
    c["levels"][c["B"]]["g_gamma"] = 140
    assert revert(host, again)["changedSince"][0]["name"] == "B.mov"


def test_match_to_a_learned_look_measures_only_the_clips(setup):
    host, _premiere, c = setup
    reference = call(host, "read_clip_color", itemIds=[c["A"]])["clips"][0]
    look = {k: reference[k] for k in colour.MEASURES}
    start = call(host, "read_clip_color", itemIds=[c["B"]])["clips"][0]
    c["frames"].clear()
    result = call(host, "match_clip_color", referenceLook=look, itemIds=[c["B"]])
    (change,) = result["changes"]
    assert result["reference"] == look and change["distance"] < colour.error(look, start)
    # Kept a nudge: inside the style limits.
    assert all(lo <= change["after"][k] <= hi for k, (lo, hi) in colour.STYLE_LIMITS.items())
    assert {round(f, 1) for f in c["frames"]} == {6.5}


def test_balance_takes_each_clip_to_its_own_neutral(setup):
    host, _premiere, c = setup
    c["lumetri"][c["B"]] = {**colour.NEUTRAL, "contrast": 12.0, "saturation": 110.0}
    # The chart's grey steps are its left columns (as the agent would name them from a look at it).
    greys = [[0.02, 0.05, 0.6, 0.9]]
    result = call(
        host,
        "match_clip_color",
        balance=True,
        items=[{"itemId": c["A"], "areas": greys}, {"itemId": c["B"], "at": 6, "areas": greys}],
    )
    # A.mov (the chart) is neutral and normally exposed already: left alone, nothing added.
    assert [b["name"] for b in result["balanced"]] == ["A.mov"] and c["A"] not in c["cdl"]
    (change,) = result["changes"]
    assert change["name"] == "B.mov" and change["method"] == "parade" and change["close"]
    # In an ASC CDL of its own, not Levels.
    assert change["effect"] == "cdl" and c["B"] not in c["levels"]
    assert parade.cdl_look(c["cdl"][c["B"]]) == change["after"]
    # OFF's greys are warm: red's curve pulled down against blue's.
    after = change["after"]
    assert after["r"]["white"] > after["b"]["white"]
    # Its Lumetri (contrast and saturation) is left as it was.
    assert c["lumetri"][c["B"]] == {**colour.NEUTRAL, "contrast": 12.0, "saturation": 110.0}
    assert revert(host, result)["reverted"] == [{"kind": "color", "name": "B.mov"}]
    assert c["B"] not in c["cdl"]
    assert change["at"] == pytest.approx(6, abs=0.05)
    with pytest.raises(HostError, match="not both"):
        call(
            host,
            "match_clip_color",
            balance=True,
            referenceId=c["A"],
            items=[{"itemId": c["B"], "areas": greys}],
        )
    # Not there at that moment: refused, nothing set.
    away = call(host, "match_clip_color", balance=True, items=[{"itemId": c["B"], "at": 1, "areas": greys}])
    assert away["changes"] == [] and away["refused"][0]["reason"] == "B.mov isn't at 1 s"


def test_read_and_refusals(setup):
    host, premiere, c = setup
    read = call(host, "read_clip_color", itemIds=[c["A"], c["B"]])
    a, b = read["clips"]
    assert (a["name"], b["name"]) == ("A.mov", "B.mov")
    assert b["warmth"] > a["warmth"] and b["brightness"] < a["brightness"]
    assert a["look"] == colour.NEUTRAL and a["at"] == pytest.approx(1.5, abs=0.05)
    premiere.find(c["B"])["disabled"] = True
    off = call(host, "read_clip_color", itemIds=[c["B"]])
    assert (
        off["refused"][0]["reason"] == "B.mov is switched off (or its track's output is), so it can't be seen"
    )


def test_a_match_after_a_balance_keeps_the_balance(setup):
    host, _premiere, c = setup
    greys = [[0.02, 0.05, 0.6, 0.9]]
    # An ASC CDL already on B.mov with a saturation of the user's: balancing uses it and keeps that.
    c["cdl"][c["B"]] = {**parade.cdl_controls(parade.neutral_look()), "saturation": 1.1}
    balanced = call(host, "match_clip_color", balance=True, items=[{"itemId": c["B"], "areas": greys}])
    (balance,) = balanced["changes"]
    assert c["cdl"][c["B"]]["saturation"] == 1.1 and balance["before"] is not None
    kept = dict(c["cdl"][c["B"]])
    matched = call(host, "match_clip_color", referenceId=c["A"], itemIds=[c["B"]])
    assert matched["changes"][0]["effect"] == "levels" and c["cdl"][c["B"]] == kept
    # Reverting the match takes off its Levels; the balance stays. Reverting the balance puts the
    # user's ASC CDL back as it was (not taken off: it was there before).
    assert revert(host, matched)["reverted"] == [{"kind": "color", "name": "B.mov"}]
    assert c["B"] not in c["levels"] and c["cdl"][c["B"]] == kept
    assert revert(host, balanced)["reverted"] == [{"kind": "color", "name": "B.mov"}]
    assert c["cdl"][c["B"]] == {**parade.cdl_controls(parade.neutral_look()), "saturation": 1.1}
