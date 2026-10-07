"""claude_client.py

The one place VibeCut talks to the Claude API (Anthropic's Messages API, through the official
`anthropic` SDK): the request plumbing for the chat agent (claude_chat.py).

Retries: the SDK's own retry loop is turned off (`max_retries=0`) and replaced with the same
backoff-and-report loop gemini_client.py uses, so a busy API surfaces as the app's "Retrying…" status
instead of a silent stall. 429 (honouring `retry-after`), 5xx/529 and connection errors are retried.

Security notes, as for Gemini: the key arrives in the request only (Rust injects it from
`ANTHROPIC_API_KEY`), is never logged or written anywhere, travels only in the SDK's `x-api-key`
header, and every error text is scrubbed of it before it leaves this module.
"""

from __future__ import annotations

import random
import time
from collections.abc import Callable
from typing import Any

import anthropic

from vibecut_agent.agent.gemini_chat import ChatError
from vibecut_agent.agent.gemini_client import OnRetry
from vibecut_agent.agent.redact import scrub

OPUS = "claude-opus-5-5"
SONNET = "claude-sonnet-5-5"
MODELS = (OPUS, SONNET)
DEFAULT_MODEL = SONNET

# Opus 5.5 defaults to "medium" effort; the agent's multi-step edits want "high". Sonnet 5.5's levels
# are recalibrated, and "medium" is its recommended start for multi-step tool use.
EFFORT = {OPUS: "high", SONNET: "medium"}

MAX_ATTEMPTS = 4
BASE_DELAY_SECONDS = 2.0
MAX_RETRY_AFTER_SECONDS = 60.0

# Refusal fallback: if a safety classifier declines a request, the API re-runs it on a model that can
# answer, inside the same call ("default" picks by refusal category).
FALLBACK_BETA = "server-side-fallback-2026-07-01"


class ClaudeError(ChatError):
    """A Claude request could not be completed."""


def resolve_model(model: str | None) -> str:
    """The model to call: one of `MODELS`, else the default. The frontend only offers these two."""
    return model if model in MODELS else DEFAULT_MODEL


def _make_client(api_key: str, timeout: float) -> anthropic.Anthropic:
    # A float timeout applies per phase (connect, each read), so a long streamed turn is fine as long
    # as events keep arriving.
    return anthropic.Anthropic(api_key=api_key, max_retries=0, timeout=timeout)


def _retry_after(error: anthropic.APIStatusError) -> float | None:
    try:
        value = float(error.response.headers.get("retry-after", ""))
    except (TypeError, ValueError, AttributeError):
        return None
    return min(max(value, 0.0), MAX_RETRY_AFTER_SECONDS)


def _wait_before_retry(attempt: int, on_retry: OnRetry, reason: str, at_least: float | None = None) -> None:
    wait_seconds = BASE_DELAY_SECONDS * (2 ** (attempt - 1)) + random.uniform(0, 0.5)
    if at_least is not None:
        wait_seconds = max(wait_seconds, at_least)
    if on_retry:
        try:
            on_retry(attempt, MAX_ATTEMPTS, wait_seconds, reason)
        except Exception:  # noqa: BLE001, S110 - never let a UI callback break the retry loop
            pass
    time.sleep(wait_seconds)


def _busy_message(status: int) -> str:
    if status == 429:
        return (
            f"Claude rate-limited this request (HTTP 429). Retried {MAX_ATTEMPTS} times — wait a "
            "minute and try again."
        )
    return (
        f"Claude's servers are busy (HTTP {status}). Retried {MAX_ATTEMPTS} times with backoff — "
        "wait a minute and try again, or switch models."
    )


def _status_message(error: anthropic.APIStatusError, api_key: str) -> str:
    if error.status_code == 401:
        return "Claude rejected the API key (HTTP 401). Check ANTHROPIC_API_KEY."
    return f"Claude API returned HTTP {error.status_code}: {scrub(error.message, api_key)[:500]}"


