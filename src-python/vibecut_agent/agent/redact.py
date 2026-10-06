"""redact.py

One place that keeps secrets (the Gemini API key) out of anything this process shows or prints:
error strings returned to the frontend, protocol `error` events, and tracebacks written to stderr.

A key is registered once, where it enters the process (a request's `apiKey`, a key the standalone
app loads or saves), and from then on `scrub` removes it from any text. Registration is
process-wide on purpose: a traceback printed deep inside `api.py` has no key in hand to scrub
with, and threading one through every call site would be easy to miss. Registered values stay
in memory only, like the key itself; nothing here logs or persists them.
"""

from __future__ import annotations

import sys
import threading
import traceback
from typing import Any, TextIO

REDACTED = "[REDACTED]"

_lock = threading.Lock()
_secrets: set[str] = set()


def register_secret(value: Any) -> None:
    """Remembers `value` as a secret to scrub from now on. Ignores anything that isn't a non-empty
    string, so a missing key (Ollama-only runs) is a no-op rather than an empty pattern that would
    match everywhere."""
    if not isinstance(value, str):
        return
    value = value.strip()
    if value:
        with _lock:
            _secrets.add(value)


def scrub(text: Any, *extra: Any) -> str:
    """`str(text)` with every registered secret, and every `extra` one, replaced by `[REDACTED]`.
    Longest first, so a secret that contains a shorter one is removed whole."""
    result = str(text)
    with _lock:
        secrets = set(_secrets)
    secrets.update(s.strip() for s in extra if isinstance(s, str) and s.strip())
    for secret in sorted(secrets, key=len, reverse=True):
        result = result.replace(secret, REDACTED)
    return result


def print_scrubbed_exc(file: TextIO | None = None) -> None:
    """`traceback.print_exc()`, with the text scrubbed before it reaches stderr."""
    stream = file if file is not None else sys.stderr
    stream.write(scrub(traceback.format_exc()))
    stream.flush()


def _reset_for_tests() -> None:
    with _lock:
        _secrets.clear()
