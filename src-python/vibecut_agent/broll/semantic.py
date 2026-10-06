"""
semantic.py
Matches B-roll clips to a sentence ("ocean waves at sunset", or a line of dialogue) using SigLIP 2.

SigLIP 2 (like CLIP before it) puts video frames and text in one embedding space, so no captions or tags are needed: every clip
is turned into a few frame embeddings once (the *index*, cached next to the clips), and a sentence is
compared with them by cosine similarity. Fully local; the model is the one `vision_energy.py` already
uses. This module holds only the logic. The two functions that need the model, `encode_images` and
`encode_texts`, are passed in, so everything here can be tested with fake vectors.

The index lives in its own file (`.broll_semantic_index.json`) and never touches the analysis cache
(`.broll_analyzer_cache.json`) or its version.
"""

from __future__ import annotations

import json
import math
import os
from collections.abc import Callable, Sequence
from dataclasses import dataclass, field
from typing import Any

import cv2
import numpy as np
from PIL import Image

from vibecut_agent.broll import analyzer, result_cache

INDEX_FILENAME = ".broll_semantic_index.json"
# 3: moved from CLIP ViT-B-32-quickgelu (512-d) to SigLIP 2 (768-d), so every older index is rebuilt once.
INDEX_VERSION = 3
# The model id (vision_energy.EMBED_MODEL_ID, kept as a literal so this module never imports torch). It is
# also the model Spyglass embeds with, so the two agree on what a sentence and a picture mean.
MODEL_ID = "ViT-B-16-SigLIP2-256/webli"

FRAME_INTERVAL_SEC = 2.0  # one frame about this often ...
MAX_FRAMES_PER_CLIP = 30  # ... but never more than this many, spread over the whole clip
FRAME_MAX_DIM = 448  # frames are shrunk to this long edge before the model sees them (it uses 256)
VECTOR_DECIMALS = 4  # stored precision; normalized 768-d vectors lose nothing that matters
SAVE_EVERY = 10  # clips between index saves, so a killed run keeps most of its work

DEFAULT_WINDOW_SEC = 4.0
DEFAULT_QUALITY_WEIGHT = 0.3
DEFAULT_TOP_K = 5
TOP_FRAMES_PER_WINDOW = 2  # a window scores as the mean of its best few frames

EncodeImages = Callable[[Sequence[Image.Image]], np.ndarray]
EncodeTexts = Callable[[Sequence[str]], np.ndarray]


# ------------------------------------------------------------------------------------------ index file


def index_path(folder: str) -> str:
    return os.path.join(folder, INDEX_FILENAME)


def load_index(folder: str) -> dict[str, dict]:
    """The stored entries by path relative to the folder. Any problem means an empty index: every clip
    is then embedded again, exactly as if no index existed."""
    try:
        with open(index_path(folder), "r", encoding="utf-8") as handle:
            data = json.load(handle)
    except (OSError, ValueError):
        return {}
    if not isinstance(data, dict) or data.get("version") != INDEX_VERSION or data.get("model") != MODEL_ID:
        return {}  # written by another version or model: its vectors mean something else
    clips = data.get("clips")
    return clips if isinstance(clips, dict) else {}


def save_index(folder: str, entries: dict[str, dict]) -> bool:
    """Atomic best-effort save (temp file, then replace). Returns whether it worked."""
    path = index_path(folder)
    tmp = path + ".tmp"
    try:
        with open(tmp, "w", encoding="utf-8") as handle:
            json.dump(
                {"version": INDEX_VERSION, "model": MODEL_ID, "clips": entries},
                handle,
                separators=(",", ":"),
            )
        os.replace(tmp, path)
        return True
    except OSError:
        try:
            os.remove(tmp)
        except OSError:
            pass
        return False


def entry_is_current(entry: Any, fingerprint: tuple[int, float] | None) -> bool:
    """Whether a stored entry still describes the file: same size and (almost) the same modification time."""
    if not isinstance(entry, dict) or fingerprint is None:
        return False
    size, mtime = fingerprint
    stored = entry.get("mtime")
    if entry.get("size") != size or not isinstance(stored, (int, float)) or abs(stored - mtime) > 1e-6:
        return False
    times, vectors = entry.get("times"), entry.get("vectors")
    return (
        isinstance(times, list)
        and isinstance(vectors, list)
        and len(times) == len(vectors) > 0
        and isinstance(entry.get("duration"), (int, float))
    )


# --------------------------------------------------------------------------------------------- frames


def sample_times(duration: float) -> list[float]:
    """Where to take frames: the middle of each ~2 s slice, spread evenly if that would be too many."""
    if not math.isfinite(duration) or duration <= 0:
        return []
    count = max(1, min(MAX_FRAMES_PER_CLIP, math.ceil(duration / FRAME_INTERVAL_SEC)))
    return [round((index + 0.5) * duration / count, 3) for index in range(count)]


