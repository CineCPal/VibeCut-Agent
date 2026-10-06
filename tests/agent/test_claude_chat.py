"""tests/test_claude_chat.py — claude_chat.run_chat_turn()'s tool-use loop and claude_client's request
plumbing, with the anthropic client faked (tests/claude_fakes.py, no network) and emit/
read_tool_result faked in-process, as tests/test_gemini_chat.py does for Gemini."""

import json

import anthropic
import pytest

from tests.agent.claude_fakes import (
    connection_error,
    install,
    message,
    status_error,
    text,
    thinking,
    tool_use,
)
from vibecut_agent.agent import claude_chat, claude_client
from vibecut_agent.agent.gemini_chat import ChatError

TOOLS = [
    {
        "name": "split_at_playhead",
        "description": "Split.",
        "parameters": {"type": "OBJECT", "properties": {}},
    },
    {
        "name": "set_clip_volume",
        "description": "Volume.",
        "parameters": {
            "type": "OBJECT",
            "properties": {"volume": {"type": "NUMBER"}},
            "required": ["volume"],
        },
    },
]


class Recorder:
    """emit() records events; read_tool_result() answers the last tool_calls batch, in order, from
    the queued results (default "ok")."""

    def __init__(self, results=None, order=None):
        self.events = []
        self._results = dict(results or {})
        self._order = order
        self._pending = []

    def emit(self, event_type, **fields):
        self.events.append({"type": event_type, **fields})
        if event_type == "tool_calls":
            ids = [c["id"] for c in fields["calls"]]
            self._pending = [ids[i] for i in self._order] if self._order else ids

    def read_tool_result(self):
        call_id = self._pending.pop(0)
        return {"type": "tool_result", "id": call_id, "result": self._results.get(call_id, "ok")}

    def of_type(self, event_type):
        return [e for e in self.events if e["type"] == event_type]


def run_turn(rec, history=None, **kwargs):
    return claude_chat.run_chat_turn(
        api_key="secret-key",
        model=kwargs.pop("model", None),
        system_instruction="You edit video.",
        tool_declarations=kwargs.pop("tools", TOOLS),
        history=history or [],
        user_message="hello",
        emit=rec.emit,
        read_tool_result=rec.read_tool_result,
        **kwargs,
    )


def test_a_text_only_answer_ends_the_turn(monkeypatch):
    client = install(monkeypatch, [message(text("Hi there."))])
    rec = Recorder()

    outcome = run_turn(rec)

    assert outcome["text"] == "Hi there."
    assert outcome["aborted"] is False
    assert outcome["history"] == [
        {"role": "user", "content": "hello"},
        {"role": "assistant", "content": [text("Hi there.")]},
    ]
    assert len(client.requests) == 1


def test_the_request_caches_converts_tools_and_sets_thinking_and_compaction(monkeypatch):
    client = install(monkeypatch, [message(text("ok"))])

    run_turn(Recorder(), model="claude-opus-5-5")

    params = client.requests[0]
    assert params["model"] == "claude-opus-5-5"
    assert params["output_config"] == {"effort": "high"}
    assert params["system"] == [
        {"type": "text", "text": "You edit video.", "cache_control": {"type": "ephemeral"}}
    ]
    assert params["cache_control"] == {"type": "ephemeral"}
    assert params["thinking"]["type"] == "adaptive"
    assert params["thinking"]["display"] == "updates"
    assert params["thinking"]["block_binding"] == {"prefix_mismatch_behavior": "drop_block"}
    assert params["context_management"] == {"edits": [{"type": "compact_20260112"}]}
    assert set(params["betas"]) == {
        "compact-2026-01-12",
        "thinking-binding-controls-2026-08-01",
        "thinking-display-updates-2026-08-18",
        "server-side-fallback-2026-07-01",
    }
    assert params["fallbacks"] == "default"
    assert [t["name"] for t in params["tools"]] == ["split_at_playhead", "set_clip_volume"]
    assert params["tools"][1]["input_schema"]["properties"]["volume"] == {"type": "number"}
    assert "temperature" not in params


