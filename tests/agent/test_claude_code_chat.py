"""Claude (subscription), Phase 7b: claude_code_chat against a fake `claude` program that records how
it was run and replays Claude Code's stream-json events (shapes taken from Claude Code 2.1.291; the
unknown-session result from 2.1.292)."""

from __future__ import annotations

import json
import os
import stat
import sys
import threading
import time
from pathlib import Path
from typing import Any

import pytest

from vibecut_agent.agent import claude_code_chat
from vibecut_agent.agent.chat_steps import OUT_OF_STEPS_NOTICE
from vibecut_agent.agent.gemini_chat import STOPPED_NOTICE, ChatError

FAKE_CLAUDE = r"""#!/bin/sh
"exec" "{python}" "$0" "$@"
import json, os, sys, time
record = os.environ["FAKE_RECORD"]
mode = os.environ.get("FAKE_MODE", "ok")
stdin = sys.stdin.read()
with open(record, "w") as f:
    json.dump({{"argv": sys.argv[1:], "stdin": stdin, "cwd": os.getcwd(),
               "env": {{k: os.environ.get(k) for k in ("ANTHROPIC_API_KEY", "CLAUDE_CONFIG_DIR", "HOME")}}}}, f)
with open(record + ".runs", "a") as f:
    f.write(json.dumps(sys.argv[1:]) + "\n")
def out(event):
    print(json.dumps(event), flush=True)
sid = "11111111-2222-3333-4444-555555555555"
def say(text):
    # --include-partial-messages (Phase 8b): the text as it's written, ahead of its whole message.
    if "--include-partial-messages" in sys.argv:
        out({{"type": "stream_event", "session_id": sid, "event": {{"type": "message_start"}}}})
        for piece in (text[: len(text) // 2], text[len(text) // 2 :]):
            out({{"type": "stream_event", "session_id": sid,
                 "event": {{"type": "content_block_delta", "index": 0, "delta": {{"type": "text_delta", "text": piece}}}}}})
        out({{"type": "stream_event", "session_id": sid,
             "event": {{"type": "content_block_delta", "index": 1, "delta": {{"type": "input_json_delta", "partial_json": "{{}}"}}}}}})
if mode == "session-gone" and "--resume" in sys.argv:
    gone = sys.argv[sys.argv.index("--resume") + 1]
    out({{"type": "result", "subtype": "error_during_execution", "is_error": True, "num_turns": 0, "session_id": gone,
         "usage": {{"input_tokens": 0, "output_tokens": 0}}, "errors": ["No conversation found with session ID: " + gone]}})
    print("No conversation found with session ID: " + gone, file=sys.stderr, flush=True)
    sys.exit(1)
if mode == "signed-out":
    print("Not logged in · Please run /login", file=sys.stderr, flush=True)
    sys.exit(1)
if mode == "partial-before-init":
    say("hi")
    sys.exit(0)
if mode == "no-init":
    out({{"type": "assistant", "session_id": sid, "message": {{"content": [{{"type": "text", "text": "hi"}}]}}}})
    sys.exit(0)
tools = ["mcp__vibecut__add_markers"] + (["Bash"] if mode == "bash" else [])
status = "failed" if mode == "mcp-failed" else "connected"
out({{"type": "system", "subtype": "init", "session_id": sid, "tools": tools,
     "mcp_servers": [{{"name": "vibecut", "status": status}}] + ([{{"name": "github", "status": "connected"}}] if mode == "mcp" else [])}})
if mode == "hang":
    time.sleep(60)
say("Let me look.")
out({{"type": "assistant", "session_id": sid, "message": {{"content": [{{"type": "text", "text": "Let me look."}},
     {{"type": "tool_use", "id": "t1", "name": "mcp__vibecut__add_markers", "input": {{"markers": []}}}}]}}}})
out({{"type": "user", "session_id": sid, "message": {{"content": [{{"type": "tool_result", "tool_use_id": "t1", "content": "ok"}}]}}}})
say("Marked the hook.")
out({{"type": "assistant", "session_id": sid, "message": {{"content": [{{"type": "text", "text": "Marked the hook."}}]}}}})
usage = {{"input_tokens": 100, "cache_creation_input_tokens": 20, "cache_read_input_tokens": 30, "output_tokens": 40,
         "output_tokens_details": {{"thinking_tokens": 12}}}}
if mode == "max-turns":
    out({{"type": "result", "subtype": "error_max_turns", "is_error": True, "session_id": sid, "num_turns": 10, "usage": usage}})
elif mode == "error":
    out({{"type": "result", "subtype": "error_during_execution", "is_error": True, "session_id": sid, "result": "overloaded", "usage": usage}})
else:
    out({{"type": "result", "subtype": "success", "is_error": False, "session_id": sid, "result": "Marked the hook.",
         "num_turns": 2, "usage": usage}})
"""

