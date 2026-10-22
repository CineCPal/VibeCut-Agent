"""antigravity_chat.py

The chat agent on "Gemini (subscription)" (PLAN.md, "Phase 17"): each turn runs the user's own
signed-in Antigravity CLI (``agy -p``), so it uses their Google AI plan and needs no API key.

The same contract as gemini_chat/claude_code_chat.run_chat_turn (one user message in; ``status`` events
while it works; an outcome with text, history, usage, aborted and outOfSteps out). What's different,
all checked live on agy 1.2.1 (2026-10-17):

- Tool calls go through VibeCut's MCP shim (mcp_server.py), as on Claude (subscription). agy has no
  per-run MCP config, so the shim is registered once in the user's agy config under ``vibecut``
  (Settings → Gemini subscription, antigravity.rs). A stdio server inherits agy's environment, so
  ``VIBECUT_MCP_CALLER`` set on the ``agy`` process tags the shim's calls with this chat's job.
- agy has no ``--system-prompt``, ``--tools`` or ``--allowedTools``. Each run writes its own agent
  (``<workDir>/.agents/agents/vibecut-<id>.md``, read from the working folder): its body is the system
  instruction and its ``tools:`` is just ``finish``, which leaves agy no shell, file, browser or web
  tool. MCP tools stay available (that list names built-ins only). The agent file is removed after.
- agy's startup event lists every built-in tool whatever the agent allows, so the lockdown can't be
  checked there as Claude Code's is. Instead the run must start on VibeCut's agent, and any tool step
  that isn't one of VibeCut's MCP tools (``mcp_vibecut_*``) or ``finish`` stops it at once.
- ``--conversation`` resumes a conversation without the model seeing its earlier turns, so the app
  keeps the history: ``[{"role": "user"|"model", "text", "tools"?}, ...]``, two entries a turn, sent
  in with each message. Retry and Edit cut it like the API providers' histories.
- There's no ``--max-turns``: the tool steps are counted here and the run is stopped past the limit.
- A user line takes text blocks only, so attached images are refused with a clear message.
- Signed out, agy prints a sign-in link on stderr and waits; the run is stopped at once and the user is
  told to sign in.
"""

from __future__ import annotations

import json
import os
import queue
import signal
import subprocess
import threading
import uuid
from collections.abc import Callable
from typing import Any

from vibecut_agent.agent.chat_steps import DEFAULT_MAX_STEPS, OUT_OF_STEPS_NOTICE, STOPPED_NOTICE, ChatError
from vibecut_agent.agent.streaming import ReplyStream

SERVER_NAME = "vibecut"
TOOL_PREFIX = f"mcp_{SERVER_NAME}_"
# The one built-in a VibeCut agent keeps: agy's own way of ending a run.
FINISH_TOOL = "finish"
# The chat's Gemini families; Settings' effort picks the variant (``-low``, ``-medium``, ``-high``).
MODELS = ("gemini-4-argon", "gemini-3.8-flash")
DEFAULT_MODEL = "gemini-4-argon"
EFFORTS = ("low", "medium", "high")
DEFAULT_EFFORT = "medium"
# Anything that would make agy bill an API key or a Cloud project instead of the user's plan.
DROPPED_ENV = (
    "GEMINI_API_KEY",
    "GOOGLE_API_KEY",
    "GOOGLE_APPLICATION_CREDENTIALS",
    "GOOGLE_CLOUD_PROJECT",
    "GOOGLE_GENAI_USE_VERTEXAI",
    "AGY_ADC_AUTH",
)
CALLER_ENV = "VIBECUT_MCP_CALLER"
POLL_SECONDS = 0.2
# agy's own wait for a run. A change waiting for the user's review (Phase 11d) holds a tool call for up
# to 30 minutes, so a turn may take that long; Stop and the step limit end it sooner.
PRINT_TIMEOUT_SECONDS = 60 * 60
# After Stop: SIGINT (agy ends in about 0.4 s with "interrupted"), then SIGTERM, then SIGKILL.
STOP_GRACE_SECONDS = 5.0
STDERR_KEEP_CHARS = 4000
# The most of the earlier conversation sent with a message; the oldest entries are left out first.
HISTORY_CHARS = 60_000
SIGN_IN_MARKERS = ("authentication required", "authentication failed", "please sign in", "log back in")
SIGNED_OUT_NOTE = (
    "Antigravity isn't signed in. Run agy in Terminal and sign in with your Google account, then try again."
)
LOCKDOWN_NOTE = (
    "VibeCut stopped Antigravity: {problem}. Your agy version may have changed how VibeCut's agent "
    "lockdown works; please report it."
)

