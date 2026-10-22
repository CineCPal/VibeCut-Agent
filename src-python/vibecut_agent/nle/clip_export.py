"""Each timeline clip exported by itself, cut from its own source file with ffmpeg (PLAN.md,
"export_clips"). Shared by Premiere and Resolve: both read_timeline answers give a clip's filePath and
its sourceIn/sourceOut, so the editor is asked only for the timeline, never to render.

Standard library only (Resolve's watcher runs with Resolve's own Python, as renders.py does).
- The file is the source between the clip's In and Out (plus `handles`), at normal speed: no effects,
  grades, titles, other tracks or speed change. export_video renders the mix as the editor plays it.
- A video clip takes its linked audio from the same file into one file; an audio clip alone (or one
  recording split across channel tracks) becomes one .wav.
- export_clips answers once the clips are chosen; a worker thread runs ffmpeg clip by clip and
  clip_export_status reports it, so no editor call waits on a transcode.
"""

from __future__ import annotations

import contextlib
import os
import re
import secrets
import subprocess
import tempfile
import threading
import time
from typing import Any

from vibecut_agent.nle.errors import HostError
from vibecut_agent.nle.renders import ffmpeg, project_folder, remove_quietly, safe_name, unique_stem

FORMATS = ("source", "1080p", "720p", "prores", "copy")
# H.264 at the short side's height (never larger than the source), as export_video's presets are.
SHORT_SIDE = {"1080p": 1080, "720p": 720}
MAX_HANDLES_S = 60.0
MAX_CLIPS = 500
STILLS = (".png", ".jpg", ".jpeg", ".tif", ".tiff", ".psd", ".ai", ".bmp", ".gif", ".heic", ".exr", ".dpx")
ENDED = ("done", "failed", "cancelled")
NICENESS = 10

JOBS: dict[str, ClipJob] = {}


class ClipJob:
    """One export_clips run: its clips, the ffmpeg running now, and what has been written."""

    def __init__(self, folder: str, items: list[dict[str, Any]], fmt: str) -> None:
        self.folder = folder
        self.items = items
        self.format = fmt
        self.total_s = sum(item["out"] - item["in"] for item in items) or 1.0
        self.state = "rendering"
        self.done = 0
        self.done_s = 0.0
        self.current_s = 0.0
        self.files: list[str] = []
        self.failed: list[dict[str, str]] = []
        self.started = time.monotonic()
        self.cancelled = False
        self.process: subprocess.Popen[str] | None = None
        self.partial: str | None = None
        self.lock = threading.Lock()


def _track_key(text: Any) -> tuple[str, int] | None:
    """ "V1" / "A2" (or "video 1") as ("video", 1)."""
    match = re.fullmatch(r"\s*(v|a|video|audio)\s*(\d+)\s*", str(text or ""), re.IGNORECASE)
    if not match:
        return None
    return ("video" if match.group(1).lower().startswith("v") else "audio", int(match.group(2)))


def _missing(path: str) -> str:
    parts = path.split("/")
    if len(parts) > 2 and parts[1] == "Volumes" and not os.path.isdir("/".join(parts[:3])):
        return f"its drive {parts[2]!r} isn't attached"
    return "its file isn't there"


def _why_not(clip: dict[str, Any], include_disabled: bool) -> str | None:
    if clip.get("kind") == "effect":
        return "a transition, adjustment layer or generator has no source file"
    if clip.get("nested"):
        return "a nested sequence or compound clip has no single source file"
    path = clip.get("filePath")
    if not path:
        return "a title or graphic has no source file"
    if os.path.splitext(path)[1].lower() in STILLS:
        return "a still image"
    if clip.get("offline"):
        return f"offline: {_missing(path)}"
    if not os.path.isfile(path):
        return _missing(path)
    if not clip.get("enabled", True) and not include_disabled:
        return "disabled on the timeline (includeDisabled exports it)"
    if not isinstance(clip.get("sourceIn"), (int, float)) or not isinstance(
        clip.get("sourceOut"), (int, float)
    ):
        return "the editor didn't say where it starts in its file"
    return None


