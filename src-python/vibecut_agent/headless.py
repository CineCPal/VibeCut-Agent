"""Command-line entry for the sidecar: ``python -u -m vibecut_agent <command>``.

The command names here must match ``COMMANDS`` in `src-tauri/src/sidecar.rs`, which is the
allow-list the frontend can start.
"""

from __future__ import annotations

import sys
from collections.abc import Callable
from typing import TextIO

from vibecut_agent import health, session
from vibecut_agent.agent.chat import run_chat
from vibecut_agent.agent.redact import scrub
from vibecut_agent.nle.watch import PremiereAdapter, ResolveAdapter, watch
from vibecut_agent.protocol import Emitter, LineChannel, RequestError, read_line_request

Command = Callable[[Emitter, TextIO], int]


def chat(emitter: Emitter, stdin: TextIO) -> int:
    request = read_line_request(stdin)
    return run_chat(request, emitter, LineChannel(stdin))


def broll_analyze(emitter: Emitter, stdin: TextIO) -> int:
    # Imported here: OpenCV and numpy load only for the B-roll commands, never under ResolvePython.
    from vibecut_agent.broll import commands

    return commands.main("analyze", emitter, stdin)


def broll_match(emitter: Emitter, stdin: TextIO) -> int:
    from vibecut_agent.broll import commands

    return commands.main("match", emitter, stdin)


def broll_spyglass(emitter: Emitter, stdin: TextIO) -> int:
    """Searches Spyglass's index (Rough Cut Studio Suite - Blair Themed), read only."""
    from vibecut_agent.broll import commands

    return commands.main("spyglass", emitter, stdin)


def transcribe(emitter: Emitter, stdin: TextIO) -> int:
    """Local transcription (mlx-whisper; pyannote speaker labels with the `diarize` extra)."""
    from vibecut_agent.transcribe import commands

    return commands.main(stdin, emitter)


def audio_peaks(emitter: Emitter, stdin: TextIO) -> int:
    """Peak levels of media files, for the agent's find_silences."""
    from vibecut_agent import peaks

    return peaks.main(stdin, emitter)


def assemble(emitter: Emitter, stdin: TextIO) -> int:
    """The Story Editor: a story cut from transcripts (and a B-roll catalog) with the chat's model."""
    from vibecut_agent.story import commands

    return commands.main(stdin, emitter)


def chat_title(emitter: Emitter, stdin: TextIO) -> int:
    """A short name for a chat, from its first message and answer (Phase 8d)."""
    from vibecut_agent.agent import titles

    return titles.main(stdin, emitter)


def premiere_watch(emitter: Emitter, stdin: TextIO) -> int:
    read_line_request(stdin)
    return watch(PremiereAdapter(), LineChannel(stdin), emitter)


def resolve_watch(emitter: Emitter, stdin: TextIO) -> int:
    """Runs under Resolve's own Python (see sidecar.rs), which can load its scripting module."""
    read_line_request(stdin)
    return watch(ResolveAdapter(), LineChannel(stdin), emitter)


COMMANDS: dict[str, Command] = {
    "health": health.run,
    "session": session.run,
    "chat": chat,
    "broll-analyze": broll_analyze,
    "broll-match": broll_match,
    "broll-spyglass": broll_spyglass,
    "transcribe": transcribe,
    "audio-peaks": audio_peaks,
    "assemble": assemble,
    "chat-title": chat_title,
    "premiere-watch": premiere_watch,
    "resolve-watch": resolve_watch,
}


def dispatch(command: str, emitter: Emitter, stdin: TextIO) -> int:
    runner = COMMANDS.get(command)
    if runner is None:
        emitter.error(f"Unknown command: {command}")
        return 2
    try:
        return runner(emitter, stdin)
    except RequestError as exc:
        emitter.error(scrub(exc))
        return 2
    except Exception as exc:  # noqa: BLE001 - report every failure as a protocol event
        # scrub: a registered API key never reaches an error event.
        emitter.error(f"{type(exc).__name__}: {scrub(exc)}")
        return 1


def main(argv: list[str]) -> int:
    emitter = Emitter.install()
    if len(argv) != 1:
        emitter.error("Usage: python -m vibecut_agent <command>")
        return 2
    return dispatch(argv[0], emitter, sys.stdin)
