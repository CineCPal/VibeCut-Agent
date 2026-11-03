"""The telemetry bus (docs/specs/visualizer-spec.md §1, `vibecut.telemetry.v1`; PLAN.md, "Phase 22").

The runtime's agents emit lifecycle events with `emit_nowait()`. It only builds a small record and appends
it to a deque, so it is safe from any thread and never waits on disk, a socket or the GPU. A flush, every
50 ms, drains what has been emitted:

- Tier 0 (SPAWN, PLANNING, TOOL_INVOCATION, WAITING_UPSTREAM, MUTATION_EMITTED, COMPLETED, FAILED,
  CONTEXT_HANDOFF) goes to an unbounded deque and is never dropped.
- Tier 1 (STREAM_CHUNK, BATCH_PROGRESS, RESOURCE_HEARTBEAT) goes to a bounded ring; when it is full the
  oldest entry is lost and `dropped_debug_events` counts it. Within a flush, STREAM_CHUNKs of one
  (trace, task, channel) are joined, and BATCH_PROGRESS of one (trace, task) keeps only the latest, with
  `coalesced_event_count` saying how many it stands for.

Each envelope then gets the next `seq_id` of its trace, is appended to `<journal_dir>/<trace_id>.jsonl`
when there is a journal, and goes to the listeners (the gateway's trace store) and subscriber queues in
frames of at most 128 events.

There are two ways to run the flush (spec decision V2): `start()`, an asyncio task, in the gateway's
process; and `start_thread()`, a daemon thread, in the sync emitters (the MCP shim's worker thread, the
ingest command), which only journal. Either way a final `flush()` runs at exit.

Stdlib only: the sidecar's base install must not grow (`uv run --locked`)."""

from __future__ import annotations

import asyncio
import atexit
import contextlib
import json
import os
import re
import resource
import secrets
import sys
import threading
import time
from collections import deque
from collections.abc import Callable, Iterable
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Literal

SCHEMA_VERSION: Literal["vibecut.telemetry.v1"] = "vibecut.telemetry.v1"
# Set to "1" to turn telemetry on (the user's call, 2026-11-02): off, nothing is written or sent.
ENABLE_ENV = "VIBECUT_TELEMETRY"
FLUSH_INTERVAL_SECONDS = 0.050
STREAM_RING_SIZE = 4096
MAX_FRAME_EVENTS = 128
HEARTBEAT_SECONDS = 1.0
# Heartbeats go only to a trace that had other events this recently, so an idle trace stops growing.
HEARTBEAT_ACTIVE_SECONDS = 10.0

SubagentType = Literal[
    "MASTER_ORCHESTRATOR",
    "INGEST_TRANSCRIBE",
    "VISION_TAGGER",
    "BROLL_RETRIEVER",
    "PACING_CUTTER",
    "AUDIO_ENGINEER",
    "COLOR_GRADER",
]
TelemetryEventType = Literal[
    "SPAWN",
    "PLANNING",
    "TOOL_INVOCATION",
    "WAITING_UPSTREAM",
    "MUTATION_EMITTED",
    "COMPLETED",
    "FAILED",
    "STREAM_CHUNK",
    "BATCH_PROGRESS",
    "CONTEXT_HANDOFF",
    "RESOURCE_HEARTBEAT",
]
LogSeverity = Literal["DEBUG", "INFO", "MUTATION", "WARN", "ERROR"]
HardwareBackend = Literal["METAL_MPS", "ANE_COREML", "VIDEOTOOLBOX", "CPU_NEON", "CLOUD_API", "NLE_IPC"]

