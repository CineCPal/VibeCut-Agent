"""The Story Editor's cut (PLAN.md, "Phase 6d"): a slim port of rough-cut-studio's `Api.assemble`.

Kept from VibeCut, verbatim in behaviour:
- `load_sources`: `_load_sources_from_transcripts` (inline transcript JSON, a malformed segment skipped).
- `resolve_main_segments`: `_resolve_main_segments` — every pick checked against the real transcript,
  trims that leave less than 0.3 s fall back to the whole line, a line chosen twice kept once, and the
  map from the model's own `order` to the final one.
- `resolve_broll_segments`: `_resolve_broll_segments` — B-roll ids checked against the catalog, each
  anchored to a main cut and turned into a timeline second, durations clamped to the clip.
- The `result` event of headless.py's `_finish`, the shape VibeCut's `roughCutPlan` reads.

Left out: the Script/XML/FCPXML/OTIO files (the app builds the timeline from `resolvedSegments`, and
`rebuild` writes the interchange), project history, the generation lock (one run per process here) and
drop-frame timecode (timecodes only label the lines in the prompt).
"""

from __future__ import annotations

import os
import re
from dataclasses import asdict, dataclass
from typing import Any

MIN_MODEL_TRIM_SECONDS = 0.3


@dataclass
class Segment:
    index: int
    start_seconds: float
    end_seconds: float
    start_tc: str
    end_tc: str
    speaker: str | None
    text: str

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


def seconds_to_smpte(total_seconds: float, fps: float) -> str:
    """rough-cut-studio's transcript_parser.seconds_to_smpte, non-drop-frame."""
    total_frames = round(max(0.0, total_seconds) * fps)
    fps_int = max(1, round(fps))
    frames = int(total_frames % fps_int)
    total_secs = total_frames // fps_int
    return f"{total_secs // 3600:02d}:{(total_secs // 60) % 60:02d}:{total_secs % 60:02d}:{frames:02d}"


def seconds_to_duration_label(total_seconds: float) -> str:
    """e.g. 92.4 -> '1m 32s' (transcript_parser.seconds_to_duration_label)."""
    total = max(0, round(total_seconds))
    m, s = divmod(total, 60)
    h, m = divmod(m, 60)
    if h:
        return f"{h}h {m}m {s}s"
    if m:
        return f"{m}m {s}s"
    return f"{s}s"


_DURATION_UNITS = re.compile(
    r"^(?:(\d+(?:\.\d+)?)\s*(?:h|hr|hrs|hour|hours))?\s*"
    r"(?:(\d+(?:\.\d+)?)\s*(?:m|min|mins|minute|minutes))?\s*"
    r"(?:(\d+(?:\.\d+)?)\s*(?:s|sec|secs|second|seconds)?)?$"
)
_DURATION_TAIL = re.compile(r"\s+(?:long|total|in length|cut|video|edit)$")


def parse_duration_string(text: Any) -> float | None:
    """transcript_parser.parse_duration_string: "90", "90s", "2 min", "1m 30s", "2-minute cut",
    "1:30", "01:02:03" (and, new here, a leading "a", as in "a 2-minute cut", which the agent passes
    on as the user said it). None for empty input; ValueError for anything unreadable."""
    if text is None:
        return None
    raw = str(text).strip()
    text = raw.lower().lstrip("~").strip()
    if text.startswith("about "):
        text = text[len("about ") :].strip()
    text = _DURATION_TAIL.sub("", re.sub(r"(\d)-(?=[a-z])", r"\1 ", text)).strip()
    if text.startswith("a "):
        text = text[2:].strip()
    if not text:
        return None
    if ":" in text:
        parts = text.rstrip("s").split(":")
        if not all(p.isdigit() for p in parts):
            raise ValueError(f"Couldn't read '{raw}' as a duration.")
        numbers = [int(p) for p in parts]
        if len(numbers) == 2:
            return float(numbers[0] * 60 + numbers[1])
        if len(numbers) == 3:
            return float(numbers[0] * 3600 + numbers[1] * 60 + numbers[2])
        raise ValueError(f"Couldn't read '{raw}' as a duration.")
    match = _DURATION_UNITS.match(text)
    if not match or not any(match.groups()):
        raise ValueError(f"Couldn't read '{raw}' as a duration.")
    h, m, s = (float(g) if g else 0.0 for g in match.groups())
    return h * 3600 + m * 60 + s


