"""gemini_chat.py

Runs Gemini's real function-calling/tools API in a loop for VibeCut's autonomous chat agent — the
model that lets the user converse about their edit and have it execute multi-step timeline changes
on its own (see PLAN.md's Chat Agent Status).

This is deliberately separate from gemini_client.py's `generate_script`/`generate_story_script`,
which force a `responseSchema` and return exactly one structured object in one call. That mode and
free-form `tools`/function-calling are mutually exclusive request shapes in the Gemini API, and the
two features' response handling (one-shot schema vs. an iterative call/respond loop) is different
enough that sharing one function would make both harder to follow. Only the low-level HTTP
plumbing — retry/backoff and secret-scrubbing — is reused from `gemini_client`.

Security notes: as in gemini_client.py, the key is read from the request only, never logged, never
written to disk, sent only in the `x-goog-api-key` header, and any exception text is scrubbed of it.
"""

from __future__ import annotations

import json
import uuid
from collections.abc import Callable
from typing import Any

import requests

from vibecut_agent.agent.chat_steps import (
    DEFAULT_MAX_STEPS,
    OUT_OF_STEPS_NOTICE,
    RepeatFailures,
    budget_note,
    is_last_step,
)
from vibecut_agent.agent.gemini_client import (
    GEMINI_ENDPOINT,
    MAX_ATTEMPTS,
    RETRYABLE_STATUSES,
    GeminiError,
    OnRetry,
    _overload_message,
    _scrub_secret,
    _wait_before_retry,
)
from vibecut_agent.agent.redact import scrub

# Same auto-updated alias gemini_client.py defaults to — see its own comment for why.
DEFAULT_MODEL = "gemini-flash-latest"

# Chat also retries transient server errors (500/502/504): a chat turn is interactive and several
# calls long, so one flaky response shouldn't end the whole session. gemini_client.py's own set is
# left alone for the one-shot Story Editor/Auto-Cut calls.
CHAT_RETRYABLE_STATUSES = RETRYABLE_STATUSES | {500, 502, 504}

STOPPED_NOTICE = "Stopped by the user. Edits made before stopping are still applied."


class ChatError(GeminiError):
    """A chat turn could not be completed."""


def _post(
    api_key: str, model: str, body: dict[str, Any], timeout: int, on_retry: OnRetry = None
) -> dict[str, Any]:
    """One `generateContent` call, with the same retry/backoff and error shape as gemini_client.py.

    `on_retry`: optional callback(attempt, max_attempts, wait_seconds, reason), same convention as
    gemini_client.py's own retrying calls — lets the caller surface a "retrying…" status instead of a
    silent stall during backoff.
    """
    if not api_key or not api_key.strip():
        raise ChatError("No Gemini API key was provided.")

    url = GEMINI_ENDPOINT.format(model=model)
    last_error: GeminiError | None = None
    for attempt in range(1, MAX_ATTEMPTS + 1):
        try:
            resp = requests.post(
                url,
                headers={"Content-Type": "application/json", "x-goog-api-key": api_key},
                data=json.dumps(body),
                timeout=timeout,
            )
        except requests.RequestException as e:
            last_error = ChatError(f"Network error calling Gemini API: {_scrub_secret(e, api_key)}")
            if attempt < MAX_ATTEMPTS:
                _wait_before_retry(attempt, on_retry, reason="network error")
                continue
            raise last_error from e

        if resp.status_code in CHAT_RETRYABLE_STATUSES:
            last_error = ChatError(_overload_message(resp))
            if attempt < MAX_ATTEMPTS:
                _wait_before_retry(attempt, on_retry, reason=f"HTTP {resp.status_code}")
                continue
            raise last_error

        if resp.status_code != 200:
            raise ChatError(f"Gemini API returned HTTP {resp.status_code}: {scrub(resp.text, api_key)[:500]}")

        answer: dict[str, Any] = resp.json()
        return answer

    raise last_error or ChatError("Gemini API request failed for an unknown reason.")