SUBAGENT_TYPES: tuple[str, ...] = (
    "MASTER_ORCHESTRATOR",
    "INGEST_TRANSCRIBE",
    "VISION_TAGGER",
    "BROLL_RETRIEVER",
    "PACING_CUTTER",
    "AUDIO_ENGINEER",
    "COLOR_GRADER",
)
EVENT_TYPES: tuple[str, ...] = (
    "SPAWN",
    "PLANNING",
    "TOOL_INVOCATION",
    "WAITING_UPSTREAM",
    "MUTATION_EMITTED",
    "COMPLETED",
    "FAILED",
    "STREAM_CHUNK",
    "BATCH_PROGRESS",
    "CONTEXT_HANDOFF",
    "RESOURCE_HEARTBEAT",
)
SEVERITIES: tuple[str, ...] = ("DEBUG", "INFO", "MUTATION", "WARN", "ERROR")
HARDWARE_BACKENDS: tuple[str, ...] = (
    "METAL_MPS",
    "ANE_COREML",
    "VIDEOTOOLBOX",
    "CPU_NEON",
    "CLOUD_API",
    "NLE_IPC",
)
SUPPORTED_RATES: tuple[float, ...] = (23.976, 24.0, 25.0, 29.97, 30.0, 50.0, 59.94, 60.0)

CRITICAL_EVENTS: frozenset[str] = frozenset(
    {
        "SPAWN",
        "PLANNING",
        "TOOL_INVOCATION",
        "WAITING_UPSTREAM",
        "MUTATION_EMITTED",
        "COMPLETED",
        "FAILED",
        "CONTEXT_HANDOFF",
    }
)

# Each payload's required keys (telemetry.ts in packages/contracts holds the full Zod schema; this is the
# stdlib check the Python side can make).
PAYLOAD_KEYS: dict[str, tuple[str, ...]] = {
    "SPAWN": ("task_id", "task_label", "model_id", "hardware_backend", "upstream_task_ids", "input_summary"),
    "PLANNING": ("task_id", "planning_phase", "thought_summary"),
    "TOOL_INVOCATION": ("task_id", "tool_call_id", "tool_name", "target_subagent", "arguments"),
    "WAITING_UPSTREAM": ("task_id", "wait_reason", "blocking_task_ids"),
    "MUTATION_EMITTED": (
        "task_id",
        "delta_id",
        "mutation_stage",
        "validation_token",
        "target_host",
        "target_timeline",
        "timeline_fps",
        "narrative_rationale",
        "operations",
    ),
    "COMPLETED": ("task_id", "latency_ms", "ttfb_ms", "output_summary"),
    "FAILED": ("task_id", "error_code", "error_message", "recoverable"),
    "STREAM_CHUNK": ("task_id", "stream_channel", "delta_text", "accumulated_tokens"),
    "BATCH_PROGRESS": (
        "task_id",
        "phase",
        "completed_items",
        "total_items",
        "fraction",
        "eta_seconds",
        "throughput_items_per_sec",
        "current_item_label",
        "coalesced_event_count",
    ),
    "CONTEXT_HANDOFF": (
        "from_task_id",
        "to_task_id",
        "from_agent_id",
        "to_agent_id",
        "from_subagent",
        "to_subagent",
        "packet_type",
        "payload_bytes",
        "summary",
    ),
    "RESOURCE_HEARTBEAT": (
        "host_cpu_percent",
        "sidecar_rss_mb",
        "unified_memory_used_gb",
        "unified_memory_total_gb",
        "gpu_lock_holder",
        "active_workers",
        "dropped_debug_events",
        "nle_connected",
    ),
}
PAYLOAD_ENUMS: dict[str, dict[str, tuple[str, ...]]] = {
    "SPAWN": {"hardware_backend": HARDWARE_BACKENDS},
    "PLANNING": {
        "planning_phase": (
            "INTENT_DECOMPOSITION",
            "ASSET_QUERY_FORMULATION",
            "ROUGH_CUT_STRUCTURING",
            "PACING_REFINEMENT",
            "PREFLIGHT_VERIFICATION",
        )
    },
    "WAITING_UPSTREAM": {
        "wait_reason": (
            "DEPENDENCY_TASKS",
            "GPU_METAL_LOCK",
            "NLE_BRIDGE_LOCK",
            "RATE_LIMIT_BACKOFF",
            "USER_CONFIRMATION",
        )
    },
    "MUTATION_EMITTED": {
        "mutation_stage": ("PROPOSED", "VALIDATED", "COMMITTED", "ROLLED_BACK"),
        "target_host": ("premiere", "resolve"),
    },
    "FAILED": {
        "error_code": (
            "SCHEMA_VALIDATION_FAILED",
            "TIMELINE_OVERLAP_COLLISION",
            "STALE_TIMELINE_HASH",
            "MEDIA_OFFLINE",
            "NLE_BRIDGE_TIMEOUT",
            "NLE_ROLLBACK_EXECUTED",
            "LOCAL_MODEL_UNAVAILABLE",
            "GPU_OOM_CIRCUIT_BREAKER",
            "UPSTREAM_PROVIDER_ERROR",
            "TASK_CANCELLED",
        )
    },
    "STREAM_CHUNK": {"stream_channel": ("THOUGHT", "ASSISTANT_TEXT", "TOOL_STDOUT")},
    "CONTEXT_HANDOFF": {
        "from_subagent": SUBAGENT_TYPES,
        "to_subagent": SUBAGENT_TYPES,
        "packet_type": (
            "PROMPT_TOKENS",
            "CLIP_MANIFEST",
            "TRANSCRIPT_SLICES",
            "VLM_TAGS",
            "OTIO_DELTA",
            "VALIDATION_TOKEN",
            "NLE_COMMIT_BATCH",
        ),
    },
}
DELTA_OP_TYPES: tuple[str, ...] = (
    "INSERT_CLIP",
    "OVERWRITE_CLIP",
    "TRIM_CLIP",
    "SPLIT_CLIP",
    "DELETE_CLIP",
    "MOVE_CLIP",
    "INSERT_GAP",
    "APPLY_TRANSITION",
    "SET_AUDIO_GAIN",
    "DUCK_REGION",
)

