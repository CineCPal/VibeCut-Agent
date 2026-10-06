"""The JSON-lines protocol between the Rust bridge (`src-tauri/src/sidecar.rs`) and this sidecar.

Ported from VibeCut's ``rcs_utils.sidecar_protocol``. Rust starts a command with one JSON request on
stdin and the sidecar reports back with one JSON object per line on the protocol channel. Every event
has a string ``type``.

The protocol channel is a duplicate of the original stdout. ``Emitter.install`` then points
``sys.stdout`` at stderr, so a stray ``print`` from a library can never corrupt the stream. Rust
turns anything that is not a JSON object with a string ``type`` into a log line, never an event.

Common event types: ``ready``, ``progress`` (``done``, ``total``, ``fraction``, ``phase``,
``detail``), ``result``, ``error`` (``message``) and ``done``.

Secrets (API keys, tokens) arrive in the stdin request only, never in argv or the environment, and
must never be emitted back.
"""

from __future__ import annotations

import json
import os
import queue
import signal
import sys
import threading
from collections.abc import Callable
from typing import Any, TextIO


class Emitter:
    """Writes protocol events, one JSON object per line, flushing after each."""

    def __init__(self, stream: TextIO) -> None:
        self._stream = stream
        self._lock = threading.Lock()

    @classmethod
    def install(cls) -> Emitter:
        """Claims the real stdout for the protocol and redirects ``sys.stdout`` to stderr."""
        sys.stdout.flush()
        protocol_fd = os.dup(1)
        # Anything written to fd 1 from now on (including by C libraries) lands on stderr.
        os.dup2(2, 1)
        sys.stdout = sys.stderr
        stream = os.fdopen(protocol_fd, "w", encoding="utf-8", buffering=1)
        return cls(stream)

    def emit(self, event_type: str, **fields: Any) -> None:
        """Sends one event. Safe to call from several threads. A closed pipe is ignored."""
        payload = {"type": event_type, **fields}
        line = json.dumps(payload, ensure_ascii=False, allow_nan=False, default=str)
        with self._lock:
            try:
                self._stream.write(line + "\n")
                self._stream.flush()
            except (BrokenPipeError, ValueError, OSError):
                # The Rust side went away; there is nobody left to tell.
                pass

    def progress(
        self,
        done: float,
        total: float,
        phase: str | None = None,
        detail: str | None = None,
        **extra: Any,
    ) -> None:
        """Sends a ``progress`` event. ``fraction`` is ``done / total`` clamped to 0..1."""
        fraction = 0.0 if total <= 0 else min(1.0, max(0.0, done / total))
        self.emit(
            "progress",
            done=done,
            total=total,
            fraction=fraction,
            phase=phase,
            detail=detail,
            **extra,
        )

    def error(self, message: str) -> None:
        self.emit("error", message=message)


class CancelFlag:
    """Set when the bridge asks the sidecar to stop (SIGTERM)."""

    def __init__(self) -> None:
        self._event = threading.Event()

    def set(self) -> None:
        self._event.set()

    def is_set(self) -> bool:
        return self._event.is_set()

    def wait(self, timeout: float | None = None) -> bool:
        return self._event.wait(timeout)

    def install_sigterm_handler(self, on_cancel: Callable[[], None] | None = None) -> None:
        """Makes SIGTERM (and SIGINT) set the flag instead of killing the process outright.

        A command that polls the flag can wind down cleanly. One that cannot is stopped by the
        bridge's SIGKILL a few seconds later."""

        def handler(_signum: int, _frame: Any) -> None:
            self.set()
            if on_cancel is not None:
                on_cancel()

        signal.signal(signal.SIGTERM, handler)
        signal.signal(signal.SIGINT, handler)


class RequestError(ValueError):
    """The stdin request was missing, not JSON, or not an object."""


class StdinClosed(RequestError):
    """stdin reached EOF: the app that started this sidecar is gone."""


def parse_request_object(text: str) -> dict[str, Any]:
    if not text.strip():
        raise RequestError("No request was received on stdin")
    try:
        request = json.loads(text)
    except json.JSONDecodeError as exc:
        raise RequestError(f"The request is not valid JSON: {exc.msg}") from exc
    if not isinstance(request, dict):
        raise RequestError("The request must be a JSON object")
    return request


def read_request(stream: TextIO | None = None) -> dict[str, Any]:
    """Reads the single JSON request object of a one-shot command, to EOF.

    The bridge writes the request then closes the pipe, so this blocks until that happens. Not for
    an interactive command, whose stdin stays open: use :func:`read_line_request` there."""
    source = stream if stream is not None else sys.stdin
    return parse_request_object(source.read())


def read_line_request(stream: TextIO | None = None) -> dict[str, Any]:
    """Reads one JSON object from a single line, for an interactive command."""
    source = stream if stream is not None else sys.stdin
    return parse_request_object(source.readline())


class LineChannel:
    """Parsed JSON lines from stdin, fed by a background thread, for an interactive command that must
    wait for its next line with a timeout (a plain ``readline()`` blocks forever). Ported from VibeCut.

    Reads start wherever ``stream`` currently is, so a line already consumed by
    :func:`read_line_request` is never read again. Construct only one per process."""

    def __init__(self, stream: TextIO | None = None) -> None:
        self._queue: queue.Queue[str] = queue.Queue()
        source = stream if stream is not None else sys.stdin
        self._thread = threading.Thread(target=self._pump, args=(source,), daemon=True)
        self._thread.start()

    def _pump(self, source: TextIO) -> None:
        while True:
            line = source.readline()
            self._queue.put(line)
            if line == "":  # EOF
                return

    def read(self, timeout: float | None = None) -> dict[str, Any] | None:
        """The next non-blank line's JSON object, or ``None`` if ``timeout`` passes first. Raises
        RequestError when stdin has closed (the app is gone) or a line isn't a JSON object."""
        try:
            line = self._queue.get(timeout=timeout)
        except queue.Empty:
            return None
        if line == "":
            # Put EOF back so every later read reports it too.
            self._queue.put("")
            raise StdinClosed("stdin closed")
        if not line.strip():
            return None
        return parse_request_object(line)

    def poll(self) -> dict[str, Any] | None:
        """The next line's JSON object if one is already waiting, else None at once."""
        return self.read(timeout=0)


def require_absolute_paths(paths: list[Any], label: str = "path") -> None:
    """Rejects relative paths: the sidecar's working directory is not the user's."""
    for path in paths:
        if not isinstance(path, str) or not os.path.isabs(path):
            raise RequestError(f"The {label} must be an absolute path: {path!r}")
