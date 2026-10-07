"""titles.py, the chat-title command (Phase 8d): the provider's helper is faked, so no network."""

from __future__ import annotations

import io
import json
from typing import Any

import pytest

from vibecut_agent.agent import titles
from vibecut_agent.protocol import Emitter, RequestError
from vibecut_agent.story import models


class Capture:
    def __init__(self) -> None:
        self.buffer = io.StringIO()
        self.emitter = Emitter(self.buffer)

    def events(self) -> list[dict[str, Any]]:
        return [json.loads(line) for line in self.buffer.getvalue().splitlines()]


@pytest.mark.parametrize(
    ("raw", "clean"),
    [
        ('"Bakery interview rough cut."', "Bakery interview rough cut"),
        ("  Duck music\n under   dialogue ", "Duck music under dialogue"),
        ("**Marker pass**", "Marker pass"),
        ("x" * 80, "x" * 59 + "…"),
        ("   ", ""),
        (None, ""),
        (42, ""),
    ],
)
def test_names_are_cleaned_to_one_short_line(raw: Any, clean: str) -> None:
    assert titles.clean_title(raw) == clean


def test_the_request_and_reply_are_cut_to_size() -> None:
    text = titles.user_text("q" * 5000, "z" * 5000)
    assert text.count("q") == titles.REQUEST_CHARS
    assert text.count("z") == titles.REPLY_CHARS
    assert "answered" not in titles.user_text("trim it", "  ")


def test_each_provider_uses_its_own_helper_at_low_effort(monkeypatch: pytest.MonkeyPatch) -> None:
    seen: dict[str, Any] = {}

    def fake(name: str):
        def call(*args: Any, **kwargs: Any) -> dict[str, Any]:
            seen[name] = (args, kwargs)
            return {"title": f"{name} title."}

        return call

    monkeypatch.setattr(models, "gemini_json", fake("gemini"))
    monkeypatch.setattr(models, "claude_json", fake("claude"))
    monkeypatch.setattr(models, "claude_code_json_answer", fake("code"))

    for request, expected in [
        ({"apiKey": "g", "request": "Mark the hook"}, "gemini title"),
        ({"provider": "claude", "apiKey": "c", "model": "claude-opus-5-5", "request": "Mark it", "reply": "Done"}, "claude title"),
        ({"provider": "claude-code", "claudeCode": {"program": "/x"}, "request": "Mark it"}, "code title"),
    ]:
        cap = Capture()
        assert titles.run(request, cap.emitter) == 0
        assert cap.events()[-1] == {"type": "result", "title": expected}

    assert seen["claude"][1]["effort"] == "low"
    assert seen["claude"][0][4] == "claude-opus-5-5", "the chat's own model"
    assert seen["code"][1]["effort"] == "low"
    assert "The assistant answered:\nDone" in seen["claude"][0][2]


def test_no_key_no_setup_or_no_request_is_refused() -> None:
    with pytest.raises(RequestError, match="No Gemini API key"):
        titles.run({"request": "x"}, Capture().emitter)
    with pytest.raises(RequestError, match="Claude Code isn't set up"):
        titles.run({"provider": "claude-code", "request": "x"}, Capture().emitter)
    with pytest.raises(RequestError, match="first message"):
        titles.run({"apiKey": "k", "request": "  "}, Capture().emitter)


def test_a_failed_or_empty_answer_is_an_error_without_the_key(monkeypatch: pytest.MonkeyPatch) -> None:
    def boom(*a: Any, **k: Any) -> dict[str, Any]:
        raise models.StoryModelError("HTTP 500 for key secret-key")

    monkeypatch.setattr(models, "gemini_json", boom)
    cap = Capture()
    assert titles.run({"apiKey": "secret-key", "request": "x"}, cap.emitter) == 1
    error = cap.events()[-1]
    assert error["type"] == "error" and "secret-key" not in error["message"]

    monkeypatch.setattr(models, "gemini_json", lambda *a, **k: {"title": "  "})
    cap = Capture()
    assert titles.run({"apiKey": "k", "request": "x"}, cap.emitter) == 1
    assert "usable name" in cap.events()[-1]["message"]
