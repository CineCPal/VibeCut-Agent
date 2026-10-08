"""effort.py

How long Claude thinks (`output_config.effort`, and Claude Code's `--effort`), kept apart from
claude_client so the Claude Code path doesn't import the `anthropic` SDK just for these (Phase 11f:
it's about 0.6 s of a chat job's start).

Both models take all five levels. The chat's default is "medium" for both (Phase 9a): Opus 5.5's own
default, and Sonnet 5.5's recommended start for multi-step tool use. Settings → Agent model can
change it per model.
"""

from __future__ import annotations

OPUS = "claude-opus-5-5"
SONNET = "claude-sonnet-5-5"

EFFORT_LEVELS = ("low", "medium", "high", "xhigh", "max")
EFFORT = {OPUS: "medium", SONNET: "medium"}


def resolve_effort(effort: object, model: str) -> str:
    """The effort to run `model` at: a known level as asked, else the model's default."""
    return effort if isinstance(effort, str) and effort in EFFORT_LEVELS else EFFORT.get(model, "medium")
