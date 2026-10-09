"""The Phase 13 media commands, one-shot like `audio-peaks`: read the request, run, report `done`."""

from __future__ import annotations

from collections.abc import Callable
from typing import Any, TextIO

from vibecut_agent.protocol import Emitter, RequestError, read_request

Runner = Callable[[dict[str, Any], Emitter], int]


def main(name: str, run: Runner, stdin: TextIO, emitter: Emitter) -> int:
    emitter.emit("starting", tool=name, command=name)
    try:
        code = run(read_request(stdin), emitter)
    except RequestError as exc:
        emitter.error(str(exc))
        code = 2
    emitter.emit("done", cancelled=False)
    return code
