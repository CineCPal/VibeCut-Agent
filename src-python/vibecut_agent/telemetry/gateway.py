"""The telemetry gateway (visualizer-spec.md §5.2; PLAN.md, "Phase 22"): HTTP, SSE and WebSocket on
`127.0.0.1:18765`, built on `asyncio.start_server` with the stdlib only (RFC 6455 framing by hand: sha1,
base64, struct), so the sidecar's locked base install doesn't grow.

Events come from two places into one `TraceStore`:
- this process's own bus (a mock run started with TRIGGER_MOCK_RUN), through a bus listener;
- `JournalTailer`, which reads `<appDataDir>/telemetry/*.jsonl` every 100 ms. Those files are written by the
  processes that do the work: the MCP shim's tool bus and the `ingest-index` command. Each trace has one
  writer, so its seq ids run on without gaps.

The store keeps each trace's events by seq id (a line read twice is the same event), serves
`/events?from_seq&to_seq` for gap recovery and `/snapshot` for hydration (snapshot.py), and sends what's new
to the WebSocket and SSE clients.

Endpoints:
- `WS /ws/v1/telemetry`: CLIENT_HELLO -> SERVER_WELCOME, then TELEMETRY_BATCH frames, PING -> PONG, and VCTB
  binary frames. A COMPLETED whose VLM_SHOT_TAGS artifact names contact strips gets each one as a 0x02
  frame tied to its seq id, read from `<folder>/strips/<id>.jpg` (instrument.TraceEmitter.attach_strip);
  a client that connects later gets its trace's strips after the welcome.
  Each delta's audio-lane ops get their media's waveform (0x01; seq = the delta's first MUTATION_EMITTED,
  channel = the op's index), measured here by ffmpeg from the op's own `target_url` and `source_range`, and
  sent again to a later client. `SCRUB_REQUEST {request_id, trace_id, delta_id, op_id, timeline_seconds}`
  answers that client alone with 0.25 s of the sound under the playhead (0x03, 48 kHz mono s16le, same
  seq and channel), or `SCRUB_UNAVAILABLE {request_id, reason}`. Only media a trace's ops named is read.
- `GET /sse/v1/telemetry?trace_id=`
- `GET /api/v1/health`
- `GET /api/v1/traces`
- `GET /api/v1/traces/{id}/snapshot`, whole; or a page of its replay with `?offset=&limit=` (at most 20,000),
  pinned to one seq with `&at_seq=` (the first page's `snapshot_seq_id`), so a 100k-row trace loads in pages
  without the viewer freezing. Page one carries the reduced state too; every page has `replay_total`.
- `GET /api/v1/traces/{id}/events?from_seq=&to_seq=`
- `POST /api/v1/control/{id}` with `{action, params}`. PAUSE, RESUME and TRIGGER_MOCK_RUN are the gateway's
  own. CANCEL, REVEAL_IN_FINDER and SET_NLE_PLAYHEAD are the app's: a gateway the app started (request
  `{"appControl": true}`, sidecar.rs `start_gateway`) checks them and hands them on as a `control` event on
  stdout, which the app carries out (visualizer.rs); any other gateway answers 409.

The Premiere panel (PLAN.md, "The Telemetry Studio in Premiere's panel", V20): a CEP page is a `file://`
page, whose requests carry `Origin: null` (WebSocket: `file://`). That's also what a sandboxed iframe on
any website sends, so such an origin is let in only with the panel key: a random key per run, written with
the gateway's address to `<folder>/gateway.json`, readable by this user only. The panel reads it with
CEP's Node `fs`; a web page can't. The key goes as `?token=` or `Bearer`.

Security (V5): the gateway binds loopback by default. A non-loopback bind (VIBECUT_TELEMETRY_BIND, for an
iPad on the studio LAN) is refused unless VIBECUT_TELEMETRY_TOKEN is set; with a token, every HTTP request
must carry it (`Authorization: Bearer`, or `?token=` for EventSource and WebSocket) and so must the
WebSocket hello. Without a token, a browser page from another origin can't read it: requests whose `Origin`
or `Host` isn't loopback are refused (DNS rebinding, cross-site WebSocket hijacking)."""

from __future__ import annotations

import asyncio
import base64
import contextlib
import hashlib
import hmac
import ipaddress
import json
import math
import os
import re
import secrets
import signal
import struct
import sys
import time
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, TextIO
from urllib.parse import parse_qs, unquote, urlsplit

from vibecut_agent.telemetry.bus import Envelope, TelemetryBus, telemetry_dir, validate_envelope
from vibecut_agent.telemetry.snapshot import snapshot

VERSION = "1.0.0"
PROTOCOL_VERSION = "vibecut.ws.v1"
DEFAULT_BIND = "127.0.0.1"
DEFAULT_PORT = 18765
BIND_ENV = "VIBECUT_TELEMETRY_BIND"
PORT_ENV = "VIBECUT_TELEMETRY_PORT"
TOKEN_ENV = "VIBECUT_TELEMETRY_TOKEN"
WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"
HEARTBEAT_INTERVAL_MS = 5000
TAIL_INTERVAL_SECONDS = 0.1
MAX_HEADER_BYTES = 16 * 1024
MAX_BODY_BYTES = 64 * 1024
MAX_WS_MESSAGE_BYTES = 1024 * 1024
MAX_EVENTS_PER_TRACE = 200_000
MAX_EVENTS_PER_RESPONSE = 20_000
CLIENT_QUEUE_SIZE = 512
# A journal touched this recently is a live run.
LIVE_SECONDS = 30.0
# The file a gateway with a folder writes for the Premiere panel (V20), and the origins a CEP page sends.
GATEWAY_FILE = "gateway.json"
FILE_ORIGINS = frozenset({"null", "file://"})
# A snapshot page's largest replay, and the snapshots kept for paging (by trace and seq).
MAX_SNAPSHOT_PAGE = 20_000
SNAPSHOTS_KEPT = 4
# A client this many events behind is sent to the snapshot rather than replayed.
REPLAY_LIMIT = 2_000
# A contact strip is a 3-panel JPEG of about 100 KB; anything far bigger isn't one.
MAX_STRIP_BYTES = 4 * 1024 * 1024
STRIP_ID = re.compile(r"[A-Za-z0-9_-]{1,160}")
# The actions only the app can carry out, and a chat's trace id (bus.trace_id_for("mcp", job id)).
APP_ACTIONS = ("CANCEL", "REVEAL_IN_FINDER", "SET_NLE_PLAYHEAD")
MCP_TRACE = re.compile(r"trc_mcp_([A-Za-z0-9-]{1,48})_[0-9a-f]{6}")
SSE_KEEPALIVE_SECONDS = 15.0