def _to_image(frame_bgr: np.ndarray) -> Image.Image:
    height, width = frame_bgr.shape[:2]
    scale = FRAME_MAX_DIM / max(height, width)
    if scale < 1:
        frame_bgr = cv2.resize(
            frame_bgr,
            (max(1, round(width * scale)), max(1, round(height * scale))),
            interpolation=cv2.INTER_AREA,
        )
    return Image.fromarray(cv2.cvtColor(frame_bgr, cv2.COLOR_BGR2RGB))


def read_frames(path: str) -> tuple[float, list[tuple[float, Image.Image]]]:
    """The clip's length and the frames at `sample_times`, as (time, image). Frames that fail to decode
    are skipped. Raises ValueError when the file cannot be opened or its length is unknown."""
    cap = analyzer._open_video_capture(path)
    try:
        if not cap.isOpened():
            raise ValueError("The clip could not be opened")
        fps = cap.get(cv2.CAP_PROP_FPS) or 0.0
        count = cap.get(cv2.CAP_PROP_FRAME_COUNT) or 0.0
        if fps <= 0 or count <= 0:
            raise ValueError("The clip's length could not be read")
        duration = count / fps
        frames: list[tuple[float, Image.Image]] = []
        for time in sample_times(duration):
            cap.set(cv2.CAP_PROP_POS_MSEC, time * 1000.0)
            ok, frame = cap.read()
            if ok and frame is not None:
                frames.append((time, _to_image(frame)))
        return duration, frames
    finally:
        cap.release()


def build_entry(path: str, fingerprint: tuple[int, float], encode_images: EncodeImages) -> dict:
    """Embeds a clip's frames. Raises ValueError if no frame could be read."""
    duration, frames = read_frames(path)
    if not frames:
        raise ValueError("No frames could be read from the clip")
    vectors = np.asarray(encode_images([image for _, image in frames]), dtype=np.float32)
    return {
        "size": fingerprint[0],
        "mtime": fingerprint[1],
        "duration": round(duration, 3),
        "times": [time for time, _ in frames],
        "vectors": [[round(float(x), VECTOR_DECIMALS) for x in row] for row in vectors],
    }


# ---------------------------------------------------------------------------------------------- index


@dataclass
class IndexOutcome:
    entries: dict[str, dict]
    indexed: int = 0  # clips embedded in this run
    cached: int = 0  # clips whose stored embeddings were still good
    failed: list[dict] = field(default_factory=list)
    cancelled: bool = False


def build_index(
    folder: str,
    files: Sequence[str],
    encode_images: EncodeImages,
    cancel: Any,
    on_progress: Callable[[int, int, str], None] = lambda done, total, name: None,
    reader: Callable[[str, tuple[int, float], EncodeImages], dict] = build_entry,
    prune: bool = True,
) -> IndexOutcome:
    """Makes sure every file has current embeddings, reusing the stored ones and saving as it goes.

    `cancel` needs `is_set()`; a cancelled run keeps (and saves) the clips it finished. With `prune`
    (when `files` is the whole folder) entries of clips no longer in the folder are dropped at the end;
    pass `prune=False` for a subset so the other clips keep their entries."""
    entries = load_index(folder)
    outcome = IndexOutcome(entries={})
    total = len(files)
    live: dict[str, dict] = {}
    since_save = 0
    finished = False

    try:
        for position, path in enumerate(files):
            if cancel.is_set():
                outcome.cancelled = True
                break
            key = os.path.relpath(path, folder)
            fingerprint = result_cache.file_fingerprint(path)
            if entry_is_current(entries.get(key), fingerprint):
                live[key] = entries[key]
                outcome.cached += 1
            else:
                try:
                    if fingerprint is None:
                        raise ValueError("The clip could not be read")
                    live[key] = reader(path, fingerprint, encode_images)
                    outcome.indexed += 1
                    since_save += 1
                except Exception as exc:  # one bad clip must not stop the folder
                    message = str(exc).splitlines()[0] if str(exc) else "Failed"
                    outcome.failed.append({"path": path, "message": message})
            on_progress(position + 1, total, os.path.basename(path))
            if since_save >= SAVE_EVERY:
                save_index(folder, {**entries, **live})
                since_save = 0
        else:
            finished = True
    finally:
        if finished and prune:
            # Every file was looked at, so entries of clips no longer in the folder are dropped.
            save_index(folder, live)
            outcome.entries = live
        else:
            # A cancel, an unexpected error or a subset run keeps the old entries of the files not looked at.
            merged = {**entries, **live}
            save_index(folder, merged)
            outcome.entries = merged
    return outcome


