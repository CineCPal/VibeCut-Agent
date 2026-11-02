"""The local speech-to-text worker (ORCHESTRATOR_SPEC.md §3.4 A, `transcribe_and_align`; PLAN.md, "Phase 21").

A file's transcript comes from its `<file>.ivt-cache.json` when that is still valid for the file (same size
and modified time); otherwise the file's sound is extracted by ffmpeg to a 16 kHz WAV in a temporary folder
and transcribed by the configured backend, holding the GPU lock:

- `mlx-whisper` (Apple Silicon; the `transcribe` extra), the same models as the `transcribe` command;
- `faster-whisper` (CTranslate2; the `orchestrator` extra), with a model tier or a path;
- `whisper.cpp` (`VIBECUT_WHISPER_CPP_BIN`, a ggml model file as `VIBECUT_WHISPER_MODEL`).

Speaker labels come from pyannote (transcribe/pipeline.py) when asked, with a Hugging Face token. A new
transcript is written back to the `.ivt-cache.json` in its shared format (VibeCut and its suite read it
too), so the next run, here or in the Transcribe tab, skips the work.

The result is `vibecut.whisper.v2`: every segment carries an exact `TimeRange` and SMPTE timecode at the
file's frame rate, and every word its first and last frame. A word's `probability` is Whisper's own when
this run transcribed it; a cached transcript doesn't keep it, so there each word has its segment's mean
token probability (exp of `avg_logprob`)."""

from __future__ import annotations

import gc
import importlib.util
import json
import math
import os
import shutil
import subprocess
import tempfile
from collections.abc import Callable, Mapping
from dataclasses import replace
from pathlib import Path
from typing import Any

from vibecut_agent.config import OrchestratorConfig
from vibecut_agent.core import ffmpeg_ops
from vibecut_agent.core.timecode_math import (
    exact_rate,
    rational_to_smpte,
    seconds_to_rational,
    time_range_from_seconds,
)
from vibecut_agent.orchestrator.schemas import WHISPER_VERSION
from vibecut_agent.transcribe import pipeline
from vibecut_agent.workers.base import GpuLock, WorkerHealth

BACKENDS = ("mlx-whisper", "faster-whisper", "whisper.cpp")
TIERS = ("tiny", "small", "medium", "large-v3")
MLX_MODELS = {tier: f"mlx-community/whisper-{tier}-mlx" for tier in TIERS}
# A file with no picture has no frame rate of its own; its frames are counted at this one.
AUDIO_ONLY_RATE = 30.0
CACHED_MODEL_ID = "ivt-cache"
WHISPER_CPP_TIMEOUT_S = 6 * 3600.0

# Segments and words as a backend gives them: seconds, text, and Whisper's confidence.
RawSegment = dict[str, Any]
Backend = Callable[[str, str], list[RawSegment]]
Progress = Callable[[str, float, str], None]


class WhisperWorkerError(RuntimeError):
    """The file couldn't be transcribed (no sound, backend missing or failed, bad request)."""


def _raw_word(text: Any, start: Any, end: Any, probability: Any = None) -> dict[str, Any] | None:
    word = str(text or "").strip()
    if not word or not isinstance(start, (int, float)) or not isinstance(end, (int, float)) or end <= start:
        return None
    entry: dict[str, Any] = {"start": float(start), "end": float(end), "text": word}
    if isinstance(probability, (int, float)):
        entry["probability"] = min(1.0, max(0.0, float(probability)))
    return entry


def mlx_backend(wav: str, model: str) -> list[RawSegment]:
    import mlx_whisper

    result = mlx_whisper.transcribe(wav, path_or_hf_repo=model, word_timestamps=True)
    segments: list[RawSegment] = []
    for seg in result.get("segments", []):
        words = [
            _raw_word(w.get("word"), w.get("start"), w.get("end"), w.get("probability"))
            for w in seg.get("words") or []
        ]
        segments.append(
            {
                "start": float(seg["start"]),
                "end": float(seg["end"]),
                "text": str(seg["text"]).strip(),
                "avg_logprob": float(seg.get("avg_logprob", 0.0)),
                "no_speech_prob": float(seg.get("no_speech_prob", 0.0)),
                "words": [w for w in words if w] or None,
            }
        )
    return segments


