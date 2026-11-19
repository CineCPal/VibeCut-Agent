"""Transcript recall and alignment (transcribe/alignment.py): Whisper's lines checked against the sound."""

from __future__ import annotations

import shutil
import subprocess

import numpy as np
import pytest

from vibecut_agent.transcribe import alignment
from vibecut_agent.transcribe.alignment import (
    ENERGY_SECONDS,
    VAD_SECONDS,
    SpeechMap,
    align,
    build_speech_map,
    drop_hallucinations,
    recover_missed,
    refine_words,
    shift,
    speech_regions,
    uncovered,
)

needs_ffmpeg = pytest.mark.skipif(shutil.which("ffmpeg") is None, reason="needs ffmpeg")
QUIET_DB, LOUD_DB = -70.0, -20.0


def levels(seconds: float, loud: list[tuple[float, float]]) -> np.ndarray:
    """A level track at 10 ms: quiet, with loud stretches."""
    out = np.full(round(seconds / ENERGY_SECONDS), QUIET_DB, dtype=np.float32)
    for start, end in loud:
        out[round(start / ENERGY_SECONDS) : round(end / ENERGY_SECONDS)] = LOUD_DB
    return out


def vad(seconds: float, speech: list[tuple[float, float]]) -> np.ndarray:
    out = np.zeros(round(seconds / VAD_SECONDS), dtype=np.float32)
    for start, end in speech:
        out[round(start / VAD_SECONDS) : round(end / VAD_SECONDS)] = 0.9
    return out


def seg(start, end, words, text="line", avg_logprob=-0.2, no_speech_prob=0.0):
    return {
        "start": start,
        "end": end,
        "text": text,
        "avg_logprob": avg_logprob,
        "no_speech_prob": no_speech_prob,
        "words": [{"start": a, "end": b, "text": t} for a, b, t in words] if words is not None else None,
    }


# Sound at 1.0-2.0 s and 3.0-3.5 s.
SOUND = [(1.0, 2.0), (3.0, 3.5)]


@pytest.fixture
def speech() -> SpeechMap:
    return SpeechMap.from_arrays(levels(10.0, SOUND), vad(10.0, SOUND))


# ------------------------------------------------------------------------------------- word edges


def test_a_late_start_and_an_early_end_go_onto_the_sound(speech):
    (line,) = refine_words([seg(1.2, 1.8, [(1.15, 1.5, "Hello"), (1.5, 1.8, "there")])], speech, [])
    assert [(w["start"], w["end"]) for w in line["words"]] == [(1.0, 1.5), (1.5, 2.0)]
    assert (line["start"], line["end"]) == (1.0, 2.0)


def test_a_start_in_silence_moves_on_to_the_sound(speech):
    (line,) = refine_words([seg(0.8, 1.6, [(0.8, 1.6, "Hi")])], speech, [])
    assert line["words"][0]["start"] == 1.0 and line["start"] == 1.0


def test_an_end_long_after_the_sound_is_pulled_back_with_a_tail(speech):
    (line,) = refine_words([seg(3.0, 4.2, [(3.0, 4.2, "Yes")])], speech, [])
    assert line["words"][0]["end"] == pytest.approx(3.5 + alignment.TRIM_TAIL_S)


def test_an_end_a_little_after_the_sound_is_left(speech):
    (line,) = refine_words([seg(3.0, 3.8, [(3.0, 3.8, "Yes")])], speech, [])
    assert line["end"] == 3.8


def test_words_never_cross_their_neighbours(speech):
    lines = refine_words(
        [seg(1.0, 1.3, [(1.1, 1.3, "So")]), seg(1.35, 1.7, [(1.35, 1.7, "then")])],
        speech,
        [],
    )
    first, second = lines
    # "So" starts back on the sound; its end can't pass "then", which can't start before it ends.
    assert first["words"][0]["start"] == 1.0
    assert first["words"][0]["end"] <= second["words"][0]["start"]
    assert second["words"][0]["end"] == 2.0


