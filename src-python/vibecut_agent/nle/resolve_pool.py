"""Read-only Media Pool awareness for the agent (PLAN.md, "Phase 6a"), ported from VibeCut's
host-resolve/resolve_pool.py (its "Connect page", phase 3a). Resolve's own transcripts (get_transcripts,
transcribe_clips) come with it and are registered in Phase 6b.

Three commands: `read_media_pool` (bins, clips, and what's selected in the pool and on the connected
timeline), `get_clip_info` (one clip in full: logging metadata, clip markers, In/Out) and
`search_media_pool` (over every clip, so it still works when the snapshot is abridged). Nothing here
changes the project.

What Resolve 21.1 gives (checked live against a logged scratch pool):
- `GetClipProperty()` (one call, about 200 keys) has "Type" ("Video + Audio", "Video", "Audio",
  "Timeline", "Still", ...), "Frames", "FPS" (a number), "Resolution", "Start TC", "File Path",
  "Clip Color", "Flags" (comma-separated), "In"/"Out" (timecodes, empty when unmarked), "Usage" (times
  used on timelines) and "Online Status". Keywords are not among them.
- `GetMetadata()` has the logged fields that are set: "Keywords", "Comments", "Description",
  "Scene", "Shot", "Take", ... ("Good Take" can't be set through the API, but is read if present).
- `GetMarkInOut()` gives In/Out in frames from the clip's start; clip `GetMarkers()` is keyed by frame
  from the clip's start.
- `MediaPool.GetSelectedClips()` and `Timeline.GetSelectedClips()` give the selections;
  `Timeline.GetCurrentVideoItem()` the clip under the playhead (only on the open timeline).
"""

from __future__ import annotations

from typing import Any

from vibecut_agent.nle.errors import HostError
from vibecut_agent.nle.resolve import timecode_to_frames

MAX_CLIPS = 2000
METADATA_KEYS = (
    "Keywords",
    "Comments",
    "Description",
    "Scene",
    "Shot",
    "Take",
    "Good Take",
    "Angle",
    "Camera #",
    "Reel Name",
)
MAX_RESULTS = 200


def _walk(media_pool: Any) -> list[tuple[str, Any]]:
    """(bin path, clip) for every clip, folders depth-first in the pool's own order."""
    found: list[tuple[str, Any]] = []

    def visit(folder: Any, path: str) -> None:
        for clip in folder.GetClipList() or []:
            found.append((path, clip))
        for sub in folder.GetSubFolderList() or []:
            visit(sub, f"{path}/{sub.GetName()}")

    root = media_pool.GetRootFolder()
    visit(root, root.GetName() or "Master")
    return found


def _bins(media_pool: Any) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []

    def visit(folder: Any, path: str) -> None:
        out.append({"path": path, "clips": len(folder.GetClipList() or [])})
        for sub in folder.GetSubFolderList() or []:
            visit(sub, f"{path}/{sub.GetName()}")

    root = media_pool.GetRootFolder()
    visit(root, root.GetName() or "Master")
    return out


def _fps(props: dict[str, Any]) -> float | None:
    try:
        fps = float(str(props.get("FPS")).split()[0])
    except (ValueError, IndexError):
        return None
    return fps if fps > 0 else None


def _seconds_from_start(timecode: Any, start_tc: Any, fps: float) -> float | None:
    if not timecode:
        return None
    try:
        return round(
            (timecode_to_frames(str(timecode), fps) - timecode_to_frames(str(start_tc or "00:00:00:00"), fps))
            / fps,
            3,
        )
    except HostError:
        return None


