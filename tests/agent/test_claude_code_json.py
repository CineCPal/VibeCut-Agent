"""Phase 7e: one schema-checked answer from Claude Code (agent/claude_code_json.py), against a fake
`claude` that records how it was run and prints Claude Code's final JSON (shape from 2.1.291)."""

from __future__ import annotations

import json
import stat
import sys
import threading
import time
from pathlib import Path
from typing import Any

import pytest

from vibecut_agent.agent import claude_code_json
from vibecut_agent.agent.claude_code_json import ClaudeCodeJsonError, answer_of, run_json

FAKE = r"""#!/bin/sh
"exec" "{python}" "$0" "$@"
import json, os, sys, time
stdin = sys.stdin.read()
with open(os.environ["FAKE_RECORD"], "w") as f:
    json.dump({{"argv": sys.argv[1:], "stdin": stdin, "key": os.environ.get("ANTHROPIC_API_KEY"),
               "profile": os.environ.get("CLAUDE_CONFIG_DIR")}}, f)
mode = os.environ.get("FAKE_MODE", "ok")
tools = {{"bash": ["Bash", "StructuredOutput"]}}.get(mode, ["StructuredOutput"])
servers = [{{"name": "github", "status": "connected"}}] if mode == "mcp" else []
if mode != "no-init":
    print(json.dumps({{"type": "system", "subtype": "init", "tools": tools, "mcp_servers": servers}}), flush=True)
if mode == "hang":
    time.sleep(60)
if mode == "signed-out":
    print("Not logged in · Please run /login", file=sys.stderr)
    sys.exit(1)
if mode == "error":
    print(json.dumps({{"type": "result", "subtype": "error_max_turns", "is_error": True}}))
    sys.exit(1)
print(json.dumps({{"type": "result", "subtype": "success", "is_error": False, "result": "{{}}",
                  "structured_output": {{"picks": [1, 3]}}}}))
"""

SCHEMA = {"type": "object", "properties": {"picks": {"type": "array", "items": {"type": "integer"}}}}


@pytest.fixture
def setup(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> dict[str, Any]:
    program = tmp_path / "claude"
    program.write_text(FAKE.format(python=sys.executable), encoding="utf-8")
    program.chmod(program.stat().st_mode | stat.S_IXUSR)
    monkeypatch.setenv("FAKE_RECORD", str(tmp_path / "record.json"))
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-should-not-pass")
    return {
        "program": str(program),
        "workDir": str(tmp_path / "work"),
        "configDir": str(tmp_path / "profile"),
    }


def recorded(setup: dict[str, Any]) -> dict[str, Any]:
    return json.loads(Path(setup["workDir"]).parent.joinpath("record.json").read_text(encoding="utf-8"))


def flag(argv: list[str], name: str) -> str:
    return argv[argv.index(name) + 1]


def test_an_answer_comes_from_structured_output_with_no_tools_and_no_key(setup: dict[str, Any]) -> None:
    out = run_json(setup, "claude-opus-5-5", "Pick lines.", "1 hello\n2 bye", SCHEMA, effort="high")
    assert out == {"picks": [1, 3]}
    seen = recorded(setup)
    argv = seen["argv"]
    assert flag(argv, "--output-format") == "stream-json" and "--verbose" in argv
    assert flag(argv, "--tools") == ""
    assert "--strict-mcp-config" in argv and "--mcp-config" not in argv
    assert "--no-session-persistence" in argv
    assert json.loads(flag(argv, "--json-schema")) == SCHEMA
    assert flag(argv, "--effort") == "high"
    assert flag(argv, "--system-prompt") == "Pick lines."
    assert seen["stdin"] == "1 hello\n2 bye"
    assert seen["key"] is None
    assert seen["profile"] == setup["configDir"]


def test_errors_are_explained(setup: dict[str, Any], monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("FAKE_MODE", "signed-out")
    with pytest.raises(ClaudeCodeJsonError, match="isn't signed in"):
        run_json(setup, "claude-sonnet-5-5", "s", "t", SCHEMA)
    monkeypatch.setenv("FAKE_MODE", "error")
    with pytest.raises(ClaudeCodeJsonError, match="didn't finish an answer"):
        run_json(setup, "claude-sonnet-5-5", "s", "t", SCHEMA)
    with pytest.raises(ClaudeCodeJsonError, match="isn't set up"):
        run_json(None, "m", "s", "t", SCHEMA)


def test_stop_and_timeout_end_claude_code(setup: dict[str, Any], monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("FAKE_MODE", "hang")
    monkeypatch.setattr(claude_code_json, "POLL_SECONDS", 0.05)
    stop = threading.Event()
    threading.Timer(0.5, stop.set).start()
    started = time.monotonic()
    with pytest.raises(ClaudeCodeJsonError, match="Stopped"):
        run_json(setup, "m", "s", "t", SCHEMA, should_abort=stop.is_set)
    with pytest.raises(ClaudeCodeJsonError, match="didn't answer within"):
        run_json(setup, "m", "s", "t", SCHEMA, timeout=0.5)
    assert time.monotonic() - started < 20


def test_results_are_read_from_structured_output_or_the_text() -> None:
    assert answer_of({"type": "result", "subtype": "success", "structured_output": {"a": 1}}) == {"a": 1}
    assert answer_of({"type": "result", "subtype": "success", "result": '{"a": 2}'}) == {"a": 2}
    with pytest.raises(ClaudeCodeJsonError, match="didn't return an answer"):
        answer_of({"type": "result", "subtype": "success", "result": "plain words"})


@pytest.mark.parametrize(
    ("mode", "says"),
    [
        ("bash", "tools VibeCut doesn't allow \\(Bash\\)"),
        ("mcp", "MCP servers VibeCut doesn't allow \\(github\\)"),
        ("no-init", "didn't report its tools"),
    ],
)
def test_a_run_that_isnt_locked_down_is_stopped(
    setup: dict[str, Any], monkeypatch: pytest.MonkeyPatch, mode: str, says: str
) -> None:
    """Phase 7f: the startup event must list only StructuredOutput and no MCP server."""
    monkeypatch.setenv("FAKE_MODE", mode)
    with pytest.raises(
        ClaudeCodeJsonError, match=f"VibeCut stopped Claude Code before it did anything: .*{says}"
    ):
        run_json(setup, "claude-sonnet-5-5", "s", "t", SCHEMA)