def send(
    api_key: str,
    params: dict[str, Any],
    timeout: float = 120,
    on_retry: OnRetry = None,
    should_abort: Callable[[], bool] = lambda: False,
    on_block: Callable[[dict[str, Any]], None] | None = None,
    on_text: Callable[[str], None] | None = None,
    on_reset: Callable[[], None] | None = None,
) -> dict[str, Any] | None:
    """One streamed Messages request (beta namespace, for the betas in `params["betas"]`), retried on
    transient failures. Returns the final message as a plain dict, or None when `should_abort()`
    turned true while it streamed (the partial answer is discarded, so history never holds it).

    `on_block(block)` is called with each content block as it completes — the chat loop uses it to
    show the model's progress notes while a long turn is still running. `on_text(delta)` gets the
    answer's text as it's written (Phase 8b), and `on_reset()` is called before a retry starts the
    answer over."""
    if not api_key or not api_key.strip():
        raise ClaudeError("No Claude API key was provided.")
    client = _make_client(api_key, timeout)
    last_error: ClaudeError | None = None
    for attempt in range(1, MAX_ATTEMPTS + 1):
        if attempt > 1 and on_reset:
            on_reset()
        try:
            with client.beta.messages.stream(**params) as stream:
                for event in stream:
                    if should_abort():
                        return None
                    if on_text and getattr(event, "type", None) == "content_block_delta":
                        delta = getattr(event, "delta", None)
                        piece = getattr(delta, "text", None) if getattr(delta, "type", None) == "text_delta" else None
                        if isinstance(piece, str) and piece:
                            on_text(piece)
                    if on_block and getattr(event, "type", None) == "content_block_stop":
                        block = getattr(event, "content_block", None)
                        if block is not None:
                            on_block(block.model_dump(exclude_none=True))
                message = stream.get_final_message()
            return message.model_dump(exclude_none=True)
        except anthropic.APIStatusError as error:
            status = error.status_code
            if status == 429 or status >= 500:
                last_error = ClaudeError(_busy_message(status))
                if attempt < MAX_ATTEMPTS:
                    _wait_before_retry(attempt, on_retry, f"HTTP {status}", _retry_after(error))
                    continue
                raise last_error from None
            raise ClaudeError(_status_message(error, api_key)) from None
        except anthropic.APIConnectionError as error:
            last_error = ClaudeError(f"Network error calling the Claude API: {scrub(error, api_key)}")
            if attempt < MAX_ATTEMPTS:
                _wait_before_retry(attempt, on_retry, "network error")
                continue
            raise last_error from None
    raise last_error or ClaudeError("Claude API request failed for an unknown reason.")


def add_usage(usage: dict[str, int], message: dict[str, Any]) -> None:
    """Adds one response's token counts to VibeCut's ChatUsage shape (src/types/chat.ts). Claude
    bills thinking as output, so `thoughtsTokens` stays 0."""
    usage["steps"] += 1
    counts = message.get("usage") if isinstance(message, dict) else None
    if not isinstance(counts, dict):
        return

    def count(key: str) -> int:
        value = counts.get(key)
        return value if isinstance(value, int) else 0

    cache_read = count("cache_read_input_tokens")
    usage["promptTokens"] += count("input_tokens") + cache_read + count("cache_creation_input_tokens")
    usage["cachedTokens"] += cache_read
    usage["outputTokens"] += count("output_tokens")


def text_of(message: dict[str, Any]) -> str:
    return "".join(
        block.get("text", "")
        for block in message.get("content") or []
        if isinstance(block, dict) and block.get("type") == "text"
    )


def to_claude_content(parts: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Gemini-shaped request parts (`{"text"}` / `{"inline_data": {mime_type, data}}`) as Claude content
    blocks, in the same order — so the critic and the looker build their prompt once for either model."""
    content: list[dict[str, Any]] = []
    for part in parts:
        if not isinstance(part, dict):
            continue
        if isinstance(part.get("text"), str) and part["text"]:
            content.append({"type": "text", "text": part["text"]})
        inline = part.get("inline_data")
        if isinstance(inline, dict) and inline.get("data"):
            source = {
                "type": "base64",
                "media_type": inline.get("mime_type") or "image/jpeg",
                "data": inline["data"],
            }
            content.append({"type": "image", "source": source})
    return content