def clip_summary(bin_path: str, clip: Any) -> dict[str, Any]:
    """What the agent sees of one clip in the snapshot and in search results."""
    props = clip.GetClipProperty() or {}
    fps = _fps(props)
    summary: dict[str, Any] = {
        "id": clip.GetUniqueId(),
        "name": props.get("Clip Name") or clip.GetName(),
        "bin": bin_path,
        "type": props.get("Type", ""),
    }
    try:
        frames = int(str(props.get("Frames") or 0))
    except ValueError:
        frames = 0
    if fps and not frames and props.get("Duration"):
        # Resolve leaves "Frames" empty for sound files; their "Duration" timecode is there.
        try:
            frames = timecode_to_frames(str(props["Duration"]), fps)
        except HostError:
            frames = 0
    if fps and frames:
        summary["duration"] = round(frames / fps, 3)
    if fps:
        summary["fps"] = fps
    for key, field in (
        ("Resolution", "resolution"),
        ("File Path", "filePath"),
        ("Clip Color", "clipColor"),
    ):
        if props.get(key):
            summary[field] = props[key]
    flags = [f.strip() for f in str(props.get("Flags") or "").split(",") if f.strip()]
    if flags:
        summary["flags"] = flags
    try:
        usage = int(str(props.get("Usage") or 0))
    except ValueError:
        usage = 0
    summary["usage"] = usage
    if props.get("Online Status") and props["Online Status"] != "Online":
        summary["offline"] = True
    if fps:
        mark_in = _seconds_from_start(props.get("In"), props.get("Start TC"), fps)
        mark_out = _seconds_from_start(props.get("Out"), props.get("Start TC"), fps)
        if mark_in is not None and mark_out is not None and mark_out > mark_in:
            summary["markIn"], summary["markOut"] = mark_in, mark_out
    metadata = clip.GetMetadata() or {}
    if isinstance(metadata, dict):
        logged = {key: metadata[key] for key in METADATA_KEYS if metadata.get(key)}
        if logged:
            summary["metadata"] = logged
    return summary


def _selection(project: Any, media_pool: Any, timeline_name: Any) -> dict[str, Any]:
    pool = [c.GetUniqueId() for c in media_pool.GetSelectedClips() or []]
    selection: dict[str, Any] = {"pool": pool, "timeline": [], "underPlayhead": None}
    current = project.GetCurrentTimeline()
    # Only the open timeline has a selection and a playhead; report it only when that's the connected one.
    if current and isinstance(timeline_name, str) and current.GetName() == timeline_name:
        selection["timeline"] = [item.GetUniqueId() for item in current.GetSelectedClips() or []]
        item = current.GetCurrentVideoItem()
        selection["underPlayhead"] = item.GetUniqueId() if item else None
    return selection


def read_media_pool(host: Any, args: dict[str, Any]) -> dict[str, Any]:
    """{timeline (optional: the connected one, for its selection)} -> bins, clips, timelines, selection."""
    project = host._project()
    media_pool = project.GetMediaPool()
    clips: list[dict[str, Any]] = []
    timelines: list[str] = []
    truncated = False
    for bin_path, clip in _walk(media_pool):
        if (clip.GetClipProperty("Type") or "") == "Timeline":
            timelines.append(clip.GetName())
            continue
        if len(clips) >= MAX_CLIPS:
            truncated = True
            continue
        clips.append(clip_summary(bin_path, clip))
    return {
        "bins": _bins(media_pool),
        "clips": clips,
        "timelines": timelines,
        "truncated": truncated,
        "selection": _selection(project, media_pool, args.get("timeline")),
    }


def find_clip(media_pool: Any, clip_id: Any) -> tuple[str, Any]:
    if not isinstance(clip_id, str) or not clip_id:
        raise HostError("clipId must name a Media Pool clip")
    for bin_path, clip in _walk(media_pool):
        if clip.GetUniqueId() == clip_id:
            return bin_path, clip
    raise HostError(f"There is no Media Pool clip {clip_id!r} any more")