def test_sonnet_runs_at_medium_effort_and_a_missing_or_unknown_model_falls_back_to_sonnet(monkeypatch):
    client = install(monkeypatch, [message(text("a")), message(text("b")), message(text("c"))])

    run_turn(Recorder(), model="claude-sonnet-5-5")
    run_turn(Recorder(), model="gemini-flash-latest")
    run_turn(Recorder())

    assert (client.requests[0]["model"], client.requests[0]["output_config"]["effort"]) == (
        "claude-sonnet-5-5",
        "medium",
    )
    assert [r["model"] for r in client.requests[1:]] == ["claude-sonnet-5-5", "claude-sonnet-5-5"]


def test_one_tool_call_is_emitted_with_claudes_own_id_and_answered(monkeypatch):
    client = install(
        monkeypatch,
        [
            message(tool_use("toolu_1", "set_clip_volume", {"volume": 0.5}), stop_reason="tool_use"),
            message(text("Done.")),
        ],
    )
    rec = Recorder(results={"toolu_1": {"summary": "Volume set"}})

    outcome = run_turn(rec)

    assert outcome["text"] == "Done."
    calls = rec.of_type("tool_calls")
    assert calls == [
        {
            "type": "tool_calls",
            "calls": [{"id": "toolu_1", "name": "set_clip_volume", "args": {"volume": 0.5}}],
        }
    ]
    answer = client.requests[1]["messages"][-1]
    assert answer == {
        "role": "user",
        "content": [
            {
                "type": "tool_result",
                "tool_use_id": "toolu_1",
                "content": json.dumps({"summary": "Volume set"}),
            }
        ],
    }


def test_parallel_calls_answered_out_of_order_go_back_in_one_message_in_call_order(monkeypatch):
    client = install(
        monkeypatch,
        [
            message(
                tool_use("a", "split_at_playhead", {}),
                tool_use("b", "set_clip_volume", {"volume": 1}),
                stop_reason="tool_use",
            ),
            message(text("Both done.")),
        ],
    )
    rec = Recorder(results={"a": "first", "b": "second"}, order=[1, 0])

    run_turn(rec)

    answer = client.requests[1]["messages"][-1]
    assert [b["tool_use_id"] for b in answer["content"]] == ["a", "b"]
    assert [b["content"] for b in answer["content"]] == ["first", "second"]


def test_an_error_result_is_marked_is_error(monkeypatch):
    client = install(
        monkeypatch,
        [message(tool_use("a", "split_at_playhead", {}), stop_reason="tool_use"), message(text("Couldn't."))],
    )

    run_turn(Recorder(results={"a": {"error": "No clip under the playhead"}}))

    assert client.requests[1]["messages"][-1]["content"][0]["is_error"] is True


def test_thinking_and_compaction_blocks_are_kept_verbatim_and_history_only_grows(monkeypatch):
    compaction = {"type": "compaction", "content": "Summary of earlier work."}
    first = message(
        thinking("Checking the clip.", "sig-1"),
        tool_use("a", "split_at_playhead", {}),
        stop_reason="tool_use",
    )
    second = message(compaction, text("Split."))
    client = install(monkeypatch, [first, second])
    prior = [
        {"role": "user", "content": "earlier"},
        {"role": "assistant", "content": [text("earlier answer")]},
    ]

    outcome = run_turn(Recorder(), history=prior)

    history = outcome["history"]
    assert history[:2] == prior
    assert history[3]["content"][0] == thinking("Checking the clip.", "sig-1")
    assert history[-1]["content"][0] == compaction
    # The second request resent the first exactly as it was, with only new entries appended.
    sent_first, sent_second = client.requests[0]["messages"], client.requests[1]["messages"]
    assert sent_second[: len(sent_first)] == sent_first


def test_progress_notes_are_emitted_as_status_lines(monkeypatch):
    install(
        monkeypatch,
        [
            message(
                thinking("Looking for the loudest clip first."),
                tool_use("a", "split_at_playhead", {}),
                stop_reason="tool_use",
            ),
            message(thinking(""), text("Done.")),
        ],
    )
    rec = Recorder()

    run_turn(rec)

    details = [e["detail"] for e in rec.of_type("status") if e.get("phase") == "progress"]
    assert details == ["Looking for the loudest clip first."]


