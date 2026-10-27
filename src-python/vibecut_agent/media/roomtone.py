"""The `media-roomtone` command (PLAN.md, "Phase 18e"): room tone taken from a recording, made as long as needed.

request: {"sources": [{"path", "channel"?, "start"?, "end"?, "seconds"}] (1 to MAX_SOURCES), "project"?}
result: {"files": [{"path", "channel"?, "output", "duration", "sample": {"start", "seconds"}, "levelDb",
                    "contrastDb", "quiet", "reused"} | {"path", "channel"?, "error"}], "folder"}

Each source is searched between `start` and `end` (file seconds; the whole file when they're left out, or when
there's no real pause there) for its quietest stretch: up to 3 s whose loudest 50 ms, with 0.1 s either
side, is the lowest, so no word, breath edge or click is in it. Digital silence doesn't count as room tone.
That stretch is then looped to `seconds`, alternating forward and reversed copies joined by equal-power
crossfades, so the seams don't click or pulse. `channel` (1-based) takes that channel alone, as a mono file
(for a clip that plays one channel of a recording); otherwise the file keeps the source's channels. The rate
is the source's, 24-bit WAV.

`contrastDb` is how far the stretch sits under the source's speech (its 90th-percentile level); under
QUIET_CONTRAST_DB it's reported as `quiet: false`, since then the source may have no real pause.

The files go in `~/Movies/VibeCut Renders/<project>/Room tone/`, named from the source and a hash of the
request and the source's size and time, so asking again reuses them.
"""

from __future__ import annotations

import hashlib
import json
import math
import os
import subprocess
from pathlib import Path
from typing import Any

import numpy as np

from vibecut_agent.broll import (
    ffprobe_util,  # noqa: F401 - imported for its side effect: Homebrew's ffmpeg on PATH
)
from vibecut_agent.nle.renders import project_folder, safe_name
from vibecut_agent.protocol import Emitter, RequestError, require_absolute_paths

MAX_SOURCES = 16
MAX_SECONDS = 600.0
MAX_ANALYSIS_SECONDS = 4 * 3600.0
FFMPEG_TIMEOUT_S = 1800.0
# Bumped when what's made changes, so older files aren't reused.
VERSION = 1

ANALYSIS_RATE = 16000
BLOCK_SECONDS = 0.05
# Blocks either side of a stretch that must be as quiet as it.
PAD_BLOCKS = 2
# Stretch lengths tried, longest first; a longer one is kept while it's within LONGER_DB of the shortest.
LENGTHS_S = (3.0, 2.0, 1.0, 0.5)
LONGER_DB = 3.0
SILENT_DB = -90.0
QUIET_CONTRAST_DB = 10.0
CROSSFADE_S = 0.25


def levels_db(samples: np.ndarray, block: int) -> np.ndarray:
    """The RMS level of each whole block of a mono signal, in dBFS."""
    whole = len(samples) // block
    if not whole:
        return np.zeros(0)
    power = np.mean(np.square(samples[: whole * block].reshape(whole, block), dtype=np.float64), axis=1)
    return np.asarray(10 * np.log10(np.maximum(power, 1e-20)))


def quietest(levels: np.ndarray) -> tuple[int, int, float] | None:
    """(first block, blocks, its loudest block in dB) of the quietest stretch, or None when no stretch fits."""
    usable = np.where(levels > SILENT_DB, levels, np.inf)
    found: list[tuple[int, int, float]] = []
    for seconds in LENGTHS_S:
        length = round(seconds / BLOCK_SECONDS)
        span = length + 2 * PAD_BLOCKS
        if len(usable) < span:
            continue
        loudest = np.lib.stride_tricks.sliding_window_view(usable, span).max(axis=1)
        best = int(np.argmin(loudest))
        if math.isfinite(loudest[best]):
            found.append((best + PAD_BLOCKS, length, float(loudest[best])))
    if not found:
        return None
    floor = min(f[2] for f in found)
    return next(f for f in found if f[2] <= floor + LONGER_DB)


