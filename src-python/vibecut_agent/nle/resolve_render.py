"""Renders of the connected Resolve timeline through its Deliver queue (PLAN.md, "Phase 15b"), ported
verbatim from VibeCut's host-resolve/resolve_render.py (its "Phase 7c"), without save_stills.

- `render_video {timeline, preset, range?, name?}` and `render_audio {timeline, format, range?, name?}`
  add one render job and start it, then answer at once with the job id and the file it will write in
  `~/Movies/VibeCut Renders/<project>/` (renders.py).
- `render_status {jobId}` reads the job. When it has ended it is taken off the queue, the settings
  Resolve had are put back, and the file is finished: an AAC export is renamed .m4a, and a WAV is
  taken out of its carrier movie by ffmpeg. A cancelled or failed render's partial file is removed.
- `cancel_render {jobId}` stops it.

What Resolve 21.1 does (checked live in VibeCut's "7c.0 probe"):
- There is no GetRenderSettings. The Deliver settings are kept by saving them as a temporary preset
  and loading it back; the target folder isn't in a preset, so it is read from a throwaway job first.
- Render settings carry over from job to job, so every field is set for each job.
- MarkIn/MarkOut set the timeline's own In and Out, so the marks are read first and put back.
- Adding a job opens the Deliver page; the page the user was on is opened again afterwards.
- Only the current timeline renders correctly (a job for another timeline wrote a broken file), so a
  render needs the connected timeline open.
- WAV can't be chosen as a format, and audio-only uncompressed sound won't start; a small ProRes
  Proxy movie with 24-bit sound renders, and its sound is copied out into the WAV.
- `CompletionPercentage` is coarse (0 for most of a render); StopRendering leaves the partial file.
"""

from __future__ import annotations

import os
import secrets
import time
from typing import Any

from vibecut_agent.nle.errors import HostError
from vibecut_agent.nle.renders import (
    RenderError,
    extract_wav,
    output_stem,
    remove_quietly,
)
from vibecut_agent.nle.resolve import _number, _to_frame
from vibecut_agent.nle.resolve import frame_rate as _frame_rate

VIDEO_PRESETS = ("source", "1080p", "720p", "prores")
AUDIO_FORMATS = ("wav", "aac")
SHORT_SIDE = {"1080p": 1080, "720p": 720}
CARRIER_WIDTH = 640
ENDED = ("done", "failed", "cancelled")
# StopRendering returns before the render has stopped, and until it has Resolve ignores deleting the
# job, loading a preset and changing page (checked live, 7c), so cancelling waits for it, this long.
STOP_WAIT_S = 15.0
STOP_POLL_S = 0.2

# The jobs this session started, by Resolve's job id. The session lives as long as the connection.
JOBS: dict[str, dict[str, Any]] = {}


def _even(value: float) -> int:
    n = max(16, round(value))
    return n if n % 2 == 0 else n - 1


def _timeline_size(timeline: Any) -> tuple[int, int]:
    try:
        width = int(float(timeline.GetSetting("timelineResolutionWidth")))
        height = int(float(timeline.GetSetting("timelineResolutionHeight")))
    except (TypeError, ValueError):
        width, height = 1920, 1080
    if width <= 0 or height <= 0:
        width, height = 1920, 1080
    return width, height


def _scaled(width: int, height: int, short: int) -> tuple[int, int]:
    """The size with its shorter side `short`: 1920x1080 for a 16:9 1080p, 1080x1920 for 9:16."""
    if width >= height:
        return _even(width * short / height), short
    return short, _even(height * short / width)


