"""Colour on the connected timeline (resolve_colour.py, Phase 19c) against test_resolve_edit.py's fakes,
with a viewer that renders the clip under the playhead through its CDL (test_colour.resolve_render) and
exports it as Resolve's ExportCurrentFrameAsStill does."""

import shutil

import pytest
from PIL import Image

from tests.nle.test_colour import chart
from tests.nle.vibecut_resolve.test_resolve_edit import START, EditTimeline, call, make_edit
from vibecut_agent.nle import colour, parade
from vibecut_agent.nle.resolve import HostError, frames_to_timecode, timecode_to_frames

pytestmark = pytest.mark.skipif(shutil.which("ffmpeg") is None, reason="needs ffmpeg")

# The same chart shot darker, warmer and duller.
OFF = [
    tuple(0.6 * v + 0.4 * sum(p) / 3 for v in (min(p[0] * 0.85, 1), p[1] * 0.8, p[2] * 0.68)) for p in chart()
]


def cdl_render(pixels, cdl):
    """What Resolve shows with a CDL on node 1 (as test_colour.resolve_render, from the CDL itself)."""
    slope, offset, power = ([float(v) for v in cdl[k].split()] for k in ("Slope", "Offset", "Power"))
    sat = float(cdl["Saturation"])
    out = []
    for p in pixels:
        rgb = [min(max(p[i] * slope[i] + offset[i], 0.0), 1.0) ** power[i] for i in range(3)]
        luma = 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2]
        out.append(tuple(min(max(luma + sat * (v - luma), 0.0), 1.0) for v in rgb))
    return out


