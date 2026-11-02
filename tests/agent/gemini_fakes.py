"""tests/agent/gemini_fakes.py — an in-process stand-in for the Gemini API's streamGenerateContent, so the
tests that drive gemini_chat's loop end to end (the orchestrated supervisor, the chat session) run with no
network. Install with `install(monkeypatch, replies)`: each call records its URL and parsed body and
plays the next reply (a `message(...)`, an HTTP status code to answer with, or an exception to raise)."""

from __future__ import annotations

import json
from types import SimpleNamespace
from typing import Any

from vibecut_agent.agent import gemini_chat


class FakeResponse:
    """A `requests` response to a `streamGenerateContent?alt=sse` call: the answer as one event."""

    def __init__(self, status_code: int, json_data: Any = None, text: str = "") -> None:
        self.status_code = status_code
        self._chunks = [json_data] if json_data is not None else []
        self.text = text

    def iter_lines(self, decode_unicode: bool = False):
        for chunk in self._chunks:
            yield f"data: {json.dumps(chunk)}"
            yield ""

    def close(self) -> None:
        pass


class FakeClient:
    def __init__(self, replies: list[Any]) -> None:
        self.replies = list(replies)
        self.requests: list[dict[str, Any]] = []
        self.urls: list[str] = []

    def post(self, url: str, *, data: str, **_kwargs: Any) -> FakeResponse:
        self.urls.append(url)
        self.requests.append(json.loads(data))
        reply = self.replies.pop(0)
        if isinstance(reply, Exception):
            raise reply
        if isinstance(reply, int):
            return FakeResponse(reply, text=f"HTTP {reply}")
        return FakeResponse(200, reply)


def install(monkeypatch, replies: list[Any]) -> FakeClient:
    client = FakeClient(replies)
    monkeypatch.setattr(gemini_chat, "_http_post", client.post)
    monkeypatch.setattr(gemini_chat, "_wait_before_retry", lambda *a, **k: None)
    return client


def fixed_ids(monkeypatch, *ids: str) -> None:
    """gemini_chat names each tool call with a random id; these tests name them `ids`, in order, so the
    app's answers can be queued ahead."""
    names = iter(ids)
    monkeypatch.setattr(gemini_chat, "uuid", SimpleNamespace(uuid4=lambda: SimpleNamespace(hex=next(names))))


def message(*parts: dict[str, Any], usage: dict[str, int] | None = None) -> dict[str, Any]:
    return {
        "candidates": [{"content": {"role": "model", "parts": list(parts)}, "finishReason": "STOP"}],
        "usageMetadata": usage or {"promptTokenCount": 10, "candidatesTokenCount": 5},
    }


def text(value: str) -> dict[str, Any]:
    return {"text": value}


def call(name: str, args: dict[str, Any]) -> dict[str, Any]:
    return {"functionCall": {"name": name, "args": args}}


def tool_names(request: dict[str, Any]) -> list[str]:
    return [d["name"] for tools in request.get("tools") or [] for d in tools["functionDeclarations"]]


def system_text(request: dict[str, Any]) -> str:
    return "".join(p.get("text", "") for p in request["systemInstruction"]["parts"])


def answered(request: dict[str, Any]) -> list[tuple[str, Any]]:
    """The functionResponse parts the request answered the previous step with: (name, result), in the
    order the model made the calls."""
    return [
        (p["functionResponse"]["name"], p["functionResponse"]["response"]["result"])
        for p in request["contents"][-1]["parts"]
        if "functionResponse" in p
    ]
