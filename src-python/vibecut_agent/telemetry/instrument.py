"""One trace's events, as the runtime's code emits them (PLAN.md, "Phase 22").

`TraceEmitter` wraps a TelemetryBus with the trace's id and builds each payload as
packages/contracts/telemetry.ts has it, so the tool bus and the ingest command say "this task started",
"it finished", "it proposed this delta" and nothing about envelopes. `for_process` gives None when
telemetry is off (VIBECUT_TELEMETRY isn't "1"), and every caller checks for None first: with it off, the
instrumented code runs exactly as before.

`tool_call` runs one orchestration tool (orchestrator/tool_bus.py) as a task of its own under the trace's
root: SPAWN, a handoff from the orchestrator, TOOL_INVOCATION, then COMPLETED, or FAILED with an
`error_code` read from the tool's `{"error"}` result (the bus never raises for a tool's own failure)."""

from __future__ import annotations

import json
import threading
import time
from collections.abc import Callable, Iterable
from dataclasses import dataclass
from typing import Any

from vibecut_agent.telemetry.bus import TelemetryBus, get_bus, trace_id_for

# Each orchestration tool's worker: (subagent type, agent id, hardware backend, label).
TOOL_AGENTS: dict[str, tuple[str, str, str, str]] = {
    "semantic_asset_search": ("BROLL_RETRIEVER", "worker.vector", "METAL_MPS", "Hybrid asset search"),
    "transcribe_and_align": ("INGEST_TRANSCRIBE", "worker.whisper", "METAL_MPS", "Transcribe and align"),
    "analyze_shot_visuals": ("VISION_TAGGER", "worker.vlm", "METAL_MPS", "Shot visuals"),
    "detect_media_boundaries": ("AUDIO_ENGINEER", "worker.audio_sync", "CPU_NEON", "Media boundaries"),
    "propose_otio_delta": ("PACING_CUTTER", "worker.otio_cutter", "CPU_NEON", "Propose OTIO delta"),
    "commit_otio_delta": ("COLOR_GRADER", "worker.color_nle", "NLE_IPC", "Commit to the editor"),
    # The app's tools an orchestrated chat keeps (tool_bus.FORWARDED_TOOLS), run in the app, not by a local
    # worker: the shim traces them (mcp_server.py). The five timeline reads aren't traced.
    "find_broll": ("BROLL_RETRIEVER", "app.broll_library", "METAL_MPS", "B-roll Library search"),
    "list_spyglass_folders": ("BROLL_RETRIEVER", "app.broll_library", "CPU_NEON", "B-roll Library folders"),
    "describe_spyglass_folder": ("BROLL_RETRIEVER", "app.broll_library", "CPU_NEON", "B-roll Library folder"),
    "list_media_pool": ("BROLL_RETRIEVER", "app.media_pool", "NLE_IPC", "Project bins"),
    "search_media_pool": ("BROLL_RETRIEVER", "app.media_pool", "NLE_IPC", "Project bin search"),
    "analyze_broll_folder": ("VISION_TAGGER", "app.broll_analyzer", "METAL_MPS", "Analyze a B-roll folder"),
    "sync_and_place": ("AUDIO_ENGINEER", "app.audio_sync", "CPU_NEON", "Sync and place"),
    "sync_clips": ("AUDIO_ENGINEER", "app.audio_sync", "CPU_NEON", "Sync clips"),
    "slip_into_sync": ("AUDIO_ENGINEER", "app.audio_sync", "CPU_NEON", "Slip into sync"),
}
# Only the local workers take VibeCut's GPU lock (workers/base.py); the app's own models don't.
GPU_LOCK_AGENT_PREFIX = "worker."
DEFAULT_AGENT = ("MASTER_ORCHESTRATOR", "orchestrator.supervisor", "CLOUD_API", "Tool")
ROOT_AGENT_ID = "orchestrator.supervisor"
# Tool arguments larger than this (in characters of JSON) are summarised, not sent whole.
MAX_ARGUMENT_CHARS = 8_000
MAX_SUMMARY_CHARS = 280

