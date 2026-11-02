"""The telemetry bus (telemetry/bus.py): tiers, coalescing, the journal, the mock run, and staying off."""

from __future__ import annotations

import asyncio
import importlib.util
import json
import threading
import time
from pathlib import Path
from typing import Any

import pytest

from vibecut_agent.telemetry import bus as bus_module
from vibecut_agent.telemetry import instrument, mock_emitter
from vibecut_agent.telemetry.bus import (
    CRITICAL_EVENTS,
    EVENT_TYPES,
    SUBAGENT_TYPES,
    TelemetryBus,
    frames_of,
    get_bus,
    reset_bus,
    validate_envelope,
)

REPO = Path(__file__).resolve().parents[2]
FIXTURE = REPO / "packages" / "contracts" / "fixtures" / "mock_trace.jsonl"


def progress_payload(task: str, done: int, total: int = 1000) -> dict[str, Any]:
    return {
        "kind": "BATCH_PROGRESS",
        "task_id": task,
        "phase": "vision",
        "completed_items": done,
        "total_items": total,
        "fraction": done / total,
        "eta_seconds": None,
        "throughput_items_per_sec": 0.0,
        "current_item_label": None,
        "coalesced_event_count": 1,
    }


def chunk(task: str, text: str, tokens: int, channel: str = "THOUGHT") -> dict[str, Any]:
    return {
        "kind": "STREAM_CHUNK",
        "task_id": task,
        "stream_channel": channel,
        "delta_text": text,
        "accumulated_tokens": tokens,
    }


def spawn_payload(task: str) -> dict[str, Any]:
    return {
        "kind": "SPAWN",
        "task_id": task,
        "task_label": "Tag shots",
        "model_id": "qwen3-vl:8b-instruct",
        "hardware_backend": "METAL_MPS",
        "upstream_task_ids": [],
        "input_summary": "a.mov",
        "expected_timeout_ms": 60000,
    }


def emit(bus: TelemetryBus, event_type: str, payload: dict[str, Any], trace: str = "trc_test") -> None:
    bus.emit_nowait(
        trace_id=trace,
        agent_id="worker.vlm",
        subagent_type="VISION_TAGGER",
        event_type=event_type,
        payload=payload,
        parent_task_id="task_root",
    )


@pytest.fixture(autouse=True)
def fresh_bus() -> Any:
    reset_bus()
    yield
    reset_bus()


# ------------------------------------------------------------------------------ the envelope


def test_envelopes_fit_the_contract_and_are_numbered_per_trace() -> None:
    bus = TelemetryBus()
    emit(bus, "SPAWN", spawn_payload("task_a"))
    emit(bus, "SPAWN", spawn_payload("task_b"), trace="trc_other")
    emit(bus, "BATCH_PROGRESS", progress_payload("task_a", 1))
    envelopes = bus.flush()
    assert [validate_envelope(e) for e in envelopes] == [[], [], []]
    assert [(e["trace_id"], e["seq_id"]) for e in envelopes] == [
        ("trc_test", 1),
        ("trc_other", 1),
        ("trc_test", 2),
    ]
    assert envelopes[0]["schema_version"] == "vibecut.telemetry.v1"
    assert envelopes[0]["event_id"].startswith("evt_")
    assert envelopes[0]["parent_task_id"] == "task_root"


def test_validate_envelope_names_what_is_wrong() -> None:
    bus = TelemetryBus()
    emit(bus, "SPAWN", spawn_payload("task_a"))
    [good] = bus.flush()
    bad = {**good, "subagent_type": "INTERN", "payload": {**good["payload"], "kind": "FAILED"}}
    del bad["payload"]["task_label"]
    problems = validate_envelope(bad)
    assert "subagent_type" in problems
    assert "payload.kind must match event_type" in problems
    assert "payload.task_label" in problems
    assert validate_envelope("nope") == ["the envelope isn't an object"]


# ------------------------------------------------------------------------------ coalescing and tiers


