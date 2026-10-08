"""The B-roll analyzer's commands, ported from VibeCut's broll-analyzer/headless.py. Run as
``python -u -m vibecut_agent broll-analyze`` / ``broll-match`` / ``broll-spyglass``.

    broll-analyze     (one JSON request on stdin)

Scores every clip in a folder (sharpness, exposure, stability, optionally content-aware "energy"
and a match to the editor's brief) with the same engine as the desktop app, reusing and refreshing
the folder's `.broll_analyzer_cache.json` (and, for content-aware runs, the SigLIP 2 per-frame
embeddings in `.broll_analyzer_embeddings.npz`). Never imports tkinter or the app's settings file.
Scores are 0 to 100.

request: {
    "folder": absolute path,
    "windowSec": 4.0, "maxSegments": 1, "minGapSec": 1.0,   (the least space between two segments of
                                                             one clip)
    "enableEnergy": false, "energyWeight": 0.35,     (0 to 1; enableEnergy turns on content-aware
                                                      scoring with the local SigLIP 2 model)
    "brief": "",               (what the editor is looking for, at most 200 characters; needs
                                enableEnergy. Each clip is scored on how well it matches it)
    "relevanceWeight": 0.35,   (0 to 1, how much the brief match counts)
    "dedupe": false,           (true marks near-duplicate takes; needs enableEnergy)
    "workers": int (default: cpu count - 1, at most 3 with enableEnergy),
    "topMode": "all" | "topn" | "threshold", "topN": 10, "minScore": 0,
    "sequenceOrder": "score" | "name",
    "exportXmlPath": absolute path ending in .xml, or null,
    "catalog": false   (true skips analysis and just reads this folder's existing cache file —
                        every other option above is ignored in that mode; see _run_analyze_catalog)
}

An optional "files": [absolute paths inside the folder] limits the analysis to those clips (the ones in
an editor's bin, which can be a few of a folder's files); the other clips' cache entries stay untouched.

Events: starting, status {phase, detail}, progress {done, total, fraction, phase, detail},
result {analyzed, cached, cancelled, failed, warnings, exportPath, ranked, duplicates, catalog},
error, done {cancelled}. `ranked` lists every clip that analyzed cleanly, best first: {path,
filename, score, bestStart, bestEnd, duration, segments, energy, relevance, duplicateOf}. `energy`
and `relevance` are null when content-aware scoring or the brief was off for this run;
`duplicateOf` names the better take a clip nearly duplicates (only with dedupe; such clips stay in
`ranked` and are left out of the XML export). `duplicates` counts them. `catalog` is only
populated by a `"catalog": true` request: [{path, filename, durationSeconds, technicalScore}] for
every clip this folder's cache already has a score for (nothing is decoded to answer this).

    broll-export      (one JSON request on stdin)

Writes a Premiere selects reel (xml_export.export_xml) from segments the editor already chose, with
no decoding: each clip's frame rate, size, audio format and timecode come from the folder's cache,
so every clip must have been analyzed first.

request: {
    "folder": absolute path,
    "outputPath": absolute path ending in .xml,
    "sequenceName": "B-Roll Selects",   (at most 120 characters)
    "showEnergy": false,                 (whether the bin comments carry the energy score)
    "clips": [{"path": absolute path inside the folder, "score": 0-100, "energy": 0-100 or null,
               "segments": [{"start": s, "end": s}]}]    (in sequence order; at most 2000 clips,
                                                          20 segments each)
}

Events: starting, status, result {exportPath, clips, segments, seconds}, error, done.

    broll-match       (one JSON request on stdin)

Finds the clips in a folder that fit a sentence, with the local SigLIP 2 model (needs the `energy` extra:
torch, open_clip and transformers). The first run embeds a few frames of every clip into `.broll_semantic_index.json` in the
folder; later runs reuse it. With no queries it only builds that index.

request: {
    "folder": absolute path,
    "queries": [{"id": str or int, "text": str, "meta": anything small, echoed back}],   (at most 20)
    "topK": 5, "windowSec": 4.0, "qualityWeight": 0.3
}

An optional "files": [absolute paths inside the folder] limits the search to those clips (the ones a
Spyglass search could not cover); the other clips keep their stored embeddings untouched.

Events: starting, status, progress {done, total, fraction, phase: "indexing", detail},
result {indexed, cached, cancelled, failed, warnings, matches: [{id, text, meta, results: [{path,
filename, similarity, relative, technical, combined, start, end, duration}]}]}, error, done.
`similarity` is the raw SigLIP 2 cosine, `relative` its 0 to 100 position among the folder's clips,
`technical` the analyzer's 0 to 100 quality score (null if the clip was never analyzed) and `combined`
the rank score: (1 - qualityWeight) * relative + qualityWeight * technical.

    broll-spyglass        (one JSON request on stdin)

Searches the shots, captions, tags and transcripts that Spyglass already made of your archive, for the
clips in a folder, READ ONLY (see spyglass_index.py). Clips Spyglass has not indexed (or has indexed in a
different version) are listed, not searched. Needs the `energy` extra to embed the query text: with SigLIP 2
for shots Spyglass indexed since its 2026-10-01 update, and with the older CLIP model for shots it has not
re-indexed yet (each query is embedded with every model the searched shots carry; see spyglass_index.py).

request: {
    "folder": absolute path, OR "clipIds": [Spyglass clip ids] (up to 50,000, chosen from Spyglass's folder
        tree by the B-roll Library; nothing on disk is walked, and `unindexed` stays empty),
    "indexPath": absolute path to spyglass_index.sqlite (default: found for you),
    "queries": [{"id", "text", "meta"}], "topK": 5,
    "catalog": false   (true lists every indexed shot's metadata instead of running a query search;
                        "queries" is ignored when this is set. No CLIP text embedding is needed for
                        this mode, so it never installs the `energy` extra.)
}

Events: starting, status, result {indexPath, indexed, moved, unindexed: [{path, reason}], warnings,
matches: [{id, text, meta, results: [{path, filename, start, end, score, visual, caption, tags,
technical, tagMatch, transcriptMatch, shotId, keyframe, energy, recordedAt, status, model}]}], catalog: [{path,
filename, start, end, caption, tags, technical}], models: {embedding model id: shot count}, cancelled}, error,
done. `model` is the embedding model a result's visual/caption similarity came from (null: matched by tags or
transcript only). `score` is Spyglass's own hybrid score. `catalog` is only
populated when the request asked for it; it is the raw per-shot metadata a "catalog": true request
comes back as, with no ranking against a query. `status` is "ok", "offline" (the file is not there) or
"changed" (its size differs from what Spyglass indexed).
"""