def get_clip_info(host: Any, args: dict[str, Any]) -> dict[str, Any]:
    """{clipId} -> the clip's summary, its markers (seconds from the clip's start) and every logged
    property that's set."""
    media_pool = host._project().GetMediaPool()
    bin_path, clip = find_clip(media_pool, args.get("clipId"))
    info = clip_summary(bin_path, clip)
    fps = info.get("fps") or 25.0
    info["markers"] = [
        {
            "time": round(int(frame) / fps, 3),
            "name": m.get("name", ""),
            "color": m.get("color", ""),
            "note": m.get("note", ""),
            "duration": round(int(m.get("duration", 1) or 1) / fps, 3),
        }
        for frame, m in sorted((clip.GetMarkers() or {}).items())
    ]
    props = clip.GetClipProperty() or {}
    info["properties"] = {
        k: v for k, v in sorted(props.items()) if v not in ("", None, "0", 0) and not k.startswith("_")
    }
    return info


def _normal(value: Any) -> str:
    """ "Video + Audio" and "video+audio" alike."""
    return "".join(str(value).lower().split())


def _matches(summary: dict[str, Any], args: dict[str, Any]) -> bool:
    text = args.get("text")
    if isinstance(text, str) and text.strip():
        haystack = " ".join(
            [
                summary.get("name", ""),
                summary.get("bin", ""),
                summary.get("filePath", ""),
            ]
            + [str(v) for v in summary.get("metadata", {}).values()]
        ).lower()
        if not all(word in haystack for word in text.lower().split()):
            return False
    keyword = args.get("keyword")
    if isinstance(keyword, str) and keyword.strip():
        keywords = [
            k.strip().lower() for k in str(summary.get("metadata", {}).get("Keywords", "")).split(",")
        ]
        if keyword.strip().lower() not in keywords:
            return False
    color = args.get("clipColor")
    if (
        isinstance(color, str)
        and color.strip()
        and summary.get("clipColor", "").lower() != color.strip().lower()
    ):
        return False
    flag = args.get("flag")
    if (
        isinstance(flag, str)
        and flag.strip()
        and flag.strip().lower() not in [f.lower() for f in summary.get("flags", [])]
    ):
        return False
    kind = args.get("type")
    if isinstance(kind, str) and kind.strip() and _normal(kind) != _normal(summary.get("type", "")):
        return False
    bin_name = args.get("bin")
    if (
        isinstance(bin_name, str)
        and bin_name.strip()
        and bin_name.strip().lower() not in summary.get("bin", "").lower()
    ):
        return False
    if args.get("unused") is True and summary.get("usage", 0) > 0:
        return False
    return not (args.get("marked") is True and "markIn" not in summary)


def search_media_pool(host: Any, args: dict[str, Any]) -> dict[str, Any]:
    """{text, keyword, clipColor, flag, type ("Video + Audio", "Video", "Audio", "Still" ...: exact),
    bin, unused, marked} -- all optional, all must match."""
    media_pool = host._project().GetMediaPool()
    results: list[dict[str, Any]] = []
    total = 0
    for bin_path, clip in _walk(media_pool):
        if (clip.GetClipProperty("Type") or "") == "Timeline":
            continue
        summary = clip_summary(bin_path, clip)
        if _matches(summary, args):
            total += 1
            if len(results) < MAX_RESULTS:
                results.append(summary)
    return {"clips": results, "total": total}


# ------------------------------------------------------------------------------- transcripts

SENTENCE_END = (".", "?", "!")
SILENCE = "(...)"
MAX_TRANSCRIBE = 50


def _clip_seconds(timecode: Any, start_frames: int, fps: float) -> float | None:
    """A transcript timecode (in the clip's own timecode) as seconds from the clip's start."""
    try:
        return round((timecode_to_frames(str(timecode), fps) - start_frames) / fps, 3)
    except HostError:
        return None