def test_a_thousand_progress_callbacks_become_at_most_two_envelopes() -> None:
    bus = TelemetryBus()
    for done in range(1, 1001):
        emit(bus, "BATCH_PROGRESS", progress_payload("task_a", done))
    envelopes = bus.flush()
    assert len(envelopes) <= 2
    last = envelopes[-1]["payload"]
    assert last["completed_items"] == 1000
    assert sum(e["payload"]["coalesced_event_count"] for e in envelopes) == 1000


def test_progress_of_different_tasks_is_kept_apart() -> None:
    bus = TelemetryBus()
    for done in range(1, 11):
        emit(bus, "BATCH_PROGRESS", progress_payload("task_a", done))
        emit(bus, "BATCH_PROGRESS", progress_payload("task_b", done))
    envelopes = bus.flush()
    assert sorted(e["payload"]["task_id"] for e in envelopes) == ["task_a", "task_b"]


def test_stream_chunks_of_a_channel_are_joined() -> None:
    bus = TelemetryBus()
    emit(bus, "STREAM_CHUNK", chunk("task_a", "Matching the bite ", 4))
    emit(bus, "STREAM_CHUNK", chunk("task_a", "with the drone shot", 9))
    emit(bus, "STREAM_CHUNK", chunk("task_a", "Done.", 2, channel="ASSISTANT_TEXT"))
    envelopes = bus.flush()
    thoughts = [e["payload"] for e in envelopes if e["payload"]["stream_channel"] == "THOUGHT"]
    assert thoughts == [chunk("task_a", "Matching the bite with the drone shot", 9)]
    assert len(envelopes) == 2


def test_critical_events_are_never_dropped_and_drops_are_counted() -> None:
    bus = TelemetryBus(max_stream_ring=8)
    for i in range(500):
        emit(bus, "SPAWN", spawn_payload(f"task_{i}"))
    for i in range(20):
        emit(bus, "STREAM_CHUNK", chunk(f"task_{i}", "x", i))
    envelopes = bus.flush()
    assert sum(1 for e in envelopes if e["event_type"] == "SPAWN") == 500
    assert sum(1 for e in envelopes if e["event_type"] == "STREAM_CHUNK") == 8
    assert bus.dropped_debug_events == 12
    assert {"SPAWN", "COMPLETED", "FAILED", "MUTATION_EMITTED"} <= CRITICAL_EVENTS


def test_envelopes_keep_emission_order() -> None:
    bus = TelemetryBus()
    emit(bus, "SPAWN", spawn_payload("task_a"))
    emit(bus, "BATCH_PROGRESS", progress_payload("task_a", 1))
    emit(
        bus,
        "COMPLETED",
        {"kind": "COMPLETED", "task_id": "task_a", "latency_ms": 1, "ttfb_ms": None, "output_summary": "ok"},
    )
    assert [e["event_type"] for e in bus.flush()] == ["SPAWN", "BATCH_PROGRESS", "COMPLETED"]


def test_frames_carry_at_most_128_events_of_one_trace() -> None:
    bus = TelemetryBus()
    for i in range(300):
        emit(bus, "SPAWN", spawn_payload(f"task_{i}"))
    emit(bus, "SPAWN", spawn_payload("task_x"), trace="trc_other")
    frames = [json.loads(f) for f in frames_of(bus.flush())]
    assert [(f["trace_id"], len(f["events"])) for f in frames] == [
        ("trc_test", 128),
        ("trc_test", 128),
        ("trc_test", 44),
        ("trc_other", 1),
    ]
    assert all(f["type"] == "TELEMETRY_BATCH" for f in frames)


# ------------------------------------------------------------------------------ the journal


def test_each_trace_is_journaled_to_its_own_file(tmp_path: Path) -> None:
    bus = TelemetryBus(tmp_path)
    emit(bus, "SPAWN", spawn_payload("task_a"))
    emit(bus, "SPAWN", spawn_payload("task_b"), trace="trc/../evil")
    bus.flush()
    emit(bus, "SPAWN", spawn_payload("task_c"))
    bus.flush()
    lines = (tmp_path / "trc_test.jsonl").read_text("utf-8").splitlines()
    assert [json.loads(line)["seq_id"] for line in lines] == [1, 2]
    # A trace id is only ever a plain file name.
    assert sorted(p.name for p in tmp_path.iterdir()) == ["trc_test.jsonl", "trcevil.jsonl"]


