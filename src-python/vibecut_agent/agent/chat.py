"""``chat``: one conversation with the editing agent, ported from VibeCut's rough-cut-studio
``headless.run_chat``.

Rust starts it with ``sidecar_start`` (an interactive command: stdin stays open) and injects the chosen
provider's API key into the first request; the frontend never holds a key.

First stdin line: {
    "provider": "gemini" | "claude" | "claude-code" (optional, "gemini" when absent),
    "apiKey": str (injected by Rust; not for "claude-code"),
    "claudeCode": {...} (injected by Rust for "claude-code" only: see claude_code_chat.py),
    "model": str (optional),
    "effort": "low" | "medium" | "high" | "xhigh" | "max" (optional; Claude only, Phase 9a: medium when absent),
    "systemInstruction": str,
    "toolDeclarations": [{"name", "description", "parameters": <Gemini OpenAPI schema>}, ...],
    "history": [...] (the previous ``result.history``, or [] for a new conversation),
    "userMessage": str,
    "attachments": [{"mime", "data"}] (optional: up to 4 base64 images sent with the message, Phase 8g),
    "maxSteps": int (optional, held to 10-150)
}

Within a turn, whenever the model wants tools this emits ``tool_calls {calls: [{id, name, args}]}`` and
blocks for one ``{"type": "tool_result", "id", "result"}`` line per call, in any order. The app runs the
tools (src/lib/agent/). ``{"type": "abort_turn"}`` may arrive at any time (Stop). On "claude-code" no
``tool_calls`` are emitted: Claude Code calls the tools through the MCP bridge (Phase 7a) instead.

While the model writes, ``reply_delta {text}`` carries the answer as it's written, ``reply_break`` ends text
said before a tool call (it stays a message of its own), and ``reply_reset`` voids the text so far (a
retried call). See streaming.py (Phase 8b).

On "claude-code", ``rate_limit {limits}`` reports the Claude plan's usage windows as Claude Code sees
them (claude_code_chat.plan_limits, Phase 9b).

Each turn ends with ``result {text, history, usage, aborted, outOfSteps}``; its ``text`` is the final
answer and replaces what was streamed. The process then waits up to
CHAT_IDLE_TIMEOUT_SECONDS for ``{"type": "user_message", "userMessage", "history", "attachments"?}`` (the next message,
with the app's history: the app is the source of truth) or ``{"type": "end_session"}``. A genuine API
failure emits ``error`` and exits 1.
"""

from __future__ import annotations

import os
from collections.abc import Callable
from typing import Any

from vibecut_agent.agent.redact import register_secret, scrub
from vibecut_agent.protocol import Emitter, RequestError

# How long a conversation's process waits for another message before exiting quietly (not an error).
CHAT_IDLE_TIMEOUT_SECONDS = float(os.environ.get("VIBECUT_CHAT_IDLE_TIMEOUT_SECONDS", "600"))

PROVIDER_NAMES = {"gemini": "Gemini", "claude": "Claude", "claude-code": "Claude (subscription)"}


def provider_of(request: dict[str, Any]) -> str:
    """The request's provider: "gemini" when absent; anything other than the two known names is refused."""
    provider = request.get("provider") or "gemini"
    if provider not in PROVIDER_NAMES:
        raise RequestError(f"Unknown provider {provider!r}")
    return str(provider)


def _provider_key(request: dict[str, Any], provider: str) -> str:
    api_key = (request.get("apiKey") or "").strip()
    if not api_key:
        raise RequestError(f"No {PROVIDER_NAMES[provider]} API key was provided.")
    return str(api_key)


