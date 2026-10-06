"""tests/test_spyglass_index.py -- reading and ranking a Spyglass index, with a synthetic database."""

import hashlib
import math
import os
import sqlite3

import numpy as np
import pytest

from tests.broll.spyglass_fixture import (
    CROWD,
    LEGACY,
    OCEAN,
    OTHER,
    ROAD,
    SCHEMA_WITH_MODEL,
    SIGLIP,
    Archive,
    blob,
)
from vibecut_agent.broll import semantic, vision_energy
from vibecut_agent.broll import spyglass_index as sg


def q(*vectors):
    return np.asarray(vectors, dtype=np.float32)


def legacy(vectors):
    """Query vectors for an index that holds only the original CLIP vectors."""
    return {sg.LEGACY_EMBEDDING_MODEL: vectors}


def sha(path):
    with open(path, "rb") as handle:
        return hashlib.sha256(handle.read()).hexdigest()


@pytest.fixture
def folder(tmp_path):
    root = tmp_path / "broll"
    root.mkdir()
    return root


def make_file(folder, name, size=10):
    path = folder / name
    path.write_bytes(b"x" * size)
    return str(path)


# ------------------------------------------------------------------------------------ the file


class TestOpenIndex:
    def test_reads_a_spyglass_shaped_database(self, tmp_path):
        path = Archive(tmp_path / "i.sqlite").done()
        conn = sg.open_index(path)
        assert conn.execute("SELECT COUNT(*) FROM clips").fetchone() == (0,)
        conn.close()

    def test_is_strictly_read_only_and_leaves_the_file_untouched(self, tmp_path, folder):
        archive = Archive(tmp_path / "i.sqlite")
        clip = archive.clip(make_file(folder, "a.mp4"), size=10)
        archive.shot(clip, 0, 5, visual=OCEAN, tags=["ocean"])
        path = archive.done()
        before = sha(path)

        conn = sg.open_index(path)
        with pytest.raises(sqlite3.OperationalError):
            conn.execute("DELETE FROM clips")
        with pytest.raises(sqlite3.OperationalError):
            conn.execute("CREATE TABLE evil (x)")
        sg.search(conn, ["ocean"], legacy(q(OCEAN)), {clip: str(folder / "a.mp4")}, 5)
        sg.match_files(conn, [str(folder / "a.mp4")])
        conn.close()
        assert sha(path) == before
        assert not os.path.exists(path + "-wal") and not os.path.exists(path + "-journal")

    def test_a_missing_file_a_non_database_and_a_foreign_schema_are_clear_errors(self, tmp_path):
        with pytest.raises(sg.SpyglassError, match="not found"):
            sg.open_index(str(tmp_path / "nope.sqlite"))
        junk = tmp_path / "junk.sqlite"
        junk.write_bytes(b"this is not sqlite" * 50)
        with pytest.raises(sg.SpyglassError, match="not a readable"):
            sg.open_index(str(junk))
        other = tmp_path / "other.sqlite"
        conn = sqlite3.connect(other)
        conn.execute("CREATE TABLE clips (id INTEGER, name TEXT)")
        conn.commit()
        conn.close()
        with pytest.raises(sg.SpyglassError, match="does not look like a Spyglass index"):
            sg.open_index(str(other))

    def test_default_path_uses_the_override_then_spyglass_app_data(self, tmp_path, monkeypatch):
        db = Archive(tmp_path / "custom.sqlite").done()
        monkeypatch.setenv(sg.ENV_INDEX, db)
        assert sg.default_index_path() == db
        monkeypatch.setenv(sg.ENV_INDEX, str(tmp_path / "missing.sqlite"))
        monkeypatch.setenv("HOME", str(tmp_path / "home"))
        assert sg.default_index_path() is None
        data = tmp_path / "home" / "Library" / "Application Support" / sg.APP_ID
        data.mkdir(parents=True)
        (data / sg.INDEX_FILENAME).write_bytes(b"")
        assert sg.default_index_path() == str(data / sg.INDEX_FILENAME)


# ------------------------------------------------------------------------------ which clips


