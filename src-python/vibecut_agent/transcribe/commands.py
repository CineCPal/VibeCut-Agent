"""The `transcribe` sidecar command (PLAN.md, "Phase 6b"), ported from VibeCut's interview-transcriber
headless.py: ``python -u -m vibecut_agent transcribe`` (one JSON request on stdin).

Transcribes videos one after another on this computer with mlx-whisper (Apple Silicon), optionally
labelling speakers with pyannote, and writes a transcript next to each video (or in `outDir`) plus
the usual `.ivt-cache.json`. Never imports streamlit. Files are processed strictly one at a time.

request: {
    "videos": [absolute paths],
    "model": one of pipeline.WHISPER_MODELS.values(),
    "diarize": false,
    "format": "txt" | "srt" | "vtt",
    "outDir": absolute folder, or null for next to each video,
    "force": false          (true ignores an existing cache)
}
The Hugging Face token for speaker labels is `hfToken`, which only Rust puts in the request (from its
environment or the Keychain; sidecar.rs `prepare_request`), and only when `diarize` is set. The UI never
holds it, the sidecar's environment never carries it, and it is never echoed in an event.

Events: starting, status {phase, detail}, file_start {path, index, total},
progress {done, total, fraction, phase, detail, path, index}, file_done {path, fromCache,
speakers, segmentCount, cachePath, exportPath}, file_error {path, message},
result {files, failed, warnings, cancelled}, error, done {cancelled}.
`progress.fraction` covers the whole batch: each finished file counts 1, the current file its share.
"""

from __future__ import annotations

import os
import shutil
from typing import Any, TextIO

from vibecut_agent.broll import (
    ffprobe_util,  # noqa: F401 - imported for its side effect: Homebrew's ffmpeg on PATH
)
from vibecut_agent.protocol import CancelFlag, Emitter, RequestError, read_request, require_absolute_paths
from vibecut_agent.transcribe import pipeline

TOOL = "interview-transcriber"
FORMATS = {
    "txt": "Plain text (.txt)",
    "srt": "SRT (.srt)",
    "vtt": "WebVTT (.vtt)",
}
# Rough share of a file's time per phase, so one batch-wide progress value can be shown.
PHASE_WEIGHTS = {
    False: {"extract": (0.0, 0.05), "transcribe": (0.05, 1.0)},
    True: {"extract": (0.0, 0.05), "transcribe": (0.05, 0.70), "diarize": (0.70, 1.0)},
}


class Cancelled(BaseException):
    """Raised inside the running pipeline when the bridge asks the sidecar to stop. It is a
    BaseException so the pipeline's own `except Exception` blocks cannot swallow it, while its
    `finally` blocks (temporary audio, memory) still run."""


def raise_cancelled() -> None:
    raise Cancelled()


def file_fraction(phase: str, fraction: float, diarize: bool) -> float:
    """A file's overall progress (0 to 1) from the fraction within one of its phases."""
    start, end = PHASE_WEIGHTS[diarize].get(phase, (0.0, 1.0))
    return start + (end - start) * min(1.0, max(0.0, fraction))


def model_is_downloaded(model_repo: str) -> bool:
    try:
        from huggingface_hub.constants import HF_HUB_CACHE
    except ImportError:
        return True  # cannot tell; do not claim a download
    return os.path.isdir(os.path.join(HF_HUB_CACHE, "models--" + model_repo.replace("/", "--")))


def export_path_for(video: str, out_dir: str | None, suffix: str, taken: set[str]) -> str:
    """Where the transcript goes: the video's own name with the new extension, so editors pair them.
    Two videos with the same name and different extensions get the video extension in the name."""
    stem, ext = os.path.splitext(os.path.basename(video))
    folder = out_dir or os.path.dirname(video)
    path = os.path.join(folder, f"{stem}{suffix}")
    if path in taken:
        path = os.path.join(folder, f"{stem}{ext}{suffix}")
    taken.add(path)
    return path


def _write_text(path: str, text: str) -> None:
    tmp = f"{path}.tmp"
    with open(tmp, "w", encoding="utf-8") as handle:
        handle.write(text)
    os.replace(tmp, path)


def transcribe_one(
    video: str,
    request: dict[str, Any],
    export_path: str,
    hf_token: str | None,
    on_progress,
) -> dict[str, Any]:
    """Transcribes (or loads from cache) one video and writes its transcript. Returns the
    `file_done` payload. Raises on failure."""
    name = os.path.basename(video)
    diarize = request["diarize"]
    cached = None if request["force"] else pipeline.load_cache(video)

    warnings: list[str] = []
    if cached is not None:
        segments = pipeline.segments_from_cache(cached)
        speakers = cached.get("speakers") or ["Speaker 1"]
        labels = cached.get("speaker_labels") or {}
        excluded = set(cached.get("excluded_speakers") or [])
    else:
        segments, speakers = pipeline.transcribe_video(
            video, request["model"], diarize, hf_token or "", on_progress
        )
        labels, excluded = {}, set()
        if not pipeline.write_cache(video, name, segments, speakers, labels, excluded):
            warnings.append(
                f"Could not write the cache next to {name}; it will be transcribed again next time."
            )

    fmt = FORMATS[request["format"]]
    _write_text(
        export_path,
        pipeline.build_transcript(name, segments, excluded, labels, fmt, video),
    )
    return {
        "path": video,
        "fromCache": cached is not None,
        "speakers": speakers,
        "segmentCount": len(segments),
        "cachePath": pipeline._cache_path(video),
        "exportPath": export_path,
        "warnings": warnings,
    }


