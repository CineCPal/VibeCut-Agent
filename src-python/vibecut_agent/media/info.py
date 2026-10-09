"""The `media-info` command (PLAN.md, "Phase 13a"): the technical facts of media files, for the
snapshot's [SOURCES] lines.

request: {"paths": [absolute media files]}
result: {"info": {path: {"duration", "video": {"codec", "width", "height", "fps"} | null,
         "audio": {"codec", "channels", "sampleRate"} | null}}, "failed": [{"path", "message"}]}
"""

from __future__ import annotations

import os
from typing import Any

from vibecut_agent.broll import ffprobe_util
from vibecut_agent.protocol import Emitter, RequestError, require_absolute_paths

MAX_FILES = 64
PROBE_TIMEOUT_S = 15.0


def _rate(value: Any) -> float | None:
    """ffprobe's "30000/1001" as 29.97; None for "0/0" or anything unreadable."""
    try:
        top, _, bottom = str(value).partition("/")
        rate = float(top) / float(bottom or 1)
    except (TypeError, ValueError, ZeroDivisionError):
        return None
    return round(rate, 3) if rate > 0 else None


def _number(value: Any) -> float | None:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if number >= 0 else None


def facts(probe: dict[str, Any]) -> dict[str, Any]:
    """ffprobe's -show_format -show_streams answer, cut to what an editor asks about. The first video
    stream that isn't cover art, and the first audio stream."""
    streams = probe.get("streams") or []
    video = next(
        (
            s
            for s in streams
            if s.get("codec_type") == "video" and not (s.get("disposition") or {}).get("attached_pic")
        ),
        None,
    )
    audio = next((s for s in streams if s.get("codec_type") == "audio"), None)
    out: dict[str, Any] = {
        "duration": _number((probe.get("format") or {}).get("duration")),
        "video": None,
        "audio": None,
    }
    if video is not None:
        out["video"] = {
            "codec": video.get("codec_name"),
            "width": video.get("width"),
            "height": video.get("height"),
            "fps": _rate(video.get("avg_frame_rate")) or _rate(video.get("r_frame_rate")),
        }
    if audio is not None:
        out["audio"] = {
            "codec": audio.get("codec_name"),
            "channels": audio.get("channels"),
            "sampleRate": int(_number(audio.get("sample_rate")) or 0) or None,
        }
    return out


def run(request: dict[str, Any], emitter: Emitter) -> int:
    paths = request.get("paths")
    if not isinstance(paths, list) or not paths or len(paths) > MAX_FILES:
        raise RequestError(f"paths must list 1 to {MAX_FILES} media files")
    require_absolute_paths(paths, "media file")
    info: dict[str, Any] = {}
    failed: list[dict[str, str]] = []
    unique = list(dict.fromkeys(paths))
    for index, path in enumerate(unique):
        emitter.progress(index, len(unique), phase="probing", detail=os.path.basename(path))
        try:
            if not os.path.isfile(path):
                raise RuntimeError("the file isn't there (is its drive attached?)")
            info[path] = facts(
                ffprobe_util.probe_json(path, PROBE_TIMEOUT_S, show_format=True, show_streams=True)
            )
        except Exception as exc:  # noqa: BLE001 - one unreadable file is reported, the rest still probed
            failed.append({"path": path, "message": str(exc)})
    emitter.progress(len(unique), len(unique), phase="done", detail="")
    emitter.emit("result", info=info, failed=failed)
    return 0 if info or not failed else 1