def _label(clip: dict[str, Any]) -> str:
    """The clip's name without its file's extension ("A.mov" -> "A")."""
    name = str(clip.get("name") or os.path.basename(str(clip.get("filePath") or "")) or "Clip")
    stem, ext = os.path.splitext(name)
    if stem and ext.lower() == os.path.splitext(str(clip.get("filePath") or ""))[1].lower():
        return stem
    return name


def choose(
    timeline: dict[str, Any], args: dict[str, Any]
) -> tuple[list[dict[str, Any]], list[dict[str, Any]], list[str]]:
    """(items, skipped, notes): what to cut, in timeline order. An item is {ids, name, path, in, out,
    video, audio, start}; a skipped clip is {id, name, reason}."""
    handles = args.get("handles", 0) or 0
    if (
        not isinstance(handles, (int, float))
        or isinstance(handles, bool)
        or not 0 <= handles <= MAX_HANDLES_S
    ):
        raise HostError(f"handles must be 0 to {round(MAX_HANDLES_S)} seconds")
    include_disabled = args.get("includeDisabled") is True
    tracks = [t for t in timeline.get("tracks", []) if t.get("type") in ("video", "audio")]
    by_id = {c["id"]: (t, c) for t in tracks for c in t.get("clips", [])}

    ids = args.get("clipIds")
    track = args.get("track")
    skipped: list[dict[str, Any]] = []
    if ids is not None:
        if not isinstance(ids, list) or not ids or not all(isinstance(i, str) for i in ids):
            raise HostError("clipIds must be a non-empty list of clip ids from read_timeline")
        wanted = []
        for clip_id in dict.fromkeys(ids):
            if clip_id in by_id:
                wanted.append(by_id[clip_id])
            else:
                skipped.append({"id": clip_id, "name": "", "reason": "not on this timeline"})
    elif track is not None:
        key = _track_key(track)
        if key is None:
            raise HostError('track must be like "V1" or "A2"')
        found = [t for t in tracks if (t["type"], t["index"]) == key]
        if not found:
            raise HostError(f"{track} isn't a track on {timeline.get('timeline')!r}")
        wanted = [(found[0], c) for c in found[0].get("clips", [])]
    else:
        wanted = [(t, c) for t in tracks for c in t.get("clips", [])]

    # Video first, so a picture takes its linked sound from the same file before that sound is
    # considered on its own.
    wanted.sort(key=lambda tc: (tc[0]["type"] != "video", tc[1].get("start", 0), tc[0]["index"]))
    items: list[dict[str, Any]] = []
    notes: list[str] = []
    used: set[str] = set()
    for track_info, clip in wanted:
        if clip["id"] in used:
            continue
        used.add(clip["id"])
        reason = _why_not(clip, include_disabled)
        if reason:
            # Transitions are listed as clips; skipping them is expected, not news.
            if not str(clip["id"]).startswith("tr-"):
                skipped.append({"id": clip["id"], "name": clip.get("name", ""), "reason": reason})
            continue
        path = clip["filePath"]
        video = track_info["type"] == "video"
        audio = not video
        ids_here = [clip["id"]]
        sounds = [clip]
        if video:
            sounds = [
                by_id[i][1]
                for i in clip.get("linkedIds", [])
                if i in by_id and by_id[i][0]["type"] == "audio"
            ]
            sounds = [c for c in sounds if c.get("filePath") == path and c["id"] not in used]
            audio = bool(sounds)
        # One recording split across channel tracks (A1 left, A2 right) is one file.
        for sound in sounds:
            for t, other in by_id.values():
                if (
                    other["id"] not in used
                    and t["type"] == "audio"
                    and other.get("filePath") == path
                    and other.get("start") == sound.get("start")
                    and other.get("sourceIn") == sound.get("sourceIn")
                ):
                    used.add(other["id"])
                    ids_here.append(other["id"])
        low, high = sorted((float(clip["sourceIn"]), float(clip["sourceOut"])))
        start = max(0.0, low - handles)
        end = high + handles
        if end - start < 0.01:
            skipped.append({"id": clip["id"], "name": clip.get("name", ""), "reason": "shorter than a frame"})
            continue
        speed = clip.get("speed")
        if isinstance(speed, (int, float)) and speed != 1:
            how = "reversed" if speed < 0 else f"at {round(abs(speed) * 100)}%"
            notes.append(
                f"{_label(clip)} plays {how} on the timeline; its file is the source at normal speed"
            )
        items.append(
            {"ids": ids_here, "name": _label(clip), "path": path, "in": round(start, 3), "out": round(end, 3),
             "video": video, "audio": audio, "start": clip.get("start", 0)}
        )  # fmt: skip
    if len(items) > MAX_CLIPS:
        raise HostError(f"At most {MAX_CLIPS} clips at a time")
    items.sort(key=lambda item: item["start"])
    return items, skipped, notes


