"""The broll-match command, with SigLIP replaced by colour vectors (ported from VibeCut's test_headless_match.py)."""

import importlib.util
import io
import json
import os
import subprocess
import sys

import pytest

from tests.broll.test_semantic import (
    BLUE,
    GREEN,
    RED,
    After,
    Never,
    fake_encode_images,
    fake_encode_texts,
    make_clip,
)
from vibecut_agent.broll import commands, semantic, vision_energy
from vibecut_agent.broll.analyzer import ClipResult, Segment
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
    make_clip(tmp_path / "red_then_blue.avi", [RED, BLUE])
    make_clip(tmp_path / "green.avi", [GREEN], seconds_each=6.0)
    return str(tmp_path)


@pytest.fixture(autouse=True)
def fake_model(monkeypatch):
    calls = {"preload": 0, "images": 0, "texts": 0}
    monkeypatch.setattr(vision_energy, "is_available", lambda: True)

    def preload(model_id=None):
        calls["preload"] += 1

    def images(batch, model_id=None):
        calls["images"] += len(batch)
        return fake_encode_images(batch)

    def texts(batch, model_id=None):
        calls["texts"] += len(batch)
        return fake_encode_texts(batch)

    monkeypatch.setattr(vision_energy, "preload", preload)
    monkeypatch.setattr(vision_energy, "encode_images", images)
    monkeypatch.setattr(vision_energy, "encode_texts", texts)
    return calls


def run(monkeypatch, request, cancel=None):
    capture = Capture()
    monkeypatch.setattr(sys, "stdin", io.StringIO(json.dumps(request)))
    code = commands.main("match", capture.emitter, sys.stdin, cancel=cancel)
    return code, capture


def query(text, **extra):
    return {"id": text, "text": text, **extra}


def test_finds_the_clip_and_the_stretch_that_fit_each_text(monkeypatch, folder):
    code, capture = run(
        monkeypatch,
        {
            "folder": folder,
            "queries": [
                query("blue sky", meta={"at": 12.5, "length": 3}),
                query("green field"),
            ],
            "topK": 2,
        },
    )
    assert code == 0
    assert capture.of_type("error") == []
    (result,) = capture.of_type("result")
    assert (
        result["indexed"],
        result["cached"],
        result["cancelled"],
        result["failed"],
    ) == (2, 0, False, [])

    blue, green = result["matches"]
    assert (
        blue["id"] == "blue sky" and blue["text"] == "blue sky" and blue["meta"] == {"at": 12.5, "length": 3}
    )
    assert next(r["filename"] for r in blue["results"]) == "red_then_blue.avi"
    assert blue["results"][0]["start"] >= 3.5
    assert len(blue["results"]) == 2
    assert green["results"][0]["filename"] == "green.avi" and green["meta"] is None
    assert set(blue["results"][0]) == {
        "path",
        "filename",
        "similarity",
        "relative",
        "technical",
        "combined",
        "start",
        "end",
        "duration",
    }
    assert capture.of_type("done")[0]["cancelled"] is False


def test_reports_indexing_progress_and_loads_the_model_once(monkeypatch, folder, fake_model):
    _, capture = run(monkeypatch, {"folder": folder, "queries": [query("red")]})
    progress = capture.of_type("progress")
    assert [p["done"] for p in progress] == [1, 2] and progress[-1]["fraction"] == 1.0
    assert progress[-1]["phase"] == "indexing"
    assert fake_model["preload"] == 1 and fake_model["texts"] == 1


def test_a_second_run_reuses_the_index_and_does_not_embed_frames_again(monkeypatch, folder, fake_model):
    run(monkeypatch, {"folder": folder, "queries": [query("red")]})
    frames = fake_model["images"]
    _, capture = run(monkeypatch, {"folder": folder, "queries": [query("blue")]})
    assert capture.of_type("result")[0]["cached"] == 2 and capture.of_type("result")[0]["indexed"] == 0
    assert fake_model["images"] == frames


def test_with_no_queries_it_only_builds_the_index(monkeypatch, folder, fake_model):
    _, capture = run(monkeypatch, {"folder": folder})
    result = capture.of_type("result")[0]
    assert result["matches"] == [] and result["indexed"] == 2
    assert fake_model["texts"] == 0
    assert sorted(semantic.load_index(folder)) == ["green.avi", "red_then_blue.avi"]


def test_a_fully_indexed_folder_with_no_queries_does_not_load_the_model(monkeypatch, folder, fake_model):
    run(monkeypatch, {"folder": folder})
    preloads = fake_model["preload"]
    run(monkeypatch, {"folder": folder})
    assert fake_model["preload"] == preloads


