"""tests/spyglass_fixture.py -- a small, synthetic database shaped like Spyglass's real index.

The schema is copied from Spyglass's own migrations (crates/spyglass-core/migrations), reduced to what the
search reads; the content is made up. Vectors have 4 dimensions so a test can say exactly what is similar
to what: axis 0 is "ocean", axis 1 is "crowd", axis 2 is "road", axis 3 is "other".

`SCHEMA` is the index before the suite's migration 013; `SCHEMA_WITH_MODEL` adds 013's `embeddings.model`
column (verbatim), which records the embedding model behind each vector."""

import sqlite3

import numpy as np

OCEAN = [1.0, 0.0, 0.0, 0.0]
CROWD = [0.0, 1.0, 0.0, 0.0]
ROAD = [0.0, 0.0, 1.0, 0.0]
OTHER = [0.0, 0.0, 0.0, 1.0]

SCHEMA = """
CREATE TABLE clips (
    id INTEGER PRIMARY KEY AUTOINCREMENT, file_path TEXT NOT NULL UNIQUE,
    source_app TEXT NOT NULL DEFAULT 'spyglass_scan', checksum TEXT, size_bytes INTEGER, duration_sec REAL,
    ingested_at TEXT NOT NULL DEFAULT '2026-01-01T00:00:00Z', frame_rate REAL);
CREATE TABLE shots (
    id INTEGER PRIMARY KEY AUTOINCREMENT, clip_id INTEGER NOT NULL REFERENCES clips(id) ON DELETE CASCADE,
    start_tc REAL NOT NULL, end_tc REAL NOT NULL, keyframe_path TEXT, technical_quality_score REAL,
    energy_score REAL, caption TEXT, caption_hub_score REAL, is_favorite INTEGER NOT NULL DEFAULT 0);
CREATE TABLE tags (
    id INTEGER PRIMARY KEY AUTOINCREMENT, shot_id INTEGER NOT NULL REFERENCES shots(id) ON DELETE CASCADE,
    label TEXT NOT NULL, source TEXT NOT NULL DEFAULT 'spyglass_vlm', confidence REAL);
CREATE UNIQUE INDEX idx_tags_shot_id_label ON tags(shot_id, label);
CREATE TABLE embeddings (
    id INTEGER PRIMARY KEY AUTOINCREMENT, shot_id INTEGER NOT NULL REFERENCES shots(id) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK (kind IN ('visual', 'caption')), vector BLOB NOT NULL);
CREATE TABLE transcript_segments (
    id INTEGER PRIMARY KEY AUTOINCREMENT, clip_id INTEGER NOT NULL REFERENCES clips(id) ON DELETE CASCADE,
    start_tc REAL NOT NULL, end_tc REAL NOT NULL, speaker TEXT, text TEXT NOT NULL, avg_logprob REAL, no_speech_prob REAL);
CREATE VIRTUAL TABLE transcript_segments_fts USING fts5(text, content = 'transcript_segments', content_rowid = 'id');
CREATE TRIGGER transcript_segments_ai AFTER INSERT ON transcript_segments BEGIN
    INSERT INTO transcript_segments_fts(rowid, text) VALUES (new.id, new.text);
END;
CREATE TABLE alias_links (apparent_path TEXT PRIMARY KEY, real_path TEXT NOT NULL, updated_at TEXT NOT NULL DEFAULT '2026-01-01T00:00:00Z');
"""

LEGACY = "ViT-B-32-quickgelu/openai"
SIGLIP = "ViT-B-16-SigLIP2-256/webli"

# apps/spyglass/crates/spyglass-core/migrations/013_add_embedding_model.sql
MIGRATION_013 = """
ALTER TABLE embeddings ADD COLUMN model TEXT NOT NULL DEFAULT 'ViT-B-32-quickgelu/openai';
CREATE INDEX idx_embeddings_model ON embeddings(model);
"""
SCHEMA_WITH_MODEL = SCHEMA + MIGRATION_013


def blob(vector):
    return np.asarray(vector, dtype="<f4").tobytes()


class Archive:
    """Builds an index file step by step."""

    def __init__(self, path, schema=SCHEMA):
        self.path = str(path)
        self.conn = sqlite3.connect(self.path)
        self.conn.executescript(schema)

    def clip(self, file_path, size=None, duration=60.0):
        return self.conn.execute(
            "INSERT INTO clips(file_path, size_bytes, duration_sec) VALUES (?, ?, ?)",
            (file_path, size, duration),
        ).lastrowid

    def shot(
        self,
        clip_id,
        start,
        end,
        visual=None,
        caption=None,
        caption_vector=None,
        tags=(),
        hub=None,
        quality=None,
        model=None,
    ):
        """`model` fills the embeddings.model column (SCHEMA_WITH_MODEL only); None leaves its default."""
        shot_id = self.conn.execute(
            "INSERT INTO shots(clip_id, start_tc, end_tc, caption, caption_hub_score, technical_quality_score) VALUES (?, ?, ?, ?, ?, ?)",
            (clip_id, start, end, caption, hub, quality),
        ).lastrowid
        for kind, vector in (("visual", visual), ("caption", caption_vector)):
            if vector is None:
                continue
            if model is None:
                self.conn.execute(
                    "INSERT INTO embeddings(shot_id, kind, vector) VALUES (?, ?, ?)",
                    (shot_id, kind, blob(vector)),
                )
            else:
                self.conn.execute(
                    "INSERT INTO embeddings(shot_id, kind, vector, model) VALUES (?, ?, ?, ?)",
                    (shot_id, kind, blob(vector), model),
                )
        for label in tags:
            self.conn.execute("INSERT INTO tags(shot_id, label) VALUES (?, ?)", (shot_id, label))
        return shot_id

    def transcript(self, clip_id, start, end, text):
        self.conn.execute(
            "INSERT INTO transcript_segments(clip_id, start_tc, end_tc, text) VALUES (?, ?, ?, ?)",
            (clip_id, start, end, text),
        )

    def alias(self, apparent, real):
        self.conn.execute(
            "INSERT INTO alias_links(apparent_path, real_path) VALUES (?, ?)",
            (apparent, real),
        )

    def done(self):
        """Saves and closes the file (safe to call again) and returns its path."""
        if self.conn is not None:
            self.conn.commit()
            self.conn.close()
            self.conn = None
        return self.path
