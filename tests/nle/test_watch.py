from __future__ import annotations

import json
from typing import Any

import pytest

from tests.nle.fakes import FakePanel, FakeProject, FakeResolve, FakeTimeline
from vibecut_agent.nle.errors import Busy, HostError, Unreachable
from vibecut_agent.nle.premiere_bridge import PremiereBridge
from vibecut_agent.nle.watch import PROBE_TIMEOUT_S, PremiereAdapter, ResolveAdapter, Tracker, watch
from vibecut_agent.protocol import RequestError, StdinClosed


def snap(**over: Any) -> dict[str, Any]:
    base = {
        "product": "P",
        "version": "1",
        "project": "Doc",
        "timeline": "Main",
        "timelines": ["Main"],
        "instance": "i1",
    }
    return {**base, **over}


def test_tracker_names_each_change():
    t = Tracker()
    assert t.unreachable("not running")["reason"] == "unavailable"
    assert t.unreachable("not running") is None  # nothing new
    assert t.unreachable("panel missing")["message"] == "panel missing"
    assert t.connected(snap())["reason"] == "connected"
    assert t.connected(snap()) is None
    assert t.connected(snap(timeline="B", timelines=["Main", "B"]))["reason"] == "timeline_changed"
    assert t.connected(snap(timeline="B", timelines=["Main", "B", "C"]))["reason"] == "timelines_changed"
    assert t.connected(snap(project="Other"))["reason"] == "project_changed"
    assert t.unreachable("gone")["reason"] == "disconnected"
    assert t.connected(snap(project="Other"))["reason"] == "reconnected"
    # A new panel instance means Premiere restarted, whether or not a disconnect was seen.
    assert t.connected(snap(project="Other", instance="i2"))["reason"] == "restarted"
    t.unreachable("gone")
    assert t.connected(snap(instance="i3"))["reason"] == "restarted"


def test_tracker_without_instances_reads_reconnects_as_reconnected():
    t = Tracker()
    t.connected(snap(instance=None))
    t.unreachable("gone")
    assert t.connected(snap(instance=None))["reason"] == "reconnected"


class Clock:
    def __init__(self) -> None:
        self.now = 0.0

    def __call__(self) -> float:
        return self.now


class ScriptedChannel:
    """Feeds scripted messages; ``None`` lets the timeout pass (advancing the clock). Then EOF."""

    def __init__(self, clock: Clock, script: list[dict[str, Any] | None]) -> None:
        self.clock = clock
        self.script = list(script)

    def read(self, timeout: float | None = None) -> dict[str, Any] | None:
        if not self.script:
            raise StdinClosed("stdin closed")
        item = self.script.pop(0)
        if item is None:
            self.clock.now += timeout or 0
        return item


class FakeAdapter:
    host = "premiere"
    calls = ("status", "read_timeline")

    def __init__(self, probes: list[Any]) -> None:
        self.probes = list(probes)
        self.made: list[tuple[str, dict[str, Any]]] = []
        self.call_error: Exception | None = None

    def probe(self) -> dict[str, Any]:
        result = self.probes.pop(0) if len(self.probes) > 1 else self.probes[0]
        if isinstance(result, Exception):
            raise result
        return result

    def call(self, command: str, args: dict[str, Any]) -> Any:
        self.made.append((command, args))
        if self.call_error:
            raise self.call_error
        return {"answer": command}


def run(adapter: FakeAdapter, script: list[dict[str, Any] | None], recorder: Any) -> int:
    clock = Clock()
    return watch(adapter, ScriptedChannel(clock, script), recorder.emitter, clock=clock, interval=2.0)


def test_watch_reports_changes_on_each_probe(recorder):
    adapter = FakeAdapter([Unreachable("Premiere Pro isn't running."), snap(), snap(), snap(project="B")])
    assert run(adapter, [None, None, None], recorder) == 0
    events = recorder.events
    assert events[0] == {"type": "ready", "host": "premiere"}
    states = [e for e in events if e["type"] == "state"]
    assert [(s["status"], s["reason"]) for s in states] == [
        ("disconnected", "unavailable"),
        ("connected", "connected"),
        ("connected", "project_changed"),
    ]
    assert states[0]["message"] == "Premiere Pro isn't running." and states[0]["host"] == "premiere"
    assert states[1]["timelines"] == ["Main"]


