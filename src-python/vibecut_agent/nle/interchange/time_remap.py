"""Speed changes on exported clips (VibeCut's `Clip.timeRemap`; see PLAN.md, "Speed ramps").

A clip with speed changes carries "time_map": a list of (t, s) pairs, `t` seconds after the clip's
start on the timeline showing source second `s`, from (0, source_in_seconds) to (length,
source_out_seconds), both rising. Between two points the clip plays at one speed.

FCPXML writes the map as it is (`<timeMap>`). Premiere XML and OTIO have no general time map that
other editors reliably import, so they get the clip as consecutive pieces, each at one speed
(`speed_pieces`), which every one of them does support.
"""

from __future__ import annotations

from typing import Any

# Speeds VibeCut allows, with a little slack for rounding.
MIN_SPEED = 0.04
MAX_SPEED = 21.0
MAX_POINTS = 2000
_TOLERANCE = 1e-3


class TimeMapError(ValueError):
    pass


def parse_time_map(raw: Any, source_in: float, source_out: float) -> list[tuple[float, float]]:
    """Checks a request's `timeMap` ([{"t", "s"}, ...]) against the clip's in and out points. Raises
    TimeMapError with the reason when it does not fit, since a wrong map would move everything after
    the clip."""
    if not isinstance(raw, list) or not 2 <= len(raw) <= MAX_POINTS:
        raise TimeMapError(f"must be a list of 2 to {MAX_POINTS} points")
    points: list[tuple[float, float]] = []
    for item in raw:
        if not isinstance(item, dict):
            raise TimeMapError("has a point that is not an object")
        t, s = item.get("t"), item.get("s")
        if any(not isinstance(v, (int, float)) or isinstance(v, bool) for v in (t, s)):
            raise TimeMapError("has a point whose t or s is not a number")
        points.append((float(t), float(s)))  # type: ignore[arg-type]  # both checked numeric just above
    if abs(points[0][0]) > _TOLERANCE or abs(points[0][1] - source_in) > _TOLERANCE:
        raise TimeMapError("does not start at the clip's in point")
    if abs(points[-1][1] - source_out) > _TOLERANCE:
        raise TimeMapError("does not end at the clip's out point")
    for (t0, s0), (t1, s1) in zip(points, points[1:]):
        if t1 <= t0 or s1 <= s0:
            raise TimeMapError("does not keep moving forward")
        speed = (s1 - s0) / (t1 - t0)
        if not MIN_SPEED <= speed <= MAX_SPEED:
            raise TimeMapError(f"plays at {speed:.3f}x, outside the supported range")
    return points


def clip_length_seconds(clip: dict) -> float:
    """How long the clip runs on the timeline."""
    time_map = clip.get("time_map")
    if time_map:
        return time_map[-1][0]
    return max(0.0, clip["source_out_seconds"] - clip["source_in_seconds"])


def constant_speed(clip: dict) -> float | None:
    """The clip's one speed (1.0 without a map), or None when it changes speed."""
    time_map = clip.get("time_map")
    if not time_map:
        return 1.0
    speeds = [(s1 - s0) / (t1 - t0) for (t0, s0), (t1, s1) in zip(time_map, time_map[1:])]
    if max(speeds) - min(speeds) <= 1e-6 * max(1.0, max(speeds)):
        return (time_map[-1][1] - time_map[0][1]) / time_map[-1][0]
    return None


def _source_at(time_map: list, t: float) -> float:
    """The source second the map shows at `t` seconds into the clip (straight between points)."""
    if t <= time_map[0][0]:
        return time_map[0][1]
    for (t0, s0), (t1, s1) in zip(time_map, time_map[1:]):
        if t <= t1:
            return s0 + (s1 - s0) * (t - t0) / (t1 - t0)
    return time_map[-1][1]


def on_frames(time_map: list, start: float, fps: float) -> list[tuple[float, float]]:
    """The map with its points moved onto the frames their timeline times land on (counted from the
    clip's own start frame), each showing the source second the map shows there, so the pieces built
    from it meet exactly and each plays the map's average speed over its frames. Points landing on one
    frame become one (an eased ramp's steps are shorter than a frame); the end stays the end, and the
    clip keeps at least one frame. Without this, pieces rounded one by one overlapped (PLAN.md, "8b
    live check")."""
    origin = round(start * fps)
    frames = sorted({round((start + t) * fps) - origin for t, _s in time_map} | {0})
    last = max(frames[-1], 1)
    frames = [f for f in frames if f < last] + [last]
    end_t = time_map[-1][0]
    points = [(f / fps, _source_at(time_map, min(f / fps, end_t))) for f in frames[:-1]]
    return [*points, (last / fps, time_map[-1][1])]


def speed_pieces(clip: dict, fps: float | None = None) -> list[dict]:
    """The clip as consecutive pieces that each play at one speed, as plain clips with an extra
    "speed" key (1.0 for a clip without speed changes, which comes back as the only piece). A fade in
    stays on the first piece, a fade out and the transition on the last; the other keys are shared.
    With `fps`, the pieces start and end on whole frames (`on_frames`)."""
    time_map = clip.get("time_map")
    if not time_map:
        return [{**clip, "speed": 1.0}]
    if fps:
        time_map = on_frames(time_map, clip["start_time_seconds"], fps)
    base = {
        k: v
        for k, v in clip.items()
        if k not in ("time_map", "fade_in_seconds", "fade_out_seconds", "transition_out")
    }
    pieces: list[dict] = []
    stretches = list(zip(time_map, time_map[1:]))
    for index, ((t0, s0), (t1, s1)) in enumerate(stretches):
        piece = {
            **base,
            "start_time_seconds": clip["start_time_seconds"] + t0,
            "source_in_seconds": s0,
            "source_out_seconds": s1,
            "length_seconds": t1 - t0,
            "speed": (s1 - s0) / (t1 - t0),
        }
        if index == 0 and clip.get("fade_in_seconds"):
            piece["fade_in_seconds"] = clip["fade_in_seconds"]
        if index == len(stretches) - 1:
            for key in ("fade_out_seconds", "transition_out"):
                if clip.get(key):
                    piece[key] = clip[key]
        pieces.append(piece)
    merged = merge_equal_speeds(pieces)
    # A picture and its sound retimed together split into the same pieces; each piece links only to
    # its counterpart, so the pairs stay together without tying the whole clip into one group.
    if len(merged) > 1 and clip.get("link_group"):
        for index, piece in enumerate(merged):
            piece["link_group"] = f"{clip['link_group']}~{index}"
    return merged


def merge_equal_speeds(pieces: list[dict]) -> list[dict]:
    """Joins neighbouring pieces that play at the same speed (an eased ramp's steps never do, but a
    map with a redundant point would), so the other editor gets no needless cuts."""
    merged: list[dict] = []
    for piece in pieces:
        last = merged[-1] if merged else None
        if last and abs(last["speed"] - piece["speed"]) <= 1e-6 * max(1.0, piece["speed"]):
            last["source_out_seconds"] = piece["source_out_seconds"]
            last["length_seconds"] += piece["length_seconds"]
            for key in ("fade_out_seconds", "transition_out"):
                if key in piece:
                    last[key] = piece[key]
            continue
        merged.append(dict(piece))
    return merged