class TestMatchFiles:
    counter = 0

    def coverage(self, tmp_path, build, files):
        TestMatchFiles.counter += 1
        archive = Archive(tmp_path / f"cov{TestMatchFiles.counter}.sqlite")
        build(archive)
        conn = sg.open_index(archive.done())
        try:
            return sg.match_files(conn, files)
        finally:
            conn.close()

    def test_a_clip_at_the_same_path_and_size_is_indexed(self, tmp_path, folder):
        f = make_file(folder, "a.mp4", 10)
        cov = self.coverage(tmp_path, lambda a: a.clip(f, size=10), [f])
        assert list(cov.indexed) == [f] and cov.unindexed == [] and cov.moved == []

    def test_a_clip_that_is_not_in_the_index_says_so(self, tmp_path, folder):
        f, g = make_file(folder, "a.mp4"), make_file(folder, "b.mp4")
        cov = self.coverage(tmp_path, lambda a: a.clip(f, size=10), [f, g])
        assert list(cov.indexed) == [f]
        assert cov.unindexed == [{"path": g, "reason": "Not in the Spyglass index"}]

    def test_a_clip_that_changed_since_it_was_indexed_is_not_trusted(self, tmp_path, folder):
        f = make_file(folder, "a.mp4", 10)
        cov = self.coverage(tmp_path, lambda a: a.clip(f, size=999), [f])
        assert cov.indexed == {} and cov.unindexed == [
            {"path": f, "reason": "Changed since Spyglass indexed it"}
        ]

    def test_an_index_that_never_recorded_sizes_is_trusted_by_path(self, tmp_path, folder):
        f = make_file(folder, "a.mp4", 10)
        cov = self.coverage(tmp_path, lambda a: a.clip(f, size=None), [f])
        assert list(cov.indexed) == [f]

    def test_follows_symlinks(self, tmp_path, folder):
        real = tmp_path / "volume" / "real"
        real.mkdir(parents=True)
        (real / "a.mp4").write_bytes(b"x" * 10)
        link = folder / "linked"
        link.symlink_to(real)
        via_link = str(link / "a.mp4")
        cov = self.coverage(tmp_path, lambda a: a.clip(str(real / "a.mp4"), size=10), [via_link])
        assert list(cov.indexed) == [via_link]

    def test_alias_links_map_an_apparent_path_to_the_indexed_one(self, tmp_path, folder):
        f = make_file(folder, "b.mp4", 10)

        def build(a):
            a.clip("/Volumes/Old/b.mp4", size=10)
            a.alias(f, "/Volumes/Old/b.mp4")

        cov = self.coverage(tmp_path, build, [f])
        assert list(cov.indexed) == [f] and cov.moved == []

    def test_a_moved_clip_is_found_by_name_and_size_when_that_is_unambiguous(self, tmp_path, folder):
        f = make_file(folder, "Sunset.MP4", 10)
        cov = self.coverage(tmp_path, lambda a: a.clip("/Volumes/Old/sunset.mp4", size=10), [f])
        assert list(cov.indexed) == [f] and cov.moved == [f]

    def test_a_moved_clip_with_two_equal_candidates_or_another_size_is_not_guessed(self, tmp_path, folder):
        f = make_file(folder, "a.mp4", 10)

        def two(a):
            a.clip("/one/a.mp4", size=10)
            a.clip("/two/a.mp4", size=10)

        assert self.coverage(tmp_path, two, [f]).indexed == {}
        assert (
            self.coverage(tmp_path, lambda a: a.clip("/one/a.mp4", size=11), [f]).unindexed[0]["reason"]
            == "Not in the Spyglass index"
        )

    def test_an_unreadable_file_is_reported(self, tmp_path, folder):
        gone = str(folder / "gone.mp4")
        cov = self.coverage(tmp_path, lambda a: None, [gone])
        assert cov.unindexed == [{"path": gone, "reason": "The file could not be read"}]


# ---------------------------------------------------------------------------------- scoring


