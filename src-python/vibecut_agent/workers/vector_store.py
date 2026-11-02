"""The local semantic index (ORCHESTRATOR_SPEC.md §3.4 C, `semantic_asset_search`; PLAN.md, "Phase 21").

`<index_dir>/vibecut_vectors.db` is one SQLite database holding a document per transcript segment
(whisper_worker's `vibecut.whisper.v2`) and per analysed shot (vlm_worker's `vibecut.vlm.v1`), each with its
exact source range. Every document is indexed twice: its embedding in a sqlite-vec `vec0` table (cosine
distance) and its words in an FTS5 table. A search runs both and fuses the two rankings by Reciprocal Rank
Fusion (k = 60), after the request's scope and filters; in `hybrid` mode a transcript hit and a shot hit
that overlap in the same file become one hit (`both`).

Embeddings come from the local model server (`VIBECUT_EMBED_MODEL`: BAAI/bge-m3 is Ollama's `bge-m3`,
nomic-ai/nomic-embed-text-v1.5 its `nomic-embed-text`, with that model's search prefixes). Indexing holds
the GPU lock; a search's one query embedding doesn't wait for it, so a chat turn isn't held up by an ingest.

sqlite-vec comes with the `orchestrator` extra. The `lancedb` backend in the spec isn't available yet: its
package isn't in any extra, so asking for it is refused rather than quietly using sqlite-vec."""

from __future__ import annotations

import hashlib
import json
import math
import os
import re
import sqlite3
import time
from collections.abc import Iterable, Sequence
from dataclasses import dataclass, field
from fractions import Fraction
from pathlib import Path
from typing import Any, Protocol

from vibecut_agent.config import OrchestratorConfig
from vibecut_agent.core.timecode_math import exact_rate, rational_time, rational_to_seconds, rational_to_smpte
from vibecut_agent.orchestrator.schemas import VECTOR_SEARCH_ID, VECTOR_VERSION, validate
from vibecut_agent.workers.base import GpuLock, LocalLlmClient, LocalLlmError, WorkerHealth

DB_NAME = "vibecut_vectors.db"
RRF_K = 60
MODALITIES = ("dialogue", "visual", "hybrid")
# The model server's name for each embedding model the spec names, and its document/query prefixes.
EMBED_MODELS: dict[str, tuple[str, str, str]] = {
    "BAAI/bge-m3": ("bge-m3", "", ""),
    "nomic-ai/nomic-embed-text-v1.5": ("nomic-embed-text", "search_document: ", "search_query: "),
}
EMBED_BATCH = 32
MAX_POOL = 400
# Seen live (Phase 21, check 12): while Whisper and Qwen were loaded, Ollama evicted the embedding model and
# a search took 13.9 s to load it again. Each embedding call asks Ollama to keep it this long
# (VIBECUT_EMBED_KEEP_ALIVE: "30m", seconds, or -1 for ever), and repeated queries skip the call.
DEFAULT_KEEP_ALIVE = "30m"
QUERY_CACHE = 64


def keep_alive_from_env() -> str | int | None:
    raw = os.environ.get("VIBECUT_EMBED_KEEP_ALIVE", DEFAULT_KEEP_ALIVE).strip()
    if not raw:
        return None
    return int(raw) if raw.lstrip("-").isdigit() else raw


class VectorStoreError(RuntimeError):
    """The index can't be opened, built or searched (sqlite-vec missing, embedding model changed, ...)."""


class Embedder(Protocol):
    def embed(self, texts: Sequence[str], *, query: bool) -> list[list[float]]: ...