# VCTB binary frames (§5.2 C).
VCTB_MAGIC = 0x56435442
VCTB_HEADER = struct.Struct(">IBBHII")
FRAME_AUDIO_PEAKS = 0x01
FRAME_CONTACT_STRIP = 0x02
FRAME_SCRUB_AUDIO = 0x03
# The OTIO dock's audio (PLAN.md, "Real audio in the OTIO dock"): the traces and ops a gateway keeps
# waveforms for, and how many ffmpeg runs at once.
MAX_AUDIO_TRACES = 64
MAX_PEAK_OPS = 32
AUDIO_JOBS = 2

OP_CONTINUATION, OP_TEXT, OP_BINARY, OP_CLOSE, OP_PING, OP_PONG = 0x0, 0x1, 0x2, 0x8, 0x9, 0xA

STATUS_TEXT = {
    101: "Switching Protocols",
    200: "OK",
    204: "No Content",
    400: "Bad Request",
    401: "Unauthorized",
    403: "Forbidden",
    404: "Not Found",
    405: "Method Not Allowed",
    409: "Conflict",
    413: "Payload Too Large",
    426: "Upgrade Required",
}


class GatewayError(Exception):
    """A refusal with its HTTP status."""

    def __init__(self, status: int, message: str) -> None:
        super().__init__(message)
        self.status = status


def pack_binary_frame(frame_type: int, channel: int, seq_id: int, payload: bytes) -> bytes:
    """A VCTB frame: magic, type (u8), channel (u8), reserved (u16 = 0), seq id (u32), length (u32), then
    the payload, big-endian."""
    if not 0 <= frame_type <= 0xFF or not 0 <= channel <= 0xFF:
        raise ValueError("frame_type and channel are single bytes")
    if not 0 <= seq_id <= 0xFFFFFFFF:
        raise ValueError("seq_id must fit in 32 bits")
    return VCTB_HEADER.pack(VCTB_MAGIC, frame_type, channel, 0, seq_id, len(payload)) + payload


def unpack_binary_frame(frame: bytes) -> tuple[int, int, int, bytes]:
    """(frame_type, channel, seq_id, payload) of a VCTB frame."""
    if len(frame) < VCTB_HEADER.size:
        raise ValueError("A VCTB frame has a 16-byte header")
    magic, frame_type, channel, _reserved, seq_id, length = VCTB_HEADER.unpack_from(frame)
    if magic != VCTB_MAGIC:
        raise ValueError("Not a VCTB frame")
    if len(frame) - VCTB_HEADER.size != length:
        raise ValueError("The VCTB frame's length doesn't match its payload")
    return frame_type, channel, seq_id, frame[VCTB_HEADER.size :]


def accept_key(key: str) -> str:
    return base64.b64encode(hashlib.sha1((key + WS_GUID).encode("ascii")).digest()).decode("ascii")


def is_loopback_host(host: str) -> bool:
    name = host.strip().strip("[]").lower()
    if name in ("localhost", ""):
        return True
    try:
        return ipaddress.ip_address(name).is_loopback
    except ValueError:
        return False


def is_loopback_origin(origin: str) -> bool:
    """An Origin header naming a loopback host. `null` and `file://` have no host: they're not loopback
    (an empty Host header is, for a request without one, but no page's origin is empty)."""
    netloc = urlsplit(origin).netloc
    return bool(netloc) and is_loopback_host(host_of(netloc))


def host_of(value: str) -> str:
    """`host` of `host:port`, `[v6]:port`, or a URL's netloc."""
    value = value.strip()
    if value.startswith("["):
        return value[1 : value.find("]")] if "]" in value else value
    return value.rsplit(":", 1)[0] if value.count(":") == 1 else value


# ------------------------------------------------------------------------------ the trace store


@dataclass
class Trace:
    trace_id: str
    events: dict[int, Envelope] = field(default_factory=dict)
    latest_seq_id: int = 0
    source: str = "live"
    updated: float = field(default_factory=time.time)

    def summary(self) -> dict[str, Any]:
        stamps = [e["timestamp_ms"] for e in self.events.values()]
        return {
            "trace_id": self.trace_id,
            "latest_seq_id": self.latest_seq_id,
            "event_count": len(self.events),
            "first_timestamp_ms": min(stamps) if stamps else None,
            "last_timestamp_ms": max(stamps) if stamps else None,
            "live": time.time() - self.updated < LIVE_SECONDS,
            "source": self.source,
        }


class TraceStore:
    """Every trace's events by seq id; tells its listeners what's new."""

    def __init__(self) -> None:
        self.traces: dict[str, Trace] = {}
        self.listeners: list[Callable[[str, list[Envelope]], None]] = []
        self.binary_listeners: list[Callable[[str, bytes], None]] = []
        self._snapshots: dict[tuple[str, int], dict[str, Any]] = {}

    def add(self, envelopes: list[Envelope], source: str = "live", updated: float | None = None) -> None:
        fresh: dict[str, list[Envelope]] = {}
        for env in envelopes:
            if validate_envelope(env):
                continue
            trace = self.traces.get(env["trace_id"])
            if trace is None:
                trace = self.traces[env["trace_id"]] = Trace(env["trace_id"], source=source)
            seq_id = env["seq_id"]
            if seq_id in trace.events:
                continue
            trace.events[seq_id] = env
            trace.latest_seq_id = max(trace.latest_seq_id, seq_id)
            trace.updated = updated if updated is not None else time.time()
            if len(trace.events) > MAX_EVENTS_PER_TRACE:
                del trace.events[min(trace.events)]
            fresh.setdefault(env["trace_id"], []).append(env)
        for trace_id, events in fresh.items():
            events.sort(key=lambda e: e["seq_id"])
            for listener in list(self.listeners):
                listener(trace_id, events)

    def add_binary(self, trace_id: str, frame: bytes) -> None:
        for listener in list(self.binary_listeners):
            listener(trace_id, frame)

    def active_trace_id(self) -> str | None:
        if not self.traces:
            return None
        return max(self.traces.values(), key=lambda t: t.updated).trace_id

    def latest_seq(self, trace_id: str | None) -> int:
        trace = self.traces.get(trace_id or "")
        return trace.latest_seq_id if trace else 0

    def events(self, trace_id: str, from_seq: int = 1, to_seq: int | None = None) -> list[Envelope]:
        trace = self.traces.get(trace_id)
        if trace is None:
            return []
        upper = trace.latest_seq_id if to_seq is None else min(to_seq, trace.latest_seq_id)
        found = [trace.events[s] for s in range(max(1, from_seq), upper + 1) if s in trace.events]
        return found[:MAX_EVENTS_PER_RESPONSE]

    def snapshot(self, trace_id: str) -> dict[str, Any]:
        trace = self.traces.get(trace_id)
        return snapshot(trace_id, list(trace.events.values()) if trace else [])

    def snapshot_page(
        self, trace_id: str, offset: int, limit: int, at_seq: int | None = None
    ) -> dict[str, Any]:
        """Replay events [offset, offset + limit) of the snapshot at `at_seq` (default: now), and how many there
        are. The first page also has the reduced state. The snapshot is worked out once per (trace, seq) and
        kept for the pages after, as later events don't change it."""
        trace = self.traces.get(trace_id)
        latest = trace.latest_seq_id if trace else 0
        seq = latest if at_seq is None else max(0, min(at_seq, latest))
        key = (trace_id, seq)
        whole = self._snapshots.get(key)
        if whole is None:
            events = [e for s, e in trace.events.items() if s <= seq] if trace else []
            whole = snapshot(trace_id, events)
            self._snapshots[key] = whole
            while len(self._snapshots) > SNAPSHOTS_KEPT:
                del self._snapshots[next(iter(self._snapshots))]
        replay = whole["replay_events"]
        offset = max(0, offset)
        page = {
            "trace_id": trace_id,
            "snapshot_seq_id": whole["snapshot_seq_id"],
            "replay_total": len(replay),
            "replay_offset": offset,
            "replay_events": replay[offset : offset + max(1, min(limit, MAX_SNAPSHOT_PAGE))],
        }
        if offset == 0:
            page = {**whole, **page}
        return page


