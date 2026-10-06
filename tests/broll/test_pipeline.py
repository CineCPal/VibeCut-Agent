"""tests/test_pipeline.py — the GUI-free analysis run, with the video decoding faked."""

import os
import threading
from concurrent.futures import ThreadPoolExecutor

import pytest

from vibecut_agent.broll import pipeline, result_cache
from vibecut_agent.broll.analyzer import ClipResult, Segment


@pytest.fixture
def folder(tmp_path):
    for name in ("a.mov", "b.mov", "c.mov"):
        (tmp_path / name).write_bytes(b"not really video: " + name.encode())
    return str(tmp_path)


def files_in(folder):
    return sorted(os.path.join(folder, n) for n in os.listdir(folder) if n.endswith(".mov"))


def fake_result(path, score=50.0, error=None):
    return ClipResult(
        path=path,
        filename=os.path.basename(path),
        duration=10.0,
        fps=30.0,
        width=1920,
        height=1080,
        overall_score=score,
        best_window_start=1.0,
        best_window_end=5.0,
        best_window_score=score,
        segments=[Segment(start=1.0, end=5.0, score=score)],
        error=error,
    )


SCORES = {"a.mov": 30.0, "b.mov": 90.0, "c.mov": 60.0}


@pytest.fixture
def fake_analyzer(monkeypatch):
    calls = []

    def fake(path, **kwargs):
        calls.append(os.path.basename(path))
        name = os.path.basename(path)
        if name == "c.mov" and kwargs.get("boom"):
            raise RuntimeError("boom")
        return fake_result(path, SCORES[name])

    monkeypatch.setattr(pipeline, "analyze_clip", fake)
    return calls


def run(folder, **overrides):
    messages = []
    statuses = []
    options = {
        "window_sec": 4.0,
        "max_segments": 1,
        "enable_energy": False,
        "energy_weight": 0.35,
        "max_workers": 2,
        "cancel_event": threading.Event(),
        "on_status": statuses.append,
        "on_progress": lambda pct, msg: messages.append((pct, msg)),
        "executor_factory": ThreadPoolExecutor,
    }
    options.update(overrides)
    outcome = pipeline.run_analysis(files_in(folder), folder, **options)
    return outcome, messages, statuses


def test_analyzes_every_clip_best_first_and_reports_progress(folder, fake_analyzer):
    outcome, progress, statuses = run(folder)

    assert [r.filename for r in outcome.results] == ["b.mov", "c.mov", "a.mov"]
    assert (outcome.total, outcome.cache_hits, outcome.cancelled) == (3, 0, False)
    assert sorted(fake_analyzer) == ["a.mov", "b.mov", "c.mov"]
    assert [p for p, _ in progress][-1] == pytest.approx(100.0)
    assert all(msg.startswith("Analyzed (") for _, msg in progress)
    assert statuses == ["Analyzing 3 clip(s) with 2 parallel worker(s)..."]


def test_a_second_run_is_served_from_the_cache(folder, fake_analyzer):
    run(folder)
    fake_analyzer.clear()

    outcome, progress, statuses = run(folder)

    assert fake_analyzer == []  # nothing decoded
    assert outcome.cache_hits == 3
    # Cached clips are re-scored from their stored frame samples, which the fakes do not have,
    # so only which clips came back is checked here (ordering is covered above).
    assert sorted(r.filename for r in outcome.results) == ["a.mov", "b.mov", "c.mov"]
    assert progress == [(100.0, "Loaded 3/3 clip(s) from cache...")]
    assert statuses == []


def test_a_changed_file_is_analyzed_again(folder, fake_analyzer):
    run(folder)
    fake_analyzer.clear()
    with open(os.path.join(folder, "a.mov"), "ab") as f:
        f.write(b"more")

    outcome, _, _ = run(folder)

    assert fake_analyzer == ["a.mov"]
    assert outcome.cache_hits == 2


def test_a_failing_clip_is_reported_not_cached_and_does_not_stop_the_rest(folder, monkeypatch):
    def fake(path, **kwargs):
        if path.endswith("c.mov"):
            raise RuntimeError("codec exploded")
        return fake_result(path, 70.0)

    monkeypatch.setattr(pipeline, "analyze_clip", fake)

    outcome, _, _ = run(folder)

    bad = [r for r in outcome.results if r.error]
    assert [r.filename for r in bad] == ["c.mov"]
    assert "codec exploded" in bad[0].error
    assert len(outcome.results) == 3
    cached = result_cache.load_cache(folder)
    assert sorted(cached) == ["a.mov", "b.mov"]  # the failure is retried next time