class ServerEmbedder:
    """Embeddings from the local model server, with the model's search prefixes."""

    def __init__(self, client: LocalLlmClient, embed_model: str) -> None:
        self.client = client
        self.server_model, self.document_prefix, self.query_prefix = EMBED_MODELS[embed_model]
        self.keep_alive = keep_alive_from_env()
        # The latest queries' embeddings, oldest first (a dict keeps insertion order).
        self.queries: dict[str, list[float]] = {}

    def embed(self, texts: Sequence[str], *, query: bool) -> list[list[float]]:
        if query and len(texts) == 1 and texts[0] in self.queries:
            vector = self.queries.pop(texts[0])
            self.queries[texts[0]] = vector
            return [vector]
        prefix = self.query_prefix if query else self.document_prefix
        try:
            vectors = self.client.embed(self.server_model, [prefix + text for text in texts], self.keep_alive)
        except LocalLlmError as e:
            raise VectorStoreError(str(e)) from None
        if query:
            for text, vector in zip(texts, vectors, strict=True):
                self.queries[text] = vector
            while len(self.queries) > QUERY_CACHE:
                del self.queries[next(iter(self.queries))]
        return vectors


@dataclass
class Document:
    """One indexed item: a transcript segment or an analysed shot."""

    media_path: str
    modality: str  # "transcript" | "vlm_shot"
    item_id: str
    start_value: int
    duration_value: int
    rate: float
    text: str
    speaker: str | None = None
    shot_scale: str | None = None
    camera_movement: str | None = None
    description: str | None = None
    visual_tags: list[str] = field(default_factory=list)
    technical_quality: float | None = None

    @property
    def start_seconds(self) -> float:
        return rational_to_seconds(rational_time(self.start_value, self.rate))

    @property
    def end_seconds(self) -> float:
        return rational_to_seconds(rational_time(self.start_value + self.duration_value, self.rate))


def transcript_documents(transcript: dict[str, Any]) -> list[Document]:
    """A document per segment of a `vibecut.whisper.v2` transcript, leaving out excluded speakers' lines."""
    excluded = set(transcript.get("excluded_speakers") or [])
    labels = transcript.get("speaker_labels") or {}
    documents = []
    for segment in transcript["segments"]:
        if segment["speaker"] in excluded or not segment["text"].strip():
            continue
        source = segment["source_range"]
        documents.append(
            Document(
                media_path=transcript["path"],
                modality="transcript",
                item_id=segment["segment_id"],
                start_value=source["start_time"]["value"],
                duration_value=source["duration"]["value"],
                rate=source["start_time"]["rate"],
                text=segment["text"].strip(),
                speaker=(labels.get(segment["speaker"]) or "").strip() or segment["speaker"],
            )
        )
    return documents


def shot_documents(analysis: dict[str, Any]) -> list[Document]:
    """A document per shot of a `vibecut.vlm.v1` analysis; its text is everything the VLM said of it."""
    documents = []
    for shot in analysis["shots"]:
        lighting = shot["lighting"]
        text = " ".join(
            [
                shot["description"],
                " ".join(shot["visual_tags"]),
                shot["shot_scale"],
                shot["camera_movement"].replace("_", " "),
                lighting["key_style"].replace("_", " "),
                shot.get("on_screen_text") or "",
            ]
        ).strip()
        source = shot["source_range"]
        documents.append(
            Document(
                media_path=analysis["media_path"],
                modality="vlm_shot",
                item_id=shot["shot_id"],
                start_value=source["start_time"]["value"],
                duration_value=source["duration"]["value"],
                rate=source["start_time"]["rate"],
                text=text,
                shot_scale=shot["shot_scale"],
                camera_movement=shot["camera_movement"],
                description=shot["description"],
                visual_tags=list(shot["visual_tags"]),
                technical_quality=float(shot["editorial_usability_score"]),
            )
        )
    return documents


def fts_query(text: str) -> str | None:
    """An FTS5 query matching any of the words in `text` (each quoted, so no word is read as syntax)."""
    words = re.findall(r"\w+", text.lower())
    return " OR ".join(f'"{w}"' for w in dict.fromkeys(words)) or None


def rrf(rankings: Iterable[Sequence[int]], k: int = RRF_K) -> dict[int, float]:
    """Reciprocal Rank Fusion: each id scores the sum of 1 / (k + rank) over the rankings it is in."""
    scores: dict[int, float] = {}
    for ranking in rankings:
        for rank, item in enumerate(ranking, start=1):
            scores[item] = scores.get(item, 0.0) + 1.0 / (k + rank)
    return scores


