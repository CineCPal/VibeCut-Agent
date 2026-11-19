"""Long files (PLAN.md, "Long files: transcripts that read back"): the sound extracted once and kept, caches
the app can always read, and Whisper's second look held to the transcript's language."""

from __future__ import annotations

import json
import math
import os
import random
import shutil
import subprocess
from pathlib import Path

import pytest

from vibecut_agent.transcribe import alignment, audio_cache, pipeline

needs_ffmpeg = pytest.mark.skipif(shutil.which("ffmpeg") is None, reason="needs ffmpeg")


@pytest.fixture
def clip(tmp_path) -> Path:
    path = tmp_path / "talk.mov"
    subprocess.run(
        [
            "ffmpeg",
            "-v",
            "error",
            "-y",
            "-f",
            "lavfi",
            "-i",
            "sine=duration=3",
            "-c:a",
            "pcm_s16le",
            str(path),
        ],
        check=True,
    )
    return path


# ----------------------------------------------------------------------------------- the kept sound


@needs_ffmpeg
def test_the_sound_is_extracted_once_and_reused(clip, monkeypatch):
    calls = []
    real = audio_cache.extract

    def counting(video, out, on_progress=None):
        calls.append(out)
        real(video, out, on_progress)

    monkeypatch.setattr(audio_cache, "extract", counting)
    with audio_cache.audio_for(str(clip)) as first:
        assert first.endswith(".flac") and os.path.isfile(first)
    with audio_cache.audio_for(str(clip)) as second:
        assert second == first
    assert len(calls) == 1
    # A changed file is extracted again.
    os.utime(clip, (1_000_000, 1_000_000))
    with audio_cache.audio_for(str(clip)) as third:
        assert third != first
    assert len(calls) == 2


@needs_ffmpeg
def test_extraction_reports_its_progress(clip, tmp_path):
    seen = []
    audio_cache.extract(str(clip), str(tmp_path / "out.wav"), lambda fraction, detail: seen.append(fraction))
    assert seen and seen[-1] == 1.0 and all(0.0 <= f <= 1.0 for f in seen)


@needs_ffmpeg
def test_a_folder_that_cant_be_written_falls_back_to_a_temporary_file(clip, tmp_path, monkeypatch):
    blocked = tmp_path / "blocked"
    blocked.write_text("a file, not a folder")
    monkeypatch.setenv("VIBECUT_AUDIO_CACHE_DIR", str(blocked / "audio"))
    with audio_cache.audio_for(str(clip)) as audio:
        assert audio.endswith(".wav") and os.path.isfile(audio)
        folder = os.path.dirname(audio)
    assert not os.path.exists(folder)


def test_the_time_limit_grows_with_the_file(tmp_path):
    small = tmp_path / "small.mov"
    small.write_bytes(b"x")
    assert audio_cache.extract_timeout(str(small), 60.0) == audio_cache.MIN_EXTRACT_TIMEOUT_S
    assert audio_cache.extract_timeout(str(small), 8 * 3600.0) == 4 * 3600.0
    big = tmp_path / "big.mov"
    with open(big, "wb") as f:
        f.truncate(54 * 1024**3)  # sparse: 54 GB, like a two-hour camera file
    assert audio_cache.extract_timeout(str(big), None) == pytest.approx(54 * 1024**3 / (8 * 1024**2))


def test_the_kept_sound_is_trimmed_oldest_first(tmp_path, monkeypatch):
    monkeypatch.setattr(audio_cache, "AUDIO_CACHE_MAX_BYTES", 250)
    files = []
    for i in range(4):
        path = tmp_path / f"{i}.flac"
        path.write_bytes(b"x" * 100)
        os.utime(path, (1000 + i, 1000 + i))
        files.append(path)
    audio_cache._prune(tmp_path, files[3])
    assert [p.exists() for p in files] == [False, False, True, True]


# ---------------------------------------------------------------------------- caches the app can read


def test_a_score_whisper_couldnt_compute_is_written_as_plainly_low(tmp_path):
    media = tmp_path / "a.wav"
    media.write_bytes(b"RIFF")
    lines = [
        pipeline.Segment(
            1.0,
            2.0,
            "Yeah.",
            avg_logprob=math.nan,
            no_speech_prob=math.inf,
            words=[{"start": 1.0, "end": 2.0, "text": "Yeah."}, {"start": math.nan, "end": 2.0, "text": "x"}],
        ),
        pipeline.Segment(math.nan, 3.0, "lost"),
    ]
    assert pipeline.write_cache(str(media), "a.wav", lines, ["Speaker 0"], language="en")
    text = (tmp_path / "a.wav.ivt-cache.json").read_text()
    data = json.loads(text, parse_constant=lambda c: pytest.fail(f"{c} in the cache"))
    (line,) = data["segments"]
    assert (line["avg_logprob"], line["no_speech_prob"]) == (-10.0, 1.0)
    assert [w["text"] for w in line["words"]] == ["Yeah."]
    assert data["language"] == "en"


