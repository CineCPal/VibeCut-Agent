"""The `orchestrator-health` command (workers/health_report.py): the mode, and each worker's health."""

from __future__ import annotations

import io
import json

from vibecut_agent.config import OrchestratorConfig
from vibecut_agent.headless import dispatch
from vibecut_agent.protocol import Emitter
from vibecut_agent.workers import health_report


class Healthy:
    def __init__(self, name):
        self.name = name

    def health(self):
        return {"worker": self.name, "backend": "b", "model": "m", "available": True, "detail": "ready"}


def test_direct_mode_loads_no_worker(monkeypatch):
    def refuse():
        raise AssertionError("no worker should be built in direct mode")

    result = health_report.report(
        OrchestratorConfig.from_env("direct"), {name: refuse for name in health_report.WORKERS}
    )
    assert result["executionMode"] == "direct"
    assert result["workers"] == []
    assert result["localLlmBaseUrl"] and result["indexDir"]


def test_orchestrated_mode_asks_each_worker_and_reports_one_that_cant_start():
    def broken():
        raise ImportError("No module named 'sqlite_vec'")

    builders = {
        "whisper": lambda: Healthy("whisper"),
        "vlm": lambda: Healthy("vlm"),
        "vector": broken,
        "gemma": lambda: Healthy("gemma"),
    }
    result = health_report.report(OrchestratorConfig.from_env("orchestrated"), builders)
    assert result["executionMode"] == "orchestrated"
    assert [w["worker"] for w in result["workers"]] == ["whisper", "vlm", "vector", "gemma"]
    assert result["workers"][2] == {
        "worker": "vector",
        "backend": "",
        "model": "",
        "available": False,
        "detail": "couldn't start: No module named 'sqlite_vec'",
    }


def test_the_command_answers_with_its_result(monkeypatch):
    monkeypatch.delenv("EXECUTION_MODE", raising=False)
    monkeypatch.delenv("VIBECUT_EXECUTION_MODE", raising=False)
    out = io.StringIO()
    assert dispatch("orchestrator-health", Emitter(out), io.StringIO("{}\n")) == 0
    [event] = [json.loads(line) for line in out.getvalue().splitlines()]
    assert event["type"] == "result"
    assert event["executionMode"] == "direct"
    assert event["workers"] == []
