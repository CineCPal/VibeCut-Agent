"""The media-info command (vibecut_agent/media/info.py, Phase 13a)."""

from __future__ import annotations

import io
import json
import shutil
import subprocess
from pathlib import Path

import pytest

from vibecut_agent.headless import COMMANDS
from vibecut_agent.media import info
from vibecut_agent.protocol import Emitter, RequestError


def test_facts_from_a_probe():
    probe = {
        "format": {"duration": "12.5"},
        "streams": [
            {"codec_type": "video", "codec_name": "mjpeg", "disposition": {"attached_pic": 1}},
            {
                "codec_type": "video",
                "codec_name": "h264",
                "width": 3840,
                "height": 2160,
                "avg_frame_rate": "24000/1001",
            },
            {"codec_type": "audio", "codec_name": "aac", "channels": 2, "sample_rate": "48000"},
        ],
    }
    assert info.facts(probe) == {
        "duration": 12.5,
        "video": {"codec": "h264", "width": 3840, "height": 2160, "fps": 23.976},
        "audio": {"codec": "aac", "channels": 2, "sampleRate": 48000},
    }


def test_sound_only_and_unreadable_rates():
    probe = {"format": {}, "streams": [{"codec_type": "audio", "codec_name": "pcm_s24le", "channels": 1}]}
    assert info.facts(probe) == {
        "duration": None,
        "video": None,
        "audio": {"codec": "pcm_s24le", "channels": 1, "sampleRate": None},
    }
    assert info._rate("0/0") is None and info._rate("25") == 25.0


def test_requests_are_checked():
    emitter = Emitter(io.StringIO())
    with pytest.raises(RequestError):
        info.run({"paths": []}, emitter)
    with pytest.raises(RequestError):
        info.run({"paths": ["relative.mov"]}, emitter)
    assert "media-info" in COMMANDS


@pytest.mark.skipif(shutil.which("ffmpeg") is None, reason="needs ffmpeg")
def test_a_real_file_and_a_missing_one(tmp_path: Path):
    clip = tmp_path / "test.mov"
    subprocess.run(
        ["ffmpeg", "-v", "error", "-f", "lavfi", "-i", "testsrc=size=320x240:rate=25:duration=1",
         "-f", "lavfi", "-i", "sine=frequency=440:duration=1", "-shortest", "-c:v", "mjpeg", "-c:a", "pcm_s16le", str(clip)],
        check=True,
    )  # fmt: skip
    out = io.StringIO()
    code = info.run({"paths": [str(clip), str(tmp_path / "gone.mov")]}, Emitter(out))
    result = next(json.loads(line) for line in out.getvalue().splitlines() if '"result"' in line)
    assert code == 0
    facts = result["info"][str(clip)]
    assert facts["video"] == {"codec": "mjpeg", "width": 320, "height": 240, "fps": 25.0}
    assert facts["audio"]["channels"] == 1
    assert result["failed"][0]["path"].endswith("gone.mov")