def run_chat_turn(
    api_key: str,
    model: str | None,
    system_instruction: str,
    tool_declarations: list[dict[str, Any]],
    history: list[dict[str, Any]],
    user_message: str,
    emit: Callable[..., None],
    read_tool_result: Callable[[], dict[str, Any]],
    max_iterations: int = DEFAULT_MAX_STEPS,
    timeout: int = 90,
    on_retry: OnRetry = None,
    should_abort: Callable[[], bool] = lambda: False,
) -> dict[str, Any]:
    """Runs Gemini's tools/function-calling loop for one user chat message, end to end.

    `tool_declarations`: JSON-Schema-shaped function declarations, e.g.
        [{"name": "trim_clip_end", "description": "...",
          "parameters": {"type": "OBJECT", "properties": {...}, "required": [...]}}, ...]

    `history`: the `contents` list a previous call to this function returned (its own `["history"]`),
    resent verbatim — like `run_revise`, each sidecar process is its own fresh call with no memory
    of a prior one, so the caller (the frontend) is what remembers the conversation across turns.

    `emit(event_type, **fields)` reports progress to the caller. Whenever Gemini requests one or
    more tool calls, this emits one `tool_calls` event carrying the whole batch
    (`{"calls": [{"id", "name", "args"}, ...]}`) and then calls `read_tool_result()` once per call,
    accepting the results in any order (matched by id), blocking until each arrives — `read_tool_result` is expected to block on the
    sidecar's stdin for a `{"type": "tool_result", "id", "result"}` message the frontend sends back
    after it has actually run that tool (a timeline edit, a search, a sidecar job — whatever the
    caller wired the tool name up to) via `sidecar_send`. Sending the whole batch as one event (Gemini
    can request several tool calls in one response) lets the caller treat it as one unit — e.g. one
    undo group for however many timeline edits that batch makes.

    Returns `{"text": <the model's final answer>, "history": <updated contents, feed back in next time>,
    "usage": <token counts summed over this turn's calls>, "aborted": <bool>, "outOfSteps": <bool>}`.

    `should_abort()` is checked before every model call and before any tool calls a response asks
    for are handed out; once it returns True the turn ends with a "stopped" answer (a response whose
    tool calls were never run is dropped, so history never holds an unanswered function call).

    A response with no content (e.g. blocked by a safety filter) ends the turn with a plain-language
    answer saying so rather than raising, so the session survives it.

    The step budget (`max_iterations` model calls, see chat_steps.py): five steps before the end a
    note tells the model how many are left, and the last call is made with function calling turned
    off, so the turn ends on the model's own summary of what it finished and what's left
    (`outOfSteps` True). The edits made by then are real, so the history keeps them. Raises ChatError
    only for a genuine failure: a network/API error exhausting its own retries, or an unexpected
    response shape.
    """
    resolved_model = model or DEFAULT_MODEL
    if not api_key or not api_key.strip():
        raise ChatError("No Gemini API key was provided.")
    if not user_message or not user_message.strip():
        raise ChatError("The chat message was empty.")

    contents: list[dict[str, Any]] = [*history, {"role": "user", "parts": [{"text": user_message}]}]

    body_base: dict[str, Any] = {
        "systemInstruction": {"parts": [{"text": system_instruction}]},
        "generationConfig": {"temperature": 0.4},
    }
    if tool_declarations:
        body_base["tools"] = [{"functionDeclarations": tool_declarations}]

    usage = {"promptTokens": 0, "cachedTokens": 0, "outputTokens": 0, "thoughtsTokens": 0, "steps": 0}

    repeats = RepeatFailures()

    def finish(text: str, aborted: bool = False, out_of_steps: bool = False) -> dict[str, Any]:
        return {
            "text": text,
            "history": contents,
            "usage": usage,
            "aborted": aborted,
            "outOfSteps": out_of_steps,
        }

    def stop() -> dict[str, Any]:
        contents.append({"role": "model", "parts": [{"text": STOPPED_NOTICE}]})
        return finish(STOPPED_NOTICE, aborted=True)

    for step in range(1, max_iterations + 1):
        if should_abort():
            return stop()
        last = is_last_step(step, max_iterations)
        note = budget_note(step, max_iterations)
        if note:
            # The latest user turn (the message, or the last batch of functionResponses) carries it.
            contents[-1]["parts"].append({"text": note})
        body = {**body_base, "contents": contents}
        if last and tool_declarations:
            body["toolConfig"] = {"functionCallingConfig": {"mode": "NONE"}}
        emit("status", phase="calling_model", detail="Calling Gemini…")
        data = _post(api_key, resolved_model, body, timeout, on_retry=on_retry)
        _add_usage(usage, data)

        parts = _response_parts(data)
        if parts is None:
            notice = _no_answer_notice(data)
            contents.append({"role": "model", "parts": [{"text": notice}]})
            return finish(notice)

        calls = [p["functionCall"] for p in parts if isinstance(p, dict) and "functionCall" in p]
        text = "".join(p.get("text", "") for p in parts if isinstance(p, dict) and "text" in p)

        if last:
            # Tools were off; a stray call is dropped so the history never holds an unanswered one.
            text_parts = [p for p in parts if isinstance(p, dict) and "functionCall" not in p]
            answer = text.strip() or OUT_OF_STEPS_NOTICE
            contents.append({"role": "model", "parts": text_parts if text.strip() else [{"text": answer}]})
            return finish(answer, out_of_steps=True)

        if calls and should_abort():
            return stop()
        contents.append({"role": "model", "parts": parts})

        if not calls:
            return finish(text)

        call_ids = [uuid.uuid4().hex[:12] for _ in calls]
        emit(
            "tool_calls",
            calls=[
                {"id": call_id, "name": call.get("name"), "args": call.get("args") or {}}
                for call_id, call in zip(call_ids, calls)
            ],
        )

        contents.append(
            {"role": "user", "parts": _collect_tool_results(call_ids, calls, read_tool_result, repeats)}
        )

    # Only reached with max_iterations < 1: no step was ever taken.
    contents.append({"role": "model", "parts": [{"text": OUT_OF_STEPS_NOTICE}]})
    return finish(OUT_OF_STEPS_NOTICE, out_of_steps=True)


