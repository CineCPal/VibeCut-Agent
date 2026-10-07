"""claude_code_chat.py

The chat agent on "Claude (subscription)" (PLAN.md, "Phase 7b"): each turn runs the user's own
signed-in Claude Code CLI (``claude -p``), so it uses their Claude subscription and needs no API key.

The same contract as gemini_chat/claude_chat.run_chat_turn (one user message in; ``status`` events
while it works; an outcome with text, history, usage, aborted and outOfSteps out), with two
differences:

- Tool calls don't come back through this process as ``tool_calls`` events. Claude Code calls
  VibeCut's MCP server (vibecut_agent/mcp_server.py, Phase 7a), which hands them to the app through
  the MCP bridge tagged with this chat's job id; the app runs them as part of this turn.
- Claude Code keeps the conversation itself. ``history`` is ``[{"claudeCodeSession": <id>}]`` and the
  next turn resumes that session.

What runs is decided by Rust (claude_code.rs) and arrives as the request's ``claudeCode``: the
program, the Claude Code profile folder (``CLAUDE_CONFIG_DIR``), the job id, an empty working folder
and how to start the MCP shim. Claude Code's own tools (shell, files, web) are switched off, only
VibeCut's MCP tools are allowed, its hooks don't run, and nothing can wait on a permission prompt.
No ``ANTHROPIC_*`` credential is ever passed on, so Claude Code signs in with the subscription.
"""

from __future__ import annotations

import json
import os
import queue
import signal
import subprocess
import threading
from collections.abc import Callable
from typing import Any

from vibecut_agent.agent.chat_steps import DEFAULT_MAX_STEPS, OUT_OF_STEPS_NOTICE
from vibecut_agent.agent.gemini_chat import STOPPED_NOTICE, ChatError

SERVER_NAME = "vibecut"
ALLOWED_TOOLS = f"mcp__{SERVER_NAME}__*"
MODELS = ("claude-opus-5-5", "claude-sonnet-5-5")
DEFAULT_MODEL = "claude-sonnet-5-5"
# Anything that would make Claude Code bill an API account instead of the subscription.
DROPPED_ENV = (
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
    "ANTHROPIC_BASE_URL",
    "CLAUDE_CODE_USE_BEDROCK",
    "CLAUDE_CODE_USE_VERTEX",
)
POLL_SECONDS = 0.2
# After Stop: SIGINT, then SIGTERM, then SIGKILL, this long apart.
STOP_GRACE_SECONDS = 5.0
STDERR_KEEP_CHARS = 4000

Popen = Callable[..., subprocess.Popen[bytes]]


def session_of(history: list[Any]) -> str | None:
    """The Claude Code session a previous turn left in ``history``."""
    for entry in reversed(history):
        if isinstance(entry, dict) and isinstance(entry.get("claudeCodeSession"), str):
            return str(entry["claudeCodeSession"])
    return None


def check_setup(setup: Any) -> dict[str, Any]:
    if not isinstance(setup, dict):
        raise ChatError("Claude Code isn't set up. See Settings → Claude subscription.")
    for key in ("program", "jobId", "workDir"):
        if not isinstance(setup.get(key), str) or not setup[key]:
            raise ChatError(f"Claude Code's setup is missing {key}.")
    mcp = setup.get("mcp")
    if (
        not isinstance(mcp, dict)
        or not isinstance(mcp.get("program"), str)
        or not isinstance(mcp.get("args"), list)
    ):
        raise ChatError("Claude Code's setup is missing how to start VibeCut's MCP server.")
    return setup


def mcp_config(setup: dict[str, Any]) -> dict[str, Any]:
    """The one MCP server Claude Code gets: VibeCut's shim, tagged with this chat's job."""
    mcp = setup["mcp"]
    env = {str(k): str(v) for k, v in (mcp.get("env") or [])}
    env["VIBECUT_MCP_CALLER"] = setup["jobId"]
    return {
        "mcpServers": {
            SERVER_NAME: {"command": mcp["program"], "args": [str(a) for a in mcp["args"]], "env": env}
        }
    }