from __future__ import annotations

import functools
import json
import os
import sqlite3
from typing import Any, TextIO

from vibecut_agent.broll import pipeline, result_cache, semantic, spyglass_index
from vibecut_agent.broll.analyzer import ClipResult, Segment, find_video_files
from vibecut_agent.broll.xml_export import export_xml
from vibecut_agent.protocol import (
    CancelFlag,
    Emitter,
    RequestError,
    read_request,
    require_absolute_paths,
)

TOOL = "broll-analyzer"
MAX_WORKERS = 32
MAX_BRIEF_CHARS = pipeline.MAX_BRIEF_CHARS


def _number(request: dict[str, Any], key: str, default: float, low: float, high: float) -> float:
    value = request.get(key, default)
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise RequestError(f"{key} must be a number")
    if not low <= value <= high:
        raise RequestError(f"{key} must be between {low} and {high}")
    return float(value)


def _brief(request: dict[str, Any]) -> str:
    raw = request.get("brief", "")
    if raw is None:
        return ""
    if not isinstance(raw, str):
        raise RequestError("brief must be text")
    return " ".join(raw.split())[:MAX_BRIEF_CHARS]


def _clip_summary(result, content_active: bool = False) -> dict[str, Any]:
    """`content_active` is whether THIS run had content-aware scoring on: result.energy_enabled
    alone only says the cached samples carry energy data (see analyzer.rescore_clip)."""
    return {
        "path": result.path,
        "filename": result.filename,
        "score": round(result.overall_score, 2),
        "bestStart": round(result.best_window_start, 3),
        "bestEnd": round(result.best_window_end, 3),
        "duration": round(result.duration, 3),
        "segments": [
            {
                "start": round(s.start, 3),
                "end": round(s.end, 3),
                "score": round(s.score, 2),
            }
            for s in result.segments
        ],
        "energy": (round(result.mean_energy_score, 1) if content_active and result.energy_enabled else None),
        "relevance": (round(result.mean_relevance_score, 1) if result.relevance_enabled else None),
        "duplicateOf": result.duplicate_of,
    }


