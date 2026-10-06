"""tests/test_gemini_chat.py — run_chat_turn()'s tool-calling loop, with requests.post faked (no
network) and read_tool_result/emit faked in-process (no actual stdin/stdout pipe — that plumbing is
covered separately by tests/test_headless_chat.py)."""

import json

import pytest

from vibecut_agent.agent import gemini_chat


class FakeResponse:
    def __init__(self, status_code, json_data=None, text=""):
        self.status_code = status_code
        self._json = json_data
        self.text = text

    def json(self):
        return self._json


def text_response(text):
    return FakeResponse(200, {"candidates": [{"content": {"parts": [{"text": text}]}}]})


def function_call_response(*calls):
    parts = [{"functionCall": {"name": name, "args": args}} for name, args in calls]
    return FakeResponse(200, {"candidates": [{"content": {"parts": parts}}]})


@pytest.fixture(autouse=True)
def no_real_sleep(monkeypatch):
    monkeypatch.setattr(gemini_chat, "_wait_before_retry", lambda *a, **k: None)


class Recorder:
    """Fakes emit()/read_tool_result() for one test: emit() records events; read_tool_result()
    returns a queued result (or a default {"result": "ok"} echoing the last tool_calls batch)."""

    def __init__(self, results=None):
        self.events = []
        self._results = list(results or [])
        self._pending_ids = []

    def emit(self, event_type, **fields):
        self.events.append({"type": event_type, **fields})
        if event_type == "tool_calls":
            self._pending_ids = [c["id"] for c in fields["calls"]]

    def read_tool_result(self):
        call_id = self._pending_ids.pop(0)
        result = self._results.pop(0) if self._results else "ok"
        return {"type": "tool_result", "id": call_id, "result": result}


def test_a_text_only_response_ends_the_loop_at_once(monkeypatch):
    monkeypatch.setattr(gemini_chat.requests, "post", lambda *a, **k: text_response("Hi there."))
    rec = Recorder()

    outcome = run_turn(rec)

    assert outcome["text"] == "Hi there."
    assert [e["type"] for e in rec.events] == ["status"]
    # The final history carries the user message and the model's reply, ready to resend next turn.
    assert outcome["history"][-2] == {"role": "user", "parts": [{"text": "hello"}]}
    assert outcome["history"][-1]["role"] == "model"


def test_one_tool_call_triggers_one_emit_and_blocked_read(monkeypatch):
    calls = [
        function_call_response(("trim_clip_end", {"clipId": "c1", "rawSourceOut": 4.2})),
        text_response("Done."),
    ]
    monkeypatch.setattr(gemini_chat.requests, "post", lambda *a, **k: calls.pop(0))
    rec = Recorder(results=[{"summary": "Trimmed"}])

    outcome = run_turn(rec)

    assert outcome["text"] == "Done."
    tool_calls_events = [e for e in rec.events if e["type"] == "tool_calls"]
    assert len(tool_calls_events) == 1
    assert tool_calls_events[0]["calls"][0]["name"] == "trim_clip_end"
    assert tool_calls_events[0]["calls"][0]["args"] == {"clipId": "c1", "rawSourceOut": 4.2}
    # The functionResponse fed back to Gemini carries the executor's result.
    function_response = outcome["history"][-2]["parts"][0]["functionResponse"]
    assert function_response == {"name": "trim_clip_end", "response": {"result": {"summary": "Trimmed"}}}


def test_multiple_parallel_calls_in_one_response_are_all_collected_and_answered(monkeypatch):
    batch = function_call_response(
        ("split_at_playhead", {}), ("set_clip_volume", {"clipIds": ["c1"], "volume": 0.5})
    )
    seq = [batch, text_response("Both done.")]
    monkeypatch.setattr(gemini_chat.requests, "post", lambda *a, **k: seq.pop(0))
    rec = Recorder(results=["ok1", "ok2"])

    outcome = run_turn(rec)

    assert outcome["text"] == "Both done."
    tool_calls_events = [e for e in rec.events if e["type"] == "tool_calls"]
    assert len(tool_calls_events) == 1
    names = [c["name"] for c in tool_calls_events[0]["calls"]]
    assert names == ["split_at_playhead", "set_clip_volume"]
    # Both calls got answered (one functionResponse part per call) before the next generateContent call.
    response_parts = outcome["history"][-2]["parts"]
    assert len(response_parts) == 2
    assert [p["functionResponse"]["response"]["result"] for p in response_parts] == ["ok1", "ok2"]


