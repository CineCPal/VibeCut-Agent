"""antigravity_json.py

One schema-constrained answer from the user's own signed-in Antigravity CLI (``agy -p --json-schema``),
for the chat's name and the Story Editor on Gemini (subscription) (PLAN.md, "Phase 17"). Like the chat
on it (antigravity_chat.py), it uses the user's Google AI plan and needs no API key.

What runs comes from Rust (antigravity.rs) as the request's ``antigravity``: the program and a working
folder. The run gets its own agent (system instruction as its body, no built-in tool but ``finish``) and
no caller tag, so VibeCut's MCP shim refuses it as an outside caller. A JSON run has no business calling
a tool, so any tool step but ``finish`` stops it. agy gives the schema-checked object as the result's
``structured_output`` (checked live on 1.2.1).

The user turn is text only: agy's stream-json input takes text blocks only, so a turn with images (the
critic's stills) is refused.
"""

from __future__ import annotations

import json
import os
import queue
import subprocess
import time
from collections.abc import Callable
from typing import Any

from vibecut_agent.agent import antigravity_chat as agy
from vibecut_agent.agent.chat_steps import ChatError

DEFAULT_TIMEOUT_SECONDS = 15 * 60


class AntigravityJsonError(Exception):
    """Antigravity couldn't give the answer."""


def text_of(user: str | list[dict[str, Any]]) -> str:
    """A user turn as one text: Gemini-shaped parts joined, or AntigravityJsonError for any image."""
    if isinstance(user, str):
        return user
    texts = []
    for part in user:
        if not isinstance(part, dict):
            continue
        if part.get("inline_data"):
            raise AntigravityJsonError(
                "Gemini (subscription) can't look at stills: Antigravity's headless mode accepts text only. "
                "Choose Gemini Flash (with a key) or another model for this."
            )
        if isinstance(part.get("text"), str):
            texts.append(part["text"])
    return "\n\n".join(texts)


def answer_of(result: dict[str, Any]) -> dict[str, Any]:
    """The schema-checked object from agy's final ``result`` event, or AntigravityJsonError."""
    if result.get("status") != "SUCCESS":
        error = str(result.get("error") or result.get("status"))
        if agy.signed_out(error):
            raise AntigravityJsonError(agy.SIGNED_OUT_NOTE)
        raise AntigravityJsonError(f"Antigravity reported an error: {error[:500]}")
    structured = result.get("structured_output")
    if isinstance(structured, dict):
        return structured
    text = result.get("response")
    if isinstance(text, str):
        try:
            parsed = json.loads(text)
        except ValueError:
            parsed = None
        if isinstance(parsed, dict):
            return parsed
    raise AntigravityJsonError("Antigravity didn't return an answer that matched the schema.")


def run_json(
    setup: Any,
    model: str | None,
    system: str,
    user_text: str | list[dict[str, Any]],
    schema: dict[str, Any],
    effort: str | None = None,
    should_abort: Callable[[], bool] = lambda: False,
    timeout: float = DEFAULT_TIMEOUT_SECONDS,
    popen: agy.Popen = subprocess.Popen,
) -> dict[str, Any]:
    """Runs agy once and returns its schema-checked object. ``schema`` is plain JSON Schema
    (claude_schema.strict_schema converts the app's). Raises AntigravityJsonError, with "Stopped" when
    ``should_abort`` turned true first."""
    if not isinstance(setup, dict) or not isinstance(setup.get("program"), str) or not setup.get("workDir"):
        raise AntigravityJsonError("Antigravity isn't set up. See Settings → Gemini subscription.")
    text = text_of(user_text)
    os.makedirs(setup["workDir"], exist_ok=True)
    agent = agy.AgentFile(setup["workDir"], system)
    try:
        args = agy.build_args(setup, agy.resolve_model(model, effort), agent.name, json_schema=schema)
        try:
            running = agy.start(setup, args, caller=False, popen=popen)
        except ChatError as e:
            raise AntigravityJsonError(str(e)) from None
        running.send(agy.user_line(text))
        return _wait(running, agent.name, should_abort, timeout)
    finally:
        agent.remove()


def _wait(
    running: agy.Running, agent: str, should_abort: Callable[[], bool], timeout: float
) -> dict[str, Any]:
    process = running.process
    started = time.monotonic()
    checked = False
    result: dict[str, Any] | None = None
    while True:
        if should_abort():
            agy.stop(process)
            raise AntigravityJsonError("Stopped")
        if time.monotonic() - started > timeout:
            agy.stop(process)
            raise AntigravityJsonError(f"Antigravity didn't answer within {round(timeout / 60)} min.")
        if not checked and agy.signed_out(running.stderr):
            agy.stop(process)
            raise AntigravityJsonError(agy.SIGNED_OUT_NOTE)
        try:
            raw = running.lines.get(timeout=agy.POLL_SECONDS)
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
                agy.stop(process)
                raise AntigravityJsonError(
                    agy.LOCKDOWN_NOTE.format(
                        problem=f"it started as {started_as or 'its default agent'}, not VibeCut's"
                    )
                )
            checked = True
        elif kind == "result":
            result = event.get("result") if isinstance(event.get("result"), dict) else {}
        elif not checked:
            agy.stop(process)
            raise AntigravityJsonError(
                agy.LOCKDOWN_NOTE.format(problem="it didn't say which agent it runs before starting")
            )
        elif kind == "step_update":
            step = event.get("step_update") or {}
            if step.get("step_type") == "tool":
                name = str(step.get("tool_name") or "")
                if name != agy.FINISH_TOOL:
                    agy.stop(process)
                    raise AntigravityJsonError(
                        agy.LOCKDOWN_NOTE.format(
                            problem=f"it tried to use {name or 'a tool'} in a one-answer run"
                        )
                    )
    try:
        process.wait(timeout=agy.STOP_GRACE_SECONDS)
    except subprocess.TimeoutExpired:
        agy.stop(process)
    if result is None:
        raise AntigravityJsonError(agy.explain_failure(running.stderr, process.returncode))
    return answer_of(result)
