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


def test_a_call_held_for_review_outlasts_its_usual_limit(folder: Path) -> None:
    """Phase 11d: the app marks a change waiting for the user with `replies/<id>.hold`; the shim then
    waits past the call's own limit until the answer comes, and clears the hold with it."""
    answered: dict[str, Any] = {}

    def hold_then_answer(request: dict[str, Any]) -> dict[str, Any] | None:
        replies = folder / "replies"
        (replies / f"{request['id']}.hold").write_text("", encoding="utf-8")

        def later() -> None:
            time.sleep(1.0)  # past the 0.5 s limit below: the user took their time
            reply = {"id": request["id"], "ok": True, "result": {"applied": True}}
            (replies / f"{request['id']}.json").write_text(json.dumps(reply), encoding="utf-8")
            answered["id"] = request["id"]

        threading.Thread(target=later, daemon=True).start()
        return None

    fake = FakeApp(folder, hold_then_answer)

    async def go() -> Any:
        return await AppBridge(folder, "job-1").ask("call_tool", 0.5, name="delete_clips", args={})

    try:
        assert run(go) == {"applied": True}
    finally:
        fake.stop()
    assert not (folder / "replies" / f"{answered['id']}.hold").exists()


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


def test_a_tools_images_reach_claude_code_as_image_content(folder: Path) -> None:
    """Phase 13b: look_at_clip's sheet comes back next to the result's text."""
    frame = {"mime": "image/jpeg", "data": "aGVsbG8="}
    fake = FakeApp(folder, lambda r: {"ok": True, "result": {"shown": "a sheet"}, "images": [frame]})
    try:
        server = build_server(AppBridge(folder, "job-1"))

        async def go() -> Any:
            async with Client(server) as client:
                return await client.call_tool("look_at_clip", {"clipId": "v1"})

        result = run(go)
    finally:
        fake.stop()
    assert result.is_error is False
    assert json.loads(result.content[0].text) == {"shown": "a sheet"}
    assert (result.content[1].type, result.content[1].data, result.content[1].mime_type) == (
        "image",
        "aGVsbG8=",
        "image/jpeg",
    )


# ------------------------------------------------------------------------------ orchestrated (Phase 21)


ORCHESTRATED_DECLARATIONS = [
    *DECLARATIONS,
    {
        "name": "list_timelines",
        "description": "Timelines.",
        "parameters": {"type": "OBJECT", "properties": {}},
    },
    {
        "name": "list_timeline_clips",
        "description": "Clips.",
        "parameters": {"type": "OBJECT", "properties": {}},
    },
    {
        "name": "get_editor_context",
        "description": "Context.",
        "parameters": {"type": "OBJECT", "properties": {}},
    },
    {"name": "get_instructions", "description": "Rules.", "parameters": {"type": "OBJECT", "properties": {}}},
]


def orchestrated_app(folder: Path, timeline_app: Any) -> FakeApp:
    """A fake app whose tools are the orchestrator test app's (tests/orchestrator/app.py)."""

    def answer(request: dict[str, Any]) -> dict[str, Any]:
        if request["kind"] == "list_tools":
            return {"ok": True, "result": {"tools": ORCHESTRATED_DECLARATIONS}}
        return {"ok": True, "result": timeline_app.answer(request["name"], request["args"])}

    return FakeApp(folder, answer)


@pytest.fixture
def timeline(tmp_path: Path) -> Any:
    from tests.orchestrator.app import App
    from tests.orchestrator.timeline import make_media, make_snapshot

    return App(make_snapshot(make_media(tmp_path)))


@pytest.fixture
def orchestration(folder: Path, tmp_path: Path) -> Any:
    from tests.orchestrator.app import make_bus
    from vibecut_agent.config import OrchestratorConfig

    bus = make_bus(OrchestratorConfig.from_env("orchestrated"), tmp_path)
    return mcp_server.Orchestration(AppBridge(folder, "job-1"), bus)


def test_an_orchestrated_chat_sees_the_orchestration_tools_and_only_the_reads(
    folder: Path, timeline: Any, orchestration: Any
) -> None:
    from vibecut_agent.orchestrator.tool_bus import ORCHESTRATOR_TOOL_NAMES

    fake = orchestrated_app(folder, timeline)
    try:
        server = build_server(AppBridge(folder, "job-1"), orchestration)

        async def go() -> Any:
            async with Client(server) as client:
                return await client.list_tools()

        names = [t.name for t in run(go).tools]
    finally:
        fake.stop()
    # Of the app's tools, add_markers (an edit) and get_instructions (the direct-mode rules) are left out.
    assert names == [
        "list_markers",
        "list_timelines",
        "list_timeline_clips",
        "get_editor_context",
        *ORCHESTRATOR_TOOL_NAMES,
    ]


def test_an_orchestrated_chat_edits_only_through_a_validated_delta(
    folder: Path, timeline: Any, orchestration: Any
) -> None:
    from tests.orchestrator.timeline import delta, op

    fake = orchestrated_app(folder, timeline)
    try:
        server = build_server(AppBridge(folder, "job-1"), orchestration)

        async def go() -> Any:
            async with Client(server) as client:
                refused = await client.call_tool("add_markers", {"markers": [{"time": 1.0}]})
                read = await client.call_tool("list_markers", {})
                proposal = await client.call_tool(
                    "propose_otio_delta", {"delta": delta(op("op_001", "DELETE_CLIP", clip_id="c2"))}
                )
                token = json.loads(proposal.content[0].text)["validation_token"]
                commit = await client.call_tool(
                    "commit_otio_delta", {"validation_token": token, "commit_summary": "Drop the second shot"}
                )
                bad = await client.call_tool("propose_otio_delta", {"delta": {"operations": []}})
                return refused, read, proposal, commit, bad

        refused, read, proposal, commit, bad = run(go)
    finally:
        fake.stop()
    assert refused.is_error is True
    assert "edits go through propose_otio_delta" in json.loads(refused.content[0].text)["error"]
    assert read.is_error is False
    assert json.loads(read.content[0].text) == {"markers": []}
    assert json.loads(proposal.content[0].text)["valid"] is True
    assert json.loads(commit.content[0].text) == {"committed": True}
    assert bad.is_error is True
    # The app saw the read, the bus's two timeline reads for each of propose and commit, and the commit,
    # all as this chat's calls; never add_markers.
    calls = [(r["caller"], r["name"]) for r in fake.seen if r["kind"] == "call_tool"]
    assert calls == [
        ("job-1", "list_markers"),
        ("job-1", "list_timelines"),
        ("job-1", "list_timeline_clips"),
        ("job-1", "list_timelines"),
        ("job-1", "list_timeline_clips"),
        ("job-1", "commit_otio_delta"),
    ]
    sent = next(r for r in fake.seen if r.get("name") == "commit_otio_delta")["args"]
    assert [c["command"] for c in sent["batch"]] == ["backup_timeline", "delete_clips"]
    assert mcp_server.timeout_for("commit_otio_delta") == mcp_server.LONG_TIMEOUT_SECONDS


def test_only_the_apps_own_chat_is_orchestrated(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv(mcp_server.ORCHESTRATED_ENV, "1")
    assert mcp_server.orchestrated_from_env("job-1") is True
    assert mcp_server.orchestrated_from_env(mcp_server.OUTSIDE) is False
    monkeypatch.delenv(mcp_server.ORCHESTRATED_ENV)
    assert mcp_server.orchestrated_from_env("job-1") is False