class TestScoringPieces:
    def test_tag_rarity_rewards_rare_tags_and_ignores_ones_on_every_shot(self):
        assert sg.normalized_tag_rarity(1000, 1000) == 0.0
        assert sg.normalized_tag_rarity(1, 1000) == pytest.approx(1.0)
        assert 0.0 < sg.normalized_tag_rarity(250, 1000) < sg.normalized_tag_rarity(10, 1000) < 1.0
        assert sg.normalized_tag_rarity(5, 1) == 1.0 and sg.normalized_tag_rarity(0, 100) == 1.0

    def test_caption_threshold_is_relative_to_the_query_and_never_met_without_a_baseline(
        self,
    ):
        assert sg.caption_relevance_threshold([0.1]) == math.inf
        assert sg.caption_relevance_threshold([0.3, 0.3, 0.3]) == math.inf
        assert sg.caption_relevance_threshold([0.0, 1.0]) == pytest.approx(1.0)  # mean 0.5 + one stdev 0.5

    def test_pure_visual_match_outranks_a_tag_only_match_and_weights_add_up(self):
        visual = sg._Candidate(visual=0.30)
        tag = sg._Candidate(tag_hit=True, tag_rarity=1.0)
        assert sg.hybrid_score(visual, math.inf) == pytest.approx(0.30 * sg.WEIGHT_VISUAL)
        assert sg.hybrid_score(tag, math.inf) == pytest.approx(sg.WEIGHT_TAG)
        both = sg._Candidate(visual=0.30, caption=0.5, tag_hit=True, tag_rarity=0.5, transcript_hit=True)
        expected = 0.30 * 0.45 + 0.5 * 0.20 + 0.5 * 0.20 + 0.15
        assert sg.hybrid_score(both, 0.4) == pytest.approx(expected)

    def test_visual_similarity_below_the_noise_floor_counts_for_nothing(self):
        noise = sg._Candidate(visual=0.20)
        assert sg.hybrid_score(noise, math.inf) == 0.0 and not sg.has_meaningful_signal(noise, math.inf)
        assert sg.has_meaningful_signal(sg._Candidate(visual=0.24), math.inf)

    def test_negative_similarity_is_clamped_not_penalised(self):
        assert sg.hybrid_score(
            sg._Candidate(caption=-0.3, tag_hit=True, tag_rarity=1.0), -1.0
        ) == pytest.approx(sg.WEIGHT_TAG)

    def test_tags_match_whole_words_with_plural_handling_only(self):
        assert sg.tag_matches_token("waves", "wave") and sg.tag_matches_token("cheering", "cheering")
        assert not sg.tag_matches_token("cat", "vacation") and not sg.tag_matches_token("party", "art")

    def test_short_words_are_not_query_terms(self):
        assert sg.query_tokens("A Wave at the Beach") == ["wave", "the", "beach"]


# ----------------------------------------------------------------------------------- search


@pytest.fixture
def archive_folder(tmp_path, folder):
    """Two clips in the folder and one elsewhere in the archive."""
    a = make_file(folder, "ocean.mp4")
    b = make_file(folder, "mixed.mp4")
    elsewhere = str(tmp_path / "other" / "crowd.mp4")
    archive = Archive(tmp_path / "i.sqlite")
    c_ocean, c_mixed, c_else = (
        archive.clip(a, 10),
        archive.clip(b, 10),
        archive.clip(elsewhere, 10),
    )
    shots = {
        "ocean": archive.shot(
            c_ocean,
            0,
            8,
            visual=OCEAN,
            caption="waves on a beach",
            tags=["beach", "water"],
            quality=80.0,
        ),
        "road": archive.shot(c_mixed, 0, 5, visual=ROAD, tags=["road"]),
        "crowd": archive.shot(c_mixed, 5, 12, visual=CROWD, tags=["crowd", "water"]),
        "else": archive.shot(c_else, 0, 9, visual=OCEAN, tags=["beach"]),
    }
    for i in range(6):  # filler so tag rarity has an archive to be rare in
        archive.shot(c_else, 20 + i, 21 + i, visual=OTHER, tags=["filler"])
    return archive, shots, {c_ocean: a, c_mixed: b}, folder


def run(archive, clip_paths, texts, vectors, top_k=5):
    conn = sg.open_index(archive.done())
    try:
        return sg.search(conn, texts, legacy(vectors), clip_paths, top_k)
    finally:
        conn.close()


