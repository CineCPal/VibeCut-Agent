"""Stand-ins for the local model server, for the workers' tests."""

from __future__ import annotations

import json
from typing import Any

from vibecut_agent.workers.base import MODEL_ALIASES


class Response:
    def __init__(self, status_code: int, body: Any = None, text: str | None = None) -> None:
        self.status_code = status_code
        self._body = body
        self.text = text if text is not None else json.dumps(body)

    def json(self) -> Any:
        if self._body is None:
            raise ValueError("no JSON")
        return self._body


class Session:
    """Answers POST/GET by route from `routes` (a route -> Response, or a callable of the JSON body)."""

    def __init__(self, routes: dict[str, Any]) -> None:
        self.routes = routes
        self.calls: list[tuple[str, Any]] = []

    def _answer(self, url: str, body: Any) -> Response:
        route = "/" + url.split("/", 3)[3]
        self.calls.append((route, body))
        answer = self.routes.get(route, Response(404, text="not found"))
        return answer(body) if callable(answer) else answer

    def post(self, url: str, json: Any = None, timeout: float | None = None) -> Response:
        return self._answer(url, json)

    def get(self, url: str, timeout: float | None = None) -> Response:
        return self._answer(url, None)


class Client:
    """A LocalLlmClient stand-in: `answers` are returned by chat_json in turn (an Exception is raised)."""

    def __init__(self, answers: list[Any] | None = None, models: tuple[str, ...] = ()) -> None:
        self.answers = list(answers or [])
        self.models = models
        self.prompts: list[tuple[str, str, list[str]]] = []
        self.keep_alive: list[Any] = []
        self.think: list[Any] = []

    def chat_json(
        self,
        model: str,
        prompt: str,
        schema: dict[str, Any],
        *,
        images: Any = (),
        system: Any = None,
        keep_alive: Any = None,
        think: Any = None,
    ) -> Any:
        self.prompts.append((model, prompt, [str(i) for i in images]))
        self.keep_alive.append(keep_alive)
        self.think.append(think)
        answer = self.answers.pop(0) if len(self.answers) > 1 else self.answers[0]
        if isinstance(answer, Exception):
            raise answer
        return json.loads(json.dumps(answer))

    def has_model(self, model: str) -> tuple[bool, str]:
        return (model in self.models, "ready" if model in self.models else "missing")

    def resolve_available_model(self, preferred: str) -> str:
        """LocalLlmClient's: `preferred`, or the first of its aliases this server has."""
        for candidate in (preferred, *MODEL_ALIASES.get(preferred, ())):
            if candidate in self.models:
                return candidate
        return preferred
