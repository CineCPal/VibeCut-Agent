"""Gemini (subscription), Phase 17: antigravity_chat and antigravity_json against a fake `agy` program
that records how it was run and replays agy's stream-json events (shapes taken from agy 1.2.1 on
2026-10-17: init, step_update, result; an interrupted result on SIGINT; the sign-in link on stderr)."""

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

from vibecut_agent.agent import antigravity_chat as agy
from vibecut_agent.agent import antigravity_json
from vibecut_agent.agent.chat_steps import OUT_OF_STEPS_NOTICE, STOPPED_NOTICE, ChatError

FAKE_AGY = r"""#!/bin/sh
"exec" "{python}" "$0" "$@"
import json, os, signal, sys, time
record = os.environ["FAKE_RECORD"]
mode = os.environ.get("FAKE_MODE", "ok")
argv = sys.argv[1:]
agent = argv[argv.index("--agent") + 1] if "--agent" in argv else None
agent_file = os.path.join(os.getcwd(), ".agents", "agents", (agent or "") + ".md")
stdin = sys.stdin.readline()
with open(record, "w") as f:
    json.dump({{"argv": argv, "stdin": stdin, "cwd": os.getcwd(),
               "agentFile": open(agent_file).read() if os.path.exists(agent_file) else None,
               "env": {{k: os.environ.get(k) for k in ("GEMINI_API_KEY", "GOOGLE_API_KEY", "VIBECUT_MCP_CALLER", "HOME")}}}}, f)
cid = "7c07b920-791c-4657-99a5-602ac230b594"
def out(event):
    print(json.dumps(event), flush=True)
def step(i, **fields):
    out({{"event": "step_update", "step_update": {{"conversation_id": cid, "step_index": i, **fields}}}})
def result(status="SUCCESS", response="", **extra):
    out({{"event": "result", "result": {{"conversation_id": cid, "status": status, "response": response, "num_turns": 2,
         "usage": {{"input_tokens": 2164, "output_tokens": 23, "thinking_tokens": 4, "cache_read_tokens": 19382}}, **extra}}}})
if mode == "signed-out":
    print("Authentication required. Please visit the URL to log in:", file=sys.stderr, flush=True)
    time.sleep(60)
    sys.exit(1)
if mode == "no-init":
    step(0, state="DONE", step_type="user_input")
    sys.exit(0)
started_as = "someone-else" if mode == "wrong-agent" else agent
out({{"event": "init", "conversation_id": cid, "init": {{"model": argv[argv.index("--model") + 1], "cwd": os.getcwd(),
     "agent": started_as, "tools": ["finish", "run_command", "view_file"], "permission_mode": "request-review"}}}})
step(0, state="DONE", step_type="user_input")
if mode == "hang":
    signal.signal(signal.SIGINT, lambda *a: (print("error: interrupted", file=sys.stderr, flush=True),
        result("ERROR", error="interrupted"), sys.exit(1)))
    step(1, state="ACTIVE", step_type="agent_response", text_delta="Thinking about")
    time.sleep(60)
if mode == "json":
    step(1, state="DONE", step_type="agent_response", text_delta="Here are a few ideas.")
    result(response="Here are a few ideas.", structured_output={{"title": "Beach day"}})
    sys.exit(0)
if mode == "json-tool":
    step(1, state="ACTIVE", step_type="tool", tool_name="mcp_vibecut_list_timelines", tool_info={{"name": "mcp_vibecut_list_timelines"}})
    time.sleep(60)
tool = {{"bash": "run_command", "other-mcp": "mcp_github_create_issue"}}.get(mode, "mcp_vibecut_add_markers")
step(1, state="ACTIVE", step_type="agent_response", text_delta="Let me ")
step(1, state="DONE", step_type="agent_response", text_delta="look.")
count = 5 if mode == "many-tools" else 1
for n in range(count):
    i = 2 + n
    step(i, state="ACTIVE", step_type="tool", tool_name=tool, tool_info={{"name": tool}})
    if mode in ("bash", "other-mcp"):
        time.sleep(60)
    step(i, state="DONE", step_type="tool", tool_name=tool, tool_info={{"name": tool, "output": "ok"}})
if mode == "many-tools":
    time.sleep(60)
step(10, state="ACTIVE", step_type="agent_response", text_delta="Marked ")
step(10, state="DONE", step_type="agent_response", text_delta="the hook.\n")
step(11, state="ACTIVE", step_type="tool", tool_name="finish", tool_info={{"name": "finish"}})
step(11, state="DONE", step_type="finish")
if mode == "error":
    result("ERROR", error="model overloaded")
elif mode == "auth-error":
    result("ERROR", error="authentication failed or timed out")
else:
    result(response="Marked the hook.\n")
"""


