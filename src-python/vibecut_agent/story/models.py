"""The Story Editor's one model call, with the chat's provider (PLAN.md, "Phase 6d").

- Gemini: rough-cut-studio's `generate_story_script`, verbatim apart from its transport helpers, which
  are the chat's (agent/gemini_client.py: the same retry and messages).
- Claude (new here; VibeCut's Story Editor was Gemini-only): the same system instruction and user turn,
  answered through structured outputs (`output_config.format`, the schema converted by
  claude_schema.strict_schema), so the reply is JSON of the same shape. It goes through the chat's
  `claude_client.send`: streamed, retried, refusal fallback on, the key scrubbed from every error.
- Claude (subscription), Phase 7e: the same again through the user's own Claude Code
  (agent/claude_code_json.py, `--json-schema`), with no key.

`gemini_json`, `claude_json` and `claude_code_json_answer` are the general calls (any system, user text
and schema); the first pass over long footage (extract.py) uses them too. All return the parsed
response dict, or raise StoryModelError.
"""

from __future__ import annotations

import json
from collections.abc import Callable
from typing import Any

import requests

from vibecut_agent.agent import claude_client, claude_code_json
from vibecut_agent.agent.claude_schema import strict_schema
from vibecut_agent.agent.gemini_client import (
    GEMINI_ENDPOINT,
    MAX_ATTEMPTS,
    RETRYABLE_STATUSES,
    OnRetry,
    _overload_message,
    _scrub_secret,
    _wait_before_retry,
)
from vibecut_agent.agent.redact import scrub
from vibecut_agent.story.prompt import STORY_RESPONSE_SCHEMA, STORY_SYSTEM_INSTRUCTION, user_content

GEMINI_DEFAULT_MODEL = "gemini-flash-latest"
GEMINI_TIMEOUT_SECONDS = 90
# A story cut over long interviews is one large answer; Claude streams it.
CLAUDE_MAX_TOKENS = 64000
CLAUDE_TIMEOUT_SECONDS = 300
# Claude (subscription) through Claude Code (Phase 7e): the chat's two models.
CLAUDE_CODE_MODELS = ("claude-opus-5-5", "claude-sonnet-5-5")
CLAUDE_CODE_DEFAULT_MODEL = "claude-sonnet-5-5"


class StoryModelError(Exception):
    """The model couldn't give a story cut."""


def gemini_json(
    api_key: str,
    system: str,
    user_text: str,
    schema: dict[str, Any],
    model: str | None = None,
    on_retry: OnRetry = None,
    temperature: float = 0.4,
) -> dict[str, Any]:
    """One schema-constrained generateContent call (rough-cut-studio's generate_story_script's
    transport), answered as a parsed dict. `schema` is in Gemini's dialect."""
    if not api_key or not api_key.strip():
        raise StoryModelError("No Gemini API key was provided.")
    body = {
        "systemInstruction": {"parts": [{"text": system}]},
        "contents": [{"role": "user", "parts": [{"text": user_text}]}],
        "generationConfig": {
            "responseMimeType": "application/json",
            "responseSchema": schema,
            "temperature": temperature,
        },
    }
    url = GEMINI_ENDPOINT.format(model=model or GEMINI_DEFAULT_MODEL)
    last_error: StoryModelError | None = None
    for attempt in range(1, MAX_ATTEMPTS + 1):
        try:
            resp = requests.post(
                url,
                headers={"Content-Type": "application/json", "x-goog-api-key": api_key},
                data=json.dumps(body),
                timeout=GEMINI_TIMEOUT_SECONDS,
            )
        except requests.RequestException as e:
            last_error = StoryModelError(f"Network error calling Gemini API: {_scrub_secret(e, api_key)}")
            if attempt < MAX_ATTEMPTS:
                _wait_before_retry(attempt, on_retry, reason="network error")
                continue
            raise last_error from e
        if resp.status_code in RETRYABLE_STATUSES:
            last_error = StoryModelError(_overload_message(resp))
            if attempt < MAX_ATTEMPTS:
                _wait_before_retry(attempt, on_retry, reason=f"HTTP {resp.status_code}")
                continue
            raise last_error
        if resp.status_code != 200:
            raise StoryModelError(
                f"Gemini API returned HTTP {resp.status_code}: {scrub(resp.text, api_key)[:500]}"
            )
        data = resp.json()
        try:
            text = "".join(p.get("text", "") for p in data["candidates"][0]["content"]["parts"])
        except (KeyError, IndexError, TypeError) as e:
            raise StoryModelError(f"Unexpected Gemini response shape: {scrub(data, api_key)[:500]}") from e
        return _parsed(text, "Gemini")
    raise last_error or StoryModelError("Gemini API request failed for an unknown reason.")


