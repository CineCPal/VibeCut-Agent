"""The orchestrator's tool bus (orchestrator/tool_bus.py): argument checks, routing to the workers, the
propose/commit handshake through the app, and results cut to fit."""

from __future__ import annotations

import copy
import importlib.util
import json

import pytest

from tests.orchestrator.app import App, Worker, make_bus
from tests.orchestrator.timeline import delta, make_media, make_snapshot, op, ref, tr
from vibecut_agent.agent.chat_steps import ChatError
from vibecut_agent.config import OrchestratorConfig
from vibecut_agent.core import ffmpeg_ops
from vibecut_agent.orchestrator import tool_bus
from vibecut_agent.orchestrator.otio_delta import timeline_hash
from vibecut_agent.orchestrator.schemas import ORCHESTRATOR_TOOLS, OTIO_DELTA_ID, errors_against, errors_in
from vibecut_agent.orchestrator.tool_bus import claude_tools, fit, inline_refs
from vibecut_agent.workers.base import GpuLockTimeout

HAS_OTIO = importlib.util.find_spec("opentimelineio") is not None


@pytest.fixture
def media(tmp_path):
    return make_media(tmp_path)


@pytest.fixture
def snapshot(media):
    return make_snapshot(media)


@pytest.fixture
def config():
    return OrchestratorConfig.from_env("orchestrated")


# ------------------------------------------------------------------------------ Claude's tool list


def test_claudes_tools_stand_alone_and_check_what_the_spec_does(media):
    tools = claude_tools()
    assert [t["name"] for t in tools] == [t["name"] for t in ORCHESTRATOR_TOOLS]
    assert "$ref" not in json.dumps(tools)
    assert "$defs" not in json.dumps(tools)
    delta_schema = next(t for t in tools if t["name"] == "propose_otio_delta")["parameters"]["properties"][
        "delta"
    ]
    operation = delta_schema["properties"]["operations"]["items"]
    assert "track_Selector" in operation["properties"]
    assert operation["properties"]["source_range"]["properties"]["start_time"]["required"]
    # The inlined schema takes and refuses what the referenced one does.
    good = delta(op("op_001", "DELETE_CLIP", clip_id="c1"))
    bad = delta(op("op_1", "DELETE_CLIP", clip_id="c1"))
    placed = delta(
        op(
            "op_001",
            "INSERT_CLIP",
            media_reference=ref(media["a.mov"]),
            source_range=tr(0, 25),
            timeline_range=tr(0, 25),
        )
    )
    for document in (good, bad, placed):
        assert bool(errors_against(document, delta_schema)) == bool(errors_in(document, OTIO_DELTA_ID))
    assert errors_against(bad, delta_schema)


def test_inline_refs_resolves_relative_and_absolute_refs():
    schema = {
        "$ref": "https://vibecut.local/schemas/common_time.json#/$defs/TimeRange",
        "description": "where",
    }
    inlined = inline_refs(schema)
    assert inlined["description"] == "where"
    assert inlined["properties"]["duration"]["properties"]["value"]["type"]
    assert "$ref" not in json.dumps(inlined)


# ------------------------------------------------------------------------------ arguments and failures


def test_arguments_that_dont_fit_are_refused_before_any_worker_runs(config, tmp_path):
    bus = make_bus(config, tmp_path)
    result = bus.dispatch("semantic_asset_search", {"query": "x"})
    assert result["error"] == "The arguments don't fit semantic_asset_search's schema"
    assert any("modality" in d for d in result["details"])
    assert bus.dispatch("ripple_delete", {}) == {
        "error": "ripple_delete isn't one of the orchestrator's tools"
    }
    assert bus.handles("commit_otio_delta") and not bus.handles("list_markers")


