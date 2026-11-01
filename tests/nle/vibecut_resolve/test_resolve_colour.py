"""Colour on the connected timeline (resolve_colour.py, Phase 19c) against test_resolve_edit.py's fakes,
with a viewer that renders the clip under the playhead through its CDL (test_colour.resolve_render) and
exports it as Resolve's ExportCurrentFrameAsStill does."""

import json
import shutil

import pytest
from PIL import Image

from tests.nle.test_colour import chart
from tests.nle.vibecut_resolve.test_resolve_edit import START, EditTimeline, call, make_edit
from vibecut_agent.nle import colour, parade, resolve_colour
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


class Graph:
    """A clip's nodes as Resolve's API shows them: labels, the tools a node uses (none on an untouched
    node), a .drx (here a JSON list of labels) replacing them all, and a reset to one empty node."""

    def __init__(self, item):
        self.item = item

    def GetNumNodes(self):
        return len(self.item.nodes)

    def GetNodeLabel(self, index):
        return self.item.nodes[index - 1]["label"]

    def GetToolsInNode(self, index):
        return ["Primary Balance"] if self.item.nodes[index - 1]["cdl"] else None

    def ApplyGradeFromDRX(self, path, mode):
        with open(path) as f:
            self.item.nodes = [{"label": label, "cdl": None} for label in json.load(f)]
        return mode == 0

    def ResetAllGrades(self):
        self.item.nodes = [{"label": "", "cdl": None}]
        return True


def nodes(item, *labels):
    """`item`'s grade as empty nodes with these labels."""
    item.nodes = [{"label": label, "cdl": None} for label in labels]


def set_cdl(item, value):
    index = int(value["NodeIndex"])
    if not 1 <= index <= len(item.nodes):
        return False
    item.nodes[index - 1]["cdl"] = value
    item.cdl, item.look_set = value, value.get("_look")
    return True


@pytest.fixture
def edit(tmp_path, monkeypatch):
    # No node template saved unless a test saves one.
    monkeypatch.setenv(resolve_colour.TEMPLATE_ENV, str(tmp_path / "template.drx"))
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
        nodes(item, "")
        item.GetNodeGraph = lambda item=item: Graph(item)
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
        for node in getattr(shown[0], "nodes", []) if shown else []:
            if node["cdl"]:
                pixels = cdl_render(pixels, node["cdl"])
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
        item.SetCDL = lambda value, item=item: set_cdl(item, value)
    return (
        host,
        timeline,
        project,
        {**c, "b": b, "exports": exports, "cdl": cdl, "template": tmp_path / "template.drx"},
    )


@pytest.fixture(autouse=True)
def keep_looks(monkeypatch, edit):
    from vibecut_agent.nle import resolve_colour

    monkeypatch.setattr(resolve_colour.colour, "cdl", edit[3]["cdl"])


def test_set_clip_color_sets_node_1_and_reverts_from_the_backup(edit):
    host, timeline, project, c = edit
    # A.mov has a grade of its own in its one node: VibeCut's goes there, as before nodes were chosen.
    c["v"].nodes[0]["cdl"] = {"Slope": "1 1 1"}
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
    assert change["node"] == {"index": 1, "label": None, "template": False, "ungraded": False}
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


def test_each_goes_in_its_labelled_node_and_reverts_to_neutral_there(edit):
    host, _timeline, _project, c = edit
    nodes(c["b"], "Input", "VC Balance", "vc match", "Look")
    greys = [[0.02, 0.05, 0.6, 0.9]]
    balanced = call(host, "match_clip_color", balance=True, items=[{"itemId": c["b"].uid, "areas": greys}])
    matched = call(host, "match_clip_color", referenceId=c["v"].uid, itemIds=[c["b"].uid])
    assert balanced["changes"][0]["node"] == {
        "index": 2,
        "label": "VC Balance",
        "template": False,
        "ungraded": False,
    }
    assert matched["changes"][0]["node"]["index"] == 3
    assert [n["cdl"] is not None for n in c["b"].nodes] == [False, True, True, False]
    assert c["b"].nodes[1]["cdl"]["NodeIndex"] == "2" and c["b"].nodes[2]["cdl"]["NodeIndex"] == "3"
    # set_clip_color goes in VC Match too.
    looked = call(host, "set_clip_color", looks=[{"itemId": c["b"].uid, "exposure": 0.2}])
    assert looked["changes"][0]["node"]["index"] == 3
    # Reverting the match sets VC Match back to neutral; the balance stays.
    reverted = call(host, "revert_timeline_changes", changes=matched["changes"], backup="Nowhere")
    assert reverted["reverted"] == [{"kind": "color", "name": "B.mov"}]
    assert (
        c["b"].nodes[2]["cdl"]["Slope"] == "1.00000 1.00000 1.00000"
        and c["b"].nodes[1]["cdl"]["Slope"] != "1.00000 1.00000 1.00000"
    )
    # Its node relabelled since: changed, not guessed at.
    c["b"].nodes[1]["label"] = "Mine"
    again = call(host, "revert_timeline_changes", changes=balanced["changes"], backup="Nowhere")
    assert again["changedSince"] == [
        {"name": "B.mov", "reason": "it has no node labelled 'VC Balance' any more"}
    ]


