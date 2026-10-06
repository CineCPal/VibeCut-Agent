"""
tests/test_content_scoring.py
Unit tests for content-aware scoring: vision_energy's pure-numpy score
functions, brief relevance in _composite/rescore_clip, near-duplicate
marking, and result_cache's embeddings sidecar + model-aware cache hits.

No model is loaded anywhere here: every embedding and text target is a
synthetic unit vector, so the suite stays fast and needs no torch
weights. The real SigLIP 2 temperatures were calibrated separately
against archive footage (see vision_energy.py's constants).
"""

import numpy as np
import pytest

from vibecut_agent.broll import result_cache, vision_energy
from vibecut_agent.broll.analyzer import (
    SAMPLE_INTERVAL_SEC,
    ClipResult,
    FrameSample,
    _composite,
    mark_near_duplicates,
    rescore_clip,
)

DIM = 8


def unit(i, dim=DIM):
    v = np.zeros(dim, dtype=np.float32)
    v[i] = 1.0
    return v


def blend(a, b, t):
    v = (1.0 - t) * a + t * b
    return v / np.linalg.norm(v)


def make_result(n_samples, embeddings=None, filename="fake.mp4", **overrides):
    samples = [
        FrameSample(
            time_sec=i * SAMPLE_INTERVAL_SEC,
            sharpness=50.0,
            exposure=50.0,
            motion_mag=0.0,
            motion_jitter=0.0,
            energy=50.0,
        )
        for i in range(n_samples)
    ]
    result = ClipResult(
        path=filename,
        filename=filename,
        duration=n_samples * SAMPLE_INTERVAL_SEC,
        fps=24.0,
        width=1920,
        height=1080,
        samples=samples,
        energy_enabled=True,
        embeddings=embeddings,
        embed_model=vision_energy.EMBED_MODEL_ID,
    )
    for key, value in overrides.items():
        setattr(result, key, value)
    return result


# Brief = axis 0, neutral prompts = axes 1..3. A frame embedding on axis 0
# "matches"; one on axis 4 matches nothing in particular.
BRIEF_TARGETS = np.stack([unit(0), unit(1), unit(2), unit(3)])
ENERGY_TARGETS = np.stack([unit(5), unit(6)])  # [positive, negative]


# ---------------------------------------------------------------------
# vision_energy pure-numpy scores
# ---------------------------------------------------------------------


class TestScoreFunctions:
    def test_energy_favors_positive_target(self):
        emb = np.stack([blend(unit(5), unit(7), 0.5), blend(unit(6), unit(7), 0.5)])
        hi, lo = vision_energy.energy_from_embeddings(emb, ENERGY_TARGETS)
        assert hi > 99.0
        assert lo < 1.0

    def test_energy_equidistant_is_fifty(self):
        (score,) = vision_energy.energy_from_embeddings(unit(7)[None, :], ENERGY_TARGETS)
        assert score == pytest.approx(50.0)

    def test_relevance_matching_frame_scores_high(self):
        emb = np.stack([blend(unit(0), unit(4), 0.3), unit(4)])
        match, other = vision_energy.relevance_from_embeddings(emb, BRIEF_TARGETS)
        assert match > 95.0
        # Equidistant from brief and all 3 neutrals -> 1 / 4 of the mass.
        assert other == pytest.approx(25.0)

    def test_relevance_without_brief_is_all_zero(self):
        emb = np.stack([unit(0), unit(4)])
        out = vision_energy.relevance_from_embeddings(emb, None)
        assert out.tolist() == [0.0, 0.0]

    def test_float16_input_accepted(self):
        emb = unit(0)[None, :].astype(np.float16)
        (score,) = vision_energy.relevance_from_embeddings(emb, BRIEF_TARGETS)
        assert score > 95.0

    def test_empty_input(self):
        empty = np.zeros((0, DIM), dtype=np.float16)
        assert vision_energy.relevance_from_embeddings(empty, BRIEF_TARGETS).shape == (0,)
        assert vision_energy.energy_from_embeddings(empty, ENERGY_TARGETS).shape == (0,)

    def test_brief_targets_empty_brief_needs_no_model(self):
        # Must short-circuit before ever trying to load torch weights.
        assert vision_energy.brief_targets("   ") is None
        assert vision_energy.brief_targets("") is None


# ---------------------------------------------------------------------
# _composite with relevance
# ---------------------------------------------------------------------


def sample_with(technical_parts=0.0, energy=0.0, relevance=0.0):
    s = FrameSample(
        time_sec=0.0,
        sharpness=technical_parts,
        exposure=technical_parts,
        motion_mag=0.0,
        motion_jitter=0.0,
        energy=energy,
    )
    s.__dict__["stability_score"] = technical_parts
    s.__dict__["relevance"] = relevance
    return s


