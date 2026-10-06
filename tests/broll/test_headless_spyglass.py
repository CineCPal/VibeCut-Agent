"""tests/test_headless_spyglass.py -- the `spyglass` command against a synthetic index (CLIP replaced)."""

import hashlib
import importlib.util
import io
import json
import os
import sys

import numpy as np
import pytest

from tests.broll.spyglass_fixture import (
    CROWD,
    LEGACY,
    OCEAN,
    ROAD,
    SCHEMA_WITH_MODEL,
    SIGLIP,
    Archive,
)
from vibecut_agent.broll import commands as headless
from vibecut_agent.broll import spyglass_index, vision_energy
from vibecut_agent.protocol import Emitter

WORDS = {"ocean": OCEAN, "crowd": CROWD, "road": ROAD}


class Capture:
    def __init__(self):
        self.buffer = io.StringIO()
        self.emitter = Emitter(self.buffer)

    def events(self):
        return [json.loads(line) for line in self.buffer.getvalue().splitlines()]

    def of_type(self, event_type):
        return [e for e in self.events() if e["type"] == event_type]


def sha(path):
    with open(path, "rb") as handle:
        return hashlib.sha256(handle.read()).hexdigest()


@pytest.fixture(autouse=True)
def fake_model(monkeypatch):
    calls = {"preload": [], "texts": 0}
    monkeypatch.setattr(vision_energy, "is_available", lambda: True)
    monkeypatch.setattr(
        vision_energy,
        "preload",
        lambda model_id=None: calls["preload"].append(model_id),
    )

    def texts(batch, model_id=None):
        calls["texts"] += len(batch)
        return np.asarray(
            [WORDS.get(t.split()[0], [0.0, 0.0, 0.0, 1.0]) for t in batch],
            dtype=np.float32,
        )

    monkeypatch.setattr(vision_energy, "encode_texts", texts)
    return calls


@pytest.fixture
def setup(tmp_path):
    """A folder of three clips: one indexed, one missing from the index, one changed since it was indexed."""
    folder = tmp_path / "broll"
    folder.mkdir()
    for name in ("waves.mp4", "new.mp4", "edited.mp4"):
        (folder / name).write_bytes(b"x" * 10)
    archive = Archive(tmp_path / "index.sqlite")
    waves = archive.clip(str(folder / "waves.mp4"), size=10)
    archive.shot(waves, 0, 6, visual=OCEAN, caption="waves rolling in", tags=["ocean", "beach"])
    archive.shot(waves, 6, 12, visual=ROAD, tags=["road"])
    edited = archive.clip(str(folder / "edited.mp4"), size=500)
    archive.shot(edited, 0, 4, visual=OCEAN, tags=["ocean"])
    return str(folder), archive.done()


def run(monkeypatch, request):
    capture = Capture()
    monkeypatch.setattr(sys, "stdin", io.StringIO(json.dumps(request)))
    code = headless.main("spyglass", capture.emitter, sys.stdin)
    return code, capture


def query(text, **extra):
    return {"id": text, "text": text, **extra}


def test_finds_shots_for_the_indexed_clips_and_lists_the_rest_with_reasons(monkeypatch, setup, fake_model):
    folder, index = setup
    code, capture = run(
        monkeypatch,
        {
            "folder": folder,
            "indexPath": index,
            "queries": [query("ocean waves", meta={"at": 3.0, "length": 4})],
        },
    )
    assert code == 0 and capture.of_type("error") == []
    (result,) = capture.of_type("result")
    assert result["indexPath"] == index and result["indexed"] == 1 and result["moved"] == 0
    assert {(os.path.basename(u["path"]), u["reason"]) for u in result["unindexed"]} == {
        ("new.mp4", "Not in the Spyglass index"),
        ("edited.mp4", "Changed since Spyglass indexed it"),
    }
    (match,) = result["matches"]
    assert match["id"] == "ocean waves" and match["meta"] == {"at": 3.0, "length": 4}
    top = match["results"][0]
    assert top["filename"] == "waves.mp4" and (top["start"], top["end"]) == (0.0, 6.0)
    assert top["caption"] == "waves rolling in" and top["tags"] == ["beach", "ocean"]
    assert all(r["filename"] == "waves.mp4" for r in match["results"])  # the stale clip's shots are not used
    assert fake_model["preload"] == [
        spyglass_index.LEGACY_EMBEDDING_MODEL
    ]  # the model this (pre-migration-013) index was embedded with