def test_a_grade_of_several_nodes_with_none_labelled_is_refused(edit):
    host, _timeline, _project, c = edit
    nodes(c["b"], "", "")
    c["b"].nodes[0]["cdl"] = {"Slope": "1 1 1"}
    result = call(host, "match_clip_color", referenceId=c["v"].uid, itemIds=[c["b"].uid])
    assert result["changes"] == []
    assert "has no node labelled 'VC Match'" in result["refused"][0]["reason"]
    assert c["b"].nodes[1]["cdl"] is None
    # One node labelled for something else isn't VibeCut's either.
    nodes(c["b"], "VC Match")
    greys = [[0.02, 0.05, 0.6, 0.9]]
    refused = call(host, "match_clip_color", balance=True, items=[{"itemId": c["b"].uid, "areas": greys}])
    assert "has no node labelled 'VC Balance'" in refused["refused"][0]["reason"]


def test_an_ungraded_clip_gets_the_template_and_without_one_is_reset_on_revert(edit):
    host, _timeline, _project, c = edit
    # No template: B.mov's one empty node is used, and Revert resets it with no backup needed.
    first = call(host, "set_clip_color", looks=[{"itemId": c["b"].uid, "exposure": 0.3}])
    assert first["changes"][0]["node"] == {"index": 1, "label": None, "template": False, "ungraded": True}
    reverted = call(host, "revert_timeline_changes", changes=first["changes"], backup="Nowhere")
    assert reverted["reverted"] == [{"kind": "color", "name": "B.mov"}] and c["b"].nodes == [
        {"label": "", "cdl": None}
    ]
    # With a template saved, the ungraded clip gets it, and the match goes in its VC Match node.
    c["template"].write_text(json.dumps(["VC Balance", "VC Match", ""]))
    matched = call(host, "match_clip_color", referenceId=c["v"].uid, itemIds=[c["b"].uid])
    assert matched["changes"][0]["node"] == {
        "index": 2,
        "label": "VC Match",
        "template": True,
        "ungraded": True,
    }
    assert [n["label"] for n in c["b"].nodes] == ["VC Balance", "VC Match", ""] and c["b"].nodes[1]["cdl"]
    # A clip with a grade of its own isn't given the template (it would replace the grade).
    c["v"].nodes[0]["cdl"] = {"Slope": "1 1 1"}
    own = call(host, "set_clip_color", looks=[{"itemId": c["v"].uid, "tint": 5}])
    assert own["changes"][0]["node"]["index"] == 1 and len(c["v"].nodes) == 1
    # A template without the node needed is taken off again and refused.
    c["template"].write_text(json.dumps(["VC Match"]))
    nodes(c["b"], "")
    greys = [[0.02, 0.05, 0.6, 0.9]]
    bad = call(host, "match_clip_color", balance=True, items=[{"itemId": c["b"].uid, "areas": greys}])
    assert (
        bad["refused"][0]["reason"]
        == "VibeCut's node template has no node labelled 'VC Balance': save it again"
    )
    assert c["b"].nodes == [{"label": "", "cdl": None}]


@pytest.fixture
def gallery(edit):
    """Resolve's page, the Color page's current clip, and a gallery whose stills export as JSON .drx files."""
    host, timeline, project, c = edit
    state = {"page": "edit", "pages": [], "stills": []}
    resolve = host._resolve
    resolve.GetCurrentPage = lambda: state["page"]
    resolve.OpenPage = lambda page: state["pages"].append(page) or state.update(page=page) or True

    def current_item():
        frame = timecode_to_frames(timeline.timecode, 25)
        shown = [i for i in timeline.tracks["video"][0] if i.start <= frame < i.end]
        return shown[0] if shown else None

    timeline.GetCurrentVideoItem = current_item

    def grab():
        if state["page"] != "color":
            return None
        state["stills"].append([n["label"] for n in current_item().nodes])
        return len(state["stills"])

    timeline.GrabStill = grab

    class Album:
        def ExportStills(self, stills, folder, prefix, kind):
            with open(f"{folder}/{prefix}_1.1.1.{kind}", "w") as f:
                json.dump(state["stills"][stills[0] - 1], f)
            return True

        def DeleteStills(self, stills):
            state["stills"] = [s for i, s in enumerate(state["stills"]) if i + 1 not in stills]
            return True

    project.GetGallery = lambda: type("Gallery", (), {"GetCurrentStillAlbum": lambda self: Album()})()
    return state


def test_save_node_template_grabs_the_clips_nodes_and_puts_the_page_back(edit, gallery):
    host, timeline, _project, c = edit
    before = timeline.timecode
    nodes(c["b"], "CST", "VC Balance", "VC Match", "")
    c["b"].nodes[0]["cdl"] = {"Slope": "1 1 1"}
    saved = call(host, "save_node_template", itemId=c["b"].uid)
    assert saved["labels"] == {"VC Balance": 2, "VC Match": 3} and saved["nodes"] == 4
    assert saved["otherNodes"] == [
        {"node": 1, "label": "CST", "tools": ["Primary Balance"]},
        {"node": 4, "label": "", "tools": []},
    ]
    assert json.loads(c["template"].read_text()) == ["CST", "VC Balance", "VC Match", ""]
    assert gallery["pages"] == ["color", "edit"] and gallery["stills"] == [] and timeline.timecode == before
    # A VC node with something in it, or a missing one, is refused before the page is touched.
    c["b"].nodes[2]["cdl"] = {"Slope": "1 1 1"}
    with pytest.raises(HostError, match="'VC Match' node isn't empty"):
        call(host, "save_node_template", itemId=c["b"].uid)
    nodes(c["b"], "VC Balance")
    with pytest.raises(HostError, match="has no node labelled 'VC Match'"):
        call(host, "save_node_template", itemId=c["b"].uid)
    assert gallery["pages"] == ["color", "edit"]
