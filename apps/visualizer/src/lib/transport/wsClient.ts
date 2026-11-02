/**
 * The gateway client (visualizer-spec.md §5.2 B). It opens the socket, sends CLIENT_HELLO, and reads
 * SERVER_WELCOME. A new client, or one gone over 5 s, fetches the snapshot; one back from a shorter drop
 * is sent what it missed by the server. It then pings every 5 s, and reconnects with backoff (250 ms
 * doubling to 5 s, ±20% jitter).
 *
 * Text frames are checked against the Zod contracts: an envelope that doesn't fit is counted and dropped,
 * never applied. Binary frames are VCTB (binaryFrameParser.ts). The socket and fetch are injectable, for
 * the tests.
 */
import type { TelemetryEnvelope } from "@vibecut/contracts";
import {
  HEARTBEAT_INTERVAL_MS,
  PROTOCOL_VERSION,
  TelemetryEnvelopeSchema,
  WsServerMessageSchema,
} from "@vibecut/contracts";
import type { HostMode } from "../host/runtimeHostAdapter";
import { parseVctbFrame, type VctbFrame } from "./binaryFrameParser";

export const MIN_BACKOFF_MS = 250;
export const MAX_BACKOFF_MS = 5000;
/** Gone longer than this, the client rebuilds from the snapshot (§2.3 B). */
export const SNAPSHOT_AFTER_MS = 5000;

