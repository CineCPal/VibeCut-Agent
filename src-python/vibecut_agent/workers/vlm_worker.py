"""The local vision worker (ORCHESTRATOR_SPEC.md §3.4 B, `analyze_shot_visuals`; PLAN.md, "Phase 21").

Each shot (core/ffmpeg_ops.py, `extract_keyframes_for_vlm`: at scene cuts, every 2 s, or the middle of the
range) goes to the local VLM (`VIBECUT_VLM_MODEL` on `VIBECUT_LOCAL_LLM_BASE_URL`, or the first of its
MODEL_ALIASES the server has) as a 3-frame contact strip: its start, middle and end side by side (model
migration v2), so camera movement is read from three moments rather than guessed from one frame's blur; a
shot too short for one goes as its middle frame. The model labels it with the spec's fixed vocabulary: shot
scale, camera movement, lighting, composition, a sentence and tags, and a 0-100 editorial usability score.
Its answer is held to that schema; one that doesn't fit is asked for again once, with what was wrong.

One shot goes to the model at a time, each holding the GPU lock only for its own call, so a chat turn can
get in between shots of a long ingest; each call asks Ollama to keep the model loaded (KEEP_ALIVE), so it
isn't loaded again between them. A model server that keeps failing opens the worker's circuit breaker.

A whole-file analysis is cached next to the file as `<file>.vlm-tags.json`, valid while the file's size and
modified time, the model and the sampling are the same; a range is answered from that cache when it
exists. Keyframes live in `<index_dir>/keyframes/`. A custom question (`custom_prompt_focus`) is never
cached: its answer leads each shot's description."""

from __future__ import annotations

import copy
import hashlib
import json
import os
from collections.abc import Callable
from pathlib import Path
from typing import Any

from vibecut_agent.config import OrchestratorConfig
from vibecut_agent.core import ffmpeg_ops
from vibecut_agent.core.ffmpeg_ops import SAMPLE_STRATEGIES, SampleStrategy
from vibecut_agent.core.timecode_math import rational_to_seconds
from vibecut_agent.orchestrator.schemas import (
    VLM_KEYFRAME_ID,
    VLM_KEYFRAME_SCHEMA,
    VLM_VERSION,
    errors_against,
    validate,
)
from vibecut_agent.workers.base import CircuitBreaker, GpuLock, LocalLlmClient, LocalLlmError, WorkerHealth

CACHE_SUFFIX = ".vlm-tags.json"
# 2 (model migration v2): shots are read from contact strips, so a single-frame analysis is done again.
CACHE_VERSION = 2
KEEP_ALIVE = "10m"
KEYFRAME_FOLDER = "keyframes"
ATTEMPTS = 2
# The share of a whole-file analysis's progress the scene-cut scan fills (`analyze`). Seen live (the Phase
# 21 follow-up's checks): on a 4K interview the scan was about 90% of the step (0.3 made the ETA 2-3x high).
SCAN_SHARE = 0.8

# What the model fills in for one frame: a shot's fields, less the ones this worker knows already.
_KNOWN = ("shot_id", "source_range", "keyframe_timestamp_sec")
SHOT_SCHEMA: dict[str, Any] = VLM_KEYFRAME_SCHEMA["properties"]["shots"]["items"]
ANALYSIS_SCHEMA: dict[str, Any] = {
    **copy.deepcopy(SHOT_SCHEMA),
    "required": [field for field in SHOT_SCHEMA["required"] if field not in _KNOWN],
    "properties": {k: copy.deepcopy(v) for k, v in SHOT_SCHEMA["properties"].items() if k not in _KNOWN},
}

PROMPT = """You are a film editor's assistant logging footage. Look at this image from a video and describe it
with these labels, choosing only from the allowed values:%(strip)s

- shot_scale: ECU (extreme close-up: part of a face), CU (a face), MCU (head and shoulders), MS (waist up),
  MWS (knees up), WS (the whole body), EWS (people small in a big space), INSERT (a detail of an object or
  hands), OTS (over a shoulder), TWO_SHOT (two people framed together).
- camera_movement: %(movement)s
- lighting: key_style, color_temperature and contrast.
- composition: subject_count (people), eyeline_direction of the main subject (NONE without one),
  focus_quality, and obstructions (something blocking the subject).
- description: one plain sentence of what is in the frame.
- visual_tags: 3 to 8 short lowercase tags (objects, setting, action, mood).
- on_screen_text: any readable text in the frame, or null.
- editorial_usability_score: 0 to 100, how usable the shot is in an edit (sharp, well exposed, steady,
  well framed is high; blurred, dark, blocked or badly framed is low).

Answer with the JSON object only."""