def faster_whisper_backend(wav: str, model: str) -> list[RawSegment]:
    from faster_whisper import WhisperModel

    whisper = WhisperModel(model, device="auto", compute_type="auto")
    try:
        found, _info = whisper.transcribe(wav, word_timestamps=True)
        segments: list[RawSegment] = []
        for seg in found:
            words = [_raw_word(w.word, w.start, w.end, w.probability) for w in seg.words or []]
            segments.append(
                {
                    "start": float(seg.start),
                    "end": float(seg.end),
                    "text": str(seg.text).strip(),
                    "avg_logprob": float(seg.avg_logprob),
                    "no_speech_prob": float(seg.no_speech_prob),
                    "words": [w for w in words if w] or None,
                }
            )
        return segments
    finally:
        del whisper
        gc.collect()


def parse_whisper_cpp(document: dict[str, Any]) -> list[RawSegment]:
    """Segments from whisper.cpp's full JSON (`-ojf`): each `transcription` entry's tokens, in ms, become
    words (a token starting with a space starts a new word; `[_...]` tokens are timing marks, not text)."""
    segments: list[RawSegment] = []
    for entry in document.get("transcription", []):
        offsets = entry.get("offsets") or {}
        groups: list[list[tuple[str, float, float, float]]] = []
        for token in entry.get("tokens", []):
            text = str(token.get("text", ""))
            if not text or text.startswith("[_"):
                continue
            span = token.get("offsets") or {}
            piece = (text, span.get("from", 0) / 1000, span.get("to", 0) / 1000, float(token.get("p", 1.0)))
            if not groups or text.startswith(" "):
                groups.append([piece])
            else:
                groups[-1].append(piece)
        words = [
            _raw_word(
                "".join(t for t, _, _, _ in group),
                group[0][1],
                group[-1][2],
                sum(p for _, _, _, p in group) / len(group),
            )
            for group in groups
        ]
        logprobs = [math.log(max(p, 1e-12)) for group in groups for _, _, _, p in group]
        segments.append(
            {
                "start": offsets.get("from", 0) / 1000,
                "end": offsets.get("to", 0) / 1000,
                "text": str(entry.get("text", "")).strip(),
                "avg_logprob": sum(logprobs) / len(logprobs) if logprobs else 0.0,
                "no_speech_prob": 0.0,
                "words": [w for w in words if w] or None,
            }
        )
    return segments


def whisper_cpp_backend(binary: str) -> Backend:
    def run(wav: str, model: str) -> list[RawSegment]:
        if not os.path.isfile(model):
            raise WhisperWorkerError(
                f"whisper.cpp needs a ggml model file; {model} isn't one (VIBECUT_WHISPER_MODEL)"
            )
        base = os.path.join(os.path.dirname(wav), "whisper-cpp")
        command = [binary, "-m", model, "-f", wav, "-ojf", "-of", base, "-np"]
        try:
            done = subprocess.run(command, capture_output=True, timeout=WHISPER_CPP_TIMEOUT_S, check=False)
        except FileNotFoundError:
            raise WhisperWorkerError(f"whisper.cpp isn't at {binary} (VIBECUT_WHISPER_CPP_BIN)") from None
        except subprocess.TimeoutExpired:
            raise WhisperWorkerError("whisper.cpp took too long") from None
        if done.returncode != 0:
            raise WhisperWorkerError(
                f"whisper.cpp failed: {done.stderr.decode(errors='ignore').strip()[-300:]}"
            )
        with open(f"{base}.json", encoding="utf-8") as f:
            return parse_whisper_cpp(json.load(f))

    return run


