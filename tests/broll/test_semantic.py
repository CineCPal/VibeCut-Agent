"""tests/test_semantic.py -- matching clips to text, with the CLIP model replaced by colour vectors.

Real (tiny) video files are written with OpenCV so frame sampling and seeking are exercised for real.
A frame's "embedding" is its mean colour and a text's is a colour name, so red frames match "red"."""

import json
import os

import cv2
import numpy as np
import pytest

from vibecut_agent.broll import semantic

FPS = 10
RED, GREEN, BLUE = (0, 0, 255), (0, 255, 0), (255, 0, 0)  # BGR, as OpenCV writes them
NAMES = {"red": [1.0, 0.0, 0.0], "green": [0.0, 1.0, 0.0], "blue": [0.0, 0.0, 1.0]}


def make_clip(path, colours, seconds_each=4.0, size=(64, 48)):
    """A video that shows each colour in turn for `seconds_each` seconds."""
    writer = cv2.VideoWriter(str(path), cv2.VideoWriter_fourcc(*"MJPG"), FPS, size)
    assert writer.isOpened(), "this OpenCV build cannot write test videos"
    for colour in colours:
        frame = np.zeros((size[1], size[0], 3), dtype=np.uint8)
        frame[:] = colour
        for _ in range(int(seconds_each * FPS)):
            writer.write(frame)
    writer.release()
    return str(path)


def fake_encode_images(images):
    rows = []
    for image in images:
        mean = np.asarray(image, dtype=np.float32).reshape(-1, 3).mean(axis=0)  # R, G, B
        rows.append(mean / (np.linalg.norm(mean) or 1.0))
    return np.asarray(rows, dtype=np.float32)


def fake_encode_texts(texts):
    return np.asarray(
        [NAMES.get(text.split()[0], [1.0, 1.0, 1.0]) for text in texts],
        dtype=np.float32,
    )


class Never:
    def is_set(self):
        return False


class After:
    """A cancel flag that trips after `n` checks."""

    def __init__(self, n):
        self.n = n

    def is_set(self):
        self.n -= 1
        return self.n < 0


@pytest.fixture
def folder(tmp_path):
    make_clip(tmp_path / "red_then_blue.avi", [RED, BLUE])  # 8 s
    make_clip(tmp_path / "green.avi", [GREEN], seconds_each=6.0)  # 6 s
    return str(tmp_path)


def files_in(folder):
    return sorted(os.path.join(folder, n) for n in os.listdir(folder) if n.endswith(".avi"))


class TestSampleTimes:
    def test_one_frame_in_the_middle_of_each_two_second_slice(self):
        assert semantic.sample_times(8.0) == [1.0, 3.0, 5.0, 7.0]

    def test_a_short_clip_still_gets_one_frame(self):
        assert semantic.sample_times(0.5) == [0.25]

    def test_a_long_clip_is_capped_and_spread_over_its_whole_length(self):
        times = semantic.sample_times(600.0)
        assert len(times) == semantic.MAX_FRAMES_PER_CLIP
        assert times[0] == pytest.approx(10.0) and times[-1] == pytest.approx(590.0)

    @pytest.mark.parametrize("duration", [0, -1, float("nan"), float("inf")])
    def test_nothing_for_a_length_that_makes_no_sense(self, duration):
        assert semantic.sample_times(duration) == []


class TestBestWindow:
    def test_centres_on_the_best_frames_and_stays_inside_the_clip(self):
        times = [1, 3, 5, 7]
        assert semantic.best_window(times, [0, 0, 1, 1], 8.0, 4.0) == (4.0, 8.0, 1.0)
        start, end, _ = semantic.best_window(times, [1, 0, 0, 0], 8.0, 4.0)
        assert (start, end) == (0.0, 4.0)

    def test_a_window_longer_than_the_clip_is_the_whole_clip(self):
        assert semantic.best_window([1.0], [0.5], 2.0, 10.0) == (0.0, 2.0, 0.5)

    def test_one_great_frame_in_a_dull_stretch_still_counts(self):
        _, _, score = semantic.best_window([1, 3, 5, 7], [0.0, 0.9, 0.1, 0.0], 8.0, 4.0)
        assert score == pytest.approx(0.5)  # mean of the two best frames in the window


class TestRelativeScores:
    def test_spreads_over_zero_to_one_hundred(self):
        assert semantic.relative_scores([0.20, 0.30, 0.25]) == pytest.approx([0.0, 100.0, 50.0])

    def test_ties_and_single_candidates(self):
        assert semantic.relative_scores([0.3, 0.3]) == [50.0, 50.0]
        assert semantic.relative_scores([0.3]) == [100.0]
        assert semantic.relative_scores([]) == []