/** The parts of a browser WebSocket the client uses. */
export interface WebSocketLike {
  binaryType: string;
  readyState: number;
  onopen: ((ev: unknown) => void) | null;
  onclose: ((ev: unknown) => void) | null;
  onerror: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

export type ConnectionStatus = "idle" | "connecting" | "open" | "reconnecting" | "closed" | "error";

/** `GET /snapshot`'s answer (src-python/vibecut_agent/telemetry/snapshot.py). */
export interface TraceSnapshot {
  trace_id: string;
  snapshot_seq_id: number;
  replay_events: TelemetryEnvelope[];
}

export interface WsClientOptions {
  url: string;
  httpBase: string;
  hostMode: HostMode;
  traceId: string | null;
  authToken?: string | null;
  clientId?: string;
  /** The highest seq applied so far, for the hello. */
  lastSeenSeq: () => number;
  onEnvelopes: (envelopes: TelemetryEnvelope[]) => void;
  onSnapshot: (snapshot: TraceSnapshot) => void;
  onBinary?: (frame: VctbFrame) => void;
  onStatus?: (status: ConnectionStatus, detail?: string) => void;
  onWelcome?: (activeTraceId: string | null, currentSeq: number) => void;
  onLatency?: (rttMs: number) => void;
  createSocket?: (url: string) => WebSocketLike;
  fetchImpl?: typeof fetch;
  now?: () => number;
  random?: () => number;
  setTimer?: (callback: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

export class TelemetryWsClient {
  /** Envelopes that didn't fit the contract (dropped). */
  invalidEnvelopes = 0;
  private socket: WebSocketLike | null = null;
  private attempts = 0;
  private stopped = true;
  private pingTimer: unknown = null;
  private retryTimer: unknown = null;
  private disconnectedAt: number | null = null;
  private traceId: string | null;
  private readonly options: WsClientOptions;
  private readonly now: () => number;
  private readonly random: () => number;
  private readonly setTimer: (callback: () => void, ms: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;
  private readonly fetchImpl: typeof fetch;

  constructor(options: WsClientOptions) {
    this.options = options;
    this.traceId = options.traceId;
    this.now = options.now ?? Date.now;
    this.random = options.random ?? Math.random;
    this.setTimer = options.setTimer ?? ((cb, ms) => setTimeout(cb, ms));
    this.clearTimer = options.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
    this.fetchImpl = options.fetchImpl ?? ((...args) => fetch(...args));
  }

  get followedTrace(): string | null {
    return this.traceId;
  }

  connect(): void {
    this.stopped = false;
    this.open();
  }

  close(): void {
    this.stopped = true;
    this.clearTimers();
    const socket = this.socket;
    this.socket = null;
    if (socket) socket.close(1000, "closed by the viewer");
    this.options.onStatus?.("closed");
  }

  /** Follow another trace (null: the active one). */
  follow(traceId: string | null): void {
    this.traceId = traceId;
    if (!this.stopped) {
      this.socket?.close(1000, "following another trace");
    }
  }

  /** The delay before reconnect attempt `n` (0-based). */
  backoffMs(attempt: number): number {
    const base = Math.min(MAX_BACKOFF_MS, MIN_BACKOFF_MS * 2 ** attempt);
    const jitter = 1 + (this.random() * 0.4 - 0.2);
    return Math.round(Math.min(MAX_BACKOFF_MS, base * jitter));
  }

  private headers(): Record<string, string> {
    return this.options.authToken ? { Authorization: `Bearer ${this.options.authToken}` } : {};
  }

  /** Gap fill: `GET /events?from_seq&to_seq`, checked against the contract. */
  async fetchGap(traceId: string, fromSeq: number, toSeq: number): Promise<TelemetryEnvelope[]> {
    const url = `${this.options.httpBase}/api/v1/traces/${encodeURIComponent(traceId)}/events?from_seq=${fromSeq}&to_seq=${toSeq}`;
    const response = await this.fetchImpl(url, { headers: this.headers() });
    if (!response.ok) throw new Error(`Gap fill failed: HTTP ${response.status}`);
    return this.validEnvelopes(await response.json());
  }

  async fetchSnapshot(traceId: string): Promise<TraceSnapshot> {
    const url = `${this.options.httpBase}/api/v1/traces/${encodeURIComponent(traceId)}/snapshot`;
    const response = await this.fetchImpl(url, { headers: this.headers() });
    if (!response.ok) throw new Error(`Snapshot failed: HTTP ${response.status}`);
    const body = (await response.json()) as { trace_id?: unknown; snapshot_seq_id?: unknown; replay_events?: unknown };
    return {
      trace_id: String(body.trace_id ?? traceId),
      snapshot_seq_id: typeof body.snapshot_seq_id === "number" ? body.snapshot_seq_id : 0,
      replay_events: this.validEnvelopes(body.replay_events),
    };
  }

  private validEnvelopes(raw: unknown): TelemetryEnvelope[] {
    if (!Array.isArray(raw)) return [];
    const valid: TelemetryEnvelope[] = [];
    for (const item of raw) {
      const parsed = TelemetryEnvelopeSchema.safeParse(item);
      if (parsed.success) valid.push(parsed.data);
      else this.invalidEnvelopes += 1;
    }
    return valid;
  }

  private open(): void {
    if (this.stopped) return;
    this.options.onStatus?.(this.attempts === 0 ? "connecting" : "reconnecting");
    let socket: WebSocketLike;
    try {
      socket = this.options.createSocket
        ? this.options.createSocket(this.options.url)
        : (new WebSocket(this.options.url) as unknown as WebSocketLike);
    } catch (error) {
      this.options.onStatus?.("error", String(error));
      this.scheduleReconnect();
      return;
    }
    socket.binaryType = "arraybuffer";
    this.socket = socket;
    socket.onopen = () => {
      socket.send(
        JSON.stringify({
          type: "CLIENT_HELLO",
          protocol_version: PROTOCOL_VERSION,
          client_id: this.options.clientId ?? "visualizer",
          host_mode: this.options.hostMode,
          subscribe_trace_id: this.traceId,
          last_seen_seq_id: this.options.lastSeenSeq(),
          capabilities: { binary_previews: true },
          ...(this.options.authToken ? { auth_token: this.options.authToken } : {}),
        }),
      );
    };
    socket.onmessage = (event) => this.onMessage(event.data);
    socket.onerror = () => this.options.onStatus?.("error", "The gateway connection failed");
    socket.onclose = () => {
      if (this.socket !== socket) return;
      this.socket = null;
      this.clearTimers();
      if (this.disconnectedAt === null) this.disconnectedAt = this.now();
      if (!this.stopped) this.scheduleReconnect();
    };
  }

  private scheduleReconnect(): void {
    if (this.stopped) return;
    const delay = this.backoffMs(this.attempts);
    this.attempts += 1;
    this.options.onStatus?.("reconnecting", `Retrying in ${delay} ms`);
    this.retryTimer = this.setTimer(() => {
      this.retryTimer = null;
      this.open();
    }, delay);
  }

  private clearTimers(): void {
    if (this.pingTimer !== null) this.clearTimer(this.pingTimer);
    if (this.retryTimer !== null) this.clearTimer(this.retryTimer);
    this.pingTimer = null;
    this.retryTimer = null;
  }

  private schedulePing(): void {
    this.pingTimer = this.setTimer(() => {
      this.pingTimer = null;
      if (!this.socket) return;
      this.socket.send(
        JSON.stringify({ type: "PING", client_time_ms: this.now(), last_applied_seq_id: this.options.lastSeenSeq() }),
      );
      this.schedulePing();
    }, HEARTBEAT_INTERVAL_MS);
  }

  private onMessage(data: unknown): void {
    if (data instanceof ArrayBuffer || ArrayBuffer.isView(data)) {
      try {
        this.options.onBinary?.(parseVctbFrame(data as ArrayBuffer));
      } catch {
        // A frame that isn't VCTB is ignored.
      }
      return;
    }
    if (typeof data !== "string") return;
    let raw: unknown;
    try {
      raw = JSON.parse(data);
    } catch {
      return;
    }
    const kind = (raw as { type?: unknown })?.type;
    if (kind === "TELEMETRY_BATCH") {
      const events = this.validEnvelopes((raw as { events?: unknown }).events);
      if (events.length) this.options.onEnvelopes(events);
      return;
    }
    const parsed = WsServerMessageSchema.safeParse(raw);
    if (!parsed.success) return;
    const message = parsed.data;
    if (message.type === "SERVER_WELCOME") {
      const gone = this.disconnectedAt === null ? 0 : this.now() - this.disconnectedAt;
      const reconnect = this.attempts > 0;
      this.attempts = 0;
      this.disconnectedAt = null;
      this.options.onStatus?.("open");
      this.options.onWelcome?.(message.active_trace_id, message.current_seq_id);
      this.schedulePing();
      const traceId = message.active_trace_id;
      const stale = reconnect && gone > SNAPSHOT_AFTER_MS;
      if (traceId && (message.requires_snapshot_fetch || stale) && message.current_seq_id > 0) {
        this.fetchSnapshot(traceId)
          .then((snapshot) => this.options.onSnapshot(snapshot))
          .catch((error: unknown) => this.options.onStatus?.("error", String(error)));
      }
    } else if (message.type === "PONG") {
      this.options.onLatency?.(Math.max(0, this.now() - message.client_time_ms));
    } else if (message.type === "ERROR") {
      this.stopped = true;
      this.options.onStatus?.("error", message.message);
    }
  }
}
