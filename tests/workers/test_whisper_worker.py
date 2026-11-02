"""The local speech-to-text worker (workers/whisper_worker.py): backends, the shared cache, v2 results."""

from __future__ import annotations

import json
import shutil

import pytest

from tests.core.test_ffmpeg_ops import make
from vibecut_agent.config import OrchestratorConfig
from vibecut_agent.orchestrator.schemas import WHISPER_TRANSCRIPT_ID, validate
from vibecut_agent.transcribe import pipeline
from vibecut_agent.workers import whisper_worker
from vibecut_agent.workers.whisper_worker import (
    CACHED_MODEL_ID,
    WhisperWorker,
    WhisperWorkerError,
    in_window,
    parse_whisper_cpp,
)

needs_ffmpeg = pytest.mark.skipif(shutil.which("ffmpeg") is None, reason="needs ffmpeg")


@pytest.fixture
def config(monkeypatch, tmp_path):
    monkeypatch.setenv("VIBECUT_INDEX_DIR", str(tmp_path / "index"))
    return OrchestratorConfig.from_env("orchestrated")


@pytest.fixture(scope="module")
def clip(tmp_path_factory):
    folder = tmp_path_factory.mktemp("whisper")
    return make(folder / "talk.mp4", "30000/1001", [3], [("sine", 3.0)])


def fake_backend(calls):
    def backend(wav, model):
        calls.append((wav, model))
        return [
            {
                "start": 0.5,
                "end": 1.9,
                "text": "Hello there",
                "avg_logprob": -0.2,
                "no_speech_prob": 0.01,
                "words": [
                    {"start": 0.5, "end": 0.9, "text": "Hello", "probability": 0.98},
                    {"start": 1.0, "end": 1.9, "text": "there", "probability": 0.7},
                ],
            },
            {"start": 2.0, "end": 2.8, "text": "", "avg_logprob": -2.0, "no_speech_prob": 0.9, "words": None},
            {
                "start": 2.0,
                "end": 2.9,
                "text": "uh",
                "avg_logprob": -1.5,
                "no_speech_prob": 0.2,
                "words": None,
            },
        ]

    return backend


@needs_ffmpeg
def test_transcribes_caches_and_reads_back(config, clip, tmp_path):
    media = tmp_path / "talk.mp4"
    shutil.copy(clip, media)
    calls: list = []
    worker = WhisperWorker(config, backends={"mlx-whisper": fake_backend(calls)})
    result = worker.transcribe(str(media), model_tier="small")
    validate(result, WHISPER_TRANSCRIPT_ID)
    assert calls[0][1] == "mlx-community/whisper-small-mlx"
    assert result["media_fps"] == 29.97 and result["backend"] == "mlx-whisper"
    assert result["speakers"] == ["Speaker 1"]
    first, second = result["segments"]
    assert first["start_tc"] == "00:00:00;15" and first["end_tc"] == "00:00:01;27"
    assert first["source_range"]["start_time"] == {
        "OTIO_SCHEMA": "RationalTime.1",
        "value": 15,
        "rate": 29.97,
    }
    assert [(w["start_frame"], w["end_frame"], w["probability"]) for w in first["words"]] == [
        (14, 27, 0.98),
        (29, 57, 0.7),
    ]
    assert second["low_confidence"] is True and second["words"] == []
    # The cache keeps its shared shape: no probabilities.
    cache = json.loads((tmp_path / "talk.mp4.ivt-cache.json").read_text())
    assert cache["segments"][0]["words"][0] == {"start": 0.5, "end": 0.9, "text": "Hello"}
    again = worker.transcribe(str(media))
    assert len(calls) == 1
    assert again["model_id"] == CACHED_MODEL_ID
    # Without Whisper's own, a word has its segment's mean token probability.
    assert again["segments"][0]["words"][0]["probability"] == pytest.approx(0.8187, abs=1e-4)
    validate(again, WHISPER_TRANSCRIPT_ID)
    assert worker.transcribe(str(media), start=2.5)["segments"] == [again["segments"][1]]
    worker.transcribe(str(media), use_cache=False)
    assert len(calls) == 2


