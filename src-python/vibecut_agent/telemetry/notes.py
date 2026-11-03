"""Claude's side of an orchestrated chat turn, for the visualizer (PLAN.md, Phase 22).

The chat process (agent/claude_code_chat.py) reads Claude Code's stream: its thinking, its reply and the
token usage of each model call. The trace is the MCP shim's (one writer per trace, spec decision V4), so
the chat only writes notes, one JSON line each, to `<telemetry>/notes/<job>.jsonl`, and the shim's
`NotesFollower` turns them into the root task's events:

- `{"thought": text}` and `{"text": text}`: STREAM_CHUNK on the THOUGHT and ASSISTANT_TEXT channels;
- `{"thinking": true}` and `{"tool": name}`: a line in the root's stream when Claude starts to think (Claude
  Code passes on the thinking itself empty) or calls a tool, so the stream shows what it's doing;
- `{"usage": {"input", "output", "cached"}}`: the turn's totals so far, which the chunks carry as
  `accumulated_tokens` (an empty chunk when nothing else is said, so the count moves) and the root's
  COMPLETED reports.

`NotesWriter` starts each turn's notes as a new file, renamed over the last turn's. A shim starts reading
where the file it found ended (`start_position`), so a shim started ahead of its turn (the app warms the
next Claude Code) never replays the last turn's notes: when the file there is another one, it reads that
from the start.
"""

from __future__ import annotations

import contextlib
import json
import os
import re
import threading
from pathlib import Path
from typing import Any, TextIO

from vibecut_agent.telemetry.bus import enabled_from_env, telemetry_dir

NOTES_FOLDER = "notes"
POLL_SECONDS = 0.1


def notes_path(caller: str, folder: Path | None = None) -> Path:
    name = re.sub(r"[^A-Za-z0-9-]", "-", caller)[:64] or "chat"
    return (folder if folder is not None else telemetry_dir()) / NOTES_FOLDER / f"{name}.jsonl"


# (inode, size) of a notes file; (0, 0) when there's none.
Position = tuple[int, int]


def file_position(path: Path) -> Position:
    try:
        stat = path.stat()
    except OSError:
        return (0, 0)
    return (stat.st_ino, stat.st_size)


class NotesWriter:
    """One turn's notes. Each line is written and flushed whole; a failed write is dropped."""

    def __init__(self, path: Path) -> None:
        self._file: TextIO | None = None
        self._input = self._output = self._cached = 0
        self._message_output = 0
        with contextlib.suppress(OSError):
            path.parent.mkdir(parents=True, exist_ok=True)
            fresh = path.with_name(f".{path.name}.{os.getpid()}.new")
            self._file = fresh.open("w", encoding="utf-8")
            # A new file, so a shim following the last turn's knows this is another turn.
            os.replace(fresh, path)

    @classmethod
    def for_turn(cls, setup: dict[str, Any]) -> NotesWriter | None:
        """Notes for an orchestrated chat's turn when telemetry is on; None otherwise (direct mode)."""
        if setup.get("orchestrated") is not True or not enabled_from_env():
            return None
        return cls(notes_path(str(setup.get("jobId") or "")))

    def _write(self, note: dict[str, Any]) -> None:
        if self._file is None:
            return
        try:
            self._file.write(json.dumps(note, ensure_ascii=False) + "\n")
            self._file.flush()
        except (OSError, ValueError):
            self._file = None

    def stream_event(self, event: dict[str, Any]) -> None:
        """A `stream_event` line of Claude Code's (`--include-partial-messages`)."""
        inner = event.get("event")
        if not isinstance(inner, dict):
            return
        kind = inner.get("type")
        if kind == "content_block_start":
            block = inner.get("content_block")
            if isinstance(block, dict) and block.get("type") == "thinking":
                self._write({"thinking": True})
            elif (
                isinstance(block, dict)
                and block.get("type") == "tool_use"
                and isinstance(block.get("name"), str)
            ):
                self._write({"tool": block["name"]})
        elif kind == "content_block_delta":
            delta = inner.get("delta")
            if not isinstance(delta, dict):
                return
            for kind_of, field, key in (
                ("thinking_delta", "thinking", "thought"),
                ("text_delta", "text", "text"),
            ):
                text = delta.get(field)
                if delta.get("type") == kind_of and isinstance(text, str) and text:
                    self._write({key: text})
        elif kind == "message_start":
            message = inner.get("message")
            usage = message.get("usage") if isinstance(message, dict) else None
            if isinstance(usage, dict):
                # A new model call: what the last one wrote is counted, and this one's prompt.
                cached = _count(usage, "cache_read_input_tokens")
                self._input += (
                    _count(usage, "input_tokens") + _count(usage, "cache_creation_input_tokens") + cached
                )
                self._cached += cached
                self._message_output = _count(usage, "output_tokens")
                self._output += self._message_output
                self._usage()
        elif kind == "message_delta":
            usage = inner.get("usage")
            if isinstance(usage, dict):
                # The call's output so far (cumulative within the call).
                written = _count(usage, "output_tokens")
                if written > self._message_output:
                    self._output += written - self._message_output
                    self._message_output = written
                    self._usage()

    def _usage(self) -> None:
        self._write({"usage": {"input": self._input, "output": self._output, "cached": self._cached}})

    def close(self) -> None:
        if self._file is not None:
            with contextlib.suppress(OSError):
                self._file.close()
            self._file = None


