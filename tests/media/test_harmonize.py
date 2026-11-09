"""The media-harmonize command (vibecut_agent/media/harmonize.py; PLAN.md, "Harmonizer in the agent"), on
synthetic takes with known tempo drift. Ported from VibeCut's harmonizer tests (test_align.py and
test_headless.py), plus the streaming decode (ffmpeg_ops.decode_mono).

Each "performance" is a click track at irregular times (evenly spaced clicks would match themselves a
beat later, which is not what real music does). A take is the same performance started later and played
at a slightly different pace, so the right answer is known exactly: reference time r shows take time
offset + r * stretch, for as long as the stretch holds.
"""

from __future__ import annotations

import io
import itertools
import json
import shutil
import subprocess
import wave
from pathlib import Path
from typing import Any

import numpy as np
import pytest

from vibecut_agent.core import ffmpeg_ops
from vibecut_agent.headless import COMMANDS, dispatch
from vibecut_agent.media import harmonize
from vibecut_agent.protocol import Emitter

SR = harmonize.SR
needs_ffmpeg = pytest.mark.skipif(shutil.which("ffmpeg") is None, reason="needs ffmpeg")


def needs_librosa() -> None:
    pytest.importorskip("librosa", reason="needs the harmonize extra")
    pytest.importorskip("scipy", reason="needs the harmonize extra")


# One pitch per note of the performance, the same in every take (like a piece played again).
PITCHES = np.random.default_rng(11).choice([262, 294, 330, 349, 392, 440, 494, 523, 587, 659], size=200)


def click_track(times, duration, seed, pitches=None, hold=None):
    """Short plucked notes at `times`, note i at `pitches[i]` (PITCHES by default), over a little noise.
    `hold` is (start, end, pitch): a chord sustained over that span with no new note in it."""
    pitches = PITCHES if pitches is None else pitches
    rng = np.random.default_rng(seed)
    n = int(duration * SR)
    audio = np.zeros(n)
    t = np.arange(int(0.12 * SR)) / SR
    for i, time in enumerate(times):
        note = np.sin(2 * np.pi * pitches[i] * t) * np.exp(-t * 30)
        start = int(time * SR)
        end = min(n, start + len(note))
        if 0 <= start < n:
            audio[start:end] += note[: end - start]
    if hold is not None:
        a, b, pitch = int(hold[0] * SR), int(hold[1] * SR), hold[2]
        held = np.arange(b - a) / SR
        audio[a:b] += (
            0.3 * sum(np.sin(2 * np.pi * pitch * k * held) for k in (1, 1.25, 1.5)) * np.exp(-held * 0.3)
        )
    return audio + rng.normal(0, 0.002, n)


def write_wav(path: Path, audio: np.ndarray) -> str:
    """16 kHz mono 16-bit WAV (half scale, so notes that overlap don't clip)."""
    with wave.open(str(path), "wb") as out:
        out.setnchannels(1)
        out.setsampwidth(2)
        out.setframerate(SR)
        out.writeframes((np.clip(audio * 0.5, -1, 1) * 32767).astype("<i2").tobytes())
    return str(path)


def take_time_at(segments, ref_time):
    for seg in segments:
        if seg["ref_start"] <= ref_time <= seg["ref_end"]:
            span = seg["ref_end"] - seg["ref_start"]
            return seg["take_start"] + (ref_time - seg["ref_start"]) / span * (
                seg["take_end"] - seg["take_start"]
            )
    raise AssertionError(f"no segment covers {ref_time}")


@pytest.fixture(scope="module")
def performance():
    rng = np.random.default_rng(7)
    gaps = rng.uniform(0.25, 0.7, size=40)
    return np.cumsum(gaps) + 0.5  # irregular onsets over about 20 s


@pytest.fixture(scope="module")
def files(tmp_path_factory, performance):
    folder = tmp_path_factory.mktemp("harmonizer")
    duration = float(performance[-1]) + 2
    ref = write_wav(folder / "ref.wav", click_track(performance, duration, 1))
    steady = write_wav(folder / "steady.wav", click_track(0.4 + performance, duration + 1, 2))
    slow = write_wav(folder / "slow.wav", click_track(1.2 + performance * 1.03, duration * 1.03 + 2, 3))
    return {"ref": ref, "steady": steady, "slow": slow, "duration": duration}


