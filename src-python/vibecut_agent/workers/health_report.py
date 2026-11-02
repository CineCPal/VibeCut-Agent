"""The `orchestrator-health` command (ORCHESTRATOR_SPEC.md §2, the About modal; PLAN.md, "Phase 21"): the
execution mode, and in orchestrated mode each local worker's health.

request: {} (nothing)
result:  {executionMode: "direct" | "orchestrated", workers: [WorkerHealth], localLlmBaseUrl, indexDir}

In direct mode no worker is loaded and `workers` is empty. In orchestrated mode each worker is built and
asked (the model server's model list, the Whisper backend's package, sqlite-vec); one that can't even
be built is reported unavailable with the reason. Nothing is downloaded or indexed."""

from __future__ import annotations

from collections.abc import Callable
from typing import Any, TextIO

from vibecut_agent.config import ExecutionMode, OrchestratorConfig
from vibecut_agent.protocol import Emitter
from vibecut_agent.workers.base import LocalWorker, WorkerHealth

WORKERS = ("whisper", "vlm", "vector", "gemma")


def default_builders(config: OrchestratorConfig) -> dict[str, Callable[[], LocalWorker]]:
    def whisper() -> LocalWorker:
        from vibecut_agent.workers.whisper_worker import WhisperWorker

        return WhisperWorker(config)

    def vlm() -> LocalWorker:
        from vibecut_agent.workers.vlm_worker import VlmWorker

        return VlmWorker(config)

    def vector() -> LocalWorker:
        from vibecut_agent.workers.vector_store import VectorStore

        return VectorStore(config)

    def gemma() -> LocalWorker:
        from vibecut_agent.workers.gemma_validator import GemmaValidator

        return GemmaValidator(config)

    return {"whisper": whisper, "vlm": vlm, "vector": vector, "gemma": gemma}


def report(
    config: OrchestratorConfig, builders: dict[str, Callable[[], LocalWorker]] | None = None
) -> dict[str, Any]:
    result: dict[str, Any] = {
        "executionMode": config.execution_mode.value,
        "workers": [],
        "localLlmBaseUrl": config.local_llm_base_url,
        "indexDir": config.index_dir,
    }
    if config.execution_mode is ExecutionMode.DIRECT:
        return result
    builders = builders or default_builders(config)
    for name in WORKERS:
        try:
            health: WorkerHealth = builders[name]().health()
        except Exception as e:  # noqa: BLE001 - a worker that can't be built is reported, not fatal
            health = {
                "worker": name,
                "backend": "",
                "model": "",
                "available": False,
                "detail": f"couldn't start: {e}",
            }
        result["workers"].append(health)
    return result


def main(stdin: TextIO, emitter: Emitter) -> int:
    emitter.emit("result", **report(OrchestratorConfig.from_env()))
    return 0