def test_the_last_step_turns_tools_off_and_its_own_answer_ends_the_turn(monkeypatch):
    split = lambda i: message(tool_use(f"t{i}", "split_at_playhead", {}), stop_reason="tool_use")
    client = install(monkeypatch, [split(0), split(1), message(text("Split twice; the fades are left."))])
    rec = Recorder()

    outcome = run_turn(rec, max_iterations=3)

    assert outcome["text"] == "Split twice; the fades are left."
    assert outcome["outOfSteps"] is True
    assert len(rec.of_type("tool_calls")) == 2
    assert "tool_choice" not in client.requests[0] and "tool_choice" not in client.requests[1]
    assert client.requests[2]["tool_choice"] == {"type": "none"}
    # The note follows the tool results in the same user message, so the history stays append-only.
    last_user = client.requests[2]["messages"][-1]
    assert last_user["content"][0]["type"] == "tool_result"
    assert last_user["content"][-1]["text"].startswith("[Last step")
    assert outcome["history"][-1] == {"role": "assistant", "content": [text(outcome["text"])]}


def test_a_tool_call_on_the_last_step_is_dropped_and_the_notice_answers(monkeypatch):
    install(
        monkeypatch,
        [message(tool_use(f"t{i}", "split_at_playhead", {}), stop_reason="tool_use") for i in range(2)],
    )
    rec = Recorder()

    outcome = run_turn(rec, max_iterations=2)

    assert "ran out of steps" in outcome["text"].lower()
    assert outcome["outOfSteps"] is True
    assert len(rec.of_type("tool_calls")) == 1
    assert all(b["type"] != "tool_use" for b in outcome["history"][-1]["content"])


def test_five_steps_before_the_end_the_model_hears_how_many_are_left(monkeypatch):
    replies = [
        message(tool_use("t0", "split_at_playhead", {}), stop_reason="tool_use"),
        message(text("Done.")),
    ]
    client = install(monkeypatch, replies)

    outcome = run_turn(Recorder(), max_iterations=6)

    assert outcome["outOfSteps"] is False
    first_user = client.requests[0]["messages"][-1]
    assert not any(
        "Step budget" in json.dumps(b)
        for b in first_user["content"]
        if isinstance(first_user["content"], list)
    )
    second_user = client.requests[1]["messages"][-1]
    assert "5 steps left" in second_user["content"][-1]["text"]


def test_the_same_failing_call_twice_is_marked_the_second_time(monkeypatch):
    same = lambda i: message(tool_use(f"t{i}", "set_clip_volume", {"volume": 2}), stop_reason="tool_use")
    install(monkeypatch, [same(0), same(1), message(text("I couldn't."))])
    rec = Recorder(results={"t0": {"error": "Too loud"}, "t1": {"error": "Too loud"}})

    outcome = run_turn(rec)

    results = [
        m["content"][0] for m in outcome["history"] if m["role"] == "user" and isinstance(m["content"], list)
    ]
    assert json.loads(results[0]["content"]) == {"error": "Too loud"}
    assert "already failed this turn" in json.loads(results[1]["content"])["error"]


def test_abort_before_the_first_call_stops_without_calling_claude(monkeypatch):
    client = install(monkeypatch, [])

    outcome = run_turn(Recorder(), should_abort=lambda: True)

    assert outcome["aborted"] is True
    assert client.requests == []
    assert outcome["history"][-1]["role"] == "assistant"


def test_tool_calls_are_dropped_when_stop_arrives_with_them(monkeypatch):
    install(monkeypatch, [message(tool_use("a", "split_at_playhead", {}), stop_reason="tool_use")])
    checks = iter([False, False, True])  # before the call, during its stream, then when the calls arrive
    rec = Recorder()

    outcome = run_turn(rec, should_abort=lambda: next(checks, True))

    assert outcome["aborted"] is True
    assert rec.of_type("tool_calls") == []
    # No unanswered tool_use is left in the history.
    assert all(
        b.get("type") != "tool_use"
        for m in outcome["history"]
        if isinstance(m["content"], list)
        for b in m["content"]
    )


