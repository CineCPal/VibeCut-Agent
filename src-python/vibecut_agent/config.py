"""Runtime configuration and Dual-Mode Execution Factory for VibeCut Agent."""

from __future__ import annotations

import os
from collections.abc import Callable
from dataclasses import dataclass
from enum import StrEnum
from typing import Any, Literal


class ExecutionMode(StrEnum):
    DIRECT = "direct"
    ORCHESTRATED = "orchestrated"


# How a proposed OTIO delta is checked (model migration v2): "deterministic" is otio_delta's own
# structural, collision, lock and channel checks alone; "llm" adds the local Gemma's editorial review.
ValidatorMode = Literal["deterministic", "llm"]


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
    validator_mode: ValidatorMode = "deterministic"

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
            gemma_model=os.environ.get("VIBECUT_GEMMA_MODEL", "gemma3:4b"),
            vlm_model=os.environ.get("VIBECUT_VLM_MODEL", "qwen3-vl:8b"),
            whisper_backend=os.environ.get("VIBECUT_WHISPER_BACKEND", "mlx-whisper"),
            whisper_model=os.environ.get("VIBECUT_WHISPER_MODEL", "mlx-community/whisper-large-v3-turbo"),
            whisper_cpp_bin=os.environ.get("VIBECUT_WHISPER_CPP_BIN", "/opt/homebrew/bin/whisper-cli"),
            vector_backend=os.environ.get("VIBECUT_VECTOR_BACKEND", "sqlite-vec"),
            embed_model=os.environ.get("VIBECUT_EMBED_MODEL", "BAAI/bge-m3"),
            index_dir=os.environ.get("VIBECUT_INDEX_DIR", default_index),
            validator_mode=(
                "llm"
                if os.environ.get("VIBECUT_VALIDATOR_MODE", "").strip().lower() == "llm"
                else "deterministic"
            ),
        )


def resolve_chat_turn_runner(
    provider: str,
    config: OrchestratorConfig,
) -> Callable[..., dict[str, Any]]:
    """Factory returning the Gemini API chat's turn runner for `agent/chat.py` ("claude-code" has its own,
    there and in mcp_server.py).

    - ExecutionMode.DIRECT: returns `gemini_chat.run_chat_turn` untouched.
    - ExecutionMode.ORCHESTRATED: returns `orchestrator.supervisor.run_orchestrated_turn`, which intercepts
      orchestrator tool calls in-process via `ToolBus` and delegates NLE commits back through the host channel.
    """
    if provider != "gemini":
        raise ValueError(f"Unknown chat provider: {provider!r}")

    if config.execution_mode == ExecutionMode.ORCHESTRATED:
        from vibecut_agent.orchestrator.supervisor import make_orchestrated_turn_runner

        return make_orchestrated_turn_runner(config)

    from vibecut_agent.agent import gemini_chat

    return gemini_chat.run_chat_turn
