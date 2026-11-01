"""The `ingest-index` command (ORCHESTRATOR_SPEC.md §1.2 Plane A; PLAN.md, "Phase 21"): media files made
searchable for the orchestrated chat.

request: {"paths": [absolute media files], "stages": ["transcribe", "vision", "index"] (default all),
          "sampleStrategy": "scene_cuts" | "uniform_2s" | "midpoint_only", "modelTier": optional Whisper tier,
          "diarize": bool, "hfToken" (from Rust, only with diarize), "force": bool (ignore the caches)}
events:  progress {fraction, phase, detail, etaSeconds}; result {"files": [{path, segments, shots, indexed,
          errors}], "indexPath"}

Files go one at a time, each through its stages in order: the Whisper transcript (whisper_worker), the
shots (vlm_worker), then both into the vector store (vector_store). Each stage holds the GPU lock only while
its model runs. A stage that fails is recorded on its file and the next stage or file goes on; a file with
no picture just has no shots. Stopping (SIGTERM) ends after the stage that is running."""

from __future__ import annotations

import os
import time
from collections.abc import Callable
from typing import Any, TextIO

from vibecut_agent.config import OrchestratorConfig
from vibecut_agent.core.ffmpeg_ops import SAMPLE_STRATEGIES
from vibecut_agent.protocol import CancelFlag, Emitter, RequestError, read_request, require_absolute_paths
from vibecut_agent.workers.whisper_worker import TIERS

STAGES = ("transcribe", "vision", "index")
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
    ) -> None:
        self.options = options
        self.emitter = emitter
        self.cancel = cancel
        self.config = config
        self.workers = (make_workers or default_workers)(config)
        self.steps = len(options["paths"]) * len(options["stages"])
        self.done = 0
        self.began = time.monotonic()

    def report(self, phase: str, within: float, detail: str) -> None:
        done = self.done + min(1.0, max(0.0, within))
        elapsed = time.monotonic() - self.began
        eta = elapsed * (self.steps - done) / done if done > 0 else None
        self.emitter.progress(
            done,
            self.steps,
            phase=phase,
            detail=detail,
            etaSeconds=round(eta, 1) if eta is not None else None,
        )

    def check(self) -> None:
        if self.cancel.is_set():
            raise Cancelled

    def file(self, path: str) -> dict[str, Any]:
        name = os.path.basename(path)
        entry: dict[str, Any] = {"path": path, "segments": None, "shots": None, "indexed": 0, "errors": []}
        transcript: dict[str, Any] | None = None
        shots: dict[str, Any] | None = None
        use_cache = not self.options["force"]
        if not os.path.isfile(path):
            entry["errors"].append("The file isn't there (is its drive attached?)")
            self.done += len(self.options["stages"])
            return entry
        for stage in self.options["stages"]:
            self.check()
            try:
                if stage == "transcribe":
                    self.report("transcribe", 0.0, f"Transcribing {name}")
                    transcript = self.workers["whisper"].transcribe(
                        path,
                        model_tier=self.options["tier"],
                        enable_diarization=self.options["diarize"],
                        hf_token=self.options["hf_token"],
                        use_cache=use_cache,
                        on_progress=lambda phase, f, detail: self.report(phase, f, f"{name}: {detail}"),
                    )
                    entry["segments"] = len(transcript["segments"])
                elif stage == "vision":
                    self.report("vision", 0.0, f"Looking at {name}")
                    shots = self.workers["vlm"].analyze(
                        path,
                        sample_strategy=self.options["strategy"],
                        use_cache=use_cache,
                        on_progress=lambda phase, f, detail: self.report(phase, f, f"{name}: {detail}"),
                    )
                    entry["shots"] = len(shots["shots"])
                else:
                    self.report("index", 0.0, f"Indexing {name}")
                    store = self.workers["vector"]
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
            self.done += 1
        return entry

    def run(self) -> list[dict[str, Any]]:
        files = []
        for path in self.options["paths"]:
            files.append(self.file(path))
        self.report("done", 0.0, "")
        return files


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
    options = parse_request(request)
    config = config or OrchestratorConfig.from_env()
    ingest = Ingest(options, emitter, cancel, config, make_workers)
    try:
        files = ingest.run()
    except Cancelled:
        emitter.emit("done", cancelled=True)
        return 0
    emitter.emit(
        "result", files=files, indexPath=str(getattr(ingest.workers.get("vector"), "db_path", "")) or None
    )
    return 0 if any(not f["errors"] for f in files) else 1


def main(stdin: TextIO, emitter: Emitter) -> int:
    cancel = CancelFlag()
    cancel.install_sigterm_handler()
    return run(read_request(stdin), emitter, cancel)