def loop_to(sample: np.ndarray, frames: int, rate: int) -> np.ndarray:
    """`sample` (frames x channels) made `frames` long: forward and reversed copies, crossfaded."""
    n = len(sample)
    fade = max(1, min(round(CROSSFADE_S * rate), n // 4))
    ramp = np.linspace(0.0, math.pi / 2, fade, dtype=np.float64)[:, None]
    fade_in, fade_out = np.sin(ramp), np.cos(ramp)
    out = np.zeros((frames + n, sample.shape[1]), dtype=np.float64)
    position, k = 0, 0
    while position < frames:
        piece = (sample if k % 2 == 0 else sample[::-1]).astype(np.float64)
        if k:
            piece[:fade] *= fade_in
        piece[-fade:] *= fade_out
        out[position : position + n] += piece
        position += n - fade
        k += 1
    return out[:frames].astype(np.float32)


def probe(path: str) -> tuple[int, int, float | None]:
    """The first sound stream's (sample rate, channels) and the file's duration."""
    done = subprocess.run(
        ["ffprobe", "-v", "error", "-select_streams", "a:0", "-show_entries",
         "stream=sample_rate,channels:format=duration", "-of", "json", path],
        capture_output=True,
        timeout=60,
        check=False,
    )  # fmt: skip
    info = json.loads(done.stdout or b"{}")
    streams = info.get("streams") or []
    if not streams:
        raise RuntimeError("the file has no sound")
    try:
        duration: float | None = float(info.get("format", {}).get("duration"))
    except (TypeError, ValueError):
        duration = None
    return int(streams[0]["sample_rate"]), int(streams[0]["channels"]), duration


def _decode(path: str, start: float, seconds: float, rate: int, mix: str) -> subprocess.Popen[bytes]:
    command = [
        "ffmpeg",
        "-hide_banner",
        "-nostats",
        "-v",
        "error",
        "-ss",
        f"{start:.3f}",
        "-t",
        f"{seconds:.3f}",
    ]
    command += ["-i", path, "-map", "0:a:0", "-vn", "-af", mix, "-ar", str(rate), "-f", "f32le", "pipe:1"]
    return subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE)


def analyse(path: str, start: float, end: float, channel: int | None, channels: int) -> np.ndarray:
    """Block levels of the mono mix (or `channel`) from `start` to `end`, read a piece at a time."""
    mix = (
        f"pan=mono|c0=c{channel - 1}"
        if channel
        else f"pan=mono|c0={'+'.join(f'{1 / channels:.6f}*c{i}' for i in range(channels))}"
    )
    block = round(BLOCK_SECONDS * ANALYSIS_RATE)
    process = _decode(path, start, end - start, ANALYSIS_RATE, mix)
    assert process.stdout is not None
    levels: list[np.ndarray] = []
    carry = np.zeros(0, dtype=np.float32)
    try:
        while chunk := process.stdout.read(block * 4 * 1000):
            samples = np.concatenate([carry, np.frombuffer(chunk, dtype=np.float32)])
            whole = len(samples) // block * block
            levels.append(levels_db(samples[:whole], block))
            carry = samples[whole:]
        process.wait(timeout=FFMPEG_TIMEOUT_S)
    finally:
        if process.poll() is None:
            process.kill()
    if process.returncode != 0:
        stderr = process.stderr.read().decode(errors="ignore") if process.stderr else ""
        raise RuntimeError(stderr.strip()[-300:] or "ffmpeg couldn't read its sound")
    return np.concatenate(levels) if levels else np.zeros(0)


def extract(
    path: str, start: float, seconds: float, rate: int, channel: int | None, channels: int
) -> np.ndarray:
    """The stretch at the source's own rate, frames x channels (one channel when `channel` is given)."""
    mix = f"pan=mono|c0=c{channel - 1}" if channel else "anull"
    width = 1 if channel else channels
    process = _decode(path, start, seconds, rate, mix)
    out, err = process.communicate(timeout=FFMPEG_TIMEOUT_S)
    if process.returncode != 0:
        raise RuntimeError(err.decode(errors="ignore").strip()[-300:] or "ffmpeg couldn't read its sound")
    samples = np.frombuffer(out, dtype=np.float32)
    return samples[: len(samples) // width * width].reshape(-1, width)


def write_wav(samples: np.ndarray, rate: int, output: Path) -> None:
    partial = output.with_name(f".{output.stem}.part.wav")
    command = ["ffmpeg", "-hide_banner", "-nostats", "-v", "error", "-y", "-f", "f32le", "-ar", str(rate)]
    command += ["-ac", str(samples.shape[1]), "-i", "pipe:0", "-c:a", "pcm_s24le", "-f", "wav", str(partial)]
    try:
        done = subprocess.run(
            command, input=samples.tobytes(), capture_output=True, timeout=FFMPEG_TIMEOUT_S, check=False
        )
    except subprocess.TimeoutExpired:
        partial.unlink(missing_ok=True)
        raise RuntimeError("ffmpeg took too long to write it") from None
    if done.returncode != 0:
        partial.unlink(missing_ok=True)
        raise RuntimeError(done.stderr.decode(errors="ignore").strip()[-300:] or "ffmpeg couldn't write it")
    partial.replace(output)


def search(path: str, start: float, end: float, channel: int | None, channels: int) -> dict[str, Any] | None:
    """The quietest stretch from `start` to `end`: where it is, its level, and how far under the speech."""
    if end - start <= 0:
        return None
    levels = analyse(path, start, end, channel, channels)
    found = quietest(levels)
    if found is None:
        return None
    first, blocks, _ = found
    stretch = levels[first : first + blocks]
    level = float(10 * np.log10(np.mean(np.power(10.0, stretch / 10))))
    speech = float(np.percentile(levels[levels > SILENT_DB], 90))
    return {
        "sample": {
            "start": round(start + first * BLOCK_SECONDS, 3),
            "seconds": round(blocks * BLOCK_SECONDS, 3),
        },
        "levelDb": round(level, 1),
        "contrastDb": round(speech - level, 1),
    }


def output_for(source: dict[str, Any], folder: Path) -> Path:
    stat = os.stat(source["path"])
    key = [VERSION, source["path"], stat.st_size, int(stat.st_mtime)]
    key += [source.get("channel"), source.get("start"), source.get("end"), source["seconds"]]
    digest = hashlib.sha1(json.dumps(key).encode()).hexdigest()[:8]
    stem = safe_name(Path(source["path"]).stem, "Recording")[:60].rstrip()
    channel = f" ch{source['channel']}" if source.get("channel") else ""
    return folder / f"{stem}{channel} room tone {digest}.wav"


def make(source: dict[str, Any], folder: Path) -> dict[str, Any]:
    path, channel = source["path"], source.get("channel")
    if not os.path.isfile(path):
        raise RuntimeError("the file isn't there (is its drive attached?)")
    rate, channels, duration = probe(path)
    if channel and channel > channels:
        raise RuntimeError(f"it has {channels} channel(s), not {channel}")
    output = output_for(source, folder)
    meta = output.with_suffix(".json")
    if output.is_file() and meta.is_file():
        return {"output": str(output), **json.loads(meta.read_text()), "reused": True}

    whole_end = min(duration or MAX_ANALYSIS_SECONDS, MAX_ANALYSIS_SECONDS)
    start = max(0.0, float(source.get("start") or 0.0))
    end = min(float(source["end"]), whole_end) if source.get("end") is not None else whole_end
    found = search(path, start, end, channel, channels)
    if (found is None or found["contrastDb"] < QUIET_CONTRAST_DB) and (start > 0 or end < whole_end):
        # No real pause near the clip: the rest of the recording may have one.
        anywhere = search(path, 0.0, whole_end, channel, channels)
        if anywhere is not None and (found is None or anywhere["contrastDb"] > found["contrastDb"]):
            found = anywhere
    if found is None:
        raise RuntimeError("no stretch of room tone in it: it's too short, or silent throughout")

    sample = extract(path, found["sample"]["start"], found["sample"]["seconds"], rate, channel, channels)
    if len(sample) < rate * 0.25:
        raise RuntimeError("ffmpeg gave back too little of its sound")
    write_wav(loop_to(sample, round(source["seconds"] * rate), rate), rate, output)
    facts = {
        "duration": round(source["seconds"], 3),
        **found,
        "quiet": found["contrastDb"] >= QUIET_CONTRAST_DB,
    }
    meta.write_text(json.dumps(facts))
    return {"output": str(output), **facts, "reused": False}


def _seconds(value: Any, where: str, low: float, high: float) -> float:
    if not isinstance(value, (int, float)) or isinstance(value, bool) or not low <= value <= high:
        raise RequestError(f"{where} must be a number from {low:g} to {high:g}")
    return float(value)


def parse_request(request: dict[str, Any]) -> list[dict[str, Any]]:
    sources = request.get("sources")
    if not isinstance(sources, list) or not 1 <= len(sources) <= MAX_SOURCES:
        raise RequestError(f"sources must list 1 to {MAX_SOURCES} recordings")
    parsed: list[dict[str, Any]] = []
    for i, raw in enumerate(sources):
        if not isinstance(raw, dict):
            raise RequestError(f"sources[{i}] must be an object")
        require_absolute_paths([raw.get("path")], "media file")
        entry: dict[str, Any] = {"path": str(raw["path"])}
        entry["seconds"] = _seconds(raw.get("seconds"), f"sources[{i}].seconds", 1.0, MAX_SECONDS)
        channel = raw.get("channel")
        if channel is not None:
            if not isinstance(channel, int) or isinstance(channel, bool) or not 1 <= channel <= 32:
                raise RequestError(f"sources[{i}].channel must be a channel number from 1")
            entry["channel"] = channel
        for key in ("start", "end"):
            if raw.get(key) is not None:
                entry[key] = round(_seconds(raw[key], f"sources[{i}].{key}", 0.0, MAX_ANALYSIS_SECONDS), 3)
        if "start" in entry and "end" in entry and entry["end"] <= entry["start"]:
            raise RequestError(f"sources[{i}].end must be after its start")
        parsed.append(entry)
    return parsed


def run(request: dict[str, Any], emitter: Emitter) -> int:
    sources = parse_request(request)
    folder = Path(project_folder(request.get("project"))) / "Room tone"
    folder.mkdir(parents=True, exist_ok=True)
    files: list[dict[str, Any]] = []
    for i, source in enumerate(sources):
        emitter.progress(i, len(sources), phase="room tone", detail=Path(source["path"]).name)
        entry: dict[str, Any] = {"path": source["path"]}
        if source.get("channel"):
            entry["channel"] = source["channel"]
        try:
            entry.update(make(source, folder))
        except Exception as exc:  # noqa: BLE001 - one source that fails is reported, the rest still made
            entry["error"] = str(exc)
        files.append(entry)
    emitter.progress(len(sources), len(sources), phase="done", detail="")
    emitter.emit("result", files=files, folder=str(folder))
    return 0 if any("error" not in f for f in files) else 1
