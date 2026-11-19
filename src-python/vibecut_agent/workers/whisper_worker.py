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
token probability (exp of `avg_logprob`).

Each new transcript is checked against the sound before it is cached (transcribe/alignment.py, PLAN.md
"Transcription recall + alignment"): speech Whisper left out is transcribed again (mlx-whisper and
faster-whisper, through `clip_backends`; whisper.cpp has none, so it gets the rest only), lines made up over
silence are dropped, line edges go onto the sound, and times are moved by the audio stream's start offset.
A cache from before that is brought up to it once, by `pipeline.upgrade_cache`, holding the GPU lock."""

from __future__ import annotations

import contextlib
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
from vibecut_agent.transcribe import alignment, audio_cache, pipeline
from vibecut_agent.workers.base import GpuLock, WorkerHealth

BACKENDS = ("mlx-whisper", "faster-whisper", "whisper.cpp")
TIERS = ("tiny", "small", "medium", "large-v3-turbo", "large-v3")
# Each tier's model per backend (model migration v2 added large-v3-turbo, whose repos don't follow the
# others' names). faster-whisper takes the tier names it knows, and the turbo repo by name.
MLX_MODELS = {
    "tiny": "mlx-community/whisper-tiny-mlx",
    "small": "mlx-community/whisper-small-mlx",
    "medium": "mlx-community/whisper-medium-mlx",
    "large-v3-turbo": "mlx-community/whisper-large-v3-turbo",
    "large-v3": "mlx-community/whisper-large-v3-mlx",
}
FASTER_WHISPER_MODELS = {
    **{tier: tier for tier in TIERS},
    "large-v3-turbo": "deepdml/faster-whisper-large-v3-turbo-ct2",
}
WHISPER_CPP_MODELS = {tier: f"ggml-{tier}.bin" for tier in TIERS}
# A file with no picture has no frame rate of its own; its frames are counted at this one.
AUDIO_ONLY_RATE = 30.0
CACHED_MODEL_ID = "ivt-cache"
WHISPER_CPP_TIMEOUT_S = 6 * 3600.0

# Segments and words as a backend gives them: seconds, text, and Whisper's confidence.
RawSegment = dict[str, Any]
Backend = Callable[[str, str], list[RawSegment]]
# Whisper over only some stretches of the WAV: (wav, model, [(start, end)] seconds, language or None).
ClipBackend = Callable[[str, str, list[tuple[float, float]], str | None], list[RawSegment]]
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


def _mlx_segments(result: dict[str, Any]) -> list[RawSegment]:
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
                "language": result.get("language"),
            }
        )
    return segments


def mlx_backend(wav: str, model: str) -> list[RawSegment]:
    import mlx_whisper

    result = mlx_whisper.transcribe(
        wav, path_or_hf_repo=model, word_timestamps=True, **pipeline.DECODE_OPTIONS
    )
    return _mlx_segments(result)


def mlx_clip_backend(
    wav: str, model: str, clips: list[tuple[float, float]], language: str | None
) -> list[RawSegment]:
    import mlx_whisper

    result = mlx_whisper.transcribe(
        wav,
        path_or_hf_repo=model,
        word_timestamps=True,
        clip_timestamps=[round(float(t), 3) for clip in clips for t in clip],
        language=language,
        **pipeline.RECOVERY_OPTIONS,
    )
    return _mlx_segments(result)


# faster-whisper models loaded in this process, by name (model migration v2): an ingest of many files
# loads its model once, not once per file. A sidecar process is one job, so the model goes when it ends.
_FASTER_WHISPER_CACHE: dict[str, Any] = {}


def _faster_whisper_model(model: str) -> Any:
    whisper = _FASTER_WHISPER_CACHE.get(model)
    if whisper is None:
        from faster_whisper import WhisperModel

        whisper = WhisperModel(model, device="auto", compute_type="auto")
        _FASTER_WHISPER_CACHE.clear()
        _FASTER_WHISPER_CACHE[model] = whisper
    return whisper


def faster_whisper_backend(wav: str, model: str) -> list[RawSegment]:
    # Its own VAD filter is off: alignment.py's pass does that job for every backend alike.
    found, info = _faster_whisper_model(model).transcribe(
        wav, word_timestamps=True, vad_filter=False, **pipeline.DECODE_OPTIONS
    )
    return _faster_segments(found, info)


def faster_whisper_clip_backend(
    wav: str, model: str, clips: list[tuple[float, float]], language: str | None
) -> list[RawSegment]:
    found, info = _faster_whisper_model(model).transcribe(
        wav,
        word_timestamps=True,
        vad_filter=False,
        clip_timestamps=[round(float(t), 3) for clip in clips for t in clip],
        language=language,
        **pipeline.RECOVERY_OPTIONS,
    )
    return _faster_segments(found, info)


def _faster_segments(found: Any, info: Any) -> list[RawSegment]:
    language = getattr(info, "language", None)
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
                "language": language,
            }
        )
    return segments


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
        # Its output (and, for the kept FLAC, a WAV it can read) goes in a folder of its own, never next to
        # the kept sound.
        folder = tempfile.mkdtemp(prefix="vibecut_whisper_cpp_")
        try:
            try:
                source = audio_cache.as_wav(wav, folder)
            except RuntimeError as e:
                raise WhisperWorkerError(str(e)) from None
            base = os.path.join(folder, "whisper-cpp")
            command = [binary, "-m", model, "-f", source, "-ojf", "-of", base, "-np"]
            try:
                done = subprocess.run(
                    command, capture_output=True, timeout=WHISPER_CPP_TIMEOUT_S, check=False
                )
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
        finally:
            shutil.rmtree(folder, ignore_errors=True)

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


def tier_of_model(model: str) -> str | None:
    """The tier a model name is of (`mlx-community/whisper-large-v3-turbo` is large-v3-turbo), or None.
    large-v3-turbo is checked before large-v3, whose name it contains."""
    name = Path(model).name.lower()
    for tier in sorted(TIERS, key=len, reverse=True):
        if f"-{tier}" in name or name == tier or name.startswith(f"{tier}-"):
            return tier
    return None


class WhisperWorker:
    name = "whisper"

    def __init__(
        self,
        config: OrchestratorConfig,
        lock: GpuLock | None = None,
        backends: Mapping[str, Backend] | None = None,
        clip_backends: Mapping[str, ClipBackend] | None = None,
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
        # Recovering missed speech needs Whisper on chosen stretches; whisper.cpp isn't wired for that.
        # Backends given without clip backends (tests) recover nothing.
        default_clips = {"mlx-whisper": mlx_clip_backend, "faster-whisper": faster_whisper_clip_backend}
        self.clip_backends: Mapping[str, ClipBackend] = (
            clip_backends if clip_backends is not None else ({} if backends else default_clips)
        )

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
                return FASTER_WHISPER_MODELS[tier]
            # The default (an mlx-community repo) means nothing to faster-whisper: its own of that tier.
            if configured.startswith("mlx-community/"):
                return FASTER_WHISPER_MODELS[tier_of_model(configured) or "large-v3-turbo"]
            return configured
        if tier:
            sibling = Path(configured).with_name(WHISPER_CPP_MODELS[tier])
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
        model = self.model_for(model_tier)
        if use_cache:
            self._upgrade(media_path, model, on_progress)
        cached = self.cached(media_path, rate) if use_cache else None
        if cached is not None:
            return in_window(cached, start, end)
        segments, speakers, aligned, language = self._run(
            media_path, model, enable_diarization, hf_token, on_progress
        )
        name = os.path.basename(media_path)
        cache_segments = [replace(s, words=pipeline.clean_words(s.words)) for s in segments]
        marker = pipeline.ALIGNMENT_VERSION if aligned else None
        pipeline.write_cache(media_path, name, cache_segments, speakers, alignment=marker, language=language)
        data = {"name": name, "speakers": speakers, "speaker_labels": {}, "excluded_speakers": []}
        return in_window(to_v2(data, media_path, rate, self.backend, model, segments), start, end)

    def _clip_backend(self, model: str) -> pipeline.ClipBackend | None:
        clips = self.clip_backends.get(self.backend)
        if clips is None:
            return None
        return lambda wav, stretches, language: clips(wav, model, stretches, language)

    def _upgrade(self, media_path: str, model: str, on_progress: Progress | None) -> None:
        """A cache from before ALIGNMENT_VERSION checked against the sound, once (pipeline.upgrade_cache);
        when that can't be done the old cache stands."""
        data = pipeline.load_cache(media_path)
        if not pipeline.needs_upgrade(data):
            return
        assert data is not None
        report = self._extract_report(on_progress)
        try:
            # Extracted (and kept) before the GPU lock is taken: reading a long file off a drive needs no GPU.
            with audio_cache.audio_for(media_path, report):
                pass
        except (OSError, RuntimeError):
            return  # the media can't be read: the old cache stands
        with self.lock:
            pipeline.upgrade_cache(media_path, data, self._clip_backend(model), on_progress)

    @staticmethod
    def _extract_report(on_progress: Progress | None) -> Callable[[float, str], None] | None:
        if on_progress is None:
            return None
        return lambda fraction, detail: on_progress("extract", fraction, detail)

    def _run(
        self,
        media_path: str,
        model: str,
        enable_diarization: bool,
        hf_token: str | None,
        on_progress: Progress | None,
    ) -> tuple[list[Any], list[str], bool, str | None]:
        def report(phase: str, fraction: float, detail: str) -> None:
            if on_progress is not None:
                on_progress(phase, fraction, detail)

        try:
            report("extract", 0.0, "Extracting the sound")
            with contextlib.ExitStack() as stack:
                try:
                    audio = stack.enter_context(
                        audio_cache.audio_for(media_path, self._extract_report(on_progress))
                    )
                except RuntimeError as e:
                    raise WhisperWorkerError(str(e)) from None
                report("transcribe", 0.0, f"Transcribing with {self.backend}")
                with self.lock:
                    raw = self.backends[self.backend](audio, model)
                    language = next((s.get("language") for s in raw if s.get("language")), None)
                    report("align", 0.0, "Checking the transcript against the sound")
                    aligned = True
                    try:
                        raw = pipeline.align_raw(
                            audio,
                            raw,
                            self._clip_backend(model),
                            language,
                            lambda fraction, detail: report("align", fraction, detail),
                        )
                    except Exception:  # noqa: BLE001 - best effort: Whisper's own times are kept, and retried later
                        aligned = False
                    turns: list[Any] = []
                    if enable_diarization:
                        report("diarize", 0.0, "Telling speakers apart")
                        turns = pipeline.diarize_audio(audio, hf_token or "")
            segments, order = pipeline.merge_transcript_and_speakers(raw, turns)
            names = pipeline.normalize_speaker_names(order)
            for seg in segments:
                seg.speaker = names.get(seg.speaker, seg.speaker)
            if aligned:
                segments = alignment.shift(segments, pipeline.audio_offset(media_path))
            report("transcribe", 1.0, "Transcribed")
            return segments, list(names.values()) or ["Speaker 1"], aligned, language
        finally:
            gc.collect()