# ---- The streaming decode ----


@needs_ffmpeg
def test_decode_mono_streams_float32_through_ffmpeg(files):
    audio = ffmpeg_ops.decode_mono(files["ref"], SR)
    assert audio.dtype == np.float32
    assert abs(audio.size / SR - files["duration"]) < 0.05
    assert 0 < float(np.abs(audio).max()) <= 1.0


@needs_ffmpeg
def test_decode_mono_refuses_a_file_over_its_limit_rather_than_cutting_it(files):
    with pytest.raises(ffmpeg_ops.FfmpegOpError, match="runs over"):
        ffmpeg_ops.decode_mono(files["ref"], SR, max_seconds=5.0)


@needs_ffmpeg
def test_load_mono_refuses_braw_unreadable_and_silent_files(tmp_path):
    braw = tmp_path / "take.braw"
    braw.write_bytes(b"x")
    with pytest.raises(harmonize.AlignError, match="Blackmagic RAW"):
        harmonize.load_mono(str(braw))
    junk = tmp_path / "junk.wav"
    junk.write_bytes(b"not audio")
    with pytest.raises(harmonize.AlignError, match="could not read"):
        harmonize.load_mono(str(junk))
    picture = tmp_path / "picture.mp4"
    subprocess.run(
        [
            "ffmpeg",
            "-v",
            "error",
            "-y",
            "-f",
            "lavfi",
            "-i",
            "testsrc=size=64x36:rate=10:duration=1",
            str(picture),
        ],
        check=True,
    )
    with pytest.raises(harmonize.AlignError, match="has no sound"):
        harmonize.load_mono(str(picture))


# ---- The alignment ----


@needs_ffmpeg
def test_harmonize_follows_each_take_to_the_reference(files, performance):
    needs_librosa()
    phases = []
    report = harmonize.harmonize(
        files["ref"], [files["steady"], files["slow"]], on_progress=lambda p, f, d: phases.append((p, f))
    )
    assert phases[0][0] == "read"
    assert phases[-1] == ("solve", 1.0)
    assert all(0 <= f <= 1 for _, f in phases)
    assert [f for _, f in phases] == sorted(f for _, f in phases)

    steady = report["segments"][files["steady"]]
    slow = report["segments"][files["slow"]]
    assert abs(report["coarse_offsets_sec"][files["steady"]] - 0.4) < 0.02
    assert abs(report["coarse_offsets_sec"][files["slow"]] - 1.2) < 0.2
    # Every onset of the performance lands on the matching moment of each take, within ~10 ms.
    for onset in performance[2:-2]:
        assert abs(take_time_at(steady, onset) - (0.4 + onset)) < 0.01
        assert abs(take_time_at(slow, onset) - (1.2 + onset * 1.03)) < 0.015
    # The steady take needs no speed change; its stretches merge into (nearly) one.
    assert len(steady) <= 3
    # Stretches run end to end in both times.
    for segs in (steady, slow):
        for a, b in itertools.pairwise(segs):
            assert a["ref_end"] == b["ref_start"] and a["take_end"] == b["take_start"]


@needs_ffmpeg
def test_a_same_recorder_take_is_placed_by_its_offset_at_exactly_normal_speed(files):
    needs_librosa()
    report = harmonize.harmonize(files["ref"], [files["steady"]], no_retime=frozenset({files["steady"]}))
    (only,) = report["segments"][files["steady"]]
    assert only["ref_start"] == 0.0
    assert abs(only["take_start"] - 0.4) < 0.02
    assert only["take_end"] - only["take_start"] == pytest.approx(only["ref_end"] - only["ref_start"])


@needs_ffmpeg
def test_harmonize_stops_when_cancelled(files):
    needs_librosa()
    calls = {"n": 0}

    def cancelled():
        calls["n"] += 1
        return calls["n"] > 2

    with pytest.raises(harmonize.Cancelled):
        harmonize.harmonize(files["ref"], [files["steady"]], is_cancelled=cancelled)


