"""Ported from VibeCut's tests/test_headless_chat.py: the "chat" command end to end: the interactive,
line-by-line stdin protocol (Tool::interactive_commands on the Rust side), with requests.post faked
(no network)."""

import io
import json
import queue
import uuid

import pytest

from vibecut_agent.agent import chat as chat_module
from vibecut_agent.agent import gemini_chat
from vibecut_agent.headless import dispatch
from vibecut_agent.protocol import Emitter


class FakeResponse:
    """A `streamGenerateContent?alt=sse` response (Phase 8b): the whole answer as one event."""

    def __init__(self, status_code, json_data=None, text=""):
        self.status_code = status_code
        self._json = json_data
        self.text = text

    def iter_lines(self, decode_unicode=False):
        if self._json is not None:
            yield f"data: {json.dumps(self._json)}"

    def close(self):
        pass


def text_response(text):
    return FakeResponse(200, {"candidates": [{"content": {"parts": [{"text": text}]}}]})


def function_call_response(name, args):
    return FakeResponse(
        200, {"candidates": [{"content": {"parts": [{"functionCall": {"name": name, "args": args}}]}}]}
    )


class Capture:
    def __init__(self):
        self.buffer = io.StringIO()
        self.emitter = Emitter(self.buffer)

    def events(self):
        return [json.loads(line) for line in self.buffer.getvalue().splitlines()]

    def of_type(self, event_type):
        return [e for e in self.events() if e["type"] == event_type]


class FakeStdin:
    """A stdin stand-in for headless.py's chat session loop, backed by a thread-safe queue so it
    behaves like a real pipe: `readline()` returns each queued line in order, and once they're all
    consumed it blocks (rather than returning "") until either `push()` adds another or `close()`
    simulates the real bridge's pipe actually closing (which `rcs_utils.sidecar_protocol.LineChannel`
    — reading stdin on its own background thread, so the session loop can time out waiting for the
    next message — turns into a `RequestError("stdin closed unexpectedly")`). Blocking on exhaustion,
    rather than an immediate synthetic EOF, is what lets a test genuinely exercise the idle-timeout
    path: nothing sent and the "pipe" still open must look different from the pipe actually closing."""

    def __init__(self, lines):
        self._queue: queue.Queue[str] = queue.Queue()
        for line in lines:
            self._queue.put(line + "\n")

    def push(self, obj):
        self._queue.put(json.dumps(obj) + "\n")

    def close(self):
        self._queue.put("")

    def readline(self):
        return self._queue.get()


# A fixed tool-call id, since `run_chat_turn` generates a random one per call and a test that needs to
# reply to a specific call must know it ahead of time to pre-queue the reply (see the note on why
# these tests avoid reacting to `tool_calls` in real time, below).
FIXED_CALL_ID = uuid.UUID(int=1).hex[:12]


def run_chat(monkeypatch, stdin, capture):
    return dispatch("chat", capture.emitter, stdin)


def test_a_text_only_reply_ends_the_session_on_an_explicit_end_session(monkeypatch):
    monkeypatch.setattr(gemini_chat.requests, "post", lambda *a, **k: text_response("The cut looks good."))
    stdin = FakeStdin(
        [
            json.dumps(
                {"apiKey": "k", "toolDeclarations": [], "history": [], "userMessage": "how's the cut?"}
            ),
            json.dumps({"type": "end_session"}),
        ]
    )
    capture = Capture()

    code = run_chat(monkeypatch, stdin, capture)

    assert code == 0
    result = capture.of_type("result")[0]
    assert result["text"] == "The cut looks good."
    assert capture.of_type("error") == []


