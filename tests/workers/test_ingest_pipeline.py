"""The `ingest-index` command (workers/ingest_pipeline.py), with stand-in workers."""

from __future__ import annotations

import os

import pytest

from vibecut_agent.config import OrchestratorConfig
from vibecut_agent.headless import COMMANDS
from vibecut_agent.protocol import CancelFlag, RequestError
from vibecut_agent.workers import ingest_pipeline
from vibecut_agent.workers.ingest_pipeline import parse_request


class Whisper:
    def __init__(self, fail=()):
        self.fail = set(fail)
        self.seen = []

    def transcribe(self, path, **options):
        self.seen.append((path, options))
        if path in self.fail:
            raise RuntimeError("no sound")
        options["on_progress"]("transcribe", 0.5, "half way")
        return {"path": path, "segments": [{}, {}]}

    def cached(self, path):
        return {"path": path, "segments": [{}]}


class Vlm:
    def analyze(self, path, **options):
        return {"media_path": path, "shots": [{}]}

    def cached(self, path, strategy):
        return None


class Store:
    db_path = "/index/vibecut_vectors.db"

    def __init__(self):
        self.indexed = []

    def index_transcript(self, transcript):
        self.indexed.append(("transcript", transcript["path"]))
        return len(transcript["segments"])

    def index_shots(self, analysis):
        self.indexed.append(("shots", analysis["media_path"]))
        return len(analysis["shots"])


@pytest.fixture
def files(tmp_path):
    paths = []
    for name in ("a.mov", "b.mov"):
        path = tmp_path / name
        path.write_bytes(b"")
        paths.append(str(path))
    return paths


def run(request, recorder, workers, cancel=None):
    return ingest_pipeline.run(
        request,
        recorder.emitter,
        cancel or CancelFlag(),
        OrchestratorConfig.from_env("orchestrated"),
        lambda config: workers,
    )


def test_every_file_through_every_stage(recorder, files):
    workers = {"whisper": Whisper(), "vlm": Vlm(), "vector": Store()}
    assert run({"paths": files}, recorder, workers) == 0
    result = recorder.events[-1]
    assert result["type"] == "result" and result["indexPath"] == "/index/vibecut_vectors.db"
    assert [(f["segments"], f["shots"], f["indexed"], f["errors"]) for f in result["files"]] == [
        (2, 1, 3, [])
    ] * 2
    assert workers["vector"].indexed == [
        ("transcript", files[0]),
        ("shots", files[0]),
        ("transcript", files[1]),
        ("shots", files[1]),
    ]
    progress = [e for e in recorder.events if e["type"] == "progress"]
    assert progress[0]["total"] == 6 and progress[-1]["fraction"] == 1.0
    assert any(e["detail"] == "a.mov: half way" and e["done"] == 0.5 for e in progress)
    assert all("etaSeconds" in e for e in progress)


def test_a_failing_stage_is_recorded_and_the_rest_go_on(recorder, files, tmp_path):
    workers = {"whisper": Whisper(fail=[files[0]]), "vlm": Vlm(), "vector": Store()}
    missing = str(tmp_path / "gone.mov")
    assert run({"paths": [*files, missing], "stages": ["transcribe", "index"]}, recorder, workers) == 0
    first, second, gone = recorder.events[-1]["files"]
    assert first["errors"] == ["transcribe: no sound"] and first["indexed"] == 0
    assert second["indexed"] == 2 and second["shots"] is None
    assert gone["errors"] == ["The file isn't there (is its drive attached?)"]


def test_index_only_reads_the_caches(recorder, files):
    workers = {"whisper": Whisper(), "vlm": Vlm(), "vector": Store()}
    run({"paths": files[:1], "stages": ["index"]}, recorder, workers)
    assert workers["vector"].indexed == [("transcript", files[0])]
    assert workers["whisper"].seen == []


def test_options_reach_the_workers(recorder, files):
    whisper = Whisper()
    run(
        {
            "paths": files[:1],
            "stages": ["transcribe"],
            "modelTier": "small",
            "diarize": True,
            "hfToken": "hf_x",
            "force": True,
        },
        recorder,
        {"whisper": whisper, "vlm": Vlm(), "vector": Store()},
    )
    options = whisper.seen[0][1]
    assert (
        options["model_tier"],
        options["enable_diarization"],
        options["hf_token"],
        options["use_cache"],
    ) == ("small", True, "hf_x", False)


def test_stopping(recorder, files):
    cancel = CancelFlag()
    cancel.set()
    assert (
        run({"paths": files}, recorder, {"whisper": Whisper(), "vlm": Vlm(), "vector": Store()}, cancel) == 0
    )
    assert recorder.events[-1] == {"type": "done", "cancelled": True}


def test_every_file_failing_is_a_failure(recorder, tmp_path):
    assert (
        run(
            {"paths": [str(tmp_path / "gone.mov")]},
            recorder,
            {"whisper": Whisper(), "vlm": Vlm(), "vector": Store()},
        )
        == 1
    )