def _run_analyze_catalog(folder: str, emitter: Emitter) -> int:
    """A `"catalog": true` request skips a full (re-)analysis and just reads whatever this folder's
    `.broll_analyzer_cache.json` already has (from a previous "Analyze B-Roll" run) — each cached
    clip's technical score and duration, filename-only (no caption, unlike Spyglass's catalog — see
    spyglass_index.list_shots_for_clips). This is the Story Editor's B-roll catalog fallback for
    clips Spyglass hasn't indexed (see rough-cut-studio's Api.assemble). Clips with no cache entry
    are left out entirely — there is nothing to report for them without decoding, which this mode
    deliberately never does, to stay a fast, read-only listing."""
    emitter.emit("status", phase="scanning", detail="Looking for video files")
    files = find_video_files(folder)
    if not files:
        emitter.error("No video files were found in that folder")
        return 1
    emitter.emit("status", phase="reading", detail="Reading the analysis cache")
    scores = semantic.technical_scores(folder, files, pipeline.DEFAULT_WINDOW_SEC)
    cache = result_cache.load_cache(folder)
    catalog: list[dict[str, Any]] = []
    for path in files:
        entry = cache.get(os.path.relpath(path, folder))
        if not entry:
            continue
        duration = entry.get("duration")
        if not isinstance(duration, (int, float)) or duration <= 0:
            continue
        catalog.append(
            {
                "path": path,
                "filename": entry.get("filename") or os.path.basename(path),
                "durationSeconds": round(float(duration), 3),
                "technicalScore": round(scores[path], 2) if path in scores else None,
            }
        )
    emitter.emit(
        "result",
        analyzed=len(catalog),
        cached=len(catalog),
        cancelled=False,
        failed=[],
        warnings=[],
        exportPath=None,
        ranked=[],
        duplicates=0,
        catalog=catalog,
    )
    return 0


def _folder(request: dict[str, Any]) -> str:
    """The request's folder: an absolute path to an existing folder."""
    folder = request.get("folder")
    require_absolute_paths([folder], "folder")
    if not isinstance(folder, str) or not os.path.isdir(folder):
        raise RequestError(f"Not a folder: {folder}")
    return folder