class JournalTailer:
    """Reads new lines of `<folder>/*.jsonl` into the store, from where it last stopped in each file."""

    def __init__(self, folder: Path, store: TraceStore) -> None:
        self.folder = folder
        self.store = store
        self.offsets: dict[Path, int] = {}
        self.partial: dict[Path, bytes] = {}

    def poll(self) -> int:
        """Reads what's new; the number of events read."""
        try:
            paths = sorted(self.folder.glob("*.jsonl"))
        except OSError:
            return 0
        count = 0
        for path in paths:
            count += self._read(path)
        return count

    def _read(self, path: Path) -> int:
        try:
            stat = path.stat()
        except OSError:
            return 0
        offset = self.offsets.get(path, 0)
        if stat.st_size < offset:
            # Rewritten from the start (a mock run written again): read it afresh.
            offset = 0
            self.partial.pop(path, None)
        if stat.st_size == offset:
            return 0
        try:
            with path.open("rb") as fh:
                fh.seek(offset)
                data = fh.read(stat.st_size - offset)
        except OSError:
            return 0
        self.offsets[path] = offset + len(data)
        data = self.partial.pop(path, b"") + data
        lines = data.split(b"\n")
        if lines[-1]:
            # A line still being written: kept for the next read.
            self.partial[path] = lines[-1]
        envelopes = []
        for line in lines[:-1]:
            if not line.strip():
                continue
            try:
                envelopes.append(json.loads(line))
            except (json.JSONDecodeError, UnicodeDecodeError):
                continue
        self.store.add(envelopes, source="journal", updated=stat.st_mtime)
        return len(envelopes)

    async def run(self, interval: float = TAIL_INTERVAL_SECONDS) -> None:
        while True:
            self.poll()
            await asyncio.sleep(interval)


# ------------------------------------------------------------------------------ HTTP and WebSocket plumbing


@dataclass
class Request:
    method: str
    path: str
    query: dict[str, list[str]]
    headers: dict[str, str]
    body: bytes = b""

    def param(self, name: str) -> str | None:
        values = self.query.get(name)
        return values[0] if values else None


async def read_request(reader: asyncio.StreamReader) -> Request | None:
    try:
        head = await reader.readuntil(b"\r\n\r\n")
    except asyncio.IncompleteReadError:
        return None
    except asyncio.LimitOverrunError:
        raise GatewayError(413, "The request's headers are too long") from None
    if len(head) > MAX_HEADER_BYTES:
        raise GatewayError(413, "The request's headers are too long")
    lines = head.decode("latin-1").split("\r\n")
    try:
        method, target, _version = lines[0].split(" ", 2)
    except ValueError:
        raise GatewayError(400, "Malformed request line") from None
    headers: dict[str, str] = {}
    for line in lines[1:]:
        if ":" in line:
            name, value = line.split(":", 1)
            headers[name.strip().lower()] = value.strip()
    url = urlsplit(target)
    body = b""
    length = int(headers.get("content-length", "0") or 0)
    if length > MAX_BODY_BYTES:
        raise GatewayError(413, "The request's body is too long")
    if length:
        body = await reader.readexactly(length)
    return Request(method.upper(), url.path, parse_qs(url.query), headers, body)