@pytest.mark.parametrize(
    ("request_", "message"),
    [
        ({"paths": []}, "paths must be"),
        ({"paths": ["a.mov"]}, "absolute"),
        ({"paths": ["/a.mov"], "stages": ["render"]}, "stages"),
        ({"paths": ["/a.mov"], "sampleStrategy": "all"}, "sampleStrategy"),
        ({"paths": ["/a.mov"], "modelTier": "huge"}, "modelTier"),
        ({"paths": ["/a.mov"], "diarize": True}, "Hugging Face"),
    ],
)
def test_bad_requests(request_, message):
    with pytest.raises(RequestError, match=message):
        parse_request(request_)


def test_registered():
    assert "ingest-index" in COMMANDS
    options = parse_request(
        {"paths": ["/a.mov", "/a.mov"], "stages": ["index", "transcribe"], "hfToken": "hf_x"}
    )
    assert (
        options["paths"] == ["/a.mov"]
        and options["stages"] == ["transcribe", "index"]
        and options["hf_token"] is None
    )


def test_the_eta_is_paced_by_the_steps_that_did_work(recorder, tmp_path, monkeypatch):
    # Seen live (Phase 21): a reused transcript finished its step at once, and the ETA said 3 s with
    # minutes to go. A cached step doesn't report progress, so it doesn't set the pace.
    clock = [0.0]
    monkeypatch.setattr(ingest_pipeline.time, "monotonic", lambda: clock[0])
    paths = []
    for name in ("cached.mov", "slow.mov", "next.mov"):
        (tmp_path / name).write_bytes(b"")
        paths.append(str(tmp_path / name))

    class Paced(Whisper):
        def transcribe(self, path, **options):
            if path.endswith("cached.mov"):
                clock[0] += 0.01
                return {"path": path, "segments": []}
            clock[0] += 5
            options["on_progress"]("transcribe", 0.5, "half way")
            clock[0] += 5
            return {"path": path, "segments": [{}]}

    workers = {"whisper": Paced(), "vlm": Vlm(), "vector": Store()}
    assert run({"paths": paths, "stages": ["transcribe"]}, recorder, workers) == 0
    progress = [e for e in recorder.events if e["type"] == "progress"]
    # Before any work, no guess; half way through slow.mov, 10 s a file with 1.5 files to go.
    assert [e["etaSeconds"] for e in progress if e["detail"].startswith("Transcribing")][:2] == [None, None]
    half = next(e for e in progress if e["detail"] == "slow.mov: half way")
    assert half["etaSeconds"] == 15.0


def test_each_stage_keeps_its_own_pace(recorder, tmp_path, monkeypatch):
    # Seen live (the Phase 21 follow-up's checks): with one pace for every stage, a few seconds of indexing
    # left read as 85 s, the pace of a 4K analysis.
    clock = [0.0]
    monkeypatch.setattr(ingest_pipeline.time, "monotonic", lambda: clock[0])
    paths = []
    for name in ("one.mov", "two.mov"):
        (tmp_path / name).write_bytes(b"")
        paths.append(str(tmp_path / name))

    class Slow(Vlm):
        def analyze(self, path, **options):
            clock[0] += 50
            options["on_progress"]("vision", 0.5, "half way")
            clock[0] += 50
            return {"media_path": path, "shots": [{}]}

    class Quick(Store):
        def index_shots(self, analysis):
            clock[0] += 2
            return super().index_shots(analysis)

    workers = {"whisper": Whisper(), "vlm": Slow(), "vector": Quick()}
    assert run({"paths": paths, "stages": ["vision", "index"]}, recorder, workers) == 0
    halves = [e for e in recorder.events if e["type"] == "progress" and e["detail"].endswith("half way")]
    # The run goes stage by stage (model migration v2): both analyses, then both indexings.
    # The first file: 50 s more of its analysis, the second's, and both indexings at the analysis's pace
    # (nothing else known).
    assert halves[0]["etaSeconds"] == 50 + 100 + 100 + 100
    # The second: 50 s more, then both indexings, still at the analysis's pace (none has run yet).
    assert halves[1]["etaSeconds"] == 50 + 100 + 100
    # Once one indexing has run, the other is at its own pace.
    index = next(e for e in recorder.events if e["type"] == "progress" and e["detail"] == "Indexing two.mov")
    assert index["etaSeconds"] == 2.0


