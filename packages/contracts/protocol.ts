/**
 * WebSocket / SSE / HTTP wire contracts (vibecut.ws.v1), from docs/specs/visualizer-spec.md §5.2.
 * The server side is src-python/vibecut_agent/telemetry/gateway.py.
 */
import { z } from "zod";
import { TelemetryEnvelopeSchema } from "./telemetry";

export const PROTOCOL_VERSION = "vibecut.ws.v1";
export const DEFAULT_GATEWAY_PORT = 18765;
export const WS_PATH = "/ws/v1/telemetry";
export const SSE_PATH = "/sse/v1/telemetry";
export const HEARTBEAT_INTERVAL_MS = 5000;

/** 1. Client -> Server Handshake sent immediately on ws.onopen */
export const WsClientHelloSchema = z.object({
  type: z.literal("CLIENT_HELLO"),
  protocol_version: z.literal("vibecut.ws.v1"),
  client_id: z.string(),
  host_mode: z.enum(["standalone", "embedded_tauri", "embedded_cep"]),
  subscribe_trace_id: z.string().nullable(), // null = subscribe to active + future traces
  last_seen_seq_id: z.number().int().nonnegative().default(0),
  capabilities: z.object({
    binary_previews: z.boolean().default(true),
  }),
  auth_token: z.string().optional(),
});
export type WsClientHello = z.infer<typeof WsClientHelloSchema>;

/** 2. Server -> Client Welcome sent in response to CLIENT_HELLO */
export const WsServerWelcomeSchema = z.object({
  type: z.literal("SERVER_WELCOME"),
  protocol_version: z.literal("vibecut.ws.v1"),
  server_time_ms: z.number(),
  active_trace_id: z.string().nullable(),
  current_seq_id: z.number().int().nonnegative(),
  requires_snapshot_fetch: z.boolean(),
  heartbeat_interval_ms: z.literal(5000),
});
export type WsServerWelcome = z.infer<typeof WsServerWelcomeSchema>;

/** 3. Bidirectional Heartbeat (every 5000ms) for clock skew & dead-peer detection */
export const WsPingSchema = z.object({
  type: z.literal("PING"),
  client_time_ms: z.number(),
  last_applied_seq_id: z.number().int().nonnegative(),
});
export type WsPing = z.infer<typeof WsPingSchema>;

export const WsPongSchema = z.object({
  type: z.literal("PONG"),
  client_time_ms: z.number(),
  server_time_ms: z.number(),
  latest_seq_id: z.number().int().nonnegative(),
});
export type WsPong = z.infer<typeof WsPongSchema>;

/** 4. Server -> Client Coalesced Telemetry Batch (20 Hz max) */
export const WsTelemetryBatchSchema = z.object({
  type: z.literal("TELEMETRY_BATCH"),
  trace_id: z.string(),
  events: z.array(TelemetryEnvelopeSchema),
});
export type WsTelemetryBatch = z.infer<typeof WsTelemetryBatchSchema>;

/** 5. Server -> Client error (a refused hello, a bad token). */
export const WsServerErrorSchema = z.object({
  type: z.literal("ERROR"),
  message: z.string(),
});
export type WsServerError = z.infer<typeof WsServerErrorSchema>;

/**
 * 6. Client -> Server: the sound under the OTIO dock's playhead (PLAN.md, "Real audio in the OTIO dock",
 * V18). The gateway answers this client alone with a 0x03 frame (seq = the delta's first MUTATION_EMITTED,
 * channel = the op's index), or SCRUB_UNAVAILABLE. A newer request replaces one not yet answered.
 */
export const WsScrubRequestSchema = z.object({
  type: z.literal("SCRUB_REQUEST"),
  request_id: z.number().int().nonnegative(),
  trace_id: z.string(),
  delta_id: z.string(),
  op_id: z.string(),
  timeline_seconds: z.number().nonnegative(),
});
export type WsScrubRequest = z.infer<typeof WsScrubRequestSchema>;

/** 7. Server -> Client: why a scrub request has nothing to play. */
export const WsScrubUnavailableSchema = z.object({
  type: z.literal("SCRUB_UNAVAILABLE"),
  request_id: z.union([z.number(), z.string()]).nullable(),
  reason: z.string(),
});
export type WsScrubUnavailable = z.infer<typeof WsScrubUnavailableSchema>;

/** Any text frame the server sends. */
export const WsServerMessageSchema = z.discriminatedUnion("type", [
  WsServerWelcomeSchema,
  WsPongSchema,
  WsTelemetryBatchSchema,
  WsServerErrorSchema,
  WsScrubUnavailableSchema,
]);
export type WsServerMessage = z.infer<typeof WsServerMessageSchema>;

/** `POST /api/v1/control/{trace_id}` */
export const ControlRequestSchema = z.object({
  action: z.enum([
    "PAUSE",
    "RESUME",
    "CANCEL",
    "TRIGGER_MOCK_RUN",
    "REVEAL_IN_FINDER",
    "SET_NLE_PLAYHEAD",
  ]),
  params: z.record(z.string(), z.unknown()).optional(),
});
export type ControlRequest = z.infer<typeof ControlRequestSchema>;

/** `GET /api/v1/health` */
export const GatewayHealthSchema = z.object({
  status: z.literal("ok"),
  version: z.string(),
  active_trace_id: z.string().nullable(),
  connected_clients: z.number().int().nonnegative(),
  host_metrics: z.record(z.string(), z.unknown()),
  workers: z.record(z.string(), z.unknown()),
  telemetry_dir: z.string().nullable().optional(),
  paused: z.boolean().optional(),
  /** The app started this gateway: CANCEL, REVEAL_IN_FINDER and SET_NLE_PLAYHEAD reach the app. */
  app_control: z.boolean().optional(),
});
export type GatewayHealth = z.infer<typeof GatewayHealthSchema>;

/** `GET /api/v1/traces` */
export const TraceSummarySchema = z.object({
  trace_id: z.string(),
  latest_seq_id: z.number().int().nonnegative(),
  event_count: z.number().int().nonnegative(),
  first_timestamp_ms: z.number().nullable(),
  last_timestamp_ms: z.number().nullable(),
  live: z.boolean(),
  source: z.enum(["live", "journal"]),
});
export type TraceSummary = z.infer<typeof TraceSummarySchema>;

// ---------------------------------------------------------------------------
// VCTB binary frames (§5.2 C): a 16-byte big-endian header, then the payload.
// ---------------------------------------------------------------------------

export const VCTB_MAGIC = 0x56435442; // "VCTB"
export const VCTB_HEADER_BYTES = 16;

export const VctbFrameType = {
  /**
   * Int16 min/max peak pairs (little-endian, V14), 256 buckets per clip. seq = the delta's first
   * MUTATION_EMITTED, channel = the op's index in its operations (V17).
   */
  AUDIO_WAVEFORM_PEAKS: 0x01,
  /** JPEG, 720x135, [START | MID | END]. */
  VLM_CONTACT_STRIP_JPEG: 0x02,
  /** 48 kHz mono PCM (s16le), 0.25 s under the playhead; addressed as the waveform (V18). */
  TIMELINE_SCRUB_AUDIO: 0x03,
} as const;
export type VctbFrameType = (typeof VctbFrameType)[keyof typeof VctbFrameType];
