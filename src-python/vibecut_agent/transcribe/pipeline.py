"""The transcription pipeline (PLAN.md, "Phase 6b"), VibeCut's interview-transcriber/pipeline.py verbatim:
mlx-whisper on Apple Silicon, optional pyannote speaker labels, and the `<video>.ivt-cache.json` cache that
VibeCut, its suite and VibeCut Agent share. Heavy models load only inside the functions that use them.

Changed here (PLAN.md, "Transcription recall + alignment"): Whisper decodes without conditioning on its
previous text; the sound comes from the file's first audio stream; each transcript is then checked against
the sound (transcribe/alignment.py: missed speech recovered, lines made up over silence dropped, line edges
on the sound) and moved by the audio stream's start offset, so its times count from the picture's first
frame. The cache records that as `"alignment": ALIGNMENT_VERSION`; `upgrade_cache` brings an older cache up
to it without transcribing the whole file again.

Long files (PLAN.md, "Long files: transcripts that read back"): the sound is extracted once and kept
(audio_cache.py), with progress and a time limit that grows with the file; the transcript's language is
kept in the cache and every second look at missed speech is held to it; no number that isn't finite is ever
written (a bare `NaN` makes the whole cache unreadable to the app's reader)."""

import gc
import json
import math
import os
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import NamedTuple

CACHE_SUFFIX = ".ivt-cache.json"

WHISPER_MODELS = {
    "Fast (tiny, lower accuracy)": "mlx-community/whisper-tiny-mlx",
    "Balanced (small)": "mlx-community/whisper-small-mlx",
    "Medium": "mlx-community/whisper-medium-mlx",
    # Model migration v2: large-v3's word timings with a 4-layer decoder, 3-4x faster than large-v3 on
    # Apple Silicon, and faster than medium too.
    "Recommended (large-v3-turbo)": "mlx-community/whisper-large-v3-turbo",
    "Best quality (large-v3)": "mlx-community/whisper-large-v3-mlx",
}
# What a request that names no model gets.
DEFAULT_MODEL = WHISPER_MODELS["Recommended (large-v3-turbo)"]

# The cache's `alignment` value once its times have been checked against the sound (alignment.py) and
# moved by the audio offset. A cache without it is brought up to it by `upgrade_cache`.
ALIGNMENT_VERSION = 1
# Whisper's decoding for a whole file: not conditioned on its own previous text (which loops, or skips
# what follows a mistake), and silence around a likely hallucination skipped (word timestamps are on).
DECODE_OPTIONS = {"condition_on_previous_text": False, "hallucination_silence_threshold": 2.0}
# Its second look at speech it left out (alignment.recover_missed): nothing skipped as silence or for a
# low score, since the VAD already found speech there.
RECOVERY_OPTIONS = {
    "condition_on_previous_text": False,
    "no_speech_threshold": None,
    "logprob_threshold": None,
}
# Transcribes only some stretches of a WAV: (wav, [(start, end)] seconds, language or None) -> raw segments.
ClipBackend = Callable[[str, list, "str | None"], list]
# What a score Whisper couldn't compute (NaN, infinite) is stored as: plainly low confidence.
NONFINITE_AVG_LOGPROB = -10.0
NONFINITE_NO_SPEECH_PROB = 1.0
# How much of a line the language is detected from, when an older cache doesn't record it.
LANGUAGE_SAMPLE_S = 30.0


def finite(value, default: float) -> float:
    """`value` as a float when it is a finite number, else `default`."""
    try:
        number = float(value)
    except (TypeError, ValueError):
        return default
    return number if math.isfinite(number) else default


class TranscribeResult(NamedTuple):
    segments: list
    speakers: list
    aligned: bool  # checked against the sound (alignment.py); False when that failed
    language: "str | None"


@dataclass
class Segment:
    start: float
    end: float
    text: str
    speaker: str = "Speaker 0"
    avg_logprob: float = 0.0  # Whisper's average log-probability for this segment
    no_speech_prob: float = 0.0  # Whisper's probability this segment is actually silence/noise
    # Per-word timings, [{"start", "end", "text"}] in source seconds, or None when unknown (a
    # transcript cached before words were recorded, or a line whose text was edited by hand).
    words: list | None = field(default=None)


# Heuristic thresholds for flagging segments worth double-checking
# against the audio — not a hard error, just a signal.
LOW_CONFIDENCE_AVG_LOGPROB = -1.0
LOW_CONFIDENCE_NO_SPEECH_PROB = 0.6