def run_analyze(request: dict[str, Any], emitter: Emitter, cancel: CancelFlag) -> int:
    folder = _folder(request)

    if request.get("catalog") is True:
        return _run_analyze_catalog(folder, emitter)

    window_sec = _number(request, "windowSec", pipeline.DEFAULT_WINDOW_SEC, 0.5, 120.0)
    max_segments = int(_number(request, "maxSegments", pipeline.DEFAULT_MAX_SEGMENTS, 1, 20))
    min_gap_sec = _number(request, "minGapSec", pipeline.DEFAULT_MIN_GAP_SEC, 0.0, 30.0)
    energy_weight = _number(request, "energyWeight", pipeline.DEFAULT_ENERGY_WEIGHT, 0.0, 1.0)
    relevance_weight = _number(request, "relevanceWeight", pipeline.DEFAULT_RELEVANCE_WEIGHT, 0.0, 1.0)
    enable_energy = request.get("enableEnergy") is True
    workers = int(
        _number(
            request,
            "workers",
            pipeline.default_worker_count(enable_energy),
            1,
            MAX_WORKERS,
        )
    )
    brief = _brief(request)
    dedupe = request.get("dedupe") is True

    top_mode = request.get("topMode", "all")
    if top_mode not in ("all", "topn", "threshold"):
        raise RequestError(f"Unknown topMode: {top_mode}")
    top_n = int(_number(request, "topN", 10, 1, 100000))
    min_score = _number(request, "minScore", 0.0, 0.0, 100.0)
    order = request.get("sequenceOrder", "score")
    if order not in ("score", "name"):
        raise RequestError(f"Unknown sequenceOrder: {order}")

    export_path = request.get("exportXmlPath")
    if export_path is not None:
        require_absolute_paths([export_path], "export path")
        if not export_path.lower().endswith(".xml"):
            raise RequestError("The export path must end in .xml")
    only = _validate_files(request.get("files"), folder)

    warnings: list[str] = []
    if enable_energy:
        from vibecut_agent.broll import vision_energy

        if not vision_energy.is_available():
            warnings.append(
                "Content-aware scoring is unavailable (PyTorch/transformers are not installed); clips were scored without it."
            )
            enable_energy = False
    if not enable_energy and (brief or dedupe):
        warnings.append(
            "A brief and near-duplicate marking need content-aware scoring, so they were ignored."
        )
        brief, dedupe = "", False

    emitter.emit("status", phase="scanning", detail="Looking for video files")
    files = only if only is not None else find_video_files(folder)
    if not files:
        emitter.error("No video files were found in that folder")
        return 1

    relevance_targets = None
    if brief:
        emitter.emit(
            "status",
            phase="loading",
            detail="Loading the local vision model for the brief (the first run downloads it)",
        )
        relevance_targets, brief_error = pipeline.content_scoring(brief, enable_energy)
        if brief_error:
            warnings.append(f"The brief could not be used: {brief_error}")

    outcome = pipeline.run_analysis(
        files,
        folder,
        window_sec=window_sec,
        max_segments=max_segments,
        enable_energy=enable_energy,
        energy_weight=energy_weight,
        max_workers=workers,
        cancel_event=cancel,
        relevance_targets=relevance_targets,
        relevance_weight=relevance_weight,
        dedupe=dedupe,
        min_segment_gap_sec=min_gap_sec,
        on_status=lambda message: emitter.emit("status", phase="analyzing", detail=message),
        on_progress=lambda percent, message: emitter.progress(
            percent, 100, phase="analyzing", detail=message
        ),
    )

    ok = [r for r in outcome.results if not r.error]
    failed = [
        {
            "path": r.path,
            "message": (r.error or "").splitlines()[0] if r.error else "Failed",
        }
        for r in outcome.results
        if r.error
    ]
    energy_failed = [r for r in ok if enable_energy and not r.energy_enabled and r.energy_error]
    if energy_failed:
        warnings.append(
            f"Energy scoring was unavailable for {len(energy_failed)} clip(s): {energy_failed[0].energy_error}"
        )

    exported: str | None = None
    if export_path is not None and not outcome.cancelled:
        selected = pipeline.order_for_sequence(
            pipeline.select_results(
                outcome.results,
                top_mode,
                top_n=top_n,
                min_score=min_score,
                skip_duplicates=dedupe,
            ),
            order,
        )
        if not selected:
            warnings.append("No clips met the selection, so no XML was written.")
        else:
            emitter.emit("status", phase="exporting", detail="Writing the Premiere XML")
            os.makedirs(os.path.dirname(export_path), exist_ok=True)
            export_xml(selected, export_path, show_energy=enable_energy)
            exported = export_path

    emitter.emit(
        "result",
        analyzed=len(ok),
        cached=outcome.cache_hits,
        cancelled=outcome.cancelled,
        failed=failed,
        warnings=warnings,
        exportPath=exported,
        ranked=[_clip_summary(r, content_active=enable_energy) for r in ok],
        duplicates=outcome.duplicates,
    )
    return 0


MAX_QUERIES = 20
MAX_QUERY_CHARS = 300
MAX_META_CHARS = 1000


def _validate_queries(raw: Any) -> list[dict[str, Any]]:
    if raw is None:
        return []
    if not isinstance(raw, list):
        raise RequestError("queries must be a list")
    if len(raw) > MAX_QUERIES:
        raise RequestError(f"At most {MAX_QUERIES} queries can be matched at once")
    queries = []
    for index, item in enumerate(raw):
        if not isinstance(item, dict):
            raise RequestError(f"queries[{index}] must be an object")
        text = item.get("text")
        if not isinstance(text, str) or not text.strip():
            raise RequestError(f"queries[{index}].text must be some text")
        query_id = item.get("id", index)
        if isinstance(query_id, bool) or not isinstance(query_id, (str, int)):
            raise RequestError(f"queries[{index}].id must be text or a number")
        meta = item.get("meta")
        try:
            too_big = len(json.dumps(meta)) > MAX_META_CHARS
        except (TypeError, ValueError):
            raise RequestError(f"queries[{index}].meta must be plain JSON") from None
        if too_big:
            raise RequestError(f"queries[{index}].meta is too large")
        queries.append(
            {
                "id": str(query_id),
                "text": " ".join(text.split())[:MAX_QUERY_CHARS],
                "meta": meta,
            }
        )
    return queries


