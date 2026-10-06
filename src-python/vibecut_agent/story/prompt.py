"""The Story Editor's prompt, verbatim from VibeCut's rough-cut-studio gemini_client.py
(`SYSTEM_INSTRUCTION`, `STORY_RESPONSE_SCHEMA`, `STORY_SYSTEM_INSTRUCTION` and the two prompt
formatters), shared by the Gemini and Claude calls so both models get the same brief.

The model only ever chooses from the segment indices and B-roll ids it is given; assemble.py checks
every choice against the real transcripts and catalog before anything reaches a timeline.
"""

from __future__ import annotations

from typing import Any

SYSTEM_INSTRUCTION = """You are an assistant video editor. You are given:
  1. A creative brief / prompt describing the video the editor wants to cut.
  2. One or more timecoded transcripts, each already split into indexed
     segments with known start/end times.

Your job is to choose which transcript segments to use, in what order, to
build the requested video, and to write a short editorial note for each cut.

Rules you must follow:
  - Only reference `source_id` values and `segment_index` values that were
    given to you. Never invent a segment that doesn't exist.
  - `in_offset_seconds` / `out_offset_seconds` trim seconds off the START and
    END of the chosen segment respectively (both default to 0, meaning use
    the full segment). Use small trims only when it clearly improves the cut
    (e.g. removing a false start or trailing silence). Never let the trimmed
    segment become shorter than 0.3 seconds.
  - Keep the narrative coherent and true to the brief. Do not fabricate
    quotes or dialogue that is not present in the transcript text.
  - A segment whose speaker is labeled "Interviewer" (e.g. "Interviewer (Ana)")
    is the interviewer's question or comment, not part of the story. Leave it
    out unless the brief asks for the questions or an answer makes no sense
    without it.
  - `editorial_note` is a short (<20 word) human-readable instruction for the
    editor, e.g. "Open on Jane's intro about the March start date."
  - Order segments with the `order` field starting at 0.
  - If a target runtime is given, treat it as a real constraint: choose
    enough segments to approach it and trim segments as needed to avoid
    overshooting by a large margin, rather than padding with filler or
    cutting the story short to hit the number exactly. Getting close
    matters more than hitting it precisely.
  - Respond ONLY with data matching the provided JSON schema."""

STORY_RESPONSE_SCHEMA: dict[str, Any] = {
    "type": "OBJECT",
    "properties": {
        "sequence_name": {"type": "STRING"},
        "narrative_summary": {"type": "STRING"},
        "script_segments": {
            "type": "ARRAY",
            "items": {
                "type": "OBJECT",
                "properties": {
                    "order": {"type": "INTEGER"},
                    "source_id": {"type": "STRING"},
                    "segment_index": {"type": "INTEGER"},
                    "in_offset_seconds": {"type": "NUMBER"},
                    "out_offset_seconds": {"type": "NUMBER"},
                    "editorial_note": {"type": "STRING"},
                    "on_screen_text": {"type": "STRING"},
                },
                "required": [
                    "order",
                    "source_id",
                    "segment_index",
                    "in_offset_seconds",
                    "out_offset_seconds",
                    "editorial_note",
                ],
            },
        },
        "broll_segments": {
            "type": "ARRAY",
            "items": {
                "type": "OBJECT",
                "properties": {
                    "broll_id": {"type": "STRING"},
                    "anchor_order": {"type": "INTEGER"},
                    "anchor_offset_seconds": {"type": "NUMBER"},
                    "duration_seconds": {"type": "NUMBER"},
                    "audio_mode": {
                        "type": "STRING",
                        "enum": ["silent", "full", "duck_main"],
                    },
                    "duck_db": {"type": "NUMBER"},
                    "editorial_note": {"type": "STRING"},
                },
                "required": [
                    "broll_id",
                    "anchor_order",
                    "anchor_offset_seconds",
                    "duration_seconds",
                    "audio_mode",
                    "editorial_note",
                ],
            },
        },
    },
    "required": [
        "sequence_name",
        "narrative_summary",
        "script_segments",
        "broll_segments",
    ],
}