class TestSearch:
    def test_the_closest_shot_ranks_first_with_its_caption_tags_and_span(self, archive_folder):
        archive, _, paths, _ = archive_folder
        (results,) = run(archive, paths, ["ocean"], q(OCEAN))
        top = results[0]
        assert top["filename"] == "ocean.mp4" and (top["start"], top["end"]) == (
            0.0,
            8.0,
        )
        assert (
            top["caption"] == "waves on a beach"
            and top["tags"] == ["beach", "water"]
            and top["technical"] == 80.0
        )
        assert top["visual"] == pytest.approx(1.0) and top["score"] > 0.4

    def test_only_the_folders_clips_are_returned_although_the_archive_has_better_matches(
        self, archive_folder
    ):
        archive, _, paths, _ = archive_folder
        (results,) = run(archive, paths, ["ocean"], q(OCEAN))
        assert {r["path"] for r in results} <= set(paths.values())
        assert all("crowd.mp4" not in r["path"] for r in results)

    def test_a_shot_with_no_real_signal_is_dropped_instead_of_returned_as_noise(self, archive_folder):
        archive, _, paths, _ = archive_folder
        (results,) = run(
            archive, paths, ["zebra"], q([0.0, 0.0, 0.5, 0.0])
        )  # road-ish vector, but "zebra" matches no tag
        assert [r["filename"] for r in results] == ["mixed.mp4"]  # the road shot clears the visual floor
        (nothing,) = run(archive, paths, ["zebra"], q([-1.0, -1.0, -1.0, -1.0]))  # like nothing in the folder
        assert nothing == []

    def test_a_tag_alone_surfaces_a_shot_and_a_rarer_tag_counts_for_more(self, archive_folder):
        archive, _, paths, _ = archive_folder
        (results,) = run(archive, paths, ["water"], q(OTHER))
        assert {r["filename"] for r in results} == {"ocean.mp4", "mixed.mp4"} and all(
            r["tagMatch"] for r in results
        )
        (road,) = run(archive, paths, ["road"], q(OTHER))
        assert [r["filename"] for r in road] == ["mixed.mp4"] and road[0]["score"] > 0
        # "water" is on two of the folder's shots and "road" on one: the rarer tag is worth more.
        assert road[0]["score"] > results[0]["score"]

    def test_the_transcript_adds_a_keyword_boost_to_shots_it_overlaps(self, tmp_path, folder):
        f = make_file(folder, "talk.mp4")
        archive = Archive(tmp_path / "i.sqlite")
        clip = archive.clip(f, 10)
        early = archive.shot(clip, 0, 10, visual=OTHER)
        late = archive.shot(clip, 10, 20, visual=OTHER)
        archive.transcript(clip, 12, 15, "the harbour was quiet")
        results = run(archive, {clip: f}, ["harbour"], q(OCEAN))[0]
        assert [(r["start"], r["transcriptMatch"]) for r in results] == [(10.0, True)]
        assert results[0]["score"] == pytest.approx(sg.WEIGHT_KEYWORD)
        assert early != late

    def test_a_query_fts5_cannot_parse_is_no_keyword_signal_not_a_crash(self, tmp_path, folder):
        f = make_file(folder, "a.mp4")
        archive = Archive(tmp_path / "i.sqlite")
        clip = archive.clip(f, 10)
        archive.shot(clip, 0, 5, visual=OCEAN)
        results = run(archive, {clip: f}, ['"unbalanced (quote'], q(OCEAN))[0]
        assert len(results) == 1 and results[0]["transcriptMatch"] is False

    def test_caption_similarity_is_corrected_by_the_hub_score_and_needs_to_stand_out(self, tmp_path, folder):
        f = make_file(folder, "a.mp4")
        archive = Archive(tmp_path / "i.sqlite")
        clip = archive.clip(f, 10)
        hub = archive.shot(clip, 0, 5, caption="a generic scene", caption_vector=OCEAN, hub=0.95)
        real = archive.shot(clip, 5, 10, caption="waves", caption_vector=OCEAN, hub=0.0)
        for i in range(8):  # a baseline of unrelated captions so "stands out" means something
            archive.shot(clip, 10 + i, 11 + i, caption="other", caption_vector=OTHER)
        results = run(archive, {clip: f}, ["ocean"], q(OCEAN))[0]
        assert [r["start"] for r in results] == [5.0] and hub != real

    def test_top_k_limits_the_list_and_ties_are_ordered_stably(self, tmp_path, folder):
        f = make_file(folder, "a.mp4")
        archive = Archive(tmp_path / "i.sqlite")
        clip = archive.clip(f, 10)
        for i in range(5):
            archive.shot(clip, i * 3, i * 3 + 2, visual=OCEAN)
        first = run(archive, {clip: f}, ["ocean"], q(OCEAN), top_k=3)[0]
        assert [r["start"] for r in first] == [0.0, 3.0, 6.0]

    def test_vectors_of_another_size_are_skipped_and_several_queries_are_answered_together(
        self, tmp_path, folder
    ):
        f = make_file(folder, "a.mp4")
        archive = Archive(tmp_path / "i.sqlite")
        clip = archive.clip(f, 10)
        archive.shot(clip, 0, 5, visual=OCEAN)
        archive.shot(clip, 5, 10, visual=[1.0, 0.0])  # from some other model
        archive.shot(clip, 10, 15, visual=CROWD)
        ocean, crowd = run(archive, {clip: f}, ["ocean", "crowd"], q(OCEAN, CROWD))
        assert [r["start"] for r in ocean] == [0.0] and [r["start"] for r in crowd] == [10.0]

    def test_an_older_index_without_captions_or_hub_scores_still_searches(self, tmp_path, folder):
        f = make_file(folder, "a.mp4")
        path = tmp_path / "old.sqlite"
        conn = sqlite3.connect(path)
        conn.executescript(
            """
            CREATE TABLE clips (id INTEGER PRIMARY KEY, file_path TEXT, size_bytes INTEGER);
            CREATE TABLE shots (id INTEGER PRIMARY KEY, clip_id INTEGER, start_tc REAL, end_tc REAL);
            CREATE TABLE tags (id INTEGER PRIMARY KEY, shot_id INTEGER, label TEXT);
            CREATE TABLE embeddings (id INTEGER PRIMARY KEY, shot_id INTEGER, kind TEXT, vector BLOB);
            """
        )
        conn.execute("INSERT INTO clips VALUES (1, ?, 10)", (f,))
        conn.execute("INSERT INTO shots VALUES (1, 1, 0, 5)")
        conn.execute(
            "INSERT INTO embeddings(shot_id, kind, vector) VALUES (1, 'visual', ?)",
            (np.asarray(OCEAN, dtype="<f4").tobytes(),),
        )
        conn.commit()
        conn.close()
        c = sg.open_index(str(path))
        (results,) = sg.search(c, ["ocean"], legacy(q(OCEAN)), {1: f}, 5)
        assert len(results) == 1 and results[0]["caption"] is None and results[0]["technical"] is None

    def test_a_wrong_number_of_query_vectors_is_refused(self, archive_folder):
        archive, _, paths, _ = archive_folder
        with pytest.raises(sg.SpyglassError):
            run(archive, paths, ["a", "b"], q(OCEAN))