def _validate_files(raw: Any, folder: str) -> list[str] | None:
    """The clips a search is limited to, or None for the whole folder."""
    if raw is None:
        return None
    if not isinstance(raw, list) or not raw:
        raise RequestError("files must be a list of clips, or left out to search the whole folder")
    require_absolute_paths(raw, "clip")
    root = os.path.realpath(folder)
    for path in raw:
        inside = os.path.commonpath([root, os.path.realpath(path)]) == root
        if not inside or not os.path.isfile(path):
            raise RequestError(f"Not a clip inside the folder: {path}")
    return sorted(set(raw))


def run_match(request: dict[str, Any], emitter: Emitter, cancel: CancelFlag) -> int:
    folder = _folder(request)
    queries = _validate_queries(request.get("queries"))
    top_k = int(_number(request, "topK", semantic.DEFAULT_TOP_K, 1, 50))
    window_sec = _number(request, "windowSec", semantic.DEFAULT_WINDOW_SEC, 0.5, 120.0)
    quality_weight = _number(request, "qualityWeight", semantic.DEFAULT_QUALITY_WEIGHT, 0.0, 1.0)

    from vibecut_agent.broll import vision_energy

    if not vision_energy.is_available():
        emitter.error(
            "Matching B-roll to text needs PyTorch, open_clip and transformers (the 'energy' extra), which are not installed."
        )
        return 1

    emitter.emit("status", phase="scanning", detail="Looking for video files")
    only = _validate_files(request.get("files"), folder)
    files = only if only is not None else find_video_files(folder)
    if not files:
        emitter.error("No video files were found in that folder")
        return 1

    index = semantic.load_index(folder)
    needs_model = bool(queries) or any(
        not semantic.entry_is_current(index.get(os.path.relpath(f, folder)), result_cache.file_fingerprint(f))
        for f in files
    )
    if needs_model:
        emitter.emit(
            "status",
            phase="loading",
            detail="Loading the SigLIP 2 vision model (the first use downloads about 1.5 GB)",
        )
        try:
            vision_energy.preload(semantic.MODEL_ID)
        except vision_energy.VisionEnergyError as exc:
            emitter.error(str(exc))
            return 1

    emitter.emit("status", phase="indexing", detail="Looking at the clips")
    outcome = semantic.build_index(
        folder,
        files,
        functools.partial(vision_energy.encode_images, model_id=semantic.MODEL_ID),
        cancel,
        on_progress=lambda done, total, name: emitter.progress(done, total, phase="indexing", detail=name),
        prune=only is None,
    )
    # A subset search ranks only the clips asked for; the rest of the folder's index is left alone.
    ranked_entries = outcome.entries
    if only is not None:
        wanted = {os.path.relpath(f, folder) for f in only}
        ranked_entries = {key: entry for key, entry in outcome.entries.items() if key in wanted}

    warnings: list[str] = []
    matches: list[dict[str, Any]] = []
    if queries and not outcome.cancelled:
        if not ranked_entries:
            warnings.append("No clip could be read, so nothing was matched.")
        else:
            emitter.emit(
                "status",
                phase="matching",
                detail=f"Matching {len(queries)} text{'s' if len(queries) != 1 else ''}",
            )
            vectors = vision_energy.encode_texts([q["text"] for q in queries], model_id=semantic.MODEL_ID)
            technical = semantic.technical_scores(folder, files, window_sec)
            for query, vector in zip(queries, vectors):
                results = semantic.rank_query(
                    vector,
                    ranked_entries,
                    folder,
                    technical,
                    top_k=top_k,
                    window_sec=window_sec,
                    quality_weight=quality_weight,
                )
                matches.append(
                    {
                        "id": query["id"],
                        "text": query["text"],
                        "meta": query["meta"],
                        "results": results,
                    }
                )

    emitter.emit(
        "result",
        indexed=outcome.indexed,
        cached=outcome.cached,
        cancelled=outcome.cancelled,
        failed=outcome.failed,
        warnings=warnings,
        matches=matches,
    )
    return 0


