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

In orchestrated mode (Phase 21; ``VIBECUT_MCP_ORCHESTRATED=1``, which claude_code_chat sets for the app's
own Claude Code run when ``EXECUTION_MODE=orchestrated``), this process plays the part
orchestrator/supervisor.py plays for Claude through the API (`Orchestration`):
- it offers the six orchestration tools, and of the app's tools only the read-only ones (the B-roll Library
  and the media pool among them), the B-roll Analyzer and the three sync tools (tool_bus.FORWARDED_TOOLS);
- it runs the orchestration tools itself, on the tool bus (orchestrator/tool_bus.py), whose reads of the
  timeline and whose commit go to the app through the bridge as this chat's own calls;
- it refuses any other call.
The bus lives as long as this process, which is one Claude Code run: one turn. A validation token is
good for the turn it was handed out in. Outside callers are never orchestrated.

stdout is the MCP channel: nothing else may print there. Diagnostics go to stderr.
"""

from __future__ import annotations

import json
import os
import signal
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

from vibecut_agent.agent.attachments import tool_images
from vibecut_agent.agent.claude_schema import to_claude_tool

SERVER_NAME = "vibecut"
OUTSIDE = "outside"
CALLER_ENV = "VIBECUT_MCP_CALLER"
DIR_ENV = "VIBECUT_AGENT_MCP_DIR"
ORCHESTRATED_ENV = "VIBECUT_MCP_ORCHESTRATED"

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
        "measure_loudness",
        "normalize_loudness",
        "find_beats",
        "review_edit",
        "cut_to_beats",
        # Phase 18a: reads every mic's peaks.
        "cut_by_speaker",
        # Phase 18c: cleans whole files with ffmpeg.
        "clean_dialogue",
        # Phase 18e: searches recordings for room tone and loops it with ffmpeg.
        "fill_room_tone",
        # Phase 18d: renders each lower third with ffmpeg.
        "add_lower_thirds",
        # Phase 19b: decodes the picture of a whole clip or file.
        "find_shot_changes",
        # Phase 20a: may decode long clips or a whole file for their shots.
        "check_pacing",
        # Phase 20b: decodes a whole reference file (shots, frames, beats).
        "learn_style",
        # Phase 20d: up to 60 frames decoded and scored; stills exported from the editor.
        "find_thumbnails",
        "export_thumbnails",
        # Phase 19c: up to 3 rendered and measured frames per clip, for up to 50 clips.
        "match_clip_color",
        "balance_clip_color",
        "create_captions",
        "export_video",
        "export_audio",
        "export_clips",
        # Phase 16e: a folder of footage can take minutes to score.
        "analyze_broll_folder",
        # The first search installs the content-aware packages and loads SigLIP 2.
        "find_broll",
        "build_broll_selects_timeline",
        # Phase 21: a validated OTIO delta's calls, one after another in the editor.
        "commit_otio_delta",
    }
)
LONG_TIMEOUT_SECONDS = 15 * 60.0
# A call waiting for the user's review in the app (Phase 11d: the app writes `replies/<id>.hold`) may
# wait this long for Apply or Skip.
HOLD_TIMEOUT_SECONDS = 30 * 60

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
        reply = await self.ask_reply(kind, timeout, name, args, on_wait)
        return reply.get("result")

    async def ask_reply(
        self,
        kind: str,
        timeout: float,
        name: str | None = None,
        args: dict[str, Any] | None = None,
        on_wait: OnWait | None = None,
    ) -> dict[str, Any]:
        """`ask`, with the whole reply: its `result` and any `images` (Phase 13b)."""
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
        hold_path = self.folder / "replies" / f"{request_id}.hold"
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
                    hold_path.unlink(missing_ok=True)
                if not isinstance(reply, dict):
                    raise BridgeError("VibeCut Agent's reply wasn't an object")
                if reply.get("ok") is not True:
                    raise BridgeError(str(reply.get("error") or "VibeCut Agent refused the request"))
                return reply
            waited = time.monotonic() - started
            if timeout < HOLD_TIMEOUT_SECONDS and hold_path.exists():
                timeout = HOLD_TIMEOUT_SECONDS  # the user is reviewing this change in the app
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


def text_result(payload: Any, is_error: bool, images: Any = None) -> types.CallToolResult:
    """The result as text, then any images it came with (look_at_clip's frames, Phase 13b)."""
    text = payload if isinstance(payload, str) else json.dumps(payload, ensure_ascii=False)
    content: list[Any] = [types.TextContent(text=text)]
    content += [
        types.ImageContent(data=i["data"], mime_type=i["mime"]) for i in tool_images({"images": images})
    ]
    return types.CallToolResult(content=content, is_error=is_error)


class Orchestration:
    """The orchestrated chat's side of this process (see the module docstring)."""

    # Of the app's tools, the ones an orchestrated chat keeps: the read-only ones, sync, and the editor context.
    FORWARDED = frozenset({CONTEXT_TOOL_NAME})

    def __init__(self, bridge: AppBridge, bus: Any = None) -> None:
        from vibecut_agent.orchestrator.tool_bus import FORWARDED_TOOLS

        self.bridge = bridge
        self._bus = bus
        self.forwarded = self.FORWARDED | frozenset(FORWARDED_TOOLS)

    @property
    def bus(self) -> Any:
        if self._bus is None:
            from vibecut_agent.config import OrchestratorConfig
            from vibecut_agent.orchestrator.tool_bus import OrchestratorToolBus
            from vibecut_agent.telemetry.instrument import for_process

            self._bus = OrchestratorToolBus(OrchestratorConfig.from_env("orchestrated"))
            # Phase 22: this run's events go to <appDataDir>/telemetry when VIBECUT_TELEMETRY=1.
            self._bus.telemetry = for_process("mcp", self.bridge.caller)
        return self._bus

    def handles(self, name: str) -> bool:
        from vibecut_agent.orchestrator.tool_bus import ORCHESTRATOR_TOOL_NAMES

        return name in ORCHESTRATOR_TOOL_NAMES

    def tools(self, app_tools: list[types.Tool]) -> list[types.Tool]:
        from vibecut_agent.orchestrator.tool_bus import claude_tools

        kept = [t for t in app_tools if t.name in self.forwarded]
        for declaration in claude_tools():
            converted = to_claude_tool(declaration)
            kept.append(
                types.Tool(
                    name=str(converted["name"]),
                    description=converted.get("description"),
                    input_schema=converted["input_schema"],
                )
            )
        return kept

    def call_app(self, calls: list[tuple[str, dict[str, Any]]]) -> list[Any]:
        """The bus's calls to the app, made from its worker thread through the bridge, in order. A call the
        bridge couldn't make comes back as that call's `{"error"}`."""
        results = []
        for name, args in calls:
            try:
                reply = anyio.from_thread.run(
                    self.bridge.ask_reply, "call_tool", timeout_for(name), name, args
                )
                results.append(reply.get("result"))
            except BridgeError as exc:
                results.append({"error": str(exc)})
        return results

    def dispatch(self, name: str, args: dict[str, Any]) -> Any:
        """Runs an orchestration tool on the bus; call from a worker thread."""
        bus = self.bus
        bus.call_app = self.call_app
        return bus.dispatch(name, args)


REFUSED_IN_ORCHESTRATED_MODE = (
    "{name} isn't available here: edits go through propose_otio_delta and commit_otio_delta"
)


def build_server(bridge: AppBridge, orchestration: Orchestration | None = None) -> Server[Any]:
    async def list_tools(ctx: Any, params: Any) -> types.ListToolsResult:
        try:
            result = await bridge.ask("list_tools", LIST_TIMEOUT_SECONDS)
        except BridgeError as exc:
            print(f"vibecut mcp: {exc}", file=sys.stderr)
            return types.ListToolsResult(tools=[FALLBACK_TOOL])
        tools = tools_from(result)
        if orchestration is not None:
            tools = orchestration.tools(tools)
        return types.ListToolsResult(tools=tools or [FALLBACK_TOOL])

    async def call_tool(ctx: Any, params: types.CallToolRequestParams) -> types.CallToolResult:
        name = params.name
        args = dict(params.arguments or {})
        timeout = timeout_for(name)
        if orchestration is not None:
            if orchestration.handles(name):
                result = await anyio.to_thread.run_sync(orchestration.dispatch, name, args)
                return text_result(result, is_error=isinstance(result, dict) and "error" in result)
            if name not in orchestration.forwarded:
                return text_result({"error": REFUSED_IN_ORCHESTRATED_MODE.format(name=name)}, is_error=True)

        async def on_wait(waited: float) -> None:
            try:
                await ctx.session.report_progress(waited, timeout, f"Still running {name}…")
            except Exception as exc:  # noqa: BLE001 - progress is best effort; the call goes on
                print(f"vibecut mcp: progress not sent: {exc}", file=sys.stderr)

        try:
            reply = await bridge.ask_reply("call_tool", timeout, name=name, args=args, on_wait=on_wait)
        except BridgeError as exc:
            return text_result({"error": str(exc)}, is_error=True)
        result = reply.get("result")
        is_error = isinstance(result, dict) and "error" in result
        return text_result(result, is_error=is_error, images=reply.get("images"))

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


def orchestrated_from_env(caller: str) -> bool:
    """Only the app's own chat is orchestrated, and only when claude_code_chat said so."""
    return caller != OUTSIDE and os.environ.get(ORCHESTRATED_ENV) == "1"


# The signals that end an orchestrated shim's run (see `main`).
END_SIGNALS = (signal.SIGTERM, signal.SIGHUP, signal.SIGINT)


def main() -> int:
    caller = caller_from_env()
    bridge = AppBridge(bridge_dir(), caller)
    orchestration = Orchestration(bridge) if orchestrated_from_env(caller) else None
    server = build_server(bridge, orchestration)

    async def run() -> None:
        async with stdio_server() as (read_stream, write_stream):
            await server.run(read_stream, write_stream, server.create_initialization_options())

    def finish() -> None:
        # Phase 22: the run is over (Claude Code closed the shim): its trace's root task is done.
        telemetry = getattr(orchestration._bus, "telemetry", None) if orchestration is not None else None
        if telemetry is not None:
            telemetry.finish()

    if orchestration is not None:
        # Claude Code ends its MCP servers with a signal, which skips `finally`: finish the trace first, then
        # end as that signal would have. Only the main thread drains the bus here, so the flush can't deadlock.
        def on_signal(signum: int, _frame: Any) -> None:
            finish()
            signal.signal(signum, signal.SIG_DFL)
            os.kill(os.getpid(), signum)

        for signum in END_SIGNALS:
            signal.signal(signum, on_signal)

    try:
        anyio.run(run)
    finally:
        finish()
    return 0