def run_chat(request: dict[str, Any], emitter: Emitter, channel: Any) -> int:
    """Runs the whole conversation; see the module docstring. ``channel`` yields the later stdin lines
    (a LineChannel in production)."""
    from vibecut_agent.agent.attachments import parse_images
    from vibecut_agent.agent.chat_steps import DEFAULT_MAX_STEPS, clamp_max_steps
    from vibecut_agent.agent.gemini_chat import ChatError

    # From here on the key is scrubbed from every error event and printed traceback.
    register_secret(request.get("apiKey"))
    provider = provider_of(request)
    if provider == "claude-code":
        # Claude (subscription), Phase 7b: no key; Rust put the Claude Code setup in `claudeCode`.
        from vibecut_agent.agent import claude_code_chat

        setup = request.get("claudeCode")

        def subscription_turn(**turn: Any) -> dict[str, Any]:
            return claude_code_chat.run_chat_turn(
                setup,
                turn["model"],
                turn["system_instruction"],
                turn["history"],
                turn["user_message"],
                turn["emit"],
                images=turn["images"],
                should_abort=turn["should_abort"],
                max_iterations=turn["max_iterations"],
                effort=turn.get("effort"),
            )

        run_chat_turn: Callable[..., dict[str, Any]] = subscription_turn
        api_key = ""
    else:
        if provider == "claude":
            from vibecut_agent.agent import claude_chat as provider_chat
        else:
            from vibecut_agent.agent import gemini_chat as provider_chat  # type: ignore[no-redef]

        run_chat_turn = provider_chat.run_chat_turn
        api_key = _provider_key(request, provider)
    model = request.get("model") or None
    # Settings' effort (Phase 9a), for Claude only; Gemini's loop takes no such argument.
    effort_args: dict[str, Any] = {"effort": request.get("effort")} if provider != "gemini" else {}
    system_instruction = request.get("systemInstruction") or ""
    max_steps = clamp_max_steps(request["maxSteps"]) if "maxSteps" in request else DEFAULT_MAX_STEPS

    tool_declarations = request.get("toolDeclarations") or []
    if not isinstance(tool_declarations, list):
        raise RequestError("toolDeclarations must be a list")

    # Stop pressed: `abort_turn` can arrive at any point in a turn. It is noted here and acted on by
    # run_chat_turn's `should_abort` checks; one arriving after the turn ended is ignored below.
    abort = {"requested": False}
    # Lines picked up while checking for an abort that belong to someone else (a tool_result, or a
    # later message already queued), kept in order for whoever reads next.
    held: list[dict[str, Any]] = []

    def next_message(timeout: float | None = None) -> dict[str, Any] | None:
        return held.pop(0) if held else channel.read(timeout=timeout)

    def take_abort_messages() -> None:
        while True:
            message = channel.poll()
            if message is None:
                return
            if message.get("type") == "abort_turn":
                abort["requested"] = True
            else:
                held.append(message)

    def should_abort() -> bool:
        take_abort_messages()
        return abort["requested"]

    def read_tool_result() -> dict[str, Any]:
        # No timeout: once a tool call has been requested, the app always owes a reply next.
        while True:
            message = next_message()
            if message is None:
                continue
            if message.get("type") == "abort_turn":
                abort["requested"] = True
                continue
            if message.get("type") != "tool_result":
                raise RequestError(f"Expected a tool_result message, got: {message.get('type')!r}")
            return message

    def notify_retry(attempt: int, max_attempts: int, wait_seconds: float, reason: str) -> None:
        emitter.emit(
            "retry",
            attempt=attempt,
            maxAttempts=max_attempts,
            waitSeconds=round(wait_seconds, 1),
            reason=reason,
        )

    def run_one_turn(user_message: Any, history: Any, attachments: Any) -> bool:
        """Runs one turn and emits its outcome. False means a genuine ChatError: exit with an error."""
        if not isinstance(user_message, str) or not user_message.strip():
            raise RequestError("userMessage must be non-empty text")
        if not isinstance(history, list):
            raise RequestError("history must be a list")
        images = parse_images(attachments)
        abort["requested"] = False
        try:
            outcome = run_chat_turn(
                api_key=api_key,
                model=model,
                system_instruction=system_instruction,
                tool_declarations=tool_declarations,
                history=history,
                user_message=user_message,
                images=images,
                emit=emitter.emit,
                read_tool_result=read_tool_result,
                on_retry=notify_retry,
                should_abort=should_abort,
                max_iterations=max_steps,
                **effort_args,
            )
        except ChatError as exc:
            emitter.error(scrub(exc, api_key))
            return False
        emitter.emit(
            "result",
            text=outcome["text"],
            history=outcome["history"],
            usage=outcome.get("usage"),
            aborted=bool(outcome.get("aborted")),
            outOfSteps=bool(outcome.get("outOfSteps")),
        )
        return True

    if not run_one_turn(request.get("userMessage"), request.get("history") or [], request.get("attachments")):
        return 1

    while True:
        message = next_message(timeout=CHAT_IDLE_TIMEOUT_SECONDS)
        if message is None:
            return 0  # idle timeout: a quiet, expected end
        message_type = message.get("type")
        if message_type == "end_session":
            return 0
        if message_type == "abort_turn":
            continue  # Stop pressed just as the turn ended on its own
        if message_type != "user_message":
            raise RequestError(f"Expected a user_message or end_session message, got: {message_type!r}")
        if not run_one_turn(message.get("userMessage"), message.get("history") or [], message.get("attachments")):
            return 1