def build_args(
    setup: dict[str, Any], model: str, system_instruction: str, max_turns: int, session: str | None
) -> list[str]:
    args = [
        setup["program"],
        "-p",
        "--output-format",
        "stream-json",
        "--verbose",
        "--model",
        model,
        # No built-in tools (shell, files, web, skills): only VibeCut's MCP tools.
        "--tools",
        "",
        "--strict-mcp-config",
        "--mcp-config",
        json.dumps(mcp_config(setup)),
        "--allowedTools",
        ALLOWED_TOOLS,
        # Nobody answers a permission prompt here; anything that would ask is refused.
        "--permission-prompts",
        "none",
        # The user's hooks are for their own sessions, not this one.
        "--settings",
        json.dumps({"disableAllHooks": True}),
        "--system-prompt",
        system_instruction,
        "--max-turns",
        str(max_turns),
    ]
    if session:
        args += ["--resume", session]
    return args


def child_env(setup: dict[str, Any], base: dict[str, str] | None = None) -> dict[str, str]:
    env = dict(os.environ if base is None else base)
    for name in DROPPED_ENV:
        env.pop(name, None)
    env.pop("CLAUDE_CONFIG_DIR", None)
    if isinstance(setup.get("configDir"), str) and setup["configDir"]:
        env["CLAUDE_CONFIG_DIR"] = setup["configDir"]
    return env


def lockdown_problem(
    init: dict[str, Any], tool_prefix: str | None, exact_tools: frozenset[str], servers: frozenset[str]
) -> str | None:
    """Why a Claude Code run isn't locked down as asked, from its startup (`system`/`init`) event, or None.

    The flags (`--tools ""`, `--strict-mcp-config`) are what keep Claude Code to VibeCut's tools; a later
    Claude Code could change what they do. So each run's own tool and MCP server lists are checked, and
    a run with anything else is stopped before Claude does anything (PLAN.md, "Phase 7f")."""
    tools = init.get("tools")
    if not isinstance(tools, list):
        return "Claude Code didn't say which tools it has"
    extra = sorted(
        str(t)
        for t in tools
        if str(t) not in exact_tools and not (tool_prefix and str(t).startswith(tool_prefix))
    )
    if extra:
        shown = ", ".join(extra[:8]) + ("…" if len(extra) > 8 else "")
        return f"Claude Code started with tools VibeCut doesn't allow ({shown})"
    raw_servers = init.get("mcp_servers")
    names = (
        {str(m.get("name")) for m in raw_servers if isinstance(m, dict)}
        if isinstance(raw_servers, list)
        else set()
    )
    if names - servers:
        return f"Claude Code started with MCP servers VibeCut doesn't allow ({', '.join(sorted(names - servers))})"
    return None


LOCKDOWN_NOTE = (
    "VibeCut stopped Claude Code before it did anything: {problem}. Your Claude Code version may have "
    "changed how VibeCut's lockdown flags work; please report it."
)


def mcp_problem(init: dict[str, Any]) -> str | None:
    """Why VibeCut's own MCP server isn't usable in this run, or None."""
    raw = init.get("mcp_servers")
    ours = (
        next((m for m in raw if isinstance(m, dict) and m.get("name") == SERVER_NAME), None)
        if isinstance(raw, list)
        else None
    )
    if ours is None:
        return "VibeCut's tools didn't load in Claude Code"
    if ours.get("status") != "connected":
        return (
            f"VibeCut's tools didn't start in Claude Code ({ours.get('status')}). Is VibeCut Agent running?"
        )
    return None


def usage_of(result: dict[str, Any]) -> dict[str, int]:
    raw_usage = result.get("usage")
    usage: dict[str, Any] = raw_usage if isinstance(raw_usage, dict) else {}
    raw_details = usage.get("output_tokens_details")
    details: dict[str, Any] = raw_details if isinstance(raw_details, dict) else {}

    def n(key: str) -> int:
        return int(usage.get(key) or 0)

    cached = n("cache_read_input_tokens")
    return {
        "promptTokens": n("input_tokens") + n("cache_creation_input_tokens") + cached,
        "cachedTokens": cached,
        "outputTokens": n("output_tokens"),
        "thoughtsTokens": int(details.get("thinking_tokens") or 0),
        "steps": int(result.get("num_turns") or 0),
    }


