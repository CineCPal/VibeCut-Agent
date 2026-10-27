"""The media-shots command (vibecut_agent/media/shots.py, Phase 19b), on video made by ffmpeg."""

from __future__ import annotations

import io
import json
import shutil
import subprocess
from pathlib import Path

import numpy as np
import pytest

from vibecut_agent.headless import COMMANDS
from vibecut_agent.media import shots
from vibecut_agent.protocol import Emitter, RequestError

pytestmark = pytest.mark.skipif(shutil.which("ffmpeg") is None, reason="needs ffmpeg")

FPS = 25
# Shots of different looks, each `seconds` long, cut together.
LOOKS = [
    "testsrc2=s=320x180:r=25",
    "smptebars=s=320x180:r=25",
    "mandelbrot=s=320x180:r=25",
    "testsrc2=s=320x180:r=25,hue=h=180,negate",
]


def make(path: Path, parts: list[tuple[str, float]]) -> Path:
    """A video of these (lavfi source, seconds) parts, one after another."""
    inputs: list[str] = []
    for source, seconds in parts:
        inputs += ["-f", "lavfi", "-t", str(seconds), "-i", source]
    labels = "".join(f"[{i}:v]format=yuv420p,setsar=1[v{i}];" for i in range(len(parts)))
    joined = "".join(f"[v{i}]" for i in range(len(parts)))
    graph = f"{labels}{joined}concat=n={len(parts)}:v=1:a=0[out]"
    subprocess.run(
        [
            "ffmpeg",
            "-v",
            "error",
            "-y",
            *inputs,
            "-filter_complex",
            graph,
            "-map",
            "[out]",
            "-c:v",
            "libx264",
            "-preset",
            "ultrafast",
            "-g",
            "250",
            str(path),
        ],
        check=True,
    )
    return path


def run(request: dict) -> dict:
    stream = io.StringIO()
    assert shots.run(request, Emitter(stream)) == 0, stream.getvalue()
    events = [json.loads(line) for line in stream.getvalue().splitlines()]
    return next(e for e in events if e["type"] == "result")


def test_finds_hard_cuts_on_their_first_frame(tmp_path: Path):
    path = make(tmp_path / "cuts.mp4", [(look, 2.0) for look in LOOKS])
    found = run({"path": str(path)})
    assert [c["time"] for c in found["cuts"]] == [2.0, 4.0, 6.0]
    assert all(c["score"] > shots.THRESHOLDS["normal"] for c in found["cuts"])
    assert found["fps"] == FPS and found["frames"] == 200 and found["end"] == 8.0


def test_steady_motion_is_not_a_cut(tmp_path: Path):
    # testsrc2 moves every frame, and mandelbrot zooms in all the time.
    path = make(
        tmp_path / "motion.mp4", [("testsrc2=s=320x180:r=25", 4.0), ("mandelbrot=s=320x180:r=25", 4.0)]
    )
    assert [c["time"] for c in run({"path": str(path)})["cuts"]] == [4.0]


def wipe(count: int) -> list[np.ndarray]:
    """One continuous shot: a slow wipe, a little change every frame."""
    frames = [np.full((shots.HEIGHT, shots.WIDTH, 3), 90, dtype=np.uint8) for _ in range(count)]
    for i, frame in enumerate(frames):
        frame[:, : i + 10] = 160
    return frames


def test_a_flash_is_not_a_cut():
    frames = wipe(50)
    frames[25] = np.full_like(frames[25], 255)
    frames[26] = np.full_like(frames[26], 255)
    cuts, count = shots.find_cuts((f.tobytes() for f in frames), FPS)
    assert count == 50 and cuts == []
    # A real cut in the same material is still found.
    frames = wipe(25) + [np.full_like(frames[0], 20) for _ in range(25)]
    cuts, _ = shots.find_cuts((f.tobytes() for f in frames), FPS)
    assert [i for i, _ in cuts] == [25]


def test_cuts_too_close_together_keep_the_stronger(tmp_path: Path):
    grey = [np.full((shots.HEIGHT, shots.WIDTH, 3), v, dtype=np.uint8) for v in (40, 140, 250)]
    # 40 for 20 frames, 140 for 3 frames (under MIN_SHOT_SECONDS), then 250.
    frames = [grey[0]] * 20 + [grey[1]] * 3 + [grey[2]] * 20
    cuts, _ = shots.find_cuts((f.tobytes() for f in frames), FPS, "high")
    assert len(cuts) == 1 and cuts[0][0] in (20, 23)


def test_a_part_of_a_file_gives_file_times(tmp_path: Path):
    path = make(tmp_path / "cuts.mp4", [(look, 2.0) for look in LOOKS])
    found = run({"path": str(path), "start": 3, "end": 7})
    assert [c["time"] for c in found["cuts"]] == [4.0, 6.0]
    assert found["start"] == 3.0 and found["end"] == 7.0


def test_requests_are_checked(tmp_path: Path):
    with pytest.raises(RequestError):
        shots.run({"path": "clip.mov"}, Emitter(io.StringIO()))
    with pytest.raises(RequestError):
        shots.run({"path": "/clip.mov", "start": 5, "end": 2}, Emitter(io.StringIO()))
    with pytest.raises(RequestError):
        shots.run({"path": "/clip.mov", "sensitivity": "max"}, Emitter(io.StringIO()))
    wav = tmp_path / "tone.wav"
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-f", "lavfi", "-i", "sine=d=1", str(wav)], check=True)
    stream = io.StringIO()
    assert shots.run({"path": str(wav)}, Emitter(stream)) == 1
    assert "has no picture" in stream.getvalue()
    assert "media-shots" in COMMANDS


def test_a_wipe_is_not_a_cut_and_a_blended_frame_is_one():
    dark, light = (np.full((shots.HEIGHT, shots.WIDTH, 3), v, dtype=np.uint8) for v in (30, 220))
    # A wipe: the light picture sweeps across over 6 frames, each changing about as much as the last.
    sweep = []
    for k in range(1, 7):
        frame = dark.copy()
        frame[:, : k * shots.WIDTH // 6] = 220
        sweep.append(frame)
    cuts, _ = shots.find_cuts((f.tobytes() for f in [dark] * 20 + sweep + [light] * 20), FPS)
    assert cuts == []
    # A cut with one blended frame on it is one cut, at the blend.
    blend = ((dark.astype(np.uint16) + light) // 2).astype(np.uint8)
    cuts, _ = shots.find_cuts((f.tobytes() for f in [dark] * 20 + [blend] + [light] * 20), FPS)
    assert [i for i, _ in cuts] == [20]
