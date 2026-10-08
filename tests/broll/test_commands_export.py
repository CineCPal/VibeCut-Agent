"""broll-export (Phase 10): a Premiere selects reel from the Folder tab's chosen segments, read from the
folder's analysis cache with no decoding; and minGapSec reaching the segment picker."""

import io
import json
import os
import sys
import xml.etree.ElementTree as ET
from concurrent.futures import ThreadPoolExecutor

import pytest

from tests.broll.test_pipeline import SCORES, fake_result
from vibecut_agent.broll import commands, pipeline
from vibecut_agent.protocol import Emitter


class Capture:
    def __init__(self):
        self.buffer = io.StringIO()
        self.emitter = Emitter(self.buffer)

    def events(self):
        return [json.loads(line) for line in self.buffer.getvalue().splitlines()]

    def of_type(self, event_type):
        return [e for e in self.events() if e["type"] == event_type]


@pytest.fixture
def folder(tmp_path):
    root = tmp_path / "footage"
    root.mkdir()
    for name in SCORES:
        (root / name).write_bytes(b"clip " + name.encode())
    return str(root)


@pytest.fixture(autouse=True)
def fake_engine(monkeypatch):
    calls = []

    def fake(path, **kw):
        calls.append(kw)
        return fake_result(path, SCORES[os.path.basename(path)])

    monkeypatch.setattr(pipeline, "analyze_clip", fake)
    real = pipeline.run_analysis
    monkeypatch.setattr(
        pipeline, "run_analysis", lambda *a, **k: real(*a, executor_factory=ThreadPoolExecutor, **k)
    )
    return calls


def run(monkeypatch, command, request):
    capture = Capture()
    monkeypatch.setattr(sys, "stdin", io.StringIO(json.dumps(request)))
    code = commands.main(command, capture.emitter, sys.stdin)
    return code, capture


def export_request(folder, out, **extra):
    request = {
        "folder": folder,
        "outputPath": out,
        "clips": [
            {
                "path": os.path.join(folder, "b.mov"),
                "score": 90,
                "segments": [{"start": 1, "end": 3}, {"start": 6, "end": 9.5}],
            },
            {"path": os.path.join(folder, "a.mov"), "score": 30, "segments": [{"start": 0, "end": 2}]},
        ],
    }
    request.update(extra)
    return request


def test_min_gap_reaches_the_analyzer(monkeypatch, folder, fake_engine):
    code, capture = run(monkeypatch, "analyze", {"folder": folder, "maxSegments": 3, "minGapSec": 2.5})
    assert code == 0 and capture.of_type("error") == []
    assert {kw["min_segment_gap_sec"] for kw in fake_engine} == {2.5}
    assert {kw["max_segments"] for kw in fake_engine} == {3}


def test_a_bad_min_gap_is_refused(monkeypatch, folder):
    code, capture = run(monkeypatch, "analyze", {"folder": folder, "minGapSec": 31})
    assert code == 2
    assert "minGapSec" in capture.of_type("error")[0]["message"]


def test_exports_one_clipitem_per_chosen_segment_in_the_given_order(monkeypatch, folder, tmp_path):
    run(monkeypatch, "analyze", {"folder": folder})
    out = str(tmp_path / "selects.xml")

    def must_not_decode(path, **kw):
        pytest.fail("export must not decode any video")

    monkeypatch.setattr(pipeline, "analyze_clip", must_not_decode)
    code, capture = run(monkeypatch, "export", export_request(folder, out, sequenceName="  Gym   selects "))

    assert code == 0 and capture.of_type("error") == []
    (result,) = capture.of_type("result")
    assert result == {"type": "result", "exportPath": out, "clips": 2, "segments": 3, "seconds": 7.5}
    root = ET.parse(out).getroot()
    assert root.find("project/children/sequence/name").text == "Gym selects"
    items = root.findall("project/children/sequence/media/video/track/clipitem")
    assert [i.find("name").text for i in items] == ["b (seg 1)", "b (seg 2)", "a"]
    # 30 fps: b's first segment is source frames 30–90, laid from 0; the next starts where it ends.
    assert [(int(i.find("in").text), int(i.find("out").text)) for i in items] == [
        (30, 90),
        (180, 285),
        (0, 60),
    ]
    assert [int(i.find("start").text) for i in items] == [0, 60, 165]
    bin_clips = root.findall("project/children/bin/children/clip")
    assert "Quality score: 90.0/100" in ET.tostring(bin_clips[0], encoding="unicode")


def test_a_clip_never_analyzed_is_refused(monkeypatch, folder, tmp_path):
    out = str(tmp_path / "selects.xml")
    code, capture = run(monkeypatch, "export", export_request(folder, out))
    assert code == 2
    assert "hasn't been analyzed" in capture.of_type("error")[0]["message"]
    assert not os.path.exists(out)


@pytest.mark.parametrize(
    "mutate, message",
    [
        (lambda r: r.update(outputPath="relative.xml"), "absolute"),
        (lambda r: r.update(outputPath=r["outputPath"][:-4] + ".txt"), ".xml"),
        (lambda r: r.update(clips=[]), "at least one clip"),
        (lambda r: r["clips"][0].update(path="/elsewhere/b.mov"), "inside the folder"),
        (lambda r: r["clips"][0].update(segments=[]), "segments must list"),
        (lambda r: r["clips"][0].update(segments=[{"start": 8, "end": 12}]), "isn't inside the clip"),
        (lambda r: r["clips"][0].update(segments=[{"start": 2, "end": 2}]), "isn't inside the clip"),
        (lambda r: r["clips"][0].update(segments=[{"start": "1", "end": 3}]), "start and an end"),
        (lambda r: r.update(sequenceName=""), "sequenceName"),
    ],
)
def test_bad_exports_are_refused(monkeypatch, folder, tmp_path, mutate, message):
    run(monkeypatch, "analyze", {"folder": folder})
    out = str(tmp_path / "selects.xml")
    request = export_request(folder, out)
    mutate(request)
    code, capture = run(monkeypatch, "export", request)
    assert code == 2
    assert message in capture.of_type("error")[0]["message"]
    assert not os.path.exists(out)