def test_watch_answers_allowed_calls_only(recorder):
    adapter = FakeAdapter([snap()])
    script = [
        {"type": "call", "id": "c1", "command": "read_timeline", "args": {"timeline": "Main"}},
        {"type": "call", "id": "c2", "command": "delete_everything", "args": {}},
        {"type": "call", "id": "c3", "command": "status", "args": []},
        {"type": "mystery"},
        {"type": "end_session"},
    ]
    assert run(adapter, script, recorder) == 0
    replies = [e for e in recorder.events if e["type"] == "reply"]
    assert replies == [
        {"type": "reply", "id": "c1", "ok": True, "result": {"answer": "read_timeline"}},
        {"type": "reply", "id": "c2", "ok": False, "error": "Unknown command: 'delete_everything'"},
        {"type": "reply", "id": "c3", "ok": False, "error": "args must be an object"},
    ]
    assert adapter.made == [("read_timeline", {"timeline": "Main"})]
    assert recorder.events[-1] == {"type": "done", "reason": "ended"}
    assert any(e["type"] == "error" and "mystery" in e["message"] for e in recorder.events)


def test_a_call_that_finds_the_editor_gone_triggers_a_probe_at_once(recorder):
    adapter = FakeAdapter([snap(), Unreachable("Premiere Pro isn't running.")])
    adapter.call_error = Unreachable("Premiere Pro isn't running.")
    script = [{"type": "call", "id": "c1", "command": "status", "args": {}}, {"type": "end_session"}]
    run(adapter, script, recorder)
    types = [(e["type"], e.get("reason") or e.get("ok")) for e in recorder.events]
    assert types == [
        ("ready", None),
        ("state", "connected"),
        ("reply", False),
        ("state", "disconnected"),
        ("done", "ended"),
    ]


def test_host_errors_in_calls_are_replies_not_disconnects(recorder):
    adapter = FakeAdapter([snap()])
    adapter.call_error = HostError('There is no sequence called "X"')
    run(adapter, [{"type": "call", "id": "c1", "command": "read_timeline", "args": {}}], recorder)
    reply = next(e for e in recorder.events if e["type"] == "reply")
    assert reply == {"type": "reply", "id": "c1", "ok": False, "error": 'There is no sequence called "X"'}
    assert [e.get("reason") for e in recorder.events if e["type"] == "state"] == ["connected"]


def test_bad_lines_are_reported_and_the_watch_goes_on(recorder):
    class BadThenClosed(ScriptedChannel):
        def read(self, timeout: float | None = None) -> dict[str, Any] | None:
            if self.script and self.script[0] == "bad":
                self.script.pop(0)
                raise RequestError("The request is not valid JSON")
            return super().read(timeout)

    clock = Clock()
    channel = BadThenClosed(clock, ["bad", None])  # type: ignore[list-item]
    assert watch(FakeAdapter([snap()]), channel, recorder.emitter, clock=clock) == 0
    assert {"type": "error", "message": "The request is not valid JSON"} in recorder.events


def test_premiere_adapter_reads_the_panel_and_its_instance(tmp_path):
    status = {"version": "26.5.2", "project": "Doc", "sequences": ["Main"], "activeSequence": "Main"}
    # A reply left by a previous run (the panel never touches replies, so this can't race it).
    (tmp_path / "replies").mkdir()
    (tmp_path / "replies" / "old-1.json").write_text("{}")
    adapter = PremiereAdapter(PremiereBridge(tmp_path))
    with FakePanel(tmp_path, {"status": lambda _a: status}) as panel:
        first = adapter.probe()
        panel.instance = "inst-2"
        panel.beat()
        second = adapter.probe()
    assert first == {
        "product": "Adobe Premiere Pro",
        "version": "26.5.2",
        "project": "Doc",
        "timeline": "Main",
        "timelines": ["Main"],
        "instance": "inst-1",
    }
    assert second["instance"] == "inst-2"
    # The first probe cleared what a previous run left in the queue.
    assert not (tmp_path / "replies" / "old-1.json").exists()


