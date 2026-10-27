"""Colour on the connected sequence (premiere_colour.py, Phase 19c) against test_premiere_edit.py's fake
Premiere, given the panel's read_lumetri, set_lumetri and export_frame: Lumetri values per clip, and a
frame rendered through them (as a CDL, test_colour.resolve_render) into the bridge folder's frames/."""

import shutil

import pytest
from PIL import Image

from tests.nle.test_colour import chart, resolve_render
from tests.nle.vibecut_premiere.test_premiere_edit import T, call, ids_of, revert
from tests.nle.vibecut_premiere.test_premiere_edit import setup as edit_setup  # noqa: F401
from vibecut_agent.nle import colour

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
    return (
        host,
        premiere,
        {"A": a, "B": b, "lumetri": lumetri, "frames": frames, "folder": tmp_path / "bridge" / "frames"},
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
    assert c["lumetri"][c["A"]] == colour.NEUTRAL
    # Changed since, it's left alone.
    again = call(host, "set_clip_color", looks=[{"itemId": c["A"], "contrast": 20}])
    c["lumetri"][c["A"]]["contrast"] = 35
    assert revert(host, again)["changedSince"][0]["name"] == "A.mov"


def test_match_closes_in_on_the_reference(setup):
    host, _premiere, c = setup
    result = call(host, "match_clip_color", referenceId=c["A"], itemIds=[c["B"]])
    (change,) = result["changes"]
    assert change["name"] == "B.mov" and change["distance"] < colour.GOOD_ENOUGH
    assert change["after"]["exposure"] > 0 and change["after"]["temperature"] < 0
    assert c["lumetri"][c["B"]] == pytest.approx(change["after"], abs=0.01)
    # The reference at A.mov's middle (1.5 s), B.mov's at its own (6.5 s); every frame file removed.
    assert c["frames"][0] == pytest.approx(1.5, abs=0.05) and {round(f, 1) for f in c["frames"][1:]} == {6.5}
    assert list(c["folder"].iterdir()) == []
    assert revert(host, result)["reverted"] == [{"kind": "color", "name": "B.mov"}]


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
