"""The `assemble` sidecar command (PLAN.md, "Phase 6d"): the Story Editor, from VibeCut's
rough-cut-studio headless.py `run_assemble`. ``python -u -m vibecut_agent assemble``, one JSON request
on stdin.

request: {
    "sources": [{"sourceId": str, "segments": [{"start", "end", "text", "speaker"}, ...]}, ...],
    "media": {sourceId: absolute video path}   (optional; names each cut after its video),
    "fps": 25,
    "provider": "gemini" | "claude" | "claude-code"   (optional, "gemini" when absent; the chat's),
    "model": str                               (optional),
    "apiKey": str                              (injected by Rust, sidecar.rs `prepare_request`; not for
                                                "claude-code"),
    "claudeCode": {...}                        (injected by Rust for "claude-code": claude_code.rs),
    "extraction": "same" | "gemini"            (optional, Phase 7e: the model of the first pass over
                                                long footage; "same" is the story's provider, on
                                                Sonnet or Gemini Flash),
    "extractionKey": str                       (injected by Rust for "gemini": its key, when one is set),
    "prompt": str, "sequenceName": str,
    "targetDuration": "90" | "2 minutes" | "1:30"   (optional),
    "brollCatalog": [{"brollId", "path", "durationSeconds", "caption", "tags", "technicalScore"}, ...]
        (optional; no B-roll when empty)
}

Above extract.SINGLE_PASS_LIMIT transcript lines, a first pass reads every line in parts and shortlists
the strongest moments before the story call (extract.py, Phase 7e).

Events: starting, status {phase, detail}, retry {attempt, maxAttempts, waitSeconds, reason},
result {sequenceName, narrativeSummary, resolvedSegments, media, duration, warnings, files}, error, done.
The key is registered with redact.py as it arrives and never appears in an event.
"""

from __future__ import annotations

import os
from typing import Any, TextIO

from vibecut_agent.agent.chat import provider_of
from vibecut_agent.agent.redact import register_secret, scrub
from vibecut_agent.protocol import CancelFlag, Emitter, RequestError, read_request, require_absolute_paths
from vibecut_agent.story import extract
from vibecut_agent.story.assemble import Story, parse_duration_string
from vibecut_agent.story.models import (
    StoryModelError,
    claude_code_json_answer,
    claude_code_story,
    claude_json,
    claude_story,
    gemini_json,
    gemini_story,
)

TOOL = "story-editor"
WHO = {"gemini": "Gemini", "claude": "Claude", "claude-code": "Claude (subscription)"}
# The first pass's models: quicker and lighter on a plan's limits than the story's.
EXTRACT_CLAUDE_MODEL = "claude-sonnet-5-5"
EXTRACT_GEMINI_MODEL = "gemini-flash-latest"


def extraction_asker(
    request: dict[str, Any], provider: str, api_key: str, should_abort: Any, on_retry: Any
) -> tuple[extract.Ask, str]:
    """How the first pass asks its model, and who that is."""
    choice = request.get("extraction") or "same"
    if choice not in ("same", "gemini"):
        raise RequestError(f"Unknown first-pass model {choice!r}")
    if choice == "gemini" or provider == "gemini":
        key = (
            api_key
            if provider == "gemini" and choice == "same"
            else (request.get("extractionKey") or "").strip()
        )
        if not key:
            raise StoryModelError(
                "The first pass over this much footage is set to Gemini, but no Gemini API key is set. Add one in "
                "Settings → API keys, or set the first pass to the story's own model."
            )
        register_secret(key)
        return (
            lambda system, text, schema: gemini_json(
                key, system, text, schema, EXTRACT_GEMINI_MODEL, on_retry
            )
        ), "Gemini Flash"
    if provider == "claude-code":
        setup = request.get("claudeCode")
        return (
            lambda system, text, schema: claude_code_json_answer(
                setup, system, text, schema, EXTRACT_CLAUDE_MODEL, effort="medium", should_abort=should_abort
            )
        ), "Claude Sonnet (subscription)"
    return (
        lambda system, text, schema: claude_json(
            api_key,
            system,
            text,
            schema,
            EXTRACT_CLAUDE_MODEL,
            on_retry,
            should_abort,
            effort="medium",
            max_tokens=16000,
        )
    ), "Claude Sonnet"


def _catalog(raw: Any) -> list[dict[str, Any]]:
    """run_assemble's brollCatalog checks, as the snake_case entries the prompt and resolver read."""
    if raw is None:
        return []
    if not isinstance(raw, list):
        raise RequestError("brollCatalog must be a list")
    catalog = []
    for i, item in enumerate(raw):
        if not isinstance(item, dict):
            raise RequestError(f"brollCatalog[{i}] must be an object")
        broll_id, path, duration = item.get("brollId"), item.get("path"), item.get("durationSeconds")
        if not isinstance(broll_id, str) or not broll_id:
            raise RequestError(f"brollCatalog[{i}].brollId must be text")
        require_absolute_paths([path], "B-roll clip")
        if not isinstance(path, str) or not os.path.isfile(path):
            raise RequestError(f"brollCatalog[{i}].path is not a file: {path!r}")
        if not isinstance(duration, (int, float)) or isinstance(duration, bool) or duration <= 0:
            raise RequestError(f"brollCatalog[{i}].durationSeconds must be a positive number")
        tags, score, caption = item.get("tags"), item.get("technicalScore"), item.get("caption")
        catalog.append(
            {
                "broll_id": broll_id,
                "path": path,
                "duration_seconds": float(duration),
                "caption": caption if isinstance(caption, str) and caption else None,
                "tags": [t for t in tags if isinstance(t, str)] if isinstance(tags, list) else [],
                "technical_score": score
                if isinstance(score, (int, float)) and not isinstance(score, bool)
                else None,
            }
        )
    return catalog


