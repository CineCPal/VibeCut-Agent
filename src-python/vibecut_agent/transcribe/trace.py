"""The `transcribe` command's trace for the Telemetry Studio (PLAN.md, "Transcription in the Studio").

A transcription runs in the app's own sidecar, not in a local worker, and a background one outlives the
chat turn that started it (backgroundTranscribe.ts): the shim's `transcribe_clips` task ends as soon as
the job starts. So the job traces itself, as the ingest does: a trace of its own (`trc_trn_…`), a root
task for the run, and per file one task per phase it goes through, chained by handoffs:

    root → extract (the sound, once) → whisper → align (missed speech, line edges) → speakers (diarize)

A file read from its cache has no phases: it is one task at the Whisper desk that says so. A cache being
checked against the sound (pipeline.upgrade_cache) shows its extract and align phases only.

A phase is spawned at its second report, or its first with progress: the pipeline announces a phase at
0.0 before the work, and upgrade_cache announces "align" before it extracts, so a phase announced and at
once replaced (or a sound already extracted, which reports nothing) never makes an empty task. Progress
is sent at most every PROGRESS_INTERVAL seconds per task, and always at a phase's end.

`for_run` gives None when telemetry is off (VIBECUT_TELEMETRY isn't "1"); the command then runs as before.
Nothing here raises into the transcription: each event is best effort."""

from __future__ import annotations

import contextlib
import os
import time
from collections.abc import Iterator
from dataclasses import dataclass
from typing import Any

from vibecut_agent.telemetry.instrument import TraceEmitter, failure_code, for_process

ROOT_AGENT = ("orchestrator.transcribe", "MASTER_ORCHESTRATOR")
# Each phase: (subagent, agent id, hardware backend, label, packet it hands on).
PHASES: dict[str, tuple[str, str, str, str, str]] = {
    "extract": ("INGEST_TRANSCRIBE", "app.sound", "CPU_NEON", "Extract the sound", "PROMPT_TOKENS"),
    "transcribe": ("INGEST_TRANSCRIBE", "app.whisper", "METAL_MPS", "Whisper", "TRANSCRIPT_SLICES"),
    "align": (
        "INGEST_TRANSCRIBE",
        "app.alignment",
        "CPU_NEON",
        "Check against the sound",
        "TRANSCRIPT_SLICES",
    ),
    "diarize": ("INGEST_TRANSCRIBE", "app.diarizer", "CPU_NEON", "Speaker labels", "TRANSCRIPT_SLICES"),
}
CACHED = ("INGEST_TRANSCRIBE", "app.whisper", "CPU_NEON", "From the cache", "TRANSCRIPT_SLICES")
PROGRESS_INTERVAL = 0.5


@dataclass
class PhaseTask:
    phase: str
    task_id: str
    began: float
    sent_at: float = 0.0


@dataclass
class Pending:
    phase: str
    began: float


