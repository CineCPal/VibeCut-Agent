"""The media-frames command (vibecut_agent/media/frames.py, Phase 13b), on real ffmpeg output."""

from __future__ import annotations

import base64
import io
import json
import shutil
import subprocess
from pathlib import Path

import pytest
from PIL import Image

from vibecut_agent.headless import COMMANDS
from vibecut_agent.media import frames
from vibecut_agent.protocol import Emitter, RequestError

needs_ffmpeg = pytest.mark.skipif(shutil.which("ffmpeg") is None, reason="needs ffmpeg")


@pytest.fixture(scope="module")
def clip(tmp_path_factory: pytest.TempPathFactory) -> Path:
    """4 s at 25 fps, 640x360: red for 2 s, then blue."""
    path = tmp_path_factory.mktemp("frames") / "redblue.mp4"
    subprocess.run(
        ["ffmpeg", "-v", "error", "-f", "lavfi", "-i", "color=red:size=640x360:rate=25:duration=2",
         "-f", "lavfi", "-i", "color=blue:size=640x360:rate=25:duration=2",
         "-filter_complex", "[0][1]concat=n=2:v=1", "-pix_fmt", "yuv420p", str(path)],
        check=True,
    )  # fmt: skip
    return path


def result_of(request: dict) -> tuple[int, dict]:
    out = io.StringIO()
    code = frames.run(request, Emitter(out))
    return code, next(json.loads(line) for line in out.getvalue().splitlines() if '"result"' in line)


def picture(image: dict) -> Image.Image:
    return Image.open(io.BytesIO(base64.b64decode(image["data"]))).convert("RGB")


def test_requests_are_checked():
    with pytest.raises(RequestError, match="1 to 12"):
        frames.run({"shots": []}, Emitter(io.StringIO()))
    with pytest.raises(RequestError, match="absolute"):
        frames.run({"shots": [{"path": "a.mov", "time": 1}]}, Emitter(io.StringIO()))
    with pytest.raises(RequestError, match="At most 4"):
        frames.run({"shots": [{"path": "/a.mov", "time": 1}] * 5, "sheet": False}, Emitter(io.StringIO()))
    assert "media-frames" in COMMANDS


@needs_ffmpeg
def test_a_frame_is_the_files_picture_at_that_time(clip: Path):
    code, result = result_of(
        {"shots": [{"path": str(clip), "time": 0.5}, {"path": str(clip), "time": 3.0}], "sheet": False}
    )
    assert code == 0
    first, second = (picture(i) for i in result["images"])
    assert first.size == (640, 360)
    assert first.getpixel((320, 180))[0] > 200 and second.getpixel((320, 180))[2] > 200


@needs_ffmpeg
def test_a_sheet_tiles_every_frame_and_reports_the_ones_it_couldnt_read(clip: Path, tmp_path: Path):
    shots = [{"path": str(clip), "time": t, "label": f"{t}s"} for t in (0.5, 1.5, 2.5)]
    shots += [{"path": str(clip), "time": 30.0}, {"path": str(tmp_path / "gone.mov"), "time": 1.0}]
    code, result = result_of({"shots": shots})
    assert code == 0
    assert len(result["images"]) == 1
    sheet = result["images"][0]
    assert (
        sheet["width"] <= frames.SHEET_WIDTH
        and len(base64.b64decode(sheet["data"])) <= frames.MAX_IMAGE_BYTES
    )
    status = [(f["ok"], f.get("message")) for f in result["frames"]]
    assert status[:3] == [(True, None)] * 3
    assert status[3] == (True, frames.PAST_END)
    assert status[4][0] is False and "isn't there" in status[4][1]


@needs_ffmpeg
def test_nothing_readable_is_a_failure(tmp_path: Path):
    code, result = result_of({"shots": [{"path": str(tmp_path / "gone.mov"), "time": 1.0}]})
    assert code == 1 and result["images"] == []
