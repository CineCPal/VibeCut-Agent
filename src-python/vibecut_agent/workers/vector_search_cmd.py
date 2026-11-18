"""The `vector-search` and `vlm-tags` commands (PLAN.md, "Bin analysis & visual clip selection"): the
Phase 21 semantic index and the VLM's cached shot tags, for the app's own tools. They let a direct-mode
chat search clips by content (`find_clips_by_content`) and let bin analysis and the snapshot read the shot
tags, without the orchestrated chat's tool bus.

    vector-search     (one JSON request on stdin)

request: {"query": str, "modality": "dialogue" | "visual" | "hybrid" (default "visual"),
          "scope_paths": [absolute files or folders] (optional), "filters": {...} (optional, as
          `semantic_asset_search`'s), "top_k": 1-25 (default 8)}
events:  result {the unchanged `vibecut.vector.v1` payload}, error.

The store is built as the tool bus builds it (tool_bus.default_workers), with the GPU lock from
workers/base.py; a search's one query embedding doesn't wait for that lock (see vector_store.py), so it
never queues behind an ingest.

    vlm-tags          (one JSON request on stdin)

request: {"paths": [absolute media files] (1-2000), "health": false}
events:  result {"files": [{path, model, shots: [{start, end, shot_scale, camera_movement, description,
          visual_tags, editorial_usability_score}] } | {path, shots: null}], "health": {...} (only when
          asked)}, error.

Reads each file's `<file>.vlm-tags.json` (vlm_worker's whole-file cache) and nothing else: it never asks
the model server for a tag. A cache that no longer fits its file (size or mtime changed, an older cache
version) counts as none. Any model and sampling strategy are accepted, since the caller only reads what an
earlier ingest saw. With "health": true it also reports whether the vision model and the embedding model
are on the model server, for `index_bin_visuals` to explain a missing model before starting a long ingest.
"""

from __future__ import annotations

import json
import os
from typing import Any, TextIO

from vibecut_agent.config import OrchestratorConfig
from vibecut_agent.protocol import Emitter, RequestError, read_request, require_absolute_paths

MODALITIES = ("dialogue", "visual", "hybrid")
MAX_TAG_FILES = 2000
MAX_SCOPE = 2000


def _seconds(time: Any) -> float:
    from vibecut_agent.core.timecode_math import rational_to_seconds

    return float(rational_to_seconds(time))


def parse_search(request: dict[str, Any]) -> dict[str, Any]:
    query = request.get("query")
    if not isinstance(query, str) or len(query.strip()) < 2:
        raise RequestError("query must be at least 2 characters")
    modality = request.get("modality", "visual")
    if modality not in MODALITIES:
        raise RequestError(f"modality must be one of {', '.join(MODALITIES)}")
    scope = request.get("scope_paths")
    if scope is not None:
        if not isinstance(scope, list) or len(scope) > MAX_SCOPE:
            raise RequestError(f"scope_paths must be a list of at most {MAX_SCOPE} paths")
        require_absolute_paths(scope, "scope path")
    filters = request.get("filters")
    if filters is not None and not isinstance(filters, dict):
        raise RequestError("filters must be an object")
    top_k = request.get("top_k", 8)
    if not isinstance(top_k, int) or isinstance(top_k, bool) or not 1 <= top_k <= 25:
        raise RequestError("top_k must be 1 to 25")
    return {
        "query": query.strip(),
        "modality": modality,
        "scope_paths": scope or None,
        "filters": filters,
        "top_k": top_k,
    }


def run_search(
    request: dict[str, Any], emitter: Emitter, config: OrchestratorConfig | None = None, store: Any = None
) -> int:
    from vibecut_agent.orchestrator.schemas import VECTOR_SEARCH_ID, validate

    options = parse_search(request)
    if store is None:
        from vibecut_agent.workers.base import GpuLock
        from vibecut_agent.workers.vector_store import VectorStore

        config = config or OrchestratorConfig.from_env()
        store = VectorStore(config, lock=GpuLock.for_config(config, timeout=30.0))
    result = store.search(
        options["query"],
        options["modality"],
        scope_paths=options["scope_paths"],
        filters=options["filters"],
        top_k=options["top_k"],
    )
    validate(result, VECTOR_SEARCH_ID)
    emitter.emit("result", **result)
    return 0


def read_tags(path: str) -> dict[str, Any] | None:
    """The file's cached shots, trimmed to what the app reads, or None when there's no cache that fits."""
    from vibecut_agent.workers.vlm_worker import CACHE_VERSION, cache_path

    try:
        with open(cache_path(path), encoding="utf-8") as f:
            data = json.load(f)
        result = data["result"]
        stat = os.stat(path)
    except (OSError, ValueError, KeyError, TypeError):
        return None
    if (
        not isinstance(result, dict)
        or data.get("cache_version") != CACHE_VERSION
        or result.get("video_size") != stat.st_size
        or result.get("video_mtime") != int(stat.st_mtime)
        or not isinstance(result.get("shots"), list)
    ):
        return None
    shots = []
    for shot in result["shots"]:
        try:
            start = _seconds(shot["source_range"]["start_time"])
            end = start + _seconds(shot["source_range"]["duration"])
        except (KeyError, TypeError, ValueError, ZeroDivisionError):
            continue
        shots.append(
            {
                "start": round(start, 3),
                "end": round(end, 3),
                "shot_scale": shot.get("shot_scale"),
                "camera_movement": shot.get("camera_movement"),
                "description": shot.get("description", ""),
                "visual_tags": list(shot.get("visual_tags") or []),
                "editorial_usability_score": shot.get("editorial_usability_score"),
            }
        )
    return {"model": result.get("vlm_model_id"), "shots": shots}


def health(config: OrchestratorConfig) -> dict[str, Any]:
    """Whether the vision and embedding models are on the model server (nothing is pulled or loaded)."""
    out: dict[str, Any] = {"localLlmBaseUrl": config.local_llm_base_url}
    for name in ("vlm", "vector"):
        try:
            if name == "vlm":
                from vibecut_agent.workers.vlm_worker import VlmWorker

                report = VlmWorker(config).health()
            else:
                from vibecut_agent.workers.vector_store import VectorStore

                report = VectorStore(config).health()
            out[name] = {
                "model": report.get("model"),
                "available": bool(report.get("available")),
                "detail": report.get("detail", ""),
            }
        except Exception as e:  # noqa: BLE001 - a worker that can't be built is reported, not raised
            out[name] = {"model": None, "available": False, "detail": str(e)}
    return out


def run_tags(request: dict[str, Any], emitter: Emitter, config: OrchestratorConfig | None = None) -> int:
    paths = request.get("paths")
    if not isinstance(paths, list) or len(paths) > MAX_TAG_FILES:
        raise RequestError(f"paths must be a list of at most {MAX_TAG_FILES} media files")
    require_absolute_paths(paths, "media file")
    files = []
    for path in dict.fromkeys(paths):
        tags = read_tags(path)
        files.append({"path": path, **tags} if tags is not None else {"path": path, "shots": None})
    extra: dict[str, Any] = {}
    if request.get("health") is True:
        extra["health"] = health(config or OrchestratorConfig.from_env())
    emitter.emit("result", files=files, **extra)
    return 0


def main(command: str, stdin: TextIO, emitter: Emitter) -> int:
    request = read_request(stdin)
    if command == "search":
        return run_search(request, emitter)
    if command == "tags":
        return run_tags(request, emitter)
    raise RequestError(f"Unknown command: {command}")