def short_tool_name(name: str) -> str:
    prefix = f"mcp__{SERVER_NAME}__"
    return name.removeprefix(prefix)


def explain_failure(stderr: str, code: int | None) -> str:
    lowered = stderr.lower()
    if "not logged in" in lowered or "please run /login" in lowered or "invalid api key" in lowered:
        return "Claude Code isn't signed in. Run claude in Terminal and sign in with your Claude account, then try again."
    if "usage limit" in lowered or "rate limit" in lowered:
        return f"Claude Code hit your plan's usage limit: {stderr.strip()[-300:]}"
    tail = stderr.strip()[-500:] or f"it exited with code {code}"
    return f"Claude Code stopped without an answer: {tail}"


def _reply_text(result: dict[str, Any], texts: list[str]) -> str:
    """The turn's answer: the result's own text, else what Claude said after its last tool call."""
    return result["result"] if isinstance(result.get("result"), str) else "\n\n".join(texts)


def _stop(process: subprocess.Popen[bytes]) -> None:
    """SIGINT, then SIGTERM, then SIGKILL to Claude Code, which ends the MCP server it started. It stays
    in the sidecar's process group, so the app's own cancel and quit (which signal that group) reach
    it too and it can never outlive the sidecar."""
    for sig in (signal.SIGINT, signal.SIGTERM, signal.SIGKILL):
        try:
            process.send_signal(sig)
        except (ProcessLookupError, PermissionError):
            return
        try:
            process.wait(timeout=STOP_GRACE_SECONDS)
            return
        except subprocess.TimeoutExpired:
            continue


# A saved session Claude Code no longer has (cleaned up, another profile, a reinstall): the turn starts a
# new one, and Claude is told it can't see the earlier part (PLAN.md, Phase 8a).
SESSION_GONE_STATUS = "Couldn't resume the earlier Claude Code session; starting a new one…"
SESSION_GONE_NOTE = (
    "(VibeCut note: the earlier part of this conversation couldn't be resumed in Claude Code, so you "
    "don't have its context. The user can still see the earlier messages; ask them if you need "
    "something from them.)\n\n"
)


def session_gone(event: dict[str, Any]) -> bool:
    """Whether Claude Code ended at once because the session to resume doesn't exist. Checked live
    (2.1.292): a ``result`` with ``errors: ["No conversation found with session ID: …"]`` and no
    startup report before it."""
    errors = event.get("errors")
    return (
        event.get("type") == "result"
        and isinstance(errors, list)
        and any(isinstance(e, str) and "no conversation found" in e.lower() for e in errors)
    )


class _SessionGone(Exception):
    pass


def run_chat_turn(
    setup: Any,
    model: str | None,
    system_instruction: str,
    history: list[Any],
    user_message: str,
    emit: Callable[..., None],
    should_abort: Callable[[], bool] = lambda: False,
    max_iterations: int = DEFAULT_MAX_STEPS,
    popen: Popen = subprocess.Popen,
) -> dict[str, Any]:
    """Runs one turn through Claude Code, end to end. Raises ChatError when it can't."""
    setup = check_setup(setup)
    if not user_message or not user_message.strip():
        raise ChatError("The chat message was empty.")
    resolved_model = model if model in MODELS else DEFAULT_MODEL
    session = session_of(history)
    os.makedirs(setup["workDir"], exist_ok=True)
    try:
        return _run_once(
            setup, resolved_model, system_instruction, session, history, user_message,
            emit, should_abort, max_iterations, popen,
        )
    except _SessionGone:
        emit("status", detail=SESSION_GONE_STATUS)
        return _run_once(
            setup, resolved_model, system_instruction, None, [], SESSION_GONE_NOTE + user_message,
            emit, should_abort, max_iterations, popen,
        )


