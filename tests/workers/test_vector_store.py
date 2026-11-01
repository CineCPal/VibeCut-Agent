"""The local semantic index (workers/vector_store.py). The fusion and filters run everywhere; the database
needs sqlite-vec (the `orchestrator` extra)."""

from __future__ import annotations

import hashlib
import importlib.util
import math

import pytest

from vibecut_agent.config import OrchestratorConfig
from vibecut_agent.orchestrator.schemas import VECTOR_SEARCH_ID, validate
from vibecut_agent.workers.vector_store import (
    Document,
    VectorStore,
    VectorStoreError,
    fts_query,
    in_scope,
    passes,
    rrf,
    shot_documents,
    transcript_documents,
)

needs_sqlite_vec = pytest.mark.skipif(
    importlib.util.find_spec("sqlite_vec") is None, reason="needs sqlite-vec"
)


def rt(value, rate=25.0):
    return {"OTIO_SCHEMA": "RationalTime.1", "value": value, "rate": rate}


def tr(start, duration, rate=25.0):
    return {"OTIO_SCHEMA": "TimeRange.1", "start_time": rt(start, rate), "duration": rt(duration, rate)}


def transcript(path, lines):
    return {
        "path": path,
        "speaker_labels": {"Speaker 1": "Ana"},
        "excluded_speakers": ["Speaker 3"],
        "segments": [
            {
                "segment_id": f"seg_{i:05d}",
                "source_range": tr(start, length),
                "text": text,
                "speaker": speaker,
            }
            for i, (start, length, text, speaker) in enumerate(lines)
        ],
    }


def shots(path, entries):
    return {
        "media_path": path,
        "shots": [
            {
                "shot_id": f"shot_{i:04d}",
                "source_range": tr(start, length),
                "shot_scale": scale,
                "camera_movement": movement,
                "lighting": {"key_style": "GOLDEN_HOUR", "color_temperature": "WARM", "contrast": "LOW"},
                "description": description,
                "visual_tags": tags,
                "on_screen_text": None,
                "editorial_usability_score": score,
            }
            for i, (start, length, scale, movement, description, tags, score) in enumerate(entries)
        ],
    }


INTERVIEW = transcript(
    "/shoot/interview.mov",
    [
        (0, 100, "We started the bakery in my grandmother's kitchen", "Speaker 1"),
        (100, 75, "The ovens were always too hot", "Speaker 2"),
        (175, 50, "Off the record, this is private", "Speaker 3"),
        (225, 25, "   ", "Speaker 1"),
    ],
)
BROLL = shots(
    "/shoot/broll/kitchen.mov",
    [
        (
            0,
            125,
            "CU",
            "STATIC",
            "Hands kneading bread dough on a floured table",
            ["bread", "hands", "kitchen"],
            82,
        ),
        (125, 100, "WS", "PAN_LEFT", "A busy bakery counter with customers", ["bakery", "customers"], 64),
    ],
)
OVERLAP = shots(
    "/shoot/interview.mov",
    [(0, 100, "MCU", "STATIC", "A woman talking about her bakery", ["interview", "woman"], 90)],
)


def test_documents():
    lines = transcript_documents(INTERVIEW)
    assert [d.speaker for d in lines] == ["Ana", "Speaker 2"]
    assert lines[1].start_seconds == 4.0 and lines[1].end_seconds == 7.0
    [first, _] = shot_documents(BROLL)
    assert first.modality == "vlm_shot" and first.technical_quality == 82
    assert "kneading" in first.text and "bread hands kitchen" in first.text and "GOLDEN HOUR" in first.text


def test_rrf_and_queries():
    scores = rrf([[1, 2, 3], [3, 1]])
    assert scores[1] == pytest.approx(1 / 61 + 1 / 62)
    assert max(scores, key=scores.__getitem__) == 1
    assert fts_query('Bread "dough" OR NOT bread!') == '"bread" OR "dough" OR "or" OR "not"'
    assert fts_query("?!") is None


def test_scope_and_filters():
    assert in_scope("/shoot/broll/a.mov", ["/shoot/broll/"])
    assert in_scope("/shoot/a.mov", ["/shoot/a.mov"])
    assert not in_scope("/shoot/broll2/a.mov", ["/shoot/broll"])
    assert in_scope("/anything", None)
    shot = Document(
        "/a",
        "vlm_shot",
        "s",
        0,
        50,
        25.0,
        "x",
        shot_scale="CU",
        camera_movement="STATIC",
        technical_quality=70,
    )
    line = Document("/a", "transcript", "t", 0, 100, 25.0, "x", speaker="Ana")
    assert passes(shot, {"shot_scales": ["CU", "MCU"], "min_technical_score": 70})
    assert not passes(shot, {"camera_motions": ["PAN_LEFT"]})
    assert not passes(line, {"shot_scales": ["CU"]})
    assert passes(line, {"speaker": "ana", "min_duration_seconds": 4.0})
    assert not passes(line, {"max_duration_seconds": 3.0})