def _range(timeline: Any, fps: float, value: Any) -> tuple[bool, int, int]:
    """(select all, first frame, last frame), the frames counted from the timeline's start and both
    included, for "all" (the default), "in_out" (the timeline's own marks) or {start, end} seconds."""
    length = int(timeline.GetEndFrame()) - int(timeline.GetStartFrame())
    if value is None or value == "all":
        return True, 0, length - 1
    if value == "in_out":
        marks = timeline.GetMarkInOut() or {}
        picture = marks.get("video") or {}
        sound = marks.get("audio") or {}
        first = picture.get("in", sound.get("in"))
        last = picture.get("out", sound.get("out"))
        if first is None and last is None:
            raise HostError(
                f"{timeline.GetName()!r} has no In or Out marked in Resolve"
            )
        first = int(first) if first is not None else 0
        last = int(last) if last is not None else length - 1
        if not 0 <= first <= last < length:
            raise HostError("The In and Out marked in Resolve are outside the timeline")
        return False, first, last
    if isinstance(value, dict):
        start = _number(value.get("start"), "range.start")
        end = _number(value.get("end"), "range.end")
        first, stop = _to_frame(start, fps), _to_frame(end, fps)
        if start < 0 or stop > length or stop - first < 1:
            raise HostError(
                f"range must be within the timeline (0 to {round(length / fps, 3)} s) and at least a frame long"
            )
        return False, first, stop - 1
    raise HostError('range must be "all", "in_out" or {start, end} in seconds')


def _target_dir(project: Any) -> str | None:
    """The Deliver page's target folder, read from a job added and taken off again (21.1 has no
    GetRenderSettings). None when the project has never had one: then no job can be added."""
    job = project.AddRenderJob()
    if not job:
        return None
    try:
        for entry in project.GetRenderJobList() or []:
            if entry.get("JobId") == job:
                return entry.get("TargetDir") or None
    finally:
        project.DeleteRenderJob(job)
    return None


def _restore(resolve: Any, project: Any, timeline: Any, saved: dict[str, Any]) -> None:
    """Puts back the Deliver settings, the target folder, the timeline's marks and the page."""
    preset = saved["preset"]
    if preset:
        project.LoadRenderPreset(preset)
        project.DeleteRenderPreset(preset)
    if saved["target"]:
        project.SetRenderSettings({"TargetDir": saved["target"]})
    marks = saved["marks"]
    if timeline is not None and marks is not None:
        timeline.ClearMarkInOut("all")
        length = int(timeline.GetEndFrame()) - int(timeline.GetStartFrame())
        for kind in ("video", "audio"):
            mark = marks.get(kind) or {}
            if "in" in mark or "out" in mark:
                timeline.SetMarkInOut(
                    int(mark.get("in", 0)), int(mark.get("out", length - 1)), kind
                )
    if saved["page"] and resolve.GetCurrentPage() != saved["page"]:
        resolve.OpenPage(saved["page"])


def _start(host: Any, args: dict[str, Any], plan: dict[str, Any]) -> dict[str, Any]:
    project, timeline = host._timeline(args)
    current = project.GetCurrentTimeline()
    if not current or current.GetName() != timeline.GetName():
        raise HostError(
            f"Open {timeline.GetName()!r} in Resolve first: Resolve only renders the timeline that's open"
        )
    if project.IsRenderingInProgress():
        raise HostError(
            "Resolve is already rendering; wait for it to finish or stop it first"
        )
    fps = _frame_rate(timeline)
    select_all, first, last = _range(timeline, fps, args.get("range"))
    start = int(timeline.GetStartFrame())

    folder, stem = output_stem(
        project.GetName(), timeline.GetName(), args.get("name"), plan["extensions"]
    )
    rendered = os.path.join(folder, stem + plan["rendered"])
    final = os.path.join(folder, stem + plan["final"])

    saved: dict[str, Any] = {
        "page": host._resolve.GetCurrentPage(),
        "marks": timeline.GetMarkInOut() or {},
        "target": _target_dir(project),
        "preset": None,
    }
    preset = f"VibeCut before render {secrets.token_hex(3)}"
    if project.SaveAsNewRenderPreset(preset):
        saved["preset"] = preset
    try:
        if not project.SetCurrentRenderFormatAndCodec(plan["format"], plan["codec"]):
            raise HostError(
                f"Resolve didn't accept {plan['format']}/{plan['codec']} as the render format"
            )
        settings = {
            "TargetDir": folder,
            "CustomName": stem,
            "SelectAllFrames": select_all,
            "ExportVideo": plan["video"],
            "ExportAudio": True,
            "FormatWidth": plan["width"],
            "FormatHeight": plan["height"],
            "AudioCodec": plan["audio"],
        }
        if plan["audio"] == "lpcm":
            settings["AudioBitDepth"] = 24
        if not select_all:
            settings["MarkIn"] = start + first
            settings["MarkOut"] = start + last
        if not project.SetRenderSettings(settings):
            raise HostError("Resolve didn't accept the render settings")
        job = project.AddRenderJob()
        if not job:
            raise HostError("Resolve didn't add the render job")
        if not project.StartRendering([job], False):
            project.DeleteRenderJob(job)
            raise HostError("Resolve didn't start the render")
    except HostError:
        _restore(host._resolve, project, timeline, saved)
        raise
    seconds = round((last - first + 1) / fps, 3)
    JOBS[job] = {
        "timeline": timeline.GetName(),
        "rendered": rendered,
        "path": final,
        "finish": plan["finish"],
        "saved": saved,
        "state": "rendering",
        "seconds": seconds,
    }
    return {"jobId": job, "path": final, "seconds": seconds}


