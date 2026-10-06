"""chat_steps.py

The step budget both chat loops share (gemini_chat and claude_chat.run_chat_turn), kept free of any
provider's request shape (PLAN.md, "13j").

A step is one model call. A turn gets `DEFAULT_MAX_STEPS` of them. Five steps before the end the
model is told how many are left, and the last step is called with tools turned off, so the turn ends
on the model's own account of what it finished and what's left rather than a canned line. The app
then offers Continue.

`RepeatFailures` marks a tool call that fails a second time with exactly the same arguments, so the
model stops spending steps on a call that can't work as written.
"""

from __future__ import annotations

import json
from typing import Any

DEFAULT_MAX_STEPS = 80
MIN_MAX_STEPS = 10
MAX_MAX_STEPS = 150
# How many steps before the end the model hears about the budget.
HEADS_UP_STEPS = 5

OUT_OF_STEPS_NOTICE = (
    "I ran out of steps for this turn after making the edits above. Press Continue (or tell me "
    "what's left) and I'll carry on."
)

REPEAT_FAILURE_SUFFIX = (
    "This exact call already failed this turn; change the arguments or try another approach."
)


def clamp_max_steps(value: Any) -> int:
    """A requested step budget, held to MIN_MAX_STEPS..MAX_MAX_STEPS. Anything that isn't a number
    gives the default."""
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return DEFAULT_MAX_STEPS
    return max(MIN_MAX_STEPS, min(MAX_MAX_STEPS, int(value)))


def is_last_step(step: int, max_steps: int) -> bool:
    return step >= max_steps


def budget_note(step: int, max_steps: int) -> str | None:
    """The note to put in front of the model before step `step` (1-based) of `max_steps`, or None."""
    left = max_steps - step + 1
    if left <= 1:
        return (
            "[Last step: tools are off. Reply with what you finished and exactly what's left, so the "
            "user can press Continue.]"
        )
    if left == HEADS_UP_STEPS and max_steps > HEADS_UP_STEPS:
        return (
            f"[Step budget: {left} steps left in this turn, this one included. Finish the essential "
            "edits and leave reviews for later.]"
        )
    return None


class RepeatFailures:
    """Remembers the tool calls that failed this turn, by name and arguments."""

    def __init__(self) -> None:
        self._failed: set[tuple[str, str]] = set()

    def annotate(self, name: Any, args: Any, result: Any) -> Any:
        """`result` as is, or with REPEAT_FAILURE_SUFFIX added to its error when the same call
        already failed this turn."""
        if not isinstance(result, dict) or not isinstance(result.get("error"), str):
            return result
        try:
            key = (str(name), json.dumps(args or {}, sort_keys=True, default=str))
        except (TypeError, ValueError):
            return result
        if key not in self._failed:
            self._failed.add(key)
            return result
        return {**result, "error": f"{result['error']} {REPEAT_FAILURE_SUFFIX}"}
