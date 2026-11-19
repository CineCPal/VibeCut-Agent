"""Soundbites from whole transcripts (PLAN.md, "Soundbites from long interviews"): the `assemble` command
with `"mode": "soundbites"`, behind the chat's `find_soundbites` tool.

A two-hour interview's transcript is too long to read through tool results a page at a time, and the chat
needs only the lines that answer its brief. This runs the Story Editor's first pass (extract.read_parts) over
every line of every given transcript, in parts, a few at a time, on the first-pass model (Sonnet at low
effort, or Gemini Flash; the request's `extraction`), and returns the moments it found: each line's file,
time, speaker and words as transcribed, why it fits, and how strongly, strongest first. Extraction returns
segment indices, never quotes, so every soundbite is a real, timecoded line.

It runs as `assemble` so Rust gives it the chat's model credentials (sidecar.rs `prepare_request`) and the
first pass's Gemini key when that's the choice, as it does for the Story Editor.

request: the `assemble` request's sources, media, fps, provider, model, extraction (and what Rust injects),
plus "mode": "soundbites", "prompt" (the brief: what to look for) and "maxResults" (default 40, at most 150).
Events: starting, status {phase, detail}, retry, result {soundbites, themes, reader, linesRead, files}, error,
done."""

from __future__ import annotations

from typing import Any

from vibecut_agent.agent.chat import provider_of
from vibecut_agent.agent.redact import register_secret, scrub
from vibecut_agent.protocol import CancelFlag, Emitter, RequestError, require_absolute_paths
from vibecut_agent.story import extract
from vibecut_agent.story.assemble import Story
from vibecut_agent.story.models import StoryModelError

DEFAULT_RESULTS = 40
MAX_RESULTS = 150


def _count(value: Any) -> int:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return DEFAULT_RESULTS
    return max(1, min(MAX_RESULTS, int(value)))


def soundbites_of(
    sources: list[dict[str, Any]], moments: list[dict[str, Any]], media: dict[str, str], limit: int
) -> list[dict[str, Any]]:
    """The moments as soundbites, strongest first (then in file order), one per line, at most `limit`."""
    lines = {(s["source_id"], seg["index"]): seg for s in sources for seg in s["segments"]}
    order = {s["source_id"]: i for i, s in enumerate(sources)}
    best: dict[tuple[str, int], dict[str, Any]] = {}
    for m in moments:
        key = (m["source_id"], m["segment_index"])
        if key in lines and (key not in best or m["strength"] > best[key]["strength"]):
            best[key] = m
    ranked = sorted(
        best.values(),
        key=lambda m: (
            -m["strength"],
            order[m["source_id"]],
            lines[(m["source_id"], m["segment_index"])]["start_seconds"],
        ),
    )
    out = []
    for m in ranked[:limit]:
        seg = lines[(m["source_id"], m["segment_index"])]
        out.append(
            {
                "source_id": m["source_id"],
                "file": media.get(m["source_id"]),
                "start": round(seg["start_seconds"], 2),
                "end": round(seg["end_seconds"], 2),
                "speaker": seg.get("speaker"),
                "text": seg["text"],
                "why": m["why"],
                "strength": m["strength"],
            }
        )
    return out


def run(request: dict[str, Any], emitter: Emitter, cancel: CancelFlag | None = None) -> int:
    # Imported here: commands.py imports this module for its `mode` switch.
    from vibecut_agent.story.commands import WHO, extraction_asker

    register_secret(request.get("apiKey"))
    register_secret(request.get("extractionKey"))
    provider = provider_of(request)
    api_key = (request.get("apiKey") or "").strip()
    if provider == "claude-code":
        if not isinstance(request.get("claudeCode"), dict):
            raise RequestError("Claude Code isn't set up. See Settings → Claude subscription.")
    elif not api_key and request.get("extraction") != "gemini":
        raise RequestError(f"No {WHO[provider]} API key was provided.")
    prompt = request.get("prompt")
    if not isinstance(prompt, str) or not prompt.strip():
        raise RequestError("Say what to look for (prompt)")
    sources = request.get("sources")
    if not isinstance(sources, list) or not sources:
        raise RequestError("No transcripts were given to search")
    media = request.get("media") or {}
    if not isinstance(media, dict):
        raise RequestError("media must map source ids to video paths")
    require_absolute_paths(list(media.values()), "video")

    story = Story(request.get("fps") or 25.0)
    emitter.emit("status", phase="reading", detail="Reading transcripts")
    if not story.load_sources(sources):
        raise RequestError("None of the transcripts had a usable line")
    prompt_sources = story.prompt_sources()
    lines = extract.line_count(prompt_sources)

    def on_retry(attempt: int, max_attempts: int, wait_seconds: float, reason: str) -> None:
        emitter.emit(
            "retry",
            attempt=attempt,
            maxAttempts=max_attempts,
            waitSeconds=round(wait_seconds, 1),
            reason=reason,
        )

    def on_fallback(notice: str) -> None:
        emitter.emit("status", phase="extracting", detail=notice)

    should_abort = cancel.is_set if cancel else lambda: False
    try:
        ask, reader = extraction_asker(request, provider, api_key, should_abort, on_retry, on_fallback)

        def progress(done: int, total: int) -> None:
            emitter.emit(
                "status",
                phase="extracting",
                detail=f"{reader} reading {lines} lines: {done} of {total} part(s)",
            )

        moments, themes = extract.read_parts(prompt, prompt_sources, None, ask, should_abort, progress)
    except extract.ExtractionStopped:
        emitter.error("Stopped")
        return 1
    except (StoryModelError, ValueError) as e:
        emitter.error(scrub(e, api_key))
        return 1
    found = soundbites_of(
        prompt_sources,
        moments,
        {k: v for k, v in media.items() if isinstance(k, str) and isinstance(v, str)},
        _count(request.get("maxResults")),
    )
    emitter.emit(
        "result",
        soundbites=found,
        themes=list(dict.fromkeys(themes))[:20],
        reader=reader,
        linesRead=lines,
        files=len(prompt_sources),
    )
    return 0