STORY_SYSTEM_INSTRUCTION = (
    SYSTEM_INSTRUCTION
    + """

You are ALSO given a catalog of available B-roll clips (id, duration, and — when known — a caption,
tags and a technical quality score). Choose which of them, if any, to lay over the main cut you just
built, as `broll_segments`.

Additional rules for B-roll:
  - Only reference `broll_id` values that appear in the catalog you were given. Never invent one.
  - Place each B-roll clip relative to a main-track cut using `anchor_order` (the `order` of a
    `script_segments` entry) and `anchor_offset_seconds` (seconds into that cut's own on-timeline
    span, 0 or more) — never an absolute timeline time, since you do not know the final timeline
    positions in advance.
  - `duration_seconds` must not exceed the catalog clip's own duration.
  - Prefer clips whose caption or tags clearly support the moment being covered; a clip with no
    caption or tags is a weaker, filename-only guess — only use one if nothing better fits.
  - Do not let a single B-roll clip cover more than roughly 60% of the main cut it anchors to.
  - `audio_mode` defaults to "silent" (the usual choice for a B-roll cutaway); use "full" only when
    the B-roll's own sound should be heard, and "duck_main" (with a negative `duck_db`, e.g. -12) only
    when the main track's sound should keep playing underneath, quieter.
  - It is fine to return an empty `broll_segments` list if the catalog offers nothing suitable, or if
    no catalog was given at all.
  - `editorial_note` is a short (<20 word) human-readable reason for the placement.

OPENING, ORDER AND PACING:
  - The opening segment (`order: 0`) is the one that naturally starts the story: an introduction,
    the setup or context, or the first beat the brief describes. Do not pull a striking line from
    later in the footage to open with. Open cold, or with a teaser of a later moment, only when the
    brief explicitly asks for it (e.g. "cold open", "teaser", "hook", "start with ...").
  - Keep segments in the story's natural order, normally the order they were said within a source.
    Reorder only when the brief asks for it or when it clearly makes the story easier to follow.
  - Never use the same segment twice.
  - Pace the cut normally by default. Only when the creative brief signals an upbeat, energetic,
    fast, social, or short-form intent (words like "upbeat," "energetic," "hype," "fast," "punchy,"
    "reel," "short-form"): prefer shorter segments, trim `in_offset_seconds`/`out_offset_seconds`
    tighter, cut away from a line as soon as its point has landed, use denser B-roll cutaways, and
    note it briefly in the affected segments' `editorial_note`.
  - These are ordering/pacing rules layered on top of the rules above, not a license to fabricate
    dialogue or ignore the target runtime — the existing constraints still govern."""
)


def format_sources(sources: list[dict[str, Any]]) -> str:
    lines = []
    for src in sources:
        lines.append(f"### source_id: {src['source_id']}")
        for seg in src["segments"]:
            speaker = f"{seg['speaker']}: " if seg.get("speaker") else ""
            lines.append(f"[{seg['index']}] {seg['start_tc']} - {seg['end_tc']}  {speaker}{seg['text']}")
        lines.append("")
    return "\n".join(lines)


def format_catalog(catalog: list[dict[str, Any]]) -> str:
    if not catalog:
        return "(none available)"
    lines = []
    for clip in catalog:
        bits = [f"duration {clip['duration_seconds']:.1f}s"]
        if clip.get("caption"):
            bits.append(f"caption: {clip['caption']}")
        if clip.get("tags"):
            bits.append(f"tags: {', '.join(clip['tags'])}")
        if clip.get("technical_score") is not None:
            bits.append(f"quality {clip['technical_score']:.0f}/100")
        lines.append(f"[{clip['broll_id']}] {'; '.join(bits)}")
    return "\n".join(lines)


def user_content(
    prompt: str, sources: list[dict[str, Any]], catalog: list[dict[str, Any]], target_seconds: float | None
) -> str:
    """The user turn of generate_story_script, verbatim."""
    target_line = ""
    if target_seconds:
        target_line = f"TARGET RUNTIME: approximately {target_seconds:.0f} seconds total.\n\n"
    return (
        f"CREATIVE BRIEF:\n{prompt.strip()}\n\n"
        f"{target_line}"
        f"AVAILABLE TRANSCRIPT SEGMENTS:\n{format_sources(sources)}\n"
        f"AVAILABLE B-ROLL CLIPS:\n{format_catalog(catalog)}"
    )