Popen = Callable[..., subprocess.Popen[bytes]]


def check_setup(setup: Any) -> dict[str, Any]:
    if not isinstance(setup, dict):
        raise ChatError("Antigravity isn't set up. See Settings → Gemini subscription.")
    for key in ("program", "jobId", "workDir"):
        if not isinstance(setup.get(key), str) or not setup[key]:
            raise ChatError(f"Antigravity's setup is missing {key}.")
    return setup


def resolve_model(model: str | None, effort: str | None) -> str:
    """The agy model id: the chosen family with Settings' effort (Claude's xhigh and max are high)."""
    family = model if model in MODELS else DEFAULT_MODEL
    level = effort if effort in EFFORTS else ("high" if effort in ("xhigh", "max") else DEFAULT_EFFORT)
    return f"{family}-{level}"


def agent_markdown(name: str, system_instruction: str) -> str:
    """A VibeCut agent for one run: no built-in tool but ``finish``; the system instruction is its body."""
    return (
        "---\n"
        f"name: {name}\n"
        "description: \"VibeCut Agent's editing assistant. It works only through VibeCut's tools.\"\n"
        "tools:\n"
        f"  - {FINISH_TOOL}\n"
        "mainAgent: true\n"
        "subagent: false\n"
        "---\n\n"
        f"{system_instruction.strip()}\n"
    )


class AgentFile:
    """Writes a run's agent into ``<workDir>/.agents/agents/`` and removes it when the run is over."""

    def __init__(self, work_dir: str, system_instruction: str) -> None:
        self.name = f"vibecut-{uuid.uuid4().hex[:12]}"
        folder = os.path.join(work_dir, ".agents", "agents")
        os.makedirs(folder, exist_ok=True)
        self.path = os.path.join(folder, f"{self.name}.md")
        with open(self.path, "w", encoding="utf-8") as f:
            f.write(agent_markdown(self.name, system_instruction))

    def remove(self) -> None:
        try:
            os.remove(self.path)
        except OSError:
            pass


def build_args(
    setup: dict[str, Any], model: str, agent: str, json_schema: dict[str, Any] | None = None
) -> list[str]:
    args = [
        setup["program"],
        # The message arrives as one stream-json user line on stdin; ``-p=`` keeps -p from taking the
        # next flag as its prompt.
        "-p=",
        "--input-format",
        "stream-json",
        "--output-format",
        "stream-json",
        "--model",
        model,
        "--agent",
        agent,
        "--disable-slash-commands",
        "--print-timeout",
        f"{PRINT_TIMEOUT_SECONDS}s",
    ]
    if json_schema is not None:
        args += ["--json-schema", json.dumps(json_schema)]
    return args


def child_env(
    setup: dict[str, Any], caller: bool = True, base: dict[str, str] | None = None
) -> dict[str, str]:
    env = dict(os.environ if base is None else base)
    for name in DROPPED_ENV:
        env.pop(name, None)
    env.pop(CALLER_ENV, None)
    if caller:
        env[CALLER_ENV] = setup["jobId"]
    return env


def user_line(text: str) -> bytes:
    """A message as agy reads it with ``--input-format stream-json``: ``event`` (not ``type``) and text
    blocks only."""
    line = {"event": "user", "message": {"role": "user", "content": [{"type": "text", "text": text}]}}
    return (json.dumps(line) + "\n").encode("utf-8")


def _entries(history: list[Any]) -> list[dict[str, Any]]:
    return [
        e
        for e in history
        if isinstance(e, dict) and e.get("role") in ("user", "model") and isinstance(e.get("text"), str)
    ]


def compose_message(history: list[Any], user_message: str, limit: int = HISTORY_CHARS) -> str:
    """The message agy gets: the conversation so far (newest kept first, up to ``limit`` characters),
    then the user's new message."""
    lines: list[str] = []
    used = 0
    entries = _entries(history)
    for entry in reversed(entries):
        if entry["role"] == "user":
            line = f"User: {entry['text'].strip()}"
        else:
            tools = entry.get("tools")
            used_tools = (
                f" (tools used: {', '.join(str(t) for t in tools)})"
                if isinstance(tools, list) and tools
                else ""
            )
            line = f"You{used_tools}: {entry['text'].strip()}"
        if used + len(line) > limit:
            lines.append("(Older messages are left out.)")
            break
        lines.append(line)
        used += len(line)
    if not lines:
        return user_message
    earlier = "\n\n".join(reversed(lines))
    return (
        "<earlier_conversation>\n"
        f"{earlier}\n"
        "</earlier_conversation>\n\n"
        "The conversation so far is above, for context; the timeline may have changed since. "
        "The user's new message:\n\n"
        f"{user_message}"
    )


