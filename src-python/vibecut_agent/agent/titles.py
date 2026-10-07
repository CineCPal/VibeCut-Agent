"""The ``chat-title`` sidecar command (PLAN.md, "Phase 8d"): a short name for a chat, written by the
chat's own model after its first answer, for the History list. ``python -u -m vibecut_agent chat-title``,
one JSON request on stdin.

request: {
    "provider": "gemini" | "claude" | "claude-code"   (optional, "gemini" when absent; the chat's),
    "model": str                                      (optional; the chat's),
    "apiKey": str                                     (injected by Rust; not for "claude-code"),
    "claudeCode": {...}                               (injected by Rust for "claude-code"),
    "request": str                                    (the first message, without the timeline snapshot),
    "reply": str                                      (optional; the first answer)
}

One small schema-constrained call through story/models.py's general helpers, at low effort. Events:
starting, result {title}, error, done. The key is registered with redact.py and never appears in an event.
"""

from __future__ import annotations

import re
from typing import Any, TextIO

from vibecut_agent.agent.chat import provider_of
from vibecut_agent.agent.redact import register_secret, scrub
from vibecut_agent.protocol import CancelFlag, Emitter, RequestError, read_request

TITLE_CHARS = 60
REQUEST_CHARS = 2000
REPLY_CHARS = 2000
WHO = {"gemini": "Gemini", "claude": "Claude", "claude-code": "Claude (subscription)"}
CLAUDE_MAX_TOKENS = 1024

TITLE_SCHEMA: dict[str, Any] = {
    "type": "OBJECT",
    "properties": {"title": {"type": "STRING", "description": "The chat's name: 2 to 6 words."}},
    "required": ["title"],
}

SYSTEM = (
    "You name conversations between a video editor and their editing assistant, for a list of past "
    "chats. Give a name of 2 to 6 words that says what the editor asked for, like a file name a person "
    "would choose: specific (the project, the clips, the task), plain, no quotes, no trailing full stop, "
    "no emoji, and not starting with 'Chat' or 'Conversation'. Write it in the language the editor used."
)


def clean_title(raw: Any) -> str:
    """One line of at most TITLE_CHARS, without wrapping quotes or a trailing full stop; "" if unusable."""
    if not isinstance(raw, str):
        return ""
    text = " ".join(raw.split())
    text = text.strip(" \"'“”‘’`*#")
    text = re.sub(r"[.。]+$", "", text).strip()
    if len(text) > TITLE_CHARS:
        text = text[: TITLE_CHARS - 1].rstrip() + "…"
    return text


def user_text(request_text: str, reply: str) -> str:
    parts = [f"The editor asked:\n{request_text[:REQUEST_CHARS]}"]
    if reply.strip():
        parts.append(f"The assistant answered:\n{reply[:REPLY_CHARS]}")
    return "\n\n".join(parts)


def run(request: dict[str, Any], emitter: Emitter, cancel: CancelFlag | None = None) -> int:
    from vibecut_agent.story.models import StoryModelError, claude_code_json_answer, claude_json, gemini_json

    register_secret(request.get("apiKey"))
    provider = provider_of(request)
    api_key = (request.get("apiKey") or "").strip()
    if provider == "claude-code":
        if not isinstance(request.get("claudeCode"), dict):
            raise RequestError("Claude Code isn't set up. See Settings → Claude subscription.")
    elif not api_key:
        raise RequestError(f"No {WHO[provider]} API key was provided.")
    first = request.get("request")
    if not isinstance(first, str) or not first.strip():
        raise RequestError("Give the first message to name the chat after (request)")
    raw_reply = request.get("reply")
    reply = raw_reply if isinstance(raw_reply, str) else ""
    model = request.get("model") or None
    text = user_text(first.strip(), reply)
    should_abort = cancel.is_set if cancel else (lambda: False)
    try:
        if provider == "claude-code":
            answer = claude_code_json_answer(
                request.get("claudeCode"), SYSTEM, text, TITLE_SCHEMA, model, effort="low", should_abort=should_abort
            )
        elif provider == "claude":
            answer = claude_json(
                api_key, SYSTEM, text, TITLE_SCHEMA, model, should_abort=should_abort, effort="low",
                max_tokens=CLAUDE_MAX_TOKENS,
            )
        else:
            answer = gemini_json(api_key, SYSTEM, text, TITLE_SCHEMA, model, temperature=0.2)
    except StoryModelError as e:
        emitter.error(scrub(e, api_key))
        return 1
    title = clean_title(answer.get("title") if isinstance(answer, dict) else None)
    if not title:
        emitter.error(f"{WHO[provider]} didn't give a usable name")
        return 1
    emitter.emit("result", title=title)
    return 0


def main(stdin: TextIO, emitter: Emitter) -> int:
    cancel = CancelFlag()
    cancel.install_sigterm_handler()
    emitter.emit("starting", tool="chat-title", command="chat-title")
    try:
        code = run(read_request(stdin), emitter, cancel)
    except RequestError as exc:
        emitter.error(scrub(exc))
        code = 2
    emitter.emit("done", cancelled=cancel.is_set())
    return code
