"""The 100k-row stress run (telemetry/stress_emitter.py)."""

from __future__ import annotations

import json
from collections import Counter
from pathlib import Path

import pytest

from vibecut_agent.telemetry import stress_emitter
from vibecut_agent.telemetry.bus import validate_envelope
from vibecut_agent.telemetry.snapshot import compact, snapshot


def test_the_run_is_exactly_its_rows_all_valid_and_the_same_every_time() -> None:
    envelopes = stress_emitter.generate(rows=5_000, tasks=40)
    assert len(envelopes) == 5_000
    assert [e["seq_id"] for e in envelopes] == list(range(1, 5_001))
    assert not [e for e in envelopes if validate_envelope(e)]
    assert envelopes == stress_emitter.generate(rows=5_000, tasks=40)
    kinds = Counter(e["event_type"] for e in envelopes)
    assert kinds["SPAWN"] == kinds["COMPLETED"] == 41
    assert kinds["WAITING_UPSTREAM"] > 0 and {e["severity"] for e in envelopes} == {"DEBUG", "INFO", "WARN"}


def test_every_row_survives_the_snapshot_and_every_task_finishes() -> None:
    envelopes = stress_emitter.generate(rows=3_000, tasks=30)
    assert len(compact(envelopes)) == 3_000
    state = snapshot("trc_stress_0001", envelopes)
    assert len(state["replay_events"]) == 3_000
    assert len(state["nodes"]) == 31
    assert {node["status"] for node in state["nodes"]} == {"COMPLETED"}


def test_the_default_run_is_100k_rows(tmp_path: Path) -> None:
    path = stress_emitter.write_journal(tmp_path)
    with path.open(encoding="utf-8") as fh:
        count = sum(1 for _ in fh)
    assert (path.name, count) == ("trc_stress_0001.jsonl", 100_000)
    assert not list(tmp_path.glob(".*partial"))


def test_a_realtime_run_journals_every_row_in_order(tmp_path: Path) -> None:
    path = stress_emitter.write_realtime(tmp_path, "trc_stress_live", rows=600, tasks=10, rate=50_000)
    lines = [json.loads(line) for line in path.read_text("utf-8").splitlines()]
    assert [e["seq_id"] for e in lines] == list(range(1, 601))


def test_the_command_writes_to_the_apps_telemetry_folder(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("VIBECUT_APP_DATA_DIR", str(tmp_path))
    assert stress_emitter.main(["--rows", "100", "--tasks", "5"]) == 0
    assert (tmp_path / "telemetry" / "trc_stress_0001.jsonl").read_text("utf-8").count("\n") == 100
    with pytest.raises(SystemExit):
        stress_emitter.main(["--rows", "5"])