def render_video(host: Any, args: dict[str, Any]) -> dict[str, Any]:
    """{timeline, preset: source | 1080p | 720p | prores, range?, name?} -> {jobId, path, seconds}.
    source, 1080p and 720p are H.264 .mp4 with AAC sound; prores is ProRes 422 HQ .mov at the
    timeline's size with uncompressed sound."""
    preset = args.get("preset", "source")
    if preset not in VIDEO_PRESETS:
        raise HostError(f"preset must be one of {', '.join(VIDEO_PRESETS)}")
    _project, timeline = host._timeline(args)
    width, height = _timeline_size(timeline)
    if preset in SHORT_SIDE:
        width, height = _scaled(width, height, SHORT_SIDE[preset])
    plan: dict[str, Any]
    if preset == "prores":
        plan = {
            "format": "mov",
            "codec": "ProRes422HQ",
            "audio": "lpcm",
            "rendered": ".mov",
            "final": ".mov",
        }
    else:
        plan = {
            "format": "mp4",
            "codec": "H264",
            "audio": "aac",
            "rendered": ".mp4",
            "final": ".mp4",
        }
    plan.update(
        video=True, width=width, height=height, finish=None, extensions=(plan["final"],)
    )
    return _start(host, args, plan)


def render_audio(host: Any, args: dict[str, Any]) -> dict[str, Any]:
    """{timeline, format: wav | aac, range?, name?} -> {jobId, path, seconds}. aac is an .m4a; wav is
    24-bit, taken out of a small ProRes Proxy movie Resolve renders alongside (removed afterwards)."""
    fmt = args.get("format", "wav")
    if fmt not in AUDIO_FORMATS:
        raise HostError(f"format must be one of {', '.join(AUDIO_FORMATS)}")
    _project, timeline = host._timeline(args)
    plan: dict[str, Any]
    if fmt == "aac":
        width, height = _timeline_size(timeline)
        plan = {
            "format": "mp4", "codec": "H264", "audio": "aac", "video": False,
            "rendered": ".mp4", "final": ".m4a", "finish": "rename",
        }  # fmt: skip
    else:
        width, height = _timeline_size(timeline)
        width, height = CARRIER_WIDTH, _even(CARRIER_WIDTH * height / width)
        plan = {
            "format": "mov", "codec": "ProRes422P", "audio": "lpcm", "video": True,
            "rendered": ".mov", "final": ".wav", "finish": "wav",
        }  # fmt: skip
    plan.update(
        width=width, height=height, extensions=(plan["rendered"], plan["final"])
    )
    return _start(host, args, plan)