def test_resolve_adapter_reconnects_after_resolve_quits():
    project = FakeProject("Doc", [FakeTimeline("Main")])
    first = FakeResolve(project)
    second = FakeResolve(project)
    connections = iter([first, Unreachable("not running"), second])

    def connect() -> FakeResolve:
        item = next(connections)
        if isinstance(item, Exception):
            raise item
        return item

    adapter = ResolveAdapter(connect)
    assert adapter.probe()["project"] == "Doc"
    first.quit = True
    for _ in range(2):
        try:
            adapter.probe()
        except Unreachable:
            pass
        else:
            raise AssertionError("expected Unreachable")
    assert adapter.probe()["timeline"] == "Main"
    assert adapter.call("status", {})["project"] == "Doc"


class SlowPanel:
    """A panel on a fake clock: it stamps alive.json (unless `alive` is False), starts each request
    (renaming it to .running, as bridge.js does) and answers only while `answering`."""

    def __init__(self, folder):
        self.folder = folder
        self.now = 1000.0
        self.alive = True
        self.busy = False
        self.answering = True
        self.sent = 0
        for sub in ("jobs", "replies"):
            (folder / sub).mkdir(parents=True, exist_ok=True)
        self.beat()

    def beat(self):
        if self.alive:
            stamp = {"time": self.now, "busy": self.busy, "instance": "inst-1"}
            (self.folder / "alive.json").write_text(json.dumps(stamp))

    def sleep(self, seconds):
        self.now += seconds
        self.beat()
        for job in (self.folder / "jobs").glob("*.json"):
            self.sent += 1
            job.rename(job.with_name(job.name + ".running"))
        if self.answering:
            for running in (self.folder / "jobs").glob("*.json.running"):
                request = json.loads(running.read_text())
                running.unlink()
                result = {"project": "Doc", "sequences": ["Main"], "activeSequence": "Main"}
                reply = {"id": request["id"], "ok": True, "result": result}
                (self.folder / "replies" / f"{request['id']}.json").write_text(json.dumps(reply))


def test_a_busy_premiere_stays_connected_and_only_a_stale_heartbeat_loses_it(tmp_path):
    # Seen 2026-10-16: during per-clip Media Encoder renders the probe's status answered after 20 s, and
    # the app showed Premiere disconnected mid-export.
    panel = SlowPanel(tmp_path)
    adapter = PremiereAdapter(PremiereBridge(tmp_path, clock=lambda: panel.now, sleep=panel.sleep))
    first = adapter.probe()
    assert first["timeline"] == "Main" and first["instance"] == "inst-1"

    panel.answering = False
    before = panel.now
    assert adapter.probe() == first
    # The probe waited its own 10 s, not the 180 s more a started edit gets.
    assert panel.now - before == pytest.approx(PROBE_TIMEOUT_S, abs=0.5)

    # While the panel says it's busy, no status is queued behind its work.
    panel.busy = True
    panel.beat()
    sent = panel.sent
    assert adapter.probe() == first
    assert panel.sent == sent

    # Once it answers again, the late reply is cleared rather than left in replies/.
    panel.busy = False
    panel.answering = True
    panel.beat()
    assert adapter.probe() == first
    assert list((tmp_path / "replies").iterdir()) == []

    panel.alive = False
    panel.now += 30
    with pytest.raises(Unreachable, match="isn't running") as exc:
        adapter.probe()
    assert not isinstance(exc.value, Busy)


def test_a_premiere_that_never_answered_isnt_shown_connected(tmp_path):
    panel = SlowPanel(tmp_path)
    panel.answering = False
    adapter = PremiereAdapter(PremiereBridge(tmp_path, clock=lambda: panel.now, sleep=panel.sleep))
    with pytest.raises(Busy, match="hadn't finished it"):
        adapter.probe()