STRIP_NOTE = """

The image is a contact strip of one shot: three frames side by side, left to right, from its start, its
middle and its end. Describe the shot as a whole; take scale, lighting and composition from the middle
frame."""
STRIP_MOVEMENT = """how the camera moves across the shot, judged by comparing the three frames left (start)
  to right (end): the scene sliding right means PAN_LEFT, sliding left PAN_RIGHT, sliding down TILT_UP,
  sliding up TILT_DOWN; the subject growing with the background shifting behind it means DOLLY_IN, shrinking
  DOLLY_OUT; growing with nothing shifting, ZOOM; small uneven shifts, HANDHELD; a smooth move following a
  moving subject, GIMBAL_TRACK; STATIC when the three frames are framed the same."""
FRAME_MOVEMENT = """what the camera is most likely doing, judged from motion blur and framing; STATIC when
  nothing suggests movement."""


def prompt_for(strip: bool) -> str:
    """PROMPT for a contact strip, or for one frame (a shot too short for a strip)."""
    return PROMPT % {
        "strip": STRIP_NOTE if strip else "",
        "movement": STRIP_MOVEMENT if strip else FRAME_MOVEMENT,
    }


Progress = Callable[[str, float, str], None]


class VlmWorkerError(RuntimeError):
    """The frames couldn't be analysed (no picture, model missing, an answer that never fit the schema)."""


def cache_path(media_path: str) -> str:
    return media_path + CACHE_SUFFIX


def _fingerprint(media_path: str) -> tuple[int, int]:
    stat = os.stat(media_path)
    return stat.st_size, int(stat.st_mtime)


def load_cache(media_path: str, model: str, strategy: str) -> dict[str, Any] | None:
    """The cached whole-file result, or None when there's none or it no longer fits the file, model or
    sampling."""
    try:
        with open(cache_path(media_path), encoding="utf-8") as f:
            data = json.load(f)
        result = data["result"]
        size, mtime = _fingerprint(media_path)
    except (OSError, ValueError, KeyError, TypeError):
        return None
    if (
        data.get("cache_version") != CACHE_VERSION
        or data.get("sample_strategy") != strategy
        or result.get("vlm_model_id") != model
        or result.get("video_size") != size
        or result.get("video_mtime") != mtime
    ):
        return None
    return result if isinstance(result, dict) else None


def write_cache(media_path: str, strategy: str, result: dict[str, Any]) -> bool:
    """Best effort, like the transcript cache: a read-only drive just means no cache."""
    target = cache_path(media_path)
    partial = f"{target}.partial"
    try:
        with open(partial, "w", encoding="utf-8") as f:
            json.dump({"cache_version": CACHE_VERSION, "sample_strategy": strategy, "result": result}, f)
        os.replace(partial, target)
        return True
    except OSError:
        try:
            os.unlink(partial)
        except OSError:
            pass
        return False


def in_window(result: dict[str, Any], start: float, end: float | None) -> dict[str, Any]:
    """`result` with only the shots overlapping [start, end) seconds."""
    if start <= 0 and end is None:
        return result
    kept = []
    for shot in result["shots"]:
        first = rational_to_seconds(shot["source_range"]["start_time"])
        last = first + rational_to_seconds(shot["source_range"]["duration"])
        if last > start and (end is None or first < end):
            kept.append(shot)
    return {**result, "shots": kept}


