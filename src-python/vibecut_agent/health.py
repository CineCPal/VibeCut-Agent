"""``health``: a one-shot check that the sidecar's Python environment starts and answers."""

from __future__ import annotations

import platform
import sys
from typing import Any, TextIO

from vibecut_agent import __version__
from vibecut_agent.protocol import Emitter, read_request


def describe() -> dict[str, Any]:
    return {
        "version": __version__,
        "python": platform.python_version(),
        "executable": sys.executable,
        "platform": platform.platform(),
    }


def run(emitter: Emitter, stdin: TextIO) -> int:
    read_request(stdin)
    emitter.emit("result", **describe())
    return 0
