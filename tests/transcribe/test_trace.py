"""The `transcribe` command's trace for the Telemetry Studio (transcribe/trace.py)."""

from __future__ import annotations

from itertools import pairwise
from typing import Any

import pytest

from vibecut_agent.protocol import CancelFlag
from vibecut_agent.telemetry.bus import TelemetryBus, get_bus, reset_bus, validate_envelope
from vibecut_agent.telemetry.instrument import TraceEmitter
from vibecut_agent.transcribe import commands, pipeline
from vibecut_agent.transcribe.trace import TranscribeTrace


@pytest.fixture
def videos(tmp_path):
    paths = []
    for name in ("interview.mov", "cached.mov", "broken.mov"):
        path = tmp_path / name
        path.write_bytes(b"\0")
        paths.append(str(path))
    return paths


@pytest.fixture
def fake_pipeline(monkeypatch):
    """transcribe_one as the real pipeline reports: each phase announced at 0.0, then its progress. The
    cached file reports nothing; the broken one fails part way through Whisper."""

    def transcribe_one(video, request, export_path, hf_token, on_progress):
        if video.endswith("broken.mov"):
            on_progress("extract", 0.0, "Extracting the sound…")
            on_progress("extract", 1.0, "Extracted the sound")
            on_progress("transcribe", 0.0, "Transcribing… 0%")
            on_progress("transcribe", 0.3, "Transcribing… 30%")
            raise RuntimeError("mlx-whisper ran out of memory")
        cached = video.endswith("cached.mov")
        if not cached:
            on_progress("extract", 0.0, "Extracting the sound…")
            on_progress("extract", 0.5, "Extracting the sound… 50%")
            on_progress("extract", 1.0, "Extracted the sound")
            on_progress("transcribe", 0.0, "Transcribing… 0%")
            for step in range(1, 11):
                on_progress("transcribe", step / 10, f"Transcribing… {step * 10}%")
            on_progress("align", 0.0, "Checking the transcript against the sound…")
            on_progress("align", 1.0, "Checked against the sound")
            on_progress("diarize", 0.0, "Diarizing speakers…")
            on_progress("diarize", 1.0, "Diarizing speakers… 100%")
        return {
            "path": video,
            "fromCache": cached,
            "speakers": ["Speaker 1", "Speaker 2"],
            "segmentCount": 42,
            "cachePath": f"{video}.ivt-cache.json",
            "exportPath": f"{video}.txt",
            "warnings": [],
        }

    monkeypatch.setattr(commands, "transcribe_one", transcribe_one)
    monkeypatch.setattr(commands.shutil, "which", lambda _: "/usr/bin/ffmpeg")
    monkeypatch.setattr(commands, "model_is_downloaded", lambda _: True)


def request_for(videos: list[str], **extra: Any) -> dict[str, Any]:
    return {"videos": videos, "model": pipeline.DEFAULT_MODEL, "diarize": True, "hfToken": "hf_x", **extra}


def traced_run(monkeypatch, recorder, videos, **extra) -> list[dict[str, Any]]:
    bus = TelemetryBus()
    made: list[TranscribeTrace] = []

    def for_run(raw, request):
        label = "Background transcription" if raw.get("background") else "Transcribe"
        trace = TranscribeTrace(
            TraceEmitter(bus, "trc_test_trn", label), len(request["videos"]), request["model"], True
        )
        made.append(trace)
        return trace

    monkeypatch.setattr(TranscribeTrace, "for_run", staticmethod(for_run))
    envelopes: list[dict[str, Any]] = []
    bus.add_listener(envelopes.extend)
    commands.run_transcribe(request_for(videos, **extra), recorder.emitter, CancelFlag())
    bus.flush()
    assert made
    return envelopes