def test_a_busy_gpu_a_failing_worker_and_a_broken_exchange(config, tmp_path):
    args = {"query": "laughing", "modality": "dialogue"}
    busy = make_bus(config, tmp_path, vector=Worker(GpuLockTimeout("held")))
    assert "busy" in busy.dispatch("semantic_asset_search", args)["error"]
    failing = make_bus(config, tmp_path, vector=Worker(RuntimeError("the index is corrupt")))
    assert failing.dispatch("semantic_asset_search", args) == {
        "error": "semantic_asset_search failed: the index is corrupt"
    }
    broken = make_bus(config, tmp_path, vector=Worker(ChatError("Tool result for unknown call id 'x'")))
    with pytest.raises(ChatError):
        broken.dispatch("semantic_asset_search", args)


# ------------------------------------------------------------------------------ the workers' tools


def test_search_goes_to_the_vector_store(config, tmp_path):
    vector = Worker({"hits": []})
    bus = make_bus(config, tmp_path, vector=vector)
    args = {
        "query": "she laughs",
        "modality": "hybrid",
        "scope_paths": ["/Volumes/Shoot"],
        "filters": {"shot_scales": ["CU"]},
        "top_k": 3,
    }
    assert bus.dispatch("semantic_asset_search", args) == {"hits": []}
    assert vector.calls == [
        (
            "search",
            ("she laughs", "hybrid"),
            {"scope_paths": ["/Volumes/Shoot"], "filters": {"shot_scales": ["CU"]}, "top_k": 3},
        )
    ]
    relative = bus.dispatch("semantic_asset_search", {**args, "scope_paths": ["Shoot"]})
    assert relative == {"error": "scope_paths must be absolute paths"}


def test_transcribe_passes_the_window_and_reports_progress(config, tmp_path, media):
    whisper = Worker({"segments": []})
    bus = make_bus(config, tmp_path, whisper=whisper)
    args = {"media_path": media["a.mov"], "source_range_seconds": {"start": 2, "end": 5}}
    assert bus.dispatch("transcribe_and_align", args) == {"segments": []}
    _, positional, keywords = whisper.calls[0]
    assert positional == (media["a.mov"],)
    assert (keywords["start"], keywords["end"], keywords["model_tier"]) == (2, 5, None)
    assert keywords["enable_diarization"] is False
    assert bus.statuses == ["a.mov: half way"]
    backwards = bus.dispatch("transcribe_and_align", {**args, "source_range_seconds": {"start": 5, "end": 2}})
    assert backwards == {"error": "The range ends before it starts"}
    speakers = bus.dispatch("transcribe_and_align", {**args, "enable_diarization": True})
    assert "Hugging Face token" in speakers["error"]
    missing = bus.dispatch("transcribe_and_align", {"media_path": str(tmp_path / "gone.mov")})
    assert "isn't there" in missing["error"]
    relative = bus.dispatch("transcribe_and_align", {"media_path": "a.mov"})
    assert relative == {"error": "media_path must be an absolute path"}


def test_shot_analysis_goes_to_the_vlm(config, tmp_path, media):
    vlm = Worker({"shots": []})
    bus = make_bus(config, tmp_path, vlm=vlm)
    args = {
        "media_path": media["b.mov"],
        "start_seconds": 1,
        "end_seconds": 9,
        "custom_prompt_focus": "eyeline",
    }
    assert bus.dispatch("analyze_shot_visuals", args) == {"shots": []}
    _, _, keywords = vlm.calls[0]
    assert (keywords["start"], keywords["end"], keywords["sample_strategy"]) == (1, 9, "scene_cuts")
    assert keywords["custom_prompt_focus"] == "eyeline"


def test_boundaries_run_the_detectors_asked_for(config, tmp_path, media, monkeypatch):
    seen = {}

    def silences(path, **kwargs):
        seen["silence"] = kwargs
        return [{"seconds": 1.0}]

    def cuts(path, **kwargs):
        seen["cuts"] = kwargs
        raise ffmpeg_ops.FfmpegOpError("The file has no picture")

    monkeypatch.setattr(ffmpeg_ops, "detect_silences", silences)
    monkeypatch.setattr(ffmpeg_ops, "detect_scene_cuts", cuts)
    bus = make_bus(config, tmp_path)
    path = media["a.mov"]
    result = bus.dispatch(
        "detect_media_boundaries", {"media_path": path, "detectors": ["silence", "loudness"]}
    )
    assert result == {
        "media_path": path,
        "start_seconds": 0.0,
        "end_seconds": None,
        "silences": [{"seconds": 1.0}],
        "loudness": {"integratedLufs": -23.0, "path": path},
    }
    assert seen["silence"] == {"start": 0.0, "end": None, "noise_db": -35.0, "min_duration": 0.35}
    failed = bus.dispatch(
        "detect_media_boundaries",
        {"media_path": path, "detectors": ["scene_cuts"], "scene_cut_sensitivity": "high"},
    )
    assert failed == {"error": "The file has no picture"}
    assert seen["cuts"]["sensitivity"] == "high"


