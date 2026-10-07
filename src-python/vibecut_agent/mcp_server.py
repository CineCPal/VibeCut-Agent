"""mcp_server.py

The MCP server an MCP client launches to call the editing agent's tools (PLAN.md, "Phase 7a"):
``python -m vibecut_agent mcp``, over stdio. The client is the app's own Claude Code run (7b, which
sets ``VIBECUT_MCP_CALLER`` to its chat job) or a Claude Code session the user started (7d, the
default caller ``"outside"``).

This process holds no tools of its own. It asks the running app for them and hands each call to it
through files in the bridge folder (src-tauri/src/mcp_bridge.rs): ``requests/<id>.json`` in,
``replies/<id>.json`` back. The app runs the same executors the in-app chat uses, so a call made here
gets the same snapshot, backup, edit log and Revert. There is no network port.

The declarations arrive in Gemini's OpenAPI dialect, as the chat sidecar gets them, and are converted
with the chat's own ``claude_schema.to_claude_tool``, so the two can't drift apart.

stdout is the MCP channel: nothing else may print there. Diagnostics go to stderr.
"""

from __future__ import annotations

import json
import os
import sys
import time
import uuid
from collections.abc import Awaitable, Callable
from pathlib import Path
from typing import Any

import anyio
import mcp_types as types
from mcp.server.lowlevel import Server
from mcp.server.stdio import stdio_server

from vibecut_agent.agent.claude_schema import to_claude_tool

SERVER_NAME = "vibecut"
OUTSIDE = "outside"
CALLER_ENV = "VIBECUT_MCP_CALLER"
DIR_ENV = "VIBECUT_AGENT_MCP_DIR"

# The app stamps agent-alive.json every second; older than this means it isn't running.
HEARTBEAT_STALE_SECONDS = 5.0
POLL_SECONDS = 0.1
PROGRESS_EVERY_SECONDS = 10.0
LIST_TIMEOUT_SECONDS = 30.0
CALL_TIMEOUT_SECONDS = 120.0
# Tools that can run for minutes: transcription, waveform sync, the Story Editor, a draft's rebuild.
LONG_TOOLS = frozenset(
    {
        "transcribe_clips",
        "sync_and_place",
        "sync_clips",
        "slip_into_sync",
        "run_story_editor",
        "send_to_premiere",
        "send_to_resolve",
        "find_silences",
    }
)
LONG_TIMEOUT_SECONDS = 15 * 60.0

INSTRUCTIONS = (
    "These tools edit the timeline open in Adobe Premiere Pro or DaVinci Resolve through the VibeCut "
    "Agent app on this Mac. Before editing, call get_instructions once (the editing rules) and "
    "get_editor_context (the open timeline, its clips, the project's media and the edits so far). "
    "Every direct edit is backed up and logged; revert_timeline_edits undoes them by id."
)

# Offered when the app can't be reached, so the client still has something that explains why.
CONTEXT_TOOL_NAME = "get_editor_context"
FALLBACK_TOOL = types.Tool(
    name=CONTEXT_TOOL_NAME,
    description="What VibeCut Agent sees: the connected editor, the open timeline and the edits so far.",
    input_schema={"type": "object", "properties": {}},
)


class BridgeError(Exception):
    """The app couldn't be asked, or didn't answer."""


def bridge_dir() -> Path:
    custom = os.environ.get(DIR_ENV)
    if custom:
        return Path(custom)
    return Path.home() / "Library/Application Support/VibeCut Agent/host-bridge/mcp"


def timeout_for(name: str) -> float:
    return LONG_TIMEOUT_SECONDS if name in LONG_TOOLS else CALL_TIMEOUT_SECONDS


OnWait = Callable[[float], Awaitable[None]]


