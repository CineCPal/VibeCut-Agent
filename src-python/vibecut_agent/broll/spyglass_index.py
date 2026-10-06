"""
spyglass_index.py
Searches the shot index that Spyglass (apps/spyglass in the Rough Cut Studio Suite) keeps of your archive,
so B-roll can be found by what is in it: shots, captions, tags and transcripts that Spyglass already made.

READ ONLY. The index belongs to Spyglass; it is opened with SQLite's `mode=ro` and `query_only`, and
nothing here ever writes to it. Nothing is copied out of it beyond the few fields a result carries.

The ranking is a port of `search_shots` in Spyglass's `crates/spyglass-core/src/search.rs`, with the same
weights and floors, so the same words rank the same shots as they do in Spyglass:
  score = 0.45 * visual + 0.20 * caption + 0.20 * tag * rarity + 0.15 * transcript hit
Vectors are little-endian float32s. Since the suite's migration 013 each row of `embeddings` records the
model that produced it (`model`): SigLIP 2 (`ViT-B-16-SigLIP2-256/webli`, 768-d) for shots Spyglass has
indexed or re-indexed since its 2026-10-01 update, CLIP (`ViT-B-32-quickgelu/openai`, 512-d) for older ones,
and an index without the column holds only CLIP vectors. A sentence is only ever compared with vectors from
the model that embedded it. SigLIP 2 visual similarities are mapped onto CLIP's scale first
(`visual_similarity_on_reference_scale`, as Spyglass does), so the one visual floor means the same thing.
Statistics that depend on the whole archive (tag rarity, the caption threshold) are computed over the whole
index, as Spyglass does, and the results are narrowed to one folder afterwards.

One deliberate difference from Spyglass: Spyglass embeds a query with SigLIP 2 only, so shots it has not
re-indexed yet are found by their tags and transcripts alone. Here the query is embedded with every model
the searched clips carry (see `embedding_models`), so those shots keep their visual and caption signal.
For a fully re-indexed archive the results are Spyglass's own; caption thresholds are worked out per model,
because the two models' caption similarities are not on one scale.

The models are passed in (`query_vectors`), so everything here is testable without torch.
"""

from __future__ import annotations

import math
import os
import sqlite3
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from typing import Any
from urllib.parse import quote

import numpy as np

ENV_INDEX = "VIBECUT_SPYGLASS_INDEX"
APP_ID = "edu.blair.spyglass"
INDEX_FILENAME = "spyglass_index.sqlite"

# Weights and floors: the same first-cut heuristics Spyglass uses (see search.rs for why).
WEIGHT_VISUAL = 0.45
WEIGHT_CAPTION = 0.20
WEIGHT_TAG = 0.20
WEIGHT_KEYWORD = 0.15
MIN_VISUAL_SIMILARITY_TO_SURFACE = 0.24

# The model ids Spyglass writes (search.rs LEGACY_EMBEDDING_MODEL / CURRENT_EMBEDDING_MODEL). The legacy id is
# also the column default every row written before migration 013 carries.
LEGACY_EMBEDDING_MODEL = "ViT-B-32-quickgelu/openai"
CURRENT_EMBEDDING_MODEL = "ViT-B-16-SigLIP2-256/webli"
CAPTION_RELATIVE_FLOOR_Z = 1.0
MIN_TOKEN_LENGTH = 3
CHUNK_ROWS = 2048  # embeddings are read in chunks so a big archive never sits in memory at once

REQUIRED_TABLES = {
    "clips": {"id", "file_path"},
    "shots": {"id", "clip_id", "start_tc", "end_tc"},
    "embeddings": {"shot_id", "kind", "vector"},
    "tags": {"shot_id", "label"},
}


class SpyglassError(ValueError):
    """The index is missing or is not a Spyglass index."""


# ------------------------------------------------------------------------------------------- the file


def default_index_path() -> str | None:
    """Where Spyglass keeps its index, if it is there: `$VIBECUT_SPYGLASS_INDEX`, else Spyglass's own app
    data folder on macOS. None when no such file exists."""
    candidates = []
    override = os.environ.get(ENV_INDEX)
    if override:
        candidates.append(override)
    candidates.append(
        os.path.join(
            os.path.expanduser("~"),
            "Library",
            "Application Support",
            APP_ID,
            INDEX_FILENAME,
        )
    )
    return next((path for path in candidates if os.path.isfile(path)), None)


