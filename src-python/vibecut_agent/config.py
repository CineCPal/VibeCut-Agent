"""Runtime configuration and Dual-Mode Execution Factory for VibeCut Agent."""

from __future__ import annotations

import os
from collections.abc import Callable
from dataclasses import dataclass
from enum import StrEnum
from typing import Any


class ExecutionMode(StrEnum):
    DIRECT = "direct"
    ORCHESTRATED = "orchestrated"


@dataclass(frozen=True)
class OrchestratorConfig:
    execution_mode: ExecutionMode
    local_llm_base_url: str
    gemma_model: str
    vlm_model: str
    whisper_backend: str
    whisper_model: str
    whisper_cpp_bin: str
    vector_backend: str
    embed_model: str
    index_dir: str

    @classmethod
    def from_env(cls, request_override: str | None = None) -> OrchestratorConfig:
        raw_mode = (
            (
                request_override
                or os.environ.get("VIBECUT_EXECUTION_MODE")
                or os.environ.get("EXECUTION_MODE")
                or "direct"
            )
            .strip()
            .lower()
        )
        mode = (
            ExecutionMode.ORCHESTRATED
            if raw_mode == ExecutionMode.ORCHESTRATED.value
            else ExecutionMode.DIRECT
        )
        default_index = os.path.expanduser("~/Library/Application Support/VibeCut Agent/vector-index")
        return cls(
            execution_mode=mode,
            local_llm_base_url=os.environ.get("VIBECUT_LOCAL_LLM_BASE_URL", "http://127.0.0.1:11434"),
            gemma_model=os.environ.get("VIBECUT_GEMMA_MODEL", "gemma3:4b-it"),
            vlm_model=os.environ.get("VIBECUT_VLM_MODEL", "qwen2.5-vl:7b-instruct"),
            whisper_backend=os.environ.get("VIBECUT_WHISPER_BACKEND", "mlx-whisper"),
            whisper_model=os.environ.get("VIBECUT_WHISPER_MODEL", "mlx-community/whisper-medium-mlx"),
            whisper_cpp_bin=os.environ.get("VIBECUT_WHISPER_CPP_BIN", "/opt/homebrew/bin/whisper-cli"),
            vector_backend=os.environ.get("VIBECUT_VECTOR_BACKEND", "sqlite-vec"),
            embed_model=os.environ.get("VIBECUT_EMBED_MODEL", "BAAI/bge-m3"),
            index_dir=os.environ.get("VIBECUT_INDEX_DIR", default_index),
        )


def resolve_chat_turn_runner(
    provider: str,
    config: OrchestratorConfig,
) -> Callable[..., dict[str, Any]]:
    """Factory returning the turn runner for `agent/chat.py`.

    - ExecutionMode.DIRECT: returns the existing `claude_chat.run_chat_turn` or `gemini_chat.run_chat_turn` untouched.
    - ExecutionMode.ORCHESTRATED: returns `orchestrator.supervisor.run_orchestrated_turn`, which intercepts
      orchestrator tool calls in-process via `ToolBus` and delegates NLE commits back through the host channel.
    """
    if config.execution_mode == ExecutionMode.ORCHESTRATED and provider == "claude":
        # supervisor.py lands in Phase 4 (ORCHESTRATOR_SPEC.md §5); strict mypy's warn_unused_ignores
        # flags this ignore once it exists, so it is removed then.
        from vibecut_agent.orchestrator.supervisor import (  # type: ignore[import-not-found]
            make_orchestrated_turn_runner,
        )

        return make_orchestrated_turn_runner(config)  # type: ignore[no-any-return]

    if provider == "claude":
        from vibecut_agent.agent import claude_chat

        return claude_chat.run_chat_turn

    from vibecut_agent.agent import gemini_chat

    return gemini_chat.run_chat_turn