def test_a_journal_that_cant_be_written_loses_only_the_journal(tmp_path: Path) -> None:
    blocker = tmp_path / "file"
    blocker.write_text("")
    bus = TelemetryBus(blocker / "telemetry")
    seen: list[int] = []
    bus.add_listener(lambda envelopes: seen.extend(e["seq_id"] for e in envelopes))
    emit(bus, "SPAWN", spawn_payload("task_a"))
    assert len(bus.flush()) == 1
    assert seen == [1]


def test_the_flush_thread_journals_and_stops_cleanly(tmp_path: Path) -> None:
    bus = TelemetryBus(tmp_path, flush_interval_sec=0.01)
    bus.start_thread()
    emit(bus, "SPAWN", spawn_payload("task_a"))
    deadline = time.monotonic() + 5
    path = tmp_path / "trc_test.jsonl"
    while not path.exists() and time.monotonic() < deadline:
        time.sleep(0.01)
    assert path.exists()
    emit(bus, "SPAWN", spawn_payload("task_b"))
    bus.stop_thread()
    assert len(path.read_text("utf-8").splitlines()) == 2


def test_emitting_from_many_threads_loses_nothing() -> None:
    bus = TelemetryBus()

    def worker(n: int) -> None:
        for i in range(200):
            emit(bus, "SPAWN", spawn_payload(f"task_{n}_{i}"))

    threads = [threading.Thread(target=worker, args=(n,)) for n in range(4)]
    for thread in threads:
        thread.start()
    collected = []
    while any(t.is_alive() for t in threads):
        collected += bus.flush()
    for thread in threads:
        thread.join()
    collected += bus.flush()
    assert len(collected) == 800
    assert [e["seq_id"] for e in collected] == list(range(1, 801))


def test_the_asyncio_flush_reaches_subscribers() -> None:
    async def scenario() -> list[dict[str, Any]]:
        bus = TelemetryBus(flush_interval_sec=0.01)
        queue = bus.subscribe()
        await bus.start()
        emit(bus, "SPAWN", spawn_payload("task_a"))
        frame = await asyncio.wait_for(queue.get(), timeout=5)
        await bus.stop()
        return [json.loads(frame)]

    [frame] = asyncio.run(scenario())
    assert frame["type"] == "TELEMETRY_BATCH"
    assert frame["events"][0]["payload"]["task_id"] == "task_a"


def test_a_heartbeat_measures_this_process() -> None:
    bus = TelemetryBus()
    sample = bus.resource_sample()
    assert sample["kind"] == "RESOURCE_HEARTBEAT"
    assert 0 <= sample["host_cpu_percent"] <= 100
    assert sample["sidecar_rss_mb"] > 0
    assert sample["unified_memory_total_gb"] > 0
    assert sample["gpu_lock_holder"] is None
    bus.emit_heartbeat("trc_test")
    [envelope] = bus.flush()
    assert validate_envelope(envelope) == []


def test_heartbeats_go_only_to_a_recently_active_trace(monkeypatch: pytest.MonkeyPatch) -> None:
    clock = [1000.0]
    monkeypatch.setattr(time, "monotonic", lambda: clock[0])
    bus = TelemetryBus()
    assert bus.active_trace() is None
    emit(bus, "SPAWN", spawn_payload("task_a"), trace="trc_old")
    clock[0] += 1
    emit(bus, "SPAWN", spawn_payload("task_b"), trace="trc_new")
    bus.emit_heartbeat("trc_new")
    assert bus.active_trace() == "trc_new"
    clock[0] += bus_module.HEARTBEAT_ACTIVE_SECONDS + 1
    assert bus.active_trace() is None


def test_the_gpu_lock_holder_is_read_from_the_lock_file(tmp_path: Path) -> None:
    lock = tmp_path / ".gpu.lock"
    lock.write_text("4242\n")
    assert bus_module.gpu_lock_holder(lock) == "pid:4242"
    lock.write_text("")
    assert bus_module.gpu_lock_holder(lock) is None
    assert bus_module.gpu_lock_holder(tmp_path / "missing") is None


# ------------------------------------------------------------------------------ cost