def test_a_cached_transcript_from_the_transcribe_tab(config, tmp_path):
    media = tmp_path / "voice.wav"
    media.write_bytes(b"RIFF")
    segment = pipeline.Segment(
        start=1.0, end=2.0, text="Hi", speaker="Speaker 2", words=[{"start": 1.0, "end": 1.4, "text": "Hi"}]
    )
    assert pipeline.write_cache(
        str(media), "voice.wav", [segment], ["Speaker 2"], {"Speaker 2": "Ana"}, {"Speaker 9"}
    )
    worker = WhisperWorker(config, backends={"mlx-whisper": fake_backend([])})
    result = worker.transcribe(str(media))
    validate(result, WHISPER_TRANSCRIPT_ID)
    # No picture: frames are counted at 30.
    assert result["media_fps"] == 30.0
    assert result["speaker_labels"] == {"Speaker 2": "Ana"} and result["excluded_speakers"] == ["Speaker 9"]
    assert result["segments"][0]["start_tc"] == "00:00:01:00"


def test_requests_are_checked(config, tmp_path):
    worker = WhisperWorker(config, backends={})
    with pytest.raises(WhisperWorkerError, match="absolute"):
        worker.transcribe("talk.mp4")
    with pytest.raises(WhisperWorkerError, match="isn't there"):
        worker.transcribe(str(tmp_path / "gone.mp4"))
    present = tmp_path / "x.wav"
    present.write_bytes(b"")
    with pytest.raises(WhisperWorkerError, match="Hugging Face"):
        worker.transcribe(str(present), enable_diarization=True)
    with pytest.raises(WhisperWorkerError, match="model_tier"):
        worker.model_for("huge")


def test_models_per_backend(monkeypatch, tmp_path):
    monkeypatch.setenv("VIBECUT_WHISPER_BACKEND", "faster-whisper")
    worker = WhisperWorker(OrchestratorConfig.from_env())
    # The default (mlx's large-v3-turbo repo) means faster-whisper's own turbo build.
    assert worker.model_for(None) == "deepdml/faster-whisper-large-v3-turbo-ct2"
    assert worker.model_for("large-v3") == "large-v3"
    assert worker.model_for("large-v3-turbo") == "deepdml/faster-whisper-large-v3-turbo-ct2"
    monkeypatch.setenv("VIBECUT_WHISPER_MODEL", "mlx-community/whisper-medium-mlx")
    assert WhisperWorker(OrchestratorConfig.from_env()).model_for(None) == "medium"
    monkeypatch.delenv("VIBECUT_WHISPER_MODEL")
    monkeypatch.setenv("VIBECUT_WHISPER_BACKEND", "mlx-whisper")
    worker = WhisperWorker(OrchestratorConfig.from_env())
    assert worker.model_for(None) == "mlx-community/whisper-large-v3-turbo"
    assert worker.model_for("large-v3-turbo") == "mlx-community/whisper-large-v3-turbo"
    assert worker.model_for("large-v3") == "mlx-community/whisper-large-v3-mlx"
    ggml = tmp_path / "ggml-medium.bin"
    ggml.write_bytes(b"")
    (tmp_path / "ggml-tiny.bin").write_bytes(b"")
    monkeypatch.setenv("VIBECUT_WHISPER_BACKEND", "whisper.cpp")
    monkeypatch.setenv("VIBECUT_WHISPER_MODEL", str(ggml))
    worker = WhisperWorker(OrchestratorConfig.from_env())
    assert worker.model_for("tiny") == str(tmp_path / "ggml-tiny.bin")
    assert worker.model_for("small") == str(ggml)
    monkeypatch.setenv("VIBECUT_WHISPER_BACKEND", "vosk")
    with pytest.raises(WhisperWorkerError, match="VIBECUT_WHISPER_BACKEND"):
        WhisperWorker(OrchestratorConfig.from_env())