def test_cancel_before_start_analyzes_nothing_but_still_reports(folder, fake_analyzer):
    cancel = threading.Event()
    cancel.set()
    outcome, _, _ = run(folder, cancel_event=cancel)
    assert fake_analyzer == []
    assert outcome.cancelled and outcome.results == []


def test_cancel_during_the_run_drops_clips_that_have_not_started(folder, monkeypatch):
    cancel = threading.Event()
    started = []

    def fake(path, **kwargs):
        started.append(os.path.basename(path))
        cancel.set()  # the first clip asks for a stop while it is still running
        return fake_result(path, 40.0)

    monkeypatch.setattr(pipeline, "analyze_clip", fake)

    outcome, _, _ = run(folder, cancel_event=cancel, max_workers=1)

    assert outcome.cancelled
    assert started == ["a.mov"]
    assert [r.filename for r in outcome.results] == ["a.mov"]
    assert sorted(result_cache.load_cache(folder)) == ["a.mov"]  # what finished is kept


def test_workers_never_exceed_the_clips_to_do(folder, fake_analyzer):
    _, _, statuses = run(folder, max_workers=16)
    assert statuses == ["Analyzing 3 clip(s) with 3 parallel worker(s)..."]


def test_worker_wrapper_turns_an_exception_into_a_failed_result(monkeypatch):
    def explode(path, **kwargs):
        raise ValueError("bad frame")

    monkeypatch.setattr(pipeline, "analyze_clip", explode)
    result = pipeline.analyze_clip_worker("/x/clip.mov", 4.0, 1, False, 0.35)
    assert result.filename == "clip.mov"
    assert "bad frame" in result.error


class TestSelection:
    results = [
        fake_result("/x/low.mov", 20.0),
        fake_result("/x/high.mov", 95.0),
        fake_result("/x/broken.mov", 99.0, error="bad"),
        fake_result("/x/mid.mov", 60.0),
    ]

    def names(self, selected):
        return [r.filename for r in selected]

    def test_all_skips_failures_and_sorts_best_first(self):
        assert self.names(pipeline.select_results(self.results, "all")) == [
            "high.mov",
            "mid.mov",
            "low.mov",
        ]

    def test_top_n(self):
        assert self.names(pipeline.select_results(self.results, "topn", top_n=2)) == [
            "high.mov",
            "mid.mov",
        ]
        assert self.names(pipeline.select_results(self.results, "topn", top_n=0)) == [
            "high.mov"
        ]  # at least one

    def test_threshold(self):
        assert self.names(pipeline.select_results(self.results, "threshold", min_score=60.0)) == [
            "high.mov",
            "mid.mov",
        ]

    def test_sequence_order(self):
        selected = pipeline.select_results(self.results, "all")
        assert self.names(pipeline.order_for_sequence(selected, "name")) == [
            "high.mov",
            "low.mov",
            "mid.mov",
        ]
        assert self.names(pipeline.order_for_sequence(selected, "score")) == [
            "high.mov",
            "mid.mov",
            "low.mov",
        ]


def test_importing_the_pipeline_does_not_pull_in_tkinter():
    import subprocess
    import sys

    code = "import sys, vibecut_agent.broll.pipeline; sys.exit(1 if 'tkinter' in sys.modules else 0)"
    src = os.path.dirname(os.path.dirname(os.path.dirname(pipeline.__file__)))
    assert subprocess.run([sys.executable, "-c", code], env={**os.environ, "PYTHONPATH": src}).returncode == 0


# ------------------------------------------------------------------------ content-aware scoring


def content_result(path, score, direction):
    """A clip analyzed with content-aware scoring: samples, energy and per-frame SigLIP 2 embeddings."""
    import numpy as np

    from vibecut_agent.broll import vision_energy
    from vibecut_agent.broll.analyzer import FrameSample

    result = fake_result(path, score)
    result.samples = [
        FrameSample(
            time_sec=t * 0.5,
            sharpness=50,
            exposure=50,
            motion_mag=0,
            motion_jitter=0,
            energy=40,
        )
        for t in range(4)
    ]
    vector = np.zeros(8, dtype=np.float32)
    vector[direction] = 1.0
    result.embeddings = np.tile(vector, (4, 1)).astype(np.float16)
    result.energy_enabled = True
    result.mean_energy_score = 40.0  # analyze_clip's mean of the samples' energy
    result.embed_model = vision_energy.EMBED_MODEL_ID
    return result


# a.mov and b.mov look the same (axis 0); c.mov does not (axis 1)
DIRECTIONS = {"a.mov": 0, "b.mov": 0, "c.mov": 1}