def test_words_inside_a_phrase_are_left(speech):
    (line,) = refine_words(
        [seg(1.1, 1.9, [(1.1, 1.4, "one"), (1.45, 1.6, "two"), (1.62, 1.9, "three")])], speech, []
    )
    assert line["words"][1] == {"start": 1.45, "end": 1.6, "text": "two"}


def test_where_the_level_doesnt_move_no_word_is_moved():
    flat = SpeechMap.from_arrays(np.full(1000, -20.0, dtype=np.float32))
    (line,) = refine_words([seg(1.2, 1.8, [(1.2, 1.8, "Hi")])], flat, [])
    assert (line["start"], line["end"], line["words"][0]["start"]) == (1.2, 1.8, 1.2)


def test_a_line_keeps_whisper_s_wider_edge_when_its_word_couldnt_be_read():
    flat = SpeechMap.from_arrays(np.full(1000, -20.0, dtype=np.float32))
    (line,) = refine_words([seg(1.0, 2.0, [(1.2, 1.8, "Hi")])], flat, [])
    assert (line["start"], line["end"]) == (1.0, 2.0)


def test_a_line_without_words_snaps_to_the_nearest_speech_edge(speech):
    regions = speech_regions(speech)
    (line,) = refine_words([seg(1.1, 1.9, None)], speech, regions)
    assert (line["start"], line["end"]) == pytest.approx(regions[0])


# --------------------------------------------------------------------------------- speech regions


def test_speech_regions_are_padded_merged_and_short_runs_dropped():
    track = vad(10.0, [(1.0, 2.0), (2.2, 3.0), (5.0, 5.1)])
    regions = speech_regions(SpeechMap.from_arrays(levels(10.0, []), track))
    # 2.0-2.2 is under MERGE_GAP_S: one region; 5.0-5.1 is under MIN_SPEECH_S: dropped.
    assert len(regions) == 1
    assert regions[0][0] == pytest.approx(1.0 - alignment.REGION_PAD_S, abs=VAD_SECONDS)
    assert regions[0][1] == pytest.approx(3.0 + alignment.REGION_PAD_S, abs=VAD_SECONDS)


def test_without_the_vad_the_level_finds_speech_only_where_it_moves():
    sound = SpeechMap.from_arrays(levels(10.0, SOUND))
    assert [tuple(round(x, 2) for x in r) for r in speech_regions(sound)] == [(0.9, 2.1), (2.9, 3.6)]
    flat = SpeechMap.from_arrays(np.full(1000, -20.0, dtype=np.float32))
    assert speech_regions(flat) == []


# --------------------------------------------------------------------------------------- recovery


def test_speech_whisper_left_out_is_transcribed_again_in_one_call(speech):
    segments = [seg(1.0, 2.0, [(1.0, 2.0, "Covered")])]
    regions = speech_regions(speech)
    assert uncovered(segments, regions) == [regions[1]]
    calls = []

    def again(clips, language):
        calls.append((clips, language))
        return [
            {
                **seg(2.9, 3.6, [(1.2, 1.5, "dupe"), (3.0, 3.2, "Missed"), (3.2, 3.5, "line.")]),
                "text": "dupe Missed line.",
            }
        ]

    merged = recover_missed(segments, regions, again, speech.duration, "en")
    assert len(calls) == 1
    ((clip,),), language = calls[0][0:1], calls[0][1]
    assert language == "en"
    assert clip[0] == pytest.approx(regions[1][0] - alignment.RECOVER_PAD_S)
    # The word that lands on speech already transcribed is left out; the line is its kept words.
    assert [s["text"] for s in merged] == ["line", "Missed line."]
    assert (merged[1]["start"], merged[1]["end"]) == (3.0, 3.5)


def test_nothing_is_transcribed_again_when_everything_is_covered(speech):
    segments = [seg(1.0, 2.0, [(1.0, 2.0, "a")]), seg(3.0, 3.5, [(3.0, 3.5, "b")])]

    def again(clips, language):
        raise AssertionError("no call expected")

    assert recover_missed(segments, speech_regions(speech), again, speech.duration) == segments


