"""titles.py, the chat-title command (Phase 8d; model migration v2): the local Gemma names the chat when
it can, and the provider's quick tier at low effort when it can't. Every model is faked, so no network."""

from __future__ import annotations

import io
import json
from typing import Any

import pytest

from tests.workers.fakes import Client
from vibecut_agent.agent import titles
from vibecut_agent.protocol import Emitter, RequestError
from vibecut_agent.story import models
from vibecut_agent.workers import base


class Capture:
    def __init__(self) -> None:
        self.buffer = io.StringIO()
        self.emitter = Emitter(self.buffer)

    def events(self) -> list[dict[str, Any]]:
        return [json.loads(line) for line in self.buffer.getvalue().splitlines()]


@pytest.fixture(autouse=True)
def no_local_model(monkeypatch: pytest.MonkeyPatch) -> None:
    """The cloud tests below never reach a real local server; the local tests replace this."""
    monkeypatch.setattr(titles, "local_title", lambda text: None)


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


def test_each_provider_uses_its_quick_tier_at_low_effort(monkeypatch: pytest.MonkeyPatch) -> None:
    seen: dict[str, Any] = {}

    def fake(name: str):
        def call(*args: Any, **kwargs: Any) -> dict[str, Any]:
            seen[name] = (args, kwargs)
            return {"title": f"{name} title."}

        return call

    monkeypatch.setattr(models, "gemini_json", fake("gemini"))
    monkeypatch.setattr(models, "claude_code_json_answer", fake("code"))

    for request, expected, model in [
        (
            {"apiKey": "g", "model": "gemini-3.1-pro-preview", "request": "Mark the hook"},
            "gemini title",
            "gemini-3.8-flash",
        ),
        (
            {
                "provider": "claude-code",
                "claudeCode": {"program": "/x"},
                "model": "claude-opus-5-5",
                "request": "Mark it",
                "reply": "Done",
            },
            "code title",
            "claude-sonnet-5-5",
        ),
    ]:
        cap = Capture()
        assert titles.run(request, cap.emitter) == 0
        assert cap.events()[-1] == {"type": "result", "title": expected, "model": model}

    # Never the chat's Opus or Pro: a title isn't worth that quota.
    assert seen["gemini"][0][4] == "gemini-3.8-flash" and seen["gemini"][1]["effort"] == "low"
    assert seen["code"][0][4] == "claude-sonnet-5-5" and seen["code"][1]["effort"] == "low"
    assert "The assistant answered:\nDone" in seen["code"][0][2]


def test_no_key_no_setup_or_no_request_is_refused() -> None:
    with pytest.raises(RequestError, match="No Gemini API key"):
        titles.run({"request": "x"}, Capture().emitter)
    with pytest.raises(RequestError, match="Claude Code isn't set up"):
        titles.run({"provider": "claude-code", "request": "x"}, Capture().emitter)
    with pytest.raises(RequestError, match="Unknown provider"):
        titles.run({"provider": "antigravity", "request": "x"}, Capture().emitter)
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


# ------------------------------------------------------------------------------ the local Gemma


@pytest.fixture
def local(monkeypatch: pytest.MonkeyPatch, tmp_path) -> Any:
    """The real local_title, with the local server faked and the GPU lock in a test folder."""
    monkeypatch.undo()
    monkeypatch.setenv("VIBECUT_INDEX_DIR", str(tmp_path))
    monkeypatch.delenv("VIBECUT_GEMMA_MODEL", raising=False)

    def install(client: Client) -> Client:
        monkeypatch.setattr(base, "LocalLlmClient", lambda *a, **k: client)
        return client

    return install


def test_the_local_gemma_names_the_chat_and_no_cloud_model_is_asked(monkeypatch, local) -> None:
    client = local(Client([{"title": "Bakery hook."}], models=("gemma3:4b",)))
    monkeypatch.setattr(models, "gemini_json", lambda *a, **k: pytest.fail("the cloud was asked"))
    cap = Capture()

    assert titles.run({"apiKey": "k", "request": "Find the bakery hook"}, cap.emitter) == 0

    assert cap.events()[-1] == {"type": "result", "title": "Bakery hook", "model": "gemma3:4b"}
    assert client.prompts[0][0] == "gemma3:4b" and "bakery hook" in client.prompts[0][1]
    assert client.keep_alive == [titles.LOCAL_KEEP_ALIVE]


def test_the_local_prompt_has_no_list_to_copy_and_shows_examples(local) -> None:
    client = local(Client([{"title": "Hook"}], models=("gemma3:4b",)))
    titles.local_title("x")
    assert "past chats" not in titles.LOCAL_SYSTEM.lower() and "Examples:" in titles.LOCAL_SYSTEM
    assert client.prompts[0][1] == "x"
    assert not titles.copies_the_prompt("Grady Dining Hall Marks")
    assert not titles.copies_the_prompt("Chapel Talk Instagram Cut")


def test_an_older_gemma_tag_stands_in(local) -> None:
    local(Client([{"title": "Hook"}], models=("gemma3:4b-it",)))
    assert titles.local_title("x") == ("Hook", "gemma3:4b-it")


def test_no_local_model_a_busy_gpu_or_a_bad_answer_falls_to_the_cloud(monkeypatch, local, tmp_path) -> None:
    local(Client([{"title": "Hook"}], models=()))
    assert titles.local_title("x") is None

    local(Client([base.LocalLlmError("server down")], models=("gemma3:4b",)))
    assert titles.local_title("x") is None

    local(Client([{"title": "  "}], models=("gemma3:4b",)))
    assert titles.local_title("x") is None

    # Seen live: Gemma named the chat after the list it was for.
    for copied in ("Past Chats - Dining Hall Project", "Past Chats", "Chat about the cut", "Conversation"):
        local(Client([{"title": copied}], models=("gemma3:4b",)))
        assert titles.local_title("x") is None, copied

    client = local(Client([{"title": "Hook"}], models=("gemma3:4b",)))
    with base.GpuLock(tmp_path):
        assert titles.local_title("x") is None, "an ingest has the GPU: don't wait for it"
    assert client.prompts == []

    monkeypatch.setattr(models, "gemini_json", lambda *a, **k: {"title": "Cloud hook"})
    monkeypatch.setattr(titles, "local_title", lambda text: None)
    cap = Capture()
    assert titles.run({"apiKey": "k", "request": "x"}, cap.emitter) == 0
    assert cap.events()[-1]["model"] == "gemini-3.8-flash"