def to_v2(
    data: Mapping[str, Any],
    path: str,
    rate: float,
    backend: str,
    model_id: str,
    raw_segments: list[Any] | None = None,
) -> dict[str, Any]:
    """A `vibecut.whisper.v2` result from transcript data in the `.ivt-cache.json` shape. `raw_segments`
    (pipeline Segments with Whisper's word probabilities) take the place of `data["segments"]`."""
    stat = os.stat(path)
    segments: list[dict[str, Any]] = []
    source = raw_segments if raw_segments is not None else pipeline.segments_from_cache(dict(data))
    fps = float(exact_rate(rate))
    for index, seg in enumerate(source):
        start, end = float(seg.start), max(float(seg.end), float(seg.start))
        fallback = min(1.0, max(0.0, math.exp(min(0.0, float(seg.avg_logprob)))))
        words = []
        for word in seg.words or []:
            first = math.floor(word["start"] * fps)
            words.append(
                {
                    "text": word["text"],
                    "start": round(word["start"], 3),
                    "end": round(word["end"], 3),
                    "start_frame": first,
                    "end_frame": max(first + 1, math.ceil(word["end"] * fps)),
                    "probability": round(word.get("probability", fallback), 4),
                }
            )
        segments.append(
            {
                "segment_id": f"seg_{index:05d}",
                "start": round(start, 3),
                "end": round(end, 3),
                "start_tc": rational_to_smpte(seconds_to_rational(start, rate)),
                "end_tc": rational_to_smpte(seconds_to_rational(end, rate)),
                "source_range": time_range_from_seconds(start, end, rate),
                "text": seg.text,
                "speaker": seg.speaker,
                "avg_logprob": float(seg.avg_logprob),
                "no_speech_prob": float(seg.no_speech_prob),
                "low_confidence": pipeline.is_low_confidence(seg),
                "words": words,
            }
        )
    return {
        "schema_version": WHISPER_VERSION,
        "path": path,
        "name": str(data.get("name") or os.path.basename(path)),
        "video_size": stat.st_size,
        "video_mtime": int(stat.st_mtime),
        "media_fps": rate,
        "backend": backend,
        "model_id": model_id,
        "speakers": list(data.get("speakers") or []),
        "speaker_labels": dict(data.get("speaker_labels") or {}),
        "excluded_speakers": list(data.get("excluded_speakers") or []),
        "segments": segments,
    }


def frame_rate(media_path: str) -> float:
    """The file's picture rate, or AUDIO_ONLY_RATE for a file with no picture."""
    try:
        return ffmpeg_ops.media_rate(media_path)
    except ffmpeg_ops.FfmpegOpError:
        return AUDIO_ONLY_RATE


def in_window(result: dict[str, Any], start: float | None, end: float | None) -> dict[str, Any]:
    """`result` with only the segments that overlap [start, end) seconds."""
    if start is None and end is None:
        return result
    low = start or 0.0
    high = math.inf if end is None else end
    return {**result, "segments": [s for s in result["segments"] if s["end"] > low and s["start"] < high]}


