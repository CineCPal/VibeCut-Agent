"""Renders through Media Encoder (premiere_render.py, PLAN.md "Phase 15b"), VibeCut's
test_premiere_render.py ported with it (its "Phase 7c"), without the stills test. The panel is faked: `encode`
answers with a job id the way 26.5.2 did, and the test writes the job's state file as the panel's
Media Encoder events do."""

import json
import os
from pathlib import Path
from typing import Any

import pytest

from tests.nle.vibecut_premiere.premiere_fakes import FakeRequests, info
from vibecut_agent.nle import premiere_render
from vibecut_agent.nle.premiere import HostError, PremiereHost
from vibecut_agent.nle.project import premiere_project

# The bridge's imports/ folder for each test's host: the watcher passes it to the render commands.
IMPORTS: dict[int, Path] = {}


def run_command(host: Any, command: str, args: Any) -> Any:
    return premiere_project(IMPORTS[id(host)])[command](host, args)


@pytest.fixture
def env(tmp_path, monkeypatch):
    monkeypatch.setenv("VIBECUT_RENDERS_DIR", str(tmp_path / "renders"))
    presets = tmp_path / "systempresets"
    for file, _ext in premiere_render.PRESETS.values():
        (presets / file).parent.mkdir(parents=True, exist_ok=True)
        (presets / file).write_text("<epr/>")
    monkeypatch.setenv("VIBECUT_AME_PRESETS", str(presets))
    premiere_render.JOBS.clear()
    jobs = iter(f"job-{n}" for n in range(1, 100))
    requests = FakeRequests(
        {
            "status": {"project": "Doc/Final", "sequences": ["Interview"]},
            "sequence_info": info(seconds_long=20),
            "encode": lambda args: {
                "jobId": next(jobs),
                "seconds": (args.get("outSeconds", 20) - args.get("inSeconds", 0)),
            },
            "encode_cancel": {"stopped": True},
        }
    )
    bridge = tmp_path / "bridge"
    (bridge / "imports").mkdir(parents=True)
    host = PremiereHost(requests)
    IMPORTS[id(host)] = bridge / "imports"
    return host, requests, tmp_path


def event(tmp_path, job, kind, **state):
    """Writes the panel's <jobId>.<kind>.json, as its Media Encoder events do."""
    states = tmp_path / "bridge" / "renders"
    states.mkdir(exist_ok=True)
    (states / f"{job}.{kind}.json").write_text(json.dumps(state))


def test_a_render_is_queued_with_media_encoders_own_preset_and_followed(env):
    host, requests, tmp_path = env
    started = run_command(
        host,
        "render_video",
        {"timeline": "Interview", "preset": "720p", "name": "rough"},
    )
    folder = tmp_path / "renders" / "Doc Final"
    assert started == {
        "jobId": "job-1",
        "path": str(folder / "Interview - rough.mp4"),
        "seconds": 20.0,
    }
    (sent,) = requests.sent("encode")
    assert sent["workArea"] == 0 and sent["out"] == started["path"]
    assert sent["preset"].endswith("4E49434B_48323634/High Quality 720 HD.epr")

    assert run_command(host, "render_status", {"jobId": "job-1"}) == {
        "state": "rendering",
        "seconds": 20.0,
        "fraction": 0.0,
    }
    event(tmp_path, "job-1", "progress", fraction=0.42)
    assert run_command(host, "render_status", {"jobId": "job-1"})["fraction"] == 0.42
    (folder / "Interview - rough.mp4").write_text("movie")
    event(tmp_path, "job-1", "done", path=started["path"])
    assert run_command(host, "render_status", {"jobId": "job-1"}) == {
        "state": "done",
        "seconds": 20.0,
        "path": started["path"],
    }
    assert list((tmp_path / "bridge" / "renders").iterdir()) == []


def test_ranges_and_audio(env):
    host, requests, _tmp = env
    started = run_command(
        host,
        "render_audio",
        {"timeline": "Interview", "format": "wav", "range": {"start": 5, "end": 10}},
    )
    assert started["path"].endswith("Interview.wav") and started["seconds"] == 5
    sent = requests.sent("encode")[-1]
    assert (sent["workArea"], sent["inSeconds"], sent["outSeconds"]) == (1, 5, 10)
    assert sent["preset"].endswith("Waveform Audio 48kHz 16-bit.epr")
    run_command(
        host,
        "render_audio",
        {"timeline": "Interview", "format": "aac", "range": "in_out"},
    )
    sent = requests.sent("encode")[-1]
    assert (
        sent["workArea"] == 1
        and "inSeconds" not in sent
        and sent["out"].endswith(".aac")
    )


def test_bad_requests_never_reach_media_encoder(env):
    host, requests, _tmp = env
    for command, args, message in (
        ("render_video", {"preset": "4k"}, "preset must be one of"),
        ("render_audio", {"format": "flac"}, "format must be one of"),
        ("render_video", {"range": {"start": 15, "end": 25}}, "within the sequence"),
        ("render_video", {"range": "the middle"}, "range must be"),
    ):
        with pytest.raises(HostError, match=message):
            run_command(host, command, {"timeline": "Interview", **args})
    assert requests.sent("encode") == []


def test_a_failure_removes_the_partial_file(env):
    host, _requests, tmp_path = env
    started = run_command(
        host, "render_video", {"timeline": "Interview", "preset": "prores"}
    )
    assert started["path"].endswith(".mov")
    with open(started["path"], "w") as f:
        f.write("partial")
    event(tmp_path, "job-1", "failed", error="Disk full")
    assert run_command(host, "render_status", {"jobId": "job-1"}) == {
        "state": "failed",
        "seconds": 20.0,
        "error": "Disk full",
    }
    assert not os.path.exists(started["path"])


def test_done_without_a_file_is_a_failure(env):
    host, _requests, tmp_path = env
    run_command(host, "render_video", {"timeline": "Interview"})
    event(tmp_path, "job-1", "done", path="/somewhere/else.mp4")
    result = run_command(host, "render_status", {"jobId": "job-1"})
    assert result["state"] == "failed" and "isn't there" in result["error"]


def test_cancel_stops_the_batch_and_says_so(env):
    host, requests, tmp_path = env
    started = run_command(host, "render_video", {"timeline": "Interview"})
    with open(started["path"], "w") as f:
        f.write("partial")
    result = run_command(host, "cancel_render", {"jobId": "job-1"})
    assert result["state"] == "cancelled" and "whole queue" in result["note"]
    assert requests.sent("encode_cancel") == [{}]
    assert not os.path.exists(started["path"])
    assert (
        run_command(host, "cancel_render", {"jobId": "job-1"})["state"] == "cancelled"
    )
    assert len(requests.sent("encode_cancel")) == 1
    with pytest.raises(HostError, match="no render with that jobId"):
        run_command(host, "render_status", {"jobId": "job-7"})


def test_a_late_progress_event_cant_hide_the_end(env):
    """Media Encoder ran its handlers out of order live (7c): a progress write that started before the
    end can land after it. The end has its own file, so it still counts."""
    host, _requests, tmp_path = env
    started = run_command(
        host, "render_audio", {"timeline": "Interview", "format": "wav"}
    )
    with open(started["path"], "w") as f:
        f.write("wav")
    event(tmp_path, "job-1", "done", path=started["path"])
    event(tmp_path, "job-1", "progress", fraction=0)
    (tmp_path / "bridge" / "renders" / "job-1.progress.json.123-1-5.tmp").write_text(
        "{}"
    )
    assert run_command(host, "render_status", {"jobId": "job-1"})["state"] == "done"
    assert list((tmp_path / "bridge" / "renders").iterdir()) == []
