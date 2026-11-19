"""A file's sound as Whisper hears it, extracted once (PLAN.md, "Long files: transcripts that read back").

Extracting the sound means ffmpeg reading the whole video: 54 GB for a two-hour camera file on an external
drive, many minutes, every time a file is transcribed, upgraded or re-transcribed. So the 16 kHz mono sound
is kept as FLAC (about 60 MB an hour) in the app's data folder, keyed by the video's path, size and modified
time, and reused until the video changes. The folder is trimmed to AUDIO_CACHE_MAX_BYTES, oldest-used first.

Extraction reports its progress (ffmpeg's `-progress`), and its time limit grows with the file: a slow drive
moving a huge file is not a hang. A folder that can't be written falls back to a temporary file."""

from __future__ import annotations

import contextlib
import hashlib
import os
import shutil
import subprocess
import tempfile
import threading
from collections.abc import Callable, Iterator
from pathlib import Path

SAMPLE_RATE = 16000
AUDIO_CACHE_MAX_BYTES = 4 * 1024**3
# The time ffmpeg is given: at least 30 minutes, more for a big file on a slow drive (8 MB/s) or a long one.
MIN_EXTRACT_TIMEOUT_S = 1800.0
SLOW_DRIVE_BYTES_PER_S = 8 * 1024**2
Progress = Callable[[float, str], None]


def cache_dir() -> Path:
    """VIBECUT_AUDIO_CACHE_DIR, else `audio-cache` in the app's data folder (next to the vector index)."""
    configured = os.environ.get("VIBECUT_AUDIO_CACHE_DIR")
    if configured:
        return Path(configured)
    return Path.home() / "Library" / "Application Support" / "VibeCut Agent" / "audio-cache"


def cache_key(video_path: str) -> str:
    stat = os.stat(video_path)
    identity = f"{os.path.realpath(video_path)}|{stat.st_size}|{stat.st_mtime_ns}"
    return hashlib.sha1(identity.encode("utf-8")).hexdigest()


def extract_timeout(video_path: str, duration: float | None) -> float:
    try:
        size = os.path.getsize(video_path)
    except OSError:
        size = 0
    return max(MIN_EXTRACT_TIMEOUT_S, size / SLOW_DRIVE_BYTES_PER_S, (duration or 0.0) * 0.5)


def _duration(path: str) -> float | None:
    from vibecut_agent.broll import ffprobe_util

    return ffprobe_util.probe_duration_seconds(path)


def extract(video_path: str, out_path: str, on_progress: Progress | None = None) -> None:
    """The file's first audio stream, mono 16 kHz, to `out_path` (FLAC for `.flac`, else 16-bit WAV).
    RuntimeError when ffmpeg fails or runs past `extract_timeout`."""
    duration = _duration(video_path)
    timeout = extract_timeout(video_path, duration)
    codec = "flac" if out_path.endswith(".flac") else "pcm_s16le"
    command = [
        *("ffmpeg", "-hide_banner", "-nostdin", "-nostats", "-y", "-i", video_path),
        # The first audio stream, the one an editor plays (not ffmpeg's pick of the "best").
        *("-map", "0:a:0", "-vn", "-sn", "-dn"),
        *("-c:a", codec, "-ar", str(SAMPLE_RATE), "-ac", "1"),
        *("-progress", "pipe:1", out_path),
    ]
    timed_out = threading.Event()
    with tempfile.TemporaryFile() as errors:
        process = subprocess.Popen(command, stdout=subprocess.PIPE, stderr=errors, text=True)

        def kill() -> None:
            timed_out.set()
            process.kill()

        watchdog = threading.Timer(timeout, kill)
        watchdog.start()
        try:
            assert process.stdout is not None
            for line in process.stdout:
                key, _, value = line.strip().partition("=")
                if key == "out_time_us" and duration and on_progress is not None and value.isdigit():
                    fraction = min(1.0, int(value) / 1e6 / duration)
                    on_progress(fraction, f"Extracting the sound… {int(fraction * 100)}%")
            code = process.wait()
        finally:
            watchdog.cancel()
            if process.poll() is None:
                process.kill()
                process.wait()
        if timed_out.is_set():
            raise RuntimeError(
                f"ffmpeg did not finish extracting the sound from {os.path.basename(video_path)} within "
                f"{timeout / 60:.0f} minutes (is its drive slow or asleep?)"
            )
        if code != 0:
            errors.seek(0)
            raise RuntimeError(f"ffmpeg failed: {errors.read().decode(errors='ignore')[-500:]}")
    if on_progress is not None:
        on_progress(1.0, "Extracted the sound")


def _prune(folder: Path, keep: Path) -> None:
    """Oldest-used first until the folder holds at most AUDIO_CACHE_MAX_BYTES (never `keep`)."""
    try:
        files = [p for p in folder.glob("*.flac") if p != keep]
        total = sum(p.stat().st_size for p in files) + (keep.stat().st_size if keep.exists() else 0)
        for path in sorted(files, key=lambda p: p.stat().st_mtime):
            if total <= AUDIO_CACHE_MAX_BYTES:
                break
            total -= path.stat().st_size
            path.unlink(missing_ok=True)
    except OSError:
        pass


def cached(video_path: str) -> Path | None:
    """The kept sound of `video_path`, if there is one for its current size and modified time."""
    try:
        path = cache_dir() / f"{cache_key(video_path)}.flac"
    except OSError:
        return None
    return path if path.is_file() else None


@contextlib.contextmanager
def audio_for(video_path: str, on_progress: Progress | None = None) -> Iterator[str]:
    """The path of the file's sound as Whisper hears it: the kept FLAC (extracted now if needed), or a
    temporary WAV, removed afterwards, when the cache folder can't be written."""
    kept = cached(video_path)
    if kept is not None:
        with contextlib.suppress(OSError):
            os.utime(kept)  # most recently used: kept longest
        yield str(kept)
        return
    folder = cache_dir()
    try:
        folder.mkdir(parents=True, exist_ok=True)
        target = folder / f"{cache_key(video_path)}.flac"
        partial = folder / f"{target.stem}.{os.getpid()}.partial.flac"
        writable = os.access(folder, os.W_OK)
    except OSError:
        writable = False
    if writable:
        try:
            extract(video_path, str(partial), on_progress)
            os.replace(partial, target)
        finally:
            partial.unlink(missing_ok=True)
        _prune(folder, target)
        yield str(target)
        return
    temporary = tempfile.mkdtemp(prefix="vibecut_audio_")
    try:
        wav = os.path.join(temporary, "audio.wav")
        extract(video_path, wav, on_progress)
        yield wav
    finally:
        shutil.rmtree(temporary, ignore_errors=True)


def as_wav(audio_path: str, folder: str) -> str:
    """`audio_path` as a 16-bit WAV in `folder` (for whisper.cpp, which reads only WAV); itself if it is one."""
    if audio_path.endswith(".wav"):
        return audio_path
    wav = os.path.join(folder, "audio.wav")
    done = subprocess.run(
        ["ffmpeg", "-v", "error", "-nostdin", "-y", "-i", audio_path, "-c:a", "pcm_s16le", wav],
        capture_output=True,
        timeout=MIN_EXTRACT_TIMEOUT_S,
        check=False,
    )
    if done.returncode != 0:
        raise RuntimeError(f"ffmpeg failed: {done.stderr.decode(errors='ignore')[-300:]}")
    return wav
