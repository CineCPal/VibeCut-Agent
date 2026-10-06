"""The `assemble` sidecar command (PLAN.md, "Phase 6d"): the Story Editor, from VibeCut's
rough-cut-studio headless.py `run_assemble`. ``python -u -m vibecut_agent assemble``, one JSON request
on stdin.

request: {
    "sources": [{"sourceId": str, "segments": [{"start", "end", "text", "speaker"}, ...]}, ...],
    "media": {sourceId: absolute video path}   (optional; names each cut after its video),
    "fps": 25,
    "provider": "gemini" | "claude"            (optional, "gemini" when absent; the chat's),
    "model": str                               (optional),
    "apiKey": str                              (injected by Rust, sidecar.rs `prepare_request`),
    "prompt": str, "sequenceName": str,
    "targetDuration": "90" | "2 minutes" | "1:30"   (optional),
    "brollCatalog": [{"brollId", "path", "durationSeconds", "caption", "tags", "technicalScore"}, ...]
        (optional; no B-roll when empty)
}

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
from vibecut_agent.story.assemble import Story, parse_duration_string
from vibecut_agent.story.models import StoryModelError, claude_story, gemini_story

TOOL = "story-editor"


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
    provider = provider_of(request)
    api_key = (request.get("apiKey") or "").strip()
    if not api_key:
        raise RequestError(f"No {'Claude' if provider == 'claude' else 'Gemini'} API key was provided.")
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
    who = "Claude" if provider == "claude" else "Gemini"
    emitter.emit("status", phase="generating", detail=f"Waiting for {who}")
    try:
        if provider == "claude":
            raw = claude_story(
                api_key,
                prompt,
                story.prompt_sources(),
                catalog,
                target_seconds,
                model,
                on_retry,
                should_abort=cancel.is_set if cancel else lambda: False,
            )
        else:
            raw = gemini_story(
                api_key, prompt, story.prompt_sources(), catalog, target_seconds, model, on_retry
            )
        result = story.result(raw, catalog, sequence_name, target_seconds)
    except (StoryModelError, ValueError) as e:
        emitter.error(scrub(e, api_key))
        return 1
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