@pytest.fixture
def content_analyzer(monkeypatch):
    calls = []

    def fake(path, **kwargs):
        name = os.path.basename(path)
        calls.append((name, kwargs))
        return content_result(path, SCORES[name], DIRECTIONS[name])

    monkeypatch.setattr(pipeline, "analyze_clip", fake)
    return calls


def test_the_brief_and_its_weight_reach_every_clip(folder, content_analyzer):
    import numpy as np

    targets = np.eye(5, 8, dtype=np.float32)
    run(folder, enable_energy=True, relevance_targets=targets, relevance_weight=0.5)
    assert len(content_analyzer) == 3
    for _, kwargs in content_analyzer:
        assert kwargs["relevance_targets"] is targets and kwargs["relevance_weight"] == 0.5


def test_a_content_aware_run_saves_embeddings_and_a_new_brief_needs_no_decode(folder, content_analyzer):
    import numpy as np

    run(folder, enable_energy=True)
    saved = result_cache.load_embeddings(folder)
    assert sorted(saved) == ["a.mov", "b.mov", "c.mov"] and saved["a.mov"].shape == (
        4,
        8,
    )

    content_analyzer.clear()
    targets = np.concatenate([np.eye(1, 8, 0), np.eye(4, 8, 4)]).astype(np.float32)  # brief = axis 0
    outcome, _, _ = run(folder, enable_energy=True, relevance_targets=targets, relevance_weight=0.35)
    assert content_analyzer == [] and outcome.cache_hits == 3
    relevance = {r.filename: r.mean_relevance_score for r in outcome.results}
    assert all(r.relevance_enabled for r in outcome.results)
    assert relevance["a.mov"] > 90 and relevance["c.mov"] < 50


def test_a_cache_entry_from_the_old_clip_model_is_analyzed_again(folder, content_analyzer):
    run(folder, enable_energy=True)
    entries = result_cache.load_cache(folder)
    entries["a.mov"]["embed_model"] = "ViT-B-32/openai"
    result_cache.save_cache(folder, entries)
    content_analyzer.clear()
    outcome, _, _ = run(folder, enable_energy=True)
    assert [name for name, _ in content_analyzer] == ["a.mov"] and outcome.cache_hits == 2


def test_a_technical_only_run_leaves_the_embeddings_file_alone(folder, content_analyzer):
    run(folder, enable_energy=True)
    path = result_cache.embeddings_path_for_folder(folder)
    before = os.path.getmtime(path), open(path, "rb").read()
    run(folder, enable_energy=False)
    assert (os.path.getmtime(path), open(path, "rb").read()) == before


def test_dedupe_marks_the_weaker_near_duplicate_and_an_export_can_skip_it(folder, content_analyzer):
    outcome, _, _ = run(folder, enable_energy=True, dedupe=True)
    marks = {r.filename: r.duplicate_of for r in outcome.results}
    assert marks == {
        "b.mov": None,
        "c.mov": None,
        "a.mov": "b.mov",
    }  # b scores higher than a
    assert outcome.duplicates == 1
    kept = pipeline.select_results(outcome.results, "all", skip_duplicates=True)
    assert [r.filename for r in kept] == ["b.mov", "c.mov"]
    assert len(pipeline.select_results(outcome.results, "all")) == 3


def test_without_dedupe_nothing_is_marked(folder, content_analyzer):
    outcome, _, _ = run(folder, enable_energy=True)
    assert all(r.duplicate_of is None for r in outcome.results) and outcome.duplicates == 0


def test_content_aware_runs_default_to_at_most_three_workers(monkeypatch):
    monkeypatch.setattr(os, "cpu_count", lambda: 16)
    assert pipeline.default_worker_count() == 15
    assert pipeline.default_worker_count(enable_energy=True) == 3


def test_content_scoring_embeds_the_brief_once_and_survives_a_failure(monkeypatch):
    from vibecut_agent.broll import vision_energy

    seen = []
    monkeypatch.setattr(vision_energy, "brief_targets", lambda brief: seen.append(brief) or "targets")
    assert pipeline.content_scoring("  sunset  ", True) == ("targets", None)
    assert pipeline.content_scoring("sunset", False) == (None, None)
    assert pipeline.content_scoring("   ", True) == (None, None)
    assert seen == ["sunset"]

    def broken(brief):
        raise vision_energy.VisionEnergyError("offline")

    monkeypatch.setattr(vision_energy, "brief_targets", broken)
    assert pipeline.content_scoring("sunset", True) == (None, "offline")