def usage_of(result: dict[str, Any] | None) -> dict[str, Any]:
    raw = (result or {}).get("usage")
    usage: dict[str, Any] = raw if isinstance(raw, dict) else {}

    def n(key: str) -> int:
        value = usage.get(key)
        return int(value) if isinstance(value, (int, float)) and not isinstance(value, bool) else 0

    # agy's input_tokens leaves out what was read from its cache.
    cached = n("cache_read_tokens")
    return {
        "promptTokens": n("input_tokens") + cached,
        "cachedTokens": cached,
        "outputTokens": n("output_tokens"),
        "thoughtsTokens": n("thinking_tokens"),
        "steps": n("num_turns") if "num_turns" in usage else int((result or {}).get("num_turns") or 0),
    }


def signed_out(text: str) -> bool:
    lowered = text.lower()
    return any(marker in lowered for marker in SIGN_IN_MARKERS)


def explain_failure(stderr: str, code: int | None) -> str:
    if signed_out(stderr):
        return SIGNED_OUT_NOTE
    lowered = stderr.lower()
    if "quota" in lowered or "rate limit" in lowered or "resource exhausted" in lowered:
        return f"Antigravity hit your plan's usage limit: {stderr.strip()[-300:]}"
    tail = stderr.strip()[-500:] or f"it exited with code {code}"
    return f"Antigravity stopped without an answer: {tail}"


def tool_problem(name: str) -> str | None:
    """Why a tool step mustn't run in a VibeCut agent, or None."""
    if name == FINISH_TOOL or name.startswith(TOOL_PREFIX):
        return None
    return f"it tried to use {name}, which VibeCut doesn't allow"


def short_tool_name(name: str) -> str:
    return name.removeprefix(TOOL_PREFIX)


def stop(process: subprocess.Popen[bytes]) -> None:
    """SIGINT, then SIGTERM, then SIGKILL to agy, which ends the MCP server it started. It stays in the
    sidecar's process group, so the app's own cancel and quit reach it too."""
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


class Running:
    """A started ``agy -p``: its stdout lines queued as they come (None at the end), and the tail of its
    stderr."""

    def __init__(self, process: subprocess.Popen[bytes]) -> None:
        self.process = process
        self.lines: queue.Queue[bytes | None] = queue.Queue()
        self.stderr_parts: list[str] = []
        threading.Thread(target=self._pump_stdout, daemon=True).start()
        threading.Thread(target=self._pump_stderr, daemon=True).start()

    def _pump_stdout(self) -> None:
        assert self.process.stdout is not None
        for raw in self.process.stdout:
            self.lines.put(raw)
        self.lines.put(None)

    def _pump_stderr(self) -> None:
        assert self.process.stderr is not None
        for raw in self.process.stderr:
            self.stderr_parts.append(raw.decode("utf-8", "replace"))
            while sum(len(p) for p in self.stderr_parts) > STDERR_KEEP_CHARS and len(self.stderr_parts) > 1:
                self.stderr_parts.pop(0)

    @property
    def stderr(self) -> str:
        return "".join(self.stderr_parts)

    def send(self, line: bytes) -> None:
        try:
            assert self.process.stdin is not None
            self.process.stdin.write(line)
            self.process.stdin.close()
        except OSError:
            pass  # it died at once; reported from its exit


def start(setup: dict[str, Any], args: list[str], caller: bool, popen: Popen = subprocess.Popen) -> Running:
    try:
        process = popen(
            args,
            cwd=setup["workDir"],
            env=child_env(setup, caller=caller),
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )
    except OSError as exc:
        raise ChatError(f"Couldn't start Antigravity ({setup['program']}): {exc}") from None
    return Running(process)


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
    images: list[dict[str, str]] | None = None,
    effort: str | None = None,
) -> dict[str, Any]:
    """Runs one turn through agy, end to end. Raises ChatError when it can't."""
    setup = check_setup(setup)
    if not user_message or not user_message.strip():
        raise ChatError("The chat message was empty.")
    if images:
        raise ChatError(
            "Gemini (subscription) can't take images: Antigravity's headless mode accepts text only. "
            "Remove the attachment, or choose another model for this message."
        )
    resolved_model = resolve_model(model, effort)
    os.makedirs(setup["workDir"], exist_ok=True)
    agent = AgentFile(setup["workDir"], system_instruction)
    try:
        return _run(
            setup,
            resolved_model,
            agent.name,
            history,
            user_message,
            ReplyStream(emit),
            should_abort,
            max_iterations,
            popen,
        )
    finally:
        agent.remove()