def run(request: dict[str, Any], emitter: Emitter, cancel: CancelFlag | None = None) -> int:
    register_secret(request.get("apiKey"))
    register_secret(request.get("extractionKey"))
    provider = provider_of(request)
    api_key = (request.get("apiKey") or "").strip()
    if provider == "claude-code":
        if not isinstance(request.get("claudeCode"), dict):
            raise RequestError("Claude Code isn't set up. See Settings → Claude subscription.")
    elif not api_key:
        raise RequestError(f"No {WHO[provider]} API key was provided.")
    prompt = request.get("prompt")
    if not isinstance(prompt, str) or not prompt.strip():
        raise RequestError("Give the Story Editor a brief (prompt)")
    sources = request.get("sources")
    if not isinstance(sources, list) or not sources:
        raise RequestError("No transcripts were given to assemble from")
    media = request.get("media") or {}
    if not isinstance(media, dict):
        raise RequestError("media must map source ids to video paths")
    require_absolute_paths(list(media.values()), "video")
    catalog = _catalog(request.get("brollCatalog"))
    try:
        target_seconds = parse_duration_string(request.get("targetDuration") or None)
    except ValueError as e:
        raise RequestError(str(e)) from None
    sequence_name = request.get("sequenceName")
    sequence_name = (
        sequence_name.strip() if isinstance(sequence_name, str) and sequence_name.strip() else "Story Cut"
    )

    story = Story(request.get("fps") or 25.0)
    story.media_paths.update({k: v for k, v in media.items() if isinstance(k, str) and isinstance(v, str)})
    emitter.emit("status", phase="reading", detail="Reading transcripts")
    if not story.load_sources(sources):
        raise RequestError("None of the transcripts had a usable line")

    def on_retry(attempt: int, max_attempts: int, wait_seconds: float, reason: str) -> None:
        emitter.emit(
            "retry",
            attempt=attempt,
            maxAttempts=max_attempts,
            waitSeconds=round(wait_seconds, 1),
            reason=reason,
        )

    model = request.get("model") if isinstance(request.get("model"), str) else None
    who = WHO[provider]
    should_abort = cancel.is_set if cancel else lambda: False
    sources = story.prompt_sources()
    brief = prompt
    first_pass_note: str | None = None
    try:
        if extract.needs_first_pass(sources):
            ask, reader = extraction_asker(request, provider, api_key, should_abort, on_retry)
            lines = extract.line_count(sources)

            def progress(done: int, total: int) -> None:
                emitter.emit(
                    "status",
                    phase="extracting",
                    detail=f"First pass with {reader}: {done} of {total} part(s) of {lines} lines",
                )

            sources, notes = extract.first_pass(prompt, sources, target_seconds, ask, should_abort, progress)
            brief = f"{prompt.strip()}\n\n{notes}"
            first_pass_note = (
                f"{lines} transcript lines were too many for one read: {reader} read them all first and "
                f"shortlisted {extract.line_count(sources)} for the story."
            )
        emitter.emit("status", phase="generating", detail=f"Waiting for {who}")
        if provider == "claude-code":
            raw = claude_code_story(
                request.get("claudeCode"), brief, sources, catalog, target_seconds, model, should_abort
            )
        elif provider == "claude":
            raw = claude_story(
                api_key, brief, sources, catalog, target_seconds, model, on_retry, should_abort=should_abort
            )
        else:
            raw = gemini_story(api_key, brief, sources, catalog, target_seconds, model, on_retry)
        result = story.result(raw, catalog, sequence_name, target_seconds)
    except extract.ExtractionStopped:
        emitter.error("Stopped")
        return 1
    except (StoryModelError, ValueError) as e:
        emitter.error(scrub(e, api_key))
        return 1
    if first_pass_note:
        result["warnings"] = [first_pass_note, *result.get("warnings", [])]
    emitter.emit("result", **result)
    return 0


def main(stdin: TextIO, emitter: Emitter) -> int:
    cancel = CancelFlag()
    cancel.install_sigterm_handler()
    emitter.emit("starting", tool=TOOL, command="assemble")
    try:
        code = run(read_request(stdin), emitter, cancel)
    except RequestError as exc:
        emitter.error(scrub(exc))
        code = 2
    emitter.emit("done", cancelled=cancel.is_set())
    return code