def open_index(path: str) -> sqlite3.Connection:
    """Opens the index read-only and checks that it has the tables and columns this needs."""
    if not os.path.isfile(path):
        raise SpyglassError(f"The Spyglass index was not found: {path}")
    try:
        conn = sqlite3.connect(f"file:{quote(path)}?mode=ro", uri=True, timeout=5.0)
        conn.execute("PRAGMA query_only = ON")
        missing = []
        for table, columns in REQUIRED_TABLES.items():
            found = {row[1] for row in conn.execute(f"PRAGMA table_info({table})")}
            if not columns <= found:
                missing.append(table)
    except sqlite3.DatabaseError as exc:
        raise SpyglassError(f"That is not a readable Spyglass index: {exc}") from exc
    if missing:
        conn.close()
        raise SpyglassError(f"That does not look like a Spyglass index (unexpected: {', '.join(missing)})")
    return conn


def _columns(conn: sqlite3.Connection, table: str) -> set[str]:
    return {row[1] for row in conn.execute(f"PRAGMA table_info({table})")}


# ------------------------------------------------------------------------------------ which clips


@dataclass
class FolderCoverage:
    """How a folder's video files relate to the index."""

    #: actual file path -> Spyglass clip id
    indexed: dict[str, int] = field(default_factory=dict)
    #: {path, reason} for each file Spyglass cannot answer for
    unindexed: list[dict[str, str]] = field(default_factory=list)
    #: files found by name and size because the index has them under another path (moved or renamed folders)
    moved: list[str] = field(default_factory=list)