# A tool's `{"error"}` text, mapped to the contract's error codes; the first match wins.
FAILURE_CODES: tuple[tuple[str, str, bool], ...] = (
    ("STALE_TIMELINE_HASH", "STALE_TIMELINE_HASH", True),
    ("schema", "SCHEMA_VALIDATION_FAILED", True),
    ("local models are busy", "LOCAL_MODEL_UNAVAILABLE", True),
    ("isn't there", "MEDIA_OFFLINE", True),
    ("Couldn't read the timeline", "NLE_BRIDGE_TIMEOUT", True),
    ("can't be reached", "NLE_BRIDGE_TIMEOUT", True),
    ("timed out", "NLE_BRIDGE_TIMEOUT", True),
    ("circuit", "GPU_OOM_CIRCUIT_BREAKER", True),
)


def failure_code(message: str) -> tuple[str, bool]:
    """The contract's `error_code` for a tool's error text, and whether trying again could help."""
    lowered = message.lower()
    for needle, code, recoverable in FAILURE_CODES:
        if needle.lower() in lowered:
            return code, recoverable
    return "UPSTREAM_PROVIDER_ERROR", True


def short(text: Any, limit: int = MAX_SUMMARY_CHARS) -> str:
    value = text if isinstance(text, str) else json.dumps(text, ensure_ascii=False, default=str)
    return value if len(value) <= limit else value[: limit - 1] + "…"


def compact_arguments(args: Any) -> dict[str, Any]:
    """The tool's arguments for TOOL_INVOCATION: whole when small, else their keys and a summary."""
    if not isinstance(args, dict):
        return {"value": short(args)}
    text = json.dumps(args, ensure_ascii=False, default=str)
    if len(text) <= MAX_ARGUMENT_CHARS:
        return args
    return {"_truncated": True, "_chars": len(text), "keys": sorted(args), "summary": short(text, 600)}


def media_paths_of(args: Any) -> list[str]:
    if not isinstance(args, dict):
        return []
    paths = [args["media_path"]] if isinstance(args.get("media_path"), str) else []
    paths += [p for p in args.get("scope_paths") or [] if isinstance(p, str)]
    return paths


def op_summaries(delta: dict[str, Any]) -> list[dict[str, Any]]:
    """A delta's operations as the contract's DeltaOpSummary (`track_Selector` becomes track_kind and
    track_index, `media_reference` its source_name and target_url)."""
    fps = delta.get("timeline_fps", 24.0)
    zero = {"OTIO_SCHEMA": "RationalTime.1", "value": 0, "rate": fps}
    summaries = []
    for op in delta.get("operations") or []:
        if not isinstance(op, dict):
            continue
        track = op.get("track_Selector") or {}
        ref = op.get("media_reference") or {}
        audio = op.get("audio_params") or {}
        transition = op.get("transition") or {}
        summaries.append(
            {
                "op_id": str(op.get("op_id", "")),
                "op_type": op.get("op_type"),
                "track_kind": track.get("kind", "Video"),
                "track_index": int(track.get("index", 1) or 1),
                "clip_id": op.get("clip_id"),
                "source_name": ref.get("source_name"),
                "target_url": ref.get("target_url"),
                "source_range": op.get("source_range"),
                "timeline_range": op.get("timeline_range")
                or {"OTIO_SCHEMA": "TimeRange.1", "start_time": zero, "duration": zero},
                "ripple": op.get("ripple") is True,
                "gain_db": audio.get("gain_db", audio.get("duck_Floor_db")),
                "transition_type": transition.get("transition_type"),
            }
        )
    return summaries


