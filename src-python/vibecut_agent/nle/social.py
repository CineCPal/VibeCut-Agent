"""Vertical, square and 4:5 versions of a timeline (PLAN.md, "Phase 14d"): the sizes, and the checks
both editors' `make_social_version` share. The short side of the source frame is kept (1920x1080 makes
1080x1920, 1080x1080 or 1080x1350), rounded to even pixels, as codecs want."""

from __future__ import annotations

from typing import Any

from vibecut_agent.nle.errors import HostError

ASPECTS: dict[str, tuple[int, int]] = {"9:16": (9, 16), "1:1": (1, 1), "4:5": (4, 5)}
REFRAMES = ("auto", "center")
# Name suffixes: no ":" in a timeline name.
SUFFIX = {"9:16": "9x16", "1:1": "1x1", "4:5": "4x5"}


def _even(value: float) -> int:
    return max(2, round(value / 2) * 2)


def social_size(width: int, height: int, aspect: str) -> tuple[int, int]:
    """The new frame for `aspect`, keeping the source's short side."""
    across, down = ASPECTS[aspect]
    short = min(width, height)
    if across <= down:
        return _even(short), _even(short * down / across)
    return _even(short * across / down), _even(short)


def social_args(args: dict[str, Any]) -> tuple[str, str]:
    aspect = args.get("aspect")
    if aspect not in ASPECTS:
        raise HostError(f"aspect must be one of {', '.join(ASPECTS)}")
    reframe = args.get("reframe", "auto")
    if reframe not in REFRAMES:
        raise HostError("reframe must be auto or center")
    return str(aspect), str(reframe)
