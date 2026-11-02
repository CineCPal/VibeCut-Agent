"""The local vision worker (workers/vlm_worker.py), with a stand-in model on ffmpeg-made video."""

from __future__ import annotations

import json
import shutil
from pathlib import Path

import pytest

from tests.core.test_ffmpeg_ops import make
from tests.workers.fakes import Client
from vibecut_agent.config import OrchestratorConfig
from vibecut_agent.orchestrator.schemas import VLM_KEYFRAME_ID, validate
from vibecut_agent.workers import vlm_worker
from vibecut_agent.workers.base import CircuitBreaker, LocalLlmError
from vibecut_agent.workers.vlm_worker import ANALYSIS_SCHEMA, VlmWorker, VlmWorkerError, cache_path

pytestmark = pytest.mark.skipif(shutil.which("ffmpeg") is None, reason="needs ffmpeg")

ANSWER = {
    "shot_scale": "WS",
    "camera_movement": "STATIC",
    "lighting": {"key_style": "STUDIO_HIGH_KEY", "color_temperature": "NEUTRAL", "contrast": "HIGH"},
    "composition": {
        "subject_count": 0,
        "eyeline_direction": "NONE",
        "focus_quality": "TACK_SHARP",
        "obstructions": False,
    },
    "description": "A test pattern of coloured bars.",
    "visual_tags": ["test pattern", "colour bars"],
    "on_screen_text": None,
    "editorial_usability_score": 140,
}


@pytest.fixture
def config(monkeypatch, tmp_path):
    monkeypatch.setenv("VIBECUT_INDEX_DIR", str(tmp_path / "index"))
    return OrchestratorConfig.from_env("orchestrated")


@pytest.fixture
def film(tmp_path):
    return make(tmp_path / "film.mp4", "25", [2, 2, 2])


def test_analysis_schema_leaves_out_what_the_worker_knows():
    assert (
        "shot_id" not in ANALYSIS_SCHEMA["properties"] and "source_range" not in ANALYSIS_SCHEMA["required"]
    )
    assert "shot_scale" in ANALYSIS_SCHEMA["required"]


def test_analyses_each_shot_and_caches_the_file(config, film):
    client = Client([ANSWER])
    worker = VlmWorker(config, client=client)  # type: ignore[arg-type]
    result = worker.analyze(str(film))
    validate(result, VLM_KEYFRAME_ID)
    assert [s["shot_id"] for s in result["shots"]] == ["shot_0000", "shot_0001", "shot_0002"]
    assert result["media_fps"] == 25.0 and result["vlm_model_id"] == config.vlm_model
    # Scores are held to 0-100.
    assert result["shots"][0]["editorial_usability_score"] == 100.0
    assert len(client.prompts) == 3 and all(len(images) == 1 for _, _, images in client.prompts)
    assert client.prompts[0][2][0].startswith(config.index_dir)
    cached = json.loads(Path(cache_path(str(film))).read_text())
    assert cached["sample_strategy"] == "scene_cuts" and cached["result"] == result
    # From the cache: the whole file, and a range of it.
    assert worker.analyze(str(film)) == result
    assert [s["shot_id"] for s in worker.analyze(str(film), start=2.5, end=3.5)["shots"]] == ["shot_0001"]
    assert len(client.prompts) == 3
    # Another sampling isn't that cache.
    worker.analyze(str(film), sample_strategy="midpoint_only")
    assert len(client.prompts) == 4


def test_each_shot_goes_as_a_contact_strip_with_the_model_kept_loaded(config, film):
    """Model migration v2: [START | MID | END] in one image, read left to right, and Ollama keeps the
    model between shots."""
    client = Client([ANSWER])
    VlmWorker(config, client=client).analyze(str(film))  # type: ignore[arg-type]
    images = [images[0] for _, _, images in client.prompts]
    assert all(image.endswith("_strip.jpg") for image in images)
    assert all("three frames side by side, left to right" in prompt for _, prompt, _ in client.prompts)
    assert all("PAN_LEFT" in prompt and "RACK_FOCUS" not in prompt for _, prompt, _ in client.prompts)
    assert client.keep_alive == [vlm_worker.KEEP_ALIVE] * 3
    assert client.think == [False] * 3, "a reasoning model is asked not to: it took two minutes a shot"