Envelope = dict[str, Any]
Listener = Callable[[list[Envelope]], None]


def new_event_id() -> str:
    """`evt_` + the time in ns as hex + 4 random bytes: ordered by time, like the spec's UUIDv7 (Python
    3.13 has no `uuid.uuid7`)."""
    return f"evt_{time.time_ns():x}{secrets.token_hex(4)}"


def safe_trace_name(trace_id: str) -> str:
    """The trace's journal file name: letters, digits, `_` and `-` only."""
    return "".join(c for c in trace_id if c.isalnum() or c in "_-")[:120] or "trace"


def enabled_from_env() -> bool:
    return os.environ.get(ENABLE_ENV, "").strip() == "1"


def telemetry_dir() -> Path:
    """`<appDataDir>/telemetry`. The app passes its data folder as VIBECUT_APP_DATA_DIR (sidecar.rs,
    mcp_bridge.rs); without it, next to the vector index, as tool_bus.default_otio_dir does."""
    app_data = os.environ.get("VIBECUT_APP_DATA_DIR", "").strip()
    if app_data:
        return Path(app_data) / "telemetry"
    from vibecut_agent.config import OrchestratorConfig

    return Path(OrchestratorConfig.from_env().index_dir).parent / "telemetry"


def trace_id_for(prefix: str, key: str | None = None) -> str:
    """A trace id only this process writes (spec decision V4): `trc_<prefix>_<key>_<random>`."""
    parts = ["trc", prefix]
    if key:
        parts.append(re.sub(r"[^A-Za-z0-9-]", "-", key)[:48])
    parts.append(secrets.token_hex(3))
    return "_".join(parts)


@dataclass(slots=True)
class RawTelemetryItem:
    trace_id: str
    agent_id: str
    subagent_type: str
    parent_task_id: str | None
    severity: str
    event_type: str
    payload: dict[str, Any]
    timestamp_ms: float = field(default_factory=lambda: time.time() * 1000.0)
    monotonic_ns: int = field(default_factory=time.perf_counter_ns)