def test_a_tool_call_round_trips_through_sidecar_send_style_stdin_lines(monkeypatch):
    # The tool-call id is generated inside run_chat_turn (a fresh uuid per call) after the session's
    # background reader thread has already started, so there is no safe moment for this test to
    # inspect the emitted `tool_calls` event and react in real time without a second thread of its
    # own. Fixing the id instead keeps this test single-threaded and deterministic: every line the
    # session will need is queued up front, and LineChannel's own background pump reads them as the
    # session asks for them.
    monkeypatch.setattr(gemini_chat.uuid, "uuid4", lambda: uuid.UUID(int=1))
    responses = [function_call_response("split_at_playhead", {}), text_response("Split at the playhead.")]
    monkeypatch.setattr(gemini_chat.requests, "post", lambda *a, **k: responses.pop(0))

    stdin = FakeStdin(
        [
            json.dumps(
                {
                    "apiKey": "k",
                    "toolDeclarations": [{"name": "split_at_playhead", "description": "d", "parameters": {}}],
                    "history": [],
                    "userMessage": "split it",
                }
            ),
            json.dumps({"type": "tool_result", "id": FIXED_CALL_ID, "result": {"summary": "Split at 4.2s"}}),
            json.dumps({"type": "end_session"}),
        ]
    )
    capture = Capture()

    code = run_chat(monkeypatch, stdin, capture)

    assert code == 0
    tool_calls = capture.of_type("tool_calls")
    assert len(tool_calls) == 1
    assert tool_calls[0]["calls"][0]["name"] == "split_at_playhead"
    assert tool_calls[0]["calls"][0]["id"] == FIXED_CALL_ID
    assert capture.of_type("result")[0]["text"] == "Split at the playhead."


def test_tool_results_can_be_sent_back_out_of_order(monkeypatch):
    # Call ids are a uuid's first 12 hex digits, so the fakes differ in their top bits.
    ids = iter(uuid.UUID(int=n << 120) for n in range(1, 100))
    monkeypatch.setattr(gemini_chat.uuid, "uuid4", lambda: next(ids))
    first, second = uuid.UUID(int=1 << 120).hex[:12], uuid.UUID(int=2 << 120).hex[:12]
    batch = FakeResponse(
        200,
        {
            "candidates": [
                {
                    "content": {
                        "parts": [
                            {"functionCall": {"name": "split_at_playhead", "args": {}}},
                            {"functionCall": {"name": "set_clip_volume", "args": {}}},
                        ]
                    }
                }
            ]
        },
    )
    bodies = []
    responses = [batch, text_response("Both done.")]

    def fake_post(url, headers=None, data=None, timeout=None, stream=False):
        bodies.append(json.loads(data))
        return responses.pop(0)

    monkeypatch.setattr(gemini_chat.requests, "post", fake_post)
    stdin = FakeStdin(
        [
            json.dumps({"apiKey": "k", "toolDeclarations": [], "history": [], "userMessage": "do both"}),
            json.dumps({"type": "tool_result", "id": second, "result": "volume set"}),
            json.dumps({"type": "tool_result", "id": first, "result": "split"}),
            json.dumps({"type": "end_session"}),
        ]
    )
    capture = Capture()

    assert run_chat(monkeypatch, stdin, capture) == 0
    assert capture.of_type("error") == []
    answered = [p["functionResponse"] for p in bodies[1]["contents"][-1]["parts"]]
    assert [(r["name"], r["response"]["result"]) for r in answered] == [
        ("split_at_playhead", "split"),
        ("set_clip_volume", "volume set"),
    ]


def test_a_second_user_message_runs_another_turn_on_the_same_process(monkeypatch):
    responses = [text_response("First done."), text_response("Second done.")]
    monkeypatch.setattr(gemini_chat.requests, "post", lambda *a, **k: responses.pop(0))

    stdin = FakeStdin(
        [
            json.dumps(
                {"apiKey": "k", "toolDeclarations": [], "history": [], "userMessage": "first request"}
            ),
            json.dumps(
                {
                    "type": "user_message",
                    "userMessage": "second request",
                    "history": [{"role": "model", "parts": [{"text": "First done."}]}],
                }
            ),
            json.dumps({"type": "end_session"}),
        ]
    )
    capture = Capture()

    code = run_chat(monkeypatch, stdin, capture)

    assert code == 0
    results = capture.of_type("result")
    assert [r["text"] for r in results] == ["First done.", "Second done."]
    assert capture.of_type("error") == []