def test_it_never_changes_the_index_and_writes_nothing_into_the_folder(monkeypatch, setup):
    folder, index = setup
    before, listing = sha(index), sorted(os.listdir(folder))
    run(monkeypatch, {"folder": folder, "indexPath": index, "queries": [query("ocean")]})
    assert sha(index) == before
    assert sorted(os.listdir(folder)) == listing  # no cache or index file appeared next to the clips
    assert not os.path.exists(index + "-wal")


# ------------------------------------------------------------------------------------- catalog mode
#
# "catalog": true — the Story Editor's B-roll catalog read (see rough-cut-studio's
# gemini_client.generate_story_script). A plain listing of every indexed shot's metadata, no CLIP
# query embedding involved.


def test_catalog_mode_lists_every_indexed_shot_and_ignores_queries(monkeypatch, setup, fake_model):
    folder, index = setup
    code, capture = run(
        monkeypatch,
        {
            "folder": folder,
            "indexPath": index,
            "catalog": True,
            "queries": [query("this must be ignored")],
        },
    )
    assert code == 0 and capture.of_type("error") == []
    (result,) = capture.of_type("result")
    assert result["indexed"] == 1  # only waves.mp4 is indexed (see `setup`)
    assert result["matches"] == []  # queries are ignored in catalog mode
    catalog = result["catalog"]
    assert {c["filename"] for c in catalog} == {"waves.mp4"}
    ocean_shot = next(c for c in catalog if (c["start"], c["end"]) == (0.0, 6.0))
    assert ocean_shot["caption"] == "waves rolling in"
    assert set(ocean_shot["tags"]) == {"beach", "ocean"}
    # Doesn't touch the CLIP model at all -- a plain SQL listing needs no text embedding.
    assert fake_model["preload"] == []
    assert fake_model["texts"] == 0


def test_catalog_mode_with_nothing_indexed_returns_an_empty_catalog(monkeypatch, tmp_path):
    folder = tmp_path / "empty"
    folder.mkdir()
    (folder / "a.mp4").write_bytes(b"x")
    index = Archive(tmp_path / "empty.sqlite").done()
    code, capture = run(monkeypatch, {"folder": str(folder), "indexPath": index, "catalog": True})
    assert code == 0
    (result,) = capture.of_type("result")
    assert result["catalog"] == []
    assert result["indexed"] == 0


def test_without_queries_it_only_reports_coverage_and_needs_no_model(monkeypatch, setup, fake_model):
    folder, index = setup
    code, capture = run(monkeypatch, {"folder": folder, "indexPath": index})
    result = capture.of_type("result")[0]
    assert code == 0 and result["matches"] == [] and result["indexed"] == 1 and len(result["unindexed"]) == 2
    assert fake_model["preload"] == [] and fake_model["texts"] == 0


def test_a_folder_with_no_clips_in_the_index_says_so_and_loads_no_model(monkeypatch, tmp_path, fake_model):
    folder = tmp_path / "other"
    folder.mkdir()
    (folder / "a.mp4").write_bytes(b"x")
    index = Archive(tmp_path / "index.sqlite").done()
    _, capture = run(
        monkeypatch,
        {"folder": str(folder), "indexPath": index, "queries": [query("ocean")]},
    )
    result = capture.of_type("result")[0]
    assert result["indexed"] == 0 and result["matches"] == [] and len(result["unindexed"]) == 1
    assert any("None of the clips" in w for w in result["warnings"]) and fake_model["preload"] == []


