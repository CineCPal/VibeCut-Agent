"""The media-loudness command (vibecut_agent/media/loudness.py, Phase 13d), on real ffmpeg output."""

from __future__ import annotations

import io
import json
import shutil
import subprocess
from pathlib import Path

import pytest

from vibecut_agent.headless import COMMANDS
from vibecut_agent.media import loudness
from vibecut_agent.protocol import Emitter, RequestError

needs_ffmpeg = pytest.mark.skipif(shutil.which("ffmpeg") is None, reason="needs ffmpeg")


@pytest.fixture(scope="module")
def tone(tmp_path_factory: pytest.TempPathFactory) -> Path:
    """10 s of a 1 kHz tone, mono: 5 s at -20 dBFS then 5 s of silence."""
    path = tmp_path_factory.mktemp("loud") / "tone.wav"
    subprocess.run(
        ["ffmpeg", "-v", "error", "-f", "lavfi", "-i", "sine=frequency=1000:sample_rate=48000:duration=5",
         "-f", "lavfi", "-i", "anullsrc=r=48000:cl=mono:d=5",
         "-filter_complex", "[0]volume=0.8[a];[a][1]concat=n=2:v=0:a=1", str(path)],
        check=True,
    )  # fmt: skip
    return path


def run(request: dict) -> tuple[int, list[dict]]:
    out = io.StringIO()
    code = loudness.run(request, Emitter(out))
    return code, next(json.loads(line) for line in out.getvalue().splitlines() if '"result"' in line)[
        "levels"
    ]


def test_requests_are_checked():
    with pytest.raises(RequestError, match="1 to 32"):
        loudness.run({"ranges": []}, Emitter(io.StringIO()))
    with pytest.raises(RequestError, match="end after"):
        loudness.run({"ranges": [{"path": "/a.wav", "start": 3, "end": 2}]}, Emitter(io.StringIO()))
    assert "media-loudness" in COMMANDS


def test_the_summary_is_parsed():
    stderr = (
        "[Parsed_ebur128_0 @ 0x1] t: 0.1 TARGET:-23 LUFS M: -30.0 S:-120.7 I: -70.0 LUFS\n"
        "[Parsed_ebur128_0 @ 0x1] t: 3.0 TARGET:-23 LUFS M: -18.0 S: -19.5 I: -19.0 LUFS\n"
        "Summary:\n  Integrated loudness:\n    I:         -19.2 LUFS\n    Threshold: -29.2 LUFS\n"
        "  Loudness range:\n    LRA:         2.1 LU\n    Threshold: -39.0 LUFS\n"
        "  True peak:\n    Peak:       -3.4 dBFS\n"
    )
    assert loudness.parse(stderr) == {
        "integratedLufs": -19.2,
        "loudnessRange": 2.1,
        "truePeakDb": -3.4,
        "maxShortTermLufs": -19.5,
    }
    silent = stderr.replace("-19.2 LUFS", "-70.0 LUFS")
    assert loudness.parse(silent)["integratedLufs"] is None


@needs_ffmpeg
def test_a_tone_measures_as_r128_says_and_silence_has_no_loudness(tone: Path, tmp_path: Path):
    code, levels = run({"ranges": [
        {"path": str(tone), "start": 0, "end": 5},
        {"path": str(tone), "start": 6},
        {"path": str(tmp_path / "gone.wav")},
    ]})  # fmt: skip
    assert code == 0
    tone_part, silence, gone = levels
    # A full-scale 1 kHz sine reads -3.0 LUFS mono; at 0.8 of the sine source's 1/8 amplitude it is
    # 20*log10(0.1) = -20 dB lower, so about -23.0, and its peak about -20 dBFS.
    assert tone_part["integratedLufs"] == pytest.approx(-23.0, abs=0.5)
    assert tone_part["truePeakDb"] == pytest.approx(-20.0, abs=0.5)
    assert silence["integratedLufs"] is None
    assert "isn't there" in gone["error"]