class AppBridge:
    """Requests to the running app through the bridge folder."""

    def __init__(self, folder: Path, caller: str) -> None:
        self.folder = folder
        self.caller = caller

    def heartbeat(self) -> dict[str, Any] | None:
        """The app's latest stamp, or None when it's missing or stale (the app isn't running)."""
        path = self.folder / "agent-alive.json"
        try:
            age = time.time() - path.stat().st_mtime
            if age > HEARTBEAT_STALE_SECONDS:
                return None
            stamp = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return None
        return stamp if isinstance(stamp, dict) else None

    def check_reachable(self) -> None:
        stamp = self.heartbeat()
        if stamp is None:
            raise BridgeError("VibeCut Agent isn't running. Open it from the menu bar, then try again.")
        if self.caller == OUTSIDE and stamp.get("outsideAllowed") is not True:
            raise BridgeError(
                "Outside control is off in VibeCut Agent. Turn it on in Settings → Outside control, "
                "then try again."
            )

    def _write_request(self, request: dict[str, Any]) -> None:
        requests = self.folder / "requests"
        name = f"{request['id']}.json"
        tmp = requests / f".{name}.tmp"
        tmp.write_text(json.dumps(request), encoding="utf-8")
        tmp.rename(requests / name)

    async def ask(
        self,
        kind: str,
        timeout: float,
        name: str | None = None,
        args: dict[str, Any] | None = None,
        on_wait: OnWait | None = None,
    ) -> Any:
        """Sends one request and waits for its reply's `result`. Raises BridgeError on any failure."""
        self.check_reachable()
        request_id = uuid.uuid4().hex
        request: dict[str, Any] = {"id": request_id, "caller": self.caller, "kind": kind}
        if name is not None:
            request["name"] = name
            request["args"] = args or {}
        try:
            self._write_request(request)
        except OSError as exc:
            raise BridgeError(f"Couldn't reach VibeCut Agent: {exc}") from None

        reply_path = self.folder / "replies" / f"{request_id}.json"
        started = time.monotonic()
        next_progress = PROGRESS_EVERY_SECONDS
        next_heartbeat = 1.0
        while True:
            if reply_path.exists():
                try:
                    reply = json.loads(reply_path.read_text(encoding="utf-8"))
                except (OSError, ValueError) as exc:
                    raise BridgeError(f"VibeCut Agent's reply couldn't be read: {exc}") from None
                finally:
                    reply_path.unlink(missing_ok=True)
                if not isinstance(reply, dict):
                    raise BridgeError("VibeCut Agent's reply wasn't an object")
                if reply.get("ok") is not True:
                    raise BridgeError(str(reply.get("error") or "VibeCut Agent refused the request"))
                return reply.get("result")
            waited = time.monotonic() - started
            if waited >= timeout:
                what = f"{name}" if name else kind
                raise BridgeError(
                    f"VibeCut Agent didn't answer {what} within {round(timeout)} s. It may still finish: "
                    "call get_editor_context to see the timeline as it is now."
                )
            if waited >= next_heartbeat:
                next_heartbeat += 1.0
                if self.heartbeat() is None:
                    raise BridgeError("VibeCut Agent quit before answering.")
            if on_wait is not None and waited >= next_progress:
                next_progress += PROGRESS_EVERY_SECONDS
                await on_wait(waited)
            await anyio.sleep(POLL_SECONDS)


def tools_from(result: Any) -> list[types.Tool]:
    """The app's declarations (Gemini's dialect) as MCP tools."""
    declarations = result.get("tools") if isinstance(result, dict) else None
    tools: list[types.Tool] = []
    for declaration in declarations if isinstance(declarations, list) else []:
        if not isinstance(declaration, dict) or not declaration.get("name"):
            continue
        converted = to_claude_tool(declaration)
        tools.append(
            types.Tool(
                name=str(converted["name"]),
                description=converted.get("description"),
                input_schema=converted["input_schema"],
            )
        )
    return tools


def text_result(payload: Any, is_error: bool) -> types.CallToolResult:
    text = payload if isinstance(payload, str) else json.dumps(payload, ensure_ascii=False)
    return types.CallToolResult(content=[types.TextContent(text=text)], is_error=is_error)


def build_server(bridge: AppBridge) -> Server[Any]:
    async def list_tools(ctx: Any, params: Any) -> types.ListToolsResult:
        try:
            result = await bridge.ask("list_tools", LIST_TIMEOUT_SECONDS)
        except BridgeError as exc:
            print(f"vibecut mcp: {exc}", file=sys.stderr)
            return types.ListToolsResult(tools=[FALLBACK_TOOL])
        return types.ListToolsResult(tools=tools_from(result) or [FALLBACK_TOOL])

    async def call_tool(ctx: Any, params: types.CallToolRequestParams) -> types.CallToolResult:
        name = params.name
        args = dict(params.arguments or {})
        timeout = timeout_for(name)

        async def on_wait(waited: float) -> None:
            try:
                await ctx.session.report_progress(waited, timeout, f"Still running {name}…")
            except Exception as exc:  # noqa: BLE001 - progress is best effort; the call goes on
                print(f"vibecut mcp: progress not sent: {exc}", file=sys.stderr)

        try:
            result = await bridge.ask("call_tool", timeout, name=name, args=args, on_wait=on_wait)
        except BridgeError as exc:
            return text_result({"error": str(exc)}, is_error=True)
        is_error = isinstance(result, dict) and "error" in result
        return text_result(result, is_error=is_error)

    return Server(
        SERVER_NAME,
        version="0.1.0",
        instructions=INSTRUCTIONS,
        on_list_tools=list_tools,
        on_call_tool=call_tool,
    )


def caller_from_env() -> str:
    caller = os.environ.get(CALLER_ENV, "").strip() or OUTSIDE
    if not (0 < len(caller) <= 64 and all(c.isalnum() or c in "_-" for c in caller)):
        return OUTSIDE
    return caller


def main() -> int:
    bridge = AppBridge(bridge_dir(), caller_from_env())
    server = build_server(bridge)

    async def run() -> None:
        async with stdio_server() as (read_stream, write_stream):
            await server.run(read_stream, write_stream, server.create_initialization_options())

    anyio.run(run)
    return 0