def test_a_transcription_is_traced_phase_by_phase(monkeypatch, recorder, videos, fake_pipeline):
    envelopes = traced_run(monkeypatch, recorder, videos, background=True)
    assert [validate_envelope(e) for e in envelopes if validate_envelope(e)] == []

    spawns = [e for e in envelopes if e["event_type"] == "SPAWN"]
    labels = [e["payload"]["task_label"] for e in spawns]
    assert labels == [
        "Background transcription",
        "Extract the sound: interview.mov",
        "Whisper: interview.mov",
        "Check against the sound: interview.mov",
        "Speaker labels: interview.mov",
        "From the cache: cached.mov",
        "Extract the sound: broken.mov",
        "Whisper: broken.mov",
    ]
    assert [e["agent_id"] for e in spawns[1:5]] == [
        "app.sound",
        "app.whisper",
        "app.alignment",
        "app.diarizer",
    ]
    assert spawns[0]["payload"]["hardware_backend"] == "METAL_MPS"
    assert spawns[2]["payload"]["hardware_backend"] == "METAL_MPS"
    # Each phase waits on the one before it; the first on the root.
    ids = [e["payload"]["task_id"] for e in spawns]
    assert spawns[1]["payload"]["upstream_task_ids"] == ["task_root"]
    for before, after in pairwise(spawns[1:5]):
        assert after["payload"]["upstream_task_ids"] == [before["payload"]["task_id"]]

    completed = {e["payload"]["task_id"]: e["payload"] for e in envelopes if e["event_type"] == "COMPLETED"}
    last = completed[ids[4]]
    assert last["output_summary"] == "42 lines, 2 speaker(s): interview.mov"
    assert last["artifacts"][0]["artifact_type"] == "TRANSCRIPT_SUMMARY"
    assert last["artifacts"][0]["speakers"] == ["Speaker 1", "Speaker 2"]
    handoffs = [e["payload"] for e in envelopes if e["event_type"] == "CONTEXT_HANDOFF"]
    assert {"from_task_id": ids[4], "to_task_id": "task_root"}.items() <= next(
        h for h in handoffs if h["from_task_id"] == ids[4]
    ).items()

    failed = [e["payload"] for e in envelopes if e["event_type"] == "FAILED"]
    assert [(f["task_id"], f["error_message"]) for f in failed] == [
        (ids[7], "broken.mov: mlx-whisper ran out of memory")
    ]

    progress = [e["payload"] for e in envelopes if e["event_type"] == "BATCH_PROGRESS"]
    whisper = [p for p in progress if p["task_id"] == ids[2]]
    # Throttled here (and coalesced by the bus): not all ten, and the last says it's done.
    assert 1 <= len(whisper) < 10
    assert whisper[-1]["fraction"] == 1.0
    assert whisper[-1]["current_item_label"].startswith("interview.mov: Transcribing")

    root = envelopes[-1]
    assert root["event_type"] == "COMPLETED" and root["payload"]["task_id"] == "task_root"
    assert root["payload"]["output_summary"] == "2 of 3 transcribed, 1 failed"


def test_a_phase_announced_and_replaced_makes_no_task(monkeypatch, recorder, videos):
    """upgrade_cache announces "align" before it extracts, and a kept sound reports no extraction."""

    def transcribe_one(video, request, export_path, hf_token, on_progress):
        on_progress("align", 0.0, "Checking the transcript against the sound…")
        on_progress("extract", 0.0, "Extracting the sound…")
        on_progress("align", 0.0, "Finding the transcript's language")
        on_progress("align", 0.4, "Listening for speech… 80%")
        on_progress("align", 1.0, "Checked against the sound")
        return {
            "path": video,
            "fromCache": True,
            "speakers": ["Speaker 1"],
            "segmentCount": 3,
            "warnings": [],
        }

    monkeypatch.setattr(commands, "transcribe_one", transcribe_one)
    monkeypatch.setattr(commands.shutil, "which", lambda _: "/usr/bin/ffmpeg")
    monkeypatch.setattr(commands, "model_is_downloaded", lambda _: True)
    envelopes = traced_run(monkeypatch, recorder, videos[:1])
    labels = [e["payload"]["task_label"] for e in envelopes if e["event_type"] == "SPAWN"]
    assert labels == ["Transcribe", "Check against the sound: interview.mov"]


def test_a_stopped_transcription_fails_its_running_task_and_root(
    monkeypatch, recorder, videos, fake_pipeline
):
    def transcribe_one(video, request, export_path, hf_token, on_progress):
        on_progress("transcribe", 0.2, "Transcribing… 20%")
        raise commands.Cancelled()

    monkeypatch.setattr(commands, "transcribe_one", transcribe_one)
    envelopes = traced_run(monkeypatch, recorder, videos[:1])
    failed = [e["payload"] for e in envelopes if e["event_type"] == "FAILED"]
    assert [f["error_code"] for f in failed] == ["TASK_CANCELLED", "TASK_CANCELLED"]
    assert failed[-1]["task_id"] == "task_root"
    assert not any(
        e["event_type"] == "COMPLETED" and e["payload"]["task_id"] == "task_root" for e in envelopes
    )


def test_without_telemetry_a_transcription_writes_no_trace(
    monkeypatch, recorder, videos, fake_pipeline, tmp_path
):
    monkeypatch.delenv("VIBECUT_TELEMETRY", raising=False)
    monkeypatch.setenv("VIBECUT_APP_DATA_DIR", str(tmp_path / "app"))
    reset_bus()
    commands.run_transcribe(request_for(videos[:1]), recorder.emitter, CancelFlag())
    assert not (tmp_path / "app").exists()
    reset_bus()


def test_with_telemetry_a_transcription_journals_its_own_trace(
    monkeypatch, recorder, videos, fake_pipeline, tmp_path
):
    monkeypatch.setenv("VIBECUT_TELEMETRY", "1")
    monkeypatch.setenv("VIBECUT_APP_DATA_DIR", str(tmp_path / "app"))
    reset_bus()
    commands.run_transcribe(request_for(videos[:1], background=True), recorder.emitter, CancelFlag())
    get_bus().stop_thread()
    [journal] = (tmp_path / "app" / "telemetry").iterdir()
    assert journal.name.startswith("trc_trn_")
    text = journal.read_text("utf-8")
    assert "Background transcription: 1 file" in text
    lines = text.splitlines()
    assert '"task_root"' in lines[-1] and '"COMPLETED"' in lines[-1]
    reset_bus()