def test_blends_in_the_analysis_quality_score_when_the_folder_was_analyzed(monkeypatch, folder):
    scores = {
        os.path.join(folder, "green.avi"): 100.0,
        os.path.join(folder, "red_then_blue.avi"): 0.0,
    }
    monkeypatch.setattr(semantic, "technical_scores", lambda *a, **k: scores)
    _, capture = run(
        monkeypatch,
        {"folder": folder, "queries": [query("blue")], "qualityWeight": 1.0},
    )
    top = capture.of_type("result")[0]["matches"][0]["results"][0]
    assert top["filename"] == "green.avi" and top["technical"] == 100.0


def test_technical_scores_come_from_the_analysis_cache(tmp_path, monkeypatch):
    from vibecut_agent.broll import result_cache

    clip = make_clip(tmp_path / "a.avi", [RED])
    fingerprint = result_cache.file_fingerprint(clip)
    result = ClipResult(
        path=clip,
        filename="a.avi",
        duration=4.0,
        fps=10.0,
        width=64,
        height=48,
        overall_score=77.0,
        segments=[Segment(0, 4, 77.0)],
    )
    entry = result_cache.entry_from_result(result, fingerprint)
    result_cache.save_cache(str(tmp_path), {"a.avi": entry})
    monkeypatch.setattr(
        "vibecut_agent.broll.analyzer.rescore_clip", lambda r, **kw: setattr(r, "overall_score", 77.0) or r
    )
    assert semantic.technical_scores(str(tmp_path), [clip], 4.0) == {clip: 77.0}
    assert semantic.technical_scores(str(tmp_path), [str(tmp_path / "other.avi")], 4.0) == {}


def test_a_clip_that_cannot_be_read_is_listed_and_the_rest_still_match(monkeypatch, folder):
    with open(os.path.join(folder, "bad.avi"), "wb") as handle:
        handle.write(b"junk")
    _, capture = run(monkeypatch, {"folder": folder, "queries": [query("green")]})
    result = capture.of_type("result")[0]
    assert [os.path.basename(f["path"]) for f in result["failed"]] == ["bad.avi"]
    assert result["matches"][0]["results"][0]["filename"] == "green.avi"


def test_when_no_clip_can_be_read_it_says_so_instead_of_matching(monkeypatch, tmp_path):
    with open(tmp_path / "bad.avi", "wb") as handle:
        handle.write(b"junk")
    _, capture = run(monkeypatch, {"folder": str(tmp_path), "queries": [query("green")]})
    result = capture.of_type("result")[0]
    assert result["matches"] == [] and any("nothing was matched" in w for w in result["warnings"])


def test_a_cancel_stops_indexing_keeps_what_was_done_and_matches_nothing(monkeypatch, folder):
    code, capture = run(monkeypatch, {"folder": folder, "queries": [query("blue")]}, cancel=After(1))
    assert code == 0
    result = capture.of_type("result")[0]
    assert result["cancelled"] is True and result["matches"] == [] and result["indexed"] == 1
    assert capture.of_type("done")[0]["cancelled"] is True
    assert len(semantic.load_index(folder)) == 1


def test_without_torch_it_explains_what_is_missing(monkeypatch, folder):
    monkeypatch.setattr(vision_energy, "is_available", lambda: False)
    code, capture = run(monkeypatch, {"folder": folder, "queries": [query("blue")]})
    assert code == 1
    assert "PyTorch" in capture.of_type("error")[0]["message"]


def test_a_model_that_cannot_load_fails_once_not_once_per_clip(monkeypatch, folder):
    def broken(model_id=None):
        raise vision_energy.VisionEnergyError("Failed to load local vision model: offline")

    monkeypatch.setattr(vision_energy, "preload", broken)
    code, capture = run(monkeypatch, {"folder": folder, "queries": [query("blue")]})
    assert code == 1
    assert [e["message"] for e in capture.of_type("error")] == ["Failed to load local vision model: offline"]
    assert capture.of_type("progress") == []


def test_a_folder_without_video_is_an_error(monkeypatch, tmp_path):
    (tmp_path / "notes.txt").write_text("hi")
    code, capture = run(monkeypatch, {"folder": str(tmp_path)})
    assert code == 1
    assert "No video files" in capture.of_type("error")[0]["message"]


def test_long_text_is_trimmed_and_whitespace_collapsed(monkeypatch, folder):
    _, capture = run(monkeypatch, {"folder": folder, "queries": [query("blue   " + "x " * 400)]})
    text = capture.of_type("result")[0]["matches"][0]["text"]
    assert len(text) <= commands.MAX_QUERY_CHARS and "  " not in text


@pytest.mark.parametrize(
    "mutation, message",
    [
        ({"folder": "relative"}, "absolute"),
        ({"folder": "/definitely/not/here"}, "Not a folder"),
        ({"queries": "blue"}, "must be a list"),
        ({"queries": ["blue"]}, "must be an object"),
        ({"queries": [{"text": "   "}]}, "must be some text"),
        ({"queries": [{"id": True, "text": "a"}]}, "id must be text or a number"),
        ({"queries": [{"text": "a", "meta": "x" * 2000}]}, "too large"),
        ({"queries": [{"text": "a"}] * 21}, "At most"),
        ({"topK": 0}, "between"),
        ({"windowSec": "long"}, "must be a number"),
        ({"qualityWeight": 2}, "between"),
    ],
)
def test_bad_requests_are_refused_before_any_work(monkeypatch, folder, mutation, message, fake_model):
    code, capture = run(monkeypatch, {"folder": folder, **mutation})
    assert code == 2
    assert message in capture.of_type("error")[0]["message"]
    assert fake_model["preload"] == 0 and fake_model["images"] == 0


