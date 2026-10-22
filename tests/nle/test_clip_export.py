"""export_clips (clip_export.py): each timeline clip cut from its own source file with ffmpeg, the same
on Premiere and Resolve."""

import json
import shutil
import subprocess
import time

import pytest

from tests.nle.fakes import sequence
from vibecut_agent.nle import clip_export
from vibecut_agent.nle.clip_export import (
    cancel_clip_export,
    choose,
    clip_export_status,
    export_clips,
    ffmpeg_args,
)
from vibecut_agent.nle.errors import HostError
from vibecut_agent.nle.premiere import timeline as premiere_timeline

needs_ffmpeg = pytest.mark.skipif(shutil.which("ffmpeg") is None, reason="ffmpeg isn't installed")


@pytest.fixture
def renders(tmp_path, monkeypatch):
    monkeypatch.setenv("VIBECUT_RENDERS_DIR", str(tmp_path / "renders"))
    return tmp_path / "renders"


def clip(clip_id, path, start, end, source_in, **extra):
    return {"id": clip_id, "name": extra.pop("name", path.rsplit("/", 1)[-1]), "start": start, "end": end,
            "enabled": True, "sourceIn": source_in, "sourceOut": source_in + end - start, "filePath": path, **extra}  # fmt: skip


def view(video, audio=(), project="Doc", name="Main"):
    return {
        "project": project,
        "timeline": name,
        "tracks": [
            {"type": "video", "index": 1, "clips": list(video)},
            {"type": "audio", "index": 1, "clips": list(audio)},
            {"type": "subtitle", "index": 1, "clips": [{"id": "s1", "name": "Hello", "start": 0, "end": 1}]},
        ],
    }


class Host:
    def __init__(self, timeline):
        self.timeline = timeline
        self.asked = []

    def read_timeline(self, args):
        self.asked.append(args)
        return self.timeline


def media(tmp_path, name):
    path = tmp_path / name
    path.write_bytes(b"x")
    return str(path)


def test_premiere_clips_skip_what_has_no_single_source(tmp_path):
    raw = sequence()
    for track in raw["video"] + raw["audio"]:
        for c in track["clips"]:
            if c.get("mediaPath"):
                c["mediaPath"] = media(tmp_path, c["mediaPath"].rsplit("/", 1)[-1])
    items, skipped, notes = choose(premiere_timeline(raw), {})
    # A.mov's picture takes its sound from both channel tracks; B.mov is reversed at 200%.
    assert [(i["name"], i["video"], i["audio"], i["ids"]) for i in items] == [
        ("A", True, True, ["v1a", "a1a", "a2a"]),
        ("B", True, False, ["v1b"]),
    ]
    assert items[0]["in"] == pytest.approx(2.002, abs=0.01)
    assert [s["id"] for s in skipped] == ["adj"]
    assert notes == ["B plays reversed on the timeline; its file is the source at normal speed"]


def test_audio_alone_and_channel_tracks_make_one_wav(tmp_path):
    vo = media(tmp_path, "vo.wav")
    left = clip("a1", vo, 0, 2, 5)
    right = {**clip("a2", vo, 0, 2, 5), "channel": 2}
    timeline = view([], [left])
    timeline["tracks"].append({"type": "audio", "index": 2, "clips": [right]})
    items, _, _ = choose(timeline, {})
    assert [(i["ids"], i["video"], i["audio"]) for i in items] == [(["a1", "a2"], False, True)]
    assert clip_export.extension(items[0], "source") == ".wav"


def test_selection_by_ids_and_by_track(tmp_path):
    a, b = media(tmp_path, "a.mov"), media(tmp_path, "b.mov")
    timeline = view([clip("v1", a, 0, 2, 1), clip("v2", b, 2, 4, 0)], [clip("x1", b, 5, 6, 0)])
    assert [i["ids"] for i in choose(timeline, {"clipIds": ["v2", "nope"]})[0]] == [["v2"]]
    assert choose(timeline, {"clipIds": ["v2", "nope"]})[1] == [
        {"id": "nope", "name": "", "reason": "not on this timeline"}
    ]
    assert [i["ids"] for i in choose(timeline, {"track": "a1"})[0]] == [["x1"]]
    assert [i["ids"] for i in choose(timeline, {})[0]] == [["v1"], ["v2"], ["x1"]]
    with pytest.raises(HostError, match='track must be like "V1"'):
        choose(timeline, {"track": "picture"})
    with pytest.raises(HostError, match="V3 isn't a track"):
        choose(timeline, {"track": "V3"})
    with pytest.raises(HostError, match="clipIds must be"):
        choose(timeline, {"clipIds": []})


