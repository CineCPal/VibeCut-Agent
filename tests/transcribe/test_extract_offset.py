"""The sound a transcript is made from, and where its times count from (transcribe/pipeline.py): the first
audio stream, moved by its start offset onto the picture's clock; older caches brought up to that."""

from __future__ import annotations

import json
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

from vibecut_agent.broll import ffprobe_util
from vibecut_agent.transcribe import alignment, commands, pipeline

needs_ffmpeg = pytest.mark.skipif(shutil.which("ffmpeg") is None, reason="needs ffmpeg")


def ffmpeg(*args: str) -> None:
    subprocess.run(["ffmpeg", "-v", "error", "-y", *args], check=True)


@pytest.fixture(scope="module")
def delayed(tmp_path_factory) -> Path:
    """4 s of picture; a 1 s tone that starts about half a second after it."""
    folder = tmp_path_factory.mktemp("offset")
    plain = folder / "plain.mp4"
    ffmpeg(
        *("-f", "lavfi", "-i", "testsrc=size=160x90:rate=25:duration=4"),
        *("-f", "lavfi", "-i", "sine=frequency=440:duration=1"),
        *("-c:v", "libx264", "-c:a", "aac", str(plain)),
    )
    out = folder / "delayed.mp4"
    ffmpeg(
        "-i",
        str(plain),
        "-itsoffset",
        "0.5",
        "-i",
        str(plain),
        "-map",
        "0:v",
        "-map",
        "1:a",
        "-c",
        "copy",
        str(out),
    )
    return out


@needs_ffmpeg
def test_the_audio_offset_is_read_from_the_streams(delayed, tmp_path):
    assert ffprobe_util.audio_offset_seconds(str(delayed)) == pytest.approx(0.5, abs=0.05)
    sound = tmp_path / "sound.wav"
    ffmpeg("-f", "lavfi", "-i", "sine=duration=1", str(sound))
    assert ffprobe_util.audio_offset_seconds(str(sound)) == 0.0
    assert ffprobe_util.audio_offset_seconds(str(tmp_path / "missing.mp4")) == 0.0


@needs_ffmpeg
def test_the_wav_drops_that_offset_so_times_are_moved_by_it(delayed, tmp_path, monkeypatch):
    """ffmpeg's WAV starts at the first audio sample; the transcript is moved onto the picture's clock."""
    monkeypatch.setattr(
        pipeline,
        "transcribe_audio",
        lambda wav, model, progress_callback=None: [
            {
                "start": 0.1,
                "end": 0.6,
                "text": "Tone.",
                "avg_logprob": -0.1,
                "no_speech_prob": 0.0,
                "words": [{"start": 0.1, "end": 0.6, "text": "Tone."}],
            }
        ],
    )
    monkeypatch.setattr(pipeline, "transcribe_clips", lambda *a, **k: [])
    segments, speakers, aligned, _language = pipeline.transcribe_video(str(delayed), "tiny", False, "")
    offset = ffprobe_util.audio_offset_seconds(str(delayed))
    assert aligned and speakers == ["Speaker 1"]
    # A steady tone gives the level nothing to read: only the offset moves the times.
    assert segments[0].start == pytest.approx(0.1 + offset, abs=0.002)
    assert segments[0].words[0]["end"] == pytest.approx(0.6 + offset, abs=0.002)


@needs_ffmpeg
def test_the_first_audio_stream_is_the_one_transcribed(tmp_path):
    """ffmpeg alone would pick the stream with the most channels (here a silent stereo one)."""
    media = tmp_path / "two.mov"
    ffmpeg(
        *("-f", "lavfi", "-i", "sine=frequency=440:duration=2"),
        *("-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo"),
        *("-map", "0:a", "-map", "1:a", "-t", "2", "-c:a", "pcm_s16le", str(media)),
    )
    wav = tmp_path / "out.wav"
    pipeline.extract_audio(str(media), str(wav))
    speech = alignment.build_speech_map(str(wav), use_vad=False)
    assert float(speech.level_db.max()) > -40


@needs_ffmpeg
def test_an_old_cache_is_checked_against_the_sound_once(delayed):
    media = str(delayed)
    old = pipeline.Segment(
        start=0.1,
        end=0.6,
        text="Tone.",
        speaker="Speaker 2",
        words=[{"start": 0.1, "end": 0.6, "text": "Tone."}],
    )
    assert pipeline.write_cache(
        media, "delayed.mp4", [old], ["Speaker 2"], {"Speaker 2": "Ana"}, {"Speaker 9"}
    )
    data = pipeline.load_cache(media)
    assert pipeline.needs_upgrade(data)
    upgraded = pipeline.upgrade_cache(media, data)
    assert upgraded is not None and not pipeline.needs_upgrade(upgraded)
    offset = ffprobe_util.audio_offset_seconds(media)
    (line,) = upgraded["segments"]
    assert line["start"] == pytest.approx(0.1 + offset, abs=0.002) and line["speaker"] == "Speaker 2"
    assert upgraded["speaker_labels"] == {"Speaker 2": "Ana"} and upgraded["excluded_speakers"] == [
        "Speaker 9"
    ]
    on_disk = json.loads(Path(media + pipeline.CACHE_SUFFIX).read_text())
    assert on_disk["alignment"] == pipeline.ALIGNMENT_VERSION