class TranscribeTrace:
    """One `transcribe` run's events (see the module docstring)."""

    def __init__(self, trace: TraceEmitter, total: int, model: str, diarize: bool) -> None:
        self.trace = trace
        self.total = total
        self.model = model
        self.diarize = diarize
        self.index = 0
        self.path = ""
        self.current: PhaseTask | None = None
        self.pending: Pending | None = None
        # The file's last finished phase task, which the next one (or the root) is handed from.
        self.last_task: str | None = None
        self.last_phase: str | None = None
        self.done = 0
        self.failed_count = 0

    @classmethod
    def for_run(cls, raw_request: dict[str, Any], request: dict[str, Any]) -> TranscribeTrace | None:
        total = len(request["videos"])
        files = f"{total} file{'s' if total != 1 else ''}"
        label = (
            f"Background transcription: {files}"
            if raw_request.get("background") is True
            else f"Transcribe {files}"
        )
        trace = for_process("trn", root_label=label)
        if trace is None:
            return None
        return cls(trace, total, str(request["model"]), bool(request["diarize"]))

    @property
    def root(self) -> str:
        return self.trace.root_task_id

    # The run.

    def begin(self) -> None:
        with self._quietly():
            self.trace.ensure_root(model_id=self.model, agent_id=ROOT_AGENT[0], backend="METAL_MPS")

    def file_start(self, path: str, index: int) -> None:
        self.path, self.index = path, index
        self.current = self.pending = None
        self.last_task = self.last_phase = None

    def progress(self, phase: str, fraction: float, detail: str) -> None:
        if phase not in PHASES:
            return
        with self._quietly():
            now = time.perf_counter()
            if self.current is not None and self.current.phase == phase:
                self._send_progress(self.current, fraction, detail, now)
                return
            if self.pending is None or self.pending.phase != phase:
                # Announced: spawned at its next report, or now if it already has progress.
                self.pending = Pending(phase, now)
                if fraction <= 0.0:
                    return
            pending, self.pending = self.pending, None
            self._end_current(now)
            self.current = self._spawn(PHASES[pending.phase], pending.phase, pending.began)
            self._send_progress(self.current, fraction, detail, now, force=True)

    def file_done(self, payload: dict[str, Any]) -> None:
        with self._quietly():
            now = time.perf_counter()
            self.pending = None
            if self.current is None and self.last_task is None:
                # Read from its cache: no phase ran.
                self.current = self._spawn(CACHED, "cached", now)
            summary = (
                f"{payload.get('segmentCount', 0)} lines, {len(payload.get('speakers') or [])} speaker(s)"
            )
            artifacts = [
                {
                    "artifact_type": "TRANSCRIPT_SUMMARY",
                    "media_path": self.path,
                    "segment_count": int(payload.get("segmentCount") or 0),
                    "word_count": 0,
                    "speakers": [str(s) for s in payload.get("speakers") or []],
                    "cache_path": str(payload.get("cachePath") or ""),
                }
            ]
            self._end_current(now, summary=f"{summary}: {self._name()}", artifacts=artifacts)
            self.done += 1
            if self.last_task is not None:
                subagent, agent_id, _, _, packet = self._spec(self.last_phase)
                self.trace.handoff(
                    self.last_task,
                    self.root,
                    from_agent=(agent_id, subagent),
                    to_agent=ROOT_AGENT,
                    packet_type=packet,
                    summary=f"{self._name()}: {summary}",
                    clip_count=int(payload.get("segmentCount") or 0),
                )

    def file_failed(self, message: str) -> None:
        with self._quietly():
            now = time.perf_counter()
            self.pending = None
            if self.current is None:
                self.current = self._spawn(PHASES["transcribe"], "transcribe", now)
            task, self.current = self.current, None
            subagent, agent_id, *_ = self._spec(task.phase)
            code, recoverable = failure_code(message)
            self.trace.failed(
                task.task_id,
                agent_id=agent_id,
                subagent=subagent,
                message=f"{self._name()}: {message}",
                code=code,
                recoverable=recoverable,
                parent=self.root,
            )
            self.failed_count += 1

    def cancelled(self) -> None:
        with self._quietly():
            self.pending = None
            if self.current is not None:
                task, self.current = self.current, None
                subagent, agent_id, *_ = self._spec(task.phase)
                self.trace.failed(
                    task.task_id,
                    agent_id=agent_id,
                    subagent=subagent,
                    message="The transcription was stopped",
                    code="TASK_CANCELLED",
                    recoverable=False,
                    parent=self.root,
                )
            self.trace.failed(
                self.root,
                agent_id=ROOT_AGENT[0],
                subagent=ROOT_AGENT[1],
                message="The transcription was stopped",
                code="TASK_CANCELLED",
                recoverable=False,
            )
            self.trace.bus.flush()

    def finish(self) -> None:
        with self._quietly():
            failed = f", {self.failed_count} failed" if self.failed_count else ""
            self.trace.finish(f"{self.done} of {self.total} transcribed{failed}")

    # Tasks.

    def _spawn(self, spec: tuple[str, str, str, str, str], phase: str, began: float) -> PhaseTask:
        subagent, agent_id, backend, label, _ = spec
        task_id = self.trace.next_task_id(phase[:3])
        upstream = self.last_task or self.root
        self.trace.spawn(
            task_id,
            agent_id=agent_id,
            subagent=subagent,
            label=f"{label}: {self._name()}",
            model_id=self.model if phase in ("transcribe", "align") else "",
            backend=backend,
            parent=self.root,
            upstream=[upstream],
            input_summary=self.path,
        )
        if self.last_task is not None:
            from_subagent, from_agent, _, _, packet = self._spec(self.last_phase)
            from_pair = (from_agent, from_subagent)
        else:
            packet, from_pair = "PROMPT_TOKENS", ROOT_AGENT
        self.trace.handoff(
            upstream,
            task_id,
            from_agent=from_pair,
            to_agent=(agent_id, subagent),
            packet_type=packet,
            summary=self._name(),
        )
        return PhaseTask(phase, task_id, began)

    def _end_current(
        self, now: float, *, summary: str | None = None, artifacts: list[dict[str, Any]] | None = None
    ) -> None:
        if self.current is None:
            return
        task, self.current = self.current, None
        subagent, agent_id, _, label, _ = self._spec(task.phase)
        self.trace.completed(
            task.task_id,
            agent_id=agent_id,
            subagent=subagent,
            latency_ms=(now - task.began) * 1000.0,
            summary=summary or f"{label}: {self._name()}",
            artifacts=artifacts,
            parent=self.root,
        )
        self.last_task, self.last_phase = task.task_id, task.phase

    def _send_progress(
        self, task: PhaseTask, fraction: float, detail: str, now: float, force: bool = False
    ) -> None:
        fraction = min(1.0, max(0.0, fraction))
        if not force and fraction < 1.0 and now - task.sent_at < PROGRESS_INTERVAL:
            return
        task.sent_at = now
        elapsed = now - task.began
        eta = elapsed * (1.0 - fraction) / fraction if fraction > 0.01 else None
        subagent, agent_id, *_ = self._spec(task.phase)
        self.trace.progress(
            task.task_id,
            agent_id=agent_id,
            subagent=subagent,
            phase=task.phase,
            fraction=fraction,
            completed_items=self.index,
            total_items=self.total,
            eta_seconds=eta,
            label=f"{self._name()}: {detail}" if detail else self._name(),
            parent=self.root,
        )

    def _spec(self, phase: str | None) -> tuple[str, str, str, str, str]:
        return PHASES.get(phase or "", CACHED)

    def _name(self) -> str:
        return os.path.basename(self.path) or self.path

    @contextlib.contextmanager
    def _quietly(self) -> Iterator[None]:
        # Telemetry never stops a transcription.
        try:
            yield
        except Exception:
            pass
