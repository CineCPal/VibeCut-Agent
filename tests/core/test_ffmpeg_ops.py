"""The streaming ffmpeg detectors (core/ffmpeg_ops.py), on media made by ffmpeg."""

from __future__ import annotations

import shutil
import subprocess
from pathlib import Path

import pytest
from PIL import Image

from vibecut_agent.core import ffmpeg_ops
from vibecut_agent.core.ffmpeg_ops import (
    FfmpegOpError,
    detect_scene_cuts,
    detect_silences,
    extract_keyframes_for_vlm,
    parse_silences,
)

needs_ffmpeg = pytest.mark.skipif(shutil.which("ffmpeg") is None, reason="needs ffmpeg")

LOOKS = ["testsrc2", "smptebars", "mandelbrot"]


def make(path: Path, rate: str, seconds: list[int], audio: list[tuple[str, float]] | None = None) -> Path:
    """Shots of LOOKS, `seconds` each, at `rate`; and, if given, sound of (sine | silence, seconds) parts."""
    inputs: list[str] = []
    for look, length in zip(LOOKS, seconds, strict=False):
        inputs += ["-f", "lavfi", "-t", str(length), "-i", f"{look}=s=320x180:r={rate}"]
    graph = "".join(f"[{i}:v]format=yuv420p,setsar=1[v{i}];" for i in range(len(seconds)))
    graph += "".join(f"[v{i}]" for i in range(len(seconds))) + f"concat=n={len(seconds)}:v=1:a=0[v]"
    maps = ["-map", "[v]"]
    if audio:
        first = len(seconds)
        for kind, length in audio:
            source = "sine=frequency=440:sample_rate=48000" if kind == "sine" else "anullsrc=r=48000:cl=mono"
            inputs += ["-f", "lavfi", "-t", str(length), "-i", source]
        graph += ";" + "".join(f"[{first + i}:a]" for i in range(len(audio)))
        graph += f"concat=n={len(audio)}:v=0:a=1[a]"
        maps += ["-map", "[a]", "-c:a", "aac"]
    command = ["ffmpeg", "-v", "error", "-y", *inputs, "-filter_complex", graph, *maps]
    subprocess.run([*command, "-c:v", "libx264", "-g", "1000", str(path)], check=True)
    return path


@pytest.fixture(scope="module")
def film(tmp_path_factory) -> Path:
    """25 fps: shots at 0, 2 and 4 s; sound with a silence from 1.0 to 2.5 s."""
    folder = tmp_path_factory.mktemp("film")
    return make(folder / "film.mp4", "25", [2, 2, 2], [("sine", 1.0), ("silence", 1.5), ("sine", 3.5)])


def test_parse_silences_offsets_and_closes_the_last_silence():
    log = [
        "[silencedetect @ 0x1] silence_start: 0.5",
        "[silencedetect @ 0x1] silence_end: 1.75 | silence_duration: 1.25",
        "size=N/A time=00:00:03.00",
        "[silencedetect @ 0x1] silence_start: -0.01",
        "[silencedetect @ 0x1] silence_end: 0.4 | silence_duration: 0.41",
        "[silencedetect @ 0x1] silence_start: 2.5",
    ]
    assert parse_silences(log, 10.0, 14.0) == [(10.5, 11.75), (10.0, 10.4), (12.5, 14.0)]
    assert parse_silences(log[-1:], 0.0, None) == []


@needs_ffmpeg
def test_detect_silences_in_frames(film):
    [silence] = detect_silences(str(film))
    assert silence["start_seconds"] == pytest.approx(1.0, abs=0.03)
    assert silence["end_seconds"] == pytest.approx(2.5, abs=0.03)
    source = silence["source_range"]
    assert source["start_time"]["rate"] == 25.0
    assert source["start_time"]["value"] in (25, 26)
    assert source["start_time"]["value"] + source["duration"]["value"] in (61, 62)


@needs_ffmpeg
def test_detect_silences_in_a_window_keeps_file_time(film):
    [silence] = detect_silences(str(film), start=1.5, end=3.0)
    assert silence["start_seconds"] == pytest.approx(1.5, abs=0.03)
    assert silence["end_seconds"] == pytest.approx(2.5, abs=0.03)
    assert detect_silences(str(film), start=3.0, end=5.0) == []


@needs_ffmpeg
def test_detect_silences_needs_sound(tmp_path):
    silent = make(tmp_path / "picture.mp4", "25", [1])
    with pytest.raises(FfmpegOpError):
        detect_silences(str(silent))