def ffmpeg_args(item: dict[str, Any], fmt: str, out: str) -> list[str]:
    """ffmpeg's arguments (after the binary) for one item. -ss before -i with a re-encode is exact to
    the frame; with copy the cut lands on the keyframe before."""
    args = ["-v", "error", "-nostdin", "-n", "-ss", f"{item['in']:.3f}", "-i", item["path"],
            "-t", f"{item['out'] - item['in']:.3f}", "-map_metadata", "-1"]  # fmt: skip
    if not item["video"]:
        args += ["-vn", "-map", "0:a:0", "-c:a", "pcm_s24le"]
    else:
        args += ["-map", "0:v:0"] + (["-map", "0:a?"] if item["audio"] else ["-an"])
        if fmt == "copy":
            args += ["-c", "copy"]
        elif fmt == "prores":
            args += ["-c:v", "prores_ks", "-profile:v", "3", "-c:a", "pcm_s24le"]
        else:
            args += ["-c:v", "libx264", "-preset", "medium", "-crf", "18", "-pix_fmt", "yuv420p",
                     "-vf", _scale(SHORT_SIDE.get(fmt)), "-c:a", "aac", "-b:a", "320k",
                     "-movflags", "+faststart"]  # fmt: skip
    return args + ["-progress", "pipe:1", "-nostats", out]


def _scale(short: int | None) -> str:
    """Even sizes (H.264 needs them); with `short`, the short side at most that many pixels."""
    if short is None:
        return "scale=trunc(iw/2)*2:trunc(ih/2)*2"
    side = f"trunc(min({{}},{short})/2)*2"
    return f"scale=w='if(gte(iw,ih),-2,{side.format('iw')})':h='if(gte(iw,ih),{side.format('ih')},-2)'"


def extension(item: dict[str, Any], fmt: str) -> str:
    if not item["video"]:
        return ".wav"
    if fmt == "prores":
        return ".mov"
    if fmt == "copy":
        ext = os.path.splitext(item["path"])[1].lower()
        return ext if ext in (".mov", ".mp4", ".m4v", ".mxf", ".mkv") else ".mov"
    return ".mp4"


def _run_one(job: ClipJob, item: dict[str, Any], out: str) -> str | None:
    """Runs ffmpeg for one item; None when it wrote the file, else why not."""
    with tempfile.TemporaryFile(mode="w+") as errors:
        try:
            process = subprocess.Popen(
                [ffmpeg(), *ffmpeg_args(item, job.format, out)],
                stdout=subprocess.PIPE,
                stderr=errors,
                stdin=subprocess.DEVNULL,
                text=True,
            )
        except OSError as exc:
            return f"ffmpeg didn't start: {exc}"
        # Below the editor, so a long transcode doesn't slow Premiere into answering late.
        with contextlib.suppress(OSError, AttributeError):
            os.setpriority(os.PRIO_PROCESS, process.pid, NICENESS)
        with job.lock:
            job.process = process
            job.partial = out
        assert process.stdout is not None
        for line in process.stdout:
            key, _, value = line.strip().partition("=")
            # out_time_ms is in microseconds too (an old ffmpeg naming slip).
            if key in ("out_time_us", "out_time_ms") and value.lstrip("-").isdigit():
                with job.lock:
                    job.current_s = max(0.0, int(value) / 1_000_000)
        code = process.wait()
        with job.lock:
            job.process = None
        if code == 0 and os.path.isfile(out):
            return None
        errors.seek(0)
        lines = errors.read().strip().splitlines()
        return lines[-1] if lines else f"ffmpeg stopped (exit {code})"


