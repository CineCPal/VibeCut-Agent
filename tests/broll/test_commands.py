"""The broll-analyze command end to end, ported from VibeCut's broll-analyzer tests/test_headless.py."""

import io
import json
import os
import shutil
import subprocess
import sys
import threading
from concurrent.futures import ThreadPoolExecutor

import numpy as np
import pytest

from tests.broll.test_pipeline import DIRECTIONS, SCORES, content_result, fake_result
from vibecut_agent.broll import commands, pipeline
from vibecut_agent.headless import dispatch
from vibecut_agent.protocol import Emitter

SRC = os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))), "src-python")


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
    for name in SCORES:
        (tmp_path / name).write_bytes(b"clip " + name.encode())
    return str(tmp_path)


@pytest.fixture(autouse=True)
def fake_engine(monkeypatch):
    monkeypatch.setattr(
        pipeline,
        "analyze_clip",
        lambda path, **kw: fake_result(path, SCORES[os.path.basename(path)]),
    )
    real = pipeline.run_analysis
    monkeypatch.setattr(
        pipeline,
        "run_analysis",
        lambda *a, **k: real(*a, executor_factory=ThreadPoolExecutor, **k),
    )


def run(monkeypatch, request, capture=None, cancel=None):
    capture = capture or Capture()
    monkeypatch.setattr(sys, "stdin", io.StringIO(json.dumps(request)))
    code = commands.main("analyze", capture.emitter, sys.stdin, cancel=cancel)
    return code, capture


def test_reports_progress_and_a_ranked_result(monkeypatch, folder):
    code, capture = run(monkeypatch, {"folder": folder})

    assert code == 0
    kinds = [e["type"] for e in capture.events()]
    assert kinds[0] == "starting" and kinds[-1] == "done"
    assert capture.of_type("error") == []
    progress = capture.of_type("progress")
    assert progress[-1]["fraction"] == pytest.approx(1.0)
    assert progress[-1]["phase"] == "analyzing"
    (result,) = capture.of_type("result")
    assert result["analyzed"] == 3 and result["cached"] == 0 and result["failed"] == []
    assert [c["filename"] for c in result["ranked"]] == ["b.mov", "c.mov", "a.mov"]
    assert result["ranked"][0]["score"] == 90.0
    assert result["ranked"][0]["segments"] == [{"start": 1.0, "end": 5.0, "score": 90.0}]
    assert result["exportPath"] is None
    assert capture.of_type("done")[0]["cancelled"] is False


def test_second_run_reports_cache_hits(monkeypatch, folder):
    run(monkeypatch, {"folder": folder})
    _, capture = run(monkeypatch, {"folder": folder})
    assert capture.of_type("result")[0]["cached"] == 3


# ------------------------------------------------------------------------------------- catalog mode
#
# "catalog": true — the Story Editor's B-roll catalog fallback for clips Spyglass hasn't indexed
# (see rough-cut-studio's gemini_client.generate_story_script). Reads whatever this folder's
# .broll_analyzer_cache.json already has; never decodes video.


def test_catalog_mode_reads_the_existing_cache_without_reanalyzing(monkeypatch, folder):
    run(monkeypatch, {"folder": folder})  # populates the cache for a.mov/b.mov/c.mov

    def must_not_be_called(path, **kw):
        pytest.fail("catalog mode must not decode any video")

    monkeypatch.setattr(pipeline, "analyze_clip", must_not_be_called)
    code, capture = run(monkeypatch, {"folder": folder, "catalog": True})

    assert code == 0 and capture.of_type("error") == []
    assert capture.of_type("progress") == []  # nothing to report progress on
    (result,) = capture.of_type("result")
    assert result["ranked"] == []
    catalog = result["catalog"]
    assert {c["filename"] for c in catalog} == {"a.mov", "b.mov", "c.mov"}
    assert all(c["durationSeconds"] == 10.0 for c in catalog)
    assert all(isinstance(c["technicalScore"], float) for c in catalog)


def test_catalog_mode_omits_clips_never_analyzed(monkeypatch, folder, tmp_path):
    run(monkeypatch, {"folder": folder})  # a.mov/b.mov/c.mov get cached
    (tmp_path / "d.mov").write_bytes(b"clip d")  # never analyzed -> no cache entry

    code, capture = run(monkeypatch, {"folder": folder, "catalog": True})
    assert code == 0
    filenames = {c["filename"] for c in capture.of_type("result")[0]["catalog"]}
    assert "d.mov" not in filenames
    assert filenames == {"a.mov", "b.mov", "c.mov"}