def is_low_confidence(seg: "Segment") -> bool:
    return seg.avg_logprob < LOW_CONFIDENCE_AVG_LOGPROB or seg.no_speech_prob > LOW_CONFIDENCE_NO_SPEECH_PROB


def _cache_path(video_path: str) -> str:
    """Cache file lives right next to the video, e.g.
    'interview.mp4' -> 'interview.mp4.ivt-cache.json'."""
    return video_path + CACHE_SUFFIX


def load_cache(video_path: str):
    """Return cached data for a video, or None if there's no cache file
    or the video has changed size/modified-time since it was cached."""
    path = _cache_path(video_path)
    if not os.path.exists(path):
        return None
    try:
        with open(path, "r", encoding="utf-8") as f:
            data = json.load(f)
    except Exception:
        return None

    try:
        stat = os.stat(video_path)
        if data.get("video_size") != stat.st_size or data.get("video_mtime") != int(stat.st_mtime):
            return None  # video changed since this cache was written
    except OSError:
        pass

    return data


def fmt_timecode(seconds: float) -> str:
    seconds = max(0, int(seconds))
    h, rem = divmod(seconds, 3600)
    m, s = divmod(rem, 60)
    return f"{h:02d}:{m:02d}:{s:02d}"


def fmt_srt_time(seconds: float) -> str:
    total_ms = max(0, round(seconds * 1000))
    h, rem = divmod(total_ms, 3600000)
    m, rem = divmod(rem, 60000)
    s, ms = divmod(rem, 1000)
    return f"{h:02d}:{m:02d}:{s:02d},{ms:03d}"


def fmt_vtt_time(seconds: float) -> str:
    total_ms = max(0, round(seconds * 1000))
    h, rem = divmod(total_ms, 3600000)
    m, rem = divmod(rem, 60000)
    s, ms = divmod(rem, 1000)
    return f"{h:02d}:{m:02d}:{s:02d}.{ms:03d}"


def extract_audio(video_path: str, out_path: str, on_progress=None) -> None:
    """Pull only the first audio stream to a mono 16 kHz file (WAV, or FLAC for `.flac`), which
    mlx-whisper and pyannote both read. No copy of the video itself is made. `on_progress(fraction,
    detail)` follows ffmpeg; the time limit grows with the file (audio_cache.extract_timeout)."""
    from vibecut_agent.transcribe import audio_cache

    audio_cache.extract(video_path, out_path, on_progress)


def transcribe_audio(audio_path: str, model_repo: str, progress_callback=None) -> list:
    """Run mlx-whisper (Apple Metal accelerated). Returns a list of dicts:
    {"start": float, "end": float, "text": str, "avg_logprob": float, "no_speech_prob": float}
    The confidence fields are used to flag segments worth double-checking.

    If `progress_callback` is given, it's called with a float in [0, 1] as
    transcription advances. mlx_whisper has no public progress API, so this
    works by temporarily swapping out the `tqdm.tqdm` class that its
    `transcribe()` reads its progress bar from (`mlx_whisper.transcribe`
    does `import tqdm` and calls `tqdm.tqdm(...)`, which is the same tqdm
    module object everywhere in the process — not a private copy). This is
    safe here specifically because processing is strictly single-threaded
    and sequential (see module docstring / SETUP.md): the patch is applied
    and reverted entirely within this one synchronous call, before
    diarization (which also uses tqdm, via pyannote) even starts."""
    import mlx_whisper
    import tqdm as _tqdm_module

    if progress_callback is None:
        result = mlx_whisper.transcribe(
            audio_path,
            path_or_hf_repo=model_repo,
            word_timestamps=True,
            **DECODE_OPTIONS,
        )
    else:
        original_tqdm_cls = _tqdm_module.tqdm

        class _ProgressReportingTqdm(original_tqdm_cls):  # type: ignore[misc,valid-type]  # tqdm, patched for one call
            def update(self, n=1):
                ret = super().update(n)
                if self.total:
                    try:
                        progress_callback(min(1.0, self.n / self.total))
                    except Exception:
                        pass
                return ret

        _tqdm_module.tqdm = _ProgressReportingTqdm
        try:
            # verbose=False (not None) is required for mlx_whisper's internal
            # progress bar to be non-disabled (see its `disable=verbose is not
            # False`), so our patched `update()` actually gets called. False
            # (vs True) also keeps it from printing each segment's text.
            result = mlx_whisper.transcribe(
                audio_path,
                path_or_hf_repo=model_repo,
                word_timestamps=True,
                verbose=False,
                **DECODE_OPTIONS,
            )
        finally:
            _tqdm_module.tqdm = original_tqdm_cls

    return [
        {
            "start": seg["start"],
            "end": seg["end"],
            "text": seg["text"].strip(),
            "avg_logprob": seg.get("avg_logprob", 0.0),
            "no_speech_prob": seg.get("no_speech_prob", 0.0),
            "words": clean_words(seg.get("words")),
            "language": result.get("language"),
        }
        for seg in result.get("segments", [])
    ]