class TelemetryBus:
    """Thread-safe, never-blocking telemetry emitter with 50 ms coalescing (see the module docstring)."""

    def __init__(
        self,
        journal_dir: str | os.PathLike[str] | None = None,
        flush_interval_sec: float = FLUSH_INTERVAL_SECONDS,
        max_stream_ring: int = STREAM_RING_SIZE,
        *,
        enabled: bool = True,
        heartbeat: bool = False,
        clock: Callable[[], float] | None = None,
        monotonic_clock: Callable[[], int] | None = None,
        event_ids: Callable[[], str] | None = None,
    ) -> None:
        self.enabled = enabled
        self._journal_dir = Path(journal_dir) if journal_dir is not None else None
        self._flush_interval = flush_interval_sec
        self._critical_queue: deque[RawTelemetryItem] = deque()
        self._stream_ring: deque[RawTelemetryItem] = deque(maxlen=max_stream_ring)
        self._seq_counters: dict[str, int] = {}
        self._last_activity: dict[str, float] = {}
        self._drain_lock = threading.Lock()
        self._dropped_debug_events = 0
        self._subscribers: set[asyncio.Queue[str]] = set()
        self._listeners: list[Listener] = []
        self._heartbeat = heartbeat
        # Injected clocks (seconds since the epoch; ns) make a trace reproducible (mock_emitter.py).
        self._clock = clock
        self._monotonic_clock = monotonic_clock
        self._event_ids = event_ids or new_event_id
        self._running = False
        self._flush_task: asyncio.Task[None] | None = None
        self._thread: threading.Thread | None = None
        self._thread_stop = threading.Event()
        self._atexit_registered = False
        self._last_cpu: tuple[float, float] | None = None
        self.gpu_lock_path: Path | None = None
        self.active_workers: Callable[[], int] = lambda: len(self._subscribers)

    @property
    def flush_interval(self) -> float:
        return self._flush_interval

    @property
    def journal_dir(self) -> Path | None:
        return self._journal_dir

    @property
    def dropped_debug_events(self) -> int:
        return self._dropped_debug_events

    # Emitting.

    def emit_nowait(
        self,
        *,
        trace_id: str,
        agent_id: str,
        subagent_type: SubagentType | str,
        event_type: TelemetryEventType | str,
        payload: dict[str, Any],
        parent_task_id: str | None = None,
        severity: LogSeverity | str = "INFO",
    ) -> None:
        """O(1), never blocks, safe from worker threads and the event loop alike."""
        if not self.enabled:
            return
        if event_type != "RESOURCE_HEARTBEAT":
            self._last_activity[trace_id] = time.monotonic()
        item = RawTelemetryItem(
            trace_id=trace_id,
            agent_id=agent_id,
            subagent_type=subagent_type,
            parent_task_id=parent_task_id,
            severity=severity,
            event_type=event_type,
            payload=payload,
        )
        if self._clock is not None:
            item.timestamp_ms = self._clock() * 1000.0
        if self._monotonic_clock is not None:
            item.monotonic_ns = self._monotonic_clock()
        if event_type in CRITICAL_EVENTS:
            self._critical_queue.append(item)
        else:
            if len(self._stream_ring) == self._stream_ring.maxlen:
                self._dropped_debug_events += 1
            self._stream_ring.append(item)

    # Draining.

    def _next_seq(self, trace_id: str) -> int:
        nxt = self._seq_counters.get(trace_id, 0) + 1
        self._seq_counters[trace_id] = nxt
        return nxt

    def _drain_and_coalesce(self) -> list[Envelope]:
        raw_items: list[RawTelemetryItem] = []
        while self._critical_queue:
            raw_items.append(self._critical_queue.popleft())

        streams: dict[tuple[str, str, str], RawTelemetryItem] = {}
        progress: dict[tuple[str, str], tuple[RawTelemetryItem, int]] = {}
        while self._stream_ring:
            try:
                item = self._stream_ring.popleft()
            except IndexError:
                break
            if item.event_type == "STREAM_CHUNK":
                key = (
                    item.trace_id,
                    str(item.payload.get("task_id", "")),
                    str(item.payload.get("stream_channel", "THOUGHT")),
                )
                prev = streams.get(key)
                if prev is None:
                    streams[key] = item
                else:
                    prev.payload = {
                        **prev.payload,
                        "delta_text": str(prev.payload.get("delta_text", ""))
                        + str(item.payload.get("delta_text", "")),
                        "accumulated_tokens": item.payload.get("accumulated_tokens", 0),
                    }
                    prev.timestamp_ms = item.timestamp_ms
                    prev.monotonic_ns = item.monotonic_ns
            elif item.event_type == "BATCH_PROGRESS":
                pkey = (item.trace_id, str(item.payload.get("task_id", "")))
                before = progress.get(pkey)
                count = (before[1] if before else 0) + int(item.payload.get("coalesced_event_count") or 1)
                item.payload = {**item.payload, "coalesced_event_count": count}
                progress[pkey] = (item, count)
            else:
                raw_items.append(item)

        raw_items.extend(streams.values())
        raw_items.extend(entry[0] for entry in progress.values())
        raw_items.sort(key=lambda x: x.monotonic_ns)

        envelopes: list[Envelope] = []
        for item in raw_items:
            envelopes.append(
                {
                    "schema_version": SCHEMA_VERSION,
                    "seq_id": self._next_seq(item.trace_id),
                    "event_id": self._event_ids(),
                    "trace_id": item.trace_id,
                    "agent_id": item.agent_id,
                    "subagent_type": item.subagent_type,
                    "parent_task_id": item.parent_task_id,
                    "timestamp_ms": round(item.timestamp_ms, 3),
                    "monotonic_ns": item.monotonic_ns,
                    "severity": item.severity,
                    "event_type": item.event_type,
                    "payload": item.payload,
                }
            )
        return envelopes

    def flush(self) -> list[Envelope]:
        """Drains, journals and delivers what has been emitted; the envelopes it made. Thread-safe."""
        with self._drain_lock:
            envelopes = self._drain_and_coalesce()
            if not envelopes:
                return []
            if self._journal_dir is not None:
                self._append_to_journal(envelopes)
        self._deliver(envelopes)
        return envelopes

    def _deliver(self, envelopes: list[Envelope]) -> None:
        for listener in list(self._listeners):
            try:
                listener(envelopes)
            except Exception as exc:  # noqa: BLE001 - a broken listener never stops telemetry
                print(f"vibecut telemetry: listener failed: {exc}", file=sys.stderr)
        if not self._subscribers:
            return
        for frame in frames_of(envelopes):
            dead: list[asyncio.Queue[str]] = []
            for queue in list(self._subscribers):
                try:
                    queue.put_nowait(frame)
                except asyncio.QueueFull:
                    dead.append(queue)
            for queue in dead:
                self._subscribers.discard(queue)

    def _append_to_journal(self, envelopes: list[Envelope]) -> None:
        assert self._journal_dir is not None
        by_trace: dict[str, list[str]] = {}
        for env in envelopes:
            by_trace.setdefault(env["trace_id"], []).append(json.dumps(env, ensure_ascii=False))
        try:
            self._journal_dir.mkdir(parents=True, exist_ok=True)
            for trace_id, lines in by_trace.items():
                path = self._journal_dir / f"{safe_trace_name(trace_id)}.jsonl"
                with path.open("a", encoding="utf-8") as fh:
                    fh.write("\n".join(lines) + "\n")
        except OSError as exc:
            # A full or read-only disk loses the journal, never the edit.
            print(f"vibecut telemetry: journal not written: {exc}", file=sys.stderr)

    # Listeners and subscribers.

    def add_listener(self, listener: Listener) -> None:
        self._listeners.append(listener)

    def subscribe(self, maxsize: int = 256) -> asyncio.Queue[str]:
        queue: asyncio.Queue[str] = asyncio.Queue(maxsize=maxsize)
        self._subscribers.add(queue)
        return queue

    def unsubscribe(self, queue: asyncio.Queue[str]) -> None:
        self._subscribers.discard(queue)

    # Running the flush.

    def _register_atexit(self) -> None:
        if not self._atexit_registered:
            atexit.register(self.flush)
            self._atexit_registered = True

    async def start(self) -> None:
        if self._running or not self.enabled:
            return
        self._running = True
        self._register_atexit()
        self._flush_task = asyncio.create_task(self._flush_loop())

    async def stop(self) -> None:
        self._running = False
        if self._flush_task is not None:
            await self._flush_task
            self._flush_task = None
        self.flush()

    async def _flush_loop(self) -> None:
        last_heartbeat = time.monotonic()
        while self._running:
            await asyncio.sleep(self._flush_interval)
            now = time.monotonic()
            if self._heartbeat and now - last_heartbeat >= HEARTBEAT_SECONDS:
                last_heartbeat = now
                active = self.active_trace(now)
                if active is not None:
                    self.emit_heartbeat(active)
            self.flush()

    def start_thread(self) -> None:
        """The flush on a daemon thread, for a process with no event loop of its own (V2)."""
        if self._thread is not None or not self.enabled:
            return
        self._register_atexit()
        self._thread_stop.clear()
        self._thread = threading.Thread(target=self._thread_loop, name="vibecut-telemetry", daemon=True)
        self._thread.start()

    def stop_thread(self) -> None:
        thread, self._thread = self._thread, None
        if thread is None:
            return
        self._thread_stop.set()
        thread.join(timeout=2.0)
        self.flush()

    def _thread_loop(self) -> None:
        while not self._thread_stop.wait(self._flush_interval):
            self.flush()

    def active_trace(self, now: float | None = None) -> str | None:
        """The trace with the latest non-heartbeat event, if it was within HEARTBEAT_ACTIVE_SECONDS."""
        if not self._last_activity:
            return None
        trace_id, at = max(self._last_activity.items(), key=lambda item: item[1])
        moment = time.monotonic() if now is None else now
        return trace_id if moment - at <= HEARTBEAT_ACTIVE_SECONDS else None

    # The host's resources (V3: measured, not made up).

    def resource_sample(self) -> dict[str, Any]:
        usage = resource.getrusage(resource.RUSAGE_SELF)
        cpu_seconds = usage.ru_utime + usage.ru_stime
        wall = time.monotonic()
        cpu_percent = 0.0
        if self._last_cpu is not None:
            spent, began = cpu_seconds - self._last_cpu[0], wall - self._last_cpu[1]
            if began > 0:
                cpu_percent = min(100.0, max(0.0, 100.0 * spent / began / (os.cpu_count() or 1)))
        self._last_cpu = (cpu_seconds, wall)
        # ru_maxrss is the peak, in bytes on macOS and KiB on Linux.
        rss_mb = usage.ru_maxrss / (1024 * 1024) if sys.platform == "darwin" else usage.ru_maxrss / 1024
        return {
            "kind": "RESOURCE_HEARTBEAT",
            "host_cpu_percent": round(cpu_percent, 2),
            "sidecar_rss_mb": round(rss_mb, 2),
            "unified_memory_used_gb": round(rss_mb / 1024.0, 3),
            "unified_memory_total_gb": total_memory_gb(),
            "gpu_lock_holder": gpu_lock_holder(self.gpu_lock_path),
            "active_workers": self.active_workers(),
            "dropped_debug_events": self._dropped_debug_events,
            "nle_connected": nle_connected(
                self._journal_dir / NLE_STATUS_FILE if self._journal_dir else None
            ),
        }

    def emit_heartbeat(self, trace_id: str) -> None:
        self.emit_nowait(
            trace_id=trace_id,
            agent_id="system.telemetry",
            subagent_type="MASTER_ORCHESTRATOR",
            event_type="RESOURCE_HEARTBEAT",
            severity="DEBUG",
            payload=self.resource_sample(),
        )


