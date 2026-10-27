"""The media-roomtone command (vibecut_agent/media/roomtone.py, Phase 18e), on sound made by ffmpeg."""

from __future__ import annotations

import io
import json
import os
import shutil
import subprocess
from pathlib import Path

import numpy as np
import pytest

from vibecut_agent.headless import COMMANDS
from vibecut_agent.media import roomtone
from vibecut_agent.protocol import Emitter, RequestError

needs_ffmpeg = pytest.mark.skipif(shutil.which("ffmpeg") is None, reason="needs ffmpeg")


@pytest.fixture(autouse=True)
def renders(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    folder = tmp_path / "renders"
    monkeypatch.setenv("VIBECUT_RENDERS_DIR", str(folder))
    return folder


def make_interview(path: Path, pause: tuple[float, float] = (3.0, 5.5)) -> Path:
    """8 s of stereo: pink room noise throughout (left only a little louder), a loud 300 Hz "voice" except
    in `pause`."""
    a, b = pause
    subprocess.run(
        ["ffmpeg", "-v", "error", "-f", "lavfi", "-i", "sine=frequency=300:sample_rate=48000:duration=8",
         "-f", "lavfi", "-i", "anoisesrc=color=pink:amplitude=0.02:sample_rate=48000:duration=8:seed=7",
         "-filter_complex",
         (f"[0]volume=0.5,volume=enable='between(t,{a},{b})':volume=0[v];"
          "[v][1]amix=inputs=2:normalize=0,pan=stereo|c0=c0|c1=0.5*c0"),
         str(path)],
        check=True,
    )  # fmt: skip
    return path


def run(request: dict) -> tuple[int, list[dict]]:
    out = io.StringIO()
    code = roomtone.run(request, Emitter(out))
    return code, next(json.loads(line) for line in out.getvalue().splitlines() if '"result"' in line)["files"]


def read(path: Path) -> tuple[np.ndarray, dict]:
    info = json.loads(
        subprocess.run(
            ["ffprobe", "-v", "error", "-show_entries", "stream=sample_rate,channels,bits_per_sample", "-of", "json",
             str(path)],
            capture_output=True,
            check=True,
        ).stdout
    )["streams"][0]  # fmt: skip
    raw = subprocess.run(
        ["ffmpeg", "-v", "error", "-i", str(path), "-f", "f32le", "pipe:1"], capture_output=True, check=True
    ).stdout
    return np.frombuffer(raw, dtype=np.float32).reshape(-1, info["channels"]), info


def test_the_quietest_stretch_skips_words_and_digital_silence():
    # 50 ms blocks: speech, a 1 s pause, a word, a 2.5 s pause, then digital silence.
    levels = np.array([-20.0] * 20 + [-60.0] * 20 + [-20.0] * 4 + [-58.0] * 50 + [-120.0] * 80)
    first, blocks, loudest = roomtone.quietest(levels)  # type: ignore[misc]
    assert 44 <= first and first + blocks <= 94
    assert blocks == 40  # 2 s: the longest that fits in the 2.5 s pause with its margins
    assert loudest == -58.0
    assert roomtone.quietest(np.array([-120.0] * 100)) is None
    assert roomtone.quietest(np.array([-50.0] * 5)) is None


def test_a_loop_keeps_its_level_through_the_seams():
    rate = 48000
    noise = np.random.default_rng(1).normal(0, 0.05, (rate // 2, 1)).astype(np.float32)
    out = roomtone.loop_to(noise, rate * 5, rate)
    assert out.shape == (rate * 5, 1)
    rms = np.sqrt(np.mean(np.square(out[: len(out) // 2400 * 2400].reshape(-1, 2400)), axis=1))
    # Every 50 ms within about 2 dB of the sample's own level: no dip or bump at a crossfade.
    assert np.all(np.abs(20 * np.log10(rms / 0.05)) < 2.0)


def test_requests_are_checked():
    with pytest.raises(RequestError, match="1 to 16"):
        roomtone.run({"sources": []}, Emitter(io.StringIO()))
    with pytest.raises(RequestError, match="seconds"):
        roomtone.run({"sources": [{"path": "/a.wav", "seconds": 0.2}]}, Emitter(io.StringIO()))
    with pytest.raises(RequestError, match="channel"):
        roomtone.run({"sources": [{"path": "/a.wav", "seconds": 3, "channel": 0}]}, Emitter(io.StringIO()))
    with pytest.raises(RequestError, match="after its start"):
        roomtone.run(
            {"sources": [{"path": "/a.wav", "seconds": 3, "start": 5, "end": 2}]}, Emitter(io.StringIO())
        )
    assert "media-roomtone" in COMMANDS


@needs_ffmpeg
def test_room_tone_comes_from_the_pause_at_the_rooms_level(tmp_path: Path, renders: Path):
    source = make_interview(tmp_path / "Int A.wav")
    code, files = run({"sources": [{"path": str(source), "seconds": 12}], "project": "Doc"})
    assert code == 0
    entry = files[0]
    assert entry["reused"] is False and entry["quiet"] is True
    assert 3.0 <= entry["sample"]["start"] and entry["sample"]["start"] + entry["sample"]["seconds"] <= 5.5
    out = Path(entry["output"])
    assert out.parent == renders / "Doc" / "Room tone"
    assert out.name.startswith("Int A room tone ")
    samples, info = read(out)
    assert info["sample_rate"] == "48000" and info["channels"] == 2 and info["bits_per_sample"] == 24
    assert abs(len(samples) / 48000 - 12) < 0.01
    # No 300 Hz voice in it: the level is the noise's, the left channel's about 6 dB over the right's.
    left, right = (20 * np.log10(np.sqrt(np.mean(np.square(samples[:, c])))) for c in (0, 1))
    assert left < -30 and abs(left - right - 6.0) < 1.0
    assert entry["contrastDb"] > 15


@needs_ffmpeg
def test_one_channel_is_taken_alone_and_reused_until_the_source_changes(tmp_path: Path):
    source = make_interview(tmp_path / "int.wav")
    request = {"sources": [{"path": str(source), "seconds": 4, "channel": 2, "start": 2, "end": 7}]}
    _, first = run(request)
    _, info = read(Path(first[0]["output"]))
    assert info["channels"] == 1 and " ch2 " in Path(first[0]["output"]).name
    _, again = run(request)
    assert again[0]["reused"] is True and again[0]["output"] == first[0]["output"]
    later = source.stat().st_mtime + 5
    os.utime(source, (later, later))
    _, after = run(request)
    assert after[0]["reused"] is False and after[0]["output"] != first[0]["output"]


@needs_ffmpeg
def test_a_range_with_no_pause_falls_back_to_the_whole_file(tmp_path: Path):
    source = make_interview(tmp_path / "int.wav", pause=(6.0, 7.5))
    _, files = run({"sources": [{"path": str(source), "seconds": 3, "start": 0, "end": 4}]})
    # 0-4 s is all voice, so the pause at 6-7.5 s is used instead.
    assert files[0]["quiet"] is True
    assert (
        6.0 <= files[0]["sample"]["start"]
        and files[0]["sample"]["start"] + files[0]["sample"]["seconds"] <= 7.5
    )


@needs_ffmpeg
def test_missing_and_silent_files_are_reported_and_the_rest_made(tmp_path: Path):
    silent = tmp_path / "silent.wav"
    subprocess.run(
        ["ffmpeg", "-v", "error", "-f", "lavfi", "-i", "anullsrc=r=48000:cl=mono", "-t", "3", str(silent)],
        check=True,
    )
    good = make_interview(tmp_path / "int.wav")
    code, files = run(
        {
            "sources": [
                {"path": str(tmp_path / "gone.wav"), "seconds": 2},
                {"path": str(silent), "seconds": 2},
                {"path": str(good), "seconds": 2},
            ]
        }
    )
    assert code == 0
    assert "isn't there" in files[0]["error"]
    assert "silent throughout" in files[1]["error"]
    assert Path(files[2]["output"]).is_file()