def gemini_story(
    api_key: str,
    prompt: str,
    sources: list[dict[str, Any]],
    catalog: list[dict[str, Any]],
    target_seconds: float | None,
    model: str | None = None,
    on_retry: OnRetry = None,
) -> dict[str, Any]:
    """rough-cut-studio's generate_story_script: one schema-constrained generateContent call."""
    return gemini_json(
        api_key,
        STORY_SYSTEM_INSTRUCTION,
        user_content(prompt, sources, catalog, target_seconds),
        STORY_RESPONSE_SCHEMA,
        model,
        on_retry,
    )


def claude_json(
    api_key: str,
    system: str,
    user_text: str,
    schema: dict[str, Any],
    model: str | None = None,
    on_retry: OnRetry = None,
    should_abort: Callable[[], bool] = lambda: False,
    effort: str = "high",
    max_tokens: int = CLAUDE_MAX_TOKENS,
) -> dict[str, Any]:
    """One Claude answer through structured outputs, parsed. `schema` is in Gemini's dialect and is
    converted with claude_schema.strict_schema."""
    chosen = claude_client.resolve_model(model)
    params: dict[str, Any] = {
        "model": chosen,
        "max_tokens": max_tokens,
        "system": system,
        "messages": [{"role": "user", "content": user_text}],
        "output_config": {
            "effort": effort,
            "format": {"type": "json_schema", "schema": strict_schema(schema)},
        },
        "betas": [claude_client.FALLBACK_BETA],
        "fallbacks": "default",
    }
    try:
        message = claude_client.send(
            api_key, params, timeout=CLAUDE_TIMEOUT_SECONDS, on_retry=on_retry, should_abort=should_abort
        )
    except claude_client.ClaudeError as e:
        raise StoryModelError(str(e)) from None
    if message is None:
        raise StoryModelError("Stopped")
    reason = message.get("stop_reason")
    if reason == "refusal":
        raise StoryModelError(
            "Claude declined to cut this story. Try rewording the brief, or switch to Gemini."
        )
    if reason == "max_tokens":
        raise StoryModelError(
            "Claude's answer was cut off (too long). Try fewer interviews or a shorter target."
        )
    return _parsed(claude_client.text_of(message), "Claude")


def claude_story(
    api_key: str,
    prompt: str,
    sources: list[dict[str, Any]],
    catalog: list[dict[str, Any]],
    target_seconds: float | None,
    model: str | None = None,
    on_retry: OnRetry = None,
    should_abort: Callable[[], bool] = lambda: False,
) -> dict[str, Any]:
    """The same brief to Claude, answered as JSON matching the story schema."""
    # Choosing and ordering a story from a whole interview set is the hard reasoning here.
    return claude_json(
        api_key,
        STORY_SYSTEM_INSTRUCTION,
        user_content(prompt, sources, catalog, target_seconds),
        STORY_RESPONSE_SCHEMA,
        model,
        on_retry,
        should_abort,
        effort="high",
    )


def claude_code_json_answer(
    setup: Any,
    system: str,
    user_text: str,
    schema: dict[str, Any],
    model: str | None = None,
    effort: str = "high",
    should_abort: Callable[[], bool] = lambda: False,
) -> dict[str, Any]:
    """One answer from the user's own Claude Code (Claude subscription, no key; Phase 7e). `schema` is
    in Gemini's dialect and converted with claude_schema.strict_schema, as for the API."""
    chosen = model if model in CLAUDE_CODE_MODELS else CLAUDE_CODE_DEFAULT_MODEL
    try:
        return claude_code_json.run_json(
            setup, chosen, system, user_text, strict_schema(schema), effort=effort, should_abort=should_abort
        )
    except claude_code_json.ClaudeCodeJsonError as e:
        raise StoryModelError(str(e)) from None


def claude_code_story(
    setup: Any,
    prompt: str,
    sources: list[dict[str, Any]],
    catalog: list[dict[str, Any]],
    target_seconds: float | None,
    model: str | None = None,
    should_abort: Callable[[], bool] = lambda: False,
) -> dict[str, Any]:
    """The same brief to Claude through Claude Code, answered as JSON matching the story schema."""
    return claude_code_json_answer(
        setup,
        STORY_SYSTEM_INSTRUCTION,
        user_content(prompt, sources, catalog, target_seconds),
        STORY_RESPONSE_SCHEMA,
        model,
        effort="high",
        should_abort=should_abort,
    )


def _parsed(text: str, who: str) -> dict[str, Any]:
    try:
        parsed = json.loads(text)
    except json.JSONDecodeError as e:
        raise StoryModelError(f"{who} did not return valid JSON: {e}. Raw: {scrub(text)[:500]}") from e
    if not isinstance(parsed, dict):
        raise StoryModelError(f"{who} returned {type(parsed).__name__}, not a story cut")
    return parsed