class TraceEmitter:
    """One trace's events (see the module docstring)."""

    def __init__(self, bus: TelemetryBus, trace_id: str, root_label: str = "Orchestrated turn") -> None:
        self.bus = bus
        self.trace_id = trace_id
        self.root_label = root_label
        self.root_task_id = "task_root"
        self._root_spawned = False
        self._count = 0
        # The tool call running now (task id, agent id, subagent), for the bus's mutation events.
        self.current_task: tuple[str, str, str] | None = None
        self._root_agent = ROOT_AGENT_ID
        self._root_began = time.perf_counter()
        self._tasks_done = 0
        self._tasks_failed = 0
        # The shim's forwarded calls (its event loop) and the bus (a worker thread) both make tasks.
        self._lock = threading.Lock()

    # Raw events.

    def emit(
        self,
        event_type: str,
        payload: dict[str, Any],
        *,
        agent_id: str,
        subagent: str,
        parent: str | None = None,
        severity: str = "INFO",
    ) -> None:
        self.bus.emit_nowait(
            trace_id=self.trace_id,
            agent_id=agent_id,
            subagent_type=subagent,
            event_type=event_type,
            payload={"kind": event_type, **payload},
            parent_task_id=parent,
            severity=severity,
        )

    def next_task_id(self, tag: str) -> str:
        with self._lock:
            self._count += 1
            return f"task_{self._count:03d}_{tag}"

    def spawn(
        self,
        task_id: str,
        *,
        agent_id: str,
        subagent: str,
        label: str,
        model_id: str = "",
        backend: str = "CPU_NEON",
        parent: str | None = None,
        upstream: Iterable[str] = (),
        input_summary: str = "",
    ) -> None:
        self.emit(
            "SPAWN",
            {
                "task_id": task_id,
                "task_label": label,
                "model_id": model_id,
                "hardware_backend": backend,
                "upstream_task_ids": list(upstream),
                "input_summary": short(input_summary),
                "expected_timeout_ms": 60000,
            },
            agent_id=agent_id,
            subagent=subagent,
            parent=parent,
        )

    def ensure_root(self, model_id: str = "claude-code", agent_id: str = ROOT_AGENT_ID) -> None:
        if self._root_spawned:
            return
        self._root_spawned = True
        self._root_agent = agent_id
        self._root_began = time.perf_counter()
        self.spawn(
            self.root_task_id,
            agent_id=agent_id,
            subagent="MASTER_ORCHESTRATOR",
            label=self.root_label,
            model_id=model_id,
            backend="CLOUD_API",
        )

    def completed(
        self,
        task_id: str,
        *,
        agent_id: str,
        subagent: str,
        latency_ms: float,
        summary: str,
        artifacts: list[dict[str, Any]] | None = None,
        parent: str | None = None,
    ) -> None:
        self.emit(
            "COMPLETED",
            {
                "task_id": task_id,
                "latency_ms": round(max(0.0, latency_ms), 3),
                "ttfb_ms": None,
                "input_tokens": 0,
                "output_tokens": 0,
                "cached_tokens": 0,
                "cost_usd": 0,
                "peak_memory_mb": 0,
                "output_summary": short(summary),
                "artifacts": artifacts or [],
            },
            agent_id=agent_id,
            subagent=subagent,
            parent=parent,
        )

    def failed(
        self,
        task_id: str,
        *,
        agent_id: str,
        subagent: str,
        message: str,
        code: str | None = None,
        recoverable: bool = True,
        parent: str | None = None,
    ) -> None:
        if code is None:
            code, recoverable = failure_code(message)
        self.emit(
            "FAILED",
            {
                "task_id": task_id,
                "error_code": code,
                "error_message": short(message, 1000),
                "recoverable": recoverable,
                "retry_attempt": 0,
                "max_retries": 0,
                "remediation_hint": None,
            },
            agent_id=agent_id,
            subagent=subagent,
            parent=parent,
            severity="ERROR",
        )

    def progress(
        self,
        task_id: str,
        *,
        agent_id: str,
        subagent: str,
        phase: str,
        fraction: float,
        completed_items: int,
        total_items: int,
        eta_seconds: float | None,
        label: str | None,
        parent: str | None = None,
    ) -> None:
        self.emit(
            "BATCH_PROGRESS",
            {
                "task_id": task_id,
                "phase": phase,
                "completed_items": max(0, completed_items),
                "total_items": max(1, total_items),
                "fraction": min(1.0, max(0.0, fraction)),
                "eta_seconds": None if eta_seconds is None else max(0.0, eta_seconds),
                "throughput_items_per_sec": 0.0,
                "current_item_label": label,
                "coalesced_event_count": 1,
            },
            agent_id=agent_id,
            subagent=subagent,
            parent=parent,
            severity="DEBUG",
        )

    def handoff(
        self,
        from_task: str,
        to_task: str,
        *,
        from_agent: tuple[str, str],
        to_agent: tuple[str, str],
        packet_type: str,
        summary: str,
        payload_bytes: int = 0,
        clip_count: int = 0,
    ) -> None:
        self.emit(
            "CONTEXT_HANDOFF",
            {
                "from_task_id": from_task,
                "to_task_id": to_task,
                "from_agent_id": from_agent[0],
                "to_agent_id": to_agent[0],
                "from_subagent": from_agent[1],
                "to_subagent": to_agent[1],
                "packet_type": packet_type,
                "payload_bytes": max(0, payload_bytes),
                "token_count": 0,
                "clip_count": max(0, clip_count),
                "summary": short(summary),
            },
            agent_id=from_agent[0],
            subagent=from_agent[1],
        )

    def mutation(
        self,
        task_id: str,
        stage: str,
        delta: dict[str, Any],
        *,
        agent_id: str,
        subagent: str,
        token: str | None = None,
        snapshot_path: str | None = None,
    ) -> None:
        self.emit(
            "MUTATION_EMITTED",
            {
                "task_id": task_id,
                "delta_id": str(delta.get("delta_id", "")),
                "mutation_stage": stage,
                "validation_token": token,
                "target_host": delta.get("target_host", "premiere"),
                "target_timeline": str(delta.get("target_timeline", "")),
                "timeline_fps": delta.get("timeline_fps", 24.0),
                "narrative_rationale": short(delta.get("narrative_rationale", ""), 1000),
                "operations": op_summaries(delta),
                "otio_snapshot_path": snapshot_path,
            },
            agent_id=agent_id,
            subagent=subagent,
            parent=self.root_task_id,
            severity="MUTATION",
        )

    def finish(self, summary: str | None = None) -> None:
        """COMPLETED for the root, with the time since it was spawned (the end of the shim's run, or of an
        ingest); then a flush. Nothing when the root was never spawned (no tool was called), or once it's done."""
        if not self._root_spawned:
            return
        self._root_spawned = False
        self.completed(
            self.root_task_id,
            agent_id=self._root_agent,
            subagent="MASTER_ORCHESTRATOR",
            latency_ms=(time.perf_counter() - self._root_began) * 1000.0,
            summary=summary or f"{self._tasks_done} tool calls, {self._tasks_failed} failed",
        )
        self.bus.flush()

    # One orchestration tool call as a task.

    def tool_call(self, name: str, args: Any, run: Callable[[], Any]) -> Any:
        """Runs `run()` (the bus's own dispatch) as a task; its result is returned unchanged."""
        task = self.begin_tool(name, args)
        self.current_task = (task.task_id, task.agent_id, task.subagent)
        try:
            result = run()
        except Exception as exc:
            self.end_tool(task, error=exc)
            raise
        finally:
            self.current_task = None
        self.end_tool(task, result)
        return result

    def begin_tool(self, name: str, args: Any) -> ToolTask:
        """A tool call's task, spawned and handed its arguments; `end_tool` finishes it. The shim uses the
        two for the app's tools it forwards (mcp_server.py), whose calls it awaits."""
        self.ensure_root()
        subagent, agent_id, backend, label = TOOL_AGENTS.get(name, DEFAULT_AGENT)
        task = ToolTask(name, self.next_task_id(name.split("_")[0]), agent_id, subagent, time.perf_counter())
        self.spawn(
            task.task_id,
            agent_id=agent_id,
            subagent=subagent,
            label=label,
            model_id=name,
            backend=backend,
            parent=self.root_task_id,
            upstream=[self.root_task_id],
            input_summary=short(args),
        )
        self.handoff(
            self.root_task_id,
            task.task_id,
            from_agent=(ROOT_AGENT_ID, "MASTER_ORCHESTRATOR"),
            to_agent=(agent_id, subagent),
            packet_type="OTIO_DELTA" if name == "propose_otio_delta" else "PROMPT_TOKENS",
            summary=f"{name}",
            payload_bytes=len(json.dumps(args, ensure_ascii=False, default=str)),
        )
        self.emit(
            "TOOL_INVOCATION",
            {
                "task_id": task.task_id,
                "tool_call_id": f"call_{task.task_id}",
                "tool_name": name,
                "target_subagent": subagent,
                "arguments": compact_arguments(args),
                "requires_gpu_lock": backend == "METAL_MPS" and agent_id.startswith(GPU_LOCK_AGENT_PREFIX),
                "media_paths": media_paths_of(args),
            },
            agent_id=agent_id,
            subagent=subagent,
            parent=self.root_task_id,
        )
        task.began = time.perf_counter()
        return task

    def end_tool(
        self,
        task: ToolTask,
        result: Any = None,
        *,
        error: BaseException | None = None,
        summary: str | None = None,
    ) -> None:
        """Completes `task` with its result, or fails it on `error` or a `{"error"}` result. `summary` (the
        app's own line for a forwarded call) stands in for the one made from the result."""
        if error is not None:
            self.failed(
                task.task_id,
                agent_id=task.agent_id,
                subagent=task.subagent,
                message=f"{type(error).__name__}: {error}",
                code="NLE_BRIDGE_TIMEOUT",
                parent=self.root_task_id,
            )
            return
        latency_ms = (time.perf_counter() - task.began) * 1000.0
        with self._lock:
            self._tasks_done += 1
            failed = isinstance(result, dict) and "error" in result
            if failed:
                self._tasks_failed += 1
        if failed:
            self.failed(
                task.task_id,
                agent_id=task.agent_id,
                subagent=task.subagent,
                message=str(result["error"]),
                parent=self.root_task_id,
            )
            return
        said = short(summary) if summary else summary_of(task.name, result)
        self.completed(
            task.task_id,
            agent_id=task.agent_id,
            subagent=task.subagent,
            latency_ms=latency_ms,
            summary=said,
            artifacts=artifacts_of(task.name, result),
            parent=self.root_task_id,
        )
        self.handoff(
            task.task_id,
            self.root_task_id,
            from_agent=(task.agent_id, task.subagent),
            to_agent=(ROOT_AGENT_ID, "MASTER_ORCHESTRATOR"),
            packet_type=PACKET_BACK.get(task.name, "PROMPT_TOKENS"),
            summary=said,
            payload_bytes=len(json.dumps(result, ensure_ascii=False, default=str)),
            clip_count=len(result.get("hits") or []) if isinstance(result, dict) else 0,
        )