def _count(usage: dict[str, Any], key: str) -> int:
    value = usage.get(key)
    return value if isinstance(value, int) and not isinstance(value, bool) and value > 0 else 0


class NotesFollower:
    """Reads a chat's notes into its trace's root task (the shim's TraceEmitter), on a daemon thread."""

    def __init__(self, path: Path, emitter: Any, start: Position = (0, 0)) -> None:
        self.path = path
        self.emitter = emitter
        self.inode, self.offset = start
        self.partial = b""
        self.tokens = {"input": 0, "output": 0, "cached": 0}
        self.at_line_start = True
        self._lock = threading.Lock()
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None

    def start(self) -> None:
        self._thread = threading.Thread(target=self._run, name="vibecut-notes", daemon=True)
        self._thread.start()

    def stop(self) -> None:
        """Stops the thread and reads what's left, so the root's COMPLETED has the last totals."""
        self._stop.set()
        if self._thread is not None and self._thread is not threading.current_thread():
            self._thread.join(timeout=1.0)
        self.poll()

    def _run(self) -> None:
        while not self._stop.wait(POLL_SECONDS):
            self.poll()

    def poll(self) -> None:
        with self._lock:
            inode, size = file_position(self.path)
            if inode != self.inode or size < self.offset:
                # The chat started a new turn's notes.
                self.inode, self.offset, self.partial = inode, 0, b""
            if size == self.offset:
                return
            try:
                with self.path.open("rb") as f:
                    f.seek(self.offset)
                    data = f.read(size - self.offset)
            except OSError:
                return
            self.offset += len(data)
            lines = (self.partial + data).split(b"\n")
            self.partial = lines.pop()
            for line in lines:
                with contextlib.suppress(ValueError):
                    note = json.loads(line)
                    if isinstance(note, dict):
                        self._apply(note)

    def _apply(self, note: dict[str, Any]) -> None:
        usage = note.get("usage")
        if isinstance(usage, dict):
            for key in self.tokens:
                value = usage.get(key)
                if isinstance(value, int) and not isinstance(value, bool) and value >= 0:
                    self.tokens[key] = max(self.tokens[key], value)
            self.emitter.root_tokens(**self.tokens)
            self._say("")
            return
        tool = note.get("tool")
        if note.get("thinking") is True:
            self._line("· Thinking…")
        elif isinstance(tool, str) and tool:
            self._line(f"→ {tool.rsplit('__', 1)[-1]}")
        elif isinstance(note.get("text"), str):
            self._say(note["text"])
        elif isinstance(note.get("thought"), str) and note["thought"]:
            self.emitter.root_chunk("THOUGHT", note["thought"], self.tokens["output"])

    def _line(self, text: str) -> None:
        """A line of its own in the root's stream: what Claude is doing, between its words."""
        self._say(("" if self.at_line_start else "\n") + text + "\n")

    def _say(self, text: str) -> None:
        # The reply and the lines between its parts share one channel, so the bus keeps their order.
        self.emitter.root_chunk("ASSISTANT_TEXT", text, self.tokens["output"])
        if text:
            self.at_line_start = text.endswith("\n")


def start_position(caller: str) -> Position:
    """Where a shim starting now begins reading its chat's notes: the end of the file that's there."""
    return file_position(notes_path(caller)) if enabled_from_env() else (0, 0)