@pytest.mark.parametrize(
    ("model", "tier"),
    [
        ("mlx-community/whisper-large-v3-turbo", "large-v3-turbo"),
        ("mlx-community/whisper-large-v3-mlx", "large-v3"),
        ("deepdml/faster-whisper-large-v3-turbo-ct2", "large-v3-turbo"),
        ("/models/ggml-small.bin", "small"),
        ("medium", "medium"),
        ("/models/custom.bin", None),
    ],
)
def test_a_models_tier_is_read_from_its_name_turbo_before_large_v3(model, tier):
    assert whisper_worker.tier_of_model(model) == tier


def test_faster_whisper_loads_a_model_once_per_process(monkeypatch):
    """Model migration v2: an ingest of many files loads its model once, and only one stays loaded."""
    import sys
    import types

    loaded = []

    class Model:
        def __init__(self, name, **_):
            loaded.append(name)

        def transcribe(self, wav, **_):
            return iter([]), None

    monkeypatch.setitem(sys.modules, "faster_whisper", types.SimpleNamespace(WhisperModel=Model))
    monkeypatch.setattr(whisper_worker, "_FASTER_WHISPER_CACHE", {})
    for _ in range(3):
        whisper_worker.faster_whisper_backend("/tmp/a.wav", "large-v3-turbo")
    whisper_worker.faster_whisper_backend("/tmp/a.wav", "small")
    assert loaded == ["large-v3-turbo", "small"]
    assert list(whisper_worker._FASTER_WHISPER_CACHE) == ["small"]


def test_health_names_whats_missing(config, monkeypatch):
    monkeypatch.setattr(whisper_worker.importlib.util, "find_spec", lambda name: None)
    health = WhisperWorker(config).health()
    assert health["available"] is False and "the `transcribe` extra" in health["detail"]


def test_parse_whisper_cpp():
    document = {
        "transcription": [
            {
                "offsets": {"from": 0, "to": 2000},
                "text": " Hello there.",
                "tokens": [
                    {"text": "[_BEG_]", "offsets": {"from": 0, "to": 0}, "p": 1.0},
                    {"text": " Hel", "offsets": {"from": 100, "to": 300}, "p": 0.9},
                    {"text": "lo", "offsets": {"from": 300, "to": 500}, "p": 0.7},
                    {"text": " there.", "offsets": {"from": 600, "to": 1000}, "p": 0.5},
                    {"text": "[_TT_50]", "offsets": {"from": 1000, "to": 1000}, "p": 1.0},
                ],
            }
        ]
    }
    [segment] = parse_whisper_cpp(document)
    assert segment["text"] == "Hello there." and segment["end"] == 2.0
    assert [(w["text"], w["start"], w["end"], round(w["probability"], 2)) for w in segment["words"]] == [
        ("Hello", 0.1, 0.5, 0.8),
        ("there.", 0.6, 1.0, 0.5),
    ]
    assert segment["avg_logprob"] < 0 and segment["no_speech_prob"] == 0.0


def test_in_window():
    result = {"segments": [{"start": 0, "end": 1}, {"start": 1, "end": 2}, {"start": 2, "end": 3}]}
    assert in_window(result, 1.0, 2.0)["segments"] == [{"start": 1, "end": 2}]
    assert in_window(result, None, None) is result


def test_the_transcribe_tab_defaults_to_large_v3_turbo(tmp_path):
    from vibecut_agent.transcribe import commands

    video = tmp_path / "a.mov"
    video.write_bytes(b"")
    assert pipeline.DEFAULT_MODEL == "mlx-community/whisper-large-v3-turbo"
    assert commands.validate({"videos": [str(video)]})["model"] == pipeline.DEFAULT_MODEL
    assert "mlx-community/whisper-medium-mlx" in pipeline.WHISPER_MODELS.values()
