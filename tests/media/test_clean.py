"""The media-clean command (vibecut_agent/media/clean.py, Phase 18c), on real ffmpeg output."""

from __future__ import annotations

import io
import json
import os
import shutil
import subprocess
from pathlib import Path

import pytest

from vibecut_agent.headless import COMMANDS
from vibecut_agent.media import clean
from vibecut_agent.protocol import Emitter, RequestError

needs_ffmpeg = pytest.mark.skipif(shutil.which("ffmpeg") is None, reason="needs ffmpeg")


@pytest.fixture
def noisy(tmp_path: Path) -> Path:
    """4 s of stereo: a 300 Hz tone under pink noise."""
    path = tmp_path / "interview.wav"
    subprocess.run(
        ["ffmpeg", "-v", "error", "-f", "lavfi", "-i", "sine=frequency=300:sample_rate=48000:duration=4",
         "-f", "lavfi", "-i", "anoisesrc=color=pink:amplitude=0.05:sample_rate=48000:duration=4",
         "-filter_complex", "[0][1]amix=inputs=2,pan=stereo|c0=c0|c1=c0", str(path)],
        check=True,
    )  # fmt: skip
    return path


def run(request: dict) -> tuple[int, list[dict]]:
    out = io.StringIO()
    code = clean.run(request, Emitter(out))
    return code, next(json.loads(line) for line in out.getvalue().splitlines() if '"result"' in line)["files"]


def probe(path: Path) -> dict:
    done = subprocess.run(
        [
            "ffprobe",
            "-v",
            "error",
            "-show_entries",
            "stream=sample_rate,channels:format=duration",
            "-of",
            "json",
            str(path),
        ],
        capture_output=True,
        check=True,
    )
    return json.loads(done.stdout)


def test_requests_are_checked():
    with pytest.raises(RequestError, match="1 to 16"):
        clean.run({"paths": []}, Emitter(io.StringIO()))
    with pytest.raises(RequestError, match="strength"):
        clean.run({"paths": ["/a.wav"], "strength": "max"}, Emitter(io.StringIO()))
    assert "media-clean" in COMMANDS
    assert clean.output_for("/m/Int A.mov", "light") == Path("/m/Int A.vca-clean-light.wav")


@needs_ffmpeg
def test_a_file_is_cleaned_beside_its_source_with_the_same_timing(noisy: Path):
    code, files = run({"paths": [str(noisy)], "strength": "medium"})
    assert code == 0
    out = Path(files[0]["output"])
    assert out == noisy.with_name("interview.vca-clean-medium.wav")
    assert files[0]["reused"] is False
    info = probe(out)
    assert info["streams"][0]["sample_rate"] == "48000"
    assert info["streams"][0]["channels"] == 2
    # The same length to the millisecond or so, so a clip's source points carry over.
    assert abs(float(info["format"]["duration"]) - 4.0) < 0.01
    assert not out.with_name(out.name + ".part").exists()


@needs_ffmpeg
def test_a_cleaned_file_is_reused_until_its_source_changes(noisy: Path):
    run({"paths": [str(noisy)], "strength": "light"})
    _, again = run({"paths": [str(noisy)], "strength": "light"})
    assert again[0]["reused"] is True
    later = Path(again[0]["output"]).stat().st_mtime + 5
    os.utime(noisy, (later, later))
    _, after = run({"paths": [str(noisy)], "strength": "light"})
    assert after[0]["reused"] is False


@needs_ffmpeg
def test_a_missing_file_is_reported_and_the_rest_cleaned(noisy: Path, tmp_path: Path):
    code, files = run({"paths": [str(tmp_path / "gone.wav"), str(noisy)], "strength": "strong"})
    assert code == 0
    assert "isn't there" in files[0]["error"]
    assert Path(files[1]["output"]).is_file()