@pytest.mark.parametrize(
    "stop_reason, expected",
    [("refusal", "declined"), ("max_tokens", "length limit")],
)
def test_a_refusal_or_length_cutoff_ends_the_turn_with_a_plain_notice(monkeypatch, stop_reason, expected):
    install(monkeypatch, [message(text("partial"), stop_reason=stop_reason)])

    outcome = run_turn(Recorder())

    assert expected in outcome["text"]
    assert outcome["history"][-1]["content"][-1] == text(outcome["text"])


def test_pause_turn_continues_the_loop(monkeypatch):
    client = install(
        monkeypatch, [message(text("Working…"), stop_reason="pause_turn"), message(text("Finished."))]
    )

    outcome = run_turn(Recorder())

    assert outcome["text"] == "Finished."
    assert len(client.requests) == 2


def test_usage_is_summed_in_vibecuts_shape(monkeypatch):
    usage = {
        "input_tokens": 100,
        "cache_read_input_tokens": 900,
        "cache_creation_input_tokens": 50,
        "output_tokens": 20,
    }
    install(
        monkeypatch,
        [
            message(tool_use("a", "split_at_playhead", {}), stop_reason="tool_use", usage=usage),
            message(text("ok"), usage=usage),
        ],
    )

    outcome = run_turn(Recorder())

    assert outcome["usage"] == {
        "promptTokens": 2100,
        "cachedTokens": 1800,
        "outputTokens": 40,
        "thoughtsTokens": 0,
        "steps": 2,
    }


def test_rate_limits_and_overloads_are_retried_and_reported(monkeypatch):
    client = install(
        monkeypatch,
        [
            status_error(anthropic.RateLimitError, 429, {"retry-after": "3"}),
            status_error(anthropic.InternalServerError, 529),
            connection_error(),
            message(text("Made it.")),
        ],
    )
    retries = []
    monkeypatch.setattr(
        claude_client,
        "_wait_before_retry",
        lambda attempt, on_retry, reason, at_least=None: retries.append((reason, at_least)),
    )

    outcome = run_turn(Recorder())

    assert outcome["text"] == "Made it."
    assert retries == [("HTTP 429", 3.0), ("HTTP 529", None), ("network error", None)]
    assert len(client.requests) == 4


def test_retries_give_up_after_the_last_attempt(monkeypatch):
    install(monkeypatch, [status_error(anthropic.InternalServerError, 503)] * claude_client.MAX_ATTEMPTS)

    with pytest.raises(ChatError, match="busy"):
        run_turn(Recorder())


def test_a_client_error_fails_at_once_without_the_key_in_the_message(monkeypatch):
    install(monkeypatch, [status_error(anthropic.BadRequestError, 400, msg="bad request near secret-key")])

    with pytest.raises(ChatError) as info:
        run_turn(Recorder())

    assert "HTTP 400" in str(info.value)
    assert "secret-key" not in str(info.value)


def test_a_rejected_key_says_which_variable_to_check(monkeypatch):
    install(monkeypatch, [status_error(anthropic.AuthenticationError, 401)])

    with pytest.raises(ChatError, match="ANTHROPIC_API_KEY"):
        run_turn(Recorder())


def test_a_missing_key_or_message_fails_before_any_request(monkeypatch):
    client = install(monkeypatch, [])
    with pytest.raises(ChatError):
        claude_chat.run_chat_turn("", None, "s", [], [], "hi", lambda *a, **k: None, dict)
    with pytest.raises(ChatError):
        claude_chat.run_chat_turn("k", None, "s", [], [], "  ", lambda *a, **k: None, dict)
    assert client.requests == []


def test_an_unknown_tool_result_id_fails_the_turn(monkeypatch):
    install(monkeypatch, [message(tool_use("a", "split_at_playhead", {}), stop_reason="tool_use")])

    def wrong_id():
        return {"type": "tool_result", "id": "nope", "result": "ok"}

    with pytest.raises(ChatError, match="unknown call id"):
        claude_chat.run_chat_turn("k", None, "s", TOOLS, [], "hi", lambda *a, **k: None, wrong_id)
