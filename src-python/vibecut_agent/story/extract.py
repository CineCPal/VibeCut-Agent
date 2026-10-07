"""The Story Editor's first pass over long footage (PLAN.md, "Phase 7e").

One story call sees every transcript line, which is best while the lines fit: `SINGLE_PASS_LIMIT`.
Above it, a single call would have to drop lines, and VibeCut's cap dropped the end of every
interview. Instead, each interview (in parts of at most `PART_LINES` lines) gets its own extraction
call, a few at a time, which reads every line and returns the brief's themes and its strongest
moments as segment indices with a short reason. The story call then gets only those lines (each with
its neighbours, so an answer that runs over two lines stays whole) and the notes.

Extraction returns indices, never quotes, so the story still picks from real, timecoded lines that
assemble.py checks. Everything sent is text; no audio leaves the Mac.
"""

from __future__ import annotations

from collections.abc import Callable
from concurrent.futures import FIRST_EXCEPTION, ThreadPoolExecutor, wait
from typing import Any

from vibecut_agent.story.prompt import format_sources

# Lines one story call reads whole. Above this, the first pass runs.
SINGLE_PASS_LIMIT = 2000
# Lines one extraction call reads.
PART_LINES = 1500
# Lines the story call gets after the first pass (moments plus neighbours).
SHORTLIST_LIMIT = 1800
# Lines kept either side of each moment.
NEIGHBOURS = 1
# Extraction calls running at once (Claude Code starts a process for each; a plan has rate limits).
WORKERS = 3

EXTRACT_SYSTEM_INSTRUCTION = """You are an assistant video editor doing a first pass over long interview
footage for a story edit. You are given the editor's creative brief and one part of one interview's
transcript, split into indexed, timecoded segments.

Find the material the story could be built from:
  - `themes`: the few topics in this part that matter for the brief (short phrases).
  - `moments`: the segments worth considering for the cut, by `segment_index`. Include the strongest
    answers, clear statements of fact, emotional beats, and lines that set up or resolve a topic.
    Give each a `why` (under 15 words) and a `strength` from 1 (usable) to 5 (must consider).

Rules:
  - Only use `segment_index` values you were given. Never invent one, and never quote or rewrite text.
  - Segments labelled as the interviewer's are questions, not story; skip them unless an answer makes
    no sense without them.
  - Be generous but selective: roughly the best fifth of the segments, more if the part is dense.
  - Respond ONLY with data matching the provided JSON schema."""

EXTRACT_SCHEMA: dict[str, Any] = {
    "type": "OBJECT",
    "properties": {
        "themes": {"type": "ARRAY", "items": {"type": "STRING"}},
        "moments": {
            "type": "ARRAY",
            "items": {
                "type": "OBJECT",
                "properties": {
                    "segment_index": {"type": "INTEGER"},
                    "why": {"type": "STRING"},
                    "strength": {"type": "INTEGER"},
                },
                "required": ["segment_index", "why", "strength"],
            },
        },
    },
    "required": ["themes", "moments"],
}

# (system, user_text, schema) -> the parsed answer. Raises on failure.
Ask = Callable[[str, str, dict[str, Any]], dict[str, Any]]


class ExtractionStopped(Exception):
    """Stop was pressed during the first pass."""


def line_count(sources: list[dict[str, Any]]) -> int:
    return sum(len(s["segments"]) for s in sources)


def needs_first_pass(sources: list[dict[str, Any]]) -> bool:
    return line_count(sources) > SINGLE_PASS_LIMIT


def parts_of(sources: list[dict[str, Any]], size: int = PART_LINES) -> list[dict[str, Any]]:
    """Each source split into parts of at most `size` segments, in order."""
    parts = []
    for source in sources:
        segments = source["segments"]
        for start in range(0, len(segments), size):
            parts.append({"source_id": source["source_id"], "segments": segments[start : start + size]})
    return parts


def extract_user_text(
    prompt: str, target_seconds: float | None, part: dict[str, Any], number: int, total: int
) -> str:
    target = (
        f"TARGET RUNTIME of the final cut: about {target_seconds:.0f} seconds.\n\n" if target_seconds else ""
    )
    return (
        f"CREATIVE BRIEF:\n{prompt.strip()}\n\n"
        f"{target}"
        f"TRANSCRIPT PART {number} of {total}:\n{format_sources([part])}"
    )


