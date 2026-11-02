"""The Story Editor's one model call, with the chat's provider (PLAN.md, "Phase 6d").

- Gemini: rough-cut-studio's `generate_story_script`, verbatim apart from its transport helpers, which
  are the chat's (agent/gemini_client.py: the same retry and messages). The story is the chat's tier
  (Flash unless the chat is on Pro), thinking hard; a key without Pro gets Flash, said through
  `on_fallback` (model migration v2).
- Claude (subscription), Phase 7e: the same system instruction and user turn through the user's own
  Claude Code (agent/claude_code_json.py, `--json-schema`, the schema converted by
  claude_schema.strict_schema), with no key, so the reply is JSON of the same shape.

`gemini_json` and `claude_code_json_answer` are the general calls (any system, user text and schema);
the first pass over long footage (extract.py), the titler and the critic use them too. All return the parsed
response dict, or raise StoryModelError. The user turn is text, or (Phase 14b, the critic) Gemini-shaped
parts (`{"text"}` / `{"inline_data": {mime_type, data}}`) with images, which each call converts.
"""

from __future__ import annotations

import json
from collections.abc import Callable
from typing import Any

import requests

from vibecut_agent.agent import claude_code_json
from vibecut_agent.agent.claude_schema import strict_schema, to_claude_content
from vibecut_agent.agent.gemini_client import (
    FALLBACK_MODELS,
    FLASH_MODEL,
    GEMINI_ENDPOINT,
    MAX_ATTEMPTS,
    RETRYABLE_STATUSES,
    OnRetry,
    _overload_message,
    _scrub_secret,
    _wait_before_retry,
    fallback_notice,
    generation_config,
)
from vibecut_agent.agent.redact import scrub
from vibecut_agent.story.prompt import STORY_RESPONSE_SCHEMA, STORY_SYSTEM_INSTRUCTION, user_content

# Gemini's default is the fast tier, as for the chat; the story thinks hard on it (`gemini_story`), and a
# chat set to Gemini Pro passes that tier.
GEMINI_DEFAULT_MODEL = FLASH_MODEL
GEMINI_TIMEOUT_SECONDS = 180
# Claude (subscription) through Claude Code (Phase 7e): the chat's two models.
CLAUDE_CODE_MODELS = ("claude-opus-5-5", "claude-sonnet-5-5")
CLAUDE_CODE_DEFAULT_MODEL = "claude-sonnet-5-5"


# The user turn: plain text, or Gemini-shaped parts that may carry images.
UserTurn = str | list[dict[str, Any]]


class StoryModelError(Exception):
    """The model couldn't give a story cut."""


def gemini_user_parts(user: UserTurn) -> list[dict[str, Any]]:
    return [{"text": user}] if isinstance(user, str) else user


def claude_user_content(user: UserTurn) -> str | list[dict[str, Any]]:
    return user if isinstance(user, str) else to_claude_content(user)


def gemini_json(
    api_key: str,
    system: str,
    user_text: UserTurn,
    schema: dict[str, Any],
    model: str | None = None,
    on_retry: OnRetry = None,
    temperature: float = 0.4,
    effort: str | None = None,
    on_fallback: Callable[[str], None] | None = None,
) -> dict[str, Any]:
    """One schema-constrained generateContent call (rough-cut-studio's generate_story_script's
    transport), answered as a parsed dict. `schema` is in Gemini's dialect. `effort` is the thinking
    level (Gemini 3). A model the key can't reach (HTTP 404) is tried once on the next one down
    (gemini_client.FALLBACK_MODELS), and `on_fallback` is told why."""
    if not api_key or not api_key.strip():
        raise StoryModelError("No Gemini API key was provided.")
    chosen = model or GEMINI_DEFAULT_MODEL
    while True:
        try:
            return _gemini_json_once(
                api_key, system, user_text, schema, chosen, on_retry, temperature, effort
            )
        except _ModelUnavailable:
            fallback = FALLBACK_MODELS.get(chosen)
            if not fallback:
                raise StoryModelError(
                    f"Gemini API returned HTTP 404: {chosen} isn't available on this key."
                ) from None
            if on_fallback:
                on_fallback(fallback_notice(chosen, fallback))
            chosen = fallback


class _ModelUnavailable(StoryModelError):
    pass


def _gemini_json_once(
    api_key: str,
    system: str,
    user_text: UserTurn,
    schema: dict[str, Any],
    model: str,
    on_retry: OnRetry,
    temperature: float,
    effort: str | None,
) -> dict[str, Any]:
    body = {
        "systemInstruction": {"parts": [{"text": system}]},
        "contents": [{"role": "user", "parts": gemini_user_parts(user_text)}],
        "generationConfig": {
            "responseMimeType": "application/json",
            "responseSchema": schema,
            **generation_config(model, effort, temperature),
        },
    }
    url = GEMINI_ENDPOINT.format(model=model)
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
        if resp.status_code == 404:
            raise _ModelUnavailable(f"Gemini API returned HTTP 404 for {model}")
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
    on_fallback: Callable[[str], None] | None = None,
) -> dict[str, Any]:
    """rough-cut-studio's generate_story_script: one schema-constrained generateContent call, on the
    chat's tier (`model`; Flash when None), thinking hard."""
    return gemini_json(
        api_key,
        STORY_SYSTEM_INSTRUCTION,
        user_content(prompt, sources, catalog, target_seconds),
        STORY_RESPONSE_SCHEMA,
        model,
        on_retry,
        effort="high",
        on_fallback=on_fallback,
    )


def claude_code_json_answer(
    setup: Any,
    system: str,
    user_text: UserTurn,
    schema: dict[str, Any],
    model: str | None = None,
    effort: str = "high",
    should_abort: Callable[[], bool] = lambda: False,
) -> dict[str, Any]:
    """One answer from the user's own Claude Code (Claude subscription, no key; Phase 7e). `schema` is
    in Gemini's dialect and converted with claude_schema.strict_schema."""
    chosen = model if model in CLAUDE_CODE_MODELS else CLAUDE_CODE_DEFAULT_MODEL
    try:
        return claude_code_json.run_json(
            setup,
            chosen,
            system,
            claude_user_content(user_text),
            strict_schema(schema),
            effort=effort,
            should_abort=should_abort,
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