def match_files(conn: sqlite3.Connection, files: Sequence[str]) -> FolderCoverage:
    """Finds each file in the index. A file counts as indexed when the index has it at the same path (after
    following symlinks and Spyglass's own path aliases), or, if it moved, when exactly one indexed clip has
    the same name and size. A file whose size no longer matches what was indexed is *stale*: its shots point
    into a different version of the file, so it is reported as not indexed rather than trusted."""
    aliases: dict[str, str] = {}
    if "alias_links" in {row[0] for row in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")}:
        aliases = {
            apparent: real
            for apparent, real in conn.execute("SELECT apparent_path, real_path FROM alias_links")
        }

    has_size = "size_bytes" in _columns(conn, "clips")
    by_name: dict[str, list[tuple[int, str, int | None]]] = {}
    query = (
        "SELECT id, file_path, size_bytes FROM clips" if has_size else "SELECT id, file_path, NULL FROM clips"
    )
    for clip_id, path, size in conn.execute(query):
        by_name.setdefault(os.path.basename(path).casefold(), []).append((clip_id, path, size))

    def same_place(a: str, b: str) -> bool:
        if a == b or aliases.get(a) == b or aliases.get(b) == a:
            return True
        return os.path.realpath(aliases.get(a, a)) == os.path.realpath(aliases.get(b, b))

    coverage = FolderCoverage()
    for path in files:
        try:
            size = os.stat(path).st_size
        except OSError:
            coverage.unindexed.append({"path": path, "reason": "The file could not be read"})
            continue
        candidates = by_name.get(os.path.basename(path).casefold(), [])
        at_path = [c for c in candidates if same_place(path, c[1])]
        if at_path:
            clip_id, _, indexed_size = at_path[0]
            if indexed_size is not None and indexed_size != size:
                coverage.unindexed.append({"path": path, "reason": "Changed since Spyglass indexed it"})
            else:
                coverage.indexed[path] = clip_id
            continue
        same_size = [c for c in candidates if c[2] == size]
        if len(same_size) == 1:
            coverage.indexed[path] = same_size[0][0]
            coverage.moved.append(path)
        else:
            coverage.unindexed.append({"path": path, "reason": "Not in the Spyglass index"})
    return coverage


MAX_CLIP_IDS = 50_000


def clips_by_id(conn: sqlite3.Connection, clip_ids: Sequence[int]) -> dict[int, str]:
    """clip id -> the path Spyglass indexed it at, for the given ids (unknown ids are left out). Used when the
    caller already chose clips from Spyglass's own folder tree, so no folder on disk is walked or matched."""
    out: dict[int, str] = {}
    ids = list(dict.fromkeys(clip_ids))
    for start in range(0, len(ids), 500):
        chunk = ids[start : start + 500]
        marks = ",".join("?" * len(chunk))
        out.update(conn.execute(f"SELECT id, file_path FROM clips WHERE id IN ({marks})", chunk).fetchall())
    return out


def file_status(path: str, indexed_size: int | None) -> str:
    """ "ok", "offline" (the file is not there, e.g. its drive is not attached) or "changed" (its size is not
    what Spyglass indexed, so a shot's times may point into a different version of the file)."""
    try:
        size = os.stat(path).st_size
    except OSError:
        return "offline"
    if indexed_size is not None and indexed_size >= 0 and size != indexed_size:
        return "changed"
    return "ok"


def list_shots_for_clips(conn: sqlite3.Connection, clip_paths: dict[int, str]) -> list[dict[str, Any]]:
    """Every indexed shot of `clip_paths` (clip id -> actual file path), with whatever caption/tags/
    quality score Spyglass already has for it — a plain read, no CLIP text embedding involved (unlike
    `search`, which ranks shots against a query vector). Used to build a text-only B-roll catalog for
    the Story Editor's Gemini prompt (see rough-cut-studio's gemini_client.generate_story_script):
    the model reasons over captions/tags/quality, never raw video. Order is arbitrary (by shot id);
    the caller ranks or trims as it sees fit."""
    if not clip_paths:
        return []
    shot_columns = _columns(conn, "shots")
    caption_sql = "s.caption" if "caption" in shot_columns else "NULL"
    quality_sql = "s.technical_quality_score" if "technical_quality_score" in shot_columns else "NULL"
    out: list[dict[str, Any]] = []
    clip_ids = list(clip_paths)
    for start in range(0, len(clip_ids), 500):
        chunk = clip_ids[start : start + 500]
        marks = ",".join("?" * len(chunk))
        rows = conn.execute(
            f"SELECT s.id, s.clip_id, s.start_tc, s.end_tc, {caption_sql}, {quality_sql} "
            f"FROM shots s WHERE s.clip_id IN ({marks})",
            chunk,
        ).fetchall()
        for shot_id, clip_id, start_tc, end_tc, caption_text, quality in rows:
            if clip_id not in clip_paths or end_tc <= start_tc:
                continue
            path = clip_paths[clip_id]
            tags = [
                label
                for (label,) in conn.execute(
                    "SELECT label FROM tags WHERE shot_id = ? ORDER BY label",
                    (shot_id,),
                )
            ]
            out.append(
                {
                    "path": path,
                    "filename": os.path.basename(path),
                    "start": round(float(start_tc), 3),
                    "end": round(float(end_tc), 3),
                    "caption": caption_text or None,
                    "tags": tags,
                    "technical": None if quality is None else round(float(quality), 1),
                }
            )
    return out


# ---------------------------------------------------------------------------------- which models


def has_model_column(conn: sqlite3.Connection) -> bool:
    return "model" in _columns(conn, "embeddings")


def embedding_models(conn: sqlite3.Connection, clip_ids: Sequence[int]) -> dict[str, int]:
    """model id -> how many of the given clips' shots carry vectors from it, current model first. An index
    without the `model` column (before the suite's migration 013) holds legacy CLIP vectors only."""
    ids = list(dict.fromkeys(clip_ids))
    if not ids:
        return {}
    with_column = has_model_column(conn)
    model_sql = "e.model" if with_column else "?"
    counts: dict[str, int] = {}
    for start in range(0, len(ids), 500):
        chunk = ids[start : start + 500]
        marks = ",".join("?" * len(chunk))
        params = ([] if with_column else [LEGACY_EMBEDDING_MODEL]) + chunk
        for model, count in conn.execute(
            f"SELECT {model_sql}, COUNT(DISTINCT e.shot_id) FROM embeddings e "
            f"JOIN shots s ON s.id = e.shot_id WHERE s.clip_id IN ({marks}) GROUP BY 1",
            params,
        ):
            counts[model] = counts.get(model, 0) + int(count)
    return dict(sorted(counts.items(), key=lambda item: _model_priority(item[0])))


def _model_priority(model: str) -> tuple[int, str]:
    """Current model first, then legacy CLIP, then anything else by name."""
    order = {CURRENT_EMBEDDING_MODEL: 0, LEGACY_EMBEDDING_MODEL: 1}
    return (order.get(model, 2), model)


def visual_similarity_on_reference_scale(model: str, similarity: float) -> float:
    """Spyglass's mapping of a model's visual cosine onto CLIP ViT-B/32's scale, so the one visual floor
    and weight mean the same thing for every model. SigLIP 2's line was fitted by the suite on 400 shots;
    every other model passes through unchanged (search.rs visual_similarity_on_reference_scale)."""
    if model == CURRENT_EMBEDDING_MODEL:
        return 0.7857 * similarity + 0.1532
    return similarity


# ---------------------------------------------------------------------------------------- ranking


@dataclass
class _Candidate:
    visual: float | None = None
    caption: float | None = None
    tag_hit: bool = False
    tag_rarity: float = 0.0
    transcript_hit: bool = False
    #: the embedding model the visual/caption similarities came from (None: tag/transcript only)
    model: str | None = None
    #: that model's caption threshold for this query
    caption_threshold: float = math.inf


def decode_vector(blob: bytes) -> np.ndarray:
    return np.frombuffer(blob, dtype="<f4", count=len(blob) // 4)


def normalized_tag_rarity(tag_shot_count: int, total_shots: int) -> float:
    """How much information a tag carries: ~0 for a tag on every shot, near 1 for a rare one."""
    if total_shots <= 1 or tag_shot_count <= 0:
        return 1.0
    count = min(tag_shot_count, total_shots)
    if count >= total_shots:
        return 0.0
    return min(1.0, max(0.0, math.log(total_shots / count) / math.log(total_shots)))


def caption_relevance_threshold(scores: Sequence[float]) -> float:
    """A caption must sit this far above the query's own mean caption similarity to count."""
    if len(scores) < 2:
        return math.inf
    mean = sum(scores) / len(scores)
    stdev = math.sqrt(sum((s - mean) ** 2 for s in scores) / len(scores))
    if stdev < 1e-6:
        return math.inf
    return mean + CAPTION_RELATIVE_FLOOR_Z * stdev


def hybrid_score(c: _Candidate, caption_threshold: float | None = None) -> float:
    if caption_threshold is None:
        caption_threshold = c.caption_threshold
    visual = (
        c.visual * WEIGHT_VISUAL
        if c.visual is not None and c.visual >= MIN_VISUAL_SIMILARITY_TO_SURFACE
        else 0.0
    )
    caption = c.caption * WEIGHT_CAPTION if c.caption is not None and c.caption >= caption_threshold else 0.0
    score = max(visual, 0.0) + max(caption, 0.0)
    if c.tag_hit:
        score += c.tag_rarity * WEIGHT_TAG
    if c.transcript_hit:
        score += WEIGHT_KEYWORD
    return score


def has_meaningful_signal(c: _Candidate, caption_threshold: float | None = None) -> bool:
    if caption_threshold is None:
        caption_threshold = c.caption_threshold
    return (
        c.tag_hit
        or c.transcript_hit
        or (c.visual is not None and c.visual >= MIN_VISUAL_SIMILARITY_TO_SURFACE)
        or (c.caption is not None and c.caption >= caption_threshold)
    )


def query_tokens(text: str) -> list[str]:
    return [t for t in text.lower().split() if len(t) >= MIN_TOKEN_LENGTH]


def tag_matches_token(token: str, label: str) -> bool:
    """Whole-word match with trivial plural handling, never a substring ("cat" must not match "vacation")."""

    def singular(word: str) -> str:
        return word.removesuffix("s")

    return token == label or singular(token) == singular(label)


def _unit(matrix: np.ndarray) -> np.ndarray:
    norms = np.linalg.norm(matrix, axis=-1, keepdims=True)
    norms[norms == 0] = 1.0
    return matrix / norms


def _embedding_similarities(
    conn: sqlite3.Connection,
    queries: np.ndarray,
    hub: dict[int, float],
    model: str,
    filter_by_model: bool,
) -> tuple[list[dict[int, float]], list[dict[int, float]]]:
    """Per query: the best visual similarity (on the reference scale) and the best hub-corrected caption
    similarity of each shot, over the vectors `model` produced. Each shot's hub score was computed by the
    model that captioned it, so it matches that shot's caption vector."""
    dim = queries.shape[1]
    visual: list[dict[int, float]] = [{} for _ in range(len(queries))]
    caption: list[dict[int, float]] = [{} for _ in range(len(queries))]
    unit_queries = _unit(queries.astype(np.float32))
    if filter_by_model:
        cursor = conn.execute("SELECT shot_id, kind, vector FROM embeddings WHERE model = ?", (model,))
    else:
        cursor = conn.execute("SELECT shot_id, kind, vector FROM embeddings")
    while True:
        rows = cursor.fetchmany(CHUNK_ROWS)
        if not rows:
            break
        usable = [
            r
            for r in rows
            if r[1] in ("visual", "caption")
            and isinstance(r[2], (bytes, bytearray))
            and len(r[2]) == dim * 4  # a guard: a vector of another size is from another model
        ]
        if not usable:
            continue
        sims = _unit(np.stack([decode_vector(r[2]) for r in usable])) @ unit_queries.T  # (rows, queries)
        for row, sim in zip(usable, sims):
            shot_id, kind = row[0], row[1]
            for q, value in enumerate(sim.tolist()):
                if kind == "visual":
                    value = visual_similarity_on_reference_scale(model, value)
                    best = visual[q].get(shot_id)
                    visual[q][shot_id] = value if best is None else max(best, value)
                else:
                    adjusted = value - hub.get(shot_id, 0.0)
                    best = caption[q].get(shot_id)
                    caption[q][shot_id] = adjusted if best is None else max(best, adjusted)
    return visual, caption


def search(
    conn: sqlite3.Connection,
    queries: Sequence[str],
    query_vectors: Mapping[str, np.ndarray],
    clip_paths: dict[int, str],
    top_k: int,
) -> list[list[dict[str, Any]]]:
    """For each query text, the best shots that belong to `clip_paths` (clip id -> actual file path), best first.

    `query_vectors` maps an embedding model id to that model's text embeddings, one per query in the same
    order. Each model's vectors are only compared with the shot vectors it produced. A shot with vectors from
    more than one model is judged by the highest-priority one (current model first). Empty: tags and
    transcripts only."""
    per_model: dict[str, np.ndarray] = {}
    for model, raw in query_vectors.items():
        vectors = np.asarray(raw, dtype=np.float32)
        if vectors.ndim != 2 or len(vectors) != len(queries):
            raise SpyglassError("There must be one query vector per query")
        per_model[model] = vectors

    shot_columns = _columns(conn, "shots")
    hub: dict[int, float] = {}
    if "caption_hub_score" in shot_columns:
        hub = {
            sid: float(score)
            for sid, score in conn.execute(
                "SELECT id, caption_hub_score FROM shots WHERE caption_hub_score IS NOT NULL"
            )
        }

    filter_by_model = has_model_column(conn)
    models = sorted(per_model, key=_model_priority)
    similarities = {
        model: _embedding_similarities(conn, per_model[model], hub, model, filter_by_model)
        for model in models
    }

    # The archive-wide statistics are done; from here on only the folder's own shots matter.
    in_folder: set[int] = set()
    clip_ids = list(clip_paths)
    for start in range(0, len(clip_ids), 500):
        chunk = clip_ids[start : start + 500]
        marks = ",".join("?" * len(chunk))
        in_folder.update(
            sid for (sid,) in conn.execute(f"SELECT id FROM shots WHERE clip_id IN ({marks})", chunk)
        )

    total_shots = conn.execute("SELECT COUNT(*) FROM shots").fetchone()[0]
    tag_counts = {
        label: count
        for label, count in conn.execute(
            "SELECT LOWER(label), COUNT(DISTINCT shot_id) FROM tags GROUP BY LOWER(label)"
        )
    }
    tag_rows = conn.execute("SELECT shot_id, label FROM tags").fetchall()
    has_fts = (
        conn.execute("SELECT 1 FROM sqlite_master WHERE name = 'transcript_segments_fts'").fetchone()
        is not None
    )

    results: list[list[dict[str, Any]]] = []
    for q, text in enumerate(queries):
        candidates: dict[int, _Candidate] = {}
        for model in models:
            visual, caption = similarities[model]
            # Archive-wide, per model: the two models' caption similarities are not on one scale.
            threshold = caption_relevance_threshold(list(caption[q].values()))
            for shot_id in visual[q].keys() | caption[q].keys():
                entry = candidates.setdefault(shot_id, _Candidate())
                if entry.model is not None:
                    continue  # already judged by a higher-priority model
                entry.model = model
                entry.visual = visual[q].get(shot_id)
                entry.caption = caption[q].get(shot_id)
                entry.caption_threshold = threshold

        tokens = query_tokens(text)
        if tokens:
            for shot_id, label in tag_rows:
                lowered = label.lower()
                if any(tag_matches_token(token, lowered) for token in tokens):
                    entry = candidates.setdefault(shot_id, _Candidate())
                    entry.tag_hit = True
                    entry.tag_rarity = max(
                        entry.tag_rarity,
                        normalized_tag_rarity(tag_counts.get(lowered, 1), total_shots),
                    )

        if has_fts:
            try:
                hits = conn.execute(
                    "SELECT ts.clip_id, ts.start_tc, ts.end_tc FROM transcript_segments_fts f "
                    "JOIN transcript_segments ts ON ts.id = f.rowid WHERE f.text MATCH ?",
                    (text,),
                ).fetchall()
            except sqlite3.DatabaseError:
                hits = []  # a query FTS5 cannot parse is just no keyword signal, as in Spyglass
            for clip_id, seg_start, seg_end in hits:
                if clip_id not in clip_paths:
                    continue
                for (shot_id,) in conn.execute(
                    "SELECT id FROM shots WHERE clip_id = ? AND start_tc < ? AND end_tc > ?",
                    (clip_id, seg_start, seg_end),
                ):
                    candidates.setdefault(shot_id, _Candidate()).transcript_hit = True

        scored = {
            sid: hybrid_score(c)
            for sid, c in candidates.items()
            if sid in in_folder and has_meaningful_signal(c)
        }
        results.append(_describe(conn, scored, candidates, clip_paths, top_k, shot_columns))
    return results


def _describe(
    conn: sqlite3.Connection,
    scored: dict[int, float],
    candidates: dict[int, _Candidate],
    clip_paths: dict[int, str],
    top_k: int,
    shot_columns: set[str],
) -> list[dict[str, Any]]:
    """Narrows scored shots to the folder's clips, keeps the best `top_k` and fills in what a result shows."""
    if not scored:
        return []
    caption_sql = "s.caption" if "caption" in shot_columns else "NULL"
    quality_sql = "s.technical_quality_score" if "technical_quality_score" in shot_columns else "NULL"
    energy_sql = "s.energy_score" if "energy_score" in shot_columns else "NULL"
    keyframe_sql = "s.keyframe_path" if "keyframe_path" in shot_columns else "NULL"
    clip_columns = _columns(conn, "clips")
    size_sql = "c.size_bytes" if "size_bytes" in clip_columns else "NULL"
    recorded_sql = "c.recorded_at" if "recorded_at" in clip_columns else "NULL"
    statuses: dict[int, str] = {}
    ranked: list[tuple[int, float]] = []
    for shot_id in sorted(scored, key=lambda sid: (-scored[sid], sid)):
        ranked.append((shot_id, scored[shot_id]))
    out: list[dict[str, Any]] = []
    for shot_id, score in ranked:
        row = conn.execute(
            f"SELECT s.clip_id, s.start_tc, s.end_tc, {caption_sql}, {quality_sql}, {energy_sql}, "
            f"{keyframe_sql}, {size_sql}, {recorded_sql} "
            "FROM shots s JOIN clips c ON c.id = s.clip_id WHERE s.id = ?",
            (shot_id,),
        ).fetchone()
        if row is None or row[0] not in clip_paths or row[2] <= row[1]:
            continue
        (
            clip_id,
            start,
            end,
            caption_text,
            quality,
            energy,
            keyframe,
            size,
            recorded_at,
        ) = row
        path = clip_paths[clip_id]
        if clip_id not in statuses:
            statuses[clip_id] = file_status(path, size)
        tags = [
            label
            for (label,) in conn.execute(
                "SELECT label FROM tags WHERE shot_id = ? ORDER BY label", (shot_id,)
            )
        ]
        candidate = candidates[shot_id]
        out.append(
            {
                "path": path,
                "filename": os.path.basename(path),
                "start": round(float(start), 3),
                "end": round(float(end), 3),
                "score": round(score, 4),
                "visual": None if candidate.visual is None else round(candidate.visual, 4),
                "caption": caption_text or None,
                "tags": tags,
                "technical": None if quality is None else round(float(quality), 1),
                "tagMatch": candidate.tag_hit,
                "transcriptMatch": candidate.transcript_hit,
                "shotId": shot_id,
                "keyframe": keyframe or None,
                "energy": None if energy is None else round(float(energy), 3),
                "recordedAt": recorded_at or None,
                "status": statuses[clip_id],
                "model": candidate.model,
            }
        )
        if len(out) >= top_k:
            break
    return out
