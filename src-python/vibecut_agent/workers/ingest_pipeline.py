"""The `ingest-index` command (ORCHESTRATOR_SPEC.md §1.2 Plane A; PLAN.md, "Phase 21"): media files made
searchable for the orchestrated chat.

request: {"paths": [absolute media files], "stages": ["transcribe", "vision", "index"] (default all),
          "sampleStrategy": "scene_cuts" | "uniform_2s" | "midpoint_only", "modelTier": optional Whisper tier,
          "diarize": bool, "hfToken" (from Rust, only with diarize), "force": bool (ignore the caches)}
events:  progress {fraction, phase, detail, etaSeconds}; result {"files": [{path, segments, shots, indexed,
          errors}], "indexPath"}

The run goes stage by stage (model migration v2): every file's Whisper transcript (whisper_worker), then
every file's shots (vlm_worker), then every file into the vector store (vector_store). Whisper, the VLM and
the embedding model each want most of unified memory; one file at a time through all three made Ollama
evict and reload the VLM and the embedder for every file. Each stage still holds the GPU lock only while
its model runs. A stage that fails is recorded on its file and the next file or stage goes on; a file with
no picture just has no shots, and a missing file is reported once and skipped. Stopping (SIGTERM) ends
after the step that is running."""

from __future__ import annotations

import os
import time
from collections.abc import Callable
from typing import TYPE_CHECKING, Any, TextIO

from vibecut_agent.config import OrchestratorConfig
from vibecut_agent.core.ffmpeg_ops import SAMPLE_STRATEGIES
from vibecut_agent.protocol import CancelFlag, Emitter, RequestError, read_request, require_absolute_paths
from vibecut_agent.workers.whisper_worker import TIERS

if TYPE_CHECKING:
    from vibecut_agent.telemetry.instrument import TraceEmitter

STAGES = ("transcribe", "vision", "index")
# Phase 22: each stage's worker as the visualizer shows it (subagent type, agent id, label, what it hands on).
STAGE_AGENTS = {
    "transcribe": ("INGEST_TRANSCRIBE", "worker.whisper", "Transcribe", "TRANSCRIPT_SLICES"),
    "vision": ("VISION_TAGGER", "worker.vlm", "Shot tags", "VLM_TAGS"),
    "index": ("BROLL_RETRIEVER", "worker.vector", "Index", "CLIP_MANIFEST"),
}
INGEST_AGENT = ("orchestrator.ingest", "MASTER_ORCHESTRATOR")
MAX_FILES = 500


class Cancelled(Exception):
    pass


def parse_request(request: dict[str, Any]) -> dict[str, Any]:
    paths = request.get("paths")
    if not isinstance(paths, list) or not paths or len(paths) > MAX_FILES:
        raise RequestError(f"paths must be a list of 1 to {MAX_FILES} media files")
    require_absolute_paths(paths, "media file")
    stages = request.get("stages", list(STAGES))
    if not isinstance(stages, list) or not stages or any(s not in STAGES for s in stages):
        raise RequestError(f"stages must be some of {', '.join(STAGES)}")
    strategy = request.get("sampleStrategy", "scene_cuts")
    if strategy not in SAMPLE_STRATEGIES:
        raise RequestError(f"sampleStrategy must be one of {', '.join(SAMPLE_STRATEGIES)}")
    tier = request.get("modelTier")
    if tier is not None and tier not in TIERS:
        raise RequestError(f"modelTier must be one of {', '.join(TIERS)}")
    diarize = request.get("diarize") is True
    token = request.get("hfToken")
    if diarize and not (isinstance(token, str) and token.strip()):
        raise RequestError("Telling speakers apart needs a Hugging Face token (Settings → API keys)")
    return {
        "paths": [str(p) for p in dict.fromkeys(paths)],
        "stages": [s for s in STAGES if s in stages],
        "strategy": strategy,
        "tier": tier,
        "diarize": diarize,
        "hf_token": token if diarize else None,
        "force": request.get("force") is True,
    }