def test_idle_timeout_ends_the_session_quietly_with_no_error(monkeypatch):
    monkeypatch.setattr(chat_module, "CHAT_IDLE_TIMEOUT_SECONDS", 0.05)
    monkeypatch.setattr(gemini_chat.requests, "post", lambda *a, **k: text_response("Done."))
    # No end_session queued — the session must exit on its own once the idle timeout elapses, not hang.
    stdin = FakeStdin(
        [json.dumps({"apiKey": "k", "toolDeclarations": [], "history": [], "userMessage": "hi"})]
    )
    capture = Capture()

    code = run_chat(monkeypatch, stdin, capture)

    assert code == 0
    assert capture.of_type("error") == []


def test_end_session_ends_the_session_immediately(monkeypatch):
    monkeypatch.setattr(
        chat_module, "CHAT_IDLE_TIMEOUT_SECONDS", 5.0
    )  # would time out slowly if end_session were ignored
    monkeypatch.setattr(gemini_chat.requests, "post", lambda *a, **k: text_response("Done."))
    stdin = FakeStdin(
        [
            json.dumps({"apiKey": "k", "toolDeclarations": [], "history": [], "userMessage": "hi"}),
            json.dumps({"type": "end_session"}),
        ]
    )
    capture = Capture()

    code = run_chat(monkeypatch, stdin, capture)

    assert code == 0


def test_missing_api_key_errors_without_calling_gemini(monkeypatch):
    called = []
    monkeypatch.setattr(gemini_chat.requests, "post", lambda *a, **k: called.append(1))
    stdin = FakeStdin(
        [json.dumps({"apiKey": "", "toolDeclarations": [], "history": [], "userMessage": "hi"})]
    )
    capture = Capture()

    code = run_chat(monkeypatch, stdin, capture)

    assert code == 2
    assert not called
    assert "Gemini API key" in capture.of_type("error")[0]["message"]


def test_blank_user_message_errors(monkeypatch):
    stdin = FakeStdin(
        [json.dumps({"apiKey": "k", "toolDeclarations": [], "history": [], "userMessage": "   "})]
    )
    capture = Capture()

    code = run_chat(monkeypatch, stdin, capture)

    assert code == 2
    assert "userMessage" in capture.of_type("error")[0]["message"]


def test_abort_turn_ends_the_turn_but_keeps_the_session_for_the_next_message(monkeypatch):
    stdin = FakeStdin(
        [json.dumps({"apiKey": "k", "toolDeclarations": [], "history": [], "userMessage": "split it"})]
    )
    posts = []

    def fake_post(*a, **k):
        posts.append(1)
        if len(posts) == 1:
            # Stop pressed while the model is thinking about the first message.
            stdin.push({"type": "abort_turn"})
            return function_call_response("split_at_playhead", {})
        return text_response("Second turn answer.")

    monkeypatch.setattr(gemini_chat.requests, "post", fake_post)

    class AnsweringEmitter(Emitter):
        """Plays the app: answers tool calls as they arrive, and sends the next message after a result."""

        def emit(self, event_type, **fields):
            super().emit(event_type, **fields)
            if event_type == "tool_calls":
                for call in fields["calls"]:
                    stdin.push(
                        {
                            "type": "tool_result",
                            "id": call["id"],
                            "result": {"error": "Stopped by the user before this ran"},
                        }
                    )
            elif event_type == "result":
                results_seen.append(fields)
                if len(results_seen) == 1:
                    stdin.push({"type": "user_message", "userMessage": "anything else?", "history": []})
                else:
                    stdin.push({"type": "end_session"})

    results_seen = []
    capture = Capture()
    capture.emitter = AnsweringEmitter(capture.buffer)

    code = run_chat(monkeypatch, stdin, capture)

    assert code == 0
    assert len(results_seen) == 2
    assert results_seen[0]["aborted"] is True
    assert results_seen[1]["text"] == "Second turn answer."
    assert results_seen[1]["aborted"] is False
    assert results_seen[1]["usage"]["steps"] == 1
    assert capture.of_type("error") == []


