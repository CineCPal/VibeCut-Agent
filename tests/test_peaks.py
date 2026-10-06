"""The audio-peaks command (vibecut_agent/peaks.py)."""

import io
import json
import subprocess
import sys

import numpy as np
import pytest

from vibecut_agent import peaks
from vibecut_agent.protocol import Emitter


def test_bins_are_the_min_and_max_of_each_stretch_scaled_to_full_scale():
    samples = np.array([0, 16384, -16384, 0] * 2000 + [0] * 4000, dtype="<i2")  # 1 s loud, 0.5 s silent
    out = peaks.peaks_of_samples(samples, 2)
    assert out["peaksPerSecond"] == 2
    assert out["maxes"] == [0.5, 0.5, 0.0] and out["mins"] == [-0.5, -0.5, 0.0]


def run(request):
    buffer = io.StringIO()
    code = peaks.main(io.StringIO(json.dumps(request)), Emitter(buffer))
    return code, [json.loads(line) for line in buffer.getvalue().splitlines()]


def test_a_real_file_is_measured_and_a_missing_one_is_reported(tmp_path):
    clip = tmp_path / "tone.wav"
    made = subprocess.run(
        [
            "ffmpeg",
            "-v",
            "error",
            "-y",
            "-f",
            "lavfi",
            "-i",
            "sine=f=440:d=1",
            "-f",
            "lavfi",
            "-i",
            "anullsrc=d=1",
            "-filter_complex",
            "[0][1]concat=n=2:v=0:a=1",
            str(clip),
        ],
        capture_output=True,
        check=False,
    )
    if made.returncode != 0:
        pytest.skip("ffmpeg isn't available")
    code, events = run({"paths": [str(clip), str(tmp_path / "gone.wav")], "peaksPerSecond": 10})
    result = next(e for e in events if e["type"] == "result")
    assert code == 0 and events[-1]["type"] == "done"
    levels = result["peaks"][str(clip)]
    assert len(levels["maxes"]) == 20
    # ffmpeg's sine source plays at 1/8 of full scale.
    assert max(levels["maxes"][:9]) == pytest.approx(0.125, abs=0.01) and max(levels["maxes"][11:]) < 0.01
    assert result["failed"][0]["path"].endswith("gone.wav")


def test_bad_requests_are_refused():
    assert run({"paths": []})[0] == 2
    assert run({"paths": ["relative.wav"]})[0] == 2
    assert run({"paths": ["/a.wav"], "peaksPerSecond": 0})[0] == 2


def test_it_is_a_sidecar_command():
    from vibecut_agent.headless import COMMANDS

    assert "audio-peaks" in COMMANDS and "transcribe" in COMMANDS
    assert sys.modules["vibecut_agent.peaks"] is peaks
