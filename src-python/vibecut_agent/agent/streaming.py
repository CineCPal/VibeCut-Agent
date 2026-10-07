"""streaming.py

The reply as it's written (PLAN.md, "Phase 8b"). Each provider hands its text deltas to a ReplyStream,
which sends them to the app as ``reply_delta {text}`` events, joined so a fast model doesn't send one
event per token:

- ``reply_delta {text}``: more of the reply. Sent once FLUSH_SECONDS have passed since the last one, or
  FLUSH_CHARS are waiting, and always before any other event this module sends.
- ``reply_break``: the text so far was said before a tool call. The app keeps it as its own message and
  starts a new one with the next delta.
- ``reply_reset``: the text so far is void (the call is being retried from the start). The app drops it.

The turn's ``result`` stays the authority on the final answer: the app replaces the streamed text with it.
"""

from __future__ import annotations

import time
from collections.abc import Callable
from typing import Any

FLUSH_SECONDS = 0.04
FLUSH_CHARS = 200


class ReplyStream:
    def __init__(self, emit: Callable[..., None], clock: Callable[[], float] = time.monotonic) -> None:
        self._emit = emit
        self._clock = clock
        self._waiting: list[str] = []
        self._waiting_chars = 0
        self._last_flush = clock()
        # Whether any text went out (or is waiting) since the last break or reset.
        self._started = False

    @property
    def started(self) -> bool:
        return self._started

    def text(self, delta: str) -> None:
        if not delta:
            return
        self._waiting.append(delta)
        self._waiting_chars += len(delta)
        self._started = True
        if self._waiting_chars >= FLUSH_CHARS or self._clock() - self._last_flush >= FLUSH_SECONDS:
            self.flush()

    def flush(self) -> None:
        if self._waiting:
            self._emit("reply_delta", text="".join(self._waiting))
            self._waiting.clear()
            self._waiting_chars = 0
        self._last_flush = self._clock()

    def brk(self) -> None:
        """The text so far came before a tool call. Nothing is sent if nothing was said."""
        if not self._started:
            return
        self.flush()
        self._emit("reply_break")
        self._started = False

    def reset(self) -> None:
        """The text so far is void. Nothing is sent if nothing was said."""
        if not self._started:
            return
        self._waiting.clear()
        self._waiting_chars = 0
        self._emit("reply_reset")
        self._started = False

    def emit(self, event_type: str, **fields: Any) -> None:
        """Any other event, sent after whatever text is waiting so the order holds."""
        self.flush()
        self._emit(event_type, **fields)
