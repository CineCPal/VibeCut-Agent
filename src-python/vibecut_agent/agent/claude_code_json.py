"""claude_code_json.py

One schema-constrained answer from the user's own signed-in Claude Code (``claude -p --json-schema``),
for the Story Editor and its first pass over long footage (PLAN.md, "Phase 7e"). Like the chat on
Claude (subscription) (claude_code_chat.py), it uses the user's Claude plan and needs no API key.

What runs comes from Rust (claude_code.rs) as the request's ``claudeCode``: the program, the profile
folder and an empty working folder. Claude Code runs with no tools at all (not even VibeCut's MCP
server: this is one answer, not an agent turn), none of the user's hooks, no saved session, and no
``ANTHROPIC_*`` credential, so it can only use the subscription. Its startup event must list exactly
the one tool a schema run has (``StructuredOutput``) and no MCP server, or it's stopped before it
answers (Phase 7f).
"""

from __future__ import annotations

import json
import os
import queue
import subprocess
import threading
import time
from collections.abc import Callable
from typing import Any

from vibecut_agent.agent.claude_code_chat import (
    LOCKDOWN_NOTE,
    Popen,
    _stop,
    child_env,
    explain_failure,
    lockdown_problem,
)

POLL_SECONDS = 0.2
DEFAULT_TIMEOUT_SECONDS = 15 * 60
# Structured output takes Claude Code a couple of turns (the answer, then its schema check).
MAX_TURNS = 4
# The one tool a schema run has (Claude Code 2.1.291): it hands back the schema-checked answer.
STRUCTURED_TOOL = "StructuredOutput"


class ClaudeCodeJsonError(Exception):
    """Claude Code couldn't give the answer."""


def check_setup(setup: Any) -> dict[str, Any]:
    if not isinstance(setup, dict):
        raise ClaudeCodeJsonError("Claude Code isn't set up. See Settings → Claude subscription.")
    for key in ("program", "workDir"):
        if not isinstance(setup.get(key), str) or not setup[key]:
            raise ClaudeCodeJsonError(f"Claude Code's setup is missing {key}.")
    return setup


def build_args(
    setup: dict[str, Any], model: str, system: str, schema: dict[str, Any], effort: str | None
) -> list[str]:
    args = [
        setup["program"],
        "-p",
        "--output-format",
        "stream-json",
        "--verbose",
        "--model",
        model,
        "--tools",
        "",
        "--strict-mcp-config",
        "--settings",
        json.dumps({"disableAllHooks": True}),
        "--no-session-persistence",
        "--system-prompt",
        system,
        "--json-schema",
        json.dumps(schema),
        "--max-turns",
        str(MAX_TURNS),
    ]
    if effort:
        args += ["--effort", effort]
    return args


def answer_of(result: dict[str, Any]) -> dict[str, Any]:
    """The schema-checked object from Claude Code's final `result` event, or ClaudeCodeJsonError."""
    if result.get("is_error") or result.get("subtype") not in (None, "success"):
        detail = result.get("result") if isinstance(result.get("result"), str) else result.get("subtype")
        if result.get("subtype") == "error_max_turns":
            detail = "it didn't finish an answer that matched the schema"
        raise ClaudeCodeJsonError(f"Claude Code reported an error: {str(detail)[:500]}")
    structured = result.get("structured_output")
    if isinstance(structured, dict):
        return structured
    text = result.get("result")
    if isinstance(text, str):
        try:
            parsed = json.loads(text)
        except ValueError:
            parsed = None
        if isinstance(parsed, dict):
            return parsed
    raise ClaudeCodeJsonError("Claude Code didn't return an answer that matched the schema.")


def run_json(
    setup: Any,
    model: str,
    system: str,
    user_text: str,
    schema: dict[str, Any],
    effort: str | None = None,
    should_abort: Callable[[], bool] = lambda: False,
    timeout: float = DEFAULT_TIMEOUT_SECONDS,
    popen: Popen = subprocess.Popen,
) -> dict[str, Any]:
    """Runs Claude Code once with `user_text` on stdin and returns its schema-checked object.

    `schema` is plain JSON Schema (claude_schema.strict_schema converts the Story Editor's). Raises
    ClaudeCodeJsonError, with "Stopped" when `should_abort` turned true first."""
    setup = check_setup(setup)
    os.makedirs(setup["workDir"], exist_ok=True)
    try:
        process = popen(
            build_args(setup, model, system, schema, effort),
            cwd=setup["workDir"],
            env=child_env(setup),
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )
    except OSError as exc:
        raise ClaudeCodeJsonError(f"Couldn't start Claude Code ({setup['program']}): {exc}") from None

    lines: queue.Queue[bytes | None] = queue.Queue()
    err: list[bytes] = []

    def pump_stdout() -> None:
        assert process.stdout is not None
        for raw in process.stdout:
            lines.put(raw)
        lines.put(None)

    def pump_stderr() -> None:
        stream = process.stderr
        assert stream is not None
        err.extend(iter(lambda: stream.read(65536), b""))

    threading.Thread(target=pump_stdout, daemon=True).start()
    threading.Thread(target=pump_stderr, daemon=True).start()
    try:
        assert process.stdin is not None
        process.stdin.write(user_text.encode("utf-8"))
        process.stdin.close()
    except OSError:
        pass  # it died at once; reported below from its exit

    started = time.monotonic()
    checked = False
    result: dict[str, Any] | None = None
    while True:
        if should_abort():
            _stop(process)
            raise ClaudeCodeJsonError("Stopped")
        if time.monotonic() - started > timeout:
            _stop(process)
            raise ClaudeCodeJsonError(f"Claude Code didn't answer within {round(timeout / 60)} min.")
        try:
            raw = lines.get(timeout=POLL_SECONDS)
        except queue.Empty:
            continue
        if raw is None:
            break
        try:
            event = json.loads(raw)
        except ValueError:
            continue
        if not isinstance(event, dict):
            continue
        kind = event.get("type")
        if kind == "system" and event.get("subtype") == "init":
            # A schema run has exactly one tool, the one that returns the answer, and no MCP server.
            problem = lockdown_problem(event, None, frozenset({STRUCTURED_TOOL}), frozenset())
            if problem:
                _stop(process)
                raise ClaudeCodeJsonError(LOCKDOWN_NOTE.format(problem=problem))
            checked = True
        elif not checked and kind in ("assistant", "user", "result"):
            _stop(process)
            raise ClaudeCodeJsonError(
                LOCKDOWN_NOTE.format(problem="it didn't report its tools before starting")
            )
        elif kind == "result":
            result = event
    try:
        process.wait(timeout=5)
    except subprocess.TimeoutExpired:
        _stop(process)
    if result is None:
        raise ClaudeCodeJsonError(
            explain_failure(b"".join(err).decode("utf-8", "replace"), process.returncode)
        )
    return answer_of(result)