def frames_of(envelopes: list[Envelope]) -> Iterable[str]:
    """`TELEMETRY_BATCH` frames of at most MAX_FRAME_EVENTS events, one trace each."""
    by_trace: dict[str, list[Envelope]] = {}
    for env in envelopes:
        by_trace.setdefault(env["trace_id"], []).append(env)
    for trace_id, events in by_trace.items():
        for start in range(0, len(events), MAX_FRAME_EVENTS):
            yield json.dumps(
                {
                    "type": "TELEMETRY_BATCH",
                    "trace_id": trace_id,
                    "events": events[start : start + MAX_FRAME_EVENTS],
                },
                ensure_ascii=False,
            )


def total_memory_gb() -> float:
    try:
        return round(os.sysconf("SC_PAGE_SIZE") * os.sysconf("SC_PHYS_PAGES") / 1024**3, 2)
    except (ValueError, OSError, AttributeError):
        return 1.0


def gpu_lock_holder(path: Path | None) -> str | None:
    """The pid GpuLock wrote into `.gpu.lock` (workers/base.py), as `pid:<n>`; read without locking."""
    if path is None:
        return None
    try:
        text = path.read_text(encoding="utf-8").strip()
    except OSError:
        return None
    return f"pid:{text}" if text.isdigit() else None


