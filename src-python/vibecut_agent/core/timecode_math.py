"""Exact frame time for the orchestrator's OTIO boundary (ORCHESTRATOR_SPEC.md §3.1; PLAN.md, "Phase 21").

Every time crossing a worker or OTIO delta is a `RationalTime`, a whole frame count at one of the
spec's rates. That count never drifts the way float seconds do on 23.976 and 29.97 timelines. The NTSC
rates are written as their nominal values (23.976, 29.97, 59.94), which is how OTIO and the NLEs label
them, and the math uses their exact values (24000/1001, 30000/1001, 60000/1001).

Standard library only, so the deterministic core runs without the `orchestrator` extra.

SMPTE timecode: drop-frame (`;` before the frames) is the default at 29.97 and 59.94 and allowed only
there. It skips the first 2 (or 4) frame labels of every minute except each tenth minute, so the label
keeps up with the wall clock. 23.976 has no drop-frame and counts in 24s."""

from __future__ import annotations

import math
import re
from fractions import Fraction
from typing import Literal, TypedDict

SUPPORTED_RATES: tuple[float, ...] = (23.976, 24.0, 25.0, 29.97, 30.0, 50.0, 59.94, 60.0)
_EXACT_RATES: dict[float, Fraction] = {
    23.976: Fraction(24000, 1001),
    24.0: Fraction(24),
    25.0: Fraction(25),
    29.97: Fraction(30000, 1001),
    30.0: Fraction(30),
    50.0: Fraction(50),
    59.94: Fraction(60000, 1001),
    60.0: Fraction(60),
}
DROP_FRAME_RATES: tuple[float, ...] = (29.97, 59.94)
# A probed rate within this of a supported one is that rate (29.97 and 30 are 0.03 apart).
RATE_TOLERANCE = 0.01

Rounding = Literal["nearest", "floor", "ceil"]

_SMPTE = re.compile(r"^(\d{1,3})[:;.](\d{2})[:;.](\d{2})([:;.])(\d{2})$")


class RationalTime(TypedDict):
    OTIO_SCHEMA: Literal["RationalTime.1"]
    value: int
    rate: float


class TimeRange(TypedDict):
    OTIO_SCHEMA: Literal["TimeRange.1"]
    start_time: RationalTime
    duration: RationalTime


def exact_rate(rate: float) -> Fraction:
    """The exact frames per second of one of SUPPORTED_RATES (23.976 is 24000/1001)."""
    try:
        return _EXACT_RATES[float(rate)]
    except KeyError:
        raise ValueError(
            f"{rate:g} fps is not a supported rate ({', '.join(f'{r:g}' for r in SUPPORTED_RATES)})"
        ) from None


def snap_rate(fps: float) -> float:
    """The supported rate a probed fps is (23.976023976 is 23.976). Raises ValueError for any other rate."""
    for rate in SUPPORTED_RATES:
        if abs(float(exact_rate(rate)) - fps) <= RATE_TOLERANCE:
            return rate
    raise ValueError(f"{fps:g} fps is not a supported rate ({', '.join(f'{r:g}' for r in SUPPORTED_RATES)})")


def rational_time(value: int, rate: float) -> RationalTime:
    exact_rate(rate)
    if isinstance(value, bool) or not isinstance(value, int):
        raise TypeError(f"A RationalTime's value is a whole frame count, not {value!r}")
    return {"OTIO_SCHEMA": "RationalTime.1", "value": value, "rate": float(rate)}


def _round(frames: Fraction, rounding: Rounding) -> int:
    if rounding == "floor":
        return math.floor(frames)
    if rounding == "ceil":
        return math.ceil(frames)
    # Halves round up (a time exactly between two frames is the later one), unlike round()'s even rule.
    return math.floor(frames + Fraction(1, 2))


def seconds_to_rational(
    seconds: float | Fraction, rate: float, rounding: Rounding = "nearest"
) -> RationalTime:
    """`seconds` as a whole frame count at `rate`, snapped to a frame by `rounding`."""
    frames = Fraction(seconds) * exact_rate(rate)
    return rational_time(_round(frames, rounding), rate)


def rational_to_fraction(time: RationalTime) -> Fraction:
    """A RationalTime's exact seconds."""
    return Fraction(time["value"]) / exact_rate(time["rate"])


