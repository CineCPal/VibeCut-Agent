"""``session``: the long-lived agent process.

Rust starts one session when the app launches and keeps its stdin open. The first line is the start
request; every later line is one message. The session ends on ``end_session`` or when stdin closes
(the app quit or was killed), so it can never outlive the app.

Messages handled here:
- ``ping`` (optional ``id``): answered with ``pong`` carrying the same ``id``.
- ``end_session``: answered with ``done``, then the session exits.

Anything else is answered with an ``error`` event; the session keeps running.
"""

from __future__ import annotations

from collections.abc import Callable
from typing import Any, TextIO

from vibecut_agent.health import describe
from vibecut_agent.protocol import Emitter, RequestError, parse_request_object, read_line_request

Handler = Callable[[Emitter, dict[str, Any]], None]


def _ping(emitter: Emitter, message: dict[str, Any]) -> None:
    emitter.emit("pong", id=message.get("id"))


HANDLERS: dict[str, Handler] = {"ping": _ping}


def handle(emitter: Emitter, message: dict[str, Any]) -> bool:
    """Handles one message. Returns False when the session should end."""
    kind = message.get("type")
    if kind == "end_session":
        emitter.emit("done", reason="ended")
        return False
    handler = HANDLERS.get(kind) if isinstance(kind, str) else None
    if handler is None:
        emitter.error(f"Unknown message type: {kind!r}")
        return True
    handler(emitter, message)
    return True


def run(emitter: Emitter, stdin: TextIO) -> int:
    read_line_request(stdin)
    emitter.emit("ready", **describe())
    while True:
        line = stdin.readline()
        if line == "":
            # stdin closed: the app is gone.
            return 0
        if not line.strip():
            continue
        try:
            message = parse_request_object(line)
        except RequestError as exc:
            emitter.error(str(exc))
            continue
        if not handle(emitter, message):
            return 0
