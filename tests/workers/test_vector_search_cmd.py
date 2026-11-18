"""The `vector-search` and `vlm-tags` commands (workers/vector_search_cmd.py): bin analysis's reads of the
semantic index and of the VLM's cached shot tags."""

from __future__ import annotations

import io
import json
import os

import pytest

from vibecut_agent.config import OrchestratorConfig
from vibecut_agent.headless import COMMANDS, dispatch
from vibecut_agent.orchestrator.schemas import VECTOR_SEARCH_ID, validate
from vibecut_agent.protocol import Emitter, RequestError
from vibecut_agent.workers import vector_search_cmd
from vibecut_agent.workers.vector_store import VectorStore
from vibecut_agent.workers.vlm_worker import CACHE_VERSION, write_cache

from .test_vector_store import BROLL, WordEmbedder, needs_sqlite_vec


def events(out: io.StringIO) -> list[dict]:
    return [json.loads(line) for line in out.getvalue().splitlines()]


def test_the_commands_are_registered():
    assert "vector-search" in COMMANDS and "vlm-tags" in COMMANDS


def test_search_requests_are_checked():
    with pytest.raises(RequestError, match="query"):
        vector_search_cmd.parse_search({"query": " "})
    with pytest.raises(RequestError, match="modality"):
        vector_search_cmd.parse_search({"query": "harbor", "modality": "smell"})
    with pytest.raises(RequestError, match="top_k"):
        vector_search_cmd.parse_search({"query": "harbor", "top_k": 40})
    with pytest.raises(RequestError):
        vector_search_cmd.parse_search({"query": "harbor", "scope_paths": ["relative/clip.mov"]})
    options = vector_search_cmd.parse_search({"query": " harbor ", "scope_paths": ["/shoot/drone"]})
    assert options == {
        "query": "harbor",
        "modality": "visual",
        "scope_paths": ["/shoot/drone"],
        "filters": None,
        "top_k": 8,
    }


@needs_sqlite_vec
def test_search_answers_with_a_vector_result(monkeypatch, tmp_path):
    monkeypatch.setenv("VIBECUT_INDEX_DIR", str(tmp_path))
    store = VectorStore(OrchestratorConfig.from_env("orchestrated"), embedder=WordEmbedder())
    store.index_shots(BROLL)
    out = io.StringIO()
    request = {"query": "bread dough", "scope_paths": ["/shoot/broll"], "top_k": 3}
    assert vector_search_cmd.run_search(request, Emitter(out), store=store) == 0
    [event] = events(out)
    assert event.pop("type") == "result"
    validate(event, VECTOR_SEARCH_ID)
    assert event["hits"][0]["evidence"]["vlm_description"].startswith("Hands kneading")
    # Out of scope, nothing.
    out = io.StringIO()
    vector_search_cmd.run_search(
        {"query": "bread dough", "scope_paths": ["/elsewhere"]}, Emitter(out), store=store
    )
    assert events(out)[0]["hits"] == []


def media_with_tags(tmp_path, name="kitchen.mov"):
    path = tmp_path / name
    path.write_bytes(b"not really a movie")
    stat = os.stat(path)
    result = {
        **BROLL,
        "media_path": str(path),
        "video_size": stat.st_size,
        "video_mtime": int(stat.st_mtime),
        "vlm_model_id": "qwen3-vl:8b-instruct",
    }
    assert write_cache(str(path), "scene_cuts", result)
    return str(path)


def test_tags_are_read_from_the_cache_without_a_model(tmp_path, monkeypatch):
    def refuse(*_args, **_kwargs):
        raise AssertionError("vlm-tags must never build a worker")

    monkeypatch.setattr("vibecut_agent.workers.vlm_worker.VlmWorker.__init__", refuse)
    tagged = media_with_tags(tmp_path)
    untagged = str(tmp_path / "plain.mov")
    open(untagged, "wb").close()
    out = io.StringIO()
    assert vector_search_cmd.run_tags({"paths": [tagged, untagged, tagged]}, Emitter(out)) == 0
    [event] = events(out)
    first, second = event["files"]
    assert first["path"] == tagged and first["model"] == "qwen3-vl:8b-instruct"
    assert first["shots"][0] == {
        "start": 0.0,
        "end": 5.0,
        "shot_scale": "CU",
        "camera_movement": "STATIC",
        "description": "Hands kneading bread dough on a floured table",
        "visual_tags": ["bread", "hands", "kitchen"],
        "editorial_usability_score": 82,
    }
    assert first["shots"][1]["start"] == 5.0 and first["shots"][1]["end"] == 9.0
    assert second == {"path": untagged, "shots": None}
    assert "health" not in event


def test_a_stale_cache_counts_as_none(tmp_path):
    path = media_with_tags(tmp_path)
    with open(path, "ab") as f:
        f.write(b" grown")
    assert vector_search_cmd.read_tags(path) is None
    path = media_with_tags(tmp_path, "older.mov")
    with open(path + ".vlm-tags.json", encoding="utf-8") as f:
        data = json.load(f)
    data["cache_version"] = CACHE_VERSION - 1
    with open(path + ".vlm-tags.json", "w", encoding="utf-8") as f:
        json.dump(data, f)
    assert vector_search_cmd.read_tags(path) is None


def test_tags_ask_for_health_only_when_told(tmp_path, monkeypatch):
    monkeypatch.setattr(
        vector_search_cmd,
        "health",
        lambda config: {"vlm": {"model": "qwen", "available": False, "detail": "not pulled"}},
    )
    out = io.StringIO()
    vector_search_cmd.run_tags({"paths": [], "health": True}, Emitter(out))
    assert events(out)[0]["health"]["vlm"]["detail"] == "not pulled"


def test_the_tags_command_runs_through_dispatch(tmp_path):
    tagged = media_with_tags(tmp_path)
    out = io.StringIO()
    assert dispatch("vlm-tags", Emitter(out), io.StringIO(json.dumps({"paths": [tagged]}))) == 0
    assert events(out)[0]["files"][0]["shots"][0]["shot_scale"] == "CU"
    out = io.StringIO()
    assert dispatch("vlm-tags", Emitter(out), io.StringIO(json.dumps({"paths": ["relative.mov"]}))) == 2
    assert events(out)[0]["type"] == "error"