def _run_once(
    setup: dict[str, Any],
    resolved_model: str,
    system_instruction: str,
    session: str | None,
    history: list[Any],
    user_message: str,
    emit: Callable[..., None],
    should_abort: Callable[[], bool],
    max_iterations: int,
    popen: Popen,
) -> dict[str, Any]:
    """One ``claude -p`` for the turn. Raises _SessionGone when ``session`` can't be resumed."""
    resuming = session is not None
    args = build_args(setup, resolved_model, system_instruction, max_iterations, session)
    try:
        process = popen(
            args,
            cwd=setup["workDir"],
            env=child_env(setup),
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )
    except OSError as exc:
        raise ChatError(f"Couldn't start Claude Code ({setup['program']}): {exc}") from None

    lines: queue.Queue[bytes | None] = queue.Queue()
    stderr_parts: list[str] = []

    def pump_stdout() -> None:
        assert process.stdout is not None
        for raw in process.stdout:
            lines.put(raw)
        lines.put(None)

    def pump_stderr() -> None:
        assert process.stderr is not None
        for raw in process.stderr:
            stderr_parts.append(raw.decode("utf-8", "replace"))
            while sum(len(p) for p in stderr_parts) > STDERR_KEEP_CHARS and len(stderr_parts) > 1:
                stderr_parts.pop(0)

    threading.Thread(target=pump_stdout, daemon=True).start()
    threading.Thread(target=pump_stderr, daemon=True).start()
    try:
        assert process.stdin is not None
        process.stdin.write(user_message.encode("utf-8"))
        process.stdin.close()
    except OSError:
        pass  # it died at once; reported below from its exit

    emit("status", detail="Starting Claude Code…")
    texts: list[str] = []
    result: dict[str, Any] | None = None
    aborted = False
    checked = False
    while True:
        if not aborted and should_abort():
            aborted = True
            emit("status", detail="Stopping Claude Code…")
            _stop(process)
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
        if resuming and not checked and not aborted and session_gone(event):
            _stop(process)
            raise _SessionGone()
        if isinstance(event.get("session_id"), str):
            session = event["session_id"]
        if kind == "system" and event.get("subtype") == "init":
            problem = lockdown_problem(
                event, ALLOWED_TOOLS.rstrip("*"), frozenset(), frozenset({SERVER_NAME})
            )
            if problem:
                _stop(process)
                raise ChatError(LOCKDOWN_NOTE.format(problem=problem))
            problem = mcp_problem(event)
            if problem:
                _stop(process)
                raise ChatError(problem)
            checked = True
            emit("status", detail=f"Calling Claude ({resolved_model}) through Claude Code…")
        elif not checked and not aborted and kind in ("assistant", "user", "result"):
            # Nothing may happen before the run has shown it's locked down.
            _stop(process)
            raise ChatError(LOCKDOWN_NOTE.format(problem="it didn't report its tools before starting"))
        elif kind == "assistant":
            content = (event.get("message") or {}).get("content")
            for block in content if isinstance(content, list) else []:
                if not isinstance(block, dict):
                    continue
                if block.get("type") == "tool_use":
                    emit("status", detail=f"Running {short_tool_name(str(block.get('name')))}…")
                    texts.clear()  # only the words after the last tool call are the reply
                elif block.get("type") == "text" and block.get("text"):
                    texts.append(str(block["text"]))
        elif kind == "result":
            result = event

    try:
        process.wait(timeout=STOP_GRACE_SECONDS)
    except subprocess.TimeoutExpired:
        _stop(process)
    history_out: list[Any] = [{"claudeCodeSession": session}] if session else list(history)

    if aborted:
        usage = usage_of(result) if result else usage_of({})
        return {
            "text": STOPPED_NOTICE,
            "history": history_out,
            "usage": usage,
            "aborted": True,
            "outOfSteps": False,
        }
    if result is None:
        raise ChatError(explain_failure("".join(stderr_parts), process.returncode))

    usage = usage_of(result)
    subtype = result.get("subtype")
    reply = _reply_text(result, texts)
    if subtype == "error_max_turns":
        return {
            "text": reply or OUT_OF_STEPS_NOTICE,
            "history": history_out,
            "usage": usage,
            "aborted": False,
            "outOfSteps": True,
        }
    if result.get("is_error") or (subtype and subtype != "success"):
        detail = reply or str(subtype)
        raise ChatError(f"Claude Code reported an error: {detail[:500]}")
    return {"text": reply, "history": history_out, "usage": usage, "aborted": False, "outOfSteps": False}