def test_the_last_step_turns_function_calling_off_and_its_own_answer_ends_the_turn(monkeypatch):
    # Every tool call made before the last step is a real, already-applied edit, so the turn ends on
    # the model's own account of what it did and what's left, with that history kept.
    bodies = []
    replies = [
        function_call_response(("noop", {})),
        function_call_response(("noop", {})),
        text_response("Two done; one left."),
    ]

    def fake_post(url, headers=None, data=None, timeout=None):
        bodies.append(json.loads(data))
        return replies.pop(0)

    monkeypatch.setattr(gemini_chat.requests, "post", fake_post)
    rec = Recorder()

    outcome = run_turn(rec, max_iterations=3)

    assert outcome["text"] == "Two done; one left."
    assert outcome["outOfSteps"] is True
    assert "toolConfig" not in bodies[0] and "toolConfig" not in bodies[1]
    assert bodies[2]["toolConfig"] == {"functionCallingConfig": {"mode": "NONE"}}
    last_user = bodies[2]["contents"][-1]
    assert "functionResponse" in last_user["parts"][0]
    assert last_user["parts"][-1]["text"].startswith("[Last step")
    assert len([e for e in rec.events if e["type"] == "tool_calls"]) == 2


def test_a_function_call_on_the_last_step_is_dropped_and_the_notice_answers(monkeypatch):
    monkeypatch.setattr(gemini_chat.requests, "post", lambda *a, **k: function_call_response(("noop", {})))
    rec = Recorder()

    outcome = run_turn(rec, max_iterations=3)

    assert "ran out of steps" in outcome["text"].lower()
    assert outcome["history"][-1] == {"role": "model", "parts": [{"text": outcome["text"]}]}
    assert len([e for e in rec.events if e["type"] == "tool_calls"]) == 2


def test_five_steps_before_the_end_the_model_hears_how_many_are_left(monkeypatch):
    bodies = []
    replies = [function_call_response(("noop", {})), text_response("Done.")]

    def fake_post(url, headers=None, data=None, timeout=None):
        bodies.append(json.loads(data))
        return replies.pop(0)

    monkeypatch.setattr(gemini_chat.requests, "post", fake_post)

    outcome = run_turn(Recorder(), max_iterations=6)

    assert outcome["outOfSteps"] is False
    assert bodies[0]["contents"][-1] == {"role": "user", "parts": [{"text": "hello"}]}
    assert "5 steps left" in bodies[1]["contents"][-1]["parts"][-1]["text"]


def test_the_same_failing_call_twice_is_marked_the_second_time(monkeypatch):
    replies = [
        function_call_response(("noop", {"a": 1})),
        function_call_response(("noop", {"a": 1})),
        text_response("No."),
    ]
    monkeypatch.setattr(gemini_chat.requests, "post", lambda *a, **k: replies.pop(0))
    rec = Recorder(results=[{"error": "Nope"}, {"error": "Nope"}])

    outcome = run_turn(rec)

    answers = [
        m["parts"][0]["functionResponse"]["response"]["result"]
        for m in outcome["history"]
        if m["role"] == "user" and "functionResponse" in m["parts"][0]
    ]
    assert answers[0] == {"error": "Nope"}
    assert "already failed this turn" in answers[1]["error"]


def run_turn(rec, **kwargs):
    return gemini_chat.run_chat_turn(
        api_key="secret-key",
        model=None,
        system_instruction="You are a video editing assistant.",
        tool_declarations=[
            {"name": "trim_clip_end", "description": "Trim a clip's end.", "parameters": {"type": "OBJECT"}}
        ],
        history=[],
        user_message="hello",
        emit=rec.emit,
        read_tool_result=rec.read_tool_result,
        **kwargs,
    )


def test_the_key_is_sent_as_a_header_never_the_body(monkeypatch):
    seen = {}

    def fake_post(url, headers=None, data=None, timeout=None):
        seen["headers"] = headers
        seen["body"] = json.loads(data)
        return text_response("ok")

    monkeypatch.setattr(gemini_chat.requests, "post", fake_post)
    run_turn(Recorder())

    assert seen["headers"]["x-goog-api-key"] == "secret-key"
    assert "apiKey" not in seen["body"]
    assert seen["body"]["tools"] == [
        {
            "functionDeclarations": [
                {
                    "name": "trim_clip_end",
                    "description": "Trim a clip's end.",
                    "parameters": {"type": "OBJECT"},
                }
            ]
        }
    ]