# ------------------------------------------------------------------------------------- the catalog


class TestListShotsForClips:
    """list_shots_for_clips: a plain per-clip metadata listing, no query vector involved -- the
    read path behind the Story Editor's Spyglass-backed B-roll catalog (see rough-cut-studio's
    gemini_client.generate_story_script)."""

    def test_lists_every_shot_of_the_given_clips_with_its_metadata(self, archive_folder):
        archive, shots, clip_paths, folder = archive_folder
        c_ocean, c_mixed = list(clip_paths)  # insertion order from the fixture: ocean, then mixed
        conn = sg.open_index(archive.done())
        try:
            out = sg.list_shots_for_clips(conn, clip_paths)
        finally:
            conn.close()

        by_span = {(round(s["start"], 1), round(s["end"], 1)): s for s in out}
        ocean = by_span[(0.0, 8.0)]
        assert ocean["path"] == clip_paths[c_ocean]
        assert ocean["caption"] == "waves on a beach"
        assert set(ocean["tags"]) == {"beach", "water"}
        assert ocean["technical"] == 80.0
        assert ocean["filename"] == os.path.basename(ocean["path"])
        # Two more shots belong to the "mixed" clip, with no caption/quality set.
        mixed_shots = [s for s in out if s["path"] == clip_paths[c_mixed]]
        assert len(mixed_shots) == 2
        assert all(s["caption"] is None and s["technical"] is None for s in mixed_shots)

    def test_ignores_shots_outside_the_given_clips(self, archive_folder):
        archive, shots, clip_paths, folder = archive_folder
        # clip_paths only has the two clips inside `folder` — the "elsewhere" clip's shot must not appear.
        conn = sg.open_index(archive.done())
        try:
            out = sg.list_shots_for_clips(conn, clip_paths)
        finally:
            conn.close()
        assert all(s["path"] in clip_paths.values() for s in out)
        assert len(out) == 3  # ocean, road, crowd -- not "else" or the 6 filler shots

    def test_empty_clip_paths_returns_nothing_without_querying(self, archive_folder):
        archive, _shots, _clip_paths, _folder = archive_folder
        conn = sg.open_index(archive.done())
        try:
            assert sg.list_shots_for_clips(conn, {}) == []
        finally:
            conn.close()

    def test_is_read_only_and_leaves_the_file_untouched(self, tmp_path, folder):
        archive = Archive(tmp_path / "cat.sqlite")
        clip = archive.clip(make_file(folder, "a.mp4"), size=10)
        archive.shot(clip, 0, 5, caption="c", tags=["t"], quality=50.0)
        path = archive.done()
        before = sha(path)
        conn = sg.open_index(path)
        sg.list_shots_for_clips(conn, {clip: str(folder / "a.mp4")})
        conn.close()
        assert sha(path) == before

    def test_tolerates_an_index_with_no_caption_or_quality_columns(self, tmp_path):
        f = str(tmp_path / "a.mp4")
        path = tmp_path / "old.sqlite"
        conn = sqlite3.connect(path)
        conn.executescript(
            """
            CREATE TABLE clips (id INTEGER PRIMARY KEY, file_path TEXT, size_bytes INTEGER);
            CREATE TABLE shots (id INTEGER PRIMARY KEY, clip_id INTEGER, start_tc REAL, end_tc REAL);
            CREATE TABLE tags (id INTEGER PRIMARY KEY, shot_id INTEGER, label TEXT);
            CREATE TABLE embeddings (id INTEGER PRIMARY KEY, shot_id INTEGER, kind TEXT, vector BLOB);
            """
        )
        conn.execute("INSERT INTO clips VALUES (1, ?, 10)", (f,))
        conn.execute("INSERT INTO shots VALUES (1, 1, 0, 5)")
        conn.commit()
        conn.close()
        c = sg.open_index(str(path))
        out = sg.list_shots_for_clips(c, {1: f})
        assert len(out) == 1 and out[0]["caption"] is None and out[0]["technical"] is None