@dataclass
class ToolTask:
    """One tool call's task while it runs (`TraceEmitter.begin_tool`)."""

    name: str
    task_id: str
    agent_id: str
    subagent: str
    began: float


PACKET_BACK = {
    "semantic_asset_search": "CLIP_MANIFEST",
    "transcribe_and_align": "TRANSCRIPT_SLICES",
    "analyze_shot_visuals": "VLM_TAGS",
    "propose_otio_delta": "VALIDATION_TOKEN",
    "commit_otio_delta": "NLE_COMMIT_BATCH",
    "find_broll": "CLIP_MANIFEST",
    "search_media_pool": "CLIP_MANIFEST",
    "analyze_broll_folder": "VLM_TAGS",
    "sync_and_place": "NLE_COMMIT_BATCH",
    "sync_clips": "NLE_COMMIT_BATCH",
    "slip_into_sync": "NLE_COMMIT_BATCH",
}


def summary_of(name: str, result: Any) -> str:
    if not isinstance(result, dict):
        return short(result)
    if name == "semantic_asset_search":
        return f"{len(result.get('hits') or [])} hits for {short(result.get('query', ''), 80)!r}"
    if name == "transcribe_and_align":
        return f"{len(result.get('segments') or [])} segments"
    if name == "analyze_shot_visuals":
        return f"{len(result.get('shots') or [])} shots"
    if name == "detect_media_boundaries":
        found = [
            f"{len(result[k])} {k}" for k in ("silences", "scene_cuts") if isinstance(result.get(k), list)
        ]
        return ", ".join(found) or "measured"
    if name == "propose_otio_delta":
        verdict = "valid" if result.get("valid") else "invalid"
        return f"{result.get('delta_id', '')} {verdict}, {len(result.get('diagnostics') or [])} diagnostics"
    return short(result)