def _job(args: dict[str, Any]) -> tuple[str, dict[str, Any]]:
    job = args.get("jobId")
    if not isinstance(job, str) or job not in JOBS:
        raise HostError("There is no render with that jobId in this connection")
    return job, JOBS[job]


def _timeline_named(host: Any, project: Any, name: str) -> Any:
    for timeline in host._timelines(project):
        if timeline and timeline.GetName() == name:
            return timeline
    return None


def _report(record: dict[str, Any]) -> dict[str, Any]:
    out: dict[str, Any] = {"state": record["state"], "seconds": record["seconds"]}
    if record["state"] == "rendering":
        out["fraction"] = record.get("fraction", 0.0)
        if record.get("eta"):
            out["etaSeconds"] = record["eta"]
    if record["state"] == "done":
        out["path"] = record["path"]
    if record.get("error"):
        out["error"] = record["error"]
    return out


def _end(
    host: Any,
    project: Any,
    job: str,
    record: dict[str, Any],
    state: str,
    error: str | None,
) -> None:
    """Takes the job off the queue, puts the settings back, and finishes or removes the file."""
    project.DeleteRenderJob(job)
    timeline = _timeline_named(host, project, record["timeline"])
    _restore(host._resolve, project, timeline, record["saved"])
    if state == "done":
        try:
            if record["finish"] == "wav":
                extract_wav(record["rendered"], record["path"])
            elif record["finish"] == "rename":
                os.replace(record["rendered"], record["path"])
        except (RenderError, OSError) as exc:
            state, error = "failed", str(exc)
        if state == "done" and not (
            os.path.isfile(record["path"]) and os.path.getsize(record["path"]) > 0
        ):
            state, error = (
                "failed",
                "Resolve said the render was complete, but the file isn't there",
            )
    if state != "done":
        remove_quietly(record["rendered"])
        if record["rendered"] != record["path"]:
            remove_quietly(record["path"])
    record["state"] = state
    if error:
        record["error"] = error


def render_status(host: Any, args: dict[str, Any]) -> dict[str, Any]:
    """{jobId} -> {state: rendering | done | failed | cancelled, fraction?, etaSeconds?, path?, error?}."""
    job, record = _job(args)
    if record["state"] in ENDED:
        return _report(record)
    project = host._project()
    status = project.GetRenderJobStatus(job) or {}
    state = status.get("JobStatus")
    if state == "Complete":
        _end(host, project, job, record, "done", None)
    elif state == "Cancelled":
        _end(host, project, job, record, "cancelled", None)
    elif state == "Failed" or not status:
        reason = status.get("Error") or (
            "Resolve lost the render job (was the project changed?)"
            if not status
            else "Resolve's render failed"
        )
        _end(host, project, job, record, "failed", str(reason))
    else:
        record["fraction"] = max(
            0.0, min(1.0, float(status.get("CompletionPercentage") or 0) / 100)
        )
        eta = status.get("EstimatedTimeRemainingInMs")
        record["eta"] = round(float(eta) / 1000) if eta else None
    return _report(record)


def cancel_render(host: Any, args: dict[str, Any]) -> dict[str, Any]:
    """{jobId} -> the render stopped, its partial file removed and the settings put back."""
    job, record = _job(args)
    if record["state"] in ENDED:
        return _report(record)
    project = host._project()
    project.StopRendering()
    deadline = time.monotonic() + STOP_WAIT_S
    status = project.GetRenderJobStatus(job) or {}
    while status.get("JobStatus") == "Rendering" or project.IsRenderingInProgress():
        if time.monotonic() >= deadline:
            raise HostError(
                "Resolve is still stopping the render; ask for its status again in a moment"
            )
        time.sleep(STOP_POLL_S)
        status = project.GetRenderJobStatus(job) or {}
    if status.get("JobStatus") == "Complete":
        _end(host, project, job, record, "done", None)
    else:
        _end(host, project, job, record, "cancelled", None)
    return _report(record)
