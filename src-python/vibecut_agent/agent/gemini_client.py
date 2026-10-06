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

# 503 (model overloaded, common on the free tier at peak hours) and 429 (rate limited) are worth
# retrying; anything else (400, 401/403 bad key...) is not transient and fails fast.
RETRYABLE_STATUSES = {429, 503}
MAX_ATTEMPTS = 4
BASE_DELAY_SECONDS = 2.0

# on_retry(attempt, max_attempts, wait_seconds, reason): told before each backoff wait.
OnRetry = Callable[[int, int, float, str], None] | None


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