def test_the_run_goes_stage_by_stage_across_files(recorder, tmp_path):
    """Model migration v2: every file's transcript, then every file's shots, then the index, so the
    local server keeps one model loaded at a time instead of swapping three for each file."""
    order = []
    paths = []
    for name in ("one.mov", "two.mov", "three.mov"):
        (tmp_path / name).write_bytes(b"")
        paths.append(str(tmp_path / name))

    class W(Whisper):
        def transcribe(self, path, **options):
            order.append(("transcribe", os.path.basename(path)))
            return super().transcribe(path, **options)

    class V(Vlm):
        def analyze(self, path, **options):
            order.append(("vision", os.path.basename(path)))
            return super().analyze(path, **options)

    class S(Store):
        def index_transcript(self, transcript):
            order.append(("index", os.path.basename(transcript["path"])))
            return super().index_transcript(transcript)

    missing = str(tmp_path / "gone.mov")
    assert (
        run({"paths": [paths[0], missing, *paths[1:]]}, recorder, {"whisper": W(), "vlm": V(), "vector": S()})
        == 0
    )
    names = ["one.mov", "two.mov", "three.mov"]
    assert order == [(stage, name) for stage in ("transcribe", "vision", "index") for name in names]
    [result] = [e for e in recorder.events if e["type"] == "result"]
    files = {os.path.basename(f["path"]): f for f in result["files"]}
    # The missing file is reported once, and the others still carry what each stage made.
    assert files["gone.mov"]["errors"] == ["The file isn't there (is its drive attached?)"]
    assert all(files[name]["indexed"] > 0 and not files[name]["errors"] for name in names)
    fractions = [e["fraction"] for e in recorder.events if e["type"] == "progress"]
    assert fractions == sorted(fractions) and fractions[-1] == 1.0


# ------------------------------------------------------------------------------ telemetry (Phase 22)


def test_an_ingest_is_traced_stage_by_stage(recorder, files):
    from vibecut_agent.telemetry.bus import TelemetryBus, validate_envelope
    from vibecut_agent.telemetry.instrument import TraceEmitter

    trace = TraceEmitter(TelemetryBus(), "trc_test_ingest")
    workers = {"whisper": Whisper(fail=[files[1]]), "vlm": Vlm(), "vector": Store()}
    ingest = ingest_pipeline.Ingest(
        parse_request({"paths": files}),
        recorder.emitter,
        CancelFlag(),
        OrchestratorConfig.from_env("orchestrated"),
        lambda config: workers,
        trace,
    )
    envelopes: list = []
    trace.bus.add_listener(envelopes.extend)
    ingest.run()
    trace.bus.flush()
    assert [validate_envelope(e) for e in envelopes if validate_envelope(e)] == []
    spawns = [e for e in envelopes if e["event_type"] == "SPAWN"]
    assert [e["subagent_type"] for e in spawns] == [
        "MASTER_ORCHESTRATOR",
        "INGEST_TRANSCRIBE",
        "INGEST_TRANSCRIBE",
        "VISION_TAGGER",
        "VISION_TAGGER",
        "BROLL_RETRIEVER",
        "BROLL_RETRIEVER",
    ]
    # a.mov's vision step waits on its transcript, and its index on its vision.
    a_transcribe, a_vision, a_index = (spawns[1], spawns[3], spawns[5])
    assert a_vision["payload"]["upstream_task_ids"] == [a_transcribe["payload"]["task_id"]]
    assert a_index["payload"]["upstream_task_ids"] == [a_vision["payload"]["task_id"]]
    failed = [e["payload"] for e in envelopes if e["event_type"] == "FAILED"]
    assert [f["error_message"] for f in failed] == ["transcribe: no sound"]
    assert any(e["event_type"] == "BATCH_PROGRESS" for e in envelopes)
    assert envelopes[-1]["event_type"] == "COMPLETED"
    assert envelopes[-1]["payload"]["task_id"] == "task_root"
    assert envelopes[-1]["payload"]["latency_ms"] > 0


def test_an_ingest_without_telemetry_writes_no_trace(recorder, files, monkeypatch, tmp_path):
    monkeypatch.delenv("VIBECUT_TELEMETRY", raising=False)
    monkeypatch.setenv("VIBECUT_APP_DATA_DIR", str(tmp_path / "app"))
    from vibecut_agent.telemetry.bus import reset_bus

    reset_bus()
    workers = {"whisper": Whisper(), "vlm": Vlm(), "vector": Store()}
    assert run({"paths": files}, recorder, workers) == 0
    assert not (tmp_path / "app").exists()
    reset_bus()


def test_an_ingest_with_telemetry_journals_its_trace(recorder, files, monkeypatch, tmp_path):
    monkeypatch.setenv("VIBECUT_TELEMETRY", "1")
    monkeypatch.setenv("VIBECUT_APP_DATA_DIR", str(tmp_path / "app"))
    from vibecut_agent.telemetry.bus import get_bus, reset_bus

    reset_bus()
    workers = {"whisper": Whisper(), "vlm": Vlm(), "vector": Store()}
    assert run({"paths": files}, recorder, workers) == 0
    get_bus().stop_thread()
    [journal] = (tmp_path / "app" / "telemetry").iterdir()
    assert journal.name.startswith("trc_ing_")
    lines = journal.read_text("utf-8").splitlines()
    assert '"task_root"' in lines[-1] and '"COMPLETED"' in lines[-1]
    reset_bus()
