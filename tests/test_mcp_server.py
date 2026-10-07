"""The MCP server shim (PLAN.md, Phase 7a): an in-process MCP client against a fake app that answers
through a temporary bridge folder, as src-tauri/src/mcp_bridge.rs and src/lib/mcp/server.ts do."""

from __future__ import annotations

import json
import os
import threading
import time
from collections.abc import Callable, Iterator
from pathlib import Path
from typing import Any

import pytest

pytest.importorskip("mcp")

import anyio
from mcp import Client

from vibecut_agent import mcp_server
from vibecut_agent.mcp_server import AppBridge, BridgeError, build_server

DECLARATIONS = [
    {
        "name": "add_markers",
        "description": "Adds markers.",
        "parameters": {
            "type": "OBJECT",
            "properties": {
                "markers": {
                    "type": "ARRAY",
                    "items": {"type": "OBJECT", "properties": {"time": {"type": "NUMBER"}}},
                }
            },
            "required": ["markers"],
        },
    },
    {
        "name": "list_markers",
        "description": "Lists markers.",
        "parameters": {"type": "OBJECT", "properties": {}},
    },
]

Answer = Callable[[dict[str, Any]], dict[str, Any] | None]


class FakeApp:
    """Stamps the heartbeat and answers requests the way the app does."""

    def __init__(self, folder: Path, answer: Answer, outside_allowed: bool = True) -> None:
        self.folder = folder
        self.answer = answer
        self.outside_allowed = outside_allowed
        self.seen: list[dict[str, Any]] = []
        self.beating = True
        self._stop = threading.Event()
        for sub in ("requests", "replies"):
            (folder / sub).mkdir(parents=True, exist_ok=True)
        self._beat()
        self._thread = threading.Thread(target=self._serve, daemon=True)
        self._thread.start()

    def _beat(self) -> None:
        stamp = {"at": int(time.time() * 1000), "pid": 1, "outsideAllowed": self.outside_allowed}
        (self.folder / "agent-alive.json").write_text(json.dumps(stamp), encoding="utf-8")

    def _serve(self) -> None:
        while not self._stop.is_set():
            if self.beating:
                self._beat()
            for path in sorted((self.folder / "requests").glob("[!.]*.json")):
                request = json.loads(path.read_text(encoding="utf-8"))
                path.unlink()
                self.seen.append(request)
                reply = self.answer(request)
                if reply is not None:
                    reply["id"] = request["id"]
                    (self.folder / "replies" / path.name).write_text(json.dumps(reply), encoding="utf-8")
            time.sleep(0.02)

    def stop(self) -> None:
        self._stop.set()
        self._thread.join(timeout=2)


def answer_normally(request: dict[str, Any]) -> dict[str, Any] | None:
    if request["kind"] == "list_tools":
        return {"ok": True, "result": {"tools": DECLARATIONS}}
    if request["name"] == "add_markers":
        return {
            "ok": True,
            "result": {"added": [{"id": "m1", "time": request["args"]["markers"][0]["time"]}]},
        }
    return {"ok": True, "result": {"error": f"Unknown tool: {request['name']}"}}


@pytest.fixture
def folder(tmp_path: Path) -> Path:
    return tmp_path / "mcp"


@pytest.fixture
def app(folder: Path) -> Iterator[FakeApp]:
    fake = FakeApp(folder, answer_normally)
    yield fake
    fake.stop()


def run(coro_fn: Callable[[], Any]) -> Any:
    return anyio.run(coro_fn)


def test_tools_come_from_the_app_as_json_schema(app: FakeApp, folder: Path) -> None:
    server = build_server(AppBridge(folder, "outside"))

    async def go() -> Any:
        async with Client(server) as client:
            return await client.list_tools()

    tools = {t.name: t for t in run(go).tools}
    assert set(tools) == {"add_markers", "list_markers"}
    schema = tools["add_markers"].input_schema
    assert schema["type"] == "object"
    assert schema["properties"]["markers"]["items"]["properties"]["time"] == {"type": "number"}
    assert schema["required"] == ["markers"]
    assert app.seen[0]["caller"] == "outside"