def _work(job: ClipJob) -> None:
    for n, item in enumerate(job.items, start=1):
        if job.cancelled:
            break
        ext = extension(item, job.format)
        out = os.path.join(
            job.folder, unique_stem(job.folder, f"{n:02d} {safe_name(item['name'], 'Clip')}", (ext,)) + ext
        )
        error = _run_one(job, item, out)
        with job.lock:
            job.partial = None
            job.current_s = 0.0
            job.done_s += item["out"] - item["in"]
            if job.cancelled:
                remove_quietly(out)
                break
            job.done += 1
            if error is None:
                job.files.append(out)
            else:
                remove_quietly(out)
                job.failed.append({"clip": item["name"], "error": error})
    with job.lock:
        if job.cancelled:
            job.state = "cancelled"
        elif job.files:
            job.state = "done"
        else:
            job.state = "failed"


def export_clips(host: Any, args: dict[str, Any]) -> dict[str, Any]:
    """{timeline, clipIds? | track?, handles?, format?: source | 1080p | 720p | prores | copy,
    includeDisabled?, name?}
    -> {jobId, folder, total, skipped, notes}; the files are written by a worker thread."""
    fmt = args.get("format", "source")
    if fmt not in FORMATS:
        raise HostError(f"format must be one of {', '.join(FORMATS)}")
    ffmpeg()  # says how to install it before anything is chosen
    timeline = host.read_timeline({"timeline": args.get("timeline")})
    items, skipped, notes = choose(timeline, args)
    if not items:
        why = "; ".join(f"{s['name'] or s['id']}: {s['reason']}" for s in skipped[:5])
        raise HostError("None of those clips can be exported" + (f" ({why})" if why else ""))
    base = project_folder(timeline.get("project"))
    stem = f"{safe_name(timeline.get('timeline'), 'Timeline')} clips"
    if args.get("name") is not None and str(args["name"]).strip():
        stem = f"{stem} - {safe_name(args['name'])}"
    folder = os.path.join(base, unique_stem(base, stem, ("",)))
    os.makedirs(folder)
    job_id = f"clips-{secrets.token_hex(4)}"
    job = ClipJob(folder, items, fmt)
    JOBS[job_id] = job
    threading.Thread(target=_work, args=(job,), name=f"export_clips {job_id}", daemon=True).start()
    return {"jobId": job_id, "folder": folder, "total": len(items), "skipped": skipped, "notes": notes}


def _job(args: dict[str, Any]) -> ClipJob:
    job = JOBS.get(str(args.get("jobId") or ""))
    if job is None:
        raise HostError("There is no clip export with that jobId in this connection")
    return job


def clip_export_status(_host: Any, args: dict[str, Any]) -> dict[str, Any]:
    """{jobId} -> {state, done, total, fraction, etaSeconds?, folder, files, failed}."""
    job = _job(args)
    with job.lock:
        so_far = min(job.total_s, job.done_s + job.current_s)
        fraction = round(so_far / job.total_s, 3)
        status: dict[str, Any] = {
            "state": job.state,
            "done": job.done,
            "total": len(job.items),
            "fraction": 1.0 if job.state == "done" else fraction,
            "folder": job.folder,
            "files": list(job.files),
            "failed": list(job.failed),
        }
        elapsed = time.monotonic() - job.started
        if job.state == "rendering" and 0 < fraction < 1 and elapsed > 1:
            status["etaSeconds"] = round(elapsed / fraction * (1 - fraction), 1)
    return status


def cancel_clip_export(host: Any, args: dict[str, Any]) -> dict[str, Any]:
    """{jobId} -> the status once the running ffmpeg is stopped; finished files are kept, the partial
    one removed."""
    job = _job(args)
    with job.lock:
        if job.state not in ENDED:
            job.cancelled = True
            if job.process is not None:
                job.process.kill()
    deadline = time.monotonic() + 10
    while time.monotonic() < deadline:
        with job.lock:
            if job.state in ENDED:
                break
        time.sleep(0.05)
    return clip_export_status(host, args)