def rational_to_seconds(time: RationalTime) -> float:
    return float(rational_to_fraction(time))


def time_range_from_seconds(start: float | Fraction, end: float | Fraction, rate: float) -> TimeRange:
    """The frames from `start` to `end`. Each end snaps to its nearest frame and the duration is the
    difference, so ranges that touch in seconds touch in frames too."""
    first = seconds_to_rational(start, rate)
    last = seconds_to_rational(end, rate)
    if last["value"] < first["value"]:
        raise ValueError(f"A range's end ({float(end):g} s) is before its start ({float(start):g} s)")
    return {
        "OTIO_SCHEMA": "TimeRange.1",
        "start_time": first,
        "duration": rational_time(last["value"] - first["value"], rate),
    }


def _drop_per_minute(rate: float) -> int:
    # 2 labels a minute at 29.97, 4 at 59.94.
    return round(rate) // 15


def rational_to_smpte(time: RationalTime, drop_frame: bool | None = None) -> str:
    """`HH:MM:SS:FF` (or `HH:MM:SS;FF`, drop-frame). `drop_frame=None` is drop-frame at 29.97 and 59.94."""
    rate = time["rate"]
    exact_rate(rate)
    if drop_frame is None:
        drop_frame = rate in DROP_FRAME_RATES
    if drop_frame and rate not in DROP_FRAME_RATES:
        raise ValueError(f"Drop-frame timecode is only for 29.97 and 59.94, not {rate:g}")
    frame = time["value"]
    if frame < 0:
        raise ValueError("Timecode can't be negative")
    timebase = round(rate)
    if drop_frame:
        drop = _drop_per_minute(rate)
        per_minute = timebase * 60 - drop
        per_ten_minutes = timebase * 600 - drop * 9
        tens, rest = divmod(frame, per_ten_minutes)
        frame += drop * 9 * tens
        if rest > drop:
            frame += drop * ((rest - drop) // per_minute)
    hours, rest = divmod(frame, timebase * 3600)
    minutes, rest = divmod(rest, timebase * 60)
    seconds, frames = divmod(rest, timebase)
    return f"{hours:02d}:{minutes:02d}:{seconds:02d}{';' if drop_frame else ':'}{frames:02d}"


def smpte_to_rational(timecode: str, rate: float) -> RationalTime:
    """A timecode label's frame. A `;` (or `.`) before the frames is drop-frame, allowed at 29.97 and 59.94."""
    exact_rate(rate)
    match = _SMPTE.match(timecode.strip())
    if not match:
        raise ValueError(f"{timecode!r} isn't a timecode (HH:MM:SS:FF)")
    hours, minutes, seconds, separator, frames = match.groups()
    hh, mm, ss, ff = int(hours), int(minutes), int(seconds), int(frames)
    drop_frame = separator in ";."
    if drop_frame and rate not in DROP_FRAME_RATES:
        raise ValueError(f"Drop-frame timecode is only for 29.97 and 59.94, not {rate:g}")
    timebase = round(rate)
    if mm >= 60 or ss >= 60 or ff >= timebase:
        raise ValueError(f"{timecode!r} isn't a valid timecode at {rate:g} fps")
    total_minutes = hh * 60 + mm
    frame = (total_minutes * 60 + ss) * timebase + ff
    if drop_frame:
        drop = _drop_per_minute(rate)
        if ss == 0 and ff < drop and mm % 10 != 0:
            raise ValueError(f"{timecode!r} is skipped in drop-frame timecode")
        frame -= drop * (total_minutes - total_minutes // 10)
    return rational_time(frame, rate)


def ranges_overlap(a: TimeRange, b: TimeRange) -> bool:
    """Whether two ranges share any time, compared exactly (their rates may differ). Ranges are half-open,
    so ranges that only touch don't overlap, and an empty range overlaps nothing."""
    a_start = rational_to_fraction(a["start_time"])
    b_start = rational_to_fraction(b["start_time"])
    a_end = a_start + rational_to_fraction(a["duration"])
    b_end = b_start + rational_to_fraction(b["duration"])
    if a_end <= a_start or b_end <= b_start:
        return False
    return a_start < b_end and b_start < a_end
