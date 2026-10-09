"""The `media-loudness` command (PLAN.md, "Phase 13d"): how loud parts of media files are, by EBU R128
(ffmpeg's `ebur128` filter), as the loudness tools in the chat need it.

request: {"ranges": [{"path", "start" (s, default 0), "end" (s, optional: to the end)}] (1 to MAX_RANGES)}
result: {"levels": [{"index", "path", "start", "end", "integratedLufs", "loudnessRange", "truePeakDb",
         "maxShortTermLufs"} | {"index", "path", "error"}]}

The first sound stream is measured, its channels mixed as R128 weights them. A range quieter than
R128's gate (silence) has no integrated loudness: `integratedLufs` is null.
"""

from __future__ import annotations

import math
import os
import re
import subprocess
from concurrent.futures import ThreadPoolExecutor
from typing import Any

from vibecut_agent.broll import (
    ffprobe_util,  # noqa: F401 - imported for its side effect: Homebrew's ffmpeg on PATH
)
from vibecut_agent.protocol import Emitter, RequestError, require_absolute_paths

MAX_RANGES = 32
WORKERS = 4
FFMPEG_TIMEOUT_S = 600.0
# ebur128's floor: what it prints for silence.
SILENT = -70.0

_SUMMARY = re.compile(
    r"Integrated loudness:\s*I:\s*(?P<i>-?[\d.]+|-inf)\s*LUFS.*?"
    r"Loudness range:\s*LRA:\s*(?P<lra>-?[\d.]+)\s*LU.*?"
    r"True peak:\s*Peak:\s*(?P<tp>-?[\d.]+|-inf)\s*dBFS",
    re.DOTALL,
)
_SHORT_TERM = re.compile(r"\bS:\s*(-?[\d.]+|-inf)")


def _value(text: str) -> float | None:
    number = -math.inf if text == "-inf" else float(text)
    return None if not math.isfinite(number) else round(number, 1)


def parse(stderr: str) -> dict[str, Any]:
    """ebur128's summary (and its per-frame lines, for the loudest 3 s) as numbers."""
    summary = list(_SUMMARY.finditer(stderr))
    if not summary:
        raise RuntimeError("ffmpeg didn't report a loudness (does the file have sound?)")
    found = summary[-1]
    integrated = _value(found["i"])
    short = [v for v in (_value(m) for m in _SHORT_TERM.findall(stderr)) if v is not None and v > SILENT]
    return {
        "integratedLufs": integrated if integrated is not None and integrated > SILENT else None,
        "loudnessRange": _value(found["lra"]),
        "truePeakDb": _value(found["tp"]),
        "maxShortTermLufs": max(short) if short else None,
    }


def measure(path: str, start: float, end: float | None) -> dict[str, Any]:
    if not os.path.isfile(path):
        raise RuntimeError("the file isn't there (is its drive attached?)")
    window = ["-ss", f"{start:.3f}"] + (["-t", f"{end - start:.3f}"] if end is not None else [])
    command = ["ffmpeg", "-hide_banner", "-nostats", "-v", "verbose", *window, "-i", path]
    command += ["-map", "0:a:0", "-af", "ebur128=peak=true:framelog=verbose", "-f", "null", "-"]
    try:
        done = subprocess.run(command, capture_output=True, timeout=FFMPEG_TIMEOUT_S, check=False)
    except subprocess.TimeoutExpired:
        raise RuntimeError("ffmpeg took too long to measure it") from None
    stderr = done.stderr.decode(errors="ignore")
    if done.returncode != 0:
        if "matches no streams" in stderr:
            raise RuntimeError("the file has no sound")
        raise RuntimeError(stderr.strip()[-300:] or "ffmpeg couldn't measure it")
    return parse(stderr)


def _number(value: Any, field: str) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)) or math.isnan(value):
        raise RequestError(f"{field} must be a number")
    return float(value)


def parse_ranges(raw: Any) -> list[dict[str, Any]]:
    if not isinstance(raw, list) or not 1 <= len(raw) <= MAX_RANGES:
        raise RequestError(f"ranges must list 1 to {MAX_RANGES} parts of files")
    out = []
    for i, item in enumerate(raw):
        if not isinstance(item, dict):
            raise RequestError(f"ranges[{i}] must be an object")
        require_absolute_paths([item.get("path")], "media file")
        start = _number(item.get("start", 0), f"ranges[{i}].start")
        end = None if item.get("end") is None else _number(item["end"], f"ranges[{i}].end")
        if start < 0 or (end is not None and end <= start):
            raise RequestError(f"ranges[{i}] must start at 0 or later and end after it starts")
        out.append({"path": str(item["path"]), "start": start, "end": end})
    return out


def run(request: dict[str, Any], emitter: Emitter) -> int:
    ranges = parse_ranges(request.get("ranges"))
    emitter.progress(0, len(ranges), phase="measuring", detail="")

    def one(n: int) -> dict[str, Any]:
        r = ranges[n]
        entry: dict[str, Any] = {"index": n, "path": r["path"], "start": r["start"], "end": r["end"]}
        try:
            entry.update(measure(r["path"], r["start"], r["end"]))
        except Exception as exc:  # noqa: BLE001 - one unreadable range is reported, the rest still measured
            entry["error"] = str(exc)
        return entry

    with ThreadPoolExecutor(max_workers=WORKERS) as pool:
        levels = list(pool.map(one, range(len(ranges))))
    emitter.progress(len(ranges), len(ranges), phase="done", detail="")
    emitter.emit("result", levels=levels)
    return 0 if any("error" not in level for level in levels) else 1