def validate(request: dict[str, Any]) -> dict[str, Any]:
    videos = request.get("videos")
    if not isinstance(videos, list) or not videos:
        raise RequestError("Choose at least one video first")
    require_absolute_paths(videos, "video")
    for video in videos:
        if not os.path.isfile(video):
            raise RequestError(f"Video not found: {video}")
    model = request.get("model") or next(iter(pipeline.WHISPER_MODELS.values()))
    if model not in pipeline.WHISPER_MODELS.values():
        raise RequestError(f"Unknown model: {model}")
    fmt = request.get("format", "txt")
    if fmt not in FORMATS:
        raise RequestError(f"Unknown format: {fmt}")
    out_dir = request.get("outDir")
    if out_dir is not None:
        require_absolute_paths([out_dir], "output folder")
    return {
        "videos": videos,
        "model": model,
        "diarize": request.get("diarize") is True,
        "format": fmt,
        "outDir": out_dir,
        "force": request.get("force") is True,
        "hfToken": request.get("hfToken") if isinstance(request.get("hfToken"), str) else None,
    }


def run_transcribe(raw_request: dict[str, Any], emitter: Emitter, cancel: CancelFlag) -> int:
    request = validate(raw_request)
    videos: list[str] = request["videos"]
    total = len(videos)

    if shutil.which("ffmpeg") is None:
        emitter.error("ffmpeg was not found. Install it (for example: brew install ffmpeg).")
        return 1
    hf_token = None
    if request["diarize"]:
        hf_token = (request["hfToken"] or "").strip() or None
        if not hf_token:
            emitter.error(
                "Telling speakers apart needs a Hugging Face token: add it in Settings → API keys, and accept "
                "the pyannote speaker-diarization model licences on huggingface.co."
            )
            return 1
    if request["outDir"]:
        os.makedirs(request["outDir"], exist_ok=True)

    if not model_is_downloaded(request["model"]):
        emitter.emit(
            "status",
            phase="download",
            detail=f"Downloading the {request['model'].split('/')[-1]} model (first use)",
        )

    done_files: list[dict[str, Any]] = []
    failed: list[dict[str, str]] = []
    warnings: list[str] = []
    taken: set[str] = set()
    cancelled = False

    try:
        for index, video in enumerate(videos):
            if cancel.is_set():
                raise Cancelled()
            emitter.emit("file_start", path=video, index=index, total=total)

            def on_progress(phase, fraction, detail, video=video, index=index):
                overall = index + file_fraction(phase, fraction, request["diarize"])
                emitter.progress(
                    overall,
                    total,
                    phase=phase,
                    detail=f"{os.path.basename(video)}: {detail}",
                    path=video,
                    index=index,
                )

            suffix, _ = pipeline.EXPORT_FORMATS[FORMATS[request["format"]]]
            try:
                payload = transcribe_one(
                    video,
                    request,
                    export_path_for(video, request["outDir"], suffix, taken),
                    hf_token,
                    on_progress,
                )
            except Exception as exc:
                failed.append({"path": video, "message": str(exc)})
                emitter.emit("file_error", path=video, message=str(exc))
                emitter.progress(
                    index + 1,
                    total,
                    phase="done",
                    detail=os.path.basename(video),
                    path=video,
                    index=index,
                )
                continue
            warnings.extend(payload.pop("warnings"))
            done_files.append(payload)
            emitter.emit("file_done", **payload)
            emitter.progress(
                index + 1,
                total,
                phase="done",
                detail=os.path.basename(video),
                path=video,
                index=index,
            )
    except Cancelled:
        cancelled = True

    emitter.emit(
        "result",
        files=done_files,
        failed=failed,
        warnings=warnings,
        cancelled=cancelled,
    )
    return 0 if done_files or cancelled or not failed else 1


def main(stdin: TextIO, emitter: Emitter, cancel: CancelFlag | None = None) -> int:
    """One `transcribe` run, as VibeCut's headless.main runs it: starting, the command, then done."""
    if cancel is None:
        cancel = CancelFlag()
        # SIGTERM raises inside whatever is running, so temporary audio is removed on the way out.
        cancel.install_sigterm_handler(on_cancel=raise_cancelled)
    emitter.emit("starting", tool=TOOL, command="transcribe")
    try:
        request = read_request(stdin)
        code = run_transcribe(request, emitter, cancel)
    except RequestError as exc:
        emitter.error(str(exc))
        code = 2
    except Cancelled:
        code = 0  # asked to stop before any file started
    except Exception as exc:
        emitter.error(f"Unexpected error: {exc}")
        code = 1
    emitter.emit("done", cancelled=cancel.is_set())
    return code