@pytest.fixture
def fake(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> dict[str, Any]:
    program = tmp_path / "agy"
    program.write_text(FAKE_AGY.format(python=sys.executable))
    program.chmod(program.stat().st_mode | stat.S_IXUSR)
    record = tmp_path / "record.json"
    monkeypatch.setenv("FAKE_RECORD", str(record))
    monkeypatch.setenv("GEMINI_API_KEY", "should-not-pass")
    monkeypatch.setenv("GOOGLE_API_KEY", "should-not-pass")
    monkeypatch.setattr(agy, "STOP_GRACE_SECONDS", 2.0)
    setup = {"program": str(program), "jobId": "job-7", "workDir": str(tmp_path / "work")}
    return {"setup": setup, "record": record, "work": tmp_path / "work"}


def recorded(fake: dict[str, Any]) -> dict[str, Any]:
    return json.loads(fake["record"].read_text())


def turn(
    fake: dict[str, Any], mode: str = "ok", **kwargs: Any
) -> tuple[dict[str, Any], list[tuple[str, dict[str, Any]]]]:
    os.environ["FAKE_MODE"] = mode
    events: list[tuple[str, dict[str, Any]]] = []
    args: dict[str, Any] = {
        "model": "gemini-4-argon",
        "system_instruction": "You edit timelines.",
        "history": [],
        "user_message": "Mark the hook.",
        "emit": lambda kind, **f: events.append((kind, f)),
    }
    args.update(kwargs)
    outcome = agy.run_chat_turn(fake["setup"], **args)
    return outcome, events


def test_a_turn_runs_on_its_own_locked_down_agent_and_streams_the_reply(fake: dict[str, Any]) -> None:
    outcome, events = turn(fake, effort="high")
    run = recorded(fake)
    argv = run["argv"]
    assert argv[0] == "-p="
    assert argv[argv.index("--model") + 1] == "gemini-4-argon-high"
    assert argv[argv.index("--input-format") + 1] == "stream-json"
    assert "--disable-slash-commands" in argv
    agent = argv[argv.index("--agent") + 1]
    assert agent.startswith("vibecut-")
    assert run["agentFile"].startswith(f"---\nname: {agent}\n")
    assert "tools:\n  - finish\n" in run["agentFile"]
    assert run["agentFile"].rstrip().endswith("You edit timelines.")
    assert run["cwd"] == str(fake["work"])
    assert run["env"] == {
        "GEMINI_API_KEY": None,
        "GOOGLE_API_KEY": None,
        "VIBECUT_MCP_CALLER": "job-7",
        "HOME": os.environ.get("HOME"),
    }
    line = json.loads(run["stdin"])
    assert line == {
        "event": "user",
        "message": {"role": "user", "content": [{"type": "text", "text": "Mark the hook."}]},
    }
    assert not list((fake["work"] / ".agents" / "agents").iterdir()), "the run's agent is removed afterwards"

    assert outcome["text"] == "Marked the hook."
    assert outcome["aborted"] is False and outcome["outOfSteps"] is False
    assert outcome["history"] == [
        {"role": "user", "text": "Mark the hook."},
        {"role": "model", "text": "Marked the hook.", "tools": ["add_markers"]},
    ]
    assert outcome["usage"] == {
        "promptTokens": 21546,
        "cachedTokens": 19382,
        "outputTokens": 23,
        "thoughtsTokens": 4,
        "steps": 2,
    }
    deltas = [f["text"] for k, f in events if k == "reply_delta"]
    assert "".join(deltas).startswith("Let me look.")
    assert ("status", {"detail": "Running add_markers…"}) in events
    assert any(k == "reply_break" for k, _ in events)


def test_the_history_is_the_apps_and_goes_in_with_the_message(fake: dict[str, Any]) -> None:
    history = [
        {"role": "user", "text": "What's on V1?"},
        {"role": "model", "text": "Three clips.", "tools": ["list_timeline_clips"]},
        {"claudeCodeSession": "not ours"},
    ]
    outcome, _ = turn(fake, history=history)
    text = json.loads(recorded(fake)["stdin"])["message"]["content"][0]["text"]
    assert "User: What's on V1?" in text
    assert "You (tools used: list_timeline_clips): Three clips." in text
    assert text.endswith("Mark the hook.")
    assert "not ours" not in text
    assert outcome["history"][:2] == history[:2]
    assert len(outcome["history"]) == 4


def test_a_long_history_keeps_the_newest_messages() -> None:
    history = [{"role": "user", "text": f"message {i} " + "x" * 50} for i in range(10)]
    text = agy.compose_message(history, "now", limit=200)
    assert "message 9" in text and "message 0" not in text
    assert "(Older messages are left out.)" in text
    assert agy.compose_message([], "just this") == "just this"


def test_effort_picks_the_models_variant() -> None:
    assert agy.resolve_model("gemini-3.8-flash", "low") == "gemini-3.8-flash-low"
    assert agy.resolve_model("gemini-4-argon", "max") == "gemini-4-argon-high"
    assert agy.resolve_model(None, None) == "gemini-4-argon-medium"
    assert agy.resolve_model("gemini-9-unknown", "medium") == "gemini-4-argon-medium"


@pytest.mark.parametrize(
    ("mode", "says"),
    [
        ("bash", "run_command"),
        ("other-mcp", "mcp_github_create_issue"),
        ("wrong-agent", "someone-else"),
        ("no-init", "didn't say which agent"),
    ],
)
def test_anything_outside_vibecuts_tools_stops_the_run(fake: dict[str, Any], mode: str, says: str) -> None:
    started = time.monotonic()
    with pytest.raises(ChatError) as caught:
        turn(fake, mode)
    assert "VibeCut stopped Antigravity" in str(caught.value)
    assert says in str(caught.value)
    assert time.monotonic() - started < 20, "it's stopped, not waited out"


def test_signed_out_is_reported_without_waiting_for_the_login(fake: dict[str, Any]) -> None:
    started = time.monotonic()
    with pytest.raises(ChatError, match="isn't signed in"):
        turn(fake, "signed-out")
    assert time.monotonic() - started < 20
    with pytest.raises(ChatError, match="isn't signed in"):
        turn(fake, "auth-error")


def test_an_error_result_is_reported(fake: dict[str, Any]) -> None:
    with pytest.raises(ChatError, match="model overloaded"):
        turn(fake, "error")


def test_stop_interrupts_agy(fake: dict[str, Any]) -> None:
    pressed = threading.Event()
    threading.Timer(1.5, pressed.set).start()
    outcome, events = turn(fake, "hang", should_abort=pressed.is_set)
    assert outcome["aborted"] is True
    assert outcome["text"] == STOPPED_NOTICE
    assert ("status", {"detail": "Stopping Antigravity…"}) in events


def test_the_step_limit_stops_the_run(fake: dict[str, Any]) -> None:
    outcome, _ = turn(fake, "many-tools", max_iterations=3)
    assert outcome["outOfSteps"] is True
    assert outcome["text"] == OUT_OF_STEPS_NOTICE
    assert outcome["history"][-1]["tools"] == ["add_markers"] * 3


def test_images_are_refused_and_nothing_runs(fake: dict[str, Any]) -> None:
    with pytest.raises(ChatError, match="can't take images"):
        turn(fake, images=[{"mime": "image/png", "data": "aGk="}])
    assert not fake["record"].exists()


def test_a_missing_setup_says_where_to_set_it_up() -> None:
    with pytest.raises(ChatError, match="Settings → Gemini subscription"):
        agy.run_chat_turn(None, None, "", [], "hi", lambda *a, **k: None)
    with pytest.raises(ChatError, match="jobId"):
        agy.run_chat_turn({"program": "/x", "workDir": "/w"}, None, "", [], "hi", lambda *a, **k: None)


def test_a_json_run_returns_the_structured_output_with_no_caller_tag(fake: dict[str, Any]) -> None:
    os.environ["FAKE_MODE"] = "json"
    schema = {"type": "object", "properties": {"title": {"type": "string"}}, "required": ["title"]}
    answer = antigravity_json.run_json(
        fake["setup"], "gemini-3.8-flash", "Name chats.", "A dog at a beach", schema, effort="low"
    )
    assert answer == {"title": "Beach day"}
    run = recorded(fake)
    argv = run["argv"]
    assert json.loads(argv[argv.index("--json-schema") + 1]) == schema
    assert argv[argv.index("--model") + 1] == "gemini-3.8-flash-low"
    assert run["env"]["VIBECUT_MCP_CALLER"] is None, "the shim refuses a JSON run as an outside caller"
    assert run["agentFile"].rstrip().endswith("Name chats.")


def test_a_json_run_that_calls_a_tool_is_stopped(fake: dict[str, Any]) -> None:
    os.environ["FAKE_MODE"] = "json-tool"
    with pytest.raises(antigravity_json.AntigravityJsonError, match="one-answer run"):
        antigravity_json.run_json(fake["setup"], None, "s", "t", {"type": "object"})


def test_a_json_run_takes_text_only() -> None:
    assert antigravity_json.text_of([{"text": "a"}, {"text": "b"}]) == "a\n\nb"
    with pytest.raises(antigravity_json.AntigravityJsonError, match="can't look at stills"):
        antigravity_json.text_of([{"text": "a"}, {"inline_data": {"mime_type": "image/jpeg", "data": "x"}}])


def test_a_json_answer_falls_back_to_the_response_text() -> None:
    assert antigravity_json.answer_of({"status": "SUCCESS", "response": '{"title": "x"}'}) == {"title": "x"}
    with pytest.raises(antigravity_json.AntigravityJsonError, match="didn't return"):
        antigravity_json.answer_of({"status": "SUCCESS", "response": "prose"})
    with pytest.raises(antigravity_json.AntigravityJsonError, match="isn't signed in"):
        antigravity_json.answer_of({"status": "ERROR", "error": "authentication failed or timed out"})
