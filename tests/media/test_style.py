"""The media-style command (vibecut_agent/media/style.py, Phase 20b), on video made by ffmpeg."""

from __future__ import annotations

import io
import json
import shutil
import subprocess
from pathlib import Path

import pytest

from vibecut_agent.headless import COMMANDS
from vibecut_agent.media import style
from vibecut_agent.protocol import Emitter, RequestError

pytestmark = pytest.mark.skipif(shutil.which("ffmpeg") is None, reason="needs ffmpeg")


def make(path: Path, colours: list[str], seconds: float = 2.0) -> Path:
    """A video of flat colours, `seconds` each, one after another (with a grey ramp under each, so a
    frame has some contrast)."""
    inputs: list[str] = []
    for c in colours:
        inputs += ["-f", "lavfi", "-t", str(seconds), "-i", f"color=c={c}:s=320x180:r=25"]
    graph = "".join(f"[{i}:v]format=yuv420p,setsar=1[v{i}];" for i in range(len(colours)))
    graph += "".join(f"[v{i}]" for i in range(len(colours))) + f"concat=n={len(colours)}:v=1:a=0[out]"
    subprocess.run(
        ["ffmpeg", "-v", "error", "-y", *inputs, "-filter_complex", graph, "-map", "[out]",
         "-c:v", "libx264", "-preset", "ultrafast", "-crf", "12", str(path)],
        check=True,
    )  # fmt: skip
    return path


def run(request: dict) -> tuple[int, list[dict]]:
    stream = io.StringIO()
    code = style.run(request, Emitter(stream))
    return code, [json.loads(line) for line in stream.getvalue().splitlines()]


def result(request: dict) -> dict:
    code, events = run(request)
    assert code == 0, events
    return next(e for e in events if e["type"] == "result")


def test_measures_a_frame_of_each_shot_and_leaves_black_out_of_the_look(tmp_path: Path):
    # Warm orange, warm orange, cool blue, then black (a fade).
    path = make(tmp_path / "ref.mp4", ["0xd08040", "0xd08040", "0x4070c0", "black"])
    found = result({"path": str(path), "times": [1, 3, 5, 7]})
    frames = found["frames"]
    assert [f["time"] for f in frames] == [1, 3, 5, 7] and all(f["ok"] for f in frames)
    assert frames[0]["warmth"] > 0.5 and frames[2]["warmth"] < -0.5
    assert frames[3]["brightness"] < style.DARK
    assert found["measured"] == 4 and found["dark"] == 1
    # The median of the three lit frames: the orange.
    assert found["look"]["warmth"] == pytest.approx(frames[0]["warmth"], abs=0.02)
    assert found["look"]["brightness"] == pytest.approx(frames[0]["brightness"], abs=0.02)
    low, high = found["spread"]["warmth"]
    assert low < 0 < high


def test_the_measures_are_get_clip_colors(tmp_path: Path):
    from vibecut_agent.nle import colour

    path = make(tmp_path / "ref.mp4", ["0x806040"])
    still = tmp_path / "still.png"
    subprocess.run(
        ["ffmpeg", "-v", "error", "-y", "-ss", "1", "-i", str(path), "-frames:v", "1", str(still)], check=True
    )
    frame = result({"path": str(path), "times": [1]})["frames"][0]
    expected = colour.measure(colour.frame_pixels(str(still)))
    # The PNG goes through its own YUV to RGB conversion, so a little apart.
    for key in style.MEASURES:
        assert frame[key] == pytest.approx(expected[key], abs=0.03)


def test_requests_are_checked(tmp_path: Path):
    path = make(tmp_path / "ref.mp4", ["gray"])
    for bad in ({"path": str(path)}, {"path": str(path), "times": []}, {"path": str(path), "times": [-1]},
                {"path": str(path), "times": [1] * (style.MAX_SAMPLES + 1)}, {"path": "ref.mp4", "times": [1]}):  # fmt: skip
        with pytest.raises(RequestError):
            style.run(bad, Emitter(io.StringIO()))
    code, events = run({"path": str(tmp_path / "missing.mp4"), "times": [1]})
    assert code == 1 and "isn't there" in events[-1]["message"]
    sound = tmp_path / "tone.wav"
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-f", "lavfi", "-i", "sine=d=1", str(sound)], check=True)
    code, events = run({"path": str(sound), "times": [0.5]})
    assert code == 1 and "no picture" in events[-1]["message"]
    assert "media-style" in COMMANDS