def in_scope(media_path: str, scope_paths: Sequence[str] | None) -> bool:
    if not scope_paths:
        return True
    for scope in scope_paths:
        folder = scope.rstrip("/")
        if media_path == scope or media_path.startswith(folder + "/"):
            return True
    return False


def passes(document: Document, filters: dict[str, Any]) -> bool:
    """Whether a document meets the search's filters. Visual filters (scale, movement, technical score)
    keep only shots that meet them; a speaker filter keeps only that speaker's lines."""
    if filters.get("shot_scales") and document.shot_scale not in filters["shot_scales"]:
        return False
    if filters.get("camera_motions") and document.camera_movement not in filters["camera_motions"]:
        return False
    if "min_technical_score" in filters and (
        document.technical_quality is None or document.technical_quality < filters["min_technical_score"]
    ):
        return False
    if filters.get("speaker") and (document.speaker or "").casefold() != str(filters["speaker"]).casefold():
        return False
    length = document.end_seconds - document.start_seconds
    if "min_duration_seconds" in filters and length < filters["min_duration_seconds"]:
        return False
    return not ("max_duration_seconds" in filters and length > filters["max_duration_seconds"])


class VectorStore:
    name = "vector"

    def __init__(
        self,
        config: OrchestratorConfig,
        embedder: Embedder | None = None,
        lock: GpuLock | None = None,
        db_path: str | os.PathLike[str] | None = None,
    ) -> None:
        if config.vector_backend != "sqlite-vec":
            raise VectorStoreError(
                f'The "{config.vector_backend}" vector backend isn\'t available; set VIBECUT_VECTOR_BACKEND=sqlite-vec'
            )
        if config.embed_model not in EMBED_MODELS:
            raise VectorStoreError(f"VIBECUT_EMBED_MODEL must be one of {', '.join(EMBED_MODELS)}")
        self.config = config
        self.embed_model = config.embed_model
        self.client = LocalLlmClient(config.local_llm_base_url)
        self.embedder: Embedder = embedder or ServerEmbedder(self.client, config.embed_model)
        self.lock = lock or GpuLock.for_config(config)
        self.db_path = Path(db_path) if db_path is not None else Path(config.index_dir) / DB_NAME

    def health(self) -> WorkerHealth:
        model = EMBED_MODELS[self.embed_model][0]
        try:
            import sqlite_vec  # noqa: F401
        except ImportError:
            return {
                "worker": self.name,
                "backend": "sqlite-vec",
                "model": self.embed_model,
                "available": False,
                "detail": "sqlite-vec isn't installed (the `orchestrator` extra)",
            }
        available, detail = self.client.has_model(model)
        return {
            "worker": self.name,
            "backend": "sqlite-vec",
            "model": self.embed_model,
            "available": available,
            "detail": detail,
        }

    def _connect(self) -> sqlite3.Connection:
        try:
            import sqlite_vec
        except ImportError:
            raise VectorStoreError("sqlite-vec isn't installed (the `orchestrator` extra)") from None
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        connection = sqlite3.connect(self.db_path)
        try:
            connection.enable_load_extension(True)
            sqlite_vec.load(connection)
            connection.enable_load_extension(False)
        except (AttributeError, sqlite3.Error) as e:
            connection.close()
            raise VectorStoreError(f"This Python's SQLite can't load sqlite-vec: {e}") from None
        connection.row_factory = sqlite3.Row
        connection.executescript(
            """
            CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS documents (
                id INTEGER PRIMARY KEY,
                media_path TEXT NOT NULL,
                modality TEXT NOT NULL,
                item_id TEXT NOT NULL,
                start_value INTEGER NOT NULL,
                duration_value INTEGER NOT NULL,
                rate REAL NOT NULL,
                text TEXT NOT NULL,
                speaker TEXT,
                shot_scale TEXT,
                camera_movement TEXT,
                description TEXT,
                visual_tags TEXT NOT NULL DEFAULT '[]',
                technical_quality REAL
            );
            CREATE INDEX IF NOT EXISTS documents_media ON documents (media_path, modality);
            CREATE VIRTUAL TABLE IF NOT EXISTS documents_fts USING fts5(text);
            """
        )
        return connection

    def _vector_table(self, connection: sqlite3.Connection, dimensions: int | None) -> int | None:
        """The index's embedding size, creating its vec0 table at the first indexing. An index built with
        another embedding model is refused (its vectors can't be compared)."""
        rows = dict(connection.execute("SELECT key, value FROM meta").fetchall())
        if rows:
            if rows.get("embed_model") != self.embed_model:
                raise VectorStoreError(
                    f"The index at {self.db_path} was built with {rows.get('embed_model')}; delete it to "
                    f"rebuild with {self.embed_model}"
                )
            return int(rows["dimensions"])
        if dimensions is None:
            return None
        connection.execute(
            f"CREATE VIRTUAL TABLE IF NOT EXISTS documents_vec USING vec0(embedding float[{dimensions}] distance_metric=cosine)"
        )
        connection.executemany(
            "INSERT INTO meta (key, value) VALUES (?, ?)",
            [("embed_model", self.embed_model), ("dimensions", str(dimensions))],
        )
        return dimensions

    def index(self, documents: Sequence[Document], media_path: str, modality: str) -> int:
        """Replaces the file's documents of one modality ("transcript" or "vlm_shot") with these. Returns
        how many were indexed."""
        from sqlite_vec import serialize_float32

        vectors: list[list[float]] = []
        if documents:
            with self.lock:
                for first in range(0, len(documents), EMBED_BATCH):
                    batch = documents[first : first + EMBED_BATCH]
                    vectors += self.embedder.embed([d.text for d in batch], query=False)
        connection = self._connect()
        try:
            with connection:
                old = [
                    row["id"]
                    for row in connection.execute(
                        "SELECT id FROM documents WHERE media_path = ? AND modality = ?",
                        (media_path, modality),
                    )
                ]
                dimensions = self._vector_table(connection, len(vectors[0]) if vectors else None)
                for chunk in range(0, len(old), 500):
                    ids = old[chunk : chunk + 500]
                    marks = ",".join("?" * len(ids))
                    connection.execute(f"DELETE FROM documents WHERE id IN ({marks})", ids)
                    connection.execute(f"DELETE FROM documents_fts WHERE rowid IN ({marks})", ids)
                    if dimensions is not None:
                        connection.execute(f"DELETE FROM documents_vec WHERE rowid IN ({marks})", ids)
                for document, vector in zip(documents, vectors, strict=True):
                    if len(vector) != dimensions:
                        raise VectorStoreError(
                            f"{self.embed_model} gave a {len(vector)}-number embedding, not {dimensions}"
                        )
                    cursor = connection.execute(
                        """INSERT INTO documents (media_path, modality, item_id, start_value, duration_value, rate,
                           text, speaker, shot_scale, camera_movement, description, visual_tags, technical_quality)
                           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                        (
                            document.media_path,
                            document.modality,
                            document.item_id,
                            document.start_value,
                            document.duration_value,
                            document.rate,
                            document.text,
                            document.speaker,
                            document.shot_scale,
                            document.camera_movement,
                            document.description,
                            json.dumps(document.visual_tags),
                            document.technical_quality,
                        ),
                    )
                    rowid = cursor.lastrowid
                    connection.execute(
                        "INSERT INTO documents_fts (rowid, text) VALUES (?, ?)", (rowid, document.text)
                    )
                    connection.execute(
                        "INSERT INTO documents_vec (rowid, embedding) VALUES (?, ?)",
                        (rowid, serialize_float32(vector)),
                    )
        finally:
            connection.close()
        return len(documents)

    def index_transcript(self, transcript: dict[str, Any]) -> int:
        return self.index(transcript_documents(transcript), transcript["path"], "transcript")

    def index_shots(self, analysis: dict[str, Any]) -> int:
        return self.index(shot_documents(analysis), analysis["media_path"], "vlm_shot")

    def indexed_files(self) -> dict[str, list[str]]:
        """Each indexed file, with the modalities it has."""
        connection = self._connect()
        try:
            rows = connection.execute(
                "SELECT DISTINCT media_path, modality FROM documents ORDER BY media_path"
            ).fetchall()
        finally:
            connection.close()
        files: dict[str, list[str]] = {}
        for row in rows:
            files.setdefault(row["media_path"], []).append(row["modality"])
        return files

    def search(
        self,
        query: str,
        modality: str,
        *,
        scope_paths: Sequence[str] | None = None,
        filters: dict[str, Any] | None = None,
        top_k: int = 8,
    ) -> dict[str, Any]:
        """The `vibecut.vector.v1` result: the `top_k` best hits for `query`."""
        from sqlite_vec import serialize_float32

        began = time.perf_counter()
        if modality not in MODALITIES:
            raise VectorStoreError(f"modality must be one of {', '.join(MODALITIES)}")
        if len(query.strip()) < 2:
            raise VectorStoreError("The query needs at least 2 characters")
        if not 1 <= top_k <= 25:
            raise VectorStoreError("top_k must be 1 to 25")
        filters = filters or {}
        wanted = {"dialogue": {"transcript"}, "visual": {"vlm_shot"}, "hybrid": {"transcript", "vlm_shot"}}[
            modality
        ]
        pool = min(MAX_POOL, max(50, top_k * 10))
        connection = self._connect()
        try:
            dimensions = self._vector_table(connection, None)
            if dimensions is None:
                return self._result(query, modality, [], began)
            [vector] = self.embedder.embed([query], query=True)
            if len(vector) != dimensions:
                raise VectorStoreError(
                    f"{self.embed_model} gave a {len(vector)}-number embedding, not {dimensions}"
                )
            packed = serialize_float32(vector)
            dense = [
                (row["rowid"], row["distance"])
                for row in connection.execute(
                    "SELECT rowid, distance FROM documents_vec WHERE embedding MATCH ? AND k = ? ORDER BY distance",
                    (packed, pool),
                )
            ]
            lexical: list[int] = []
            match = fts_query(query)
            if match:
                lexical = [
                    row["rowid"]
                    for row in connection.execute(
                        "SELECT rowid FROM documents_fts WHERE documents_fts MATCH ? ORDER BY rank LIMIT ?",
                        (match, pool),
                    )
                ]
            ids = list(dict.fromkeys([i for i, _ in dense] + lexical))
            documents = self._documents(connection, ids)
            cosine = {i: 1.0 - d for i, d in dense}
            missing = [i for i in ids if i not in cosine]
            if missing:
                marks = ",".join("?" * len(missing))
                for row in connection.execute(
                    f"SELECT rowid, vec_distance_cosine(embedding, ?) AS distance FROM documents_vec WHERE rowid IN ({marks})",
                    (packed, *missing),
                ):
                    cosine[row["rowid"]] = 1.0 - row["distance"]
        finally:
            connection.close()

        def keep(i: int) -> bool:
            document = documents.get(i)
            return (
                document is not None
                and document.modality in wanted
                and in_scope(document.media_path, scope_paths)
                and passes(document, filters)
            )

        scores = rrf([[i for i, _ in dense if keep(i)], [i for i in lexical if keep(i)]])
        ranked = sorted(scores, key=lambda i: (-scores[i], -cosine.get(i, -1.0)))
        groups = self._group(ranked, documents) if modality == "hybrid" else [[i] for i in ranked]
        best = 2.0 / (RRF_K + 1)
        hits: list[dict[str, Any]] = []
        for group in groups[:top_k]:
            hits.append(self._hit(len(hits) + 1, group, documents, scores, cosine, best))
        return self._result(query, modality, hits, began)

    @staticmethod
    def _documents(connection: sqlite3.Connection, ids: Sequence[int]) -> dict[int, Document]:
        found: dict[int, Document] = {}
        for chunk in range(0, len(ids), 500):
            part = ids[chunk : chunk + 500]
            marks = ",".join("?" * len(part))
            for row in connection.execute(f"SELECT * FROM documents WHERE id IN ({marks})", part):
                found[row["id"]] = Document(
                    media_path=row["media_path"],
                    modality=row["modality"],
                    item_id=row["item_id"],
                    start_value=row["start_value"],
                    duration_value=row["duration_value"],
                    rate=row["rate"],
                    text=row["text"],
                    speaker=row["speaker"],
                    shot_scale=row["shot_scale"],
                    camera_movement=row["camera_movement"],
                    description=row["description"],
                    visual_tags=json.loads(row["visual_tags"]),
                    technical_quality=row["technical_quality"],
                )
        return found

    @staticmethod
    def _group(ranked: Sequence[int], documents: dict[int, Document]) -> list[list[int]]:
        """Hybrid hits: a transcript line and a shot of the same file that overlap go together, the pair
        placed where the better of them ranked."""
        groups: list[list[int]] = []
        for i in ranked:
            document = documents[i]
            for group in groups:
                if len(group) != 1:
                    continue
                other = documents[group[0]]
                if (
                    other.media_path == document.media_path
                    and other.modality != document.modality
                    and other.start_seconds < document.end_seconds
                    and document.start_seconds < other.end_seconds
                ):
                    group.append(i)
                    break
            else:
                groups.append([i])
        return groups

    @staticmethod
    def _hit(
        rank: int,
        group: Sequence[int],
        documents: dict[int, Document],
        scores: dict[int, float],
        cosine: dict[int, float],
        best: float,
    ) -> dict[str, Any]:
        members = [documents[i] for i in group]
        transcript = next((d for d in members if d.modality == "transcript"), None)
        shot = next((d for d in members if d.modality == "vlm_shot"), None)
        # The hit's range is the union of its members' ranges, at the first member's rate (a member at
        # another rate widens it to whole frames).
        rate = members[0].rate
        frames = exact_rate(rate)
        first = min(
            d.start_value if d.rate == rate else math.floor(Fraction(d.start_seconds) * frames)
            for d in members
        )
        last = max(
            d.start_value + d.duration_value
            if d.rate == rate
            else math.ceil(Fraction(d.end_seconds) * frames)
            for d in members
        )
        source_range = {
            "OTIO_SCHEMA": "TimeRange.1",
            "start_time": rational_time(first, rate),
            "duration": rational_time(last - first, rate),
        }
        anchor = members[0]
        digest = hashlib.sha1(f"{anchor.media_path}|{anchor.modality}|{anchor.item_id}".encode()).hexdigest()[
            :10
        ]
        matched = "both" if transcript and shot else ("transcript" if transcript else "vlm_shot")
        combined = sum(scores[i] for i in group)
        return {
            "hit_id": f"hit_{digest}",
            "rank": rank,
            "media_path": anchor.media_path,
            "filename": os.path.basename(anchor.media_path),
            "source_range": source_range,
            "start_tc": rational_to_smpte(rational_time(first, rate)),
            "end_tc": rational_to_smpte(rational_time(last, rate)),
            "scores": {
                "rrf_combined": round(min(100.0, 100.0 * combined / best), 3),
                "dense_cosine": round(max(-1.0, min(1.0, max(cosine.get(i, -1.0) for i in group))), 4),
                "siglip_visual": None,
                "technical_quality": shot.technical_quality if shot else None,
            },
            "evidence": {
                "matched_modality": matched,
                "transcript_excerpt": transcript.text if transcript else None,
                "speaker": transcript.speaker if transcript else None,
                "shot_scale": shot.shot_scale if shot else None,
                "camera_movement": shot.camera_movement if shot else None,
                "vlm_description": shot.description if shot else None,
                "visual_tags": shot.visual_tags if shot else [],
            },
        }

    def _result(self, query: str, modality: str, hits: list[dict[str, Any]], began: float) -> dict[str, Any]:
        result = {
            "schema_version": VECTOR_VERSION,
            "query": query,
            "modality": modality,
            "embedding_model": self.embed_model,
            "vector_backend": "sqlite-vec",
            "latency_ms": round((time.perf_counter() - began) * 1000, 2),
            "hits": hits,
        }
        validate(result, VECTOR_SEARCH_ID)
        return result