def transcribe_clips(audio_path: str, model_repo: str, clips: list, language: str | None = None) -> list:
    """mlx-whisper over only `clips` ([(start, end)] seconds) of the audio, with RECOVERY_OPTIONS: the
    same dicts as `transcribe_audio`, their times in the whole file's seconds."""
    import mlx_whisper

    if not clips:
        return []
    result = mlx_whisper.transcribe(
        audio_path,
        path_or_hf_repo=model_repo,
        word_timestamps=True,
        clip_timestamps=[round(float(t), 3) for clip in clips for t in clip],
        language=language,
        **RECOVERY_OPTIONS,
    )
    return [
        {
            "start": seg["start"],
            "end": seg["end"],
            "text": seg["text"].strip(),
            "avg_logprob": seg.get("avg_logprob", 0.0),
            "no_speech_prob": seg.get("no_speech_prob", 0.0),
            "words": clean_words(seg.get("words")),
            "language": result.get("language"),
        }
        for seg in result.get("segments", [])
    ]


def detect_language(audio_path: str, segments: list, clip_backend: ClipBackend) -> str | None:
    """The language of a transcript that doesn't record it: Whisper's detection on up to
    LANGUAGE_SAMPLE_S of its surest lines that have words (up to three tries), or None."""
    lines = [
        s
        for s in segments
        if s.get("words") and finite(s.get("end"), 0.0) - finite(s.get("start"), 0.0) >= 1.0
    ]
    lines.sort(key=lambda s: -finite(s.get("avg_logprob"), NONFINITE_AVG_LOGPROB))
    for line in lines[:3]:
        start = float(line["start"])
        clip = (start, min(float(line["end"]), start + LANGUAGE_SAMPLE_S))
        try:
            found = clip_backend(audio_path, [clip], None)
        except Exception:
            continue
        language = next((f.get("language") for f in found if f.get("language")), None)
        if language:
            return language
    return None


def align_raw(
    audio_path: str,
    raw_segments: list,
    clip_backend: ClipBackend | None = None,
    language: str | None = None,
    on_progress=None,
) -> list:
    """Whisper's raw segments checked against the sound of `audio_path` (alignment.align): missed speech
    recovered with `clip_backend`, made-up lines dropped, edges on the sound. Missed speech is only
    transcribed again in the transcript's own language: `language`, else the main pass's, else detected
    from its lines; when none can be found nothing is recovered (Whisper guessing a language on room
    noise writes loops in it). `on_progress(fraction, detail)` follows the steps."""
    from vibecut_agent.transcribe import alignment

    language = language or next((s.get("language") for s in raw_segments if s.get("language")), None)
    transcribe = None
    if clip_backend is not None:
        if language is None:
            if on_progress is not None:
                on_progress(0.0, "Finding the transcript's language")
            language = detect_language(audio_path, raw_segments, clip_backend)
        if language is not None:

            def transcribe(clips, lang):
                return clip_backend(audio_path, clips, lang)

    speech = alignment.build_speech_map(audio_path, on_progress=on_progress)
    return alignment.align(raw_segments, speech, transcribe, language, on_progress=on_progress)


def audio_offset(video_path: str) -> float:
    """How late the file's sound starts after its picture (ffprobe_util.audio_offset_seconds)."""
    from vibecut_agent.broll import ffprobe_util

    return ffprobe_util.audio_offset_seconds(video_path)


def clean_words(raw) -> list | None:
    """Whisper's per-word timings as [{"start", "end", "text"}], dropping blank or malformed entries
    and any with no usable time range. None when there are none at all."""
    if not isinstance(raw, list):
        return None
    words = []
    for w in raw:
        if not isinstance(w, dict):
            continue
        text = str(w.get("word", w.get("text", ""))).strip()
        start, end = w.get("start"), w.get("end")
        if (
            not text
            or not isinstance(start, (int, float))
            or not isinstance(end, (int, float))
            or not math.isfinite(start)
            or not math.isfinite(end)
            or end <= start
        ):
            continue
        words.append({"start": float(start), "end": float(end), "text": text})
    return words or None