# ------------------------------------------------------------------------------ fit


def test_a_long_result_loses_its_words_then_its_later_entries():
    words = [{"word": "w" * 20, "start": 0.0, "end": 0.1}] * 20
    transcript = {
        "schema_version": "vibecut.whisper.v2",
        "segments": [{"id": i, "text": "x" * 200, "words": words} for i in range(60)],
    }
    assert fit(transcript, limit=10**7) is transcript
    slim = fit(transcript, limit=8000)
    assert len(json.dumps(slim)) <= 8000
    assert all("words" not in s for s in slim["segments"])
    assert slim["segments"][0]["id"] == 0
    assert "word timings were left out" in slim["truncated"]
    assert "of 60 segments" in slim["truncated"]
    roomy = fit(
        transcript,
        limit=len(json.dumps({**transcript, "segments": [{"id": i, "text": "x" * 200} for i in range(60)]}))
        + 500,
    )
    assert len(roomy["segments"]) == 60
    assert "only the first" not in roomy["truncated"]
    assert fit({"blob": "x" * 100}, limit=50)["error"].startswith("The result was too long to send")


# ------------------------------------------------------------------------------ propose and commit


def removal():
    return {"delta": delta(op("op_001", "DELETE_CLIP", clip_id="c2"))}


def test_a_valid_delta_is_kept_for_its_commit(config, tmp_path, snapshot):
    app = App(snapshot)
    bus = make_bus(config, tmp_path, app)
    result = bus.dispatch("propose_otio_delta", removal())
    assert result["valid"] is True
    assert result["validator_model"] == "deterministic"
    assert app.names() == ["list_timelines", "list_timeline_clips"]
    token = result["validation_token"]
    assert set(bus.proposals) == {token}

    outcome = bus.dispatch(
        "commit_otio_delta", {"validation_token": token, "commit_summary": "Drop the second shot"}
    )
    assert outcome == {"committed": True}
    assert app.names()[2:] == ["list_timelines", "list_timeline_clips", "commit_otio_delta"]
    commit = app.calls[-1][1]
    assert commit["validationToken"] == token
    assert commit["deltaId"] == "delta_0001"
    assert commit["commitSummary"] == "Drop the second shot"
    assert (commit["host"], commit["timeline"]) == ("premiere", "Cut")
    assert commit["batch"] == result["translated_nle_batch"]
    assert [c["command"] for c in commit["batch"]] == ["backup_timeline", "delete_clips"]
    # The editor checks this again just before it edits (nle/bridge_runner.py).
    assert commit["expectedTimelineHash"] == timeline_hash(snapshot)
    if HAS_OTIO:
        assert commit["otioPath"] == str(tmp_path / "otio_deltas" / "delta_0001.otio")
        assert (tmp_path / "otio_deltas" / "delta_0001.otio").is_file()
    else:
        assert "otioPath" not in commit
    # A token is used once.
    again = bus.dispatch("commit_otio_delta", {"validation_token": token, "commit_summary": "Drop it again"})
    assert "already committed" in again["error"]


def test_an_invalid_delta_gets_no_token(config, tmp_path, snapshot):
    bus = make_bus(config, tmp_path, App(snapshot))
    result = bus.dispatch("propose_otio_delta", {"delta": delta(op("op_001", "DELETE_CLIP", clip_id="zz"))})
    assert result["valid"] is False
    assert result["diagnostics"][0]["code"] == "UNKNOWN_CLIP_ID"
    assert bus.proposals == {}
    unknown = bus.dispatch(
        "commit_otio_delta", {"validation_token": "vtok_" + "0" * 32, "commit_summary": "Try it"}
    )
    assert "isn't from a passing propose_otio_delta" in unknown["error"]