class TestIndexFile:
    def test_round_trips_and_ignores_damage(self, tmp_path):
        folder = str(tmp_path)
        assert semantic.load_index(folder) == {}
        assert semantic.save_index(folder, {"a.mov": {"x": 1}})
        assert semantic.load_index(folder) == {"a.mov": {"x": 1}}
        assert not os.path.exists(semantic.index_path(folder) + ".tmp")

        with open(semantic.index_path(folder), "w") as handle:
            handle.write("{ not json")
        assert semantic.load_index(folder) == {}
        with open(semantic.index_path(folder), "w") as handle:
            json.dump({"version": 999, "clips": {"a": {}}}, handle)
        assert semantic.load_index(folder) == {}

    def test_save_failure_is_reported_not_raised(self, tmp_path):
        assert semantic.save_index(str(tmp_path / "missing folder"), {}) is False

    def test_entry_is_current_needs_the_same_file_and_usable_data(self):
        entry = {
            "size": 10,
            "mtime": 5.0,
            "duration": 8.0,
            "times": [1.0],
            "vectors": [[1.0]],
        }
        assert semantic.entry_is_current(entry, (10, 5.0))
        assert semantic.entry_is_current(entry, (10, 5.0 + 1e-9))
        assert not semantic.entry_is_current(entry, (11, 5.0))
        assert not semantic.entry_is_current(entry, (10, 6.0))
        assert not semantic.entry_is_current(entry, None)
        assert not semantic.entry_is_current(None, (10, 5.0))
        assert not semantic.entry_is_current({**entry, "vectors": []}, (10, 5.0))
        assert not semantic.entry_is_current({**entry, "times": [1.0, 2.0]}, (10, 5.0))


class TestReadFrames:
    def test_reads_the_length_and_a_frame_per_slice(self, folder):
        duration, frames = semantic.read_frames(os.path.join(folder, "red_then_blue.avi"))
        assert duration == pytest.approx(8.0, abs=0.2)
        assert [round(t) for t, _ in frames] == [1, 3, 5, 7]
        first, last = (
            np.asarray(frames[0][1]).reshape(-1, 3).mean(axis=0),
            np.asarray(frames[-1][1]).reshape(-1, 3).mean(axis=0),
        )
        assert first[0] > 200 > last[0] and last[2] > 200 > first[2]  # red early, blue late

    def test_a_file_that_is_not_a_video_is_an_error(self, tmp_path):
        path = tmp_path / "broken.avi"
        path.write_bytes(b"not a video")
        with pytest.raises(ValueError):
            semantic.read_frames(str(path))


class TestBuildIndex:
    def test_embeds_every_clip_and_saves_the_index(self, folder):
        outcome = semantic.build_index(folder, files_in(folder), fake_encode_images, Never())
        assert (outcome.indexed, outcome.cached, outcome.failed, outcome.cancelled) == (
            2,
            0,
            [],
            False,
        )
        assert sorted(outcome.entries) == ["green.avi", "red_then_blue.avi"]
        assert sorted(semantic.load_index(folder)) == sorted(outcome.entries)
        assert len(outcome.entries["red_then_blue.avi"]["vectors"]) == 4

    def test_a_second_run_reuses_the_stored_embeddings(self, folder):
        semantic.build_index(folder, files_in(folder), fake_encode_images, Never())
        calls = []
        second = semantic.build_index(
            folder,
            files_in(folder),
            fake_encode_images,
            Never(),
            reader=lambda *a: calls.append(a) or {},
        )
        assert (second.indexed, second.cached) == (0, 2) and calls == []

    def test_a_changed_file_is_embedded_again_and_a_removed_one_is_dropped(self, folder):
        semantic.build_index(folder, files_in(folder), fake_encode_images, Never())
        make_clip(os.path.join(folder, "green.avi"), [GREEN], seconds_each=7.0)
        os.remove(os.path.join(folder, "red_then_blue.avi"))
        outcome = semantic.build_index(folder, files_in(folder), fake_encode_images, Never())
        assert (outcome.indexed, outcome.cached) == (1, 0)
        assert list(semantic.load_index(folder)) == ["green.avi"]

    def test_one_unreadable_clip_does_not_stop_the_rest(self, folder):
        bad = os.path.join(folder, "bad.avi")
        with open(bad, "wb") as handle:
            handle.write(b"junk")
        outcome = semantic.build_index(folder, files_in(folder), fake_encode_images, Never())
        assert outcome.indexed == 2
        assert [f["path"] for f in outcome.failed] == [bad]
        assert outcome.failed[0]["message"]
        assert "bad.avi" not in semantic.load_index(folder)

    def test_a_cancel_keeps_finished_clips_and_the_old_entries_of_the_rest(self, folder):
        files = files_in(folder)  # green.avi, red_then_blue.avi
        semantic.build_index(folder, files, fake_encode_images, Never())
        make_clip(os.path.join(folder, "green.avi"), [GREEN], seconds_each=7.0)  # stale now
        outcome = semantic.build_index(folder, files, fake_encode_images, After(1))
        assert outcome.cancelled and outcome.indexed == 1
        assert sorted(semantic.load_index(folder)) == ["green.avi", "red_then_blue.avi"]

    def test_reports_progress_for_every_clip(self, folder):
        seen = []
        semantic.build_index(
            folder,
            files_in(folder),
            fake_encode_images,
            Never(),
            on_progress=lambda d, t, n: seen.append((d, t, n)),
        )
        assert seen == [(1, 2, "green.avi"), (2, 2, "red_then_blue.avi")]

    def test_saves_along_the_way_so_a_killed_run_keeps_its_work(self, folder, monkeypatch):
        monkeypatch.setattr(semantic, "SAVE_EVERY", 1)
        saves = []
        real = semantic.save_index
        monkeypatch.setattr(semantic, "save_index", lambda f, e: saves.append(sorted(e)) or real(f, e))
        semantic.build_index(folder, files_in(folder), fake_encode_images, Never())
        assert saves[0] == ["green.avi"] and saves[-1] == [
            "green.avi",
            "red_then_blue.avi",
        ]