class Ingest:
    """One run's files through its stages, reporting progress by stage across all files."""

    def __init__(
        self,
        options: dict[str, Any],
        emitter: Emitter,
        cancel: CancelFlag,
        config: OrchestratorConfig,
        make_workers: Callable[[OrchestratorConfig], dict[str, Any]] | None = None,
        telemetry: TraceEmitter | None = None,
    ) -> None:
        self.options = options
        # Phase 22: None (telemetry off) emits nothing.
        self.telemetry = telemetry
        self.task_of: dict[tuple[str, str], str] = {}
        self.current_task: str | None = None
        self.emitter = emitter
        self.cancel = cancel
        self.config = config
        self.workers = (make_workers or default_workers)(config)
        self.steps = len(options["paths"]) * len(options["stages"])
        self.done = 0
        # The ETA is paced by the steps that did work, stage by stage. Seen live (Phase 21): a reused
        # transcript finished its step at once, and an ETA by steps done said 3 s with minutes to go. A
        # cached transcript or analysis never reports progress, a missing file's steps take no time, and
        # indexing is work. Seen live again (the follow-up's checks): with one pace for every stage, a few
        # seconds of indexing left read as 85 s, the pace of a 4K analysis.
        self.stage_seconds: dict[str, float] = {}
        self.stage_worked: dict[str, int] = {}
        self.step_began = time.monotonic()
        self.step_working = False

    def stage_of(self, step: int) -> str:
        """The stage step `step` is in: the run goes stage by stage, a step per file in each."""
        return str(
            self.options["stages"][min(step // len(self.options["paths"]), len(self.options["stages"]) - 1)]
        )

    def eta(self, within: float) -> float | None:
        """Seconds left: the step under way, from its own progress once it reports some (else its stage's
        pace), and each step after it at its stage's pace (a stage not yet timed takes the others' mean)."""
        if self.done >= self.steps:
            return 0.0
        paces = {s: self.stage_seconds[s] / n for s, n in self.stage_worked.items() if n}
        stage = self.stage_of(self.done)
        elapsed = time.monotonic() - self.step_began
        projected = elapsed / within if self.step_working and within > 0 else None
        fallback = sum(paces.values()) / len(paces) if paces else projected
        current = projected if projected is not None else paces.get(stage, fallback)
        if current is None:
            return None
        left = max(0.0, current - (elapsed if self.step_working else 0.0))
        for step in range(self.done + 1, self.steps):
            pace = paces.get(self.stage_of(step), fallback)
            if pace is None:
                return None
            left += pace
        return left

    def report(self, phase: str, within: float, detail: str) -> None:
        within = min(1.0, max(0.0, within))
        done = self.done + within
        eta = self.eta(within)
        if self.telemetry is not None and self.current_task is not None:
            subagent, agent_id, _, _ = STAGE_AGENTS[self.stage_of(self.done)]
            self.telemetry.progress(
                self.current_task,
                agent_id=agent_id,
                subagent=subagent,
                phase=phase,
                fraction=within,
                completed_items=self.done,
                total_items=self.steps,
                eta_seconds=eta,
                label=detail or None,
                parent=self.telemetry.root_task_id,
            )
        self.emitter.progress(
            done,
            self.steps,
            phase=phase,
            detail=detail,
            etaSeconds=round(eta, 1) if eta is not None else None,
        )

    def worker_report(self, name: str) -> Callable[[str, float, str], None]:
        """A worker's on_progress: it reports only while it works, so the step counts toward the ETA."""

        def report(phase: str, fraction: float, detail: str) -> None:
            self.step_working = True
            self.report(phase, fraction, f"{name}: {detail}")

        return report

    def check(self) -> None:
        if self.cancel.is_set():
            raise Cancelled

    def step(self, stage: str, path: str, entry: dict[str, Any], found: dict[str, Any]) -> None:
        """One file through one stage. `found` holds what its earlier stages made (`transcript`, `shots`)."""
        name = os.path.basename(path)
        use_cache = not self.options["force"]
        self.step_began = time.monotonic()
        self.step_working = stage == "index"
        errors_before = len(entry["errors"])
        self.observe_start(stage, path)
        try:
            if stage == "transcribe":
                self.report("transcribe", 0.0, f"Transcribing {name}")
                found["transcript"] = self.workers["whisper"].transcribe(
                    path,
                    model_tier=self.options["tier"],
                    enable_diarization=self.options["diarize"],
                    hf_token=self.options["hf_token"],
                    use_cache=use_cache,
                    on_progress=self.worker_report(name),
                )
                entry["segments"] = len(found["transcript"]["segments"])
            elif stage == "vision":
                self.report("vision", 0.0, f"Looking at {name}")
                found["shots"] = self.workers["vlm"].analyze(
                    path,
                    sample_strategy=self.options["strategy"],
                    use_cache=use_cache,
                    on_progress=self.worker_report(name),
                )
                entry["shots"] = len(found["shots"]["shots"])
            else:
                self.report("index", 0.0, f"Indexing {name}")
                store = self.workers["vector"]
                transcript, shots = found.get("transcript"), found.get("shots")
                if transcript is None and "transcribe" not in self.options["stages"]:
                    transcript = self.workers["whisper"].cached(path)
                if shots is None and "vision" not in self.options["stages"]:
                    shots = self.workers["vlm"].cached(path, self.options["strategy"])
                if transcript is not None:
                    entry["indexed"] += store.index_transcript(transcript)
                if shots is not None:
                    entry["indexed"] += store.index_shots(shots)
        except Exception as e:  # noqa: BLE001 - one stage failing is recorded on its file; the run goes on
            entry["errors"].append(f"{stage}: {e}")
        self.observe_end(stage, path, entry, entry["errors"][errors_before:])
        if self.step_working:
            self.stage_worked[stage] = self.stage_worked.get(stage, 0) + 1
            self.stage_seconds[stage] = (
                self.stage_seconds.get(stage, 0.0) + time.monotonic() - self.step_began
            )
        self.step_working = False
        self.done += 1

    def observe_start(self, stage: str, path: str) -> None:
        """SPAWN for one file's stage, after a handoff from its previous stage (Phase 22)."""
        if self.telemetry is None:
            return
        subagent, agent_id, label, _ = STAGE_AGENTS[stage]
        task_id = self.telemetry.next_task_id(stage[:3])
        stages = self.options["stages"]
        before = stages[stages.index(stage) - 1] if stages.index(stage) > 0 else None
        upstream = self.task_of.get((before, path)) if before else None
        self.task_of[(stage, path)] = task_id
        self.current_task = task_id
        self.telemetry.spawn(
            task_id,
            agent_id=agent_id,
            subagent=subagent,
            label=f"{label}: {os.path.basename(path)}",
            model_id=self.model_of(stage),
            backend="METAL_MPS",
            parent=self.telemetry.root_task_id,
            upstream=[upstream or self.telemetry.root_task_id],
            input_summary=path,
        )
        if upstream is not None and before is not None:
            from_subagent, from_agent, _, packet = STAGE_AGENTS[before]
            from_pair, to_pair = (from_agent, from_subagent), (agent_id, subagent)
        else:
            packet, from_pair, to_pair = "PROMPT_TOKENS", INGEST_AGENT, (agent_id, subagent)
        self.telemetry.handoff(
            upstream or self.telemetry.root_task_id,
            task_id,
            from_agent=from_pair,
            to_agent=to_pair,
            packet_type=packet,
            summary=os.path.basename(path),
        )

    def observe_end(self, stage: str, path: str, entry: dict[str, Any], errors: list[str]) -> None:
        if self.telemetry is None or self.current_task is None:
            return
        subagent, agent_id, _, _ = STAGE_AGENTS[stage]
        task_id, self.current_task = self.current_task, None
        parent = self.telemetry.root_task_id
        if errors:
            self.telemetry.failed(
                task_id, agent_id=agent_id, subagent=subagent, message=errors[0], parent=parent
            )
            return
        counts = {"transcribe": "segments", "vision": "shots", "index": "indexed"}
        latency_ms = (time.monotonic() - self.step_began) * 1000.0
        self.telemetry.completed(
            task_id,
            agent_id=agent_id,
            subagent=subagent,
            latency_ms=latency_ms,
            summary=f"{entry.get(counts[stage])} {counts[stage]}: {os.path.basename(path)}",
            parent=parent,
        )

    def model_of(self, stage: str) -> str:
        names = {"transcribe": "whisper_model", "vision": "vlm_model", "index": "embed_model"}
        return str(getattr(self.config, names[stage], ""))

    def run(self) -> list[dict[str, Any]]:
        if self.telemetry is not None:
            self.telemetry.ensure_root(model_id="ingest-index", agent_id=INGEST_AGENT[0])
        try:
            files = self._run()
        except Cancelled:
            if self.telemetry is not None:
                self.telemetry.failed(
                    self.telemetry.root_task_id,
                    agent_id=INGEST_AGENT[0],
                    subagent=INGEST_AGENT[1],
                    message="The ingest was stopped",
                    code="TASK_CANCELLED",
                )
            raise
        if self.telemetry is not None:
            self.telemetry.completed(
                self.telemetry.root_task_id,
                agent_id=INGEST_AGENT[0],
                subagent=INGEST_AGENT[1],
                latency_ms=0.0,
                summary=f"{len(files)} files, {sum(f['indexed'] for f in files)} indexed",
            )
        return files

    def _run(self) -> list[dict[str, Any]]:
        paths = self.options["paths"]
        entries = {
            path: {"path": path, "segments": None, "shots": None, "indexed": 0, "errors": []}
            for path in paths
        }
        found: dict[str, dict[str, Any]] = {path: {} for path in paths}
        present = {path: os.path.isfile(path) for path in paths}
        for path in paths:
            if not present[path]:
                entries[path]["errors"].append("The file isn't there (is its drive attached?)")
        for stage in self.options["stages"]:
            for path in paths:
                self.check()
                if present[path]:
                    self.step(stage, path, entries[path], found[path])
                else:
                    self.done += 1
        self.report("done", 0.0, "")
        return [entries[path] for path in paths]


def default_workers(config: OrchestratorConfig) -> dict[str, Any]:
    from vibecut_agent.workers.vector_store import VectorStore
    from vibecut_agent.workers.vlm_worker import VlmWorker
    from vibecut_agent.workers.whisper_worker import WhisperWorker

    return {"whisper": WhisperWorker(config), "vlm": VlmWorker(config), "vector": VectorStore(config)}


def run(
    request: dict[str, Any],
    emitter: Emitter,
    cancel: CancelFlag,
    config: OrchestratorConfig | None = None,
    make_workers: Callable[[OrchestratorConfig], dict[str, Any]] | None = None,
) -> int:
    from vibecut_agent.telemetry.instrument import for_process

    options = parse_request(request)
    config = config or OrchestratorConfig.from_env()
    telemetry = for_process("ing", root_label=f"Ingest {len(options['paths'])} files")
    ingest = Ingest(options, emitter, cancel, config, make_workers, telemetry)
    try:
        files = ingest.run()
    except Cancelled:
        emitter.emit("done", cancelled=True)
        return 0
    finally:
        if telemetry is not None:
            telemetry.bus.flush()
    emitter.emit(
        "result", files=files, indexPath=str(getattr(ingest.workers.get("vector"), "db_path", "")) or None
    )
    return 0 if any(not f["errors"] for f in files) else 1


def main(stdin: TextIO, emitter: Emitter) -> int:
    cancel = CancelFlag()
    cancel.install_sigterm_handler()
    return run(read_request(stdin), emitter, cancel)