def _validate_clip_ids(raw: Any) -> list[int]:
    if not isinstance(raw, list) or not raw:
        raise RequestError("clipIds must be a non-empty list of Spyglass clip ids")
    if len(raw) > spyglass_index.MAX_CLIP_IDS:
        raise RequestError(f"At most {spyglass_index.MAX_CLIP_IDS} clips can be searched at once")
    if not all(isinstance(i, int) and not isinstance(i, bool) for i in raw):
        raise RequestError("clipIds must be whole numbers")
    return raw


def run_spyglass(request: dict[str, Any], emitter: Emitter, cancel: CancelFlag) -> int:
    folder: str = request.get("folder")  # type: ignore[assignment]  # checked below when clipIds is absent
    clip_ids: list[int] | None = None
    if request.get("clipIds") is not None:
        if folder is not None:
            raise RequestError("Give either a folder or clipIds, not both")
        clip_ids = _validate_clip_ids(request.get("clipIds"))
    else:
        require_absolute_paths([folder], "folder")
        if not os.path.isdir(folder):
            raise RequestError(f"Not a folder: {folder}")
    catalog_mode = request.get("catalog") is True
    queries = [] if catalog_mode else _validate_queries(request.get("queries"))
    top_k = int(_number(request, "topK", semantic.DEFAULT_TOP_K, 1, 50))
    index_path = request.get("indexPath")
    if index_path is not None:
        require_absolute_paths([index_path], "Spyglass index")
    else:
        index_path = spyglass_index.default_index_path()
    if not index_path:
        emitter.error(
            "The Spyglass index was not found. Open Spyglass once so it exists, or choose its spyglass_index.sqlite."
        )
        return 1

    emitter.emit("status", phase="opening", detail="Opening the Spyglass index (read only)")
    try:
        conn = spyglass_index.open_index(index_path)
    except spyglass_index.SpyglassError as exc:
        emitter.error(str(exc))
        return 1

    warnings: list[str] = []
    matches: list[dict[str, Any]] = []
    catalog: list[dict[str, Any]] = []
    models: dict[str, int] = {}
    try:
        if clip_ids is not None:
            # Chosen from Spyglass's own folder tree: every clip is indexed by definition, and nothing on
            # disk is walked (the drive may not even be attached; results say so in their `status`).
            coverage = spyglass_index.FolderCoverage(
                indexed={
                    path: clip_id for clip_id, path in spyglass_index.clips_by_id(conn, clip_ids).items()
                }
            )
        else:
            emitter.emit("status", phase="scanning", detail="Looking for video files")
            files = find_video_files(folder)
            if not files:
                emitter.error("No video files were found in that folder")
                return 1
            coverage = spyglass_index.match_files(conn, files)

        if catalog_mode:
            emitter.emit(
                "status",
                phase="listing",
                detail=f"Listing {len(coverage.indexed)} indexed clips",
            )
            clip_paths = {clip_id: path for path, clip_id in coverage.indexed.items()}
            catalog = spyglass_index.list_shots_for_clips(conn, clip_paths)

        if queries and not coverage.indexed:
            warnings.append(
                "None of those clips are in the Spyglass index any more, so there was nothing to search."
                if clip_ids is not None
                else "None of the clips in this folder are in the Spyglass index, so there was nothing to search there."
            )
        elif queries and not cancel.is_set():
            clip_paths = {clip_id: path for path, clip_id in coverage.indexed.items()}
            models = spyglass_index.embedding_models(conn, list(clip_paths))
            vectors = _spyglass_query_vectors([q["text"] for q in queries], models, warnings, emitter)
            if vectors is None:
                return 1
            emitter.emit(
                "status",
                phase="searching",
                detail=f"Searching {len(coverage.indexed)} indexed clips",
            )
            found = spyglass_index.search(conn, [q["text"] for q in queries], vectors, clip_paths, top_k)
            for query, results in zip(queries, found):
                matches.append(
                    {
                        "id": query["id"],
                        "text": query["text"],
                        "meta": query["meta"],
                        "results": results,
                    }
                )
    except (spyglass_index.SpyglassError, sqlite3.DatabaseError) as exc:
        emitter.error(f"The Spyglass index could not be read: {exc}")
        return 1
    finally:
        conn.close()

    emitter.emit(
        "result",
        indexPath=index_path,
        indexed=len(coverage.indexed),
        moved=len(coverage.moved),
        unindexed=coverage.unindexed,
        warnings=warnings,
        matches=matches,
        catalog=catalog,
        models=models,
        cancelled=cancel.is_set(),
    )
    return 0