# ------------------------------------------------------------------------- embedding models (013)


def at_cosine(c):
    """A unit vector whose cosine with OCEAN is exactly `c`."""
    return [c, math.sqrt(1.0 - c * c), 0.0, 0.0]


class TestEmbeddingModels:
    def test_the_model_ids_match_spyglass_and_the_vision_module(self):
        assert sg.LEGACY_EMBEDDING_MODEL == LEGACY == vision_energy.SPYGLASS_LEGACY_MODEL_ID
        assert sg.CURRENT_EMBEDDING_MODEL == SIGLIP == vision_energy.EMBED_MODEL_ID
        assert semantic.MODEL_ID == vision_energy.EMBED_MODEL_ID
        assert set(vision_energy.KNOWN_MODELS) == {LEGACY, SIGLIP}

    def test_an_index_without_the_model_column_holds_legacy_vectors_only(self, tmp_path, folder):
        archive = Archive(tmp_path / "i.sqlite")
        clip = archive.clip(make_file(folder, "a.mp4"), size=10)
        archive.shot(clip, 0, 5, visual=OCEAN)
        conn = sg.open_index(archive.done())
        try:
            assert not sg.has_model_column(conn)
            assert sg.embedding_models(conn, [clip]) == {LEGACY: 1}
            ((top,),) = sg.search(conn, ["ocean"], legacy(q(OCEAN)), {clip: "a"}, 5)
            assert top["model"] == LEGACY and top["visual"] == pytest.approx(1.0)
        finally:
            conn.close()

    def test_rows_written_before_the_migration_default_to_legacy(self, tmp_path, folder):
        archive = Archive(tmp_path / "i.sqlite", schema=SCHEMA_WITH_MODEL)
        clip = archive.clip(make_file(folder, "a.mp4"), size=10)
        archive.shot(clip, 0, 5, visual=OCEAN, caption_vector=OCEAN)
        conn = sg.open_index(archive.done())
        try:
            assert sg.has_model_column(conn)
            assert sg.embedding_models(conn, [clip]) == {LEGACY: 1}
        finally:
            conn.close()

    def test_models_are_counted_per_shot_for_the_given_clips_current_first(self, tmp_path, folder):
        archive = Archive(tmp_path / "i.sqlite", schema=SCHEMA_WITH_MODEL)
        old = archive.clip(make_file(folder, "old.mp4"), size=10)
        new = archive.clip(make_file(folder, "new.mp4"), size=10)
        other = archive.clip(make_file(folder, "other.mp4"), size=10)
        archive.shot(old, 0, 5, visual=OCEAN, caption_vector=OCEAN, model=LEGACY)
        archive.shot(old, 5, 9, visual=OCEAN, model=LEGACY)
        archive.shot(new, 0, 5, visual=OCEAN, caption_vector=OCEAN, model=SIGLIP)
        archive.shot(other, 0, 5, visual=OCEAN, model="Some-Future-Model/x")
        conn = sg.open_index(archive.done())
        try:
            models = sg.embedding_models(conn, [old, new])
            assert models == {SIGLIP: 1, LEGACY: 2} and list(models) == [SIGLIP, LEGACY]
            assert sg.embedding_models(conn, []) == {}
            assert list(sg.embedding_models(conn, [other, old, new])) == [
                SIGLIP,
                LEGACY,
                "Some-Future-Model/x",
            ]
        finally:
            conn.close()

    def test_siglip_visual_similarity_is_mapped_onto_clips_scale_and_nothing_else_is(
        self,
    ):
        # The suite's calibration: SigLIP's median relevant (0.174) and irrelevant (-0.007) cosines land
        # on either side of the shared 0.24 floor once mapped.
        assert sg.visual_similarity_on_reference_scale(SIGLIP, 0.174) > sg.MIN_VISUAL_SIMILARITY_TO_SURFACE
        assert sg.visual_similarity_on_reference_scale(SIGLIP, -0.007) < sg.MIN_VISUAL_SIMILARITY_TO_SURFACE
        assert sg.visual_similarity_on_reference_scale(SIGLIP, 1.0) == pytest.approx(0.9389)
        assert sg.visual_similarity_on_reference_scale(LEGACY, 0.3) == 0.3
        assert sg.visual_similarity_on_reference_scale("Other/x", 0.3) == 0.3

    def test_a_query_is_only_compared_with_vectors_from_its_own_model(self, tmp_path, folder):
        archive = Archive(tmp_path / "i.sqlite", schema=SCHEMA_WITH_MODEL)
        clip = archive.clip(make_file(folder, "a.mp4"), size=10)
        old = archive.shot(clip, 0, 5, visual=OCEAN, model=LEGACY)
        new = archive.shot(clip, 5, 9, visual=OCEAN, model=SIGLIP)
        conn = sg.open_index(archive.done())
        try:
            (only_siglip,) = sg.search(conn, ["ocean"], {SIGLIP: q(OCEAN)}, {clip: "a"}, 5)
            assert [r["shotId"] for r in only_siglip] == [new]
            assert only_siglip[0]["model"] == SIGLIP
            assert only_siglip[0]["visual"] == pytest.approx(0.9389, abs=1e-4)
            (only_legacy,) = sg.search(conn, ["ocean"], {LEGACY: q(OCEAN)}, {clip: "a"}, 5)
            assert [r["shotId"] for r in only_legacy] == [old]
        finally:
            conn.close()

    def test_a_mixed_archive_keeps_the_visual_signal_of_shots_not_yet_reindexed(self, tmp_path, folder):
        archive = Archive(tmp_path / "i.sqlite", schema=SCHEMA_WITH_MODEL)
        clip = archive.clip(make_file(folder, "a.mp4"), size=10)
        old = archive.shot(clip, 0, 5, visual=OCEAN, model=LEGACY)
        new = archive.shot(clip, 5, 9, visual=OCEAN, model=SIGLIP)
        archive.shot(clip, 9, 12, visual=ROAD, model=SIGLIP)
        conn = sg.open_index(archive.done())
        try:
            (results,) = sg.search(conn, ["ocean"], {LEGACY: q(OCEAN), SIGLIP: q(OCEAN)}, {clip: "a"}, 5)
            by_shot = {r["shotId"]: r["model"] for r in results}
            assert by_shot == {old: LEGACY, new: SIGLIP}
        finally:
            conn.close()

    def test_the_visual_floor_applies_after_mapping(self, tmp_path, folder):
        archive = Archive(tmp_path / "i.sqlite", schema=SCHEMA_WITH_MODEL)
        clip = archive.clip(make_file(folder, "a.mp4"), size=10)
        archive.shot(clip, 0, 5, visual=at_cosine(0.12), model=LEGACY)  # 0.12: below the floor
        new = archive.shot(clip, 5, 9, visual=at_cosine(0.12), model=SIGLIP)  # 0.12 -> 0.247: above it
        conn = sg.open_index(archive.done())
        try:
            (results,) = sg.search(conn, ["ocean"], {LEGACY: q(OCEAN), SIGLIP: q(OCEAN)}, {clip: "a"}, 5)
            assert [r["shotId"] for r in results] == [new]
        finally:
            conn.close()

    def test_caption_thresholds_are_worked_out_per_model(self, tmp_path, folder):
        archive = Archive(tmp_path / "i.sqlite", schema=SCHEMA_WITH_MODEL)
        clip = archive.clip(make_file(folder, "a.mp4"), size=10)
        # CLIP captions sit high; pooled with them, SigLIP's 0.3 would fall far below mean + 1 stdev.
        for i in range(5):
            archive.shot(clip, 20 + i, 21 + i, caption_vector=at_cosine(0.9), model=LEGACY)
        match = archive.shot(clip, 0, 5, caption_vector=at_cosine(0.3), model=SIGLIP)
        for i in range(3):
            archive.shot(clip, 10 + i, 11 + i, caption_vector=at_cosine(0.0), model=SIGLIP)
        conn = sg.open_index(archive.done())
        try:
            (results,) = sg.search(conn, ["ocean"], {LEGACY: q(OCEAN), SIGLIP: q(OCEAN)}, {clip: "a"}, 10)
            assert match in [r["shotId"] for r in results]
            pooled = sg.caption_relevance_threshold([0.9] * 5 + [0.3, 0.0, 0.0, 0.0])
            assert 0.3 < pooled  # what a single, pooled threshold would have done
        finally:
            conn.close()

    def test_a_shot_with_vectors_from_both_models_is_judged_by_the_current_one(self, tmp_path, folder):
        archive = Archive(tmp_path / "i.sqlite", schema=SCHEMA_WITH_MODEL)
        clip = archive.clip(make_file(folder, "a.mp4"), size=10)
        shot = archive.shot(clip, 0, 5, visual=OTHER, model=LEGACY)
        archive.conn.execute(
            "INSERT INTO embeddings(shot_id, kind, vector, model) VALUES (?, 'visual', ?, ?)",
            (shot, blob(OCEAN), SIGLIP),
        )
        conn = sg.open_index(archive.done())
        try:
            ((top,),) = sg.search(conn, ["ocean"], {LEGACY: q(OCEAN), SIGLIP: q(OCEAN)}, {clip: "a"}, 5)
            assert top["shotId"] == shot and top["model"] == SIGLIP
        finally:
            conn.close()

    def test_with_no_model_vectors_tags_still_find_shots(self, tmp_path, folder):
        archive = Archive(tmp_path / "i.sqlite", schema=SCHEMA_WITH_MODEL)
        clip = archive.clip(make_file(folder, "a.mp4"), size=10)
        shot = archive.shot(clip, 0, 5, visual=OCEAN, tags=["ocean"], model="Other/x")
        archive.shot(clip, 5, 9, visual=OCEAN, tags=["road"], model="Other/x")
        conn = sg.open_index(archive.done())
        try:
            ((top,),) = sg.search(conn, ["ocean"], {}, {clip: "a"}, 5)
            assert top["shotId"] == shot and top["tagMatch"] and top["model"] is None
            assert top["visual"] is None
        finally:
            conn.close()

    def test_the_migrated_index_is_still_never_written(self, tmp_path, folder):
        archive = Archive(tmp_path / "i.sqlite", schema=SCHEMA_WITH_MODEL)
        clip = archive.clip(make_file(folder, "a.mp4"), size=10)
        archive.shot(clip, 0, 5, visual=OCEAN, model=SIGLIP)
        path = archive.done()
        before = sha(path)
        conn = sg.open_index(path)
        sg.embedding_models(conn, [clip])
        sg.search(conn, ["ocean"], {SIGLIP: q(OCEAN)}, {clip: "a"}, 5)
        conn.close()
        assert sha(path) == before