def test_a_thousand_emits_take_under_two_milliseconds() -> None:
    payload = progress_payload("task_a", 1)
    best = float("inf")
    # Best of 5 (PLAN.md, "Phase 22", V12): one slow run under full-suite load isn't the bus.
    for _ in range(5):
        bus = TelemetryBus()
        began = time.perf_counter()
        for _ in range(1000):
            bus.emit_nowait(
                trace_id="trc_test",
                agent_id="worker.vlm",
                subagent_type="VISION_TAGGER",
                event_type="BATCH_PROGRESS",
                payload=payload,
            )
        best = min(best, time.perf_counter() - began)
    assert best < 0.002, f"1,000 emits took {best * 1000:.2f} ms"


# ------------------------------------------------------------------------------ on and off


def test_the_process_bus_is_off_unless_asked_for(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    monkeypatch.delenv("VIBECUT_TELEMETRY", raising=False)
    monkeypatch.setenv("VIBECUT_APP_DATA_DIR", str(tmp_path))
    bus = get_bus()
    assert not bus.enabled
    emit(bus, "SPAWN", spawn_payload("task_a"))
    assert bus.flush() == []
    assert instrument.for_process("mcp", "job") is None
    assert not (tmp_path / "telemetry").exists()


def test_the_process_bus_journals_to_the_apps_data_folder(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    monkeypatch.setenv("VIBECUT_TELEMETRY", "1")
    monkeypatch.setenv("VIBECUT_APP_DATA_DIR", str(tmp_path))
    trace = instrument.for_process("mcp", "job_42")
    assert trace is not None
    assert trace.trace_id.startswith("trc_mcp_job-42_")
    trace.ensure_root()
    trace.bus.stop_thread()
    [journal] = (tmp_path / "telemetry").iterdir()
    assert journal.name == f"{trace.trace_id}.jsonl"
    assert json.loads(journal.read_text("utf-8"))["event_type"] == "SPAWN"


def test_without_the_apps_folder_it_sits_beside_the_index(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    monkeypatch.delenv("VIBECUT_APP_DATA_DIR", raising=False)
    monkeypatch.setenv("VIBECUT_INDEX_DIR", str(tmp_path / "vector-index"))
    assert bus_module.telemetry_dir() == tmp_path / "telemetry"


# ------------------------------------------------------------------------------ the mock run and the contracts


def test_the_mock_run_covers_every_role_and_event_and_fits_the_contract() -> None:
    envelopes = mock_emitter.generate()
    assert {e["subagent_type"] for e in envelopes} == set(SUBAGENT_TYPES)
    assert {e["event_type"] for e in envelopes} == set(EVENT_TYPES)
    assert [validate_envelope(e) for e in envelopes if validate_envelope(e)] == []
    assert [e["seq_id"] for e in envelopes] == list(range(1, len(envelopes) + 1))
    stages = [e["payload"]["mutation_stage"] for e in envelopes if e["event_type"] == "MUTATION_EMITTED"]
    assert stages == ["PROPOSED", "VALIDATED", "COMMITTED"]


def test_the_contracts_fixture_is_the_mock_runs_output() -> None:
    """packages/contracts/fixtures/mock_trace.jsonl is what the visualizer's Zod tests parse; regenerate it
    with `python -m vibecut_agent.telemetry.mock_emitter --out packages/contracts/fixtures` (then rename)
    when the mock run changes."""
    expected = [json.loads(line) for line in FIXTURE.read_text("utf-8").splitlines()]
    assert mock_emitter.generate() == expected


def test_the_mock_run_can_be_written_as_it_happens(tmp_path: Path) -> None:
    path = mock_emitter.write_realtime(tmp_path, "trc_mock_live", speed=200.0)
    lines = path.read_text("utf-8").splitlines()
    assert len(lines) == len(mock_emitter.generate())


def test_packages_contracts_re_exports_the_bus() -> None:
    spec = importlib.util.spec_from_file_location(
        "vibecut_contracts_telemetry", REPO / "packages" / "contracts" / "telemetry.py"
    )
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    assert module.TelemetryBus is TelemetryBus
    assert module.validate_envelope is validate_envelope
    assert set(module.__all__) <= set(dir(module))
