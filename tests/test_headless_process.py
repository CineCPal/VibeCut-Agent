"""End to end: the module runs as Rust runs it, and only protocol events reach stdout."""

import json
import os
import subprocess
import sys
from pathlib import Path

SRC = Path(__file__).resolve().parent.parent / "src-python"


def run(command: str, stdin: str) -> subprocess.CompletedProcess[str]:
    env = {**os.environ, "PYTHONPATH": str(SRC), "PYTHONUNBUFFERED": "1"}
    return subprocess.run(
        [sys.executable, "-u", "-m", "vibecut_agent", command],
        input=stdin,
        capture_output=True,
        text=True,
        env=env,
        timeout=30,
        check=False,
    )


def events(stdout: str) -> list[dict]:
    return [json.loads(line) for line in stdout.splitlines() if line.strip()]


def test_health_process():
    result = run("health", "{}")
    assert result.returncode == 0
    assert [e["type"] for e in events(result.stdout)] == ["result"]


def test_session_process():
    result = run("session", '{}\n{"type": "ping", "id": "a"}\n{"type": "end_session"}\n')
    assert result.returncode == 0
    assert [e["type"] for e in events(result.stdout)] == ["ready", "pong", "done"]


def test_unknown_command_process():
    result = run("nope", "{}")
    assert result.returncode == 2
    assert events(result.stdout)[0]["message"] == "Unknown command: nope"


def test_premiere_watch_process_without_a_panel(tmp_path):
    env = {**os.environ, "PYTHONPATH": str(SRC), "VIBECUT_AGENT_PREMIERE_BRIDGE_DIR": str(tmp_path)}
    result = subprocess.run(
        [sys.executable, "-u", "-m", "vibecut_agent", "premiere-watch"],
        input='{}\n{"type": "end_session"}\n',
        capture_output=True,
        text=True,
        env=env,
        timeout=30,
        check=False,
    )
    assert result.returncode == 0
    got = events(result.stdout)
    assert [e["type"] for e in got] == ["ready", "state", "done"]
    assert got[1]["reason"] == "unavailable"
    assert "Install it from Settings" in got[1]["message"]