def artifacts_of(name: str, result: Any) -> list[dict[str, Any]]:
    """The contract's ArtifactRefs a tool's result makes, where one fits."""
    if not isinstance(result, dict):
        return []
    if name == "semantic_asset_search":
        clips = []
        for hit in result.get("hits") or []:
            try:
                clips.append(
                    {
                        "hit_id": str(hit["hit_id"]),
                        "filename": str(hit["filename"]),
                        "media_path": str(hit["media_path"]),
                        "source_range": hit["source_range"],
                        "start_tc": str(hit["start_tc"]),
                        "end_tc": str(hit["end_tc"]),
                        "score": float(hit.get("scores", {}).get("rrf_combined", 0.0)),
                        "modality": result.get("modality", "hybrid"),
                        "thumbnail_frame_id": None,
                    }
                )
            except (KeyError, TypeError, ValueError):
                continue
        return [{"artifact_type": "CLIP_RANGES", "count": len(clips), "clips": clips}]
    if name == "transcribe_and_align" and isinstance(result.get("segments"), list):
        segments = result["segments"]
        return [
            {
                "artifact_type": "TRANSCRIPT_SUMMARY",
                "media_path": str(result.get("path", "")),
                "segment_count": len(segments),
                "word_count": sum(len(s.get("words") or []) for s in segments if isinstance(s, dict)),
                "speakers": [str(s) for s in result.get("speakers") or []],
                "cache_path": "",
            }
        ]
    if name == "analyze_shot_visuals" and isinstance(result.get("shots"), list):
        shots = result["shots"]
        scales = list(dict.fromkeys(str(s.get("shot_scale")) for s in shots if isinstance(s, dict)))
        return [
            {
                "artifact_type": "VLM_SHOT_TAGS",
                "media_path": str(result.get("media_path", "")),
                "shot_count": len(shots),
                "dominant_scales": scales[:4],
                "contact_strip_frame_ids": [],
            }
        ]
    if name == "propose_otio_delta" and "valid" in result:
        return [
            {
                "artifact_type": "VALIDATION_REPORT",
                "delta_id": str(result.get("delta_id", "")),
                "valid": result.get("valid") is True,
                "validation_token": result.get("validation_token"),
                "validator_mode": "deterministic"
                if result.get("validator_model") == "deterministic"
                else "llm",
                "diagnostic_count": len(result.get("diagnostics") or []),
            }
        ]
    return []


def for_process(
    prefix: str, key: str | None = None, root_label: str = "Orchestrated turn"
) -> TraceEmitter | None:
    """A trace for this process on its bus (journaling on a thread), or None when telemetry is off."""
    bus = get_bus()
    if not bus.enabled:
        return None
    bus.start_thread()
    return TraceEmitter(bus, trace_id_for(prefix, key), root_label)