def test_a_timeline_changed_since_the_proposal_is_stale(config, tmp_path, snapshot):
    app = App(snapshot)
    bus = make_bus(config, tmp_path, app)
    token = bus.dispatch("propose_otio_delta", removal())["validation_token"]
    app.snapshot = copy.deepcopy(snapshot)
    app.snapshot["tracks"][0]["clips"][1]["start"] = 4.04
    outcome = bus.dispatch(
        "commit_otio_delta", {"validation_token": token, "commit_summary": "Drop the shot"}
    )
    assert outcome["error"].startswith("STALE_TIMELINE_HASH")
    assert "commit_otio_delta" not in app.names()
    assert bus.proposals == {}


def test_an_app_that_cant_commit_keeps_the_token(config, tmp_path, snapshot):
    app = App(snapshot, commit_result={"error": "Unknown tool: commit_otio_delta"})
    bus = make_bus(config, tmp_path, app)
    token = bus.dispatch("propose_otio_delta", removal())["validation_token"]
    args = {"validation_token": token, "commit_summary": "Drop the shot"}
    assert bus.dispatch("commit_otio_delta", args) == {"error": "Unknown tool: commit_otio_delta"}
    assert token in bus.proposals
    app.commit_result = {"committed": True}
    assert bus.dispatch("commit_otio_delta", args) == {"committed": True}


def test_only_incremental_commits_are_offered(config, tmp_path, snapshot):
    app = App(snapshot)
    bus = make_bus(config, tmp_path, app)
    token = bus.dispatch("propose_otio_delta", removal())["validation_token"]
    rebuild = bus.dispatch(
        "commit_otio_delta",
        {
            "validation_token": token,
            "commit_summary": "Drop the shot",
            "execution_strategy": "otio_timeline_rebuild",
        },
    )
    assert "Only incremental_bridge" in rebuild["error"]
    assert token in bus.proposals


def test_a_timeline_that_cant_be_read_is_said_so(config, tmp_path, snapshot):
    app = App(snapshot)
    app.fail["list_timeline_clips"] = "No timeline is open in Premiere Pro."
    bus = make_bus(config, tmp_path, app)
    result = bus.dispatch("propose_otio_delta", removal())
    assert result == {"error": "Couldn't read the timeline: No timeline is open in Premiere Pro."}
    unreached = make_bus(config, tmp_path)
    assert unreached.dispatch("propose_otio_delta", removal()) == {
        "error": "The editor can't be reached from here"
    }


def test_a_delta_id_is_only_ever_a_plain_file_name(config, tmp_path, snapshot):
    pytest.importorskip("opentimelineio")
    app = App(snapshot)
    bus = make_bus(config, tmp_path, app)
    d = removal()
    d["delta"]["delta_id"] = "../../../escape"
    token = bus.dispatch("propose_otio_delta", d)["validation_token"]
    bus.dispatch("commit_otio_delta", {"validation_token": token, "commit_summary": "Drop the shot"})
    assert app.calls[-1][1]["otioPath"] == str(tmp_path / "otio_deltas" / "_________escape.otio")


def test_default_workers_wait_only_so_long_for_the_gpu(config):
    whisper = tool_bus.default_workers(config)["whisper"]()
    assert whisper.lock.timeout == tool_bus.CHAT_LOCK_TIMEOUT_SECONDS


def test_the_bus_hashes_the_apps_timeline_as_the_editor_hashes_its_own(snapshot):
    """The bus reads the timeline through the app; the batch runner reads it in the editor. Both must hash
    the same, or every commit would be refused as stale."""
    app = App(snapshot)
    status, clips = app.answer("list_timelines", {}), app.answer("list_timeline_clips", {"detail": True})
    assert timeline_hash(tool_bus._snapshot_from(status, clips)) == timeline_hash(snapshot)
