"""The `media-clean` command (PLAN.md, "Phase 18c"): dialogue cleaned with ffmpeg, written next to each file.

request: {"paths": [absolute media files] (1 to MAX_FILES), "strength": "light" | "medium" | "strong",
          "streams"?: "first" | "all"}
result: {"files": [{"path", "output", "duration", "reused"} | {"path", "error"}]}

The first sound stream of each file is run through a high-pass (rumble, handling noise), ffmpeg's FFT
denoiser tracking the noise floor (`afftdn`, room tone, hiss, air conditioning) and, above "light", a
de-esser. The whole file is cleaned, so a second in the output is the same second in the source and a
clip's source in and out points carry over. The output is `<name>.vca-clean-<strength>.wav` (24-bit, the
source's sample rate and channels) beside the source; one newer than its source is reused.

The first stream is what Resolve plays of a file with several. `streams: "all"` (for Premiere, which plays a
camera's two mono mics as left and right) joins every sound stream's channels in order first; for a file with
more than one, the output is `<name>.vca-clean-<strength>-all.wav`, so a copy of the first stream alone is
never taken for it.
"""

from __future__ import annotations

import json
import os
import subprocess
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Any

from vibecut_agent.broll import (
    ffprobe_util,  # noqa: F401 - imported for its side effect: Homebrew's ffmpeg on PATH
)
from vibecut_agent.protocol import Emitter, RequestError, require_absolute_paths

MAX_FILES = 16
WORKERS = 2
FFMPEG_TIMEOUT_S = 1800.0

CHAINS = {
    "light": "highpass=f=80,afftdn=nr=6:nf=-45:tn=1",
    "medium": "highpass=f=90,afftdn=nr=12:nf=-40:tn=1,deesser=i=0.3",
    "strong": "highpass=f=100,afftdn=nr=20:nf=-35:tn=1,deesser=i=0.5",
}


STREAMS = ("first", "all")


def output_for(path: str, strength: str, joined: bool = False) -> Path:
    source = Path(path)
    return source.with_name(f"{source.stem}.vca-clean-{strength}{'-all' if joined else ''}.wav")


def sound_streams(path: str) -> list[int]:
    """The sample rate of each sound stream, in order."""
    done = subprocess.run(
        ["ffprobe", "-v", "error", "-select_streams", "a", "-show_entries", "stream=sample_rate", "-of", "json", path],
        capture_output=True,
        timeout=60,
        check=False,
    )  # fmt: skip
    streams = json.loads(done.stdout or b"{}").get("streams") or []
    return [int(s.get("sample_rate") or 0) for s in streams]


def duration_of(path: Path) -> float | None:
    done = subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", str(path)],
        capture_output=True,
        timeout=60,
        check=False,
    )
    try:
        return round(float(done.stdout.decode().strip()), 3)
    except ValueError:
        return None


def clean(path: str, strength: str, streams: str = "first") -> dict[str, Any]:
    if not os.path.isfile(path):
        raise RuntimeError("the file isn't there (is its drive attached?)")
    rates = sound_streams(path) if streams == "all" else []
    joined = len(rates) > 1
    output = output_for(path, strength, joined)
    if output.is_file() and output.stat().st_mtime >= Path(path).stat().st_mtime:
        return {"output": str(output), "duration": duration_of(output), "reused": True}
    if not os.access(output.parent, os.W_OK):
        raise RuntimeError(
            f"can't write next to it ({output.parent} is read-only); copy the media to a writable drive"
        )
    partial = output.with_name(output.name + ".part")
    command = ["ffmpeg", "-hide_banner", "-nostats", "-v", "error", "-y", "-i", path]
    if joined:
        # Every stream at the first one's rate, their channels joined in order, then cleaned.
        rate = rates[0] or 48000
        inputs = "".join(f"[0:a:{i}]aformat=sample_rates={rate}[s{i}];" for i in range(len(rates)))
        joins = "".join(f"[s{i}]" for i in range(len(rates)))
        graph = f"{inputs}{joins}amerge=inputs={len(rates)},{CHAINS[strength]}[out]"
        command += ["-filter_complex", graph, "-map", "[out]", "-vn"]
    else:
        command += ["-map", "0:a:0", "-vn", "-af", CHAINS[strength]]
    command += ["-c:a", "pcm_s24le", "-f", "wav", str(partial)]
    try:
        done = subprocess.run(command, capture_output=True, timeout=FFMPEG_TIMEOUT_S, check=False)
    except subprocess.TimeoutExpired:
        partial.unlink(missing_ok=True)
        raise RuntimeError("ffmpeg took too long to clean it") from None
    if done.returncode != 0:
        partial.unlink(missing_ok=True)
        stderr = done.stderr.decode(errors="ignore")
        if "matches no streams" in stderr:
            raise RuntimeError("the file has no sound")
        raise RuntimeError(stderr.strip()[-300:] or "ffmpeg couldn't clean it")
    partial.replace(output)
    return {"output": str(output), "duration": duration_of(output), "reused": False}


def parse_request(request: dict[str, Any]) -> tuple[list[str], str, str]:
    paths = request.get("paths")
    if not isinstance(paths, list) or not 1 <= len(paths) <= MAX_FILES:
        raise RequestError(f"paths must list 1 to {MAX_FILES} media files")
    require_absolute_paths(paths, "media file")
    strength = request.get("strength", "medium")
    if strength not in CHAINS:
        raise RequestError(f"strength must be one of {', '.join(CHAINS)}")
    streams = request.get("streams", "first")
    if streams not in STREAMS:
        raise RequestError('streams must be "first" or "all"')
    return [str(p) for p in dict.fromkeys(paths)], str(strength), str(streams)


def run(request: dict[str, Any], emitter: Emitter) -> int:
    paths, strength, streams = parse_request(request)
    emitter.progress(0, len(paths), phase="cleaning", detail="")

    def one(path: str) -> dict[str, Any]:
        entry: dict[str, Any] = {"path": path}
        try:
            entry.update(clean(path, strength, streams))
        except Exception as exc:  # noqa: BLE001 - one file that fails is reported, the rest still cleaned
            entry["error"] = str(exc)
        return entry

    with ThreadPoolExecutor(max_workers=WORKERS) as pool:
        files = list(pool.map(one, paths))
    emitter.progress(len(paths), len(paths), phase="done", detail="")
    emitter.emit("result", files=files, strength=strength)
    return 0 if any("error" not in f for f in files) else 1