NLE_STATUS_FILE = "nle_status.json"


def nle_connected(path: Path | None) -> dict[str, bool]:
    """Which editors the app's watchers see, from the `nle_status.json` the app writes on each change
    (nle.rs `write_nle_status`). Both false when there's no file or the app that wrote it isn't running."""
    none = {"premiere": False, "resolve": False}
    if path is None:
        return none
    try:
        status = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return none
    if not isinstance(status, dict) or not _running(status.get("pid")):
        return none
    return {host: status.get(host) is True for host in none}


def _running(pid: object) -> bool:
    if not isinstance(pid, int) or isinstance(pid, bool) or pid <= 0:
        return False
    try:
        os.kill(pid, 0)
    except PermissionError:
        return True
    except OSError:
        return False
    return True


# The process's bus.

_BUS: TelemetryBus | None = None
_BUS_LOCK = threading.Lock()


def get_bus() -> TelemetryBus:
    """This process's bus: journaling to telemetry_dir() when VIBECUT_TELEMETRY=1, else a no-op."""
    global _BUS
    with _BUS_LOCK:
        if _BUS is None:
            if enabled_from_env():
                bus = TelemetryBus(telemetry_dir())
                with contextlib.suppress(Exception):
                    from vibecut_agent.config import OrchestratorConfig

                    bus.gpu_lock_path = Path(OrchestratorConfig.from_env().index_dir) / ".gpu.lock"
                _BUS = bus
            else:
                _BUS = TelemetryBus(enabled=False)
        return _BUS