def test_ids_may_be_numbers_and_default_to_the_position(monkeypatch, folder):
    _, capture = run(
        monkeypatch,
        {"folder": folder, "queries": [{"id": 7, "text": "red"}, {"text": "blue"}]},
    )
    assert [m["id"] for m in capture.of_type("result")[0]["matches"]] == ["7", "1"]


def test_real_process_speaks_clean_protocol_and_needs_the_extra_when_torch_is_missing(
    folder,
):
    """A real subprocess: every stdout line is protocol JSON, and without the energy extra the failure is a clean error event."""
    proc = subprocess.run(
        [sys.executable, "-u", "-m", "vibecut_agent", "broll-match"],
        input=json.dumps({"folder": folder, "queries": [{"text": "blue"}]}),
        capture_output=True,
        text=True,
        cwd=SRC,
        env={**os.environ, "PYTHONPATH": SRC},
        timeout=120,
    )
    events = [json.loads(line) for line in proc.stdout.splitlines()]
    assert events[0]["type"] == "starting" and events[-1]["type"] == "done"
    if importlib.util.find_spec("torch") and importlib.util.find_spec("open_clip"):
        pytest.skip("the energy extra is installed here, so this run really loads the model")
    assert proc.returncode == 1
    assert "PyTorch" in next(e for e in events if e["type"] == "error")["message"]


# ------------------------------------------------------------------ searching only some clips


def test_a_search_can_be_limited_to_some_clips_and_leaves_the_others_index_alone(monkeypatch, folder):
    run(monkeypatch, {"folder": folder})  # index both clips
    both = set(semantic.load_index(folder))
    only = os.path.join(folder, "green.avi")
    _, capture = run(monkeypatch, {"folder": folder, "files": [only], "queries": [query("green")]})
    result = capture.of_type("result")[0]
    assert [r["filename"] for r in result["matches"][0]["results"]] == ["green.avi"]
    assert result["cached"] == 1 and result["indexed"] == 0
    assert set(semantic.load_index(folder)) == both  # red_then_blue.avi kept its stored embeddings


def test_a_limited_search_embeds_only_the_clips_asked_for(monkeypatch, folder, fake_model):
    only = os.path.join(folder, "red_then_blue.avi")
    _, capture = run(monkeypatch, {"folder": folder, "files": [only], "queries": [query("blue")]})
    result = capture.of_type("result")[0]
    assert result["indexed"] == 1 and [r["filename"] for r in result["matches"][0]["results"]] == [
        "red_then_blue.avi"
    ]
    assert list(semantic.load_index(folder)) == [
        "red_then_blue.avi"
    ]  # a partial index, and nothing was pruned or invented
    assert [p["done"] for p in capture.of_type("progress")] == [1]


@pytest.mark.parametrize(
    "files, message",
    [
        ([], "files must be a list"),
        ("green.avi", "files must be a list"),
        (["green.avi"], "absolute"),
        (["/etc/hosts"], "Not a clip inside the folder"),
        (["MISSING"], "Not a clip inside the folder"),
    ],
)
def test_the_clips_to_search_are_checked(monkeypatch, folder, files, message, fake_model):
    if files == ["MISSING"]:
        files = [os.path.join(folder, "nope.avi")]
    code, capture = run(monkeypatch, {"folder": folder, "files": files, "queries": [query("green")]})
    assert code == 2 and message in capture.of_type("error")[0]["message"]
    assert fake_model["preload"] == 0


def test_the_match_model_is_the_one_spyglass_uses(monkeypatch, folder):
    seen = []
    monkeypatch.setattr(vision_energy, "preload", lambda model_id=None: seen.append(model_id))
    run(monkeypatch, {"folder": folder, "queries": [query("red")]})
    assert seen == ["ViT-B-16-SigLIP2-256/webli"] == [vision_energy.EMBED_MODEL_ID]


def test_an_index_made_by_another_model_or_version_is_not_reused(folder):
    run_index = semantic.build_index(folder, [os.path.join(folder, "green.avi")], fake_encode_images, Never())
    assert run_index.indexed == 1
    path = semantic.index_path(folder)
    data = json.load(open(path))
    assert (
        data["model"] == semantic.MODEL_ID == vision_energy.EMBED_MODEL_ID
        and data["version"] == semantic.INDEX_VERSION == 3
    )
    data["model"] = "ViT-B-32-quickgelu"  # an index the CLIP-era search wrote
    json.dump(data, open(path, "w"))
    assert semantic.load_index(folder) == {}