SESSION = "11111111-2222-3333-4444-555555555555"


@pytest.fixture
def fake(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> dict[str, Any]:
    program = tmp_path / "claude"
    program.write_text(FAKE_CLAUDE.format(python=sys.executable), encoding="utf-8")
    program.chmod(program.stat().st_mode | stat.S_IXUSR)
    record = tmp_path / "record.json"
    monkeypatch.setenv("FAKE_RECORD", str(record))
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-should-not-pass")
    setup = {
        "program": str(program),
        "configDir": str(tmp_path / "profile"),
        "jobId": "job-7",
        "workDir": str(tmp_path / "work"),
        "mcp": {
            "program": "/opt/homebrew/bin/uv",
            "args": ["run", "--extra", "mcp", "python", "-m", "vibecut_agent", "mcp"],
            "env": [["PYTHONPATH", "/r/src-python"]],
        },
    }
    return {"setup": setup, "record": record}


def run(
    fake: dict[str, Any], history: list[Any] | None = None, **kw: Any
) -> tuple[dict[str, Any], list[tuple[str, dict[str, Any]]]]:
    events: list[tuple[str, dict[str, Any]]] = []
    outcome = claude_code_chat.run_chat_turn(
        fake["setup"],
        kw.pop("model", "claude-opus-5-5"),
        "You edit timelines.",
        history or [],
        "mark the hook",
        lambda kind, **fields: events.append((kind, fields)),
        **kw,
    )
    return outcome, events


def recorded(fake: dict[str, Any]) -> dict[str, Any]:
    return json.loads(fake["record"].read_text(encoding="utf-8"))


def flag(argv: list[str], name: str) -> str:
    return argv[argv.index(name) + 1]


def sent_blocks(seen: dict[str, Any]) -> list[dict[str, Any]]:
    """The content blocks of the one stream-json user line Claude Code was given (Phase 8g)."""
    lines = seen["stdin"].splitlines()
    assert len(lines) == 1
    line = json.loads(lines[0])
    assert line["type"] == "user"
    assert line["message"]["role"] == "user"
    blocks: list[dict[str, Any]] = line["message"]["content"]
    return blocks


def test_a_turn_runs_claude_code_with_only_vibecuts_tools(fake: dict[str, Any]) -> None:
    outcome, events = run(fake, max_iterations=40)
    seen = recorded(fake)
    argv = seen["argv"]
    assert argv[:1] == ["-p"]
    assert flag(argv, "--output-format") == "stream-json"
    assert flag(argv, "--model") == "claude-opus-5-5"
    assert flag(argv, "--tools") == ""
    assert "--strict-mcp-config" in argv
    assert flag(argv, "--allowedTools") == "mcp__vibecut__*"
    assert flag(argv, "--permission-prompts") == "none"
    assert json.loads(flag(argv, "--settings")) == {"disableAllHooks": True}
    assert flag(argv, "--system-prompt") == "You edit timelines."
    assert flag(argv, "--max-turns") == "40"
    assert "--resume" not in argv
    assert "--fork-session" not in argv
    server = json.loads(flag(argv, "--mcp-config"))["mcpServers"]["vibecut"]
    assert server["command"] == "/opt/homebrew/bin/uv"
    assert server["env"] == {"PYTHONPATH": "/r/src-python", "VIBECUT_MCP_CALLER": "job-7"}
    assert flag(argv, "--input-format") == "stream-json"
    assert sent_blocks(seen) == [{"type": "text", "text": "mark the hook"}]
    assert seen["cwd"] == os.path.realpath(fake["setup"]["workDir"])
    assert seen["env"]["ANTHROPIC_API_KEY"] is None, "the subscription, never an API key"
    assert seen["env"]["CLAUDE_CONFIG_DIR"] == fake["setup"]["configDir"]

    assert outcome == {
        "text": "Marked the hook.",
        "history": [{"claudeCodeSession": SESSION}],
        "usage": {
            "promptTokens": 150,
            "cachedTokens": 30,
            "outputTokens": 40,
            "thoughtsTokens": 12,
            "steps": 2,
        },
        "aborted": False,
        "outOfSteps": False,
    }
    details = [fields["detail"] for kind, fields in events if kind == "status"]
    assert "Running add_markers…" in details


def test_the_reply_streams_and_text_before_a_tool_call_is_its_own_message(fake: dict[str, Any]) -> None:
    """Phase 8b: --include-partial-messages, deltas joined, a break at the tool call."""
    _, events = run(fake)
    argv = recorded(fake)["argv"]
    assert "--include-partial-messages" in argv
    replies = [(kind, fields.get("text")) for kind, fields in events if kind.startswith("reply_")]
    assert "".join(t or "" for k, t in replies[: replies.index(("reply_break", None))]) == "Let me look."
    after = replies[replies.index(("reply_break", None)) + 1 :]
    assert "".join(t or "" for _, t in after) == "Marked the hook."
    assert all(kind == "reply_delta" for kind, _ in after)
    # The status for the tool comes after the break, so the app ends the first message first.
    kinds = [kind for kind, fields in events]
    running = next(i for i, (k, f) in enumerate(events) if k == "status" and f["detail"] == "Running add_markers…")
    assert kinds.index("reply_break") < running


def test_the_next_turn_resumes_the_session(fake: dict[str, Any]) -> None:
    run(fake, history=[{"claudeCodeSession": SESSION}], model="something-else")
    argv = recorded(fake)["argv"]
    assert flag(argv, "--resume") == SESSION
    # Phase 8c: the turn forks, so the session it started from stays as it was for Retry and Edit.
    assert "--fork-session" in argv
    assert flag(argv, "--model") == "claude-sonnet-5-5", "an unknown model falls back to the default"


def test_a_session_claude_code_no_longer_has_starts_a_new_one(
    fake: dict[str, Any], monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("FAKE_MODE", "session-gone")
    gone = "99999999-0000-4000-8000-000000000000"
    outcome, events = run(fake, history=[{"claudeCodeSession": gone}])
    runs = [json.loads(line) for line in Path(str(fake["record"]) + ".runs").read_text().splitlines()]
    assert len(runs) == 2
    assert flag(runs[0], "--resume") == gone
    assert "--resume" not in runs[1]
    assert sent_blocks(recorded(fake)) == [
        {"type": "text", "text": claude_code_chat.SESSION_GONE_NOTE.strip()},
        {"type": "text", "text": "mark the hook"},
    ]
    assert outcome["text"] == "Marked the hook."
    assert outcome["history"] == [{"claudeCodeSession": SESSION}], "the new session replaces the lost one"
    details = [fields["detail"] for kind, fields in events if kind == "status"]
    assert claude_code_chat.SESSION_GONE_STATUS in details


def test_images_go_ahead_of_the_text_as_image_blocks(fake: dict[str, Any]) -> None:
    run(fake, images=[{"mime": "image/png", "data": "iVBORw0KGgo="}])
    assert sent_blocks(recorded(fake)) == [
        {"type": "image", "source": {"type": "base64", "media_type": "image/png", "data": "iVBORw0KGgo="}},
        {"type": "text", "text": "mark the hook"},
    ]


def test_only_a_missing_session_is_retried() -> None:
    assert claude_code_chat.session_gone(
        {"type": "result", "is_error": True, "errors": ["No conversation found with session ID: x"]}
    )
    assert not claude_code_chat.session_gone({"type": "result", "is_error": True, "errors": ["overloaded"]})
    assert not claude_code_chat.session_gone({"type": "assistant", "errors": ["No conversation found"]})
    assert not claude_code_chat.session_gone({"type": "result", "errors": "No conversation found"})


def test_no_profile_folder_means_claude_codes_default(
    fake: dict[str, Any], monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("CLAUDE_CONFIG_DIR", "/inherited")
    fake["setup"]["configDir"] = None
    run(fake)
    assert recorded(fake)["env"]["CLAUDE_CONFIG_DIR"] is None


def test_running_out_of_turns_offers_continue(fake: dict[str, Any], monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("FAKE_MODE", "max-turns")
    outcome, _ = run(fake)
    assert outcome["outOfSteps"] is True
    assert outcome["text"] == "Marked the hook.", "what Claude said after its last tool call"
    assert outcome["history"] == [{"claudeCodeSession": SESSION}]


def test_running_out_of_turns_with_nothing_said_uses_the_notice(
    fake: dict[str, Any], monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("FAKE_MODE", "max-turns")
    monkeypatch.setattr(claude_code_chat, "_reply_text", lambda result, texts: "")
    outcome, _ = run(fake)
    assert outcome["text"] == OUT_OF_STEPS_NOTICE


def test_an_error_result_is_a_chat_error(fake: dict[str, Any], monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("FAKE_MODE", "error")
    with pytest.raises(ChatError, match="overloaded"):
        run(fake)


def test_signed_out_is_explained(fake: dict[str, Any], monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("FAKE_MODE", "signed-out")
    with pytest.raises(ChatError, match="isn't signed in"):
        run(fake)


def test_a_missing_program_or_setup_is_explained(fake: dict[str, Any]) -> None:
    fake["setup"]["program"] = "/nowhere/claude"
    with pytest.raises(ChatError, match="Couldn't start Claude Code"):
        run(fake)
    with pytest.raises(ChatError, match="isn't set up"):
        claude_code_chat.run_chat_turn(None, None, "", [], "hi", lambda *a, **k: None)


def test_stop_ends_claude_code_and_keeps_the_session(
    fake: dict[str, Any], monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("FAKE_MODE", "hang")
    monkeypatch.setattr(claude_code_chat, "STOP_GRACE_SECONDS", 1.0)
    stop = threading.Event()
    threading.Timer(1.0, stop.set).start()
    started = time.monotonic()
    outcome, _ = run(fake, should_abort=stop.is_set)
    assert time.monotonic() - started < 10
    assert outcome["aborted"] is True
    assert outcome["text"] == STOPPED_NOTICE
    assert outcome["history"] == [{"claudeCodeSession": SESSION}]


def test_usage_and_names_are_read_safely() -> None:
    assert claude_code_chat.usage_of({}) == {
        "promptTokens": 0,
        "cachedTokens": 0,
        "outputTokens": 0,
        "thoughtsTokens": 0,
        "steps": 0,
    }
    assert claude_code_chat.short_tool_name("mcp__vibecut__split_clip") == "split_clip"
    assert (
        claude_code_chat.session_of(
            [{"role": "user"}, {"claudeCodeSession": "a"}, {"claudeCodeSession": "b"}]
        )
        == "b"
    )
    assert claude_code_chat.session_of([]) is None


@pytest.mark.parametrize(
    ("mode", "says"),
    [
        ("bash", "VibeCut stopped Claude Code before it did anything: .*doesn't allow \\(Bash\\)"),
        ("mcp", "VibeCut stopped Claude Code before it did anything: .*MCP servers .*\\(github\\)"),
        ("no-init", "VibeCut stopped Claude Code before it did anything: .*didn't report its tools"),
        ("partial-before-init", "VibeCut stopped Claude Code before it did anything: .*didn't report its tools"),
        ("mcp-failed", "VibeCut's tools didn't start in Claude Code \\(failed\\)"),
    ],
)
def test_a_turn_that_isnt_locked_down_is_stopped(
    fake: dict[str, Any], monkeypatch: pytest.MonkeyPatch, mode: str, says: str
) -> None:
    """Phase 7f: each run's own startup event must list only VibeCut's tools and MCP server."""
    monkeypatch.setenv("FAKE_MODE", mode)
    with pytest.raises(ChatError, match=says):
        run(fake)


def test_lockdown_problems_are_named() -> None:
    check = claude_code_chat.lockdown_problem
    vibecut = frozenset({"vibecut"})
    assert (
        check(
            {"tools": ["mcp__vibecut__a"], "mcp_servers": [{"name": "vibecut"}]},
            "mcp__vibecut__",
            frozenset(),
            vibecut,
        )
        is None
    )
    assert "Bash, Edit" in str(
        check({"tools": ["Edit", "Bash", "mcp__vibecut__a"]}, "mcp__vibecut__", frozenset(), vibecut)
    )
    assert "didn't say" in str(check({}, None, frozenset(), frozenset()))
    assert (
        check(
            {"tools": ["StructuredOutput"], "mcp_servers": []},
            None,
            frozenset({"StructuredOutput"}),
            frozenset(),
        )
        is None
    )