_MODEL_LABELS = {
    spyglass_index.CURRENT_EMBEDDING_MODEL: "SigLIP 2",
    spyglass_index.LEGACY_EMBEDDING_MODEL: "the older CLIP model",
}


def _spyglass_query_vectors(
    texts: list[str],
    models: dict[str, int],
    warnings: list[str],
    emitter: Emitter,
) -> dict[str, Any] | None:
    """The query texts embedded with each model the searched shots carry (see spyglass_index.search),
    current model first. Shots from a model that can't be loaded are still found by tags and transcripts,
    with a warning. None (after an error event) only when the vision model is needed and none is usable."""
    from vibecut_agent.broll import vision_energy

    known = [m for m in models if m in vision_energy.KNOWN_MODELS]
    unknown = [m for m in models if m not in vision_energy.KNOWN_MODELS]
    for model in unknown:
        warnings.append(
            f"{models[model]} shot(s) were embedded with {model}, which VibeCut Agent can't load; "
            "they were matched by tags and transcripts only."
        )
    legacy = models.get(spyglass_index.LEGACY_EMBEDDING_MODEL, 0)
    if legacy and spyglass_index.CURRENT_EMBEDDING_MODEL in models:
        warnings.append(
            f"{legacy} of {sum(models.values())} shots here still use Spyglass's older CLIP embeddings. "
            "Re-index them in Spyglass for SigLIP 2 matches."
        )
    if not known:
        return {}
    if not vision_energy.is_available():
        emitter.error(
            "Searching Spyglass's index needs PyTorch, open_clip and transformers (the 'energy' extra), "
            "which are not installed."
        )
        return None

    vectors: dict[str, Any] = {}
    failures: list[str] = []
    for model in known:
        emitter.emit(
            "status",
            phase="loading",
            detail=f"Loading {_MODEL_LABELS.get(model, model)} (the first use downloads it)",
        )
        try:
            vision_energy.preload(model)
            vectors[model] = vision_energy.encode_texts(texts, model_id=model)
        except vision_energy.VisionEnergyError as exc:
            failures.append(str(exc))
            warnings.append(
                f"{_MODEL_LABELS.get(model, model)} could not be loaded ({exc}); "
                f"its {models[model]} shot(s) were matched by tags and transcripts only."
            )
    if not vectors:
        emitter.error(failures[0])
        return None
    return vectors


MAX_EXPORT_CLIPS = 2000
MAX_EXPORT_SEGMENTS = 20
MAX_SEQUENCE_NAME = 120


def _seconds(value: Any) -> float | None:
    """A number of seconds from a request, or None (booleans aren't numbers here)."""
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    return float(value)


def _export_segments(raw: Any, duration: float, name: str) -> list[Segment]:
    """A clip's segments for the export: each inside the clip, at least one frame-ish long."""
    if not isinstance(raw, list) or not raw or len(raw) > MAX_EXPORT_SEGMENTS:
        raise RequestError(f"{name}: segments must list 1 to {MAX_EXPORT_SEGMENTS} stretches")
    segments: list[Segment] = []
    for seg in raw:
        start = _seconds(seg.get("start") if isinstance(seg, dict) else None)
        end = _seconds(seg.get("end") if isinstance(seg, dict) else None)
        if start is None or end is None:
            raise RequestError(f"{name}: each segment needs a start and an end in seconds")
        # The UI rounds to milliseconds, so allow that much past the clip's end.
        if start < 0 or end - start < 0.04 or end > duration + 0.01:
            raise RequestError(
                f"{name}: the segment {start}-{end} s isn't inside the clip ({duration:.2f} s)"
            )
        segments.append(Segment(start=start, end=min(end, duration), score=0.0))
    return segments