def test_catalog_mode_with_no_prior_analysis_is_an_empty_catalog(monkeypatch, folder):
    code, capture = run(monkeypatch, {"folder": folder, "catalog": True})
    assert code == 0
    assert capture.of_type("result")[0]["catalog"] == []


def test_exports_the_selected_clips(monkeypatch, folder, tmp_path):
    exported = {}

    def fake_export(selected, path, show_energy=True):
        exported["names"] = [r.filename for r in selected]
        exported["path"] = path
        open(path, "w").write("<xmeml/>")

    monkeypatch.setattr(commands, "export_xml", fake_export)
    out = str(tmp_path / "out" / "selects.xml")

    code, capture = run(
        monkeypatch,
        {
            "folder": folder,
            "topMode": "topn",
            "topN": 2,
            "sequenceOrder": "name",
            "exportXmlPath": out,
        },
    )

    assert code == 0
    assert exported == {"names": ["b.mov", "c.mov"], "path": out}
    assert capture.of_type("result")[0]["exportPath"] == out
    assert os.path.exists(out)


def test_an_empty_selection_writes_nothing_and_says_so(monkeypatch, folder, tmp_path):
    monkeypatch.setattr(
        commands,
        "export_xml",
        lambda *a, **k: pytest.fail("nothing should be exported"),
    )
    out = str(tmp_path / "selects.xml")
    _, capture = run(
        monkeypatch,
        {
            "folder": folder,
            "topMode": "threshold",
            "minScore": 99,
            "exportXmlPath": out,
        },
    )
    result = capture.of_type("result")[0]
    assert result["exportPath"] is None
    assert any("No clips met the selection" in w for w in result["warnings"])


def test_energy_without_torch_falls_back_with_a_warning(monkeypatch, folder):
    from vibecut_agent.broll import vision_energy

    monkeypatch.setattr(vision_energy, "is_available", lambda: False)
    seen = {}
    real = pipeline.run_analysis

    def spy(*args, **kwargs):
        seen["enable_energy"] = kwargs["enable_energy"]
        return real(*args, **kwargs)

    monkeypatch.setattr(pipeline, "run_analysis", spy)
    _, capture = run(monkeypatch, {"folder": folder, "enableEnergy": True})
    assert seen["enable_energy"] is False
    assert any("PyTorch" in w for w in capture.of_type("result")[0]["warnings"])


def test_a_cancel_is_reported(monkeypatch, folder):
    cancel = threading.Event()
    cancel.set()

    class Flag:
        is_set = cancel.is_set

    code, capture = run(monkeypatch, {"folder": folder}, cancel=Flag())
    assert code == 0
    assert capture.of_type("result")[0]["cancelled"] is True
    assert capture.of_type("done")[0]["cancelled"] is True


@pytest.mark.parametrize(
    "mutation, message",
    [
        ({"folder": "relative"}, "absolute"),
        ({"folder": "/definitely/not/here"}, "Not a folder"),
        ({"windowSec": "long"}, "must be a number"),
        ({"windowSec": 0}, "between"),
        ({"energyWeight": 2}, "between"),
        ({"relevanceWeight": -0.1}, "between"),
        ({"brief": 42}, "brief must be text"),
        ({"topMode": "best"}, "Unknown topMode"),
        ({"sequenceOrder": "random"}, "Unknown sequenceOrder"),
        ({"exportXmlPath": "relative.xml"}, "absolute"),
        ({"exportXmlPath": "/tmp/out.txt"}, ".xml"),
    ],
)
def test_bad_requests_are_refused_before_any_analysis(monkeypatch, folder, mutation, message):
    monkeypatch.setattr(pipeline, "run_analysis", lambda *a, **k: pytest.fail("must not analyze"))
    code, capture = run(monkeypatch, {"folder": folder, **mutation})
    assert code == 2
    assert message in capture.of_type("error")[0]["message"]