def test_a_cache_with_nan_in_it_still_loads_with_low_scores(tmp_path):
    media = tmp_path / "b.wav"
    media.write_bytes(b"RIFF")
    stat = media.stat()
    head = f'{{"video_size": {stat.st_size}, "video_mtime": {int(stat.st_mtime)}, '
    body = '"segments": [{"start": 1, "end": 2, "text": "Hi", "avg_logprob": NaN, "no_speech_prob": 0.1}]}'
    (tmp_path / "b.wav.ivt-cache.json").write_text(head + body)
    (line,) = pipeline.segments_from_cache(pipeline.load_cache(str(media)))
    assert line.avg_logprob == -10.0 and pipeline.is_low_confidence(line)


# --------------------------------------------------------------------------- Whisper's second look


@pytest.mark.parametrize(
    ("text", "loop"),
    [
        ("Ja tähän tähän tähän tähän tähän tähän tähän tähän tähän tähän tähän tähän", True),
        ("We're all " + "tähän " * 30, True),
        ("No. No. No. No. No.", True),
        ("No, no, no, no, don't.", False),
        ("I'm grateful for my advisor, Mr. Devaney.", False),
        ("Yeah.", False),
        ("I'm grateful for my friends and for my friends' families.", False),
    ],
)
def test_loops_are_told_from_lines(text, loop):
    assert alignment.is_repetitive(text) is loop


def _speech():
    import numpy as np

    from tests.transcribe.test_alignment import levels, vad

    sound = [(1.0, 2.0), (3.0, 3.5), (5.0, 6.0)]
    return alignment.SpeechMap.from_arrays(levels(10.0, sound), vad(10.0, sound)), np


def _line(start, end, text, logprob=-0.3):
    words = text.split()
    step = (end - start) / len(words)
    return {
        "start": start,
        "end": end,
        "text": text,
        "avg_logprob": logprob,
        "no_speech_prob": 0.1,
        "words": [
            {"start": start + i * step, "end": start + (i + 1) * step, "text": w} for i, w in enumerate(words)
        ],
    }


def test_recovered_loops_and_unscored_lines_are_left_out():
    speech, _ = _speech()

    def again(clips, language):
        assert language == "en"
        return [
            _line(3.0, 3.5, "tähän tähän tähän tähän tähän tähän"),
            _line(5.0, 5.5, "Duke", logprob=math.nan),
            _line(5.5, 6.0, "Ice cream machine."),
        ]

    out = alignment.align([_line(1.0, 2.0, "Hello there.")], speech, again, "en")
    assert [s["text"] for s in out] == ["Hello there.", "Ice cream machine."]


def test_a_recovered_line_whisper_was_unsure_of_is_left_out():
    speech, _ = _speech()
    out = alignment.align(
        [_line(1.0, 2.0, "Hello there.")],
        speech,
        lambda clips, language: [_line(3.0, 3.5, "maybe this", logprob=-1.6)],
        "en",
    )
    assert [s["text"] for s in out] == ["Hello there."]


def test_nothing_is_recovered_when_the_language_cant_be_found():
    speech, _ = _speech()
    calls = []

    def backend(audio, clips, language):
        calls.append((clips, language))
        return []  # detection finds nothing

    raw = [_line(1.0, 2.0, "Hello there.")]
    original = alignment.build_speech_map
    try:
        alignment.build_speech_map = lambda *a, **k: speech
        out = pipeline.align_raw("/nowhere.flac", raw, backend)
    finally:
        alignment.build_speech_map = original
    # One detection try on the only line long enough; no recovery call.
    assert calls == [([(1.0, 2.0)], None)]
    assert [s["text"] for s in out] == ["Hello there."]


def test_the_language_is_detected_from_the_surest_line_and_recovery_is_held_to_it():
    speech, _ = _speech()
    calls = []

    def backend(audio, clips, language):
        calls.append((clips, language))
        if language is None:
            return [{"language": "en", "text": "x", "start": 0, "end": 1}]
        return [_line(5.0, 6.0, "Con Law.")]

    raw = [_line(1.0, 2.0, "Hello there.", logprob=-0.9), _line(3.0, 3.5, "Duke.", logprob=-0.1)]
    original = alignment.build_speech_map
    try:
        alignment.build_speech_map = lambda *a, **k: speech
        out = pipeline.align_raw("/nowhere.flac", raw, backend)
    finally:
        alignment.build_speech_map = original
    # "Duke." is surer but under a second: "Hello there." is the sample.
    assert calls[0] == ([(1.0, 2.0)], None)
    assert calls[1][1] == "en"
    assert [s["text"] for s in out] == ["Hello there.", "Duke.", "Con Law."]


def test_interval_overlap_matches_counting_by_hand():
    rng = random.Random(7)
    spans = []
    for _ in range(300):
        a = rng.uniform(0, 1000)
        spans.append((a, a + rng.uniform(0.05, 5)))
    intervals = alignment._Intervals(spans)
    for _ in range(300):
        a = rng.uniform(-5, 1005)
        b = a + rng.uniform(0, 60)
        # By hand: sample the union at fine steps.
        step = 0.01
        expected = sum(
            step for i in range(int((b - a) / step)) if any(s <= a + (i + 0.5) * step < e for s, e in spans)
        )
        assert intervals.overlap(a, b) == pytest.approx(expected, abs=0.05)
        t = rng.uniform(0, 1000)
        assert intervals.contains(t) == any(s <= t <= e for s, e in spans)