def test_a_call_round_trips_and_an_error_result_is_flagged(app: FakeApp, folder: Path) -> None:
    server = build_server(AppBridge(folder, "job-1"))

    async def go() -> Any:
        async with Client(server) as client:
            ok = await client.call_tool("add_markers", {"markers": [{"time": 4.0}]})
            bad = await client.call_tool("nope", {})
            return ok, bad

    ok, bad = run(go)
    assert ok.is_error is False
    assert json.loads(ok.content[0].text) == {"added": [{"id": "m1", "time": 4.0}]}
    assert bad.is_error is True
    assert "Unknown tool" in json.loads(bad.content[0].text)["error"]
    call = app.seen[0]
    assert call == {
        "id": call["id"],
        "caller": "job-1",
        "kind": "call_tool",
        "name": "add_markers",
        "args": {"markers": [{"time": 4.0}]},
    }
    assert not list((folder / "replies").iterdir()), "the shim deletes the replies it read"


def test_a_refused_request_comes_back_as_a_tool_error(folder: Path) -> None:
    fake = FakeApp(folder, lambda r: {"ok": False, "error": "VibeCut's own chat is busy"})
    try:
        server = build_server(AppBridge(folder, "outside"))

        async def go() -> Any:
            async with Client(server) as client:
                return await client.call_tool("add_markers", {"markers": []})

        result = run(go)
    finally:
        fake.stop()
    assert result.is_error is True
    assert "busy" in json.loads(result.content[0].text)["error"]


def test_no_app_means_a_clear_error_and_a_fallback_tool(folder: Path) -> None:
    server = build_server(AppBridge(folder, "outside"))

    async def go() -> Any:
        async with Client(server) as client:
            return await client.list_tools(), await client.call_tool("get_editor_context", {})

    tools, result = run(go)
    assert [t.name for t in tools.tools] == ["get_editor_context"]
    assert result.is_error is True
    assert "isn't running" in json.loads(result.content[0].text)["error"]


def test_outside_callers_are_refused_while_outside_control_is_off(folder: Path) -> None:
    fake = FakeApp(folder, answer_normally, outside_allowed=False)
    try:
        with pytest.raises(BridgeError, match="Outside control is off"):
            AppBridge(folder, "outside").check_reachable()
        AppBridge(folder, "job-1").check_reachable()  # the app's own chat is always served
    finally:
        fake.stop()
    assert fake.seen == []


def test_a_stale_heartbeat_counts_as_not_running(app: FakeApp, folder: Path) -> None:
    app.beating = False
    time.sleep(0.05)
    old = time.time() - 60
    os.utime(folder / "agent-alive.json", (old, old))
    with pytest.raises(BridgeError, match="isn't running"):
        AppBridge(folder, "outside").check_reachable()


def test_no_reply_times_out_and_progress_is_reported(folder: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    fake = FakeApp(folder, lambda r: None)  # never answers
    monkeypatch.setattr(mcp_server, "PROGRESS_EVERY_SECONDS", 0.2)
    waits: list[float] = []

    async def on_wait(waited: float) -> None:
        waits.append(waited)

    async def go() -> None:
        await AppBridge(folder, "outside").ask(
            "call_tool", 0.7, name="transcribe_clips", args={}, on_wait=on_wait
        )

    try:
        with pytest.raises(BridgeError, match="didn't answer transcribe_clips"):
            run(go)
    finally:
        fake.stop()
    assert len(waits) >= 2


def test_an_app_that_quits_mid_call_is_reported(folder: Path) -> None:
    fake = FakeApp(folder, lambda r: None)

    async def go() -> None:
        await AppBridge(folder, "outside").ask("call_tool", 30, name="add_markers", args={})

    def quit_app() -> None:
        time.sleep(0.2)
        fake.beating = False
        old = time.time() - 60
        os.utime(folder / "agent-alive.json", (old, old))

    threading.Thread(target=quit_app, daemon=True).start()
    try:
        with pytest.raises(BridgeError, match="quit before answering"):
            run(go)
    finally:
        fake.stop()


def test_long_tools_get_the_long_timeout() -> None:
    assert mcp_server.timeout_for("transcribe_clips") == mcp_server.LONG_TIMEOUT_SECONDS
    assert mcp_server.timeout_for("send_to_resolve") == mcp_server.LONG_TIMEOUT_SECONDS
    assert mcp_server.timeout_for("add_markers") == mcp_server.CALL_TIMEOUT_SECONDS


def test_the_caller_comes_from_the_environment(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv(mcp_server.CALLER_ENV, raising=False)
    assert mcp_server.caller_from_env() == "outside"
    monkeypatch.setenv(mcp_server.CALLER_ENV, "abc-123")
    assert mcp_server.caller_from_env() == "abc-123"
    monkeypatch.setenv(mcp_server.CALLER_ENV, "../../etc")
    assert mcp_server.caller_from_env() == "outside"