def test_skips_say_why(tmp_path):
    ok = media(tmp_path, "ok.mov")
    timeline = view([
        clip("off", "/Volumes/Gone Drive/a.mov", 0, 1, 0, offline=True),
        clip("gone", str(tmp_path / "missing.mov"), 1, 2, 0),
        clip("still", media(tmp_path, "logo.png"), 2, 3, 0),
        clip("dis", ok, 3, 4, 0, enabled=False),
        {"id": "nest", "name": "Nest", "start": 4, "end": 5, "enabled": True, "nested": True, "sourceIn": 0, "sourceOut": 1},
        {"id": "title", "name": "Title", "start": 5, "end": 6, "enabled": True, "sourceIn": 0, "sourceOut": 1},
        {"id": "tr-v1-1", "name": "Cross Dissolve", "start": 1, "end": 2, "enabled": True, "kind": "effect"},
    ])  # fmt: skip
    _, skipped, _ = choose(timeline, {})
    assert {s["id"]: s["reason"] for s in skipped} == {
        "off": "offline: its drive 'Gone Drive' isn't attached",
        "gone": "its file isn't there",
        "still": "a still image",
        "dis": "disabled on the timeline (includeDisabled exports it)",
        "nest": "a nested sequence or compound clip has no single source file",
        "title": "a title or graphic has no source file",
    }
    assert [i["ids"] for i in choose(timeline, {"includeDisabled": True})[0]] == [["dis"]]


def test_handles_are_clamped_at_the_files_start(tmp_path):
    a = media(tmp_path, "a.mov")
    items, _, _ = choose(view([clip("v1", a, 0, 2, 0.5)]), {"handles": 1})
    assert (items[0]["in"], items[0]["out"]) == (0.0, 3.5)
    with pytest.raises(HostError, match="handles must be"):
        choose(view([]), {"handles": -1})


def test_ffmpeg_args_per_format():
    item = {"path": "/m/a.mov", "in": 1.5, "out": 3.0, "video": True, "audio": True}
    args = ffmpeg_args(item, "source", "/o.mp4")
    assert args[args.index("-ss") + 1] == "1.500" and args[args.index("-t") + 1] == "1.500"
    assert args.index("-ss") < args.index("-i") and "libx264" in args and "-n" in args
    assert "prores_ks" in ffmpeg_args(item, "prores", "/o.mov")
    copy = ffmpeg_args({**item, "audio": False}, "copy", "/o.mov")
    assert "-an" in copy and copy[copy.index("-c") + 1] == "copy"
    wav = ffmpeg_args({**item, "video": False}, "source", "/o.wav")
    assert "-vn" in wav and "pcm_s24le" in wav


def test_nothing_exportable_is_an_error(renders, tmp_path):
    host = Host(view([{"id": "t", "name": "Title", "start": 0, "end": 1, "enabled": True}]))
    with pytest.raises(HostError, match=r"None of those clips can be exported \(Title: a title or graphic"):
        export_clips(host, {"timeline": "Main"})
    with pytest.raises(HostError, match="format must be one of"):
        export_clips(host, {"timeline": "Main", "format": "gif"})


def make_source(tmp_path, name, seconds=4, audio=True):
    path = tmp_path / name
    args = ["ffmpeg", "-v", "error", "-f", "lavfi", "-i", f"testsrc=s=64x36:r=24:d={seconds}"]
    if audio:
        args += ["-f", "lavfi", "-i", f"sine=d={seconds}"]
    args += (
        ["-c:v", "libx264", "-pix_fmt", "yuv420p"]
        + (["-c:a", "aac", "-shortest"] if audio else [])
        + [str(path)]
    )
    subprocess.run(args, check=True)
    return str(path)


def duration(path):
    probe = subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries", "format=duration:stream=codec_type", "-of", "json", path],
        capture_output=True, text=True, check=True,
    )  # fmt: skip
    data = json.loads(probe.stdout)
    return float(data["format"]["duration"]), sorted(s["codec_type"] for s in data["streams"])


def wait(job_id, until=("done", "failed", "cancelled"), seconds=60):
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        status = clip_export_status(None, {"jobId": job_id})
        if status["state"] in until:
            return status
        time.sleep(0.05)
    raise AssertionError("the export didn't end")