class TestCompositeRelevance:
    def test_three_way_blend(self):
        s = sample_with(technical_parts=40.0, energy=80.0, relevance=100.0)
        # technical == 40 (all parts 40, weights sum to 1).
        expected = 40.0 * 0.4 + 80.0 * 0.3 + 100.0 * 0.3
        assert _composite(s, energy_weight=0.3, relevance_weight=0.3) == pytest.approx(expected)

    def test_relevance_only(self):
        s = sample_with(technical_parts=0.0, relevance=100.0)
        assert _composite(s, relevance_weight=0.5) == pytest.approx(50.0)

    def test_weights_over_one_scale_proportionally(self):
        s = sample_with(technical_parts=10.0, energy=60.0, relevance=100.0)
        # 0.9 + 0.9 -> 0.5 / 0.5, technical drops out entirely.
        assert _composite(s, energy_weight=0.9, relevance_weight=0.9) == pytest.approx(80.0)

    def test_missing_relevance_attribute_counts_as_zero(self):
        s = FrameSample(0.0, 0.0, 0.0, 0.0, 0.0, energy=0.0)
        s.__dict__["stability_score"] = 0.0  # technical == 0
        assert _composite(s, relevance_weight=0.5) == pytest.approx(0.0)


# ---------------------------------------------------------------------
# rescore_clip with a brief
# ---------------------------------------------------------------------


def brief_clip():
    """24 samples (12s). Technical/energy are flat; only samples 14..21
    (t = 7.0..10.5s) look like the brief."""
    n = 24
    emb = np.stack([unit(0) if 14 <= i <= 21 else unit(4) for i in range(n)]).astype(np.float16)
    return make_result(n, embeddings=emb)


class TestRescoreWithBrief:
    def test_brief_moves_best_window_onto_matching_frames(self):
        r = brief_clip()
        rescore_clip(
            r,
            window_sec=3.0,
            energy_weight=0.0,
            enable_energy=True,
            relevance_targets=BRIEF_TARGETS,
            relevance_weight=0.5,
        )
        assert r.relevance_enabled
        assert 7.0 <= r.best_window_start and r.best_window_end <= 11.0
        assert r.mean_relevance_score > 25.0

    def test_no_brief_leaves_relevance_off(self):
        r = brief_clip()
        rescore_clip(r, window_sec=3.0, enable_energy=True, relevance_weight=0.5)
        assert not r.relevance_enabled
        assert r.mean_relevance_score == 0.0
        assert r.best_window_start == 0.0  # flat scores -> first window

    def test_content_scoring_off_ignores_brief(self):
        r = brief_clip()
        rescore_clip(
            r,
            window_sec=3.0,
            enable_energy=False,
            relevance_targets=BRIEF_TARGETS,
            relevance_weight=0.5,
        )
        assert not r.relevance_enabled
        assert r.best_window_start == 0.0

    def test_misaligned_embeddings_ignored(self):
        r = brief_clip()
        r.embeddings = r.embeddings[:-3]
        rescore_clip(
            r,
            window_sec=3.0,
            enable_energy=True,
            relevance_targets=BRIEF_TARGETS,
            relevance_weight=0.5,
        )
        assert not r.relevance_enabled

    def test_brief_change_flips_from_on_to_off(self):
        r = brief_clip()
        rescore_clip(r, enable_energy=True, relevance_targets=BRIEF_TARGETS, relevance_weight=0.5)
        assert r.relevance_enabled
        rescore_clip(r, enable_energy=True, relevance_weight=0.5)
        assert not r.relevance_enabled
        assert all(s.__dict__["relevance"] == 0.0 for s in r.samples)


# ---------------------------------------------------------------------
# mark_near_duplicates
# ---------------------------------------------------------------------


def clip_on(vec, score, filename, n=4, **overrides):
    r = make_result(
        n,
        embeddings=np.stack([vec] * n).astype(np.float16),
        filename=filename,
        **overrides,
    )
    r.overall_score = score
    return r


class TestNearDuplicates:
    def test_lower_scoring_take_is_marked(self):
        best = clip_on(unit(0), 80.0, "take2.mov")
        dup = clip_on(blend(unit(0), unit(1), 0.1), 60.0, "take1.mov")
        other = clip_on(unit(3), 70.0, "wide.mov")
        marked = mark_near_duplicates([dup, other, best])
        assert marked == 1
        assert dup.duplicate_of == "take2.mov"
        assert best.duplicate_of is None
        assert other.duplicate_of is None

    def test_clips_without_embeddings_never_marked(self):
        a = clip_on(unit(0), 80.0, "a.mov")
        b = make_result(4, filename="b.mov")
        b.overall_score = 50.0
        assert mark_near_duplicates([a, b]) == 0
        assert b.duplicate_of is None

    def test_errored_clips_skipped(self):
        a = clip_on(unit(0), 80.0, "a.mov")
        b = clip_on(unit(0), 0.0, "b.mov", error="broken")
        mark_near_duplicates([a, b])
        assert b.duplicate_of is None

    def test_stale_marks_cleared(self):
        a = clip_on(unit(0), 80.0, "a.mov")
        a.duplicate_of = "something-old.mov"
        mark_near_duplicates([a])
        assert a.duplicate_of is None

    def test_threshold_respected(self):
        a = clip_on(unit(0), 80.0, "a.mov")
        b = clip_on(blend(unit(0), unit(1), 0.5), 60.0, "b.mov")  # cos ~0.71
        assert mark_near_duplicates([a, b]) == 0