@pytest.fixture
def edit():
    host, timeline, project, c = make_edit()
    project.current = timeline  # the connected timeline is the one open in Resolve
    b = timeline.place("video", 1, c["broll"], 300, 500)
    looks = {c["v"]: chart(), b: OFF}
    timeline.GetStartTimecode = lambda: frames_to_timecode(START, 25)
    timeline.timecode = frames_to_timecode(START + 7, 25)
    timeline.GetCurrentTimecode = lambda: timeline.timecode
    timeline.SetCurrentTimecode = lambda tc: setattr(timeline, "timecode", tc) or True
    for item in looks:
        item.cdl = None
    exports = []

    def export(path):
        frame = timecode_to_frames(timeline.timecode, 25)
        shown = [
            i
            for index in range(len(timeline.tracks["video"]), 0, -1)
            for i in timeline.tracks["video"][index - 1]
            if i.start <= frame < i.end and i.enabled
        ]
        pixels = looks.get(shown[0], chart()) if shown else [(0.0, 0.0, 0.0)]
        if shown and getattr(shown[0], "cdl", None):
            pixels = cdl_render(pixels, shown[0].cdl)
        image = Image.new("RGB", (16, len(pixels) // 16))
        image.putdata([tuple(round(v * 255) for v in p) for p in pixels[: 16 * (len(pixels) // 16)]])
        image.save(path)
        exports.append(frame - START)
        return True

    project.ExportCurrentFrameAsStill = export
    # The fake keeps the look a CDL came from, so the viewer can render it.
    original = colour.cdl

    def cdl(look):
        out = original(look)
        out["_look"] = look
        return out

    for item in looks:
        item.SetCDL = lambda value, item=item: (
            setattr(item, "cdl", value) or setattr(item, "look_set", value.get("_look")) or True
        )
    return host, timeline, project, {**c, "b": b, "exports": exports, "cdl": cdl}


@pytest.fixture(autouse=True)
def keep_looks(monkeypatch, edit):
    from vibecut_agent.nle import resolve_colour

    monkeypatch.setattr(resolve_colour.colour, "cdl", edit[3]["cdl"])


def test_set_clip_color_sets_node_1_and_reverts_from_the_backup(edit):
    host, timeline, project, c = edit
    result = call(
        host,
        "set_clip_color",
        looks=[
            {"itemId": c["v"].uid, "exposure": 0.5, "temperature": -10},
            {"itemId": c["a"].uid, "tint": 5},
        ],
    )
    (change,) = result["changes"]
    assert (change["kind"], change["name"], change["track"], change["before"]) == (
        "color",
        "A.mov",
        ["video", 1],
        None,
    )
    assert change["after"] == {**colour.NEUTRAL, "exposure": 0.5, "temperature": -10.0}
    assert c["v"].cdl["NodeIndex"] == "1" and float(c["v"].cdl["Slope"].split()[1]) == pytest.approx(
        2 ** (0.5 / 2.4), abs=1e-4
    )
    assert result["refused"] == [{"itemId": c["a"].uid, "reason": "A.mov has no picture to colour"}]
    # The backup's copy of A.mov has its grade as it was.
    backup = EditTimeline("Interview (before VibeCut 1)")
    backup.project = project
    project.timelines.append(backup)
    copy = backup.place("video", 1, c["interview"], 0, 250)
    copy.grade = "as shot"
    c["v"].grade = "VibeCut"
    reverted = call(host, "revert_timeline_changes", changes=[change], backup="Interview (before VibeCut 1)")
    assert reverted["reverted"] == [{"kind": "color", "name": "A.mov"}]
    assert c["v"].grade == "as shot"
    # Without the backup's copy it can't.
    gone = call(host, "revert_timeline_changes", changes=[change], backup="Nowhere")
    assert gone["failed"][0]["name"] == "A.mov"


def test_match_closes_in_on_the_reference_by_the_parade_and_puts_the_playhead_back(edit):
    host, timeline, _project, c = edit
    before = timeline.timecode
    result = call(host, "match_clip_color", referenceId=c["v"].uid, itemIds=[c["b"].uid])
    (change,) = result["changes"]
    assert change["kind"] == "color" and change["name"] == "B.mov" and change["method"] == "parade"
    # OFF was dulled toward each pixel's mean (saturation about luma can't wholly undo it): much closer.
    assert change["distance"] < 0.25 * parade.error(result["reference"], parade.parade(OFF))
    after = change["after"]
    assert after["b"]["white"] < after["r"]["white"] < 1 and after["saturation"] > 1.2
    assert c["b"].cdl == parade.cdl(after)
    assert timeline.timecode == before
    # Three frames of each: A.mov (0-250) at 62, 125, 187; B.mov (300-500) at 350, 400, 450.
    assert c["exports"][:3] == [62, 125, 187] and set(c["exports"][3:]) == {350, 400, 450}


def test_match_to_a_learned_look_measures_only_the_clips(edit):
    host, _timeline, _project, c = edit
    reference = call(host, "read_clip_color", itemIds=[c["v"].uid])["clips"][0]
    look = {k: reference[k] for k in colour.MEASURES}
    start = call(host, "read_clip_color", itemIds=[c["b"].uid])["clips"][0]
    c["exports"].clear()
    result = call(host, "match_clip_color", referenceLook=look, itemIds=[c["b"].uid])
    (change,) = result["changes"]
    assert result["reference"] == look and change["distance"] < colour.error(look, start)
    # Kept a nudge: inside the style limits.
    assert all(lo <= change["after"][k] <= hi for k, (lo, hi) in colour.STYLE_LIMITS.items())
    assert set(c["exports"]) == {400}


def test_balance_takes_each_clip_to_its_own_neutral(edit):
    host, timeline, _project, c = edit
    before = timeline.timecode
    # The chart's grey steps are its left columns (as the agent would name them from a look at it).
    greys = [[0.02, 0.05, 0.6, 0.9]]
    result = call(
        host,
        "match_clip_color",
        balance=True,
        items=[{"itemId": c["v"].uid, "areas": greys}, {"itemId": c["b"].uid, "at": 15, "areas": greys}],
    )
    # A.mov (the chart) is neutral and normally exposed already: its grade isn't touched.
    assert [b["name"] for b in result["balanced"]] == ["A.mov"] and c["v"].cdl is None
    (change,) = result["changes"]
    assert change["name"] == "B.mov" and change["method"] == "parade" and change["close"]
    # OFF's greys are warm: red's curve pulled down against blue's; saturation as shot.
    after = change["after"]
    assert after["r"]["white"] > after["b"]["white"] and after["saturation"] == 1
    assert c["b"].cdl == parade.cdl(after) and timeline.timecode == before
    # B.mov (300-500) looked at 15 s in (frame 375); not there at 2 s: refused.
    assert c["exports"][-1] == 375
    away = call(
        host, "match_clip_color", balance=True, items=[{"itemId": c["b"].uid, "at": 2, "areas": greys}]
    )
    assert away["changes"] == [] and away["refused"][0]["reason"] == "B.mov isn't at 2 s"


def test_read_measures_and_looks_past_covers(edit):
    host, timeline, _project, c = edit
    timeline.AddTrack("video")
    # A title over B.mov's middle: B.mov is looked at where it's clear.
    timeline.place("video", 2, c["broll"], 350, 450)
    read = call(host, "read_clip_color", itemIds=[c["v"].uid, c["b"].uid, c["a"].uid])
    assert [r["name"] for r in read["clips"]] == ["A.mov", "B.mov"]
    assert read["clips"][1]["warmth"] > read["clips"][0]["warmth"]
    assert read["clips"][1]["brightness"] < read["clips"][0]["brightness"]
    assert c["exports"][1] in (325, 475)
    assert read["refused"] == [{"itemId": c["a"].uid, "reason": "A.mov has no picture to colour"}]
    # Covered all through, it's refused.
    timeline.place("video", 2, c["broll"], 0, 250)
    covered = call(host, "read_clip_color", itemIds=[c["v"].uid])
    assert covered["refused"][0]["reason"] == "A.mov is covered all through by clips on tracks above it"


def test_the_connected_timeline_must_be_open(edit):
    host, _timeline, project, c = edit
    project.current = project.timelines[1]
    with pytest.raises(HostError, match="must be the timeline open in Resolve"):
        call(host, "read_clip_color", itemIds=[c["v"].uid])