@needs_ffmpeg
def test_detect_scene_cuts_at_25(film):
    cuts = detect_scene_cuts(str(film))
    assert [c["time"]["value"] for c in cuts] == [50, 100]
    assert [c["smpte"] for c in cuts] == ["00:00:02:00", "00:00:04:00"]
    assert cuts[0]["seconds"] == 2.0
    assert all(c["score"] > 0.1 for c in cuts)
    assert [c["time"]["value"] for c in detect_scene_cuts(str(film), start=3.0)] == [100]


@needs_ffmpeg
def test_detect_scene_cuts_at_29_97_in_drop_frame(tmp_path):
    clip = make(tmp_path / "ntsc.mp4", "30000/1001", [2, 2])
    [cut] = detect_scene_cuts(str(clip))
    assert cut["time"] == {"OTIO_SCHEMA": "RationalTime.1", "value": 60, "rate": 29.97}
    assert cut["smpte"] == "00:00:02;00"


@needs_ffmpeg
def test_keyframes_at_scene_cuts(film, tmp_path):
    keyframes = extract_keyframes_for_vlm(str(film), tmp_path / "keys", width=160)
    assert [k["shot_id"] for k in keyframes] == ["shot_0000", "shot_0001", "shot_0002"]
    ranges = [
        (k["source_range"]["start_time"]["value"], k["source_range"]["duration"]["value"]) for k in keyframes
    ]
    assert ranges == [(0, 50), (50, 50), (100, 50)]
    assert [k["keyframe_time"]["value"] for k in keyframes] == [25, 75, 125]
    assert keyframes[1]["keyframe_timestamp_sec"] == 3.0
    for k in keyframes:
        with Image.open(k["image_path"]) as image:
            assert image.size == (160, 90)
    assert not list((tmp_path / "keys").glob(".*partial*"))


@needs_ffmpeg
def test_the_scene_cut_scan_reports_how_far_it_is(film, tmp_path):
    # Seen live (Phase 21): a whole 4K file decoded for 12 s with no progress.
    heard = []
    extract_keyframes_for_vlm(str(film), tmp_path / "keys", width=160, on_scan=heard.append)
    assert len(heard) >= 50
    assert heard == sorted(heard) and 0 < heard[0] and heard[-1] == pytest.approx(1.0, abs=0.02)
    # The other strategies don't scan.
    heard.clear()
    extract_keyframes_for_vlm(
        str(film), tmp_path / "keys", width=160, strategy="midpoint_only", on_scan=heard.append
    )
    assert heard == []


@needs_ffmpeg
def test_keyframes_uniform_and_midpoint(film, tmp_path):
    uniform = extract_keyframes_for_vlm(
        str(film), tmp_path, strategy="uniform_2s", start=1.0, end=5.0, width=64
    )
    assert [
        (k["source_range"]["start_time"]["value"], k["source_range"]["duration"]["value"]) for k in uniform
    ] == [
        (25, 50),
        (75, 50),
    ]
    [middle] = extract_keyframes_for_vlm(str(film), tmp_path, strategy="midpoint_only", width=64)
    assert middle["keyframe_time"]["value"] == 75
    assert Path(middle["image_path"]).is_file()


@needs_ffmpeg
def test_a_shot_becomes_a_contact_strip_of_its_start_middle_and_end(film, tmp_path):
    """Model migration v2: the three moments side by side, left to right, each its own frame."""
    import numpy as np

    [shot] = extract_keyframes_for_vlm(
        str(film), tmp_path / "strips", strategy="midpoint_only", width=160, strip=True
    )
    # The whole 6 s as one shot: 15%, 50% and 85% are in the first, second and third look.
    assert shot["strip_timestamps_sec"] == [0.88, 3.0, 5.12]
    assert shot["keyframe_timestamp_sec"] == 3.0
    assert shot["image_path"].endswith("_strip.jpg")
    with Image.open(shot["image_path"]) as image:
        assert image.size == (480, 90)
        panels = [
            np.asarray(image.convert("L").crop((160 * i, 0, 160 * (i + 1), 90)), dtype=float)
            for i in range(3)
        ]
    for i, seconds in enumerate(shot["strip_timestamps_sec"]):
        single = tmp_path / f"single_{i}.jpg"
        ffmpeg_ops._grab(str(film), ffmpeg_ops.Fraction(str(seconds)), 160, single)
        with Image.open(single) as image:
            alone = np.asarray(image.convert("L"), dtype=float)
        assert np.abs(panels[i] - alone).mean() < 8, f"panel {i} is the frame at {seconds} s"
    assert np.abs(panels[0] - panels[1]).mean() > 20 and np.abs(panels[1] - panels[2]).mean() > 20
    assert not list((tmp_path / "strips").glob(".*partial*"))