def test_the_index_is_found_by_itself_when_none_is_given(monkeypatch, setup):
    folder, index = setup
    monkeypatch.setenv(spyglass_index.ENV_INDEX, index)
    _, capture = run(monkeypatch, {"folder": folder, "queries": [query("ocean")]})
    assert capture.of_type("result")[0]["indexPath"] == index


def test_no_index_is_a_clear_error(monkeypatch, setup, tmp_path):
    folder, _ = setup
    monkeypatch.delenv(spyglass_index.ENV_INDEX, raising=False)
    monkeypatch.setenv("HOME", str(tmp_path / "empty-home"))
    code, capture = run(monkeypatch, {"folder": folder, "queries": [query("ocean")]})
    assert code == 1 and "Spyglass index was not found" in capture.of_type("error")[0]["message"]


def test_a_file_that_is_not_a_spyglass_index_is_a_clear_error(monkeypatch, setup, tmp_path):
    folder, _ = setup
    junk = tmp_path / "junk.sqlite"
    junk.write_bytes(b"not sqlite" * 100)
    code, capture = run(
        monkeypatch,
        {"folder": folder, "indexPath": str(junk), "queries": [query("ocean")]},
    )
    assert code == 1 and "not a readable Spyglass index" in capture.of_type("error")[0]["message"]


def test_without_torch_it_explains_what_is_missing(monkeypatch, setup):
    folder, index = setup
    monkeypatch.setattr(vision_energy, "is_available", lambda: False)
    code, capture = run(monkeypatch, {"folder": folder, "indexPath": index, "queries": [query("ocean")]})
    assert code == 1 and "PyTorch" in capture.of_type("error")[0]["message"]


def test_a_model_that_cannot_load_is_reported_once(monkeypatch, setup):
    folder, index = setup

    def broken(model_id=None):
        raise vision_energy.VisionEnergyError("Failed to load local vision model: offline")

    monkeypatch.setattr(vision_energy, "preload", broken)
    code, capture = run(monkeypatch, {"folder": folder, "indexPath": index, "queries": [query("ocean")]})
    assert code == 1 and [e["message"] for e in capture.of_type("error")] == [
        "Failed to load local vision model: offline"
    ]


@pytest.mark.parametrize(
    "mutation, message",
    [
        ({"folder": "relative"}, "absolute"),
        ({"folder": "/definitely/not/here"}, "Not a folder"),
        ({"indexPath": "relative.sqlite"}, "absolute"),
        ({"queries": [{"text": " "}]}, "must be some text"),
        ({"queries": [{"text": "a"}] * 21}, "At most"),
        ({"topK": 0}, "between"),
    ],
)
def test_bad_requests_are_refused_before_the_index_is_opened(monkeypatch, setup, mutation, message):
    folder, index = setup
    code, capture = run(
        monkeypatch,
        {"folder": folder, "indexPath": index, "queries": [query("ocean")], **mutation},
    )
    assert code == 2 and message in capture.of_type("error")[0]["message"]
    assert capture.of_type("status") == []


def test_a_folder_without_video_is_an_error(monkeypatch, tmp_path):
    (tmp_path / "notes.txt").write_text("hi")
    index = Archive(tmp_path / "index.sqlite").done()
    code, capture = run(monkeypatch, {"folder": str(tmp_path), "indexPath": index})
    assert code == 1 and "No video files" in capture.of_type("error")[0]["message"]


def test_a_real_process_needs_the_energy_extra_and_speaks_clean_protocol(setup):
    import subprocess

    folder, index = setup
    src = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(headless.__file__))))
    proc = subprocess.run(
        [sys.executable, "-u", "-m", "vibecut_agent", "broll-spyglass"],
        input=json.dumps({"folder": folder, "indexPath": index, "queries": [{"text": "ocean"}]}),
        capture_output=True,
        text=True,
        cwd=src,
        env={**os.environ, "PYTHONPATH": src},
        timeout=120,
    )
    events = [json.loads(line) for line in proc.stdout.splitlines()]
    assert events[0]["type"] == "starting" and events[-1]["type"] == "done"
    if importlib.util.find_spec("torch") and importlib.util.find_spec("open_clip"):
        pytest.skip("the energy extra is installed here, so this run really loads the model")
    assert proc.returncode == 1 and "PyTorch" in next(e for e in events if e["type"] == "error")["message"]