def test_a_late_abort_turn_between_turns_is_ignored(monkeypatch):
    monkeypatch.setattr(gemini_chat.requests, "post", lambda *a, **k: text_response("ok"))
    stdin = FakeStdin(
        [
            json.dumps({"apiKey": "k", "toolDeclarations": [], "history": [], "userMessage": "hi"}),
            json.dumps({"type": "abort_turn"}),
            json.dumps({"type": "end_session"}),
        ]
    )
    capture = Capture()

    # The abort may be picked up during the first turn (ending it as stopped) or after it (ignored);
    # either way the session must end cleanly on end_session, not with an error.
    assert run_chat(monkeypatch, stdin, capture) == 0
    assert capture.of_type("error") == []


# ------------------------------------------------------------------------------ provider: claude


def test_a_claude_session_runs_claudes_loop_with_claudes_call_ids(monkeypatch):
    from tests.agent.claude_fakes import install, message, text, tool_use

    client = install(
        monkeypatch,
        [
            message(tool_use("toolu_9", "split_at_playhead", {}), stop_reason="tool_use"),
            message(text("Split.")),
        ],
    )
    called_gemini = []
    monkeypatch.setattr(gemini_chat.requests, "post", lambda *a, **k: called_gemini.append(1))
    stdin = FakeStdin(
        [
            json.dumps(
                {
                    "provider": "claude",
                    "model": "claude-sonnet-5-5",
                    "apiKey": "k",
                    "systemInstruction": "s",
                    "toolDeclarations": [{"name": "split_at_playhead", "description": "d", "parameters": {}}],
                    "history": [],
                    "userMessage": "split it",
                }
            ),
            json.dumps({"type": "tool_result", "id": "toolu_9", "result": {"summary": "Split"}}),
            json.dumps({"type": "end_session"}),
        ]
    )
    capture = Capture()

    code = run_chat(monkeypatch, stdin, capture)

    assert code == 0
    assert not called_gemini
    assert capture.of_type("tool_calls")[0]["calls"][0]["id"] == "toolu_9"
    result = capture.of_type("result")[0]
    assert result["text"] == "Split."
    assert result["history"][0] == {"role": "user", "content": "split it"}
    assert client.requests[0]["model"] == "claude-sonnet-5-5"


def test_a_missing_claude_key_names_claude(monkeypatch):
    stdin = FakeStdin(
        [
            json.dumps(
                {
                    "provider": "claude",
                    "apiKey": "",
                    "toolDeclarations": [],
                    "history": [],
                    "userMessage": "hi",
                }
            )
        ]
    )
    capture = Capture()

    assert run_chat(monkeypatch, stdin, capture) == 2
    assert "Claude API key" in capture.of_type("error")[0]["message"]


def test_an_unknown_provider_is_refused(monkeypatch):
    stdin = FakeStdin(
        [
            json.dumps(
                {
                    "provider": "openai",
                    "apiKey": "test-key-xyz",
                    "toolDeclarations": [],
                    "history": [],
                    "userMessage": "hi",
                }
            )
        ]
    )
    capture = Capture()

    assert run_chat(monkeypatch, stdin, capture) == 2
    assert "Unknown provider" in capture.of_type("error")[0]["message"]


@pytest.mark.parametrize("sent,used", [(None, 80), (40, 40), (2, 10), (500, 150), ("lots", 80)])
def test_max_steps_is_held_to_its_range_and_out_of_steps_is_passed_on(monkeypatch, sent, used):
    seen = {}

    def fake_turn(**kwargs):
        seen["max_iterations"] = kwargs["max_iterations"]
        return {"text": "Done some.", "history": [], "usage": None, "aborted": False, "outOfSteps": True}

    monkeypatch.setattr(gemini_chat, "run_chat_turn", fake_turn)
    request = {"apiKey": "k", "toolDeclarations": [], "history": [], "userMessage": "go"}
    if sent is not None:
        request["maxSteps"] = sent
    stdin = FakeStdin([json.dumps(request), json.dumps({"type": "end_session"})])
    capture = Capture()

    assert run_chat(monkeypatch, stdin, capture) == 0
    assert seen["max_iterations"] == used
    assert capture.of_type("result")[0]["outOfSteps"] is True