@needs_ffmpeg
def test_a_take_that_speeds_up_halfway_and_started_first(tmp_path, performance):
    """The take starts 0.6 s before the reference, plays the first half at the reference's pace and the
    second half 4% faster: the stretches follow the change."""
    needs_librosa()
    duration = float(performance[-1]) + 2
    ref = write_wav(tmp_path / "ref.wav", click_track(performance, duration, 1))
    middle = float(performance[len(performance) // 2])

    def true_take_time(r):
        return -0.6 + (r if r <= middle else middle + (r - middle) / 1.04)

    take = write_wav(
        tmp_path / "take.wav", click_track([true_take_time(r) for r in performance], duration, 4)
    )
    report = harmonize.harmonize(ref, [take])
    segments = report["segments"][take]
    assert abs(report["coarse_offsets_sec"][take] + 0.6) < 0.03
    # The reference before the take has anything is left out.
    assert segments[0]["ref_start"] > 0.5
    for onset in performance[3:-2]:
        assert abs(take_time_at(segments, onset) - true_take_time(onset)) < 0.015


@needs_ffmpeg
def test_a_take_that_rolls_on_past_the_reference_keeps_its_pace_to_the_end(files):
    needs_librosa()
    report = harmonize.harmonize(files["ref"], [files["steady"]])
    last = report["segments"][files["steady"]][-1]
    speed = (last["take_end"] - last["take_start"]) / (last["ref_end"] - last["ref_start"])
    assert abs(speed - 1.0) < 0.02
    assert abs(last["ref_end"] - report["ref_duration"]) < 0.01


@needs_ffmpeg
def test_the_references_own_performance_through_another_microphone_is_one_straight_stretch(
    tmp_path, performance
):
    """A camera that heard the very performance the reference recorded: same notes at the same moments,
    its own noise and tone, and a clock running 100 ppm fast. One stretch (offset plus that drift), and
    the report says it's the same recording."""
    needs_librosa()
    duration = float(performance[-1]) + 2
    ref = write_wav(tmp_path / "ref.wav", click_track(performance, duration, 1))
    heard = click_track(performance, duration, 5)
    heard = np.convolve(heard, [0.6, 0.3, 0.1])[: heard.size]  # a duller microphone
    drifted = np.interp(np.arange(0, heard.size, 1.0001), np.arange(heard.size), heard)
    take = write_wav(
        tmp_path / "cam.wav",
        np.concatenate([np.random.default_rng(6).normal(0, 0.002, int(0.7 * SR)), drifted]),
    )
    report = harmonize.harmonize(ref, [take])
    (only,) = report["segments"][take]
    assert report["same_performance"][take] is True
    speed = (only["take_end"] - only["take_start"]) / (only["ref_end"] - only["ref_start"])
    assert speed == pytest.approx(1 / 1.0001, abs=2e-4)
    for onset in performance[2:-2]:
        assert abs(take_time_at([only], onset) - (0.7 + onset / 1.0001)) < 0.005


@needs_ffmpeg
def test_a_different_performance_after_a_long_pre_roll_is_found_and_followed(tmp_path, performance):
    """A separate run-through (every note up to 40 ms early or late, and 5% slower from the middle on) by a
    camera that rolled 8 s before the music."""
    needs_librosa()
    duration = float(performance[-1]) + 2
    ref = write_wav(tmp_path / "ref.wav", click_track(performance, duration, 1))
    jitter = np.random.default_rng(8).uniform(-0.04, 0.04, performance.size)
    middle = float(performance[len(performance) // 2])

    def pace(r):
        return 8.0 + (r if r <= middle else middle + (r - middle) * 1.05)

    played = np.array([pace(r) for r in performance]) + jitter
    take = write_wav(tmp_path / "run2.wav", click_track(played, pace(duration) + 1, 9))
    report = harmonize.harmonize(ref, [take])
    segments = report["segments"][take]
    assert report["same_performance"][take] is False
    assert abs(report["coarse_offsets_sec"][take] - 8.0) < 0.1
    errors = [
        abs(take_time_at(segments, r) - t) for r, t in zip(performance[3:-3], played[3:-3], strict=True)
    ]
    assert np.median(errors) < 0.02
    assert max(errors) < 0.06


@needs_ffmpeg
def test_note_pairing_puts_a_different_performances_notes_on_the_references(tmp_path, performance):
    needs_librosa()
    duration = float(performance[-1]) + 2
    ref = write_wav(tmp_path / "ref.wav", click_track(performance, duration, 1))
    jitter = np.random.default_rng(12).uniform(-0.04, 0.04, performance.size)
    middle = float(performance[len(performance) // 2])
    played = (
        np.array([0.5 + (r if r <= middle else middle + (r - middle) * 1.05) for r in performance]) + jitter
    )
    take = write_wav(tmp_path / "run3.wav", click_track(played, played[-1] + 2, 13))
    report = harmonize.harmonize(ref, [take], {"fit": "notes"})
    segments = report["segments"][take]
    errors = [
        abs(take_time_at(segments, r) - t) for r, t in zip(performance[2:-2], played[2:-2], strict=True)
    ]
    assert np.median(errors) < 0.01
    assert max(errors) < 0.025
    # Confidence is the share of the reference's notes that found a partner.
    assert report["coarse_offset_confidence"][take] > 80


@needs_ffmpeg
def test_a_dropped_note_and_an_extra_one_are_skipped_without_shifting_the_rest(tmp_path, performance):
    needs_librosa()
    duration = float(performance[-1]) + 2
    ref = write_wav(tmp_path / "ref.wav", click_track(performance, duration, 1))
    keep = np.ones(performance.size, dtype=bool)
    keep[[12, 25]] = False
    extra_times = [float(performance[18] + performance[19]) / 2, float(performance[30] + performance[31]) / 2]
    times = np.concatenate([performance[keep] * 1.02 + 0.3, np.array(extra_times) * 1.02 + 0.3])
    pitches = np.concatenate([PITCHES[: performance.size][keep], [1175, 1319]])
    order = np.argsort(times)
    take = write_wav(
        tmp_path / "gaps.wav", click_track(times[order], duration * 1.02 + 2, 14, pitches=pitches[order])
    )
    report = harmonize.harmonize(ref, [take])
    segments = report["segments"][take]
    for i, onset in enumerate(performance[2:-2], start=2):
        if keep[i]:
            assert abs(take_time_at(segments, onset) - (0.3 + onset * 1.02)) < 0.015


@needs_ffmpeg
def test_a_chord_held_longer_with_no_new_notes_is_bridged_by_the_notes_either_side(tmp_path, performance):
    needs_librosa()
    split = len(performance) // 2
    gap = 3.0
    ref_notes = np.concatenate([performance[:split], performance[split:] + gap])
    hold_start = float(performance[split - 1]) + 0.15
    hold_end = float(performance[split]) + gap - 0.1
    take_notes = np.concatenate([performance[:split], performance[split:] + gap + 0.8])
    duration = float(ref_notes[-1]) + 2
    ref = write_wav(
        tmp_path / "ref.wav", click_track(ref_notes, duration, 1, hold=(hold_start, hold_end, 196))
    )
    take = write_wav(
        tmp_path / "held.wav",
        click_track(take_notes, duration + 1, 15, hold=(hold_start, hold_end + 0.8, 196)),
    )
    report = harmonize.harmonize(ref, [take], {"fit": "notes"})
    segments = report["segments"][take]
    for r, t in zip(ref_notes[2:-2], take_notes[2:-2], strict=True):
        assert abs(take_time_at(segments, r) - t) < 0.015


@needs_ffmpeg
def test_the_smooth_fit_follows_a_different_performances_tempo_without_lurching(tmp_path, performance):
    """The default fit: every note up to 40 ms early or late (a separate run-through), 5% slower from the
    middle on. The notes fit chases each note (its speeds swing); the smooth one follows the tempo, stays
    near the take's pace with no sudden speed change, and still puts the notes within a frame."""
    needs_librosa()
    duration = float(performance[-1]) + 2
    ref = write_wav(tmp_path / "ref.wav", click_track(performance, duration, 1))
    jitter = np.random.default_rng(12).uniform(-0.04, 0.04, performance.size)
    middle = float(performance[len(performance) // 2])
    played = (
        np.array([0.5 + (r if r <= middle else middle + (r - middle) * 1.05) for r in performance]) + jitter
    )
    take = write_wav(tmp_path / "run3.wav", click_track(played, played[-1] + 2, 13))

    def speeds(report):
        return [
            (s["take_end"] - s["take_start"]) / (s["ref_end"] - s["ref_start"])
            for s in report["segments"][take]
        ]

    smooth = harmonize.harmonize(ref, [take])
    notes = harmonize.harmonize(ref, [take], {"fit": "notes"})
    assert smooth["fit"] == "smooth"
    assert min(speeds(smooth)) >= 0.8 and max(speeds(smooth)) <= 1.25
    assert max(abs(b - a) for a, b in itertools.pairwise(speeds(smooth))) < 0.1
    assert max(speeds(notes)) - min(speeds(notes)) > max(speeds(smooth)) - min(speeds(smooth))
    segments = smooth["segments"][take]
    errors = [
        abs(take_time_at(segments, r) - t) for r, t in zip(performance[2:-2], played[2:-2], strict=True)
    ]
    assert np.median(errors) < 0.03
    assert max(errors) < 0.08
    # Most of the piece is in sync within a frame; the median miss is reported.
    covered = sum(b - a for a, b in smooth["in_sync"][take])
    assert covered > 0.8 * (performance[-1] - performance[0])
    assert smooth["sync_error"][take] < 0.03


@needs_ffmpeg
def test_the_references_own_recording_is_in_sync_throughout(files):
    needs_librosa()
    report = harmonize.harmonize(files["ref"], [files["steady"]], no_retime=frozenset({files["steady"]}))
    (only,) = report["segments"][files["steady"]]
    assert report["in_sync"][files["steady"]] == [(only["ref_start"], only["ref_end"])]


def test_in_sync_ranges_split_where_the_take_drifts_and_forgive_one_wrong_pair():
    refs = np.arange(0.0, 30.0, 0.5)
    path = [(0.0, 0.0), (30.0, 30.0)]
    takes = refs.copy()
    takes[(refs >= 12) & (refs < 18)] += 0.1  # 6 s where the take is 100 ms off
    takes[10] += 0.2  # one wrong pair at 5 s
    ranges, median = harmonize.in_sync_ranges(list(zip(refs, takes, strict=True)), path, 0.042)
    assert ranges == [(0.0, 11.5), (18.0, 29.5)]
    assert median == 0.0
    # Too short to cut to, or nothing to go on: no range.
    assert harmonize.in_sync_ranges([(0.0, 0.0), (1.0, 1.0)], path)[0] == []
    assert harmonize.in_sync_ranges([(0.0, 0.0)], path) == ([], 0.0)


def test_smooth_path_keeps_speeds_bounded_and_ignores_a_wrong_pair():
    refs = np.arange(0.0, 20.0, 0.4)
    takes = 1.0 + refs * 1.02
    takes[25] += 0.5  # a wrong pair
    curve = np.array(harmonize.smooth_path(list(zip(refs, takes, strict=True))))
    speeds = np.diff(curve[:, 1]) / np.diff(curve[:, 0])
    assert np.all((speeds >= 0.8 * 1.02 - 1e-9) & (speeds <= 1.25 * 1.02 + 1e-9))
    assert np.max(np.abs(np.interp(refs, curve[:, 0], curve[:, 1]) - (1.0 + refs * 1.02))) < 0.03
    assert harmonize.smooth_path([(0.0, 1.0), (0.5, 1.5)]) == [(0.0, 1.0), (0.5, 1.5)]


def test_remove_stutters_drops_a_brief_slow_then_fast_pair_but_keeps_a_real_hold():
    wobble = [(0.0, 0.0), (10.0, 10.0), (10.1, 10.02), (10.2, 10.2), (20.0, 20.0)]
    smoothed = harmonize.remove_stutters(wobble)
    speeds = [(b[1] - a[1]) / (b[0] - a[0]) for a, b in itertools.pairwise(smoothed)]
    assert all(0.5 <= v <= 2.0 for v in speeds)
    refs, takes = zip(*smoothed, strict=True)
    assert all(abs(np.interp(r, refs, takes) - t) < 0.1 for r, t in wobble)
    hold = [(0.0, 0.0), (10.0, 10.0), (12.0, 10.4), (20.0, 18.4)]
    assert harmonize.remove_stutters(hold) == hold


def test_simplify_path_keeps_corners_and_drops_jitter():
    rng = np.random.default_rng(3)
    refs = np.arange(0, 20, 0.5)
    takes = np.where(refs < 10, refs, 10 + (refs - 10) * 1.1) + rng.uniform(-0.005, 0.005, refs.size)
    simplified = harmonize.simplify_path(list(zip(refs, takes, strict=True)))
    assert len(simplified) <= 4
    assert any(abs(r - 10) <= 0.5 for r, _ in simplified[1:-1])


# ---- The command ----


class Capture:
    def __init__(self) -> None:
        self.buffer = io.StringIO()
        self.emitter = Emitter(self.buffer)

    def of_type(self, event_type: str) -> list[dict[str, Any]]:
        events = [json.loads(line) for line in self.buffer.getvalue().splitlines()]
        return [e for e in events if e["type"] == event_type]


def run_command(request: dict[str, Any]) -> tuple[int, Capture]:
    capture = Capture()
    code = dispatch("media-harmonize", capture.emitter, io.StringIO(json.dumps(request)))
    return code, capture


@pytest.fixture
def media(tmp_path):
    paths = {}
    for name in ("ref.wav", "a.mov", "b.mov"):
        path = tmp_path / name
        path.write_bytes(b"x")
        paths[name] = str(path)
    return paths


@pytest.mark.parametrize(
    "mutate, message",
    [
        (lambda r, m: r.pop("referencePath"), "reference recording"),
        (lambda r, m: r.update(takePaths=[]), "at least one take"),
        (lambda r, m: r.update(takePaths=[m["a.mov"], m["a.mov"]]), "listed twice"),
        (lambda r, m: r.update(takePaths=[m["ref.wav"]]), "can't also be a take"),
        (lambda r, m: r.update(takePaths=["relative.mov"]), "absolute"),
        (lambda r, m: r.update(takePaths=[m["a.mov"] + ".missing"]), "File not found"),
        (lambda r, m: r.update(noRetime=[m["b.mov"]]), "noRetime"),
        (lambda r, m: r.update(flagSpeedMax=100), "flagSpeedMax"),
        (lambda r, m: r.update(fit="wobbly"), "fit must be"),
        (lambda r, m: r.update(syncTolerance=2), "syncTolerance"),
        (lambda r, m: r.update(takePaths=[f"/t{i}.mov" for i in range(17)]), "At most 16"),
    ],
)
def test_bad_requests_are_refused(media, mutate, message):
    request = {"referencePath": media["ref.wav"], "takePaths": [media["a.mov"]]}
    mutate(request, media)
    code, capture = run_command(request)
    assert code == 2
    assert message in capture.of_type("error")[0]["message"]
    assert capture.of_type("done")


def test_reports_the_takes_in_the_apps_shape(monkeypatch, media):
    needs_librosa()

    def fake_harmonize(ref, takes, options, no_retime, on_progress):
        on_progress("solve", 1.0, "Done")
        assert options == {"flag_speed_max": 1.5, "fit": "smooth", "stiffness": 8.0, "sync_tolerance": 0.04}
        assert no_retime == frozenset({media["b.mov"]})
        segs = [
            {
                "ref_start": 0.0,
                "ref_end": 4.0,
                "take_start": 1.0,
                "take_end": 5.2,
                "speed_factor": 0.95,
                "flagged": False,
            }
        ]
        return {
            "reference": ref,
            "takes": takes,
            "ref_duration": 4.0,
            "take_durations": dict.fromkeys(takes, 6.0),
            "coarse_offsets_sec": dict.fromkeys(takes, 1.0),
            "coarse_offset_confidence": dict.fromkeys(takes, 50.0),
            "anchor_count": 9,
            "segments": dict.fromkeys(takes, segs),
            "skipped_anchors": dict.fromkeys(takes, 0),
            "excluded_leadin_ref_sec": dict.fromkeys(takes, 0.0),
            "same_performance": {takes[0]: False, takes[1]: True},
            "in_sync": {takes[0]: [(0.5, 3.5), (3.6, 3.6)], takes[1]: [(0.0, 4.0)]},
            "sync_error": {takes[0]: 0.0123, takes[1]: 0.0},
        }

    monkeypatch.setattr(harmonize, "harmonize", fake_harmonize)
    request = {
        "referencePath": media["ref.wav"],
        "takePaths": [media["a.mov"], media["b.mov"]],
        "noRetime": [media["b.mov"]],
        "flagSpeedMax": 1.5,
        "fit": "smooth",
        "stiffness": 8,
        "syncTolerance": 0.04,
    }
    code, capture = run_command(request)
    assert code == 0
    (result,) = capture.of_type("result")
    assert result["cancelled"] is False
    assert result["anchorCount"] == 9
    first, second = result["takes"]
    assert first["path"] == media["a.mov"]
    assert first["segments"] == [
        {"refStart": 0.0, "refEnd": 4.0, "takeStart": 1.0, "takeEnd": 5.2, "flagged": False}
    ]
    assert first["flaggedCount"] == 0
    assert (first["sameRecording"], second["sameRecording"]) == (False, True)
    # A range of no length is dropped.
    assert first["inSync"] == [{"refStart": 0.5, "refEnd": 3.5}]
    assert (first["syncErrorMs"], second["syncErrorMs"]) == (12.3, 0.0)
    assert capture.of_type("progress")[0]["fraction"] == 1.0
    assert "media-harmonize" in COMMANDS


def test_stretches_of_no_length_or_with_nan_times_are_left_out_so_the_result_still_sends():
    """A file that isn't the piece can come out with a NaN pace; the protocol refuses NaN (allow_nan=False),
    which would lose the whole result."""
    nan = float("nan")
    segs = [
        {"ref_start": 0.0, "ref_end": 5.0, "take_start": 1.0, "take_end": 6.0, "flagged": False},
        {"ref_start": 5.0, "ref_end": 5.0, "take_start": 6.0, "take_end": 9.0, "flagged": True},
        {"ref_start": 5.0, "ref_end": 8.0, "take_start": nan, "take_end": 9.0, "flagged": False},
    ]
    report = {
        "reference": "/r.wav",
        "takes": ["/a.mov"],
        "ref_duration": 8.0,
        "take_durations": {"/a.mov": 10.0},
        "coarse_offsets_sec": {"/a.mov": nan},
        "coarse_offset_confidence": {"/a.mov": 0.0},
        "anchor_count": 3,
        "segments": {"/a.mov": segs},
        "skipped_anchors": {"/a.mov": 3},
        "excluded_leadin_ref_sec": {"/a.mov": 0.0},
    }
    result = harmonize.to_result(report)
    assert result["takes"][0]["segments"] == [
        {"refStart": 0.0, "refEnd": 5.0, "takeStart": 1.0, "takeEnd": 6.0, "flagged": False}
    ]
    assert result["takes"][0]["offset"] == 0.0
    json.dumps(result, allow_nan=False)


@needs_ffmpeg
def test_an_unreadable_file_is_an_error_not_a_crash(media):
    needs_librosa()
    code, capture = run_command({"referencePath": media["ref.wav"], "takePaths": [media["a.mov"]]})
    assert code == 1
    assert "could not read its sound" in capture.of_type("error")[0]["message"]
    assert capture.of_type("done")
