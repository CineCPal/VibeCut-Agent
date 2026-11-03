"""Claude's side of an orchestrated turn: the chat's notes and the shim's follower (telemetry/notes.py)."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest

from vibecut_agent.telemetry import notes as notes_module
from vibecut_agent.telemetry.bus import TelemetryBus, validate_envelope
from vibecut_agent.telemetry.instrument import TraceEmitter
from vibecut_agent.telemetry.notes import NotesFollower, NotesWriter, notes_path


def stream(inner: dict[str, Any]) -> dict[str, Any]:
    return {"type": "stream_event", "event": inner}


def delta(kind: str, field: str, text: str) -> dict[str, Any]:
    return stream({"type": "content_block_delta", "delta": {"type": kind, field: text}})


def call(input_tokens: int, cached: int, created: int = 0) -> dict[str, Any]:
    usage = {
        "input_tokens": input_tokens,
        "cache_read_input_tokens": cached,
        "cache_creation_input_tokens": created,
        "output_tokens": 1,
    }
    return stream({"type": "message_start", "message": {"usage": usage}})


def wrote(output: int) -> dict[str, Any]:
    return stream({"type": "message_delta", "usage": {"output_tokens": output}})


def lines(path: Path) -> list[dict[str, Any]]:
    return [json.loads(line) for line in path.read_text("utf-8").splitlines()]


def test_the_writer_notes_thinking_the_reply_and_the_turns_running_totals(tmp_path: Path) -> None:
    path = tmp_path / "notes" / "job-7.jsonl"
    path.parent.mkdir()
    path.write_text('{"thought": "last turn"}\n')
    writer = NotesWriter(path)
    for event in [
        call(100, 30, 20),
        delta("thinking_delta", "thinking", "Cut the pause"),
        delta("text_delta", "text", "Done."),
        delta("input_json_delta", "partial_json", "{}"),
        wrote(25),
        wrote(40),
        call(10, 150),
        wrote(5),
    ]:
        writer.stream_event(event)
    writer.close()
    assert lines(path) == [
        {"usage": {"input": 150, "output": 1, "cached": 30}},
        {"thought": "Cut the pause"},
        {"text": "Done."},
        {"usage": {"input": 150, "output": 25, "cached": 30}},
        {"usage": {"input": 150, "output": 40, "cached": 30}},
        {"usage": {"input": 310, "output": 41, "cached": 180}},
        {"usage": {"input": 310, "output": 45, "cached": 180}},
    ]


def test_only_an_orchestrated_turn_with_telemetry_on_writes_notes(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("VIBECUT_APP_DATA_DIR", str(tmp_path))
    monkeypatch.setenv("VIBECUT_TELEMETRY", "1")
    assert NotesWriter.for_turn({"jobId": "job-7"}) is None
    writer = NotesWriter.for_turn({"jobId": "job_7", "orchestrated": True})
    assert writer is not None
    writer.close()
    assert notes_path("job_7") == tmp_path / "telemetry" / "notes" / "job-7.jsonl"
    monkeypatch.setenv("VIBECUT_TELEMETRY", "0")
    assert NotesWriter.for_turn({"jobId": "job-7", "orchestrated": True}) is None


def test_the_follower_puts_claudes_side_on_the_root_task(tmp_path: Path) -> None:
    path = tmp_path / "job-7.jsonl"
    path.write_text('{"thought": "the last turn"}\n')
    emitter = TraceEmitter(TelemetryBus(), "trc_mcp_job-7_a1b2c3")
    envelopes: list[dict[str, Any]] = []
    emitter.bus.add_listener(envelopes.extend)  # finish() flushes the bus itself
    # A shim started ahead of its turn reads from where the file ended; the turn's writer empties it.
    follower = NotesFollower(path, emitter, notes_module.file_position(path))
    follower.poll()
    emitter.bus.flush()
    assert envelopes == []
    writer = NotesWriter(path)
    writer.stream_event(call(100, 0))
    writer.stream_event(delta("thinking_delta", "thinking", "Trim the "))
    writer.stream_event(delta("thinking_delta", "thinking", "intro"))
    writer.stream_event(wrote(30))
    writer.stream_event(delta("text_delta", "text", "Trimmed."))
    follower.poll()
    emitter.tool_call("semantic_asset_search", {"query": "x"}, lambda: {"hits": []})
    with path.open("a") as f:
        f.write('{"usage": {"input": 100, "output": 42, "cached": 0}}\n{"thou')
    follower.stop()
    emitter.finish()
    assert [e for e in envelopes if validate_envelope(e)] == []
    root = [e for e in envelopes if e["payload"].get("task_id") == "task_root"]
    assert root[0]["event_type"] == "SPAWN"
    chunks = [e["payload"] for e in root if e["event_type"] == "STREAM_CHUNK"]
    assert [(c["stream_channel"], c["delta_text"]) for c in chunks] == [
        ("THOUGHT", "Trim the intro"),
        ("ASSISTANT_TEXT", "Trimmed."),
    ]
    assert chunks[-1]["accumulated_tokens"] == 30
    done = next(e["payload"] for e in root if e["event_type"] == "COMPLETED")
    assert (done["input_tokens"], done["output_tokens"], done["cached_tokens"]) == (100, 42, 0)
    # A note after the root is done never spawns it again.
    seen = len(envelopes)
    emitter.root_chunk("THOUGHT", "late", 42)
    emitter.bus.flush()
    assert len(envelopes) == seen