# ---------------------------------------------------------------------------------------------- match


def best_window(
    times: Sequence[float], sims: Sequence[float], duration: float, window_sec: float
) -> tuple[float, float, float]:
    """The stretch of at most `window_sec` seconds whose frames match best, as (start, end, score).

    A window scores as the mean of its best `TOP_FRAMES_PER_WINDOW` frames, so one great shot inside a
    dull stretch still counts. Candidate windows are centred on each frame and kept inside the clip."""
    window = min(window_sec, duration)
    best: tuple[float, float, float] | None = None
    best_key: tuple[float, float] | None = None
    for centre in times:
        start = min(max(0.0, centre - window / 2), max(0.0, duration - window))
        end = start + window
        inside = sorted(
            (s for t, s in zip(times, sims) if start - 1e-9 <= t <= end + 1e-9),
            reverse=True,
        )
        if not inside:
            continue
        top = inside[:TOP_FRAMES_PER_WINDOW]
        score = sum(top) / len(top)
        # Between equally good windows prefer the one whose other frames match better too (a tighter fit).
        key = (round(score, 9), sum(inside) / len(inside))
        if best_key is None or key > best_key:
            best, best_key = (start, end, score), key
    if best is None:  # cannot happen with at least one frame, but never return nothing
        return 0.0, window, float(max(sims))
    return best


def technical_scores(folder: str, files: Sequence[str], window_sec: float) -> dict[str, float]:
    """Each clip's 0 to 100 quality score from the analysis cache, for the clips that have a current entry."""
    entries = result_cache.load_cache(folder)
    scores: dict[str, float] = {}
    for path in files:
        entry = entries.get(os.path.relpath(path, folder))
        if not result_cache.is_entry_usable(entry, result_cache.file_fingerprint(path), need_energy=False):
            continue
        try:
            assert entry is not None  # is_entry_usable is False for a missing entry
            result = result_cache.result_from_entry(path, entry)
            analyzer.rescore_clip(result, window_sec=window_sec, max_segments=1, enable_energy=False)
            scores[path] = float(result.overall_score)
        except Exception:
            continue
    return scores


def relative_scores(values: Sequence[float]) -> list[float]:
    """Similarities spread over 0 to 100 across the candidates. Raw cosines (CLIP's or SigLIP 2's) are not meaningful as
    absolute numbers (they sit in a narrow band), so ranking uses where a clip falls among the others."""
    if not values:
        return []
    low, high = min(values), max(values)
    if high - low < 1e-9:
        return [100.0 if len(values) == 1 else 50.0 for _ in values]
    return [100.0 * (value - low) / (high - low) for value in values]


def rank_query(
    query_vector: np.ndarray,
    entries: dict[str, dict],
    folder: str,
    technical: dict[str, float],
    *,
    top_k: int,
    window_sec: float,
    quality_weight: float,
) -> list[dict]:
    """The best clips for one query, best first. Each result carries the raw `similarity`, the
    `relative` 0 to 100 position among the candidates, the `technical` score (or None), the blended
    `combined` rank score and the best `start`/`end` stretch."""
    query = np.asarray(query_vector, dtype=np.float32).reshape(-1)
    norm = float(np.linalg.norm(query))
    if norm > 0:
        query = query / norm

    candidates: list[dict] = []
    for key, entry in entries.items():
        vectors = np.asarray(entry["vectors"], dtype=np.float32)
        if vectors.ndim != 2 or vectors.shape[1] != query.shape[0]:
            continue
        sims = vectors @ query
        start, end, score = best_window(entry["times"], sims.tolist(), float(entry["duration"]), window_sec)
        path = os.path.join(folder, key)
        candidates.append(
            {
                "path": path,
                "filename": os.path.basename(path),
                "similarity": score,
                "start": start,
                "end": end,
                "duration": float(entry["duration"]),
            }
        )

    relative = relative_scores([c["similarity"] for c in candidates])
    results = []
    for candidate, rel in zip(candidates, relative):
        tech = technical.get(candidate["path"])
        combined = rel if tech is None else (1 - quality_weight) * rel + quality_weight * tech
        results.append(
            {
                "path": candidate["path"],
                "filename": candidate["filename"],
                "similarity": round(candidate["similarity"], 4),
                "relative": round(rel, 1),
                "technical": None if tech is None else round(tech, 1),
                "combined": round(combined, 1),
                "start": round(candidate["start"], 3),
                "end": round(candidate["end"], 3),
                "duration": round(candidate["duration"], 3),
            }
        )
    results.sort(key=lambda r: (-r["combined"], -r["similarity"], r["filename"]))
    return results[:top_k]