# ---------------------------------------------------------------------
# result_cache: embeddings sidecar + model-aware cache hits
# ---------------------------------------------------------------------


class TestEmbeddingsSidecar:
    def test_round_trip_with_nested_paths(self, tmp_path):
        a = np.random.default_rng(0).standard_normal((5, DIM)).astype(np.float16)
        b = np.random.default_rng(1).standard_normal((3, DIM)).astype(np.float16)
        result_cache.save_embeddings(str(tmp_path), {"a.mov": a, "day2/b clip.mov": b})
        loaded = result_cache.load_embeddings(str(tmp_path))
        assert set(loaded) == {"a.mov", "day2/b clip.mov"}
        np.testing.assert_array_equal(loaded["a.mov"], a)
        np.testing.assert_array_equal(loaded["day2/b clip.mov"], b)
        assert not any(p.name.endswith(".tmp.npz") for p in tmp_path.iterdir())

    def test_missing_file_is_empty(self, tmp_path):
        assert result_cache.load_embeddings(str(tmp_path)) == {}

    def test_corrupt_file_is_empty(self, tmp_path):
        (tmp_path / result_cache.EMBEDDINGS_FILENAME).write_bytes(b"not a zip")
        assert result_cache.load_embeddings(str(tmp_path)) == {}

    def test_empty_mapping_removes_stale_file(self, tmp_path):
        result_cache.save_embeddings(str(tmp_path), {"a.mov": np.ones((2, DIM))})
        result_cache.save_embeddings(str(tmp_path), {})
        assert not (tmp_path / result_cache.EMBEDDINGS_FILENAME).exists()


def cached_entry(result, fp=(100, 1.0)):
    return result_cache.entry_from_result(result, fp)


class TestModelAwareCacheHits:
    MODEL = vision_energy.EMBED_MODEL_ID

    def setup_method(self):
        self.emb = np.stack([unit(0)] * 4).astype(np.float16)
        self.result = make_result(4, embeddings=self.emb)
        self.entry = cached_entry(self.result)

    def test_entry_records_model(self):
        assert self.entry["embed_model"] == self.MODEL

    def test_entry_without_energy_records_no_model(self):
        r = make_result(4, energy_enabled=False)
        assert cached_entry(r)["embed_model"] is None

    def test_hit_restores_embeddings(self):
        restored = result_cache.restore_cached_result(
            "fake.mp4",
            self.entry,
            (100, 1.0),
            self.emb,
            need_energy=True,
            embed_model=self.MODEL,
        )
        assert restored is not None
        np.testing.assert_array_equal(restored.embeddings, self.emb)
        assert restored.embed_model == self.MODEL

    def test_model_mismatch_is_miss(self):
        self.entry["embed_model"] = "Some-Other-Model/x"
        assert (
            result_cache.restore_cached_result(
                "fake.mp4",
                self.entry,
                (100, 1.0),
                self.emb,
                need_energy=True,
                embed_model=self.MODEL,
            )
            is None
        )

    def test_legacy_clip_entry_is_miss_for_content_runs(self):
        del self.entry["embed_model"]  # written before the field existed
        assert result_cache.entry_embed_model(self.entry) == result_cache.LEGACY_EMBED_MODEL_ID
        assert (
            result_cache.restore_cached_result(
                "fake.mp4",
                self.entry,
                (100, 1.0),
                self.emb,
                need_energy=True,
                embed_model=self.MODEL,
            )
            is None
        )

    def test_missing_embeddings_is_miss_for_content_runs(self):
        assert (
            result_cache.restore_cached_result(
                "fake.mp4",
                self.entry,
                (100, 1.0),
                None,
                need_energy=True,
                embed_model=self.MODEL,
            )
            is None
        )

    def test_misaligned_embeddings_is_miss(self):
        assert (
            result_cache.restore_cached_result(
                "fake.mp4",
                self.entry,
                (100, 1.0),
                self.emb[:2],
                need_energy=True,
                embed_model=self.MODEL,
            )
            is None
        )

    def test_technical_only_run_ignores_model_and_embeddings(self):
        del self.entry["embed_model"]
        restored = result_cache.restore_cached_result(
            "fake.mp4",
            self.entry,
            (100, 1.0),
            None,
            need_energy=False,
            embed_model=self.MODEL,
        )
        assert restored is not None
        assert restored.embeddings is None

    def test_samples_json_has_no_relevance_field(self):
        # Spyglass's adapter parses this schema directly -- relevance must
        # stay a score-time attribute, never a cached sample field.
        rescore_clip(
            self.result,
            enable_energy=True,
            relevance_targets=BRIEF_TARGETS,
            relevance_weight=0.5,
        )
        entry = cached_entry(self.result)
        assert set(entry["samples"][0]) == {
            "time_sec",
            "sharpness",
            "exposure",
            "motion_mag",
            "motion_jitter",
            "energy",
        }