def test_a_retryable_failure_calls_on_retry_before_succeeding(monkeypatch):
    # Overrides the autouse no_real_sleep fixture's blanket no-op for this one test, so on_retry
    # actually gets invoked the way the real _wait_before_retry would call it.
    def fake_wait_before_retry(attempt, on_retry, reason):
        if on_retry:
            on_retry(attempt, gemini_chat.MAX_ATTEMPTS, 0.0, reason)

    monkeypatch.setattr(gemini_chat, "_wait_before_retry", fake_wait_before_retry)
    responses = [FakeResponse(429, text="rate limited"), text_response("ok")]
    monkeypatch.setattr(gemini_chat.requests, "post", lambda *a, **k: responses.pop(0))

    retries = []
    run_turn(Recorder(), on_retry=lambda *args: retries.append(args))

    assert retries == [(1, gemini_chat.MAX_ATTEMPTS, 0.0, "HTTP 429")]


def with_usage(response, prompt, cached, output, thoughts=0):
    response._json["usageMetadata"] = {
        "promptTokenCount": prompt,
        "cachedContentTokenCount": cached,
        "candidatesTokenCount": output,
        "thoughtsTokenCount": thoughts,
    }
    return response


def test_usage_is_summed_over_every_call_in_the_turn(monkeypatch):
    seq = [
        with_usage(function_call_response(("split_at_playhead", {})), 1000, 0, 20, 5),
        with_usage(text_response("Done."), 1100, 900, 10),
    ]
    monkeypatch.setattr(gemini_chat.requests, "post", lambda *a, **k: seq.pop(0))

    outcome = run_turn(Recorder())

    assert outcome["usage"] == {
        "promptTokens": 2100,
        "cachedTokens": 900,
        "outputTokens": 30,
        "thoughtsTokens": 5,
        "steps": 2,
    }
    assert outcome["aborted"] is False


def test_abort_before_handing_out_calls_drops_the_unanswered_response(monkeypatch):
    monkeypatch.setattr(
        gemini_chat.requests, "post", lambda *a, **k: function_call_response(("split_at_playhead", {}))
    )
    rec = Recorder()
    checks = iter([False, True])  # not before the first call; yes once its response is in

    outcome = run_turn(rec, should_abort=lambda: next(checks))

    assert outcome["aborted"] is True
    assert outcome["text"] == gemini_chat.STOPPED_NOTICE
    assert [e["type"] for e in rec.events] == ["status"]  # no tool_calls were handed out
    # History stays well formed: the user's message, then the stop notice — no dangling functionCall.
    assert [c["role"] for c in outcome["history"]] == ["user", "model"]
    assert "functionCall" not in json.dumps(outcome["history"])


def test_abort_after_a_batch_stops_before_the_next_model_call(monkeypatch):
    posts = []

    def fake_post(*a, **k):
        posts.append(1)
        return function_call_response(("split_at_playhead", {}))

    monkeypatch.setattr(gemini_chat.requests, "post", fake_post)
    checks = iter([False, False, True])

    outcome = run_turn(Recorder(), should_abort=lambda: next(checks))

    assert outcome["aborted"] is True
    assert len(posts) == 1
    # The answered call and its result stay in history; the stop notice follows them.
    assert [c["role"] for c in outcome["history"]] == ["user", "model", "user", "model"]


def test_a_blocked_response_answers_instead_of_ending_the_session(monkeypatch):
    blocked = FakeResponse(200, {"candidates": [{"finishReason": "SAFETY"}]})
    monkeypatch.setattr(gemini_chat.requests, "post", lambda *a, **k: blocked)

    outcome = run_turn(Recorder())

    assert "SAFETY" in outcome["text"]
    assert outcome["history"][-1]["role"] == "model"


def test_a_prompt_block_reason_is_reported(monkeypatch):
    blocked = FakeResponse(200, {"promptFeedback": {"blockReason": "OTHER"}})
    monkeypatch.setattr(gemini_chat.requests, "post", lambda *a, **k: blocked)

    assert "OTHER" in run_turn(Recorder())["text"]