class WhisperWorker:
    name = "whisper"

    def __init__(
        self,
        config: OrchestratorConfig,
        lock: GpuLock | None = None,
        backends: Mapping[str, Backend] | None = None,
    ) -> None:
        if config.whisper_backend not in BACKENDS:
            raise WhisperWorkerError(f"VIBECUT_WHISPER_BACKEND must be one of {', '.join(BACKENDS)}")
        self.config = config
        self.backend = config.whisper_backend
        self.lock = lock or GpuLock.for_config(config)
        self.backends: Mapping[str, Backend] = backends or {
            "mlx-whisper": mlx_backend,
            "faster-whisper": faster_whisper_backend,
            "whisper.cpp": whisper_cpp_backend(config.whisper_cpp_bin),
        }

    def model_for(self, tier: str | None) -> str:
        """The model this backend loads for a tier (or the configured one): an mlx-community repo for
        mlx-whisper, a tier name (or the configured path) for faster-whisper, a ggml file for whisper.cpp."""
        if tier is not None and tier not in TIERS:
            raise WhisperWorkerError(f"model_tier must be one of {', '.join(TIERS)}")
        configured = self.config.whisper_model
        if self.backend == "mlx-whisper":
            return MLX_MODELS[tier] if tier else configured
        if self.backend == "faster-whisper":
            if tier:
                return tier
            # The default (an mlx-community repo) means nothing to faster-whisper.
            return "medium" if configured.startswith("mlx-community/") else configured
        if tier:
            sibling = Path(configured).with_name(f"ggml-{tier}.bin")
            if sibling.is_file():
                return str(sibling)
        return configured

    def health(self) -> WorkerHealth:
        model = self.model_for(None)
        if shutil.which("ffmpeg") is None:
            available, detail = False, "ffmpeg isn't installed"
        elif self.backend == "whisper.cpp":
            ready = os.path.isfile(self.config.whisper_cpp_bin) and os.path.isfile(model)
            available = ready
            detail = "ready" if ready else f"needs {self.config.whisper_cpp_bin} and a ggml model at {model}"
        else:
            module = "mlx_whisper" if self.backend == "mlx-whisper" else "faster_whisper"
            available = importlib.util.find_spec(module) is not None
            extra = "transcribe" if self.backend == "mlx-whisper" else "orchestrator"
            detail = "ready" if available else f"{self.backend} isn't installed (the `{extra}` extra)"
        return {
            "worker": self.name,
            "backend": self.backend,
            "model": model,
            "available": available,
            "detail": detail,
        }

    def cached(self, media_path: str, rate: float | None = None) -> dict[str, Any] | None:
        """The file's transcript from its `.ivt-cache.json` when that is still valid, else None. VibeCut's
        transcriber (mlx-whisper) wrote it; which model isn't recorded."""
        data = pipeline.load_cache(media_path)
        if data is None:
            return None
        rate = rate if rate is not None else frame_rate(media_path)
        return to_v2(data, media_path, rate, "mlx-whisper", CACHED_MODEL_ID)

    def transcribe(
        self,
        media_path: str,
        *,
        model_tier: str | None = None,
        enable_diarization: bool = False,
        hf_token: str | None = None,
        start: float | None = None,
        end: float | None = None,
        rate: float | None = None,
        use_cache: bool = True,
        on_progress: Progress | None = None,
    ) -> dict[str, Any]:
        """The file's `vibecut.whisper.v2` transcript, limited to the segments overlapping [start, end) when
        those are given. The whole file is transcribed (and cached) either way."""
        if not os.path.isabs(media_path):
            raise WhisperWorkerError(f"{media_path!r} isn't an absolute path")
        if not os.path.isfile(media_path):
            raise WhisperWorkerError(f"{media_path} isn't there (is its drive attached?)")
        if start is not None and end is not None and end <= start:
            raise WhisperWorkerError("end must be after start")
        if enable_diarization and not hf_token:
            raise WhisperWorkerError("Telling speakers apart needs a Hugging Face token")
        rate = rate if rate is not None else frame_rate(media_path)
        cached = self.cached(media_path, rate) if use_cache else None
        if cached is not None:
            return in_window(cached, start, end)
        model = self.model_for(model_tier)
        segments, speakers = self._run(media_path, model, enable_diarization, hf_token, on_progress)
        name = os.path.basename(media_path)
        cache_segments = [replace(s, words=pipeline.clean_words(s.words)) for s in segments]
        pipeline.write_cache(media_path, name, cache_segments, speakers)
        data = {"name": name, "speakers": speakers, "speaker_labels": {}, "excluded_speakers": []}
        return in_window(to_v2(data, media_path, rate, self.backend, model, segments), start, end)

    def _run(
        self,
        media_path: str,
        model: str,
        enable_diarization: bool,
        hf_token: str | None,
        on_progress: Progress | None,
    ) -> tuple[list[Any], list[str]]:
        def report(phase: str, fraction: float, detail: str) -> None:
            if on_progress is not None:
                on_progress(phase, fraction, detail)

        folder = tempfile.mkdtemp(prefix="vibecut_whisper_")
        try:
            wav = os.path.join(folder, "audio.wav")
            report("extract", 0.0, "Extracting the sound")
            try:
                pipeline.extract_audio(media_path, wav)
            except RuntimeError as e:
                raise WhisperWorkerError(str(e)) from None
            report("transcribe", 0.0, f"Transcribing with {self.backend}")
            with self.lock:
                raw = self.backends[self.backend](wav, model)
                turns: list[Any] = []
                if enable_diarization:
                    report("diarize", 0.0, "Telling speakers apart")
                    turns = pipeline.diarize_audio(wav, hf_token or "")
            segments, order = pipeline.merge_transcript_and_speakers(raw, turns)
            names = pipeline.normalize_speaker_names(order)
            for seg in segments:
                seg.speaker = names.get(seg.speaker, seg.speaker)
            report("transcribe", 1.0, "Transcribed")
            return segments, list(names.values()) or ["Speaker 1"]
        finally:
            shutil.rmtree(folder, ignore_errors=True)
            gc.collect()