class TestRankQuery:
    @pytest.fixture
    def entries(self, folder):
        return semantic.build_index(folder, files_in(folder), fake_encode_images, Never()).entries

    def rank(self, entries, folder, colour, **overrides):
        options = {"top_k": 5, "window_sec": 4.0, "quality_weight": 0.0}
        options.update(overrides)
        return semantic.rank_query(fake_encode_texts([colour])[0], entries, folder, {}, **options)

    def test_the_clip_that_shows_the_colour_ranks_first_with_the_right_stretch(self, entries, folder):
        blue = self.rank(entries, folder, "blue")
        assert next(r["filename"] for r in blue) == "red_then_blue.avi"
        assert blue[0]["start"] >= 3.5 and blue[0]["end"] <= 8.05  # the blue half
        assert blue[0]["relative"] == 100.0 and blue[0]["technical"] is None and blue[0]["combined"] == 100.0
        assert self.rank(entries, folder, "green")[0]["filename"] == "green.avi"
        red = self.rank(entries, folder, "red")[0]
        assert red["filename"] == "red_then_blue.avi" and red["end"] <= 4.55

    def test_top_k_limits_the_list_and_paths_are_absolute(self, entries, folder):
        (only,) = self.rank(entries, folder, "green", top_k=1)
        assert only["path"] == os.path.join(folder, "green.avi") and only["duration"] == pytest.approx(
            6.0, abs=0.2
        )

    def test_quality_can_break_the_order_when_the_weight_is_high(self, entries, folder):
        technical = {
            os.path.join(folder, "green.avi"): 100.0,
            os.path.join(folder, "red_then_blue.avi"): 0.0,
        }
        args = (fake_encode_texts(["blue"])[0], entries, folder, technical)
        by_meaning = semantic.rank_query(*args, top_k=5, window_sec=4.0, quality_weight=0.0)
        by_quality = semantic.rank_query(*args, top_k=5, window_sec=4.0, quality_weight=1.0)
        assert by_meaning[0]["filename"] == "red_then_blue.avi"
        assert by_quality[0]["filename"] == "green.avi" and by_quality[0]["technical"] == 100.0

    def test_clips_without_a_quality_score_rank_by_meaning_alone(self, entries, folder):
        technical = {os.path.join(folder, "green.avi"): 10.0}
        results = semantic.rank_query(
            fake_encode_texts(["blue"])[0],
            entries,
            folder,
            technical,
            top_k=5,
            window_sec=4.0,
            quality_weight=0.5,
        )
        unscored = next(r for r in results if r["filename"] == "red_then_blue.avi")
        assert unscored["technical"] is None and unscored["combined"] == unscored["relative"]

    def test_entries_from_a_different_model_are_ignored(self, entries, folder):
        entries["odd.avi"] = {
            **entries["green.avi"],
            "vectors": [[0.1, 0.2]] * 3,
            "times": [1, 2, 3],
        }
        assert "odd.avi" not in [r["filename"] for r in self.rank(entries, folder, "blue")]

    def test_no_clips_means_no_results(self, folder):
        assert (
            semantic.rank_query(
                fake_encode_texts(["blue"])[0],
                {},
                folder,
                {},
                top_k=5,
                window_sec=4.0,
                quality_weight=0.3,
            )
            == []
        )