class WebSocket:
    """One server-side RFC 6455 connection."""

    def __init__(self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        self.reader = reader
        self.writer = writer
        self.closed = False
        self._lock = asyncio.Lock()

    async def _send(self, opcode: int, data: bytes) -> None:
        if self.closed and opcode != OP_CLOSE:
            return
        length = len(data)
        if length < 126:
            header = struct.pack(">BB", 0x80 | opcode, length)
        elif length < 1 << 16:
            header = struct.pack(">BBH", 0x80 | opcode, 126, length)
        else:
            header = struct.pack(">BBQ", 0x80 | opcode, 127, length)
        async with self._lock:
            self.writer.write(header + data)
            await self.writer.drain()

    async def send_text(self, text: str) -> None:
        await self._send(OP_TEXT, text.encode("utf-8"))

    async def send_bytes(self, data: bytes) -> None:
        await self._send(OP_BINARY, data)

    async def close(self, code: int = 1000, reason: str = "") -> None:
        if self.closed:
            return
        self.closed = True
        with contextlib.suppress(ConnectionError, RuntimeError):
            await self._send(OP_CLOSE, struct.pack(">H", code) + reason.encode("utf-8")[:120])

    async def _frame(self) -> tuple[bool, int, bytes]:
        first, second = await self.reader.readexactly(2)
        fin, opcode = bool(first & 0x80), first & 0x0F
        if first & 0x70:
            raise GatewayError(400, "Reserved bits set without an extension")
        if not second & 0x80:
            raise GatewayError(400, "A client's frames must be masked")
        length = second & 0x7F
        if length == 126:
            (length,) = struct.unpack(">H", await self.reader.readexactly(2))
        elif length == 127:
            (length,) = struct.unpack(">Q", await self.reader.readexactly(8))
        if length > MAX_WS_MESSAGE_BYTES:
            raise GatewayError(413, "The message is too long")
        if opcode >= 0x8 and (length > 125 or not fin):
            raise GatewayError(400, "A control frame must be whole and short")
        mask = await self.reader.readexactly(4)
        data = bytearray(await self.reader.readexactly(length))
        for i in range(length):
            data[i] ^= mask[i % 4]
        return fin, opcode, bytes(data)

    async def receive(self) -> tuple[int, bytes] | None:
        """The next text or binary message (pings answered, fragments joined); None once closed."""
        message = bytearray()
        message_opcode: int | None = None
        while True:
            try:
                fin, opcode, data = await self._frame()
            except (asyncio.IncompleteReadError, ConnectionError):
                self.closed = True
                return None
            except GatewayError as exc:
                await self.close(1002 if exc.status == 400 else 1009, str(exc))
                return None
            if opcode == OP_PING:
                await self._send(OP_PONG, data)
                continue
            if opcode == OP_PONG:
                continue
            if opcode == OP_CLOSE:
                code = struct.unpack(">H", data[:2])[0] if len(data) >= 2 else 1000
                await self.close(code)
                return None
            if opcode == OP_CONTINUATION:
                if message_opcode is None:
                    await self.close(1002, "A continuation with nothing to continue")
                    return None
            elif opcode in (OP_TEXT, OP_BINARY):
                if message_opcode is not None:
                    await self.close(1002, "A new message before the last one ended")
                    return None
                message_opcode = opcode
            else:
                await self.close(1002, "Unknown opcode")
                return None
            message += data
            if len(message) > MAX_WS_MESSAGE_BYTES:
                await self.close(1009, "The message is too long")
                return None
            if fin:
                return message_opcode, bytes(message)


@dataclass(eq=False)
class Client:
    """A WebSocket or SSE viewer: what it follows, and its outgoing queue."""

    kind: str
    trace_id: str | None = None
    queue: asyncio.Queue[str | bytes] = field(default_factory=lambda: asyncio.Queue(CLIENT_QUEUE_SIZE))
    ready: bool = False
    # The newest scrub request not yet answered, and the task answering them (one at a time, newest wins).
    scrub_next: dict[str, Any] | None = None
    scrub_worker: asyncio.Task[Any] | None = None

    def follows(self, trace_id: str) -> bool:
        return self.ready and (self.trace_id is None or self.trace_id == trace_id)


# ------------------------------------------------------------------------------ the OTIO dock's audio


def media_of(op: dict[str, Any]) -> str | None:
    """The local file an op's `target_url` names (an absolute path or a `file://` URL), when it's there."""
    url = op.get("target_url")
    if not isinstance(url, str) or not url:
        return None
    if url.startswith("file://"):
        parts = urlsplit(url)
        if parts.netloc not in ("", "localhost"):
            return None
        url = unquote(parts.path)
    if not os.path.isabs(url) or not os.path.isfile(url):
        return None
    return url


def _seconds(value: Any) -> float | None:
    if not isinstance(value, dict):
        return None
    count, rate = value.get("value"), value.get("rate")
    if not isinstance(count, int | float) or not isinstance(rate, int | float) or rate <= 0:
        return None
    return float(count) / float(rate)


def op_span(op: dict[str, Any]) -> tuple[float, float, float] | None:
    """(timeline start, duration, source start) in seconds; None without a source range, which an op
    over a clip already on the timeline (a duck) may not have: then nothing says where in the file it is."""
    timeline = op.get("timeline_range") or {}
    source = op.get("source_range")
    if not isinstance(timeline, dict) or not isinstance(source, dict):
        return None
    start = _seconds(timeline.get("start_time"))
    duration = _seconds(timeline.get("duration"))
    source_start = _seconds(source.get("start_time"))
    if start is None or duration is None or source_start is None or duration <= 0 or source_start < 0:
        return None
    return start, duration, source_start


def _range_peaks(path: str, start: float, duration: float) -> bytes:
    from vibecut_agent.core import ffmpeg_ops  # imported here: the gateway starts on the stdlib alone

    return ffmpeg_ops.range_peaks(path, start, min(duration, ffmpeg_ops.MAX_PEAKS_SECONDS))


def _scrub_pcm(path: str, at: float) -> bytes:
    from vibecut_agent.core import ffmpeg_ops

    return ffmpeg_ops.scrub_pcm(path, at)


# ------------------------------------------------------------------------------ the gateway


class Gateway:
    def __init__(
        self,
        folder: Path | None = None,
        *,
        bind: str = DEFAULT_BIND,
        port: int = DEFAULT_PORT,
        token: str | None = None,
        bus: TelemetryBus | None = None,
        tail_interval: float = TAIL_INTERVAL_SECONDS,
        forward: Callable[[dict[str, Any]], None] | None = None,
    ) -> None:
        if not is_loopback_host(bind) and not token:
            raise GatewayError(
                403,
                f"Serving telemetry on {bind} would let anyone on the network read it: set "
                f"{TOKEN_ENV} too, or bind 127.0.0.1",
            )
        self.folder = folder
        self.bind = bind
        self.port = port
        self.token = token or None
        self.store = TraceStore()
        # V20: what a CEP page (Origin null or file://) must show; written to gateway.json at start.
        self.panel_key = secrets.token_urlsafe(24)
        self.bus = bus or TelemetryBus(folder, heartbeat=True)
        self.tailer = JournalTailer(folder, self.store) if folder is not None else None
        self.tail_interval = tail_interval
        self.clients: set[Client] = set()
        self.paused = False
        self.mock_runs = 0
        # Hands the app's control actions to the app that started this gateway (None: nobody to ask).
        self.forward = forward
        self._server: asyncio.Server | None = None
        self._tasks: set[asyncio.Task[Any]] = set()
        self._connections: set[asyncio.StreamWriter] = set()
        self.store.listeners.append(self._broadcast)
        self.store.binary_listeners.append(self._broadcast_binary)
        self.store.listeners.append(self._send_strips)
        # Each trace's contact strips as (seq id, strip id), sent again to a client that connects later.
        self.strips: dict[str, list[tuple[int, str]]] = {}
        self.store.listeners.append(self._send_peaks)
        # Each trace's deltas as delta id -> (first seq, op summaries), for waveforms and scrub requests,
        # and the waveform frames made, sent again to a later client. Oldest trace dropped first.
        self.deltas: dict[str, dict[str, tuple[int, list[Any]]]] = {}
        self.peaks: dict[str, list[bytes]] = {}
        self._audio_slots = asyncio.Semaphore(AUDIO_JOBS)
        self.bus.add_listener(lambda envelopes: self.store.add(envelopes))
        self.bus.active_workers = lambda: len(self.clients)

    @property
    def url(self) -> str:
        return f"http://{self.bind}:{self.port}"

    async def start(self) -> None:
        if self.tailer is not None:
            self.tailer.poll()
            self._spawn(self.tailer.run(self.tail_interval))
        await self.bus.start()
        self._server = await asyncio.start_server(
            self._handle, self.bind, self.port, limit=MAX_HEADER_BYTES * 4
        )
        sockets = self._server.sockets
        if sockets:
            self.port = int(sockets[0].getsockname()[1])
        self._write_gateway_file()

    def _write_gateway_file(self) -> None:
        """`<folder>/gateway.json`: where this gateway is and the panel key (V20), this user's alone (0600),
        written to a temporary file and renamed. Nothing without a folder."""
        if self.folder is None:
            return
        body = json.dumps(
            {
                "url": self.url,
                "ws_url": f"ws://{self.bind}:{self.port}/ws/v1/telemetry",
                "panel_key": self.panel_key,
                "pid": os.getpid(),
            }
        )
        partial = self.folder / f".{GATEWAY_FILE}.{os.getpid()}"
        try:
            self.folder.mkdir(parents=True, exist_ok=True)
            fd = os.open(partial, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
            with os.fdopen(fd, "w", encoding="utf-8") as fh:
                fh.write(body)
            os.replace(partial, self.folder / GATEWAY_FILE)
        except OSError:
            with contextlib.suppress(OSError):
                partial.unlink()

    def _remove_gateway_file(self) -> None:
        """Removes gateway.json if it's still this gateway's (another may have started since)."""
        if self.folder is None:
            return
        path = self.folder / GATEWAY_FILE
        with contextlib.suppress(OSError, ValueError):
            if json.loads(path.read_text("utf-8")).get("panel_key") == self.panel_key:
                path.unlink()

    async def stop(self) -> None:
        self._remove_gateway_file()
        if self._server is not None:
            self._server.close()
            # wait_closed waits for every connection: a WebSocket or SSE viewer would hold it open.
            for client in list(self.clients):
                self._offer(client, b"")
            for writer in list(self._connections):
                writer.close()
            await self._server.wait_closed()
        for task in list(self._tasks):
            task.cancel()
        for task in list(self._tasks):
            with contextlib.suppress(asyncio.CancelledError, Exception):
                await task
        await self.bus.stop()

    def _spawn(self, coro: Awaitable[Any]) -> asyncio.Task[Any]:
        task: asyncio.Task[Any] = asyncio.ensure_future(coro)
        self._tasks.add(task)
        task.add_done_callback(self._tasks.discard)
        return task

    # Fan-out.

    def _offer(self, client: Client, message: str | bytes) -> None:
        try:
            client.queue.put_nowait(message)
        except asyncio.QueueFull:
            # Too slow to keep up: dropped, and told so (b""); it reconnects and catches up from the snapshot.
            self.clients.discard(client)
            while not client.queue.empty():
                client.queue.get_nowait()
            client.queue.put_nowait(b"")

    def _broadcast(self, trace_id: str, events: list[Envelope]) -> None:
        if self.paused:
            return
        for start in range(0, len(events), 128):
            frame = json.dumps(
                {"type": "TELEMETRY_BATCH", "trace_id": trace_id, "events": events[start : start + 128]},
                ensure_ascii=False,
            )
            for client in list(self.clients):
                if client.follows(trace_id):
                    self._offer(client, frame)

    def _broadcast_binary(self, trace_id: str, frame: bytes) -> None:
        if self.paused:
            return
        for client in list(self.clients):
            if client.kind == "ws" and client.follows(trace_id):
                self._offer(client, frame)

    def _strip_frame(self, seq_id: int, strip_id: str) -> bytes | None:
        if self.folder is None or not STRIP_ID.fullmatch(strip_id):
            return None
        path = self.folder / "strips" / f"{strip_id}.jpg"
        try:
            if path.stat().st_size > MAX_STRIP_BYTES:
                return None
            data = path.read_bytes()
        except OSError:
            return None
        return pack_binary_frame(FRAME_CONTACT_STRIP, 0, seq_id, data)

    def _send_strips(self, trace_id: str, events: list[Envelope]) -> None:
        for env in events:
            if env["event_type"] != "COMPLETED":
                continue
            for artifact in env["payload"].get("artifacts") or []:
                if artifact.get("artifact_type") != "VLM_SHOT_TAGS":
                    continue
                for strip_id in artifact.get("contact_strip_frame_ids") or []:
                    if not isinstance(strip_id, str):
                        continue
                    self.strips.setdefault(trace_id, []).append((env["seq_id"], strip_id))
                    frame = self._strip_frame(env["seq_id"], strip_id)
                    if frame is not None:
                        self.store.add_binary(trace_id, frame)

    def _send_peaks(self, trace_id: str, events: list[Envelope]) -> None:
        for env in events:
            if env["event_type"] != "MUTATION_EMITTED":
                continue
            delta_id = str(env["payload"].get("delta_id", ""))
            deltas = self.deltas.setdefault(trace_id, {})
            if delta_id in deltas:
                continue
            ops = list(env["payload"].get("operations") or [])
            deltas[delta_id] = (env["seq_id"], ops)
            while len(self.deltas) > MAX_AUDIO_TRACES:
                oldest = next(iter(self.deltas))
                self.deltas.pop(oldest)
                self.peaks.pop(oldest, None)
            jobs = []
            for index, op in enumerate(ops[:MAX_PEAK_OPS]):
                if not isinstance(op, dict) or op.get("track_kind") != "Audio":
                    continue
                span, path = op_span(op), media_of(op)
                if span is not None and path is not None:
                    jobs.append((index, path, span[2], span[1]))
            if jobs:
                try:
                    asyncio.get_running_loop()
                except RuntimeError:
                    continue
                self._spawn(self._make_peaks(trace_id, env["seq_id"], jobs))

    async def _make_peaks(
        self, trace_id: str, seq_id: int, jobs: list[tuple[int, str, float, float]]
    ) -> None:
        for index, path, start, duration in jobs:
            async with self._audio_slots:
                try:
                    data = await asyncio.to_thread(_range_peaks, path, start, duration)
                except Exception:  # noqa: BLE001, S112 - an unreadable file just has no waveform
                    continue
            self._add_peaks(trace_id, pack_binary_frame(FRAME_AUDIO_PEAKS, index, seq_id, data))

    def _add_peaks(self, trace_id: str, frame: bytes) -> None:
        if trace_id in self.deltas or trace_id in self.peaks:
            self.peaks.setdefault(trace_id, []).append(frame)
        self.store.add_binary(trace_id, frame)

    def _scrub_target(self, client: Client, message: dict[str, Any]) -> tuple[str, float, int, int] | str:
        """(file, source seconds, seq, channel) for a scrub request, or why there's nothing to play."""
        trace_id = message.get("trace_id")
        if not isinstance(trace_id, str) or not trace_id:
            trace_id = client.trace_id or self.store.active_trace_id() or ""
        delta = self.deltas.get(trace_id, {}).get(str(message.get("delta_id", "")))
        if delta is None:
            return "That delta isn't in this trace"
        seq_id, ops = delta
        index = next(
            (
                i
                for i, op in enumerate(ops)
                if isinstance(op, dict) and op.get("op_id") == message.get("op_id")
            ),
            None,
        )
        if index is None or index > 0xFF:
            return "That op isn't in the delta"
        at = message.get("timeline_seconds")
        if not isinstance(at, int | float) or isinstance(at, bool) or not math.isfinite(at):
            return "timeline_seconds must be a number"
        span = op_span(ops[index])
        if span is None:
            return "This op has no source range"
        start, duration, source_start = span
        if not start <= at < start + duration:
            return "The playhead isn't over this op"
        path = media_of(ops[index])
        if path is None:
            return "Its media isn't a file on this Mac"
        return path, source_start + (at - start), seq_id, index

    async def _answer_scrubs(self, client: Client) -> None:
        while client.scrub_next is not None:
            message, client.scrub_next = client.scrub_next, None
            target = self._scrub_target(client, message)
            if not isinstance(target, str):
                path, at, seq_id, channel = target
                async with self._audio_slots:
                    try:
                        data = await asyncio.to_thread(_scrub_pcm, path, at)
                    except Exception as exc:  # noqa: BLE001 - told to the viewer, not raised
                        target = str(exc)[:200] or "ffmpeg couldn't read its sound"
                if not isinstance(target, str):
                    self._offer(client, pack_binary_frame(FRAME_SCRUB_AUDIO, channel, seq_id, data))
                    continue
            request_id = message.get("request_id")
            self._offer(
                client,
                json.dumps(
                    {
                        "type": "SCRUB_UNAVAILABLE",
                        "request_id": request_id if isinstance(request_id, int | str) else None,
                        "reason": target,
                    }
                ),
            )

    # Connections.

    async def _handle(self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        self._connections.add(writer)
        try:
            request = await read_request(reader)
            if request is None:
                return
            await self._route(request, reader, writer)
        except GatewayError as exc:
            with contextlib.suppress(ConnectionError, RuntimeError):
                await self._respond(writer, exc.status, {"error": str(exc)}, None)
        except (ConnectionError, asyncio.IncompleteReadError):
            pass
        except Exception as exc:  # noqa: BLE001 - one bad connection never stops the gateway
            print(f"vibecut telemetry gateway: {type(exc).__name__}: {exc}", file=sys.stderr)
        finally:
            self._connections.discard(writer)
            with contextlib.suppress(ConnectionError, RuntimeError):
                writer.close()
                await writer.wait_closed()

    def _cors_origin(self, request: Request) -> str | None:
        origin = request.headers.get("origin")
        if origin is None:
            return None
        if self.token is not None or is_loopback_origin(origin):
            return origin
        # A CEP page: `_check` has already refused it unless it showed the panel key.
        if origin in FILE_ORIGINS:
            return origin
        return None

    @staticmethod
    def _given_token(request: Request) -> str:
        auth = request.headers.get("authorization", "")
        if auth.lower().startswith("bearer "):
            return auth[7:].strip()
        return request.param("token") or ""

    def _check(self, request: Request) -> None:
        """V5: a token when there is one; else only loopback hosts and origins, and a CEP page's origin
        with the panel key (V20)."""
        if self.token is not None:
            given = self._given_token(request)
            # The WebSocket's token comes in its hello.
            exempt = request.method == "OPTIONS" or request.path == "/ws/v1/telemetry"
            if not exempt and not hmac.compare_digest(given.encode(), self.token.encode()):
                raise GatewayError(401, "A telemetry token is needed")
            return
        if not is_loopback_host(host_of(request.headers.get("host", ""))):
            raise GatewayError(403, "Only this Mac may read its telemetry")
        origin = request.headers.get("origin")
        if origin is not None and not is_loopback_origin(origin):
            if origin in FILE_ORIGINS:
                # A preflight carries no key and gets no data; everything else needs it.
                if request.method == "OPTIONS" or hmac.compare_digest(
                    self._given_token(request).encode(), self.panel_key.encode()
                ):
                    return
                raise GatewayError(403, "A page from a file needs the panel key in gateway.json")
            raise GatewayError(403, "Only pages served from this Mac may read its telemetry")

    async def _respond(
        self,
        writer: asyncio.StreamWriter,
        status: int,
        body: Any,
        request: Request | None,
        content_type: str = "application/json",
    ) -> None:
        data = b"" if status == 204 else json.dumps(body, ensure_ascii=False).encode("utf-8")
        headers = [
            f"HTTP/1.1 {status} {STATUS_TEXT.get(status, 'OK')}",
            f"Content-Type: {content_type}; charset=utf-8",
            f"Content-Length: {len(data)}",
            "Cache-Control: no-store",
            "Connection: close",
        ]
        origin = self._cors_origin(request) if request is not None else None
        if origin is not None:
            headers += [
                f"Access-Control-Allow-Origin: {origin}",
                "Vary: Origin",
                "Access-Control-Allow-Methods: GET, POST, OPTIONS",
                "Access-Control-Allow-Headers: Content-Type, Authorization",
            ]
        writer.write(("\r\n".join(headers) + "\r\n\r\n").encode("latin-1") + data)
        await writer.drain()

    async def _route(
        self, request: Request, reader: asyncio.StreamReader, writer: asyncio.StreamWriter
    ) -> None:
        self._check(request)
        if request.method == "OPTIONS":
            await self._respond(writer, 204, None, request)
            return
        parts = [p for p in request.path.split("/") if p]
        if request.path == "/ws/v1/telemetry":
            await self._websocket(request, reader, writer)
        elif request.path == "/sse/v1/telemetry" and request.method == "GET":
            await self._sse(request, reader, writer)
        elif request.path == "/api/v1/health" and request.method == "GET":
            await self._respond(writer, 200, self.health(), request)
        elif request.path == "/api/v1/traces" and request.method == "GET":
            await self._respond(writer, 200, {"traces": self.trace_summaries()}, request)
        elif len(parts) == 5 and parts[:3] == ["api", "v1", "traces"] and request.method == "GET":
            trace_id = parts[3]
            if parts[4] == "snapshot":
                offset, limit, at_seq = (request.param(name) for name in ("offset", "limit", "at_seq"))
                if offset is None and limit is None and at_seq is None:
                    body = self.store.snapshot(trace_id)
                else:
                    try:
                        body = self.store.snapshot_page(
                            trace_id,
                            int(offset or 0),
                            int(limit or MAX_SNAPSHOT_PAGE),
                            int(at_seq) if at_seq else None,
                        )
                    except ValueError:
                        raise GatewayError(400, "offset, limit and at_seq are whole numbers") from None
                await self._respond(writer, 200, body, request)
            elif parts[4] == "events":
                from_seq = int(request.param("from_seq") or 1)
                to_seq_text = request.param("to_seq")
                events = self.store.events(trace_id, from_seq, int(to_seq_text) if to_seq_text else None)
                await self._respond(writer, 200, events, request)
            else:
                raise GatewayError(404, "No such endpoint")
        elif len(parts) == 4 and parts[:3] == ["api", "v1", "control"]:
            if request.method != "POST":
                raise GatewayError(405, "Control takes POST")
            status, body = await self.control(parts[3], request.body)
            await self._respond(writer, status, body, request)
        else:
            raise GatewayError(404, "No such endpoint")

    # The endpoints.

    def health(self) -> dict[str, Any]:
        from vibecut_agent.config import OrchestratorConfig

        config = OrchestratorConfig.from_env()
        return {
            "status": "ok",
            "version": VERSION,
            "active_trace_id": self.store.active_trace_id(),
            "connected_clients": len(self.clients),
            "host_metrics": self.bus.resource_sample(),
            "workers": {
                "execution_mode": str(config.execution_mode),
                "whisper": {"backend": config.whisper_backend, "model": config.whisper_model},
                "vlm": {"model": config.vlm_model},
                "vector": {"backend": config.vector_backend, "model": config.embed_model},
                "validator": {"model": config.gemma_model},
            },
            "telemetry_dir": str(self.folder) if self.folder is not None else None,
            "paused": self.paused,
            "app_control": self.forward is not None,
        }

    def trace_summaries(self) -> list[dict[str, Any]]:
        return sorted(
            (t.summary() for t in self.store.traces.values()),
            key=lambda s: s["last_timestamp_ms"] or 0,
            reverse=True,
        )

    async def control(self, trace_id: str, body: bytes) -> tuple[int, dict[str, Any]]:
        try:
            request = json.loads(body or b"{}")
        except json.JSONDecodeError:
            raise GatewayError(400, "The body isn't JSON") from None
        action = request.get("action") if isinstance(request, dict) else None
        params = request.get("params") if isinstance(request, dict) else None
        if action == "PAUSE":
            self.paused = True
            return 200, {"ok": True, "paused": True}
        if action == "RESUME":
            self.paused = False
            return 200, {"ok": True, "paused": False}
        if action == "TRIGGER_MOCK_RUN":
            self.mock_runs += 1
            speed = float((params or {}).get("speed", 1.0)) if isinstance(params, dict) else 1.0
            mock_id = trace_id if trace_id not in ("", "new", "mock") else f"trc_mock_{self.mock_runs:04d}"
            self._spawn(self._mock_run(mock_id, speed))
            return 200, {"ok": True, "trace_id": mock_id}
        if action in APP_ACTIONS:
            if self.forward is None:
                # V6: a gateway run on its own only watches; the agents run in processes it can't reach.
                return 409, {"error": f"{action} needs the gateway the app starts (Open Telemetry Studio)"}
            message = self.app_action(trace_id, action, params if isinstance(params, dict) else {})
            self.forward(message)
            return 202, {"ok": True, "forwarded": True}
        raise GatewayError(400, f"Unknown action: {action!r}")

    def app_action(self, trace_id: str, action: str, params: dict[str, Any]) -> dict[str, Any]:
        """The `control` message for the app, once `params` check out against the trace."""
        if trace_id not in self.store.traces:
            raise GatewayError(404, f"No trace {trace_id!r}")
        if action == "CANCEL":
            # Only a chat's trace names the job to stop: trc_mcp_<the chat's job id>_<random>.
            match = MCP_TRACE.fullmatch(trace_id)
            if match is None:
                raise GatewayError(409, "Only a chat's run can be cancelled from here")
            return {"action": action, "traceId": trace_id, "caller": match.group(1)}
        if action == "REVEAL_IN_FINDER":
            path = params.get("path")
            if not isinstance(path, str) or path not in self.media_paths(trace_id):
                raise GatewayError(400, "path must be a file this trace's agents used")
            return {"action": action, "traceId": trace_id, "path": path}
        host, timeline, seconds = params.get("host"), params.get("timeline"), params.get("seconds")
        if host not in ("premiere", "resolve"):
            raise GatewayError(400, "host must be premiere or resolve")
        if not isinstance(timeline, str) or not timeline:
            raise GatewayError(400, "timeline must name the editor's timeline")
        if isinstance(seconds, bool) or not isinstance(seconds, (int, float)) or not 0 <= seconds < 86_400:
            raise GatewayError(400, "seconds must be a time on the timeline")
        return {
            "action": action,
            "traceId": trace_id,
            "host": host,
            "timeline": timeline,
            "seconds": float(seconds),
        }

    def media_paths(self, trace_id: str) -> set[str]:
        """The files a trace's tool calls named, and the ones their artifacts did."""
        found: set[str] = set()
        for env in self.store.events(trace_id):
            payload = env["payload"]
            found.update(p for p in payload.get("media_paths") or [] if isinstance(p, str))
            for artifact in payload.get("artifacts") or []:
                if isinstance(artifact, dict) and isinstance(artifact.get("media_path"), str):
                    found.add(artifact["media_path"])
        return found

    async def _mock_run(self, trace_id: str, speed: float) -> None:
        from vibecut_agent.telemetry import mock_emitter

        await mock_emitter.play(self.bus, trace_id, speed)
        await asyncio.sleep(self.bus.flush_interval * 2)
        # The music bed's waveform for the OTIO dock (VCTB 0x01), addressed as a real one: the delta's
        # first MUTATION_EMITTED, and the duck's index among its ops.
        first = next((e for e in self.store.events(trace_id) if e["event_type"] == "MUTATION_EMITTED"), None)
        if first is not None:
            ops = first["payload"].get("operations") or []
            duck = next((i for i, op in enumerate(ops) if op.get("op_type") == "DUCK_REGION"), None)
            if duck is not None:
                self._add_peaks(
                    trace_id,
                    pack_binary_frame(
                        FRAME_AUDIO_PEAKS, duck, first["seq_id"], mock_emitter.waveform_peaks()
                    ),
                )

    async def _websocket(
        self, request: Request, reader: asyncio.StreamReader, writer: asyncio.StreamWriter
    ) -> None:
        if request.headers.get("upgrade", "").lower() != "websocket":
            raise GatewayError(426, "This endpoint is a WebSocket")
        key = request.headers.get("sec-websocket-key")
        if not key or request.headers.get("sec-websocket-version") != "13":
            raise GatewayError(400, "A WebSocket handshake needs Sec-WebSocket-Key and version 13")
        writer.write(
            (
                "HTTP/1.1 101 Switching Protocols\r\n"
                "Upgrade: websocket\r\n"
                "Connection: Upgrade\r\n"
                f"Sec-WebSocket-Accept: {accept_key(key)}\r\n\r\n"
            ).encode("latin-1")
        )
        await writer.drain()
        socket = WebSocket(reader, writer)
        client = Client("ws")
        self.clients.add(client)
        sender = self._spawn(self._pump_ws(client, socket))
        try:
            while True:
                message = await socket.receive()
                if message is None:
                    break
                opcode, data = message
                if opcode != OP_TEXT:
                    continue
                try:
                    payload = json.loads(data)
                except json.JSONDecodeError:
                    continue
                if isinstance(payload, dict) and not await self._on_message(client, socket, payload):
                    break
        finally:
            self.clients.discard(client)
            sender.cancel()
            await socket.close()

    async def _on_message(self, client: Client, socket: WebSocket, message: dict[str, Any]) -> bool:
        kind = message.get("type")
        if kind == "CLIENT_HELLO":
            if self.token is not None and not hmac.compare_digest(
                str(message.get("auth_token") or "").encode(), self.token.encode()
            ):
                await socket.send_text(
                    json.dumps({"type": "ERROR", "message": "A telemetry token is needed"})
                )
                await socket.close(4401, "unauthorized")
                return False
            wanted = message.get("subscribe_trace_id")
            client.trace_id = wanted if isinstance(wanted, str) and wanted else None
            last_seen = message.get("last_seen_seq_id")
            last_seen = last_seen if isinstance(last_seen, int) and last_seen >= 0 else 0
            trace_id = client.trace_id or self.store.active_trace_id()
            current = self.store.latest_seq(trace_id)
            needs_snapshot = current - last_seen > REPLAY_LIMIT or (last_seen == 0 and current > 0)
            await socket.send_text(
                json.dumps(
                    {
                        "type": "SERVER_WELCOME",
                        "protocol_version": PROTOCOL_VERSION,
                        "server_time_ms": time.time() * 1000.0,
                        "active_trace_id": trace_id,
                        "current_seq_id": current,
                        "requires_snapshot_fetch": needs_snapshot,
                        "heartbeat_interval_ms": HEARTBEAT_INTERVAL_MS,
                    }
                )
            )
            if trace_id and not needs_snapshot and last_seen < current:
                # Back after a short drop: what it missed, then live.
                missed = self.store.events(trace_id, last_seen + 1, current)
                for start in range(0, len(missed), 128):
                    await socket.send_text(
                        json.dumps(
                            {
                                "type": "TELEMETRY_BATCH",
                                "trace_id": trace_id,
                                "events": missed[start : start + 128],
                            },
                            ensure_ascii=False,
                        )
                    )
            for seq_id, strip_id in self.strips.get(trace_id or "", []):
                frame = self._strip_frame(seq_id, strip_id)
                if frame is not None:
                    await socket.send_bytes(frame)
            for frame in list(self.peaks.get(trace_id or "", [])):
                await socket.send_bytes(frame)
            client.ready = True
        elif kind == "SCRUB_REQUEST":
            if client.ready:
                client.scrub_next = message
                if client.scrub_worker is None or client.scrub_worker.done():
                    client.scrub_worker = self._spawn(self._answer_scrubs(client))
        elif kind == "PING":
            trace_id = client.trace_id or self.store.active_trace_id()
            await socket.send_text(
                json.dumps(
                    {
                        "type": "PONG",
                        "client_time_ms": message.get("client_time_ms", 0),
                        "server_time_ms": time.time() * 1000.0,
                        "latest_seq_id": self.store.latest_seq(trace_id),
                    }
                )
            )
        return True

    async def _pump_ws(self, client: Client, socket: WebSocket) -> None:
        with contextlib.suppress(ConnectionError, RuntimeError):
            while True:
                message = await client.queue.get()
                if message == b"":
                    await socket.close(1013, "too slow; reconnect")
                    return
                if isinstance(message, bytes):
                    await socket.send_bytes(message)
                else:
                    await socket.send_text(message)

    async def _sse(
        self, request: Request, reader: asyncio.StreamReader, writer: asyncio.StreamWriter
    ) -> None:
        headers = [
            "HTTP/1.1 200 OK",
            "Content-Type: text/event-stream; charset=utf-8",
            "Cache-Control: no-store",
            "Connection: keep-alive",
        ]
        origin = self._cors_origin(request)
        if origin is not None:
            headers += [f"Access-Control-Allow-Origin: {origin}", "Vary: Origin"]
        writer.write(("\r\n".join(headers) + "\r\n\r\n").encode("latin-1"))
        await writer.drain()
        client = Client("sse", trace_id=request.param("trace_id") or None, ready=True)
        self.clients.add(client)

        async def hang_up() -> None:
            # An SSE client never sends anything: end of input means it went away.
            with contextlib.suppress(ConnectionError, asyncio.IncompleteReadError):
                while await reader.read(1024):
                    pass
            self._offer(client, b"")

        watcher = self._spawn(hang_up())
        try:
            writer.write(b": vibecut telemetry\n\n")
            await writer.drain()
            while True:
                try:
                    message = await asyncio.wait_for(client.queue.get(), SSE_KEEPALIVE_SECONDS)
                except TimeoutError:
                    writer.write(b": keepalive\n\n")
                    await writer.drain()
                    continue
                if message == b"" or isinstance(message, bytes):
                    if message == b"":
                        return
                    continue
                writer.write(f"event: batch\ndata: {message}\n\n".encode())
                await writer.drain()
        finally:
            watcher.cancel()
            self.clients.discard(client)


# ------------------------------------------------------------------------------ the command


def options_from(request: dict[str, Any]) -> dict[str, Any]:
    from vibecut_agent.protocol import RequestError

    bind = request.get("bind") or os.environ.get(BIND_ENV, "").strip() or DEFAULT_BIND
    # 0 is a port too (any free one), so only a missing value falls through.
    port = request.get("port")
    if port is None:
        port = os.environ.get(PORT_ENV, "").strip() or DEFAULT_PORT
    try:
        port = int(port)
    except (TypeError, ValueError):
        raise RequestError("port must be a number") from None
    if not 0 <= port <= 65535:
        raise RequestError("port must be 0 to 65535")
    folder = request.get("telemetryDir")
    return {
        "bind": str(bind),
        "port": port,
        "token": os.environ.get(TOKEN_ENV, "").strip() or None,
        "folder": Path(folder) if isinstance(folder, str) and folder else telemetry_dir(),
    }


def read_optional_request(stdin: TextIO) -> dict[str, Any]:
    """The request, or `{}` when there is none (run from a terminal, or an empty stdin)."""
    from vibecut_agent.protocol import parse_request_object

    if stdin.isatty():
        return {}
    text = stdin.read()
    return parse_request_object(text) if text.strip() else {}


async def serve(gateway: Gateway, on_ready: Callable[[], None]) -> None:
    stop = asyncio.Event()
    loop = asyncio.get_running_loop()
    for sig in (signal.SIGTERM, signal.SIGINT):
        with contextlib.suppress(NotImplementedError, RuntimeError):
            loop.add_signal_handler(sig, stop.set)
    await gateway.start()
    on_ready()
    try:
        await stop.wait()
    finally:
        await gateway.stop()


def main(stdin: TextIO, emitter: Any) -> int:
    """`telemetry-gateway`: request `{bind?, port?, telemetryDir?, appControl?}` (or none); emits `ready
    {url, wsUrl, telemetryDir}` once listening, `control {action, traceId, ...}` for each app action asked
    for when `appControl` is true, and `done` after SIGTERM."""
    from vibecut_agent.protocol import RequestError

    request = read_optional_request(stdin)
    options = options_from(request)

    def forward(message: dict[str, Any]) -> None:
        emitter.emit("control", **message)

    try:
        gateway = Gateway(
            options["folder"],
            bind=options["bind"],
            port=options["port"],
            token=options["token"],
            forward=forward if request.get("appControl") is True else None,
        )
    except GatewayError as exc:
        raise RequestError(str(exc)) from None

    def ready() -> None:
        host = gateway.bind if ":" not in gateway.bind else f"[{gateway.bind}]"
        emitter.emit(
            "ready",
            url=f"http://{host}:{gateway.port}",
            wsUrl=f"ws://{host}:{gateway.port}/ws/v1/telemetry",
            telemetryDir=str(gateway.folder),
        )

    try:
        asyncio.run(serve(gateway, ready))
    except OSError as exc:
        raise RequestError(
            f"The telemetry gateway couldn't listen on {gateway.bind}:{gateway.port}: {exc}"
        ) from None
    emitter.emit("done")
    return 0
