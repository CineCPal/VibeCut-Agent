"""claude_chat.py

The chat agent's tool-calling loop on Claude — the same contract as gemini_chat.run_chat_turn (same
arguments, same `emit`/`read_tool_result` protocol, same return shape), so headless.py's chat session
runs either one unchanged and the frontend's executors never know which model is driving.

What differs from Gemini, and why:
- History is Claude's own `messages` list, with every response's full `content` kept as is: thinking
  blocks (with their signatures), `tool_use` blocks and compaction blocks all have to come back
  unchanged on the next request.
- That history is only ever appended to. On Claude Opus 5.5 / Sonnet 5.5 a thinking block is bound to
  the exact conversation before it (system prompt, tools, every earlier message); dropping old turns
  from the front, as the frontend does for Gemini, would invalidate every later block. Long sessions
  are bounded by server-side compaction instead (`compact_20260112`), and
  `prefix_mismatch_behavior: "drop_block"` makes an unexpected edit degrade (the stale reasoning is
  dropped) rather than fail the turn.
- The system prompt and the tool list are cached (`cache_control` on the system block covers both,
  since tools render first), and a top-level `cache_control` caches the growing conversation, so each
  step of a long turn pays full price only for what's new.
- Text the model writes between tool calls comes back as short progress-update thinking blocks
  (`display: "updates"`); each one is emitted as a status line so a long turn isn't silent.
- The answer streams to the app as it's written (streaming.py, Phase 8b). Text written before a tool
  call ends with `reply_break`, so it stays a message of its own.
- The step budget's notes (chat_steps.py) are text blocks after the tool results, which keeps the
  history append-only. The last step sets `tool_choice: none`: that costs the messages cache for that
  one call, but leaves thinking blocks valid (tool_choice isn't part of what they're bound to).
"""

from __future__ import annotations

import json
import sys
from collections.abc import Callable
from typing import Any

from vibecut_agent.agent.chat_steps import (
    DEFAULT_MAX_STEPS,
    OUT_OF_STEPS_NOTICE,
    RepeatFailures,
    budget_note,
    is_last_step,
)
from vibecut_agent.agent.claude_client import EFFORT, FALLBACK_BETA, add_usage, resolve_model, send, text_of
from vibecut_agent.agent.claude_schema import to_claude_tools
from vibecut_agent.agent.gemini_chat import STOPPED_NOTICE, ChatError
from vibecut_agent.agent.gemini_client import OnRetry
from vibecut_agent.agent.redact import scrub
from vibecut_agent.agent.streaming import ReplyStream

BETAS = [
    "compact-2026-01-12",
    "thinking-binding-controls-2026-08-01",
    "thinking-display-updates-2026-08-18",
    FALLBACK_BETA,
]


def _base_params(
    model: str, system_instruction: str, tool_declarations: list[dict[str, Any]]
) -> dict[str, Any]:
    params: dict[str, Any] = {
        "model": model,
        "max_tokens": 64000,
        "system": [{"type": "text", "text": system_instruction, "cache_control": {"type": "ephemeral"}}],
        "cache_control": {"type": "ephemeral"},
        "thinking": {
            "type": "adaptive",
            "display": "updates",
            "block_binding": {"prefix_mismatch_behavior": "drop_block"},
        },
        "output_config": {"effort": EFFORT[model]},
        "context_management": {"edits": [{"type": "compact_20260112"}]},
        "betas": BETAS,
        "fallbacks": "default",
    }
    tools = to_claude_tools(tool_declarations)
    if tools:
        params["tools"] = tools
    return params


def _no_answer_notice(message: dict[str, Any]) -> str | None:
    """A plain-language answer for a response that ended without one, or None if it's a normal end."""
    reason = message.get("stop_reason")
    if reason == "refusal":
        return "Claude declined to help with that. Nothing further was changed — try rephrasing the request."
    if reason == "max_tokens":
        return (
            "My answer ran past the length limit before I finished. Edits made before this are still "
            "applied — ask me to continue."
        )
    return None


def _tool_result_block(call_id: str, result: Any) -> dict[str, Any]:
    content = result if isinstance(result, str) else json.dumps(result, ensure_ascii=False, default=str)
    block: dict[str, Any] = {"type": "tool_result", "tool_use_id": call_id, "content": content}
    if isinstance(result, dict) and "error" in result:
        block["is_error"] = True
    return block


def _collect_tool_results(
    calls: list[dict[str, Any]],
    read_tool_result: Callable[[], dict[str, Any]],
    repeats: RepeatFailures | None = None,
) -> list[dict[str, Any]]:
    """One `tool_result` per call, in whatever order they arrive, answered in the order the model
    made the calls, all in one user message (splitting them teaches the model to stop calling tools
    in parallel). An unknown or repeated id is a caller bug and fails the turn."""
    call_ids = [str(call.get("id")) for call in calls]
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
    return [
        _tool_result_block(
            call_id,
            repeats.annotate(call.get("name"), call.get("input"), results[call_id])
            if repeats
            else results[call_id],
        )
        for call_id, call in zip(call_ids, calls)
    ]