def _run(
    setup: dict[str, Any],
    resolved_model: str,
    agent: str,
    history: list[Any],
    user_message: str,
    stream: ReplyStream,
    should_abort: Callable[[], bool],
    max_iterations: int,
    popen: Popen,
) -> dict[str, Any]:
    emit = stream.emit
    running = start(setup, build_args(setup, resolved_model, agent), caller=True, popen=popen)
    process = running.process
    running.send(user_line(compose_message(history, user_message)))
    emit("status", detail="Starting Antigravity…")

    texts: list[str] = []
    tools_used: list[str] = []
    seen_tool_steps: set[Any] = set()
    tool_steps = 0
    result: dict[str, Any] | None = None
    aborted = out_of_steps = checked = False
    while True:
        if not aborted and not out_of_steps and should_abort():
            aborted = True
            emit("status", detail="Stopping Antigravity…")
            stop(process)
        if not checked and signed_out(running.stderr):
            stop(process)
            raise ChatError(SIGNED_OUT_NOTE)
        try:
            raw = running.lines.get(timeout=POLL_SECONDS)
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
        kind = event.get("event")
        if kind == "init":
            started_as = (event.get("init") or {}).get("agent")
            if started_as != agent:
                stop(process)
                raise ChatError(
                    LOCKDOWN_NOTE.format(
                        problem=f"it started as {started_as or 'its default agent'}, not VibeCut's"
                    )
                )
            checked = True
            emit("status", detail=f"Calling Gemini ({resolved_model}) through Antigravity…")
        elif kind == "result":
            result = event.get("result") if isinstance(event.get("result"), dict) else {}
        elif not checked and not aborted:
            # Nothing may happen before the run has shown it's on VibeCut's agent.
            stop(process)
            raise ChatError(LOCKDOWN_NOTE.format(problem="it didn't say which agent it runs before starting"))
        elif kind == "step_update" and not aborted and not out_of_steps:
            step = event.get("step_update") or {}
            step_type = step.get("step_type")
            if step_type == "tool":
                name = str(step.get("tool_name") or (step.get("tool_info") or {}).get("name") or "")
                key = step.get("step_index")
                if key in seen_tool_steps:
                    continue
                seen_tool_steps.add(key)
                problem = tool_problem(name)
                if problem:
                    stop(process)
                    raise ChatError(LOCKDOWN_NOTE.format(problem=problem))
                if name == FINISH_TOOL:
                    continue
                tool_steps += 1
                if tool_steps > max_iterations:
                    out_of_steps = True
                    emit("status", detail="Out of steps; stopping Antigravity…")
                    stop(process)
                    continue
                stream.brk()
                texts.clear()  # only the words after the last tool call are the reply
                tools_used.append(short_tool_name(name))
                emit("status", detail=f"Running {short_tool_name(name)}…")
            elif step_type == "agent_response":
                delta = step.get("text_delta")
                if isinstance(delta, str) and delta:
                    stream.text(delta)
                    texts.append(delta)

    stream.flush()
    try:
        process.wait(timeout=STOP_GRACE_SECONDS)
    except subprocess.TimeoutExpired:
        stop(process)
    usage = usage_of(result)
    said = "".join(texts).strip()

    def outcome(text: str, **flags: bool) -> dict[str, Any]:
        turn = [
            {"role": "user", "text": user_message},
            {"role": "model", "text": text, **({"tools": tools_used} if tools_used else {})},
        ]
        return {
            "text": text,
            "history": [*_entries(history), *turn],
            "usage": usage,
            "aborted": flags.get("aborted", False),
            "outOfSteps": flags.get("outOfSteps", False),
        }

    if aborted:
        return outcome(STOPPED_NOTICE, aborted=True)
    if out_of_steps:
        return outcome(said or OUT_OF_STEPS_NOTICE, outOfSteps=True)
    if result is None:
        raise ChatError(explain_failure(running.stderr, process.returncode))
    if result.get("status") != "SUCCESS":
        error = str(result.get("error") or "")
        if signed_out(error):
            raise ChatError(SIGNED_OUT_NOTE)
        raise ChatError(f"Antigravity reported an error: {(error or str(result.get('status')))[:500]}")
    response = result.get("response")
    reply = response.strip() if isinstance(response, str) and response.strip() else said
    return outcome(reply)
