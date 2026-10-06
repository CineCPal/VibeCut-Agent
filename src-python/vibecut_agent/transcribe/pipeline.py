"""The transcription pipeline (PLAN.md, "Phase 6b"), VibeCut's interview-transcriber/pipeline.py verbatim:
mlx-whisper on Apple Silicon, optional pyannote speaker labels, and the `<video>.ivt-cache.json` cache that
VibeCut, its suite and VibeCut Agent share. Heavy models load only inside the functions that use them."""

import gc
import json
import os
import shutil
import subprocess
import tempfile
from dataclasses import dataclass, field

CACHE_SUFFIX = ".ivt-cache.json"

WHISPER_MODELS = {
    "Fast (tiny, lower accuracy)": "mlx-community/whisper-tiny-mlx",
    "Balanced (small)": "mlx-community/whisper-small-mlx",
    "Recommended (medium)": "mlx-community/whisper-medium-mlx",
    "Best quality (large-v3)": "mlx-community/whisper-large-v3-mlx",
}


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


def extract_audio(video_path: str, out_wav: str) -> None:
    """Pull only the audio stream to a mono 16kHz WAV (required by both
    mlx-whisper and pyannote). No copy of the video itself is made."""
    cmd = [
        "ffmpeg",
        "-y",
        "-i",
        video_path,
        "-vn",  # no video
        "-acodec",
        "pcm_s16le",
        "-ar",
        "16000",
        "-ac",
        "1",
        out_wav,
    ]
    try:
        result = subprocess.run(cmd, capture_output=True, timeout=1800)
    except subprocess.TimeoutExpired:
        raise RuntimeError(f"ffmpeg did not finish extracting audio from {video_path} within 30 minutes")
    if result.returncode != 0:
        raise RuntimeError(f"ffmpeg failed: {result.stderr.decode(errors='ignore')[-500:]}")


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
        }
        for seg in result.get("segments", [])
    ]


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
        return Pipeline.from_pretrained(model_id, use_auth_token=hf_token)


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
                "avg_logprob": s.avg_logprob,
                "no_speech_prob": s.no_speech_prob,
                **({"words": s.words} if s.words else {}),
            }
            for s in segments
        ],
        "speaker_labels": speaker_labels or {},
        "excluded_speakers": sorted(excluded_speakers),
    }
    try:
        with open(_cache_path(video_path), "w", encoding="utf-8") as f:
            json.dump(data, f)
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
            avg_logprob=s.get("avg_logprob", 0.0),
            no_speech_prob=s.get("no_speech_prob", 0.0),
            words=clean_words(s.get("words")),
        )
        for s in data.get("segments", [])
    ]


def transcribe_video(
    video_path: str,
    model_repo: str,
    enable_diarization: bool,
    hf_token: str,
    on_progress=None,
):
    """Run the full pipeline (extract -> transcribe -> diarize -> merge) for one video and
    return `(segments, speakers)`. Raises on failure. The temporary audio is always removed
    and memory released, even when a step fails.

    If given, `on_progress(phase: str, fraction: float, detail: str)` is called as the file moves
    through "extract"/"transcribe"/"diarize", with `fraction` resetting to 0.0 at the start of each
    phase (there is no single meaningful percentage across phases of very different,
    file-dependent duration). Exceptions raised by the callback are ignored."""

    def report(phase, fraction, detail):
        if on_progress is not None:
            try:
                on_progress(phase, fraction, detail)
            except Exception:
                pass

    tmp_dir = tempfile.mkdtemp(prefix="ivt_")
    try:
        # 1. Extract audio only, to a temp file
        report("extract", 0.0, "Extracting audio…")
        tmp_wav = os.path.join(tmp_dir, "audio.wav")
        extract_audio(video_path, tmp_wav)

        # 2. Transcribe (Apple Metal via mlx-whisper)
        report("transcribe", 0.0, "Transcribing… 0%")
        transcript_segments = transcribe_audio(
            tmp_wav,
            model_repo,
            progress_callback=(lambda frac: report("transcribe", frac, f"Transcribing… {int(frac * 100)}%"))
            if on_progress is not None
            else None,
        )

        # 3. Diarize (optional)
        diarization_turns = []
        if enable_diarization:
            report("diarize", 0.0, "Diarizing speakers…")
            diarization_turns = diarize_audio(
                tmp_wav,
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

        # 4. Merge + friendly speaker names
        segments, speaker_order = merge_transcript_and_speakers(transcript_segments, diarization_turns)
        name_map = normalize_speaker_names(speaker_order)
        for seg in segments:
            seg.speaker = name_map.get(seg.speaker, seg.speaker)
        return segments, list(name_map.values()) or ["Speaker 1"]
    finally:
        # 5. Clean up temp audio dir (even if extraction itself failed
        # before producing any output) + free Unified Memory
        shutil.rmtree(tmp_dir, ignore_errors=True)
        gc.collect()
