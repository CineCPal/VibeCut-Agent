"""A 100,000-row trace for checking the visualizer's log at scale (PLAN.md, "Phase 22", "The log at 100k rows").

A long ingest-like run: a root task and `tasks` workers spread over the six worker roles, each chained to
the one before on its role. Each worker spawns, makes tool calls, sometimes waits on the GPU lock (WARN),
and completes, until the trace holds `rows` envelopes. The task count stays realistic, so the DAG and
studio stay readable and the check is of the log.

Every row is a Tier-0 event (SPAWN, TOOL_INVOCATION, WAITING_UPSTREAM, COMPLETED), which the bus never
drops and the snapshot never folds. So the visualizer shows all `rows` rows whether it watches the run
live or opens it afterwards from the snapshot. `generate()` is deterministic: a fixed clock, event ids and
tool names.

    python -m vibecut_agent.telemetry.stress_emitter [--out DIR] [--rows 100000] [--tasks 200]
                                                     [--realtime --rate 5000] [--trace-id ID]

`--out` defaults to the app's telemetry folder (VIBECUT_APP_DATA_DIR's, else the installed app's), so the
Telemetry Studio's gateway picks it up. Without
`--realtime` the whole journal is written at once (the "open it afterwards" case). With it, it's
journaled at `--rate` rows a second for the gateway's tailer to stream (the "watch it live" case)."""

from __future__ import annotations

import argparse
import itertools
import json
import os
import sys
import time
from collections.abc import Iterator
from pathlib import Path
from typing import Any

from vibecut_agent.telemetry.bus import Envelope, TelemetryBus, telemetry_dir

# The installed app's data folder (tauri.conf.json's identifier), where its Telemetry Studio's gateway reads.
APP_TELEMETRY = Path.home() / "Library" / "Application Support" / "com.cj.vibecutagent" / "telemetry"

DEFAULT_TRACE_ID = "trc_stress_0001"
DEFAULT_ROWS = 100_000
DEFAULT_TASKS = 200
DEFAULT_RATE = 5_000
# 2026-11-03 09:00:00 UTC.
EPOCH_MS = 1_793_782_800_000
# The run's spacing on its fixed clock: one row every 2 ms (100k rows is 200 s of run).
ROW_MS = 2

ROOT = "task_root_001"
ORCH = ("orchestrator.supervisor", "MASTER_ORCHESTRATOR")
ROLES = [
    (
        "worker.whisper.01",
        "INGEST_TRANSCRIBE",
        "transcribe_and_align",
        True,
        "mlx-community/whisper-large-v3-turbo",
    ),
    ("worker.vlm.01", "VISION_TAGGER", "analyze_shot_visuals", True, "qwen3-vl:8b-instruct"),
    ("worker.vector.01", "BROLL_RETRIEVER", "semantic_asset_search", False, "nomic-embed-text"),
    ("worker.audio_sync.01", "AUDIO_ENGINEER", "detect_media_boundaries", False, "ffmpeg"),
    ("worker.otio_cutter.01", "PACING_CUTTER", "propose_otio_delta", False, "deterministic"),
    ("worker.color_nle.01", "COLOR_GRADER", "get_clip_color", False, "deterministic"),
]


def _media(index: int) -> str:
    return f"/Volumes/Media/Stress/Reel_{index // 40:03d}/C{index:05d}.mov"