def _load_pipeline(model_id: str, hf_token: str):
    """Load a pyannote Pipeline, tolerating both the old `use_auth_token`
    and new `token` kwarg names across pyannote.audio versions."""
    from pyannote.audio import Pipeline

    try:
        return Pipeline.from_pretrained(model_id, token=hf_token)
    except TypeError:
        return Pipeline.from_pretrained(model_id, use_auth_token=hf_token)  # type: ignore[call-arg, unused-ignore]


class _DiarizationProgressHook:
    """A pyannote pipeline `hook` callable (see pyannote.audio.pipelines.utils.hook.ProgressHook
    for the reference implementation/signature this mirrors). pyannote calls
    this repeatedly as `hook(step_name, step_artifact, file=..., total=..., completed=...)`
    while it works through its internal steps (segmentation, embeddings, etc.);
    we just forward `(step_name, completed/total)` to a simpler callback."""

    def __init__(self, progress_callback):
        self.progress_callback = progress_callback

    def __call__(self, step_name, step_artifact, file=None, total=None, completed=None):
        if not total:
            return
        if completed is None:
            completed = total
        try:
            self.progress_callback(step_name, min(1.0, completed / total))
        except Exception:
            pass


def diarize_audio(audio_path: str, hf_token: str, progress_callback=None):
    """Run pyannote.audio speaker diarization locally.

    Tries the current recommended pipeline first, then falls back to the
    older one, since pyannote has been migrating pipelines and gated-repo
    dependencies between versions:
      1. pyannote/speaker-diarization-community-1 (current, most accurate)
      2. pyannote/speaker-diarization-3.1 (legacy, still supported)

    Both require a free Hugging Face account with the model license
    accepted on the respective model page, plus an access token. The
    token is only used to download model weights once; all audio
    processing happens on-device.

    If `progress_callback(step_name: str, fraction: float)` is given, it's
    wired up via pyannote's own `hook=` mechanism. If a given pipeline
    version's `apply()` doesn't accept `hook` (signature has shifted across
    pyannote releases before), we silently fall back to running it without
    progress reporting rather than failing the whole diarization pass.
    """
    model_ids = [
        "pyannote/speaker-diarization-community-1",
        "pyannote/speaker-diarization-3.1",
    ]

    last_error = None
    for model_id in model_ids:
        try:
            pipeline = _load_pipeline(model_id, hf_token)
            if progress_callback is not None:
                try:
                    output = pipeline(audio_path, hook=_DiarizationProgressHook(progress_callback))
                except TypeError:
                    output = pipeline(audio_path)
            else:
                output = pipeline(audio_path)

            # community-1 exposes results via `.speaker_diarization`
            # (an iterable of (turn, speaker) pairs); 3.1 returns an
            # Annotation object directly with `.itertracks()`.
            annotation = getattr(output, "speaker_diarization", output)

            turns = []
            if hasattr(annotation, "itertracks"):
                for turn, _, speaker in annotation.itertracks(yield_label=True):
                    turns.append((turn.start, turn.end, speaker))
            else:
                for turn, speaker in annotation:
                    turns.append((turn.start, turn.end, speaker))
            return turns

        except Exception as e:
            last_error = e
            continue

    raise RuntimeError(
        "Diarization failed for all known pyannote pipelines. Make sure "
        "you've accepted the license on BOTH "
        "huggingface.co/pyannote/speaker-diarization-community-1 and "
        "huggingface.co/pyannote/speaker-diarization-3.1 (plus "
        "huggingface.co/pyannote/segmentation-3.0), using the same "
        f"account that generated your token. Last error: {last_error}"
    )