def test_files_limits_the_analysis_to_those_clips(monkeypatch, folder):
    only = os.path.join(folder, "c.mov")
    code, capture = run(monkeypatch, {"folder": folder, "files": [only]})
    assert code == 0
    (result,) = capture.of_type("result")
    assert [c["path"] for c in result["ranked"]] == [only]
    # The rest of the folder is still analyzed, and cached, on a later whole-folder run.
    _, capture = run(monkeypatch, {"folder": folder})
    assert capture.of_type("result")[0]["cached"] == 1


@pytest.mark.parametrize(
    "files, message",
    [
        ([], "files must be a list"),
        ("a.mov", "files must be a list"),
        (["relative.mov"], "absolute"),
        (["OUTSIDE"], "Not a clip inside the folder"),
    ],
)
def test_bad_files_are_refused_before_any_analysis(monkeypatch, folder, tmp_path_factory, files, message):
    if files == ["OUTSIDE"]:
        other = tmp_path_factory.mktemp("other") / "x.mov"
        other.write_bytes(b"x")
        files = [str(other)]
    monkeypatch.setattr(pipeline, "run_analysis", lambda *a, **k: pytest.fail("must not analyze"))
    code, capture = run(monkeypatch, {"folder": folder, "files": files})
    assert code == 2
    assert message in capture.of_type("error")[0]["message"]


def test_a_folder_without_video_is_an_error(monkeypatch, tmp_path):
    (tmp_path / "notes.txt").write_text("hi")
    code, capture = run(monkeypatch, {"folder": str(tmp_path)})
    assert code == 1
    assert "No video files" in capture.of_type("error")[0]["message"]


def test_unknown_command(monkeypatch):
    capture = Capture()
    assert dispatch("broll-explode", capture.emitter, io.StringIO("{}")) == 2


@pytest.mark.skipif(shutil.which("ffmpeg") is None, reason="needs ffmpeg to make test videos")
def test_real_process_pool_end_to_end(tmp_path):
    """Real decoding in real worker processes: catches spawn/pickling and stdout-pollution problems."""
    for i in range(2):
        subprocess.run(
            [
                "ffmpeg",
                "-v",
                "error",
                "-y",
                "-f",
                "lavfi",
                "-i",
                "testsrc2=size=320x240:rate=15:duration=2",
                "-pix_fmt",
                "yuv420p",
                str(tmp_path / f"clip{i}.mp4"),
            ],
            check=True,
        )
    proc = subprocess.run(
        [sys.executable, "-u", "-m", "vibecut_agent", "broll-analyze"],
        input=json.dumps({"folder": str(tmp_path), "workers": 2, "windowSec": 1.0}),
        capture_output=True,
        text=True,
        cwd=SRC,
        env={**os.environ, "PYTHONPATH": SRC},
        timeout=120,
    )
    assert proc.returncode == 0, proc.stderr
    events = [json.loads(line) for line in proc.stdout.splitlines()]  # every stdout line is protocol
    assert events[0]["type"] == "starting" and events[-1] == {
        "type": "done",
        "cancelled": False,
    }
    result = next(e for e in events if e["type"] == "result")
    assert result["analyzed"] == 2 and result["failed"] == []
    assert {c["filename"] for c in result["ranked"]} == {"clip0.mp4", "clip1.mp4"}
    assert all(0 <= c["score"] <= 100 for c in result["ranked"])


# ------------------------------------------------------------------------ content-aware scoring


@pytest.fixture
def content_engine(monkeypatch):
    """Clips analyzed with content-aware scoring (see test_pipeline.content_result), torch faked as present."""
    from vibecut_agent.broll import vision_energy
    from vibecut_agent.broll.analyzer import rescore_clip

    monkeypatch.setattr(vision_energy, "is_available", lambda: True)

    def fake(path, **kw):
        name = os.path.basename(path)
        result = content_result(path, SCORES[name], DIRECTIONS[name])
        # The real analyze_clip scores through rescore_clip too, which applies the brief.
        rescore_clip(
            result,
            window_sec=kw["window_sec"],
            max_segments=kw["max_segments"],
            energy_weight=kw["energy_weight"],
            enable_energy=kw["enable_energy"],
            relevance_targets=kw.get("relevance_targets"),
            relevance_weight=kw.get("relevance_weight", 0.0),
        )
        result.overall_score = SCORES[name]  # keep the fixture's ranking
        return result

    monkeypatch.setattr(pipeline, "analyze_clip", fake)


