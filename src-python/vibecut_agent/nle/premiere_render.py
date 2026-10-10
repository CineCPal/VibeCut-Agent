"""Renders of the connected Premiere sequence through Adobe Media Encoder (PLAN.md, "Phase 15b"), with the
same commands and answers as resolve_render.py. Ported from VibeCut's host-premiere/premiere_render.py
(its "Phase 7c"), without save_stills; the bridge folder is passed in (`imports`, as for rebuild).

- `render_video {timeline, preset, range?, name?}` and `render_audio {timeline, format, range?, name?}`
  queue the sequence in Media Encoder with one of its own presets (the panel's `encode`) and answer
  at once with the job id and the file it will write in `~/Movies/VibeCut Renders/<project>/`.
- `render_status {jobId}` reads the job's state file, which the panel's Media Encoder events keep up
  to date in the bridge folder's renders/.
- `cancel_render {jobId}` stops Media Encoder's batch (the panel's `encode_cancel`) and removes the
  partial file.

What Premiere 26.5.2 and Media Encoder 2026 do (checked live in VibeCut's "7c.0 probe"): encodeSequence
returns a job id and the events keep firing after the request that bound them; workArea 1 renders
the sequence's In to Out, which can be set for the job and put back straight away; Media Encoder
has no stop of its own through Premiere, and stopping its batch stops every job in it.
"""

from __future__ import annotations

import glob
import json
import os
from pathlib import Path
from typing import Any

from vibecut_agent.nle.premiere import HostError, _number, seconds
from vibecut_agent.nle.renders import (
    inside,
    output_stem,
    remove_quietly,
    renders_root,
)

# Media Encoder's own presets, under its MediaIO/systempresets folder, and the file each writes.
PRESETS = {
    "source": ("4E49434B_48323634/01 - Match Source - High bitrate.epr", ".mp4"),
    "1080p": ("4E49434B_48323634/High Quality 1080 HD.epr", ".mp4"),
    "720p": ("4E49434B_48323634/High Quality 720 HD.epr", ".mp4"),
    "prores": ("3F3F3F3F_4D6F6F56/Apple ProRes 422 HQ.epr", ".mov"),
    "wav": ("3F3F3F3F_57415645/Waveform Audio 48kHz 16-bit.epr", ".wav"),
    "aac": ("4E49434B_41414320/Stereo AAC, 48kHz 256kbps.epr", ".aac"),
}
VIDEO_PRESETS = ("source", "1080p", "720p", "prores")
AUDIO_FORMATS = ("wav", "aac")
AME_PRESETS = "/Applications/Adobe Media Encoder */Adobe Media Encoder *.app/Contents/MediaIO/systempresets"
# Starting Media Encoder can take a while the first time.
ENCODE_TIMEOUT_S = 100.0
ENDED = ("done", "failed", "cancelled")

# The jobs this session queued, by Media Encoder's job id.
JOBS: dict[str, dict[str, Any]] = {}


def presets_dir() -> str:
    """The newest Media Encoder's system presets (`VIBECUT_AME_PRESETS` overrides it, for tests)."""
    custom = os.environ.get("VIBECUT_AME_PRESETS")
    if custom:
        return custom
    found = sorted(glob.glob(AME_PRESETS))
    if not found:
        raise HostError("Adobe Media Encoder isn't installed; Premiere renders through it")
    return found[-1]


def _states(imports: Path | None) -> Path:
    if imports is None:
        raise HostError("Rendering needs the bridge folder")
    return Path(imports).parent / "renders"


def _project(host: Any) -> str:
    return str(host._send("status", {}).get("project") or "Premiere project")


def _start(host: Any, args: dict[str, Any], key: str, imports: Path | None) -> dict[str, Any]:
    name = host._name(args)
    preset_file, ext = PRESETS[key]
    preset = os.path.join(presets_dir(), preset_file)
    if not os.path.isfile(preset):
        raise HostError(f"Media Encoder's preset {os.path.basename(preset)!r} isn't installed")
    request: dict[str, Any] = {"timeline": name, "preset": preset}
    value = args.get("range")
    if value is None or value == "all":
        request["workArea"] = 0
    elif value == "in_out":
        request["workArea"] = 1
    elif isinstance(value, dict):
        start = _number(value.get("start"), "range.start")
        end = _number(value.get("end"), "range.end")
        length = seconds(int(host._info(args)["endTicks"]))
        if start < 0 or end > length or end - start < 0.04:
            raise HostError(f"range must be within the sequence (0 to {length} s) and at least a frame long")
        request.update(workArea=1, inSeconds=round(start, 3), outSeconds=round(end, 3))
    else:
        raise HostError('range must be "all", "in_out" or {start, end} in seconds')
    folder, stem = output_stem(_project(host), name, args.get("name"), (ext,))
    path = os.path.join(folder, stem + ext)
    request["out"] = path
    raw = host._request("encode", request, ENCODE_TIMEOUT_S)
    job = str(raw.get("jobId") or "")
    if not job:
        raise HostError("Media Encoder didn't take the render")
    JOBS[job] = {
        "path": path,
        "seconds": round(float(raw.get("seconds") or 0), 3),
        "states": str(_states(imports)),
        "state": "rendering",
        "fraction": 0.0,
    }
    return {"jobId": job, "path": path, "seconds": JOBS[job]["seconds"]}