def test_an_older_qwen_stands_in_and_its_analysis_is_cached_as_its_own(config, film):
    client = Client([ANSWER], models=("qwen2.5vl:7b",))
    worker = VlmWorker(config, client=client)  # type: ignore[arg-type]
    result = worker.analyze(str(film))
    assert {model for model, _, _ in client.prompts} == {"qwen2.5vl:7b"}
    assert result["vlm_model_id"] == "qwen2.5vl:7b"
    assert worker.cached(str(film)) == result
    # Once qwen3-vl:8b-instruct is pulled, the old model's analysis no longer fits.
    client.models = ("qwen2.5vl:7b", "qwen3-vl:8b-instruct")
    assert worker.cached(str(film)) is None


def test_a_single_frame_analysis_from_before_the_strips_is_done_again(config, film):
    client = Client([ANSWER])
    worker = VlmWorker(config, client=client)  # type: ignore[arg-type]
    result = worker.analyze(str(film))
    stored = json.loads(Path(cache_path(str(film))).read_text())
    Path(cache_path(str(film))).write_text(json.dumps({**stored, "cache_version": 1}))
    assert worker.cached(str(film)) is None
    assert worker.analyze(str(film)) == result and len(client.prompts) == 6


def test_a_custom_question_is_asked_and_not_cached(config, film):
    client = Client([ANSWER])
    worker = VlmWorker(config, client=client)  # type: ignore[arg-type]
    worker.analyze(
        str(film), sample_strategy="midpoint_only", custom_prompt_focus="Is anyone looking at the lens?"
    )
    assert "Is anyone looking at the lens?" in client.prompts[0][1]
    assert not Path(cache_path(str(film))).exists()


def test_an_off_format_answer_is_asked_again_once(config, film):
    wrong = {**ANSWER, "shot_scale": "MEDIUM"}
    client = Client([wrong, ANSWER, ANSWER])
    worker = VlmWorker(config, client=client)  # type: ignore[arg-type]
    worker.analyze(str(film), sample_strategy="midpoint_only")
    assert "didn't fit the format" in client.prompts[1][1] and "MEDIUM" in client.prompts[1][1]
    worker = VlmWorker(config, client=Client([wrong]))  # type: ignore[arg-type]
    with pytest.raises(VlmWorkerError, match="never fit"):
        worker.analyze(str(film), sample_strategy="midpoint_only", use_cache=False)


def test_a_failing_server_opens_the_breaker(config, film):
    breaker = CircuitBreaker("vision", failure_threshold=2)
    worker = VlmWorker(config, client=Client([LocalLlmError("down")]), breaker=breaker)  # type: ignore[arg-type]
    for _ in range(2):
        with pytest.raises(VlmWorkerError, match="down"):
            worker.analyze(str(film), sample_strategy="midpoint_only")
    assert breaker.state == "open"


def test_bad_requests(config, film, tmp_path):
    worker = VlmWorker(config, client=Client([ANSWER]))  # type: ignore[arg-type]
    with pytest.raises(VlmWorkerError, match="sample_strategy"):
        worker.analyze(str(film), sample_strategy="every_frame")  # type: ignore[arg-type]
    with pytest.raises(VlmWorkerError, match="isn't there"):
        worker.analyze(str(tmp_path / "gone.mp4"))


def test_health(config):
    assert VlmWorker(config, client=Client([ANSWER], models=(config.vlm_model,))).health()["available"]  # type: ignore[arg-type]
    assert not VlmWorker(config, client=Client([ANSWER])).health()["available"]  # type: ignore[arg-type]