def _report_dropped_thinking(message: dict[str, Any]) -> None:
    """Logs (to stderr, which the app keeps as sidecar log lines) any thinking the API dropped because
    the history changed under it. It should never happen — the history is append-only — so one
    showing up is worth seeing in a live check."""
    dropped = [
        t
        for t in message.get("input_transformations") or []
        if isinstance(t, dict) and t.get("type") == "thinking_dropped"
    ]
    if dropped:
        print(
            f"claude_chat: the API dropped {len(dropped)} thinking block(s): {json.dumps(dropped)[:500]}",
            file=sys.stderr,
        )


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
    timeout: int = 120,
    on_retry: OnRetry = None,
    should_abort: Callable[[], bool] = lambda: False,
) -> dict[str, Any]:
    """Runs Claude's tool-use loop for one user chat message, end to end. See
    gemini_chat.run_chat_turn for the shared contract; `history` here is the `messages` list a
    previous call returned, resent verbatim and only ever appended to."""
    if not api_key or not api_key.strip():
        raise ChatError("No Claude API key was provided.")
    if not user_message or not user_message.strip():
        raise ChatError("The chat message was empty.")

    resolved_model = resolve_model(model)
    reply = ReplyStream(emit)
    emit = reply.emit
    messages: list[dict[str, Any]] = [*history, {"role": "user", "content": user_message}]
    params = _base_params(resolved_model, system_instruction, tool_declarations)
    usage = {"promptTokens": 0, "cachedTokens": 0, "outputTokens": 0, "thoughtsTokens": 0, "steps": 0}
    repeats = RepeatFailures()

    def finish(text: str, aborted: bool = False, out_of_steps: bool = False) -> dict[str, Any]:
        return {
            "text": text,
            "history": messages,
            "usage": usage,
            "aborted": aborted,
            "outOfSteps": out_of_steps,
        }

    def add_note(note: str) -> None:
        last_message = messages[-1]
        if last_message.get("role") != "user":
            # After a pause_turn the last message is the assistant's; the note gets its own turn.
            messages.append({"role": "user", "content": [{"type": "text", "text": note}]})
        elif isinstance(last_message.get("content"), str):
            last_message["content"] = [
                {"type": "text", "text": last_message["content"]},
                {"type": "text", "text": note},
            ]
        else:
            last_message["content"].append({"type": "text", "text": note})

    def stop() -> dict[str, Any]:
        messages.append({"role": "assistant", "content": [{"type": "text", "text": STOPPED_NOTICE}]})
        return finish(STOPPED_NOTICE, aborted=True)

    def show_progress(block: dict[str, Any]) -> None:
        note = block.get("thinking") if block.get("type") == "thinking" else None
        if isinstance(note, str) and note.strip():
            emit("status", phase="progress", detail=note.strip())

    for step in range(1, max_iterations + 1):
        if should_abort():
            return stop()
        last = is_last_step(step, max_iterations)
        note = budget_note(step, max_iterations)
        if note:
            add_note(note)
        request = {**params, "messages": messages}
        if last and "tools" in params:
            request["tool_choice"] = {"type": "none"}
        emit("status", phase="calling_model", detail="Calling Claude…")
        try:
            response = send(
                api_key,
                request,
                timeout=timeout,
                on_retry=on_retry,
                should_abort=should_abort,
                on_block=show_progress,
                on_text=reply.text,
                on_reset=reply.reset,
            )
        except ChatError as exc:
            raise ChatError(scrub(exc, api_key)) from None
        reply.flush()
        if response is None:
            return stop()
        add_usage(usage, response)
        _report_dropped_thinking(response)

        content = [b for b in response.get("content") or [] if isinstance(b, dict)]
        calls = [b for b in content if b.get("type") == "tool_use"]
        notice = _no_answer_notice(response)

        if last:
            # Tools were off; a stray tool_use is dropped so the history never holds an unanswered one.
            kept = [b for b in content if b.get("type") != "tool_use"]
            answer = text_of(response).strip() or notice or OUT_OF_STEPS_NOTICE
            if not text_of(response).strip():
                kept.append({"type": "text", "text": answer})
            messages.append({"role": "assistant", "content": kept})
            return finish(answer, out_of_steps=True)

        if calls and should_abort():
            return stop()
        if notice and not calls:
            messages.append({"role": "assistant", "content": [*content, {"type": "text", "text": notice}]})
            return finish(notice)
        if not content:
            notice = (
                "Claude returned an empty answer. Nothing further was changed — try rephrasing the request."
            )
            messages.append({"role": "assistant", "content": [{"type": "text", "text": notice}]})
            return finish(notice)
        messages.append({"role": "assistant", "content": content})

        if response.get("stop_reason") == "pause_turn":
            continue
        if not calls:
            return finish(text_of(response))

        reply.brk()
        call_ids = [str(call.get("id")) for call in calls]
        emit(
            "tool_calls",
            calls=[
                {"id": call_id, "name": call.get("name"), "args": call.get("input") or {}}
                for call_id, call in zip(call_ids, calls)
            ],
        )
        messages.append({"role": "user", "content": _collect_tool_results(calls, read_tool_result, repeats)})

    # Only reached with max_iterations < 1: no step was ever taken.
    messages.append({"role": "assistant", "content": [{"type": "text", "text": OUT_OF_STEPS_NOTICE}]})
    return finish(OUT_OF_STEPS_NOTICE, out_of_steps=True)