def test_a_cache_that_cant_be_upgraded_stands(tmp_path):
    media = tmp_path / "broken.wav"
    media.write_bytes(b"RIFF")
    assert pipeline.write_cache(str(media), "broken.wav", [pipeline.Segment(1.0, 2.0, "Hi")], ["Speaker 0"])
    data = pipeline.load_cache(str(media))
    assert pipeline.upgrade_cache(str(media), data) is None
    assert pipeline.needs_upgrade(pipeline.load_cache(str(media)))


def test_the_align_phase_has_its_share_of_progress():
    assert commands.file_fraction("align", 0.0, False) == pytest.approx(0.90)
    assert commands.file_fraction("align", 1.0, True) == pytest.approx(0.70)


# ---------------------------------------------------------------------------------- real speech


def _tiny_model_ready() -> bool:
    return (
        sys.platform == "darwin"
        and shutil.which("say") is not None
        and shutil.which("ffmpeg") is not None
        and alignment.vad_available()
        and commands.model_is_downloaded("mlx-community/whisper-tiny-mlx")
        and _importable("mlx_whisper")
    )


def _importable(name: str) -> bool:
    import importlib.util

    return importlib.util.find_spec(name) is not None


@pytest.mark.skipif(not _tiny_model_ready(), reason="needs macOS `say`, onnxruntime and the tiny mlx model")
def test_real_speech_lines_are_all_found_and_their_edges_land_on_the_sound(tmp_path):
    """Two spoken lines with silence around them, in a video whose sound starts 0.5 s late."""
    lines = ["Hello there, this is the first line.", "And here is the second line."]
    parts = []
    for i, text in enumerate(lines):
        aiff = tmp_path / f"line{i}.aiff"
        subprocess.run(["say", "-o", str(aiff), text], check=True)
        parts.append(aiff)
    # Where each line's sound really is in the WAV: 1.5 s silence, line 0, 2 s silence, line 1, 1 s.
    speech_wav = tmp_path / "speech.wav"
    ffmpeg(
        *("-f", "lavfi", "-t", "1.5", "-i", "anullsrc=r=22050:cl=mono", "-i", str(parts[0])),
        *("-f", "lavfi", "-t", "2", "-i", "anullsrc=r=22050:cl=mono", "-i", str(parts[1])),
        *("-f", "lavfi", "-t", "1", "-i", "anullsrc=r=22050:cl=mono"),
        *(
            "-filter_complex",
            "[0][1][2][3][4]concat=n=5:v=0:a=1",
            "-ar",
            "16000",
            "-ac",
            "1",
            str(speech_wav),
        ),
    )
    truth = [
        (start + 0.0, end)
        for start, end in alignment.speech_regions(alignment.build_speech_map(str(speech_wav), use_vad=False))
    ]
    truth = [(s + alignment.REGION_PAD_S, e - alignment.REGION_PAD_S) for s, e in truth]
    video = tmp_path / "talk.mp4"
    ffmpeg(
        *("-f", "lavfi", "-i", "testsrc=size=160x90:rate=25:duration=12"),
        *("-itsoffset", "0.5", "-i", str(speech_wav)),
        *("-map", "0:v", "-map", "1:a", "-c:v", "libx264", "-c:a", "aac", "-shortest", str(video)),
    )
    offset = ffprobe_util.audio_offset_seconds(str(video))
    segments, _, aligned, language = pipeline.transcribe_video(
        str(video), "mlx-community/whisper-tiny-mlx", False, ""
    )
    assert language == "en"
    assert aligned
    text = " ".join(s.text.lower() for s in segments)
    assert "first line" in text and "second line" in text
    assert len(truth) == 2
    for (true_start, true_end), line in zip(truth, _lines_by_region(segments, truth, offset), strict=True):
        assert abs(line.start - (true_start + offset)) <= 0.06
        assert line.end >= true_end + offset - 0.02


def _lines_by_region(segments, truth, offset):
    """For each true stretch of speech, the first and last transcript line in it, as one span."""
    out = []
    for start, end in truth:
        inside = [s for s in segments if s.start < end + offset + 0.3 and s.end > start + offset - 0.3]
        out.append(
            pipeline.Segment(start=min(s.start for s in inside), end=max(s.end for s in inside), text="")
        )
    return out