@needs_ffmpeg
def test_exports_each_clip_by_itself(renders, tmp_path):
    a = make_source(tmp_path, "A.mov")
    vo = make_source(tmp_path, "vo.mov")
    host = Host(view(
        [clip("v1", a, 0, 1, 1, linkedIds=["l1"]), clip("v2", a, 1, 2, 2.5, name="A.mov")],
        [clip("l1", a, 0, 1, 1), clip("x1", vo, 3, 4.5, 0.5)],
        project="Doc", name="Main/Cut",
    ))  # fmt: skip
    started = export_clips(host, {"timeline": "Main/Cut", "handles": 0.5})
    assert started["folder"] == str(renders / "Doc" / "Main Cut clips")
    assert started["total"] == 3
    status = wait(started["jobId"])
    assert status["state"] == "done" and status["failed"] == [] and status["fraction"] == 1.0
    names = [f.rsplit("/", 1)[-1] for f in status["files"]]
    assert names == ["01 A.mp4", "02 A.mp4", "03 vo.wav"]
    first, kinds = duration(status["files"][0])
    assert first == pytest.approx(2.0, abs=0.1) and kinds == ["audio", "video"]
    assert duration(status["files"][1])[1] == ["video"]  # no linked sound, so none in the file
    assert duration(status["files"][2])[0] == pytest.approx(2.5, abs=0.1)
    # A second export never reuses the folder.
    again = export_clips(host, {"timeline": "Main/Cut", "clipIds": ["x1"]})
    assert again["folder"] == str(renders / "Doc" / "Main Cut clips 2")
    wait(again["jobId"])


@needs_ffmpeg
def test_one_failing_clip_doesnt_stop_the_rest(renders, tmp_path):
    good = make_source(tmp_path, "good.mov")
    bad = tmp_path / "bad.mov"
    bad.write_text("not a movie")
    host = Host(view([clip("v1", str(bad), 0, 1, 0), clip("v2", good, 1, 2, 0)]))
    status = wait(export_clips(host, {"timeline": "Main"})["jobId"])
    assert status["state"] == "done" and len(status["files"]) == 1
    assert status["failed"][0]["clip"] == "bad" and status["failed"][0]["error"]
    assert sorted(p.name for p in (renders / "Doc" / "Main clips").iterdir()) == ["02 good.mp4"]


@needs_ffmpeg
def test_cancel_keeps_finished_files_and_removes_the_partial_one(renders, tmp_path):
    short = make_source(tmp_path, "short.mov", seconds=1)
    long = make_source(tmp_path, "long.mov", seconds=120, audio=False)
    host = Host(view([clip("v1", short, 0, 1, 0), clip("v2", long, 1, 121, 0)]))
    job = export_clips(host, {"timeline": "Main", "format": "prores"})["jobId"]
    deadline = time.monotonic() + 60
    while clip_export_status(None, {"jobId": job})["done"] < 1 and time.monotonic() < deadline:
        time.sleep(0.02)
    status = cancel_clip_export(None, {"jobId": job})
    assert status["state"] == "cancelled"
    assert [p.name for p in (renders / "Doc" / "Main clips").iterdir()] == ["01 short.mov"]
    with pytest.raises(HostError, match="no clip export with that jobId"):
        clip_export_status(None, {"jobId": "nope"})


@needs_ffmpeg
@pytest.mark.parametrize(
    ("size", "fmt", "expected"),
    [("1920x1080", "720p", (1280, 720)), ("1080x1920", "1080p", (1080, 1920)), ("64x36", "1080p", (64, 36))],
)
def test_1080p_and_720p_scale_the_short_side_and_never_up(renders, tmp_path, size, fmt, expected):
    source = tmp_path / f"{size}.mov"
    subprocess.run(
        [
            "ffmpeg",
            "-v",
            "error",
            "-f",
            "lavfi",
            "-i",
            f"color=black:s={size}:r=24:d=0.5",
            "-c:v",
            "libx264",
            "-pix_fmt",
            "yuv420p",
            str(source),
        ],
        check=True,
    )
    host = Host(view([clip("v1", str(source), 0, 0.5, 0)]))
    status = wait(export_clips(host, {"timeline": "Main", "format": fmt})["jobId"])
    assert status["state"] == "done", status
    probe = subprocess.run(
        ["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "csv=p=0", status["files"][0]],
        capture_output=True, text=True, check=True,
    )  # fmt: skip
    assert tuple(int(n) for n in probe.stdout.strip().split(",")) == expected
