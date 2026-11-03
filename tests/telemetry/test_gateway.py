"""The telemetry gateway (telemetry/gateway.py), spoken to over real sockets with a hand-written client."""

from __future__ import annotations

import asyncio
import base64
import json
import os
import secrets
import shutil
import struct
import subprocess
import sys
from collections.abc import Awaitable, Callable
from pathlib import Path
from typing import Any

import pytest

from vibecut_agent.headless import COMMANDS
from vibecut_agent.telemetry import mock_emitter
from vibecut_agent.telemetry.bus import TelemetryBus
from vibecut_agent.telemetry.gateway import (
    FRAME_AUDIO_PEAKS,
    FRAME_CONTACT_STRIP,
    FRAME_SCRUB_AUDIO,
    Gateway,
    GatewayError,
    JournalTailer,
    TraceStore,
    accept_key,
    options_from,
    pack_binary_frame,
    unpack_binary_frame,
)
from vibecut_agent.telemetry.snapshot import compact

REPO = Path(__file__).resolve().parents[2]


# ------------------------------------------------------------------------------ a minimal client


class WsClient:
    def __init__(self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        self.reader = reader
        self.writer = writer

    @classmethod
    async def connect(cls, port: int, origin: str | None = None, path: str = "/ws/v1/telemetry") -> WsClient:
        reader, writer = await asyncio.open_connection("127.0.0.1", port)
        key = base64.b64encode(secrets.token_bytes(16)).decode()
        lines = [
            f"GET {path} HTTP/1.1",
            f"Host: 127.0.0.1:{port}",
            "Upgrade: websocket",
            "Connection: Upgrade",
            f"Sec-WebSocket-Key: {key}",
            "Sec-WebSocket-Version: 13",
        ]
        if origin:
            lines.append(f"Origin: {origin}")
        writer.write(("\r\n".join(lines) + "\r\n\r\n").encode())
        head = (await reader.readuntil(b"\r\n\r\n")).decode()
        if not head.startswith("HTTP/1.1 101"):
            raise ConnectionRefusedError(head.splitlines()[0])
        assert f"Sec-WebSocket-Accept: {accept_key(key)}" in head
        return cls(reader, writer)

    async def send_frame(self, opcode: int, data: bytes, fin: bool = True) -> None:
        mask = secrets.token_bytes(4)
        header = bytes([(0x80 if fin else 0) | opcode])
        if len(data) < 126:
            header += bytes([0x80 | len(data)])
        else:
            header += bytes([0x80 | 126]) + struct.pack(">H", len(data))
        body = bytes(b ^ mask[i % 4] for i, b in enumerate(data))
        self.writer.write(header + mask + body)
        await self.writer.drain()

    async def send_json(self, message: dict[str, Any]) -> None:
        await self.send_frame(0x1, json.dumps(message).encode())

    async def receive(self) -> tuple[int, bytes]:
        first, second = await self.reader.readexactly(2)
        length = second & 0x7F
        if length == 126:
            (length,) = struct.unpack(">H", await self.reader.readexactly(2))
        elif length == 127:
            (length,) = struct.unpack(">Q", await self.reader.readexactly(8))
        return first & 0x0F, await self.reader.readexactly(length)

    async def receive_json(self) -> dict[str, Any]:
        while True:
            opcode, data = await asyncio.wait_for(self.receive(), timeout=5)
            if opcode == 0x1:
                message: dict[str, Any] = json.loads(data)
                return message

    async def close(self) -> None:
        self.writer.close()


async def http(
    port: int, method: str, path: str, body: Any = None, headers: dict[str, str] | None = None
) -> tuple[int, dict[str, str], Any]:
    reader, writer = await asyncio.open_connection("127.0.0.1", port)
    data = b"" if body is None else json.dumps(body).encode()
    lines = [f"{method} {path} HTTP/1.1", f"Host: 127.0.0.1:{port}", f"Content-Length: {len(data)}"]
    lines += [f"{k}: {v}" for k, v in (headers or {}).items()]
    writer.write(("\r\n".join(lines) + "\r\n\r\n").encode() + data)
    raw = await asyncio.wait_for(reader.read(), timeout=5)
    writer.close()
    head, _, payload = raw.partition(b"\r\n\r\n")
    status_line, *header_lines = head.decode().split("\r\n")
    parsed = {k.lower(): v.strip() for k, v in (line.split(":", 1) for line in header_lines)}
    return int(status_line.split()[1]), parsed, json.loads(payload) if payload else None


def with_gateway(
    test: Callable[[Gateway], Awaitable[None]], folder: Path | None = None, **options: Any
) -> None:
    async def scenario() -> None:
        gateway = Gateway(
            folder, port=0, tail_interval=0.02, bus=TelemetryBus(flush_interval_sec=0.01), **options
        )
        await gateway.start()
        try:
            await asyncio.wait_for(test(gateway), timeout=20)
        finally:
            await gateway.stop()

    asyncio.run(scenario())


def journal(folder: Path, trace_id: str = "trc_mock_0001") -> list[dict[str, Any]]:
    envelopes = mock_emitter.generate(trace_id)
    folder.mkdir(parents=True, exist_ok=True)
    (folder / f"{trace_id}.jsonl").write_text("".join(json.dumps(e) + "\n" for e in envelopes), "utf-8")
    return envelopes


# ------------------------------------------------------------------------------ VCTB frames


def test_binary_frames_round_trip_with_a_16_byte_header() -> None:
    payload = mock_emitter.waveform_peaks()
    frame = pack_binary_frame(FRAME_AUDIO_PEAKS, 2, 4242, payload)
    assert frame[:4] == b"VCTB"
    assert len(frame) == 16 + len(payload) == 16 + 256 * 2 * 2
    assert struct.unpack(">IBBHII", frame[:16]) == (0x56435442, 1, 2, 0, 4242, len(payload))
    assert unpack_binary_frame(frame) == (FRAME_AUDIO_PEAKS, 2, 4242, payload)
    with pytest.raises(ValueError, match="Not a VCTB"):
        unpack_binary_frame(b"JPEG" + frame[4:])
    with pytest.raises(ValueError, match="length"):
        unpack_binary_frame(frame[:-1])
    with pytest.raises(ValueError):
        pack_binary_frame(FRAME_CONTACT_STRIP, 256, 1, b"")


# ------------------------------------------------------------------------------ the store and the tailer


def test_the_store_keeps_each_event_once_and_answers_ranges() -> None:
    store = TraceStore()
    seen: list[int] = []
    store.listeners.append(lambda trace, events: seen.extend(e["seq_id"] for e in events))
    envelopes = mock_emitter.generate()
    store.add(envelopes[10:])
    store.add(envelopes)
    assert seen == list(range(11, len(envelopes) + 1)) + list(range(1, 11))
    assert [e["seq_id"] for e in store.events("trc_mock_0001", 5, 8)] == [5, 6, 7, 8]
    assert store.latest_seq("trc_mock_0001") == len(envelopes)
    store.add([{"not": "an envelope"}])
    assert list(store.traces) == ["trc_mock_0001"]


def test_the_tailer_reads_only_whole_new_lines(tmp_path: Path) -> None:
    store = TraceStore()
    tailer = JournalTailer(tmp_path, store)
    envelopes = mock_emitter.generate()
    path = tmp_path / "trc_mock_0001.jsonl"
    lines = [json.dumps(e) for e in envelopes]
    path.write_text("\n".join(lines[:3]) + "\n" + lines[3][:20], "utf-8")
    assert tailer.poll() == 3
    with path.open("a", encoding="utf-8") as fh:
        fh.write(lines[3][20:] + "\n" + "garbage\n" + lines[4] + "\n")
    assert tailer.poll() == 2
    assert tailer.poll() == 0
    assert store.latest_seq("trc_mock_0001") == 5


def test_a_snapshot_is_the_reduced_state_and_a_compact_replay() -> None:
    store = TraceStore()
    envelopes = mock_emitter.generate()
    store.add(envelopes)
    snap = store.snapshot("trc_mock_0001")
    assert snap["snapshot_seq_id"] == len(envelopes)
    nodes = {n["task_id"]: n for n in snap["nodes"]}
    assert len(nodes) == 7
    assert {n["status"] for n in nodes.values()} == {"COMPLETED"}
    # The audio engineer failed, then was retried and finished.
    assert nodes["task_aud_005"]["error"] is None
    assert nodes["task_cut_006"]["emitted_mutations"][-1]["mutation_stage"] == "VALIDATED"
    kinds = {e["edge_kind"] for e in snap["edges"]}
    assert kinds == {"SPAWN_PARENT", "DATA_DEPENDENCY", "CONTEXT_HANDOFF"}
    assert [t["track"] for t in snap["otio_tracks"]] == ["V2", "V1", "A2"]
    replay = snap["replay_events"]
    assert len(replay) < len(envelopes)
    assert sum(1 for e in replay if e["event_type"] == "BATCH_PROGRESS") == 2
    assert replay == compact(envelopes)


# ------------------------------------------------------------------------------ HTTP


def test_health_traces_events_and_snapshot(tmp_path: Path) -> None:
    envelopes = journal(tmp_path)

    async def check(gateway: Gateway) -> None:
        status, headers, health = await http(gateway.port, "GET", "/api/v1/health")
        assert status == 200 and headers["content-type"].startswith("application/json")
        assert health["status"] == "ok" and health["version"] == "1.0.0"
        assert health["active_trace_id"] == "trc_mock_0001"
        assert health["telemetry_dir"] == str(tmp_path)
        assert health["host_metrics"]["kind"] == "RESOURCE_HEARTBEAT"
        assert set(health["workers"]) >= {"whisper", "vlm", "vector", "validator"}
        status, _, traces = await http(gateway.port, "GET", "/api/v1/traces")
        [summary] = traces["traces"]
        assert summary["trace_id"] == "trc_mock_0001" and summary["latest_seq_id"] == len(envelopes)
        assert summary["source"] == "journal"
        status, _, events = await http(
            gateway.port, "GET", "/api/v1/traces/trc_mock_0001/events?from_seq=3&to_seq=6"
        )
        assert [e["seq_id"] for e in events] == [3, 4, 5, 6]
        status, _, snap = await http(gateway.port, "GET", "/api/v1/traces/trc_mock_0001/snapshot")
        assert snap["snapshot_seq_id"] == len(envelopes)
        status, _, _ = await http(gateway.port, "GET", "/api/v1/nothing")
        assert status == 404

    with_gateway(check, tmp_path)


def test_control_pauses_runs_a_mock_and_refuses_what_it_cant_do(tmp_path: Path) -> None:
    async def check(gateway: Gateway) -> None:
        status, _, body = await http(gateway.port, "POST", "/api/v1/control/any", {"action": "PAUSE"})
        assert (status, body["paused"]) == (200, True)
        status, _, body = await http(gateway.port, "POST", "/api/v1/control/any", {"action": "RESUME"})
        assert body["paused"] is False
        status, _, body = await http(gateway.port, "POST", "/api/v1/control/any", {"action": "CANCEL"})
        assert status == 409 and "needs the gateway the app starts" in body["error"]
        status, _, body = await http(gateway.port, "POST", "/api/v1/control/any", {"action": "DANCE"})
        assert status == 400
        status, _, body = await http(
            gateway.port,
            "POST",
            "/api/v1/control/new",
            {"action": "TRIGGER_MOCK_RUN", "params": {"speed": 100}},
        )
        assert status == 200 and body["trace_id"] == "trc_mock_0001"

        # Played live, its progress coalesces by real 50 ms windows, so the count varies: wait for the end.
        def finished() -> bool:
            return any(
                e["event_type"] == "COMPLETED" and e["payload"]["task_id"] == "task_root_001"
                for e in gateway.store.events("trc_mock_0001")
            )

        for _ in range(200):
            if finished():
                break
            await asyncio.sleep(0.05)
        assert finished()
        stages = [
            e["payload"]["mutation_stage"]
            for e in gateway.store.events("trc_mock_0001")
            if e["event_type"] == "MUTATION_EMITTED"
        ]
        assert stages == ["PROPOSED", "VALIDATED", "COMMITTED"]
        # The music bed's waveform, addressed as a real one: the delta's first seq, the duck's index (3).
        first = next(
            e for e in gateway.store.events("trc_mock_0001") if e["event_type"] == "MUTATION_EMITTED"
        )
        for _ in range(100):
            if gateway.peaks.get("trc_mock_0001"):
                break
            await asyncio.sleep(0.02)
        [frame] = gateway.peaks["trc_mock_0001"]
        assert unpack_binary_frame(frame)[:3] == (FRAME_AUDIO_PEAKS, 3, first["seq_id"])
        assert gateway.paused is False

    with_gateway(check, tmp_path)


def test_the_apps_gateway_checks_its_actions_and_hands_them_on(tmp_path: Path) -> None:
    from vibecut_agent.telemetry.instrument import TraceEmitter

    chat = "trc_mcp_job-7_a1b2c3"
    emitter = TraceEmitter(TelemetryBus(), chat)
    emitter.ensure_root()
    emitter.tool_call("analyze_shot_visuals", {"media_path": "/m/b.mov"}, lambda: {"shots": []})
    ingest = TraceEmitter(TelemetryBus(), "trc_ing_d4e5f6")
    ingest.ensure_root()
    sent: list[dict[str, Any]] = []

    async def check(gateway: Gateway) -> None:
        gateway.store.add(emitter.bus.flush() + ingest.bus.flush())

        async def control(trace: str, action: str, **params: Any) -> tuple[int, Any]:
            path = f"/api/v1/control/{trace}"
            status, _, body = await http(gateway.port, "POST", path, {"action": action, "params": params})
            return status, body

        assert (await http(gateway.port, "GET", "/api/v1/health"))[2]["app_control"] is True
        assert await control(chat, "REVEAL_IN_FINDER", path="/m/b.mov") == (
            202,
            {"ok": True, "forwarded": True},
        )
        assert (await control(chat, "REVEAL_IN_FINDER", path="/etc/passwd"))[0] == 400
        playhead = await control(chat, "SET_NLE_PLAYHEAD", host="resolve", timeline="Cut", seconds=12.5)
        assert playhead[0] == 202
        assert (await control(chat, "SET_NLE_PLAYHEAD", host="avid", timeline="Cut", seconds=1))[0] == 400
        assert (await control(chat, "SET_NLE_PLAYHEAD", host="resolve", timeline="Cut", seconds=-1))[0] == 400
        assert (await control(chat, "CANCEL"))[0] == 202
        assert (await control("trc_ing_d4e5f6", "CANCEL"))[0] == 409
        assert (await control("trc_nobody", "CANCEL"))[0] == 404

    with_gateway(check, tmp_path, forward=sent.append)
    assert sent == [
        {"action": "REVEAL_IN_FINDER", "traceId": chat, "path": "/m/b.mov"},
        {
            "action": "SET_NLE_PLAYHEAD",
            "traceId": chat,
            "host": "resolve",
            "timeline": "Cut",
            "seconds": 12.5,
        },
        {"action": "CANCEL", "traceId": chat, "caller": "job-7"},
    ]


def test_other_origins_and_hosts_are_refused_without_a_token(tmp_path: Path) -> None:
    async def check(gateway: Gateway) -> None:
        status, headers, _ = await http(
            gateway.port, "GET", "/api/v1/health", headers={"Origin": "http://localhost:5173"}
        )
        assert status == 200 and headers["access-control-allow-origin"] == "http://localhost:5173"
        status, _, _ = await http(
            gateway.port, "GET", "/api/v1/health", headers={"Origin": "https://evil.example"}
        )
        assert status == 403
        with pytest.raises(ConnectionRefusedError, match="403"):
            await WsClient.connect(gateway.port, origin="https://evil.example")

    with_gateway(check, tmp_path)


def test_a_token_is_needed_when_there_is_one(tmp_path: Path) -> None:
    async def check(gateway: Gateway) -> None:
        status, _, _ = await http(gateway.port, "GET", "/api/v1/health")
        assert status == 401
        status, _, _ = await http(
            gateway.port, "GET", "/api/v1/health", headers={"Authorization": "Bearer s3cret"}
        )
        assert status == 200
        status, _, _ = await http(gateway.port, "GET", "/api/v1/health?token=s3cret")
        assert status == 200
        ws = await WsClient.connect(gateway.port)
        await ws.send_json(_hello(auth_token="wrong"))
        assert (await ws.receive_json())["type"] == "ERROR"
        ws = await WsClient.connect(gateway.port)
        await ws.send_json(_hello(auth_token="s3cret"))
        assert (await ws.receive_json())["type"] == "SERVER_WELCOME"
        await ws.close()

    with_gateway(check, tmp_path, token="s3cret")


def test_a_lan_bind_without_a_token_is_refused(tmp_path: Path) -> None:
    with pytest.raises(GatewayError, match="VIBECUT_TELEMETRY_TOKEN"):
        Gateway(tmp_path, bind="0.0.0.0", port=0)
    Gateway(tmp_path, bind="0.0.0.0", port=0, token="t")


# ------------------------------------------------------------------------------ WebSocket


def _hello(last_seen: int = 0, trace: str | None = None, auth_token: str | None = None) -> dict[str, Any]:
    hello: dict[str, Any] = {
        "type": "CLIENT_HELLO",
        "protocol_version": "vibecut.ws.v1",
        "client_id": "test",
        "host_mode": "standalone",
        "subscribe_trace_id": trace,
        "last_seen_seq_id": last_seen,
        "capabilities": {"binary_previews": True},
    }
    if auth_token is not None:
        hello["auth_token"] = auth_token
    return hello


def test_a_new_client_is_sent_to_the_snapshot_and_a_returning_one_gets_what_it_missed(tmp_path: Path) -> None:
    envelopes = journal(tmp_path)

    async def check(gateway: Gateway) -> None:
        ws = await WsClient.connect(gateway.port, origin="http://127.0.0.1:5173")
        await ws.send_json(_hello())
        welcome = await ws.receive_json()
        assert welcome["type"] == "SERVER_WELCOME" and welcome["protocol_version"] == "vibecut.ws.v1"
        assert welcome["active_trace_id"] == "trc_mock_0001"
        assert welcome["current_seq_id"] == len(envelopes)
        assert welcome["requires_snapshot_fetch"] is True
        assert welcome["heartbeat_interval_ms"] == 5000
        await ws.send_json({"type": "PING", "client_time_ms": 12.5, "last_applied_seq_id": 0})
        pong = await ws.receive_json()
        assert pong["type"] == "PONG" and pong["client_time_ms"] == 12.5
        assert pong["latest_seq_id"] == len(envelopes)
        await ws.close()

        back = await WsClient.connect(gateway.port)
        await back.send_json(_hello(last_seen=len(envelopes) - 5, trace="trc_mock_0001"))
        welcome = await back.receive_json()
        assert welcome["requires_snapshot_fetch"] is False
        batch = await back.receive_json()
        assert batch["type"] == "TELEMETRY_BATCH"
        assert [e["seq_id"] for e in batch["events"]] == list(range(len(envelopes) - 4, len(envelopes) + 1))
        await back.close()

    with_gateway(check, tmp_path)


def test_live_events_from_another_process_stream_to_the_client(tmp_path: Path) -> None:
    """A journal written by another process (as the MCP shim and ingest-index write theirs) reaches a
    connected client through the tailer."""

    async def check(gateway: Gateway) -> None:
        ws = await WsClient.connect(gateway.port)
        await ws.send_json(_hello(trace="trc_live_proc"))
        assert (await ws.receive_json())["type"] == "SERVER_WELCOME"
        env = {**os.environ, "PYTHONPATH": str(REPO / "src-python")}
        process = await asyncio.create_subprocess_exec(
            sys.executable,
            "-m",
            "vibecut_agent.telemetry.mock_emitter",
            "--out",
            str(tmp_path),
            "--trace-id",
            "trc_live_proc",
            "--realtime",
            "--speed",
            "50",
            env=env,
            stderr=subprocess.DEVNULL,
        )
        seqs: list[int] = []
        total = len(mock_emitter.generate())
        while len(seqs) < total:
            batch = await ws.receive_json()
            assert batch["type"] == "TELEMETRY_BATCH" and batch["trace_id"] == "trc_live_proc"
            seqs += [e["seq_id"] for e in batch["events"]]
        await process.wait()
        assert seqs == list(range(1, total + 1))
        await ws.close()

    with_gateway(check, tmp_path)


def test_fragments_pings_and_binary_frames(tmp_path: Path) -> None:
    async def check(gateway: Gateway) -> None:
        ws = await WsClient.connect(gateway.port)
        hello = json.dumps(_hello()).encode()
        await ws.send_frame(0x1, hello[:10], fin=False)
        await ws.send_frame(0x9, b"are you there")
        await ws.send_frame(0x0, hello[10:])
        opcode, data = await ws.receive()
        assert (opcode, data) == (0xA, b"are you there")
        assert (await ws.receive_json())["type"] == "SERVER_WELCOME"
        gateway.store.add_binary("trc_any", pack_binary_frame(FRAME_CONTACT_STRIP, 0, 7, b"\xff\xd8jpeg"))
        opcode, data = await asyncio.wait_for(ws.receive(), timeout=5)
        assert opcode == 0x2 and unpack_binary_frame(data) == (FRAME_CONTACT_STRIP, 0, 7, b"\xff\xd8jpeg")
        await ws.send_frame(0x8, struct.pack(">H", 1000))
        opcode, _ = await ws.receive()
        assert opcode == 0x8

    with_gateway(check, tmp_path)


def test_a_traced_contact_strip_streams_live_and_to_a_later_client(tmp_path: Path) -> None:
    """A shot analysis whose COMPLETED names a strip (written by another process's emitter) reaches a
    connected client as VCTB 0x02 after its batch, tied to that envelope's seq; a client that connects
    afterwards gets it after the welcome."""
    from vibecut_agent.telemetry.instrument import TraceEmitter

    image = tmp_path / "shot_strip.jpg"
    image.write_bytes(b"\xff\xd8" + bytes(range(256)) * 4)

    async def receive_strip(ws: WsClient) -> tuple[int, int, int, bytes]:
        while True:
            opcode, data = await asyncio.wait_for(ws.receive(), timeout=5)
            if opcode == 0x2:
                return unpack_binary_frame(data)

    async def check(gateway: Gateway) -> None:
        ws = await WsClient.connect(gateway.port)
        await ws.send_json(_hello(trace="trc_strip"))
        assert (await ws.receive_json())["type"] == "SERVER_WELCOME"
        emitter = TraceEmitter(TelemetryBus(tmp_path), "trc_strip")
        emitter.ensure_root()
        result = {"media_path": "/m/b.mov", "shots": [{"shot_scale": "WIDE"}]}
        emitter.tool_call("analyze_shot_visuals", {}, lambda: (emitter.attach_strip(image), result)[1])
        envelopes = emitter.bus.flush()
        completed = next(e for e in envelopes if e["event_type"] == "COMPLETED")
        frame_type, channel, seq_id, payload = await receive_strip(ws)
        assert (frame_type, channel, seq_id) == (FRAME_CONTACT_STRIP, 0, completed["seq_id"])
        assert payload == image.read_bytes()
        await ws.close()

        later = await WsClient.connect(gateway.port)
        await later.send_json(_hello(trace="trc_strip"))
        assert (await later.receive_json())["type"] == "SERVER_WELCOME"
        assert (await receive_strip(later))[2] == completed["seq_id"]
        await later.close()

    with_gateway(check, tmp_path)


def test_a_strip_id_outside_the_strips_folder_is_not_read(tmp_path: Path) -> None:
    (tmp_path / "secret.jpg").write_bytes(b"not for you")
    gateway = Gateway(tmp_path, port=0, bus=TelemetryBus(flush_interval_sec=0.01))
    assert gateway._strip_frame(1, "../secret") is None
    assert gateway._strip_frame(1, "missing") is None


needs_ffmpeg = pytest.mark.skipif(shutil.which("ffmpeg") is None, reason="needs ffmpeg")


def _rt(value: int, rate: float = 25.0) -> dict[str, Any]:
    return {"OTIO_SCHEMA": "RationalTime.1", "value": value, "rate": rate}


def _audio_delta(media: str, delta_id: str = "delta_a") -> dict[str, Any]:
    """A picture op, then an op on A1 over 2 s of `media` from 1 s, at 10 s on the timeline."""
    return {
        "delta_id": delta_id,
        "target_host": "premiere",
        "target_timeline": "Seq",
        "timeline_fps": 25.0,
        "narrative_rationale": "Dialogue under the drone",
        "operations": [
            {
                "op_id": "op_v",
                "op_type": "INSERT_CLIP",
                "track_Selector": {"kind": "Video", "index": 2},
                "media_reference": {"source_name": "drone.mov", "target_url": "file:///nowhere/drone.mov"},
                "source_range": {"OTIO_SCHEMA": "TimeRange.1", "start_time": _rt(0), "duration": _rt(50)},
                "timeline_range": {"OTIO_SCHEMA": "TimeRange.1", "start_time": _rt(250), "duration": _rt(50)},
            },
            {
                "op_id": "op_a",
                "op_type": "INSERT_CLIP",
                "track_Selector": {"kind": "Audio", "index": 1},
                "media_reference": {"source_name": "tone.wav", "target_url": "file://" + media},
                "source_range": {"OTIO_SCHEMA": "TimeRange.1", "start_time": _rt(25), "duration": _rt(50)},
                "timeline_range": {"OTIO_SCHEMA": "TimeRange.1", "start_time": _rt(250), "duration": _rt(50)},
            },
        ],
    }


@pytest.fixture
def tone(tmp_path: Path) -> Path:
    """4 s: silence for 2 s, then a sine."""
    path = tmp_path / "media" / "tone.wav"
    path.parent.mkdir()
    subprocess.run(
        [
            "ffmpeg", "-v", "error", "-y",
            "-f", "lavfi", "-t", "2", "-i", "anullsrc=r=48000:cl=mono",
            "-f", "lavfi", "-t", "2", "-i", "sine=frequency=440:sample_rate=48000",
            "-filter_complex", "[0:a][1:a]concat=n=2:v=0:a=1[a]", "-map", "[a]", str(path),
        ],
        check=True,
    )  # fmt: skip
    return path


async def _binary(ws: WsClient, frame_type: int) -> tuple[int, int, int, bytes]:
    while True:
        opcode, data = await asyncio.wait_for(ws.receive(), timeout=10)
        if opcode == 0x2 and data[4] == frame_type:
            return unpack_binary_frame(data)


@needs_ffmpeg
def test_a_deltas_audio_op_gets_its_waveform_live_and_later(tmp_path: Path, tone: Path) -> None:
    """The A1 op's media, measured from its source range, reaches a client as 0x01 on the delta's first
    MUTATION_EMITTED seq and the op's index; the picture op (and its missing file) gets none; a later
    client gets the waveform after the welcome; the commit doesn't measure again."""
    from vibecut_agent.telemetry.instrument import TraceEmitter

    async def check(gateway: Gateway) -> None:
        ws = await WsClient.connect(gateway.port)
        await ws.send_json(_hello(trace="trc_audio"))
        assert (await ws.receive_json())["type"] == "SERVER_WELCOME"
        emitter = TraceEmitter(TelemetryBus(tmp_path), "trc_audio")
        emitter.ensure_root()
        delta = _audio_delta(str(tone))
        for stage in ("PROPOSED", "VALIDATED", "COMMITTED"):
            emitter.mutation(
                "task_x", stage, delta, agent_id="worker.otio_cutter.01", subagent="PACING_CUTTER"
            )
        envelopes = emitter.bus.flush()
        first = next(e for e in envelopes if e["event_type"] == "MUTATION_EMITTED")
        frame_type, channel, seq_id, payload = await _binary(ws, FRAME_AUDIO_PEAKS)
        assert (frame_type, channel, seq_id) == (FRAME_AUDIO_PEAKS, 1, first["seq_id"])
        peaks = struct.unpack(f"<{len(payload) // 2}h", payload)
        assert len(peaks) == 512
        # 1 s to 3 s of the file: silent, then the sine from the middle.
        assert max(peaks[:240]) < 200 and min(peaks[300::2]) < -3000
        await asyncio.sleep(0.3)
        assert len(gateway.peaks["trc_audio"]) == 1
        await ws.close()

        later = await WsClient.connect(gateway.port)
        await later.send_json(_hello(trace="trc_audio"))
        assert (await later.receive_json())["type"] == "SERVER_WELCOME"
        assert (await _binary(later, FRAME_AUDIO_PEAKS))[1:3] == (1, first["seq_id"])
        await later.close()

    with_gateway(check, tmp_path)


@needs_ffmpeg
def test_a_scrub_request_gets_the_sound_under_the_playhead(tmp_path: Path, tone: Path) -> None:
    """At 11.5 s on the timeline the A1 op is 1.5 s in, so 2.5 s into the file: the sine, as 0.25 s of
    48 kHz s16le to that client alone. Elsewhere, or for an op whose file isn't here, the reason."""
    from vibecut_agent.telemetry.instrument import TraceEmitter

    async def scrub(ws: WsClient, **request: Any) -> None:
        await ws.send_json(
            {"type": "SCRUB_REQUEST", "trace_id": "trc_scrub", "delta_id": "delta_a", **request}
        )

    async def check(gateway: Gateway) -> None:
        emitter = TraceEmitter(TelemetryBus(tmp_path), "trc_scrub")
        emitter.ensure_root()
        emitter.mutation(
            "task_x",
            "PROPOSED",
            _audio_delta(str(tone)),
            agent_id="worker.otio_cutter.01",
            subagent="PACING_CUTTER",
        )
        envelopes = emitter.bus.flush()
        first = next(e for e in envelopes if e["event_type"] == "MUTATION_EMITTED")
        for _ in range(100):
            if "delta_a" in gateway.deltas.get("trc_scrub", {}):
                break
            await asyncio.sleep(0.02)
        ws = await WsClient.connect(gateway.port)
        await ws.send_json(_hello(trace="trc_scrub"))
        assert (await ws.receive_json())["type"] == "SERVER_WELCOME"

        await scrub(ws, request_id=1, op_id="op_a", timeline_seconds=11.5)
        _, channel, seq_id, payload = await _binary(ws, FRAME_SCRUB_AUDIO)
        assert (channel, seq_id, len(payload)) == (1, first["seq_id"], 24_000)
        assert max(struct.unpack("<12000h", payload)) > 3000

        refusals: list[tuple[int, dict[str, Any], str]] = [
            (2, {"op_id": "op_a", "timeline_seconds": 30.0}, "isn't over this op"),
            (3, {"op_id": "op_v", "timeline_seconds": 10.5}, "isn't a file"),
            (4, {"op_id": "op_missing", "timeline_seconds": 10.5}, "isn't in the delta"),
            (5, {"op_id": "op_a", "timeline_seconds": "soon"}, "must be a number"),
        ]
        for request_id, request, reason in refusals:
            await scrub(ws, request_id=request_id, **request)
            answer = await ws.receive_json()
            assert answer["type"] == "SCRUB_UNAVAILABLE" and answer["request_id"] == request_id
            assert reason in answer["reason"]
        await ws.send_json(
            {"type": "SCRUB_REQUEST", "trace_id": "trc_scrub", "delta_id": "nope", "request_id": 6}
        )
        assert "isn't in this trace" in (await ws.receive_json())["reason"]
        await ws.close()

    with_gateway(check, tmp_path)


def test_only_a_local_file_an_op_names_is_read(tmp_path: Path) -> None:
    from vibecut_agent.telemetry.gateway import media_of, op_span

    real = tmp_path / "a b.wav"
    real.write_bytes(b"")
    assert media_of({"target_url": "file://" + str(real).replace(" ", "%20")}) == str(real)
    assert media_of({"target_url": str(real)}) == str(real)
    assert media_of({"target_url": "file://other-mac" + str(real)}) is None
    assert media_of({"target_url": "https://example.com/a.wav"}) is None
    assert media_of({"target_url": "relative.wav"}) is None
    assert media_of({"target_url": None}) is None
    assert (
        op_span({"timeline_range": {"start_time": _rt(25), "duration": _rt(50)}, "source_range": None})
        is None
    )
    assert op_span(
        {
            "timeline_range": {"start_time": _rt(25), "duration": _rt(50)},
            "source_range": {"start_time": _rt(100), "duration": _rt(50)},
        }
    ) == (1.0, 2.0, 4.0)


def test_an_unmasked_frame_closes_the_connection(tmp_path: Path) -> None:
    async def check(gateway: Gateway) -> None:
        ws = await WsClient.connect(gateway.port)
        ws.writer.write(bytes([0x81, 2]) + b"{}")
        await ws.writer.drain()
        opcode, data = await ws.receive()
        assert opcode == 0x8 and struct.unpack(">H", data[:2])[0] == 1002

    with_gateway(check, tmp_path)


def test_sse_streams_batches(tmp_path: Path) -> None:
    async def check(gateway: Gateway) -> None:
        reader, writer = await asyncio.open_connection("127.0.0.1", gateway.port)
        writer.write(
            f"GET /sse/v1/telemetry?trace_id=trc_sse HTTP/1.1\r\nHost: 127.0.0.1:{gateway.port}\r\n\r\n".encode()
        )
        head = (await reader.readuntil(b"\r\n\r\n")).decode()
        assert "text/event-stream" in head
        await asyncio.sleep(0.05)
        gateway.store.add(mock_emitter.generate("trc_other")[:2])
        gateway.store.add(mock_emitter.generate("trc_sse")[:3])
        while True:
            line = (await reader.readline()).decode().strip()
            if line.startswith("data: "):
                batch = json.loads(line[6:])
                break
        assert batch["trace_id"] == "trc_sse" and len(batch["events"]) == 3
        writer.close()

    with_gateway(check, tmp_path)


# ------------------------------------------------------------------------------ the command


def test_the_command_is_registered_and_reads_its_options(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    assert "telemetry-gateway" in COMMANDS
    monkeypatch.setenv("VIBECUT_TELEMETRY_PORT", "19999")
    monkeypatch.setenv("VIBECUT_APP_DATA_DIR", str(tmp_path))
    options = options_from({})
    assert (options["bind"], options["port"], options["folder"]) == (
        "127.0.0.1",
        19999,
        tmp_path / "telemetry",
    )
    chosen = options_from({"port": 0, "telemetryDir": str(tmp_path / "x")})
    assert (chosen["port"], chosen["folder"]) == (0, tmp_path / "x")


def test_the_command_serves_until_stopped(tmp_path: Path) -> None:
    env = {**os.environ, "PYTHONPATH": str(REPO / "src-python"), "VIBECUT_APP_DATA_DIR": str(tmp_path)}
    process = subprocess.Popen(
        [sys.executable, "-u", "-m", "vibecut_agent", "telemetry-gateway"],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
        env=env,
        text=True,
    )
    assert process.stdin is not None and process.stdout is not None
    process.stdin.write(json.dumps({"port": 0}))
    process.stdin.close()
    try:
        ready = json.loads(process.stdout.readline())
        assert ready["type"] == "ready"
        assert ready["wsUrl"].startswith("ws://127.0.0.1:") and ready["wsUrl"].endswith("/ws/v1/telemetry")
        assert ready["telemetryDir"] == str(tmp_path / "telemetry")
        port = int(ready["url"].rsplit(":", 1)[1])
        status, _, health = asyncio.run(http(port, "GET", "/api/v1/health"))
        assert status == 200 and health["status"] == "ok"
        process.terminate()
        assert json.loads(process.stdout.readline())["type"] == "done"
        assert process.wait(timeout=10) == 0
    finally:
        if process.poll() is None:
            process.kill()
