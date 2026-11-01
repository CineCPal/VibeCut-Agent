"""Phase 21's execution-mode toggle (config.py): `direct` unless asked otherwise, and `direct`'s turn
runners returned untouched."""

import pytest

from vibecut_agent.agent import claude_chat, gemini_chat
from vibecut_agent.config import ExecutionMode, OrchestratorConfig, resolve_chat_turn_runner

ENV_NAMES = [
    "VIBECUT_EXECUTION_MODE",
    "EXECUTION_MODE",
    "VIBECUT_LOCAL_LLM_BASE_URL",
    "VIBECUT_GEMMA_MODEL",
    "VIBECUT_VLM_MODEL",
    "VIBECUT_WHISPER_BACKEND",
    "VIBECUT_WHISPER_MODEL",
    "VIBECUT_WHISPER_CPP_BIN",
    "VIBECUT_VECTOR_BACKEND",
    "VIBECUT_EMBED_MODEL",
    "VIBECUT_INDEX_DIR",
]


@pytest.fixture(autouse=True)
def clean_env(monkeypatch):
    for name in ENV_NAMES:
        monkeypatch.delenv(name, raising=False)


def test_direct_by_default_with_the_spec_defaults():
    config = OrchestratorConfig.from_env()
    assert config.execution_mode is ExecutionMode.DIRECT
    assert config.local_llm_base_url == "http://127.0.0.1:11434"
    assert config.gemma_model == "gemma3:4b-it"
    assert config.vlm_model == "qwen2.5-vl:7b-instruct"
    assert config.whisper_backend == "mlx-whisper"
    assert config.whisper_model == "mlx-community/whisper-medium-mlx"
    assert config.whisper_cpp_bin == "/opt/homebrew/bin/whisper-cli"
    assert config.vector_backend == "sqlite-vec"
    assert config.embed_model == "BAAI/bge-m3"
    assert config.index_dir.endswith("Library/Application Support/VibeCut Agent/vector-index")


def test_execution_mode_sources_in_order(monkeypatch):
    monkeypatch.setenv("EXECUTION_MODE", "orchestrated")
    assert OrchestratorConfig.from_env().execution_mode is ExecutionMode.ORCHESTRATED
    monkeypatch.setenv("VIBECUT_EXECUTION_MODE", "direct")
    assert OrchestratorConfig.from_env().execution_mode is ExecutionMode.DIRECT
    assert OrchestratorConfig.from_env("orchestrated").execution_mode is ExecutionMode.ORCHESTRATED


@pytest.mark.parametrize(
    ("raw", "mode"),
    [
        ("  Orchestrated \n", ExecutionMode.ORCHESTRATED),
        ("ORCHESTRATED", ExecutionMode.ORCHESTRATED),
        ("supervised", ExecutionMode.DIRECT),
        ("", ExecutionMode.DIRECT),
    ],
)
def test_unknown_modes_fall_back_to_direct(monkeypatch, raw, mode):
    monkeypatch.setenv("VIBECUT_EXECUTION_MODE", raw)
    assert OrchestratorConfig.from_env().execution_mode is mode


def test_worker_settings_come_from_the_environment(monkeypatch, tmp_path):
    monkeypatch.setenv("VIBECUT_INDEX_DIR", str(tmp_path))
    monkeypatch.setenv("VIBECUT_WHISPER_BACKEND", "faster-whisper")
    monkeypatch.setenv("VIBECUT_VECTOR_BACKEND", "lancedb")
    config = OrchestratorConfig.from_env()
    assert config.index_dir == str(tmp_path)
    assert config.whisper_backend == "faster-whisper"
    assert config.vector_backend == "lancedb"


def test_direct_mode_returns_the_existing_turn_runners():
    config = OrchestratorConfig.from_env("direct")
    assert resolve_chat_turn_runner("claude", config) is claude_chat.run_chat_turn
    assert resolve_chat_turn_runner("gemini", config) is gemini_chat.run_chat_turn


def test_orchestrated_mode_only_changes_claude():
    config = OrchestratorConfig.from_env("orchestrated")
    assert resolve_chat_turn_runner("gemini", config) is gemini_chat.run_chat_turn