def render_video(host: Any, args: dict[str, Any], imports: Path | None = None) -> dict[str, Any]:
    """{timeline, preset: source | 1080p | 720p | prores, range?, name?} -> {jobId, path, seconds}.
    source is Media Encoder's H.264 Match Source (High bitrate); 1080p and 720p its High Quality HD
    presets; prores Apple ProRes 422 HQ."""
    preset = args.get("preset", "source")
    if preset not in VIDEO_PRESETS:
        raise HostError(f"preset must be one of {', '.join(VIDEO_PRESETS)}")
    return _start(host, args, preset, imports)


def render_audio(host: Any, args: dict[str, Any], imports: Path | None = None) -> dict[str, Any]:
    """{timeline, format: wav | aac, range?, name?} -> {jobId, path, seconds}: a 48 kHz 16-bit WAV, or
    a stereo 256 kbps AAC."""
    fmt = args.get("format", "wav")
    if fmt not in AUDIO_FORMATS:
        raise HostError(f"format must be one of {', '.join(AUDIO_FORMATS)}")
    return _start(host, args, fmt, imports)


def _job(args: dict[str, Any]) -> tuple[str, dict[str, Any]]:
    job = args.get("jobId")
    if not isinstance(job, str) or job not in JOBS:
        raise HostError("There is no render with that jobId in this connection")
    return job, JOBS[job]


def _report(record: dict[str, Any]) -> dict[str, Any]:
    out: dict[str, Any] = {"state": record["state"], "seconds": record["seconds"]}
    if record["state"] == "rendering":
        out["fraction"] = record["fraction"]
    if record["state"] == "done":
        out["path"] = record["path"]
    if record.get("error"):
        out["error"] = record["error"]
    return out


def _safe_id(job: str) -> str:
    return "".join(c for c in job if c.isalnum() or c in "_-")


def _read_state(record: dict[str, Any], job: str, kind: str) -> dict[str, Any] | None:
    """The panel's <jobId>.<kind>.json (progress, done or failed), or None while there isn't one."""
    try:
        news = json.loads(
            (Path(record["states"]) / f"{_safe_id(job)}.{kind}.json").read_text(encoding="utf-8")
        )
    except (OSError, ValueError):
        return None  # not written yet, or being replaced
    return news if isinstance(news, dict) else None


def _end(record: dict[str, Any], job: str, state: str, error: str | None) -> None:
    if state != "done":
        remove_quietly(record["path"])
    for leftover in Path(record["states"]).glob(f"{_safe_id(job)}.*"):
        remove_quietly(str(leftover))
    record["state"] = state
    if error:
        record["error"] = error


def render_status(_host: Any, args: dict[str, Any]) -> dict[str, Any]:
    """{jobId} -> {state: rendering | done | failed | cancelled, fraction?, path?, error?}. The end of a
    job has a file of its own, so a progress event Media Encoder delivers late can't hide it."""
    job, record = _job(args)
    if record["state"] in ENDED:
        return _report(record)
    done = _read_state(record, job, "done")
    failed = _read_state(record, job, "failed")
    if done is not None:
        written = str(done.get("path") or record["path"])
        if written != record["path"] and inside(written, renders_root()) and os.path.isfile(written):
            record["path"] = written
        if os.path.isfile(record["path"]) and os.path.getsize(record["path"]) > 0:
            _end(record, job, "done", None)
        else:
            _end(
                record,
                job,
                "failed",
                "Media Encoder said the render was done, but the file isn't there",
            )
    elif failed is not None:
        _end(
            record,
            job,
            "failed",
            str(failed.get("error") or "Media Encoder's render failed"),
        )
    else:
        progress = _read_state(record, job, "progress") or {}
        try:
            record["fraction"] = max(record["fraction"], min(1.0, float(progress.get("fraction") or 0)))
        except (TypeError, ValueError):
            pass
    return _report(record)


def cancel_render(host: Any, args: dict[str, Any]) -> dict[str, Any]:
    """{jobId} -> Media Encoder's batch stopped and the partial file removed. Every job in Media
    Encoder's queue is paused with it, so the answer says so."""
    job, record = _job(args)
    if record["state"] in ENDED:
        return _report(record)
    status = render_status(host, args)
    if status["state"] in ENDED:
        return status
    host._send("encode_cancel", {})
    _end(record, job, "cancelled", None)
    return {
        **_report(record),
        "note": "Media Encoder's whole queue was stopped; other jobs in it wait to be started again there",
    }