def moments_in(answer: Any, part: dict[str, Any]) -> list[dict[str, Any]]:
    """The answer's moments that name a segment of this part, with sane fields."""
    known = {seg["index"] for seg in part["segments"]}
    out = []
    raw = answer.get("moments") if isinstance(answer, dict) else None
    for item in raw if isinstance(raw, list) else []:
        if not isinstance(item, dict):
            continue
        index = item.get("segment_index")
        if not isinstance(index, int) or isinstance(index, bool) or index not in known:
            continue
        strength = item.get("strength")
        strength = (
            min(5, max(1, strength)) if isinstance(strength, int) and not isinstance(strength, bool) else 3
        )
        raw_why = item.get("why")
        why = raw_why if isinstance(raw_why, str) else ""
        out.append(
            {
                "source_id": part["source_id"],
                "segment_index": index,
                "why": why.strip()[:200],
                "strength": strength,
            }
        )
    return out


def themes_in(answer: Any) -> list[str]:
    raw = answer.get("themes") if isinstance(answer, dict) else None
    return [t.strip()[:120] for t in raw if isinstance(t, str) and t.strip()] if isinstance(raw, list) else []


def shortlist(
    sources: list[dict[str, Any]], moments: list[dict[str, Any]], limit: int = SHORTLIST_LIMIT
) -> list[dict[str, Any]]:
    """The sources cut down to the moments and their neighbours, strongest first until `limit` lines,
    each source's lines kept in their original order."""
    positions = {
        source["source_id"]: {seg["index"]: i for i, seg in enumerate(source["segments"])}
        for source in sources
    }
    keep: dict[str, set[int]] = {source["source_id"]: set() for source in sources}
    total = 0
    for moment in sorted(moments, key=lambda m: -m["strength"]):
        where = positions.get(moment["source_id"], {})
        at = where.get(moment["segment_index"])
        if at is None:
            continue
        segments = next(s["segments"] for s in sources if s["source_id"] == moment["source_id"])
        wanted = {
            segments[i]["index"]
            for i in range(max(0, at - NEIGHBOURS), min(len(segments), at + NEIGHBOURS + 1))
        } - keep[moment["source_id"]]
        if total + len(wanted) > limit:
            continue
        keep[moment["source_id"]] |= wanted
        total += len(wanted)
    return [
        {
            "source_id": s["source_id"],
            "segments": [seg for seg in s["segments"] if seg["index"] in keep[s["source_id"]]],
        }
        for s in sources
        if keep[s["source_id"]]
    ]


def notes_text(themes: list[str], moments: list[dict[str, Any]], kept: list[dict[str, Any]]) -> str:
    """The first pass's findings, for the story call's brief."""
    kept_ids = {(s["source_id"], seg["index"]) for s in kept for seg in s["segments"]}
    lines = ["FIRST-PASS NOTES (an assistant read every line of the footage and shortlisted these):"]
    unique_themes = list(dict.fromkeys(themes))[:30]
    if unique_themes:
        lines.append("Themes: " + "; ".join(unique_themes))
    for m in moments:
        if (m["source_id"], m["segment_index"]) in kept_ids and m["why"]:
            lines.append(f"- {m['source_id']} [{m['segment_index']}] (strength {m['strength']}): {m['why']}")
    lines.append(
        "Only the shortlisted segments are listed below; their neighbours are included for continuity."
    )
    return "\n".join(lines)


def first_pass(
    prompt: str,
    sources: list[dict[str, Any]],
    target_seconds: float | None,
    ask: Ask,
    should_abort: Callable[[], bool] = lambda: False,
    on_progress: Callable[[int, int], None] = lambda done, total: None,
    workers: int = WORKERS,
) -> tuple[list[dict[str, Any]], str]:
    """Reads every part with `ask`, a few at a time, and returns (shortlisted sources, notes for the
    story call). A part that fails fails the pass (its error is raised); Stop raises ExtractionStopped."""
    parts = parts_of(sources)
    total = len(parts)
    answers: list[Any] = [None] * total
    on_progress(0, total)

    def read(i: int) -> None:
        if should_abort():
            raise ExtractionStopped()
        answers[i] = ask(
            EXTRACT_SYSTEM_INSTRUCTION,
            extract_user_text(prompt, target_seconds, parts[i], i + 1, total),
            EXTRACT_SCHEMA,
        )

    done = 0
    with ThreadPoolExecutor(max_workers=max(1, workers)) as pool:
        pending = {pool.submit(read, i) for i in range(total)}
        while pending:
            finished, pending = wait(pending, timeout=0.5, return_when=FIRST_EXCEPTION)
            for future in finished:
                error = future.exception()
                if error is not None:
                    for other in pending:
                        other.cancel()
                    raise error
                done += 1
                on_progress(done, total)
            if should_abort():
                for other in pending:
                    other.cancel()
                raise ExtractionStopped()

    moments: list[dict[str, Any]] = []
    themes: list[str] = []
    for part, answer in zip(parts, answers, strict=True):
        moments += moments_in(answer, part)
        themes += themes_in(answer)
    kept = shortlist(sources, moments)
    if not kept:
        raise ValueError("The first pass found nothing in the footage that fits the brief.")
    return kept, notes_text(themes, moments, kept)
