"""Stand-ins for the orchestrator's tests: the app's side of the chat (its read-only tools answered from a
HostTimeline snapshot as src/lib/agent/tools.ts answers them, `commit_otio_delta` recorded), a worker, and a
tool bus built on them with the real validator (its Gemma off)."""

from __future__ import annotations

import copy
from typing import Any

from tests.workers.fakes import Client
from vibecut_agent.orchestrator.tool_bus import OrchestratorToolBus
from vibecut_agent.workers.base import LocalLlmError
from vibecut_agent.workers.gemma_validator import GemmaValidator


class App:
    def __init__(self, snapshot: dict[str, Any], commit_result: Any = None) -> None:
        self.snapshot = snapshot
        self.commit_result = commit_result if commit_result is not None else {"committed": True}
        self.calls: list[tuple[str, dict[str, Any]]] = []
        self.fail: dict[str, str] = {}

    def answer(self, name: str, args: dict[str, Any]) -> Any:
        self.calls.append((name, copy.deepcopy(args)))
        if name in self.fail:
            return {"error": self.fail[name]}
        if name == "list_timelines":
            return {
                "project": self.snapshot["project"],
                "timelines": [self.snapshot["timeline"]],
                "open": self.snapshot["timeline"],
            }
        if name == "list_timeline_clips":
            assert args == {"detail": True}
            letters = {"video": "V", "audio": "A", "subtitle": "S"}
            return {
                "fps": self.snapshot["fps"],
                "duration": 20,
                "tracks": [
                    {
                        "track": f"{letters[t['type']]}{t['index']}",
                        "name": t.get("name", ""),
                        "enabled": True,
                        "clips": copy.deepcopy(t["clips"]),
                    }
                    for t in self.snapshot["tracks"]
                ],
            }
        if name == "list_markers":
            return {"markers": []}
        if name == "commit_otio_delta":
            return self.commit_result
        return {"error": f"Unknown tool: {name}"}

    def call_app(self, calls: list[tuple[str, dict[str, Any]]]) -> list[Any]:
        return [self.answer(name, args) for name, args in calls]

    def names(self) -> list[str]:
        return [name for name, _ in self.calls]


class Worker:
    """Records each call; answers with `answer` (an Exception is raised)."""

    def __init__(self, answer=None):
        self.answer = answer if answer is not None else {"ok": True}
        self.calls = []

    def _call(self, method, *args, **kwargs):
        self.calls.append((method, args, kwargs))
        if isinstance(self.answer, Exception):
            raise self.answer
        return self.answer

    def search(self, *args, **kwargs):
        return self._call("search", *args, **kwargs)

    def transcribe(self, *args, **kwargs):
        kwargs["on_progress"]("transcribe", 0.5, "half way")
        return self._call("transcribe", *args, **kwargs)

    def analyze(self, *args, **kwargs):
        return self._call("analyze", *args, **kwargs)


def make_bus(config, tmp_path, app=None, **workers):
    validator = GemmaValidator(
        config, client=Client([LocalLlmError("off")]), key=b"k" * 32, media_duration=lambda path: 60.0
    )
    built = {"validator": validator, **workers}

    def builder(name):
        def build():
            if name not in built:
                raise AssertionError(f"the {name} worker shouldn't be needed")
            return built[name]

        return build

    bus = OrchestratorToolBus(
        config,
        workers={name: builder(name) for name in ("whisper", "vlm", "vector", "validator")},
        measure_loudness=lambda path, start, end: {"integratedLufs": -23.0, "path": path},
        otio_dir=tmp_path / "otio_deltas",
    )
    if app is not None:
        bus.call_app = app.call_app
    statuses = []
    bus.status = statuses.append
    bus.statuses = statuses  # type: ignore[attr-defined]
    return bus