def merge_transcript_and_speakers(transcript_segments, diarization_turns) -> tuple[list, list]:
    """Assign a speaker label to each whisper segment based on which
    diarization turn covers the segment's midpoint (falls back to the
    turn with greatest overlap)."""
    segments = []
    speaker_order = []

    def label_for(mid_point):
        best_speaker, best_overlap = None, float("-inf")
        for t_start, t_end, spk in diarization_turns:
            overlap = min(t_end, mid_point) - max(t_start, mid_point)
            if overlap > best_overlap:
                best_overlap, best_speaker = overlap, spk
        return best_speaker or "Speaker 0"

    for seg_data in transcript_segments:
        start, end, text = seg_data["start"], seg_data["end"], seg_data["text"]
        if not text:
            continue
        mid = (start + end) / 2
        speaker = label_for(mid) if diarization_turns else "Speaker 0"
        if speaker not in speaker_order:
            speaker_order.append(speaker)
        segments.append(
            Segment(
                start=start,
                end=end,
                text=text,
                speaker=speaker,
                avg_logprob=seg_data.get("avg_logprob", 0.0),
                no_speech_prob=seg_data.get("no_speech_prob", 0.0),
                words=seg_data.get("words"),
            )
        )

    return segments, speaker_order


def normalize_speaker_names(speaker_order: list) -> dict:
    """Map raw diarization labels (e.g. SPEAKER_00) to friendly
    'Speaker 1', 'Speaker 2', ... in order of first appearance."""
    mapping = {}
    for i, raw in enumerate(speaker_order):
        mapping[raw] = f"Speaker {i + 1}"
    return mapping


def _visible_segments(segments: list, excluded_speakers: set, speaker_labels: dict | None):
    speaker_labels = speaker_labels or {}
    for seg in segments:
        if seg.speaker in excluded_speakers:
            continue
        display_name = (speaker_labels.get(seg.speaker) or "").strip() or seg.speaker
        yield seg, display_name


def build_txt(
    file_name: str,
    segments: list,
    excluded_speakers: set,
    speaker_labels: dict | None = None,
    source_path: str | None = None,
) -> str:
    lines = [f"# Transcript: {file_name}"]
    if source_path:
        lines.append(f"# Source video: {source_path}")
    lines.append("")
    for seg, display_name in _visible_segments(segments, excluded_speakers, speaker_labels):
        lines.append(f"[{fmt_timecode(seg.start)}] {display_name}: {seg.text}")
    return "\n".join(lines) + "\n"


def build_srt(
    file_name: str,
    segments: list,
    excluded_speakers: set,
    speaker_labels: dict | None = None,
    source_path: str | None = None,
) -> str:
    # Standard SRT has no comment/metadata syntax, so the source video
    # isn't embedded here — association relies on the exported .srt
    # sharing the same base filename as the video (the default suggested
    # name already does this), which is how editors auto-pair captions.
    lines = []
    idx = 1
    for seg, display_name in _visible_segments(segments, excluded_speakers, speaker_labels):
        lines.append(str(idx))
        lines.append(f"{fmt_srt_time(seg.start)} --> {fmt_srt_time(seg.end)}")
        lines.append(f"{display_name}: {seg.text}")
        lines.append("")
        idx += 1
    return "\n".join(lines) + "\n"


def build_vtt(
    file_name: str,
    segments: list,
    excluded_speakers: set,
    speaker_labels: dict | None = None,
    source_path: str | None = None,
) -> str:
    lines = ["WEBVTT"]
    if source_path:
        lines.append(f"NOTE Source video: {source_path}")
    lines.append("")
    for seg, display_name in _visible_segments(segments, excluded_speakers, speaker_labels):
        lines.append(f"{fmt_vtt_time(seg.start)} --> {fmt_vtt_time(seg.end)}")
        lines.append(f"{display_name}: {seg.text}")
        lines.append("")
    return "\n".join(lines) + "\n"


EXPORT_FORMATS = {
    "SRT (.srt)": (".srt", build_srt),
    "WebVTT (.vtt)": (".vtt", build_vtt),
    "Plain text (.txt)": (".txt", build_txt),
}


def build_transcript(
    file_name: str,
    segments: list,
    excluded_speakers: set,
    speaker_labels: dict,
    export_format: str,
    source_path: str | None = None,
) -> str:
    _, builder = EXPORT_FORMATS[export_format]
    return builder(file_name, segments, excluded_speakers, speaker_labels, source_path)


