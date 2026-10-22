"""The renders folder and the ffmpeg step after an editor's render (renders.py, PLAN.md "Phase 15b"),
VibeCut's test_host_renders.py ported with it (its "Phase 7c"), without the stills test."""

import shutil
import subprocess

import pytest

from vibecut_agent.nle.renders import (
    RenderError,
    extract_wav,
    media_duration,
    output_stem,
    safe_name,
)

needs_ffmpeg = pytest.mark.skipif(shutil.which("ffmpeg") is None, reason="ffmpeg isn't installed")


@pytest.fixture
def renders(tmp_path, monkeypatch):
    monkeypatch.setenv("VIBECUT_RENDERS_DIR", str(tmp_path / "renders"))
    return tmp_path / "renders"


def test_names_can_never_leave_the_folder():
    # Without a separator, ".." is only part of a name.
    assert safe_name("../../etc/passwd") == ".. etc passwd"
    assert "/" not in safe_name("a/b\\c:d") and safe_name("a/b\\c:d") == "a b c d"
    assert safe_name("..hidden") == "hidden"
    assert safe_name("   ") == "Render" and safe_name(None, "X") == "X"
    assert len(safe_name("x" * 500)) == 80


def test_stems_are_unique_across_extensions(renders):
    folder, stem = output_stem("Proj", "Cut", "v1", (".mov", ".wav"))
    assert (folder, stem) == (str(renders / "Proj"), "Cut - v1")
    (renders / "Proj" / "Cut - v1.mov").write_text("carrier")
    assert output_stem("Proj", "Cut", "v1", (".mov", ".wav"))[1] == "Cut - v1 2"
    assert output_stem("Proj", "Cut", None, (".mp4",))[1] == "Cut"


@needs_ffmpeg
def test_wav_is_copied_out_of_the_carrier_and_the_carrier_removed(tmp_path):
    carrier = tmp_path / "c.mov"
    subprocess.run(
        ["ffmpeg", "-v", "error", "-f", "lavfi", "-i", "color=black:s=64x36:d=1", "-f", "lavfi", "-i", "sine=d=1",
         "-c:v", "prores_ks", "-profile:v", "0", "-c:a", "pcm_s24le", "-shortest", str(carrier)],
        check=True,
    )  # fmt: skip
    wav = tmp_path / "c.wav"
    extract_wav(str(carrier), str(wav))
    assert wav.is_file() and not carrier.exists()
    probe = subprocess.run(
        [
            "ffprobe",
            "-v",
            "error",
            "-show_entries",
            "stream=codec_name",
            "-of",
            "csv=p=0",
            str(wav),
        ],
        capture_output=True,
        text=True,
        check=False,
    )
    assert probe.stdout.strip() == "pcm_s24le"


@needs_ffmpeg
def test_a_broken_carrier_fails_cleanly(tmp_path):
    carrier = tmp_path / "c.mov"
    carrier.write_text("not a movie")
    with pytest.raises(RenderError, match="take the sound out"):
        extract_wav(str(carrier), str(tmp_path / "c.wav"))
    assert not carrier.exists() and not (tmp_path / "c.wav").exists()


@needs_ffmpeg
def test_media_duration(tmp_path, monkeypatch):
    clip = tmp_path / "c.mp4"
    subprocess.run(
        ["ffmpeg", "-v", "error", "-f", "lavfi", "-i", "color=black:s=64x36:r=25:d=2", str(clip)], check=True
    )
    assert media_duration(str(clip)) == pytest.approx(2.0, abs=0.05)
    (tmp_path / "text.mp4").write_text("not a movie")
    assert media_duration(str(tmp_path / "text.mp4")) is None
    monkeypatch.setenv("VIBECUT_FFPROBE", str(tmp_path / "missing"))
    assert media_duration(str(clip)) is None