def sentences(transcription: Any, start_tc: Any, fps: float) -> list[dict[str, Any]]:
    """Resolve's transcript as sentences. Resolve's segments can run for many seconds (one was 12 s), which
    would make the Story Editor's cuts coarse, so each is split after every word ending a sentence,
    using the words' own timings; silences ("(...)") are dropped. Times are seconds from the clip's start
    (Resolve gives timecodes in the clip's own timecode, e.g. 01:00:02:05)."""
    if not isinstance(transcription, dict):
        return []
    try:
        start_frames = timecode_to_frames(str(start_tc or "00:00:00:00"), fps)
    except HostError:
        start_frames = 0
    out: list[dict[str, Any]] = []
    for segment in transcription.get("segments") or []:
        if not isinstance(segment, dict):
            continue
        speaker = segment.get("speaker") or ""
        words = [
            w
            for w in segment.get("words") or []
            if isinstance(w, dict) and (w.get("text") or "").strip() not in ("", SILENCE)
        ]
        if not words:
            text = (segment.get("text") or "").replace(SILENCE, "").strip()
            start, end = (
                _clip_seconds(segment.get("start"), start_frames, fps),
                _clip_seconds(segment.get("end"), start_frames, fps),
            )
            if text and start is not None and end is not None and end > start:
                out.append({"start": start, "end": end, "text": text, "speaker": speaker})
            continue
        current: list[dict[str, Any]] = []
        for i, word in enumerate(words):
            current.append(word)
            last = i == len(words) - 1
            if last or word["text"].strip().endswith(SENTENCE_END):
                start = _clip_seconds(current[0].get("start"), start_frames, fps)
                end = _clip_seconds(current[-1].get("end"), start_frames, fps)
                text = "".join(w["text"] for w in current).strip()
                if start is not None and end is not None and end > start and text:
                    out.append({"start": start, "end": end, "text": text, "speaker": speaker})
                current = []
    return out


def _clip_ids(args: dict[str, Any], limit: int) -> list[str]:
    ids = args.get("clipIds")
    if not isinstance(ids, list) or not ids or not all(isinstance(i, str) and i for i in ids):
        raise HostError("clipIds must be a non-empty list of Media Pool clip ids")
    if len(ids) > limit:
        raise HostError(f"At most {limit} clips at a time")
    return list(dict.fromkeys(ids))


def get_transcripts(host: Any, args: dict[str, Any]) -> dict[str, Any]:
    """{clipIds} -> per clip {clipId, name, filePath, transcribed, segments: [{start, end, text, speaker}]}
    from Resolve's own transcription (Studio's AI transcription, `MediaPoolItem.GetTranscription`)."""
    media_pool = host._project().GetMediaPool()
    clips = []
    for clip_id in _clip_ids(args, 500):
        _bin, clip = find_clip(media_pool, clip_id)
        props = clip.GetClipProperty() or {}
        fps = _fps(props) or 25.0
        transcription = clip.GetTranscription() if hasattr(clip, "GetTranscription") else None
        segments = sentences(transcription, props.get("Start TC"), fps)
        clips.append({
            "clipId": clip_id,
            "name": props.get("Clip Name") or clip.GetName(),
            "filePath": props.get("File Path") or None,
            "transcribed": bool(transcription),
            "segments": segments,
        })  # fmt: skip
    return {"clips": clips}


def transcribe_clips(host: Any, args: dict[str, Any]) -> dict[str, Any]:
    """{clipIds, speakers (detect speakers, default true)} -> runs Resolve's transcription on each clip
    in turn. It blocks until done: about 40 s for a 15 s clip the first time, a few seconds after."""
    media_pool = host._project().GetMediaPool()
    speakers = args.get("speakers") is not False
    done: list[Any] = []
    failed: list[Any] = []
    for clip_id in _clip_ids(args, MAX_TRANSCRIBE):
        _bin, clip = find_clip(media_pool, clip_id)
        if not hasattr(clip, "TranscribeAudio"):
            raise HostError(
                "This version of Resolve can't transcribe through its scripting API (Resolve Studio 19 or later)"
            )
        (done if clip.TranscribeAudio(speakers) else failed).append(clip_id)
    return {"transcribed": done, "failed": failed}