# ------------------------------------------------------------------ clips chosen from Spyglass's tree


def clip_id_of(index, path):
    import sqlite3

    conn = sqlite3.connect(index)
    try:
        return conn.execute("SELECT id FROM clips WHERE file_path = ?", (path,)).fetchone()[0]
    finally:
        conn.close()


def test_clip_ids_search_exactly_those_clips_without_walking_a_folder(monkeypatch, setup):
    folder, index = setup
    waves = clip_id_of(index, os.path.join(folder, "waves.mp4"))
    monkeypatch.setattr(
        headless,
        "find_video_files",
        lambda _folder: pytest.fail("a clipIds search must not walk a folder"),
    )
    code, capture = run(
        monkeypatch,
        {"clipIds": [waves], "indexPath": index, "queries": [query("ocean")]},
    )
    assert code == 0 and capture.of_type("error") == []
    (result,) = capture.of_type("result")
    assert result["indexed"] == 1 and result["unindexed"] == []
    shots = result["matches"][0]["results"]
    assert {s["filename"] for s in shots} == {"waves.mp4"}
    top = shots[0]
    assert top["status"] == "ok" and isinstance(top["shotId"], int)
    assert top["keyframe"] is None and top["energy"] is None


def test_results_say_when_a_file_is_offline_or_changed(monkeypatch, setup):
    folder, index = setup
    edited = clip_id_of(index, os.path.join(folder, "edited.mp4"))
    waves = clip_id_of(index, os.path.join(folder, "waves.mp4"))
    os.remove(os.path.join(folder, "waves.mp4"))
    code, capture = run(
        monkeypatch,
        {"clipIds": [edited, waves], "indexPath": index, "queries": [query("ocean")]},
    )
    assert code == 0
    (result,) = capture.of_type("result")
    status = {s["filename"]: s["status"] for s in result["matches"][0]["results"]}
    assert status == {"edited.mp4": "changed", "waves.mp4": "offline"}


def test_unknown_clip_ids_leave_nothing_to_search(monkeypatch, setup, fake_model):
    _, index = setup
    code, capture = run(
        monkeypatch,
        {"clipIds": [987654], "indexPath": index, "queries": [query("ocean")]},
    )
    assert code == 0
    (result,) = capture.of_type("result")
    assert result["indexed"] == 0 and "any more" in result["warnings"][0]
    assert fake_model["preload"] == []


def test_catalog_mode_works_with_clip_ids(monkeypatch, setup):
    folder, index = setup
    waves = clip_id_of(index, os.path.join(folder, "waves.mp4"))
    code, capture = run(monkeypatch, {"clipIds": [waves], "indexPath": index, "catalog": True})
    assert code == 0
    (result,) = capture.of_type("result")
    assert len(result["catalog"]) == 2


@pytest.mark.parametrize(
    "request_fields, message",
    [
        ({"clipIds": []}, "non-empty"),
        ({"clipIds": ["1"]}, "whole numbers"),
        ({"clipIds": [True]}, "whole numbers"),
        ({"clipIds": list(range(50_001))}, "At most"),
        ({"clipIds": [1], "folder": "/tmp"}, "not both"),
    ],
)
def test_bad_clip_ids_are_refused(monkeypatch, setup, request_fields, message):
    _, index = setup
    code, capture = run(monkeypatch, {"indexPath": index, "queries": [query("ocean")], **request_fields})
    assert code == 2 and message in capture.of_type("error")[0]["message"]


# ------------------------------------------------------------------ embedding models (suite migration 013)