def test_a_transient_500_is_retried(monkeypatch):
    seq = [FakeResponse(500, text="internal"), text_response("Recovered.")]
    monkeypatch.setattr(gemini_chat.requests, "post", lambda *a, **k: seq.pop(0))

    assert run_turn(Recorder())["text"] == "Recovered."


class ReorderingRecorder(Recorder):
    """Answers each batch's calls in reverse order, the way a caller running them concurrently might."""

    def read_tool_result(self):
        call_id = self._pending_ids.pop()
        return {"type": "tool_result", "id": call_id, "result": f"result-for-{call_id}"}


def test_results_may_arrive_in_any_order_but_history_follows_the_call_order(monkeypatch):
    batch = function_call_response(("split_at_playhead", {}), ("set_clip_volume", {}), ("ripple_delete", {}))
    seq = [batch, text_response("Done.")]
    monkeypatch.setattr(gemini_chat.requests, "post", lambda *a, **k: seq.pop(0))
    rec = ReorderingRecorder()

    outcome = run_turn(rec)

    call_ids = [c["id"] for c in rec.events[[e["type"] for e in rec.events].index("tool_calls")]["calls"]]
    response_parts = outcome["history"][-2]["parts"]
    assert [p["functionResponse"]["name"] for p in response_parts] == [
        "split_at_playhead",
        "set_clip_volume",
        "ripple_delete",
    ]
    assert [p["functionResponse"]["response"]["result"] for p in response_parts] == [
        f"result-for-{i}" for i in call_ids
    ]


def test_a_result_for_an_unknown_call_id_fails_the_turn(monkeypatch):
    monkeypatch.setattr(gemini_chat.requests, "post", lambda *a, **k: function_call_response(("noop", {})))
    rec = Recorder()
    rec.read_tool_result = lambda: {"type": "tool_result", "id": "not-a-call", "result": "ok"}

    with pytest.raises(gemini_chat.ChatError, match="unknown call id"):
        run_turn(rec)


def test_a_duplicate_result_fails_the_turn(monkeypatch):
    monkeypatch.setattr(
        gemini_chat.requests, "post", lambda *a, **k: function_call_response(("a", {}), ("b", {}))
    )
    rec = Recorder()
    original = rec.read_tool_result

    def first_id_twice():
        message = original()
        rec._pending_ids.insert(0, message["id"])
        return message

    rec.read_tool_result = first_id_twice

    with pytest.raises(gemini_chat.ChatError, match="sent twice"):
        run_turn(rec)


def test_a_model_supplied_call_id_is_echoed_on_its_response(monkeypatch):
    parts = [{"functionCall": {"id": "gemini-call-7", "name": "noop", "args": {}}}]
    seq = [FakeResponse(200, {"candidates": [{"content": {"parts": parts}}]}), text_response("ok")]
    monkeypatch.setattr(gemini_chat.requests, "post", lambda *a, **k: seq.pop(0))

    outcome = run_turn(Recorder())

    assert outcome["history"][-2]["parts"][0]["functionResponse"]["id"] == "gemini-call-7"


def test_thought_signatures_are_kept_verbatim_in_history_and_resent(monkeypatch):
    # Thinking models (what gemini-flash-latest can resolve to) reject a follow-up call whose history
    # dropped the signature they attached to a function call.
    parts = [{"functionCall": {"name": "noop", "args": {}}, "thoughtSignature": "sig-abc"}]
    seq = [FakeResponse(200, {"candidates": [{"content": {"parts": parts}}]}), text_response("ok")]
    bodies = []

    def fake_post(url, headers=None, data=None, timeout=None):
        bodies.append(json.loads(data))
        return seq.pop(0)

    monkeypatch.setattr(gemini_chat.requests, "post", fake_post)

    outcome = run_turn(Recorder())

    assert outcome["history"][1] == {"role": "model", "parts": parts}
    assert bodies[1]["contents"][1]["parts"][0]["thoughtSignature"] == "sig-abc"


def test_a_non_200_body_reflecting_the_key_is_scrubbed(monkeypatch):
    monkeypatch.setattr(
        gemini_chat.requests,
        "post",
        lambda *a, **k: FakeResponse(400, text="proxy says: bad header x-goog-api-key=secret-key"),
    )

    with pytest.raises(gemini_chat.ChatError) as exc_info:
        run_turn(Recorder())

    assert "secret-key" not in str(exc_info.value)
    assert "[REDACTED]" in str(exc_info.value)