def write_cache(
    video_path: str,
    name: str,
    segments: list,
    speakers: list,
    speaker_labels: dict | None = None,
    excluded_speakers=(),
    alignment: int | None = None,
    language: str | None = None,
) -> bool:
    """Persist a finished (or edited) file's results next to the source
    video so a future run can skip re-transcribing it. Best-effort:
    never raises, since caching should never block the caller. Returns whether
    the write actually succeeded, so callers can surface a warning instead
    of silently re-transcribing later (e.g. a read-only or
    disconnected external volume)."""
    try:
        stat = os.stat(video_path)
        video_size, video_mtime = stat.st_size, int(stat.st_mtime)
    except OSError:
        video_size, video_mtime = None, None

    data = {
        "path": video_path,
        "name": name,
        "video_size": video_size,
        "video_mtime": video_mtime,
        "speakers": speakers,
        "segments": [
            {
                "start": s.start,
                "end": s.end,
                "text": s.text,
                "speaker": s.speaker,
                # A score Whisper couldn't compute is stored as plainly low: a bare NaN isn't JSON, and
                # the app's reader would drop the whole transcript over it.
                "avg_logprob": finite(s.avg_logprob, NONFINITE_AVG_LOGPROB),
                "no_speech_prob": finite(s.no_speech_prob, NONFINITE_NO_SPEECH_PROB),
                **({"words": words} if (words := clean_words(s.words)) else {}),
            }
            for s in segments
            if math.isfinite(finite(s.start, math.nan)) and math.isfinite(finite(s.end, math.nan))
        ],
        "speaker_labels": speaker_labels or {},
        "excluded_speakers": sorted(excluded_speakers),
        **({"alignment": alignment} if alignment is not None else {}),
        **({"language": language} if language else {}),
    }
    try:
        text = json.dumps(data, allow_nan=False)
        tmp = _cache_path(video_path) + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            f.write(text)
        os.replace(tmp, _cache_path(video_path))
        return True
    except Exception:
        return False


def segments_from_cache(data: dict) -> list:
    """The Segment list stored in a cache dict returned by load_cache."""
    return [
        Segment(
            start=s["start"],
            end=s["end"],
            text=s["text"],
            speaker=s.get("speaker", "Speaker 0"),
            avg_logprob=finite(s.get("avg_logprob", 0.0), NONFINITE_AVG_LOGPROB),
            no_speech_prob=finite(s.get("no_speech_prob", 0.0), NONFINITE_NO_SPEECH_PROB),
            words=clean_words(s.get("words")),
        )
        for s in data.get("segments", [])
        if math.isfinite(finite(s.get("start"), math.nan)) and math.isfinite(finite(s.get("end"), math.nan))
    ]


def transcribe_video(
    video_path: str,
    model_repo: str,
    enable_diarization: bool,
    hf_token: str,
    on_progress=None,
) -> TranscribeResult:
    """Run the full pipeline (extract -> transcribe -> align -> diarize -> merge -> offset) for one
    video. `aligned` is False when checking the transcript against the sound failed (Whisper's own times
    are kept; the cache is then written without its `alignment` mark, so `upgrade_cache` tries again).
    Raises on any other failure. The sound is extracted once and kept (audio_cache.audio_for); memory is
    released even when a step fails.

    If given, `on_progress(phase: str, fraction: float, detail: str)` is called as the file moves
    through "extract"/"transcribe"/"align"/"diarize", with `fraction` resetting to 0.0 at the start of each
    phase (there is no single meaningful percentage across phases of very different,
    file-dependent duration). Exceptions raised by the callback are ignored."""
    from vibecut_agent.transcribe import alignment, audio_cache

    def report(phase, fraction, detail):
        if on_progress is not None:
            try:
                on_progress(phase, fraction, detail)
            except Exception:
                pass

    try:
        # 1. The sound only, extracted once and kept
        report("extract", 0.0, "Extracting the sound…")
        with audio_cache.audio_for(video_path, lambda f, d: report("extract", f, d)) as audio:
            # 2. Transcribe (Apple Metal via mlx-whisper)
            report("transcribe", 0.0, "Transcribing… 0%")
            transcript_segments = transcribe_audio(
                audio,
                model_repo,
                progress_callback=(
                    lambda frac: report("transcribe", frac, f"Transcribing… {int(frac * 100)}%")
                )
                if on_progress is not None
                else None,
            )
            language = next((s.get("language") for s in transcript_segments if s.get("language")), None)

            # 3. Check it against the sound: missed speech, made-up lines, edges (best effort)
            report("align", 0.0, "Checking the transcript against the sound…")
            aligned = True
            try:
                transcript_segments = align_raw(
                    audio,
                    transcript_segments,
                    lambda wav, clips, lang: transcribe_clips(wav, model_repo, clips, lang),
                    language,
                    lambda f, d: report("align", f, d),
                )
            except Exception:
                aligned = False
            report("align", 1.0, "Checked against the sound")

            # 4. Diarize (optional)
            diarization_turns = []
            if enable_diarization:
                report("diarize", 0.0, "Diarizing speakers…")
                diarization_turns = diarize_audio(
                    audio,
                    hf_token,
                    progress_callback=(
                        lambda step, frac: report(
                            "diarize",
                            frac,
                            f"Diarizing speakers ({step})… {int(frac * 100)}%",
                        )
                    )
                    if on_progress is not None
                    else None,
                )

        # 5. Merge + friendly speaker names, then times from the picture's first frame
        segments, speaker_order = merge_transcript_and_speakers(transcript_segments, diarization_turns)
        name_map = normalize_speaker_names(speaker_order)
        for seg in segments:
            seg.speaker = name_map.get(seg.speaker, seg.speaker)
        if aligned:
            segments = alignment.shift(segments, audio_offset(video_path))
        return TranscribeResult(segments, list(name_map.values()) or ["Speaker 1"], aligned, language)
    finally:
        gc.collect()