@needs_ffmpeg
def test_a_shot_too_short_for_a_strip_is_its_middle_frame(film, tmp_path):
    [shot] = extract_keyframes_for_vlm(
        str(film), tmp_path, strategy="midpoint_only", start=1.0, end=1.4, width=64, strip=True
    )
    assert "strip_timestamps_sec" not in shot and not shot["image_path"].endswith("_strip.jpg")
    with Image.open(shot["image_path"]) as image:
        assert image.size == (64, 36)


@needs_ffmpeg
def test_keyframes_reuse_existing_images(film, tmp_path, monkeypatch):
    first = extract_keyframes_for_vlm(str(film), tmp_path, strategy="midpoint_only", width=64)

    def no_grab(*args, **kwargs):
        raise AssertionError("the frame was already there")

    monkeypatch.setattr(ffmpeg_ops, "_grab", no_grab)
    assert extract_keyframes_for_vlm(str(film), tmp_path, strategy="midpoint_only", width=64) == first


def test_requests_are_checked(tmp_path):
    with pytest.raises(FfmpegOpError, match="absolute"):
        detect_silences("film.mp4")
    with pytest.raises(FfmpegOpError, match="isn't there"):
        detect_scene_cuts(str(tmp_path / "missing.mp4"))
    present = tmp_path / "x.mp4"
    present.write_bytes(b"")
    with pytest.raises(FfmpegOpError, match="end must be after start"):
        detect_silences(str(present), start=2, end=1)
    with pytest.raises(FfmpegOpError, match="sensitivity"):
        detect_scene_cuts(str(present), sensitivity="extreme")
    with pytest.raises(FfmpegOpError, match="strategy"):
        extract_keyframes_for_vlm(str(present), tmp_path, strategy="every_frame")  # type: ignore[arg-type]
    with pytest.raises(FfmpegOpError, match="noise_db"):
        detect_silences(str(present), noise_db=-5)


def _pairs(data: bytes) -> list[tuple[int, int]]:
    import array

    values = array.array("h")
    values.frombytes(data)
    return list(zip(values[::2], values[1::2], strict=True))


@needs_ffmpeg
def test_range_peaks_are_the_sound_of_the_range_in_256_buckets(film):
    """0 to 2 s of the film: the sine (ffmpeg's 1/8 amplitude) for the first second, then silence."""
    pairs = _pairs(ffmpeg_ops.range_peaks(str(film), 0.0, 2.0))
    assert len(pairs) == 256
    loud = 0.125 * 32767
    assert all(low < -0.8 * loud and high > 0.8 * loud for low, high in pairs[8:120])
    assert all(abs(low) < 200 and abs(high) < 200 for low, high in pairs[136:250])
    # From 1.0 s: the silence first, then the sine again at 2.5 s (bucket 192 of 0..2 s from 1.0 s).
    later = _pairs(ffmpeg_ops.range_peaks(str(film), 1.0, 2.0, buckets=64))
    assert len(later) == 64
    assert max(high for _, high in later[4:44]) < 200
    assert min(high for _, high in later[52:62]) > 0.8 * loud


@needs_ffmpeg
def test_range_peaks_past_the_end_leave_zeros(film):
    pairs = _pairs(ffmpeg_ops.range_peaks(str(film), 5.0, 2.0, buckets=16))
    assert pairs[2][1] > 0 and pairs[-1] == (0, 0)


def test_range_peaks_refuse_what_they_cant_measure(tmp_path):
    with pytest.raises(FfmpegOpError, match="isn't there"):
        ffmpeg_ops.range_peaks(str(tmp_path / "gone.wav"), 0.0, 1.0)
    (tmp_path / "x.wav").write_bytes(b"")
    with pytest.raises(FfmpegOpError, match="at most 15 minutes"):
        ffmpeg_ops.range_peaks(str(tmp_path / "x.wav"), 0.0, 16 * 60.0)
    with pytest.raises(FfmpegOpError, match="up to 1 s"):
        ffmpeg_ops.scrub_pcm(str(tmp_path / "x.wav"), 0.0, 2.0)


@needs_ffmpeg
def test_scrub_pcm_is_a_quarter_second_at_48_khz(film):
    data = ffmpeg_ops.scrub_pcm(str(film), 0.5)
    assert len(data) == 12_000 * 2
    assert max(abs(low) for low, _ in _pairs(data)) > 0.8 * 0.125 * 32767
    assert len(ffmpeg_ops.scrub_pcm(str(film), 5.9)) < 12_000 * 2