def spy_run_analysis(monkeypatch):
    seen = {}
    real = pipeline.run_analysis

    def spy(*args, **kwargs):
        seen.update(kwargs)
        return real(*args, **kwargs)

    monkeypatch.setattr(pipeline, "run_analysis", spy)
    return seen


def test_ranked_clips_carry_energy_relevance_and_duplicate_marks(monkeypatch, folder, content_engine):
    from vibecut_agent.broll import vision_energy

    targets = np.concatenate([np.eye(1, 8, 0), np.eye(4, 8, 4)]).astype(np.float32)
    monkeypatch.setattr(vision_energy, "brief_targets", lambda brief: targets)
    code, capture = run(
        monkeypatch,
        {"folder": folder, "enableEnergy": True, "brief": "the sea", "dedupe": True},
    )
    (result,) = capture.of_type("result")
    assert code == 0 and result["warnings"] == [] and result["duplicates"] == 1
    by_name = {os.path.basename(c["path"]): c for c in result["ranked"]}
    assert by_name["a.mov"]["duplicateOf"] == "b.mov"
    assert by_name["b.mov"]["duplicateOf"] is None
    assert by_name["b.mov"]["energy"] == 40.0
    assert by_name["b.mov"]["relevance"] > 90
    assert by_name["c.mov"]["relevance"] < 50


def test_a_technical_run_reports_no_energy_or_relevance(monkeypatch, folder):
    code, capture = run(monkeypatch, {"folder": folder})
    (result,) = capture.of_type("result")
    assert result["duplicates"] == 0
    assert all(
        c["energy"] is None and c["relevance"] is None and c["duplicateOf"] is None for c in result["ranked"]
    )


def test_the_brief_is_trimmed_and_embedded_once(monkeypatch, folder, content_engine):
    seen = []
    monkeypatch.setattr(
        pipeline,
        "content_scoring",
        lambda brief, on: seen.append(brief) or (None, None),
    )
    run(
        monkeypatch,
        {"folder": folder, "enableEnergy": True, "brief": "  sea   " + "x" * 300},
    )
    assert len(seen) == 1 and len(seen[0]) == commands.MAX_BRIEF_CHARS == 200
    assert seen[0].startswith("sea x")


def test_a_brief_without_content_aware_scoring_is_ignored_with_a_warning(monkeypatch, folder):
    monkeypatch.setattr(pipeline, "content_scoring", lambda *a: pytest.fail("must not embed"))
    seen = spy_run_analysis(monkeypatch)
    _, capture = run(monkeypatch, {"folder": folder, "brief": "sea", "dedupe": True})
    assert seen["relevance_targets"] is None and seen["dedupe"] is False
    assert any("need content-aware scoring" in w for w in capture.of_type("result")[0]["warnings"])


def test_a_brief_that_cannot_be_embedded_is_a_warning_not_an_error(monkeypatch, folder, content_engine):
    from vibecut_agent.broll import vision_energy

    def broken(brief):
        raise vision_energy.VisionEnergyError("offline")

    monkeypatch.setattr(vision_energy, "brief_targets", broken)
    code, capture = run(monkeypatch, {"folder": folder, "enableEnergy": True, "brief": "sea"})
    (result,) = capture.of_type("result")
    assert code == 0 and capture.of_type("error") == []
    assert result["warnings"] == ["The brief could not be used: offline"]
    assert all(c["relevance"] is None for c in result["ranked"])


def test_content_aware_runs_default_to_three_workers(monkeypatch, folder, content_engine):
    monkeypatch.setattr(os, "cpu_count", lambda: 16)
    seen = spy_run_analysis(monkeypatch)
    run(monkeypatch, {"folder": folder, "enableEnergy": True})
    assert seen["max_workers"] == 3
    run(monkeypatch, {"folder": folder, "enableEnergy": True, "workers": 6})
    assert seen["max_workers"] == 6


def test_dedupe_leaves_near_duplicates_out_of_the_xml(monkeypatch, folder, tmp_path, content_engine):
    out = str(tmp_path / "out" / "selects.xml")
    code, capture = run(
        monkeypatch,
        {"folder": folder, "enableEnergy": True, "dedupe": True, "exportXmlPath": out},
    )
    assert code == 0 and capture.of_type("result")[0]["exportPath"] == out
    xml = open(out).read()
    assert "b.mov" in xml and "c.mov" in xml and "a.mov" not in xml