def needs_upgrade(data: dict | None) -> bool:
    """Whether a loaded cache predates ALIGNMENT_VERSION (its times are Whisper's own)."""
    return data is not None and data.get("alignment") != ALIGNMENT_VERSION and bool(data.get("segments"))


def _nearest_speaker(seg: dict, segments: list) -> str:
    middle = (seg["start"] + seg["end"]) / 2
    spoken = [s for s in segments if s.get("speaker")]
    if not spoken:
        return "Speaker 0"
    return min(spoken, key=lambda s: abs((s["start"] + s["end"]) / 2 - middle))["speaker"]


def upgrade_cache(video_path: str, data: dict, clip_backend: ClipBackend | None = None, on_progress=None):
    """A cache written before ALIGNMENT_VERSION, checked against the sound and moved by the audio offset
    without transcribing the whole file again (only the speech it missed, with `clip_backend`, in the
    transcript's language: recorded, else detected from its lines), written back with its speaker names
    and switched-off speakers kept. Returns the new cache dict, or None when it couldn't be done (the media
    can't be read, ...): the old cache stands and is tried again next time. Lines recovered here take the
    speaker of the nearest line."""
    from vibecut_agent.transcribe import alignment, audio_cache

    def report(phase, fraction, detail):
        if on_progress is not None:
            try:
                on_progress(phase, fraction, detail)
            except Exception:
                pass

    try:
        report("align", 0.0, "Checking the transcript against the sound…")
        try:
            raw = [
                {
                    "start": s.start,
                    "end": s.end,
                    "text": s.text,
                    "speaker": s.speaker,
                    "avg_logprob": s.avg_logprob,
                    "no_speech_prob": s.no_speech_prob,
                    "words": s.words,
                }
                for s in segments_from_cache(data)
            ]
            with audio_cache.audio_for(video_path, lambda f, d: report("extract", f, d)) as audio:
                language = data.get("language") if isinstance(data.get("language"), str) else None
                if clip_backend is not None and language is None:
                    report("align", 0.0, "Finding the transcript's language")
                    language = detect_language(audio, raw, clip_backend)
                checked = align_raw(audio, raw, clip_backend, language, lambda f, d: report("align", f, d))
            offset = audio_offset(video_path)
        except Exception:
            return None

        segments = [
            Segment(
                start=seg["start"],
                end=seg["end"],
                text=seg["text"],
                speaker=seg.get("speaker") or _nearest_speaker(seg, checked),
                avg_logprob=seg.get("avg_logprob", 0.0),
                no_speech_prob=seg.get("no_speech_prob", 0.0),
                words=clean_words(seg.get("words")),
            )
            for seg in checked
            if seg.get("text")
        ]
        segments = alignment.shift(segments, offset)
        speakers = list(data.get("speakers") or [])
        for seg in segments:
            if seg.speaker not in speakers:
                speakers.append(seg.speaker)
        if not write_cache(
            video_path,
            str(data.get("name") or os.path.basename(video_path)),
            segments,
            speakers or ["Speaker 1"],
            data.get("speaker_labels") or {},
            set(data.get("excluded_speakers") or []),
            alignment=ALIGNMENT_VERSION,
            language=language,
        ):
            return None
        report("align", 1.0, "Checked against the sound")
        return load_cache(video_path)
    finally:
        gc.collect()