# ---------------------------------------------------------------------------------- hallucinations


def test_a_made_up_line_over_silence_is_dropped_and_real_lines_kept(speech):
    regions = speech_regions(speech)
    kept = drop_hallucinations(
        [
            seg(1.0, 2.0, None, "real but unsure", avg_logprob=-1.4),
            seg(6.0, 7.0, None, "Thanks for watching.", avg_logprob=-1.4, no_speech_prob=0.8),
            seg(8.0, 9.0, None, "sure of itself", avg_logprob=-0.1),
        ],
        speech,
        regions,
    )
    assert [s["text"] for s in kept] == ["real but unsure", "sure of itself"]


def test_align_runs_recovery_drops_and_refines_in_order(speech):
    calls = []

    def again(clips, language):
        calls.append(clips)
        return [seg(3.0, 3.4, [(3.05, 3.4, "Found.")], "Found.")]

    out = align(
        [
            seg(1.2, 1.8, [(1.2, 1.8, "Hello.")], "Hello."),
            seg(6.0, 7.0, [(6.0, 7.0, "Bye.")], avg_logprob=-2.0),
        ],
        speech,
        again,
    )
    assert len(calls) == 1
    assert [(s["text"], s["start"], s["end"]) for s in out] == [("Hello.", 1.0, 2.0), ("Found.", 3.0, 3.5)]


# ------------------------------------------------------------------------------------------- shift


def test_shift_moves_lines_and_words_and_drops_what_falls_before_zero():
    lines = [seg(0.1, 0.4, [(0.1, 0.4, "gone")]), seg(0.3, 1.0, [(0.3, 0.45, "cut"), (0.6, 1.0, "kept")])]
    out = shift(lines, -0.5)
    assert len(out) == 1
    assert (out[0]["start"], out[0]["end"]) == (0.0, 0.5)
    assert [w["text"] for w in out[0]["words"]] == ["kept"]
    assert shift(lines, 0.0) is lines


# ------------------------------------------------------------------------------- reading the sound


@needs_ffmpeg
def test_the_level_is_read_through_a_pipe_every_10_ms(tmp_path):
    wav = tmp_path / "tone.wav"
    graph = "sine=frequency=300:sample_rate=16000:duration=1,volume=0.5[a];anullsrc=r=16000:cl=mono,atrim=0:2[b];[b][a]concat=n=2:v=0:a=1"
    subprocess.run(
        ["ffmpeg", "-v", "error", "-y", "-filter_complex", graph, "-ac", "1", "-ar", "16000", str(wav)],
        check=True,
    )
    speech = build_speech_map(str(wav), use_vad=False)
    assert speech.vad is None
    assert speech.duration == pytest.approx(3.0, abs=0.02)
    assert speech.level_db[50] <= alignment.LEVEL_FLOOR_DBFS + 1
    assert speech.level_db[250] > -40  # lavfi sine is 1/8 full scale; at half that, about -27 dBFS
    (region,) = speech_regions(speech)
    assert region == pytest.approx((2.0 - alignment.REGION_PAD_S, 3.0), abs=0.02)


@needs_ffmpeg
@pytest.mark.skipif(not alignment.vad_available(), reason="needs onnxruntime")
def test_silero_runs_in_chunks_and_hears_no_speech_in_a_tone(tmp_path):
    wav = tmp_path / "tone.wav"
    subprocess.run(
        [
            "ffmpeg",
            "-v",
            "error",
            "-y",
            "-f",
            "lavfi",
            "-i",
            "sine=frequency=440:duration=20",
            "-ar",
            "16000",
            str(wav),
        ],
        check=True,
    )
    speech = build_speech_map(str(wav))
    assert speech.vad is not None and len(speech.vad) == pytest.approx(20 / VAD_SECONDS, abs=1)
    assert speech_regions(speech) == []