def _collect_tool_results(
    call_ids: list[str],
    calls: list[dict[str, Any]],
    read_tool_result: Callable[[], dict[str, Any]],
    repeats: RepeatFailures | None = None,
) -> list[dict[str, Any]]:
    """Reads one `tool_result` per call, in whatever order they arrive, and returns the
    `functionResponse` parts in the order the calls were made. Gemini pairs each response with its
    call by position, so the history has to follow the model's order even when the results didn't.
    A result for an unknown id, or a second result for the same id, is a caller bug and fails the turn."""
    pending = set(call_ids)
    results: dict[str, Any] = {}
    while pending:
        message = read_tool_result()
        result_id = message.get("id")
        if result_id in results:
            raise ChatError(f"Tool result for call {result_id!r} was sent twice")
        if result_id not in pending:
            raise ChatError(f"Tool result for unknown call id {result_id!r}")
        pending.discard(result_id)
        results[result_id] = message.get("result")

    parts = []
    for call_id, call in zip(call_ids, calls):
        result = (
            repeats.annotate(call.get("name"), call.get("args"), results[call_id])
            if repeats
            else results[call_id]
        )
        response: dict[str, Any] = {"name": call.get("name"), "response": {"result": result}}
        # Newer models tag each call with their own id; echoing it pairs the answer explicitly.
        if call.get("id"):
            response["id"] = call["id"]
        parts.append({"functionResponse": response})
    return parts


def _add_usage(usage: dict[str, int], data: dict[str, Any]) -> None:
    meta = data.get("usageMetadata") if isinstance(data, dict) else None
    usage["steps"] += 1
    if not isinstance(meta, dict):
        return
    for field, key in (
        ("promptTokenCount", "promptTokens"),
        ("cachedContentTokenCount", "cachedTokens"),
        ("candidatesTokenCount", "outputTokens"),
        ("thoughtsTokenCount", "thoughtsTokens"),
    ):
        value = meta.get(field)
        if isinstance(value, int):
            usage[key] += value


def _response_parts(data: Any) -> list[Any] | None:
    """The first candidate's parts, or None when the response carries no usable content."""
    try:
        parts = data["candidates"][0]["content"]["parts"]
    except (KeyError, IndexError, TypeError):
        return None
    return parts if isinstance(parts, list) and parts else None


def _no_answer_notice(data: Any) -> str:
    reason = None
    if isinstance(data, dict):
        feedback = data.get("promptFeedback")
        if isinstance(feedback, dict):
            reason = feedback.get("blockReason")
        candidates = data.get("candidates")
        if not reason and isinstance(candidates, list) and candidates and isinstance(candidates[0], dict):
            reason = candidates[0].get("finishReason")
    return (
        f"Gemini returned no answer for that (reason: {reason or 'unknown'}). Nothing further was "
        "changed — try rephrasing the request."
    )
