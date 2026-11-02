"""The Gemini API transport pieces the chat loop uses, from VibeCut's rough-cut-studio gemini_client.py.

Talks to the Gemini API's generateContent endpoint over plain HTTPS with ``requests`` (no SDK). The API
key arrives in the stdin request (Rust injects it), goes only into the ``x-goog-api-key`` header, and is
scrubbed from every error message (redact.py).
"""

import random
import time
from collections.abc import Callable
from typing import Any

from vibecut_agent.agent.redact import scrub

GEMINI_ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent"
# The chat's answers as they're written (Phase 8b): the same request, answered as server-sent events.
GEMINI_STREAM_ENDPOINT = (
    "https://generativelanguage.googleapis.com/v1beta/models/{model}:streamGenerateContent?alt=sse"
)

# 503 (model overloaded, common on the free tier at peak hours) and 429 (rate limited) are worth
# retrying; anything else (400, 401/403 bad key...) is not transient and fails fast.
RETRYABLE_STATUSES = {429, 503}
MAX_ATTEMPTS = 4
BASE_DELAY_SECONDS = 2.0

# on_retry(attempt, max_attempts, wait_seconds, reason): told before each backoff wait.
OnRetry = Callable[[int, int, float, str], None] | None

# The Gemini API's two tiers (model migration v2, PLAN.md D1): Flash for the chat, titles, the first pass
# and the critic; Pro for the Story Editor's narrative pass and the "Gemini Pro" chat choice.
FLASH_MODEL = "gemini-3.8-flash"
PRO_MODEL = "gemini-3.1-pro-preview"
# A model this key can't reach (HTTP 404: retired, or not offered to the project) is tried once more on
# the next one down, and the caller says so (D2), so Pro never quietly becomes Flash.
FALLBACK_MODELS = {PRO_MODEL: FLASH_MODEL, FLASH_MODEL: "gemini-flash-latest"}
# Settings' effort as Gemini 3's thinking level (thinkingConfig.thinkingLevel). The Pro models take only
# low and high, so medium is high there.
GEMINI_THINKING_LEVELS = ("low", "medium", "high")


def thinking_level(model: str, effort: str | None) -> str | None:
    """The thinking level for `model` at Settings' `effort`, or None when the model takes none (before
    Gemini 3, or no effort set)."""
    if effort not in GEMINI_THINKING_LEVELS or not model.startswith("gemini-3"):
        return None
    return "high" if effort == "medium" and "-pro" in model else effort


def generation_config(model: str, effort: str | None = None, temperature: float = 0.4) -> dict[str, Any]:
    """`generationConfig` for one call. Gemini 3 is left at its own temperature (Google: lower ones can
    make it loop), and given the thinking level when there is one (D13)."""
    if not model.startswith("gemini-3"):
        return {"temperature": temperature}
    level = thinking_level(model, effort)
    return {"thinkingConfig": {"thinkingLevel": level}} if level else {}


def fallback_notice(model: str, fallback: str) -> str:
    return f"{model} isn't available on this Gemini API key; using {fallback} instead."


class GeminiError(Exception):
    pass


def _scrub_secret(err: Exception, secret: str) -> str:
    """str(err) with any occurrence of the raw API key removed."""
    return scrub(err, secret)


def _overload_message(resp: Any) -> str:
    if resp.status_code == 503:
        return (
            "Gemini's servers are temporarily overloaded (HTTP 503). "
            f"Retried {MAX_ATTEMPTS} times with backoff and it's still busy. This is on Google's end, "
            "not the app. Wait a minute and send your message again, or choose another model."
        )
    return (
        "Gemini rate-limited this request (HTTP 429). "
        f"Retried {MAX_ATTEMPTS} times. If this keeps happening, you may be hitting the free tier's "
        "requests-per-minute limit. Wait a bit and retry."
    )


def _wait_before_retry(attempt: int, on_retry: OnRetry, reason: str) -> None:
    # Exponential backoff with jitter: ~2s, ~4s, ~8s.
    wait_seconds = BASE_DELAY_SECONDS * (2 ** (attempt - 1))
    wait_seconds += random.uniform(0, 0.5)
    if on_retry:
        try:
            on_retry(attempt, MAX_ATTEMPTS, wait_seconds, reason)
        except Exception:  # noqa: BLE001, S110 - never let a UI callback break the retry loop
            pass
    time.sleep(wait_seconds)