def coerce_int(value: Any) -> int | None:
    """api._coerce_int: a model's number, even written as text; never a bool."""
    if isinstance(value, bool):
        return None
    if isinstance(value, int):
        return value
    if isinstance(value, float):
        return round(value)
    if isinstance(value, str):
        s = value.strip()
        try:
            return int(s)
        except ValueError:
            try:
                return round(float(s))
            except ValueError:
                return None
    return None


def coerce_float(value: Any, default: float | None = 0.0) -> float | None:
    """api._coerce_float."""
    if isinstance(value, bool):
        return default
    if isinstance(value, (int, float)):
        return float(value)
    if isinstance(value, str) and value.strip():
        try:
            return float(value.strip())
        except ValueError:
            return default
    return default


def _float(value: Any, default: float) -> float:
    out = coerce_float(value, default)
    return default if out is None else out


class Story:
    """One assemble run's sources, media and frame rate (the part of rough-cut-studio's Api it uses)."""

    def __init__(self, fps: float = 25.0) -> None:
        self.fps = fps if isinstance(fps, (int, float)) and not isinstance(fps, bool) and fps > 0 else 25.0
        self.sources: dict[str, dict[str, Any]] = {}
        self.media_paths: dict[str, str] = {}

    def tc(self, seconds: float) -> str:
        return seconds_to_smpte(seconds, self.fps)

    def display_name(self, source_id: str) -> str:
        """The name shown for a cut: the video file's, else the source id."""
        path = self.media_paths.get(source_id)
        return os.path.basename(path) if path else source_id

    def load_sources(self, transcripts: list[Any]) -> list[str]:
        """_load_sources_from_transcripts: [{sourceId, segments: [{start, end, text, speaker}]}]."""
        loaded = []
        for source in transcripts:
            if not isinstance(source, dict):
                continue
            source_id = source.get("sourceId")
            if not isinstance(source_id, str) or not source_id:
                continue
            raw_segments = source.get("segments")
            if not isinstance(raw_segments, list):
                continue
            segments = []
            for i, raw_seg in enumerate(raw_segments):
                if not isinstance(raw_seg, dict):
                    continue
                start = coerce_float(raw_seg.get("start"), None)
                end = coerce_float(raw_seg.get("end"), None)
                if start is None or end is None or end <= start:
                    continue
                text = raw_seg.get("text")
                speaker = raw_seg.get("speaker")
                segments.append(
                    Segment(
                        index=i,
                        start_seconds=start,
                        end_seconds=end,
                        start_tc=self.tc(start),
                        end_tc=self.tc(end),
                        speaker=speaker if isinstance(speaker, str) and speaker else None,
                        text=text if isinstance(text, str) else "",
                    )
                )
            if segments:
                self.sources[source_id] = {"segments": segments}
                loaded.append(source_id)
        return loaded

    def prompt_sources(self) -> list[dict[str, Any]]:
        return [
            {"source_id": sid, "segments": [s.to_dict() for s in e["segments"]]}
            for sid, e in self.sources.items()
        ]

    def resolve_main_segments(
        self, segs: list[Any], order_map: dict[int, int] | None = None
    ) -> tuple[list[dict[str, Any]], list[str]]:
        """_resolve_main_segments: (resolved main cuts in final order, problems)."""
        problems: list[str] = []
        resolved: list[dict[str, Any]] = []
        model_orders: list[int] = []
        picks: list[tuple[str, int]] = []
        for i, item in enumerate(segs):
            if not isinstance(item, dict):
                problems.append(f"Segment {i}: expected an object, got {type(item).__name__} — skipped.")
                continue
            source_id = item.get("source_id")
            entry = self.sources.get(source_id) if isinstance(source_id, str) else None
            if entry is None or not isinstance(source_id, str):
                problems.append(f"Segment {i}: unknown source_id '{source_id}' — skipped.")
                continue
            raw_idx = item.get("segment_index")
            idx = coerce_int(raw_idx)
            if idx is None or idx < 0 or idx >= len(entry["segments"]):
                problems.append(
                    f"Segment {i}: segment_index {raw_idx!r} isn't a valid index for '{source_id}' "
                    f"(has {len(entry['segments'])} segments) — skipped."
                )
                continue
            seg = entry["segments"][idx]
            in_off = max(0.0, _float(item.get("in_offset_seconds"), 0.0))
            out_off = max(0.0, _float(item.get("out_offset_seconds"), 0.0))
            in_seconds = seg.start_seconds + in_off
            out_seconds = seg.end_seconds - out_off
            if out_seconds - in_seconds < MIN_MODEL_TRIM_SECONDS:
                in_seconds, out_seconds = seg.start_seconds, seg.end_seconds
                problems.append(f"Segment {i}: trim made the clip too short — used the full segment instead.")
            order = coerce_int(item.get("order"))
            model_orders.append(order if order is not None else i)
            picks.append((source_id, idx))
            resolved.append(
                {
                    **item,
                    "order": order if order is not None else i,
                    "track": "main",
                    "source_id": source_id,
                    "source_name": self.display_name(source_id),
                    "in_seconds": in_seconds,
                    "out_seconds": out_seconds,
                    "in_tc": self.tc(in_seconds),
                    "out_tc": self.tc(out_seconds),
                    "note": item.get("editorial_note", ""),
                    "on_screen_text": item.get("on_screen_text", ""),
                    "source_text": seg.text,
                }
            )
        ranked = sorted(zip(resolved, model_orders, picks, strict=True), key=lambda t: t[0]["order"])
        kept: list[dict[str, Any]] = []
        final_by_segment: dict[tuple[str, int], int] = {}
        for s, model_order, segment in ranked:
            if segment in final_by_segment:
                problems.append(
                    f"Segment at order {model_order}: the same line from '{s['source_id']}' was "
                    "already used earlier in the cut — skipped the repeat."
                )
                if order_map is not None:
                    order_map.setdefault(model_order, final_by_segment[segment])
                continue
            final_by_segment[segment] = len(kept)
            if order_map is not None:
                order_map.setdefault(model_order, len(kept))
            kept.append(s)
        for i, s in enumerate(kept):
            s["order"] = i
        return kept, problems

    def resolve_broll_segments(
        self,
        raw: dict[str, Any],
        catalog: list[dict[str, Any]],
        main_list: list[dict[str, Any]],
        order_map: dict[int, int] | None = None,
    ) -> tuple[list[dict[str, Any]], list[str]]:
        """_resolve_broll_segments: (B-roll cuts with their timeline start, problems)."""
        problems: list[str] = []
        resolved: list[dict[str, Any]] = []
        catalog_by_id = {c["broll_id"]: c for c in catalog}
        main_by_order = {s["order"]: s for s in main_list}
        running = 0.0
        main_starts: dict[int, float] = {}
        for s in sorted(main_list, key=lambda s: s["order"]):
            main_starts[s["order"]] = running
            running += s["out_seconds"] - s["in_seconds"]

        raw_items = raw.get("broll_segments")
        if raw_items is None:
            return resolved, problems
        if not isinstance(raw_items, list):
            problems.append("The response's broll_segments was not a list — ignored.")
            return resolved, problems
        for i, item in enumerate(raw_items):
            if not isinstance(item, dict):
                problems.append(f"B-roll {i}: expected an object, got {type(item).__name__} — skipped.")
                continue
            broll_id = item.get("broll_id")
            clip = catalog_by_id.get(broll_id) if isinstance(broll_id, str) else None
            if clip is None or not isinstance(broll_id, str):
                problems.append(f"B-roll {i}: unknown broll_id '{broll_id}' — skipped.")
                continue
            anchor_order = coerce_int(item.get("anchor_order"))
            if anchor_order is not None and order_map is not None:
                anchor_order = order_map.get(anchor_order)
            if anchor_order is None or anchor_order not in main_by_order:
                problems.append(
                    f"B-roll {i}: anchor_order {item.get('anchor_order')!r} doesn't match a main cut — skipped."
                )
                continue
            anchor_main = main_by_order[anchor_order]
            anchor_span = anchor_main["out_seconds"] - anchor_main["in_seconds"]
            anchor_offset = min(
                max(0.0, _float(item.get("anchor_offset_seconds"), 0.0)), max(0.0, anchor_span - 0.1)
            )
            timeline_start_seconds = main_starts[anchor_order] + anchor_offset
            duration = _float(item.get("duration_seconds"), 0.0)
            clip_duration = clip["duration_seconds"]
            if duration <= 0:
                duration = min(clip_duration, 4.0)
            duration = min(duration, clip_duration)
            if duration < MIN_MODEL_TRIM_SECONDS:
                problems.append(f"B-roll {i}: '{broll_id}' resolved to too short a clip — skipped.")
                continue
            clip_path = clip.get("path")
            if not isinstance(clip_path, str) or not clip_path:
                problems.append(f"B-roll {i}: '{broll_id}' has no file path in the catalog — skipped.")
                continue
            self.media_paths[broll_id] = clip_path
            audio_mode = item.get("audio_mode")
            if audio_mode not in ("silent", "full", "duck_main"):
                audio_mode = "silent"
            duck_db = max(-60.0, min(0.0, _float(item.get("duck_db"), -12.0)))
            resolved.append(
                {
                    "order": i,
                    "track": "broll",
                    "source_id": broll_id,
                    "source_name": os.path.basename(clip_path),
                    "in_seconds": 0.0,
                    "out_seconds": duration,
                    "in_tc": self.tc(0.0),
                    "out_tc": self.tc(duration),
                    "note": item.get("editorial_note", ""),
                    "on_screen_text": "",
                    "source_text": "",
                    "timeline_start_seconds": timeline_start_seconds,
                    "timeline_start_tc": self.tc(timeline_start_seconds),
                    "audio_mode": audio_mode,
                    "duck_db": duck_db,
                }
            )
        return resolved, problems

    def result(
        self,
        raw: dict[str, Any],
        catalog: list[dict[str, Any]],
        sequence_name: str,
        target_seconds: float | None,
    ) -> dict[str, Any]:
        """The checked cut as headless.py's `result` event fields, or raises ValueError when the
        model chose nothing usable (with the reasons, as `_no_segments_error` gives them)."""
        main_segs = raw.get("script_segments")
        order_map: dict[int, int] = {}
        if main_segs is None:
            main_list: list[dict[str, Any]] = []
            problems = ["The response had no 'script_segments' array."]
        elif not isinstance(main_segs, list) or not main_segs:
            main_list, problems = [], []
        else:
            main_list, problems = self.resolve_main_segments(main_segs, order_map)
        if not main_list:
            message = "The model's response didn't reference any valid transcript segments."
            if problems:
                message += (
                    " "
                    + "; ".join(problems[:5])
                    + (f" (+{len(problems) - 5} more)" if len(problems) > 5 else "")
                )
            raise ValueError(message)
        broll_list, broll_problems = self.resolve_broll_segments(raw, catalog, main_list, order_map)
        problems += broll_problems

        running = 0.0
        for s in main_list:
            s["timeline_start_seconds"] = running
            s["timeline_start_tc"] = self.tc(running)
            running += s["out_seconds"] - s["in_seconds"]
        duration: dict[str, Any] = {
            "main_runtime_seconds": round(running, 3),
            "main_runtime_label": seconds_to_duration_label(running),
        }
        if target_seconds:
            # New here: the agent passes this on, so it can say the cut missed the brief's length.
            duration["target_seconds"] = target_seconds
            duration["target_label"] = seconds_to_duration_label(target_seconds)
            off = running - target_seconds
            if abs(off) > max(10.0, 0.25 * target_seconds):
                problems.append(
                    f"The cut runs {seconds_to_duration_label(running)}, "
                    f"{'over' if off > 0 else 'under'} the {seconds_to_duration_label(target_seconds)} target."
                )
        name = raw.get("sequence_name")
        return {
            "sequenceName": name if isinstance(name, str) and name.strip() else sequence_name,
            "narrativeSummary": raw.get("narrative_summary")
            if isinstance(raw.get("narrative_summary"), str)
            else "",
            "resolvedSegments": main_list + broll_list,
            "media": dict(self.media_paths),
            "duration": duration,
            "warnings": problems,
            "files": {},
        }
