"""The media-beats command (vibecut_agent/media/beats.py, Phase 13d), on synthetic click tracks."""

from __future__ import annotations

import io
import json
import shutil
import wave
from pathlib import Path

import numpy as np
import pytest

from vibecut_agent.headless import COMMANDS
from vibecut_agent.media import beats
from vibecut_agent.peaks import SAMPLE_RATE
from vibecut_agent.protocol import Emitter, RequestError


def clicks(
    bpm: float, seconds: float, offset: float = 0.25, rate: int = SAMPLE_RATE
) -> tuple[np.ndarray, np.ndarray]:
    """A drum-like thump on every beat, with a little noise."""
    signal = np.zeros(int(seconds * rate))
    times = np.arange(offset, seconds, 60 / bpm)
    n = np.arange(400)
    thump = 0.6 * np.sin(2 * np.pi * 150 * n / rate) * np.exp(-n / 80)
    for t in times:
        i = int(t * rate)
        signal[i : i + 400] += thump[: len(signal) - i]
    signal += 0.02 * np.random.default_rng(1).standard_normal(len(signal))
    return (np.clip(signal, -1, 1) * 32767).astype("<i2"), times


@pytest.mark.parametrize("bpm", [90, 120, 128])
def test_the_tempo_and_beats_of_a_steady_pulse(bpm: int):
    samples, truth = clicks(bpm, 30)
    found = beats.beats_of(samples)
    assert found["bpm"] == pytest.approx(bpm, abs=1.0)
    assert found["confidence"] > 0.4
    got = np.array(found["beats"])
    errors = [np.min(np.abs(got - t)) for t in truth[2:-2]]
    assert max(errors) < 0.04
    assert len(got) == pytest.approx(len(truth), abs=2)


def test_fast_music_says_it_may_be_double_time():
    samples, _ = clicks(174, 30)
    found = beats.beats_of(samples)
    assert found["bpm"] == pytest.approx(87, abs=1.5) and found["maybeDoubleTime"] == pytest.approx(
        174, abs=3
    )


def test_noise_has_low_confidence():
    noise = (np.random.default_rng(2).standard_normal(SAMPLE_RATE * 20) * 3000).astype("<i2")
    assert beats.beats_of(noise)["confidence"] < 0.3


def test_requests_are_checked():
    with pytest.raises(RequestError, match="absolute"):
        beats.run({"path": "song.wav"}, Emitter(io.StringIO()))
    with pytest.raises(RequestError, match="end must be after"):
        beats.run({"path": "/song.wav", "start": 5, "end": 2}, Emitter(io.StringIO()))
    assert "media-beats" in COMMANDS


@pytest.mark.skipif(shutil.which("ffmpeg") is None, reason="needs ffmpeg")
def test_a_part_of_a_file_gives_file_times(tmp_path: Path):
    samples, truth = clicks(120, 30)
    path = tmp_path / "clicks.wav"
    with wave.open(str(path), "wb") as out:
        out.setnchannels(1)
        out.setsampwidth(2)
        out.setframerate(SAMPLE_RATE)
        out.writeframes(samples.tobytes())
    stream = io.StringIO()
    assert beats.run({"path": str(path), "start": 10, "end": 20}, Emitter(stream)) == 0
    result = next(json.loads(line) for line in stream.getvalue().splitlines() if '"result"' in line)
    assert result["bpm"] == pytest.approx(120, abs=1.0)
    assert all(10 <= b < 20 for b in result["beats"])
    inside = truth[(truth > 10.6) & (truth < 19.4)]
    assert max(np.min(np.abs(np.array(result["beats"]) - t)) for t in inside) < 0.04