class VlmWorker:
    name = "vlm"

    def __init__(
        self,
        config: OrchestratorConfig,
        client: LocalLlmClient | None = None,
        lock: GpuLock | None = None,
        breaker: CircuitBreaker | None = None,
    ) -> None:
        self.config = config
        self.model = config.vlm_model
        self.client = client or LocalLlmClient(config.local_llm_base_url)
        self.lock = lock or GpuLock.for_config(config)
        self.breaker = breaker or CircuitBreaker("The local vision model")

    def health(self) -> WorkerHealth:
        available, detail = self.client.has_model(self.model)
        if available and self.breaker.state == "open":
            available, detail = False, "paused after repeated failures"
        return {
            "worker": self.name,
            "backend": "ollama",
            "model": self.model,
            "available": available,
            "detail": detail,
        }

    def keyframe_dir(self, media_path: str) -> Path:
        digest = hashlib.sha1(media_path.encode("utf-8")).hexdigest()[:16]
        return Path(self.config.index_dir) / KEYFRAME_FOLDER / digest

    def serving_model(self) -> str:
        """The model this worker asks: the configured one, or the first of its aliases the server has."""
        return self.client.resolve_available_model(self.model)

    def cached(
        self, media_path: str, sample_strategy: str = "scene_cuts", model: str | None = None
    ) -> dict[str, Any] | None:
        """The file's whole-file analysis from its `.vlm-tags.json` when that still fits the model the
        worker asks (or `model`), else None."""
        if not os.path.isfile(media_path):
            return None
        return load_cache(media_path, model or self.serving_model(), sample_strategy)

    def analyze(
        self,
        media_path: str,
        *,
        start: float = 0.0,
        end: float | None = None,
        sample_strategy: SampleStrategy = "scene_cuts",
        custom_prompt_focus: str | None = None,
        use_cache: bool = True,
        on_progress: Progress | None = None,
    ) -> dict[str, Any]:
        """The `vibecut.vlm.v1` result for the shots in [start, end) seconds of the file."""
        if sample_strategy not in SAMPLE_STRATEGIES:
            raise VlmWorkerError(f"sample_strategy must be one of {', '.join(SAMPLE_STRATEGIES)}")
        focus = (custom_prompt_focus or "").strip() or None
        whole = start <= 0 and end is None
        model = self.serving_model()
        if use_cache and focus is None and os.path.isfile(media_path):
            cached = self.cached(media_path, sample_strategy, model)
            if cached is not None:
                return in_window(cached, start, end)
        # The scene-cut scan decodes the whole range first (a 4K file took 12 s, silent, in Phase 21's
        # live checks): it fills the first SCAN_SHARE of the progress, the shots the rest.
        scanned = SCAN_SHARE if sample_strategy == "scene_cuts" and on_progress is not None else 0.0
        on_scan: Callable[[float], None] | None = None
        if scanned and on_progress is not None:
            report = on_progress
            on_scan = lambda f: report("scanning", f * SCAN_SHARE, f"Finding the shots ({round(f * 100)}%)")
        try:
            keyframes = ffmpeg_ops.extract_keyframes_for_vlm(
                media_path,
                self.keyframe_dir(media_path),
                start=start,
                end=end,
                strategy=sample_strategy,
                on_scan=on_scan,
                strip=True,
            )
        except ffmpeg_ops.FfmpegOpError as e:
            raise VlmWorkerError(str(e)) from None
        if not keyframes:
            raise VlmWorkerError(f"No shots found in {os.path.basename(media_path)}")
        shots = []
        for index, keyframe in enumerate(keyframes):
            if on_progress is not None:
                on_progress(
                    "vision",
                    scanned + (1 - scanned) * index / len(keyframes),
                    f"Looking at shot {index + 1} of {len(keyframes)}",
                )
            analysis = self._analyze_frame(
                keyframe["image_path"], focus, "strip_timestamps_sec" in keyframe, model
            )
            shots.append(
                {
                    "shot_id": keyframe["shot_id"],
                    "source_range": keyframe["source_range"],
                    "keyframe_timestamp_sec": keyframe["keyframe_timestamp_sec"],
                    **analysis,
                }
            )
        size, mtime = _fingerprint(media_path)
        result = {
            "schema_version": VLM_VERSION,
            "media_path": media_path,
            "video_size": size,
            "video_mtime": mtime,
            "media_fps": keyframes[0]["source_range"]["start_time"]["rate"],
            "vlm_model_id": model,
            "shots": shots,
        }
        validate(result, VLM_KEYFRAME_ID)
        if whole and focus is None:
            write_cache(media_path, sample_strategy, result)
        if on_progress is not None:
            on_progress("vision", 1.0, f"Looked at {len(shots)} shots")
        return result

    def _analyze_frame(self, image: str, focus: str | None, strip: bool, model: str) -> dict[str, Any]:
        prompt = prompt_for(strip)
        if focus:
            prompt += f"\n\nAlso answer this, starting the description with the answer: {focus}"
        problems: list[str] = []
        for _ in range(ATTEMPTS):
            asked = prompt
            if problems:
                asked += "\n\nYour last answer didn't fit the format: " + "; ".join(problems[:5])
            try:
                with self.breaker.guard(), self.lock:
                    answer = self.client.chat_json(
                        model, asked, ANALYSIS_SCHEMA, images=[image], keep_alive=KEEP_ALIVE, think=False
                    )
            except LocalLlmError as e:
                raise VlmWorkerError(str(e)) from None
            answer = {k: v for k, v in answer.items() if k in ANALYSIS_SCHEMA["properties"]}
            score = answer.get("editorial_usability_score")
            if isinstance(score, (int, float)) and not isinstance(score, bool):
                answer["editorial_usability_score"] = min(100.0, max(0.0, float(score)))
            problems = errors_against(answer, ANALYSIS_SCHEMA)
            if not problems:
                return answer
        raise VlmWorkerError(
            f"{model}'s description of a shot never fit the format: {'; '.join(problems[:3])}"
        )