def reset_bus() -> None:
    """Forgets the process's bus (tests)."""
    global _BUS
    with _BUS_LOCK:
        _BUS = None


# The stdlib check of an envelope (the full schema is telemetry.ts's Zod).


def validate_envelope(env: Any) -> list[str]:
    """What's wrong with `env` as a `vibecut.telemetry.v1` envelope; empty when it fits."""
    if not isinstance(env, dict):
        return ["the envelope isn't an object"]
    problems: list[str] = []

    def need(cond: bool, message: str) -> None:
        if not cond:
            problems.append(message)

    need(env.get("schema_version") == SCHEMA_VERSION, "schema_version")
    need(isinstance(env.get("seq_id"), int) and env["seq_id"] >= 1, "seq_id")
    need(isinstance(env.get("event_id"), str) and len(env["event_id"]) >= 8, "event_id")
    need(isinstance(env.get("trace_id"), str) and len(env["trace_id"]) >= 6, "trace_id")
    need(isinstance(env.get("agent_id"), str) and len(env["agent_id"]) >= 2, "agent_id")
    need(env.get("subagent_type") in SUBAGENT_TYPES, "subagent_type")
    need(env.get("parent_task_id") is None or isinstance(env.get("parent_task_id"), str), "parent_task_id")
    need(isinstance(env.get("timestamp_ms"), int | float) and env["timestamp_ms"] > 0, "timestamp_ms")
    need(isinstance(env.get("monotonic_ns"), int) and env["monotonic_ns"] >= 0, "monotonic_ns")
    need(env.get("severity") in SEVERITIES, "severity")
    event_type = env.get("event_type")
    need(event_type in EVENT_TYPES, "event_type")
    payload = env.get("payload")
    if not isinstance(payload, dict):
        return [*problems, "payload"]
    need(payload.get("kind") == event_type, "payload.kind must match event_type")
    for key in PAYLOAD_KEYS.get(str(event_type), ()):
        need(key in payload, f"payload.{key}")
    for key, allowed in PAYLOAD_ENUMS.get(str(event_type), {}).items():
        if key in payload:
            need(payload[key] in allowed, f"payload.{key}")
    if event_type == "MUTATION_EMITTED":
        need(payload.get("timeline_fps") in SUPPORTED_RATES, "payload.timeline_fps")
        for op in payload.get("operations") or []:
            need(isinstance(op, dict) and op.get("op_type") in DELTA_OP_TYPES, "payload.operations[].op_type")
    if event_type == "BATCH_PROGRESS":
        fraction = payload.get("fraction")
        need(isinstance(fraction, int | float) and 0 <= fraction <= 1, "payload.fraction")
        need(
            isinstance(payload.get("total_items"), int) and payload["total_items"] >= 1, "payload.total_items"
        )
    return problems