@pytest.fixture
def mixed(tmp_path):
    """A migrated index whose folder has one shot Spyglass re-indexed with SigLIP 2 and one still on CLIP."""
    folder = tmp_path / "mixed"
    folder.mkdir()
    for name in ("new.mp4", "old.mp4"):
        (folder / name).write_bytes(b"x" * 10)
    archive = Archive(tmp_path / "index.sqlite", schema=SCHEMA_WITH_MODEL)
    new = archive.clip(str(folder / "new.mp4"), size=10)
    archive.shot(new, 0, 5, visual=OCEAN, model=SIGLIP)
    old = archive.clip(str(folder / "old.mp4"), size=10)
    archive.shot(old, 0, 5, visual=OCEAN, model=LEGACY)
    return str(folder), archive.done()


def test_a_legacy_index_loads_only_the_legacy_model(monkeypatch, setup, fake_model):
    folder, index = setup
    code, capture = run(monkeypatch, {"folder": folder, "indexPath": index, "queries": [query("ocean")]})
    (result,) = capture.of_type("result")
    assert code == 0 and fake_model["preload"] == [LEGACY]
    assert result["models"] == {LEGACY: 2}
    assert result["matches"][0]["results"][0]["model"] == LEGACY
    assert not any("re-index" in w.lower() for w in result["warnings"])


def test_a_mixed_index_embeds_the_query_with_both_models_current_first(monkeypatch, mixed, fake_model):
    folder, index = mixed
    code, capture = run(monkeypatch, {"folder": folder, "indexPath": index, "queries": [query("ocean")]})
    (result,) = capture.of_type("result")
    assert code == 0 and fake_model["preload"] == [SIGLIP, LEGACY]
    assert result["models"] == {SIGLIP: 1, LEGACY: 1}
    found = {r["filename"]: r["model"] for r in result["matches"][0]["results"]}
    assert found == {"new.mp4": SIGLIP, "old.mp4": LEGACY}
    assert any("1 of 2 shots" in w and "Re-index them in Spyglass" in w for w in result["warnings"])


def test_a_model_that_fails_leaves_its_shots_to_tags_and_the_other_model(monkeypatch, mixed, fake_model):
    folder, index = mixed

    def preload(model_id=None):
        if model_id == LEGACY:
            raise vision_energy.VisionEnergyError("offline")
        fake_model["preload"].append(model_id)

    monkeypatch.setattr(vision_energy, "preload", preload)
    code, capture = run(monkeypatch, {"folder": folder, "indexPath": index, "queries": [query("ocean")]})
    (result,) = capture.of_type("result")
    assert code == 0 and capture.of_type("error") == []
    assert [r["filename"] for r in result["matches"][0]["results"]] == ["new.mp4"]
    assert any("could not be loaded (offline)" in w for w in result["warnings"])


def test_shots_from_an_unknown_model_are_searched_by_tags_without_loading_torch(
    monkeypatch, tmp_path, fake_model
):
    folder = tmp_path / "future"
    folder.mkdir()
    (folder / "a.mp4").write_bytes(b"x" * 10)
    archive = Archive(tmp_path / "index.sqlite", schema=SCHEMA_WITH_MODEL)
    clip = archive.clip(str(folder / "a.mp4"), size=10)
    archive.shot(clip, 0, 5, visual=OCEAN, tags=["ocean"], model="Future/x")
    archive.shot(clip, 5, 9, visual=OCEAN, tags=["road"], model="Future/x")
    index = archive.done()
    monkeypatch.setattr(vision_energy, "is_available", lambda: False)
    code, capture = run(
        monkeypatch,
        {"folder": str(folder), "indexPath": index, "queries": [query("ocean")]},
    )
    (result,) = capture.of_type("result")
    assert code == 0 and fake_model["preload"] == [] and fake_model["texts"] == 0
    ((top,),) = [m["results"] for m in result["matches"]]
    assert top["tagMatch"] and top["model"] is None
    assert any("Future/x" in w for w in result["warnings"])
