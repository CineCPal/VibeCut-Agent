"""The media-thumbs command (vibecut_agent/media/thumbs.py, Phase 20d), on video and stills made by ffmpeg."""

from __future__ import annotations

import io
import json
import shutil
import subprocess
from pathlib import Path

import pytest
from PIL import Image

from vibecut_agent.headless import COMMANDS
from vibecut_agent.media import thumbs
from vibecut_agent.protocol import Emitter, RequestError

pytestmark = pytest.mark.skipif(shutil.which("ffmpeg") is None, reason="needs ffmpeg")


def make(path: Path) -> Path:
    """4 s: a sharp test pattern (0-1 s), the same blurred (1-2 s), black (2-3 s), the pattern (3-4 s)."""
    sharp = "testsrc2=s=640x360:r=25:d=1"
    graph = (
        f"{sharp}[a];{sharp},boxblur=12:2[b];color=c=black:s=640x360:r=25:d=1[c];{sharp}[d];"
        "[a][b][c][d]concat=n=4:v=1:a=0,format=yuv420p[out]"
    )
    subprocess.run(
        ["ffmpeg", "-v", "error", "-y", "-filter_complex", graph, "-map", "[out]",
         "-c:v", "libx264", "-preset", "ultrafast", "-crf", "10", str(path)],
        check=True,
    )  # fmt: skip
    return path


def run(request: dict) -> tuple[int, list[dict]]:
    stream = io.StringIO()
    code = thumbs.run(request, Emitter(stream))
    return code, [json.loads(line) for line in stream.getvalue().splitlines()]


def test_frames_are_scored_sharp_over_blurred_and_black_is_dark(tmp_path):
    video = str(make(tmp_path / "v.mp4"))
    code, events = run({"frames": [{"path": video, "time": t} for t in (0.5, 1.5, 2.5)]})
    assert code == 0
    sharp, blurred, black = next(e for e in events if e["type"] == "result")["frames"]
    assert sharp["ok"] and sharp["sharpness"] > blurred["sharpness"] + 20
    assert sharp["score"] > blurred["score"] and sharp["colour"] > 30
    assert black["dark"] and black["score"] == 0
    # A file that isn't there is reported for its frame; the others are scored.
    code, events = run(
        {"frames": [{"path": video, "time": 0.5}, {"path": str(tmp_path / "gone.mp4"), "time": 1}]}
    )
    frames = next(e for e in events if e["type"] == "result")["frames"]
    assert code == 0 and frames[0]["ok"] and not frames[1]["ok"] and "isn't there" in frames[1]["message"]


def test_requests_are_checked(tmp_path):
    with pytest.raises(RequestError, match="frames must list 1 to 60"):
        thumbs.run({"frames": []}, Emitter(io.StringIO()))
    with pytest.raises(RequestError, match="frames\\[0\\].time"):
        thumbs.run({"frames": [{"path": str(tmp_path / "a.mp4"), "time": -1}]}, Emitter(io.StringIO()))
    with pytest.raises(RequestError):
        thumbs.run({"frames": [{"path": "relative.mp4", "time": 1}]}, Emitter(io.StringIO()))
    with pytest.raises(RequestError, match="youtube must list"):
        thumbs.run({"youtube": []}, Emitter(io.StringIO()))


def test_stills_become_youtube_jpegs_under_2mb(tmp_path):
    # A 4K still of noise (hard to compress) and a square one (cropped to 16:9).
    wide = tmp_path / "wide.png"
    subprocess.run(
        ["ffmpeg", "-v", "error", "-y", "-f", "lavfi", "-i", "nullsrc=s=3840x2160,geq=random(1)*255:128:128",
         "-frames:v", "1", str(wide)],
        check=True,
    )  # fmt: skip
    square = tmp_path / "square.png"
    Image.new("RGB", (1000, 1000), (200, 40, 40)).save(square)
    code, events = run({"youtube": [str(wide), str(square)]})
    assert code == 0
    big, small = next(e for e in events if e["type"] == "result")["jpegs"]
    assert (big["width"], big["height"]) == (1280, 720) and big["bytes"] <= thumbs.YOUTUBE_MAX_BYTES
    assert big["path"] == str(tmp_path / "wide YouTube.jpg")
    assert (small["width"], small["height"]) == (1000, 562)
    # Never overwrites: a second one gets a new name.
    _code, events = run({"youtube": [str(square)]})
    assert next(e for e in events if e["type"] == "result")["jpegs"][0]["path"] == str(
        tmp_path / "square YouTube 2.jpg"
    )
    assert "media-thumbs" in COMMANDS