def test_backend_and_model_are_checked(monkeypatch):
    monkeypatch.setenv("VIBECUT_VECTOR_BACKEND", "lancedb")
    with pytest.raises(VectorStoreError, match="sqlite-vec"):
        VectorStore(OrchestratorConfig.from_env())
    monkeypatch.setenv("VIBECUT_VECTOR_BACKEND", "sqlite-vec")
    monkeypatch.setenv("VIBECUT_EMBED_MODEL", "openai/text-embedding-3")
    with pytest.raises(VectorStoreError, match="VIBECUT_EMBED_MODEL"):
        VectorStore(OrchestratorConfig.from_env())


class WordEmbedder:
    """A bag of words hashed into 64 numbers, normalised: texts sharing words are close."""

    def __init__(self, dimensions=64):
        self.dimensions = dimensions
        self.calls = []

    def embed(self, texts, *, query):
        self.calls.append((list(texts), query))
        vectors = []
        for text in texts:
            vector = [0.0] * self.dimensions
            for word in text.lower().replace(",", " ").split():
                vector[int(hashlib.md5(word.encode()).hexdigest(), 16) % self.dimensions] += 1.0
            norm = math.sqrt(sum(x * x for x in vector)) or 1.0
            vectors.append([x / norm for x in vector])
        return vectors


@pytest.fixture
def store(monkeypatch, tmp_path):
    monkeypatch.setenv("VIBECUT_INDEX_DIR", str(tmp_path))
    return VectorStore(OrchestratorConfig.from_env("orchestrated"), embedder=WordEmbedder())


@needs_sqlite_vec
def test_index_and_search(store):
    assert store.index_transcript(INTERVIEW) == 2
    assert store.index_shots(BROLL) == 2
    assert store.indexed_files() == {
        "/shoot/broll/kitchen.mov": ["vlm_shot"],
        "/shoot/interview.mov": ["transcript"],
    }
    result = store.search("bread dough kneading", "visual")
    validate(result, VECTOR_SEARCH_ID)
    assert result["hits"][0]["evidence"]["vlm_description"].startswith("Hands kneading")
    assert result["hits"][0]["start_tc"] == "00:00:00:00" and result["hits"][0]["end_tc"] == "00:00:05:00"
    assert result["hits"][0]["scores"]["technical_quality"] == 82
    dialogue = store.search("grandmother kitchen", "dialogue")
    assert [h["evidence"]["speaker"] for h in dialogue["hits"]] == ["Ana", "Speaker 2"]
    assert dialogue["hits"][0]["scores"]["rrf_combined"] == 100.0
    assert all(h["evidence"]["matched_modality"] == "transcript" for h in dialogue["hits"])
    # The query embedding is a query's; indexing embedded documents.
    assert store.embedder.calls[-1][1] is True and store.embedder.calls[0][1] is False


@needs_sqlite_vec
def test_hybrid_pairs_a_line_with_its_shot(store):
    store.index_transcript(INTERVIEW)
    store.index_shots(OVERLAP)
    store.index_shots(BROLL)
    result = store.search("bakery", "hybrid", top_k=3)
    validate(result, VECTOR_SEARCH_ID)
    both = [h for h in result["hits"] if h["evidence"]["matched_modality"] == "both"]
    assert len(both) == 1
    assert (
        both[0]["evidence"]["transcript_excerpt"].startswith("We started")
        and both[0]["evidence"]["shot_scale"] == "MCU"
    )


@needs_sqlite_vec
def test_filters_and_scope(store):
    store.index_transcript(INTERVIEW)
    store.index_shots(BROLL)
    wide = store.search("bakery bread", "visual", filters={"shot_scales": ["WS"]})
    assert [h["evidence"]["shot_scale"] for h in wide["hits"]] == ["WS"]
    scoped = store.search("bakery bread ovens", "hybrid", scope_paths=["/shoot/broll"])
    assert {h["media_path"] for h in scoped["hits"]} == {"/shoot/broll/kitchen.mov"}
    assert store.search("bakery", "visual", filters={"min_technical_score": 95})["hits"] == []


@needs_sqlite_vec
def test_reindexing_replaces_a_files_documents(store):
    store.index_shots(BROLL)
    store.index_shots(
        shots("/shoot/broll/kitchen.mov", [(0, 50, "INSERT", "STATIC", "A clock on the wall", ["clock"], 50)])
    )
    hits = store.search("bread clock", "visual")["hits"]
    assert [h["evidence"]["shot_scale"] for h in hits] == ["INSERT"]
    assert store.index_shots({"media_path": "/shoot/broll/kitchen.mov", "shots": []}) == 0
    assert store.search("clock", "visual")["hits"] == []


@needs_sqlite_vec
def test_an_empty_index_and_bad_searches(store):
    assert store.search("anything", "hybrid")["hits"] == []
    with pytest.raises(VectorStoreError, match="modality"):
        store.search("bread", "audio")
    with pytest.raises(VectorStoreError, match="2 characters"):
        store.search(" a ", "visual")
    with pytest.raises(VectorStoreError, match="top_k"):
        store.search("bread", "visual", top_k=30)


@needs_sqlite_vec
def test_another_embedding_model_is_refused(monkeypatch, store, tmp_path):
    store.index_shots(BROLL)
    monkeypatch.setenv("VIBECUT_EMBED_MODEL", "nomic-ai/nomic-embed-text-v1.5")
    other = VectorStore(OrchestratorConfig.from_env(), embedder=WordEmbedder())
    with pytest.raises(VectorStoreError, match="built with BAAI/bge-m3"):
        other.search("bread", "visual")