def run_export(request: dict[str, Any], emitter: Emitter, cancel: CancelFlag) -> int:
    folder = _folder(request)
    output = request.get("outputPath")
    require_absolute_paths([output], "export path")
    if not isinstance(output, str) or not output.lower().endswith(".xml"):
        raise RequestError("The export path must end in .xml")
    if not os.path.isdir(os.path.dirname(output)):
        raise RequestError(f"Not a folder: {os.path.dirname(output)}")
    name = request.get("sequenceName", "B-Roll Selects")
    if not isinstance(name, str) or not name.strip():
        raise RequestError("sequenceName must be text")
    name = " ".join(name.split())[:MAX_SEQUENCE_NAME]
    show_energy = request.get("showEnergy") is True

    raw = request.get("clips")
    if not isinstance(raw, list) or not raw:
        raise RequestError("clips must list at least one clip")
    if len(raw) > MAX_EXPORT_CLIPS:
        raise RequestError(f"At most {MAX_EXPORT_CLIPS} clips at a time")
    paths = [c.get("path") if isinstance(c, dict) else None for c in raw]
    _validate_files(paths, folder)
    clip_paths = [p for p in paths if isinstance(p, str)]  # every one, once _validate_files has passed

    emitter.emit("status", phase="reading", detail="Reading the analysis cache")
    cache = result_cache.load_cache(folder)
    clips: list[ClipResult] = []
    for item, path in zip(raw, clip_paths, strict=True):
        entry = cache.get(os.path.relpath(path, folder))
        if not entry:
            raise RequestError(f"{os.path.basename(path)} hasn't been analyzed yet; analyze the folder first")
        clip = result_cache.result_from_entry(path, entry)
        if clip.duration <= 0:
            raise RequestError(f"{clip.filename} has no duration in the cache; analyze the folder again")
        clip.segments = _export_segments(item.get("segments"), clip.duration, clip.filename)
        clip.best_window_start, clip.best_window_end = clip.segments[0].start, clip.segments[0].end
        score = item.get("score")
        if isinstance(score, (int, float)) and not isinstance(score, bool):
            clip.overall_score = max(0.0, min(100.0, float(score)))
        energy = item.get("energy")
        if isinstance(energy, (int, float)) and not isinstance(energy, bool):
            clip.mean_energy_score = max(0.0, min(100.0, float(energy)))
        else:
            clip.energy_enabled = False
        clips.append(clip)

    emitter.emit("status", phase="exporting", detail="Writing the Premiere XML")
    export_xml(clips, output, sequence_name=name, show_energy=show_energy)
    segments = [s for c in clips for s in c.segments]
    emitter.emit(
        "result",
        exportPath=output,
        clips=len(clips),
        segments=len(segments),
        seconds=round(sum(s.end - s.start for s in segments), 3),
    )
    return 0


COMMANDS = {"analyze": run_analyze, "match": run_match, "spyglass": run_spyglass, "export": run_export}


def main(command: str, emitter: Emitter, stdin: TextIO, cancel: CancelFlag | None = None) -> int:
    """One command, as VibeCut's headless.main runs it: starting, the command, then done."""
    if cancel is None:
        cancel = CancelFlag()
        # Cooperative cancel: the analysis loop notices within about 0.2 s, finishes the clips already
        # decoding, saves the cache and reports what it has. Rust kills the process if that takes
        # more than a few seconds.
        cancel.install_sigterm_handler()
    emitter.emit("starting", tool=TOOL, command=command)
    try:
        request = read_request(stdin)
        code = COMMANDS[command](request, emitter, cancel)
    except RequestError as exc:
        emitter.error(str(exc))
        code = 2
    except Exception as exc:  # never leave the bridge without a final event
        emitter.error(f"Unexpected error: {exc}")
        code = 1
    emitter.emit("done", cancelled=cancel.is_set())
    return code