def _rows(rows: int, tasks: int) -> Iterator[tuple[tuple[str, str], str, dict[str, Any], str | None, str]]:
    """(agent, event type, payload, parent, severity), `rows` of them."""
    tasks = max(1, min(tasks, (rows - 2) // 3))
    yield (
        ORCH,
        "SPAWN",
        {
            "task_id": ROOT,
            "task_label": f"Stress run: {rows:,} rows",
            "model_id": "claude-code",
            "hardware_backend": "CLOUD_API",
            "upstream_task_ids": [],
            "input_summary": f"{tasks} workers",
            "expected_timeout_ms": 3_600_000,
        },
        None,
        "INFO",
    )
    # Rows left for the workers' tool calls once each has its SPAWN and COMPLETED, and the root its COMPLETED.
    calls = rows - 2 - 2 * tasks
    last_of_role: dict[str, str] = {}
    for n in range(tasks):
        agent_id, subagent, tool_name, gpu, model = ROLES[n % len(ROLES)]
        task_id = f"task_{subagent.lower()}_{n + 1:04d}"
        upstream = [last_of_role[subagent]] if subagent in last_of_role else []
        last_of_role[subagent] = task_id
        agent = (agent_id, subagent)
        yield (
            agent,
            "SPAWN",
            {
                "task_id": task_id,
                "task_label": f"{tool_name} #{n + 1}",
                "model_id": model,
                "hardware_backend": "METAL_MPS" if gpu else "CPU_NEON",
                "upstream_task_ids": upstream,
                "input_summary": _media(n),
                "expected_timeout_ms": 60_000,
            },
            ROOT,
            "INFO",
        )
        mine = calls // tasks + (1 if n < calls % tasks else 0)
        for k in range(mine):
            media = _media(n * 7 + k)
            if gpu and k % 25 == 24:
                yield (
                    agent,
                    "WAITING_UPSTREAM",
                    {
                        "task_id": task_id,
                        "wait_reason": "GPU_METAL_LOCK",
                        "blocking_task_ids": [],
                        "lock_holder_agent_id": ROLES[(n + 1) % 2][0],
                        "queue_depth": 1 + k % 3,
                        "estimated_wait_ms": 400.0,
                    },
                    ROOT,
                    "WARN",
                )
                continue
            yield (
                agent,
                "TOOL_INVOCATION",
                {
                    "task_id": task_id,
                    "tool_call_id": f"call_{task_id}_{k + 1:04d}",
                    "tool_name": tool_name,
                    "target_subagent": subagent,
                    "arguments": {"media_path": media, "chunk": k + 1},
                    "requires_gpu_lock": gpu,
                    "media_paths": [media],
                },
                ROOT,
                "DEBUG" if k % 4 else "INFO",
            )
        yield (agent, "COMPLETED", _completed(task_id, 40.0 * mine, f"{mine} calls"), ROOT, "INFO")
    yield (ORCH, "COMPLETED", _completed(ROOT, float(rows * ROW_MS), f"{tasks} workers"), ROOT, "INFO")


def _completed(task_id: str, latency_ms: float, summary: str) -> dict[str, Any]:
    return {
        "task_id": task_id,
        "latency_ms": latency_ms,
        "ttfb_ms": 12.0,
        "input_tokens": 0,
        "output_tokens": 0,
        "cached_tokens": 0,
        "cost_usd": 0.0,
        "peak_memory_mb": 0.0,
        "output_summary": summary,
        "artifacts": [],
    }


def _bus(journal: Path | None, now: dict[str, int], epoch_ms: int) -> TelemetryBus:
    counter = itertools.count(1)
    ids = itertools.count(1)
    return TelemetryBus(
        journal,
        clock=lambda: (epoch_ms + now["ms"]) / 1000.0,
        monotonic_clock=lambda: now["ms"] * 1_000_000 + next(counter),
        event_ids=lambda: f"evt_stress_{next(ids):07d}",
    )


def _emit(
    bus: TelemetryBus, trace_id: str, row: tuple[tuple[str, str], str, dict[str, Any], str | None, str]
) -> None:
    agent, event_type, payload, parent, severity = row
    bus.emit_nowait(
        trace_id=trace_id,
        agent_id=agent[0],
        subagent_type=agent[1],
        event_type=event_type,
        payload={"kind": event_type, **payload},
        parent_task_id=parent,
        severity=severity,
    )


def generate(
    trace_id: str = DEFAULT_TRACE_ID,
    rows: int = DEFAULT_ROWS,
    tasks: int = DEFAULT_TASKS,
    epoch_ms: int = EPOCH_MS,
) -> list[Envelope]:
    """The whole run as `rows` envelopes, the same every time."""
    now = {"ms": 0}
    bus = _bus(None, now, epoch_ms)
    envelopes: list[Envelope] = []
    for index, row in enumerate(_rows(rows, tasks)):
        now["ms"] = index * ROW_MS
        _emit(bus, trace_id, row)
        if index % 1000 == 999:
            envelopes += bus.flush()
    return envelopes + bus.flush()


def write_journal(
    out_dir: Path, trace_id: str = DEFAULT_TRACE_ID, rows: int = DEFAULT_ROWS, tasks: int = DEFAULT_TASKS
) -> Path:
    out_dir.mkdir(parents=True, exist_ok=True)
    path = out_dir / f"{trace_id}.jsonl"
    partial = path.with_name(f".{path.name}.partial")
    with partial.open("w", encoding="utf-8") as fh:
        for env in generate(trace_id, rows, tasks):
            fh.write(json.dumps(env, ensure_ascii=False) + "\n")
    partial.replace(path)
    return path


def write_realtime(
    out_dir: Path,
    trace_id: str = DEFAULT_TRACE_ID,
    rows: int = DEFAULT_ROWS,
    tasks: int = DEFAULT_TASKS,
    rate: int = DEFAULT_RATE,
) -> Path:
    """The run journaled at `rate` rows a second, flushed every 50 ms as a real run's bus would be."""
    out_dir.mkdir(parents=True, exist_ok=True)
    path = out_dir / f"{trace_id}.jsonl"
    path.unlink(missing_ok=True)
    now = {"ms": 0}
    bus = _bus(out_dir, now, int(time.time() * 1000))
    began = time.monotonic()
    per_flush = max(1, rate // 20)
    for index, row in enumerate(_rows(rows, tasks)):
        now["ms"] = int((time.monotonic() - began) * 1000)
        _emit(bus, trace_id, row)
        if index % per_flush == per_flush - 1:
            bus.flush()
            delay = (index + 1) / rate - (time.monotonic() - began)
            if delay > 0:
                time.sleep(delay)
    bus.flush()
    return path


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0] if __doc__ else None)
    parser.add_argument(
        "--out",
        type=Path,
        default=None,
        help="the folder for <trace_id>.jsonl (default: the app's telemetry folder)",
    )
    parser.add_argument("--trace-id", default=DEFAULT_TRACE_ID)
    parser.add_argument("--rows", type=int, default=DEFAULT_ROWS)
    parser.add_argument("--tasks", type=int, default=DEFAULT_TASKS)
    parser.add_argument("--realtime", action="store_true", help="journal it live, at --rate rows a second")
    parser.add_argument("--rate", type=int, default=DEFAULT_RATE)
    options = parser.parse_args(argv)
    if options.rows < 10 or options.tasks < 1 or options.rate < 1:
        parser.error("--rows must be 10 or more, and --tasks and --rate 1 or more")
    out = options.out or (
        telemetry_dir() if os.environ.get("VIBECUT_APP_DATA_DIR", "").strip() else APP_TELEMETRY
    )
    began = time.monotonic()
    if options.realtime:
        path = write_realtime(out, options.trace_id, options.rows, options.tasks, options.rate)
    else:
        path = write_journal(out, options.trace_id, options.rows, options.tasks)
    print(f"{path} ({options.rows:,} rows, {time.monotonic() - began:.1f} s)", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
