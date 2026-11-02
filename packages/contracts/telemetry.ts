/**
 * Canonical Telemetry & Event Bus Contracts (vibecut.telemetry.v1)
 * Shared across apps/visualizer, packages/agents, packages/core, and packages/timeline.
 *
 * Verbatim from docs/specs/visualizer-spec.md §1.1, plus the payload types §1.1 left unexported and the
 * tier constants at the end. The Python side is src-python/vibecut_agent/telemetry/bus.py (PLAN.md,
 * "Phase 22"); fixtures/mock_trace.jsonl, written by its mock emitter, is parsed against these schemas in
 * the visualizer's tests so the two can't drift.
 */
import { z } from "zod";

// ---------------------------------------------------------------------------
// 1. Fundamental OTIO Timecode Primitives (Mirrors vibecut.otio.delta.v1)
// ---------------------------------------------------------------------------

export const SupportedRateSchema = z.union([
  z.literal(23.976),
  z.literal(24),
  z.literal(25),
  z.literal(29.97),
  z.literal(30),
  z.literal(50),
  z.literal(59.94),
  z.literal(60),
]);
export type SupportedRate = z.infer<typeof SupportedRateSchema>;

export const RationalTimeSchema = z.object({
  OTIO_SCHEMA: z.literal("RationalTime.1"),
  value: z.number(),
  rate: SupportedRateSchema,
});
export type RationalTime = z.infer<typeof RationalTimeSchema>;

export const TimeRangeSchema = z.object({
  OTIO_SCHEMA: z.literal("TimeRange.1"),
  start_time: RationalTimeSchema,
  duration: RationalTimeSchema,
});
export type TimeRange = z.infer<typeof TimeRangeSchema>;

// ---------------------------------------------------------------------------
// 2. Agent & Event Enumerations
// ---------------------------------------------------------------------------

export const SubagentTypeSchema = z.enum([
  "MASTER_ORCHESTRATOR",
  "INGEST_TRANSCRIBE",
  "VISION_TAGGER",
  "BROLL_RETRIEVER",
  "PACING_CUTTER",
  "AUDIO_ENGINEER",
  "COLOR_GRADER",
]);
export type SubagentType = z.infer<typeof SubagentTypeSchema>;

export const TelemetryEventTypeSchema = z.enum([
  "SPAWN",
  "PLANNING",
  "TOOL_INVOCATION",
  "WAITING_UPSTREAM",
  "MUTATION_EMITTED",
  "COMPLETED",
  "FAILED",
  "STREAM_CHUNK",
  "BATCH_PROGRESS",
  "CONTEXT_HANDOFF",
  "RESOURCE_HEARTBEAT",
]);
export type TelemetryEventType = z.infer<typeof TelemetryEventTypeSchema>;

export const LogSeveritySchema = z.enum([
  "DEBUG",
  "INFO",
  "MUTATION",
  "WARN",
  "ERROR",
]);
export type LogSeverity = z.infer<typeof LogSeveritySchema>;

export const HardwareBackendSchema = z.enum([
  "METAL_MPS",
  "ANE_COREML",
  "VIDEOTOOLBOX",
  "CPU_NEON",
  "CLOUD_API",
  "NLE_IPC",
]);
export type HardwareBackend = z.infer<typeof HardwareBackendSchema>;

// ---------------------------------------------------------------------------
// 3. Lifecycle State Transition Payloads
// ---------------------------------------------------------------------------

/** 3.1 SPAWN: Emitted when the orchestrator or a sub-agent task node is instantiated. */
export const SpawnPayloadSchema = z.object({
  kind: z.literal("SPAWN"),
  task_id: z.string().min(4),
  task_label: z.string().min(1),
  model_id: z.string(),
  hardware_backend: HardwareBackendSchema,
  upstream_task_ids: z.array(z.string()),
  input_summary: z.string(),
  expected_timeout_ms: z.number().int().positive().default(60000),
});
export type SpawnPayload = z.infer<typeof SpawnPayloadSchema>;

/** 3.2 PLANNING: Emitted when an agent enters reasoning, story structuring, or prompt synthesis. */
export const PlanningPayloadSchema = z.object({
  kind: z.literal("PLANNING"),
  task_id: z.string(),
  planning_phase: z.enum([
    "INTENT_DECOMPOSITION",
    "ASSET_QUERY_FORMULATION",
    "ROUGH_CUT_STRUCTURING",
    "PACING_REFINEMENT",
    "PREFLIGHT_VERIFICATION",
  ]),
  thought_summary: z.string(),
  thinking_budget_tokens: z.number().int().nonnegative().optional(),
  active_timeline_name: z.string().nullable().optional(),
  active_timeline_fps: SupportedRateSchema.nullable().optional(),
});
export type PlanningPayload = z.infer<typeof PlanningPayloadSchema>;

/** 3.3 TOOL_INVOCATION: Emitted when an agent invokes a tool on the ToolBus or NLE Bridge. */
export const ToolInvocationPayloadSchema = z.object({
  kind: z.literal("TOOL_INVOCATION"),
  task_id: z.string(),
  tool_call_id: z.string(),
  tool_name: z.string(),
  target_subagent: SubagentTypeSchema.nullable(),
  arguments: z.record(z.string(), z.unknown()),
  requires_gpu_lock: z.boolean().default(false),
  media_paths: z.array(z.string()).default([]),
});
export type ToolInvocationPayload = z.infer<typeof ToolInvocationPayloadSchema>;

/** 3.4 WAITING_UPSTREAM: Emitted when a task blocks on upstream DAG nodes or the Metal GPU semaphore. */
export const WaitingUpstreamPayloadSchema = z.object({
  kind: z.literal("WAITING_UPSTREAM"),
  task_id: z.string(),
  wait_reason: z.enum([
    "DEPENDENCY_TASKS",
    "GPU_METAL_LOCK",
    "NLE_BRIDGE_LOCK",
    "RATE_LIMIT_BACKOFF",
    "USER_CONFIRMATION",
  ]),
  blocking_task_ids: z.array(z.string()),
  lock_holder_agent_id: z.string().nullable().optional(),
  queue_depth: z.number().int().nonnegative().default(0),
  estimated_wait_ms: z.number().nonnegative().nullable().optional(),
});
export type WaitingUpstreamPayload = z.infer<typeof WaitingUpstreamPayloadSchema>;

/** 3.5 MUTATION_EMITTED: Emitted when an OTIO delta is proposed, validated, or committed to the NLE. */
export const DeltaOpSummarySchema = z.object({
  op_id: z.string(),
  op_type: z.enum([
    "INSERT_CLIP",
    "OVERWRITE_CLIP",
    "TRIM_CLIP",
    "SPLIT_CLIP",
    "DELETE_CLIP",
    "MOVE_CLIP",
    "INSERT_GAP",
    "APPLY_TRANSITION",
    "SET_AUDIO_GAIN",
    "DUCK_REGION",
  ]),
  track_kind: z.enum(["Video", "Audio"]),
  track_index: z.number().int().min(1),
  clip_id: z.string().nullable(),
  source_name: z.string().nullable(),
  target_url: z.string().nullable(),
  source_range: TimeRangeSchema.nullable(),
  timeline_range: TimeRangeSchema,
  ripple: z.boolean().default(false),
  gain_db: z.number().nullable().optional(),
  transition_type: z.string().nullable().optional(),
});
export type DeltaOpSummary = z.infer<typeof DeltaOpSummarySchema>;

export const MutationEmittedPayloadSchema = z.object({
  kind: z.literal("MUTATION_EMITTED"),
  task_id: z.string(),
  delta_id: z.string(),
  mutation_stage: z.enum(["PROPOSED", "VALIDATED", "COMMITTED", "ROLLED_BACK"]),
  validation_token: z.string().nullable(),
  target_host: z.enum(["premiere", "resolve"]),
  target_timeline: z.string(),
  timeline_fps: SupportedRateSchema,
  narrative_rationale: z.string(),
  operations: z.array(DeltaOpSummarySchema),
  otio_snapshot_path: z.string().nullable().optional(),
});
export type MutationEmittedPayload = z.infer<typeof MutationEmittedPayloadSchema>;

/** 3.6 COMPLETED: Emitted when a task finishes execution and produces output artifacts/tokens. */
export const ArtifactRefSchema = z.discriminatedUnion("artifact_type", [
  z.object({
    artifact_type: z.literal("CLIP_RANGES"),
    count: z.number().int().nonnegative(),
    clips: z.array(
      z.object({
        hit_id: z.string(),
        filename: z.string(),
        media_path: z.string(),
        source_range: TimeRangeSchema,
        start_tc: z.string(),
        end_tc: z.string(),
        score: z.number(),
        modality: z.enum(["dialogue", "visual", "hybrid"]),
        thumbnail_frame_id: z.string().nullable().optional(),
      })
    ),
  }),
  z.object({
    artifact_type: z.literal("TRANSCRIPT_SUMMARY"),
    media_path: z.string(),
    segment_count: z.number().int().nonnegative(),
    word_count: z.number().int().nonnegative(),
    speakers: z.array(z.string()),
    cache_path: z.string(),
  }),
  z.object({
    artifact_type: z.literal("VLM_SHOT_TAGS"),
    media_path: z.string(),
    shot_count: z.number().int().nonnegative(),
    dominant_scales: z.array(z.string()),
    contact_strip_frame_ids: z.array(z.string()),
  }),
  z.object({
    artifact_type: z.literal("AUDIO_SYNC_MAP"),
    matched_pairs: z.number().int().nonnegative(),
    max_drift_ms: z.number(),
    loudness_lufs: z.number().nullable(),
  }),
  z.object({
    artifact_type: z.literal("VALIDATION_REPORT"),
    delta_id: z.string(),
    valid: z.boolean(),
    validation_token: z.string().nullable(),
    validator_mode: z.enum(["deterministic", "llm"]),
    diagnostic_count: z.number().int().nonnegative(),
  }),
]);
export type ArtifactRef = z.infer<typeof ArtifactRefSchema>;

export const CompletedPayloadSchema = z.object({
  kind: z.literal("COMPLETED"),
  task_id: z.string(),
  latency_ms: z.number().nonnegative(),
  ttfb_ms: z.number().nonnegative().nullable(),
  input_tokens: z.number().int().nonnegative().default(0),
  output_tokens: z.number().int().nonnegative().default(0),
  cached_tokens: z.number().int().nonnegative().default(0),
  cost_usd: z.number().nonnegative().default(0),
  peak_memory_mb: z.number().nonnegative().default(0),
  output_summary: z.string(),
  artifacts: z.array(ArtifactRefSchema).default([]),
});
export type CompletedPayload = z.infer<typeof CompletedPayloadSchema>;

/** 3.7 FAILED: Emitted when a task encounters a recoverable or terminal error. */
export const FailedPayloadSchema = z.object({
  kind: z.literal("FAILED"),
  task_id: z.string(),
  error_code: z.enum([
    "SCHEMA_VALIDATION_FAILED",
    "TIMELINE_OVERLAP_COLLISION",
    "STALE_TIMELINE_HASH",
    "MEDIA_OFFLINE",
    "NLE_BRIDGE_TIMEOUT",
    "NLE_ROLLBACK_EXECUTED",
    "LOCAL_MODEL_UNAVAILABLE",
    "GPU_OOM_CIRCUIT_BREAKER",
    "UPSTREAM_PROVIDER_ERROR",
    "TASK_CANCELLED",
  ]),
  error_message: z.string(),
  recoverable: z.boolean(),
  retry_attempt: z.number().int().nonnegative().default(0),
  max_retries: z.number().int().nonnegative().default(0),
  remediation_hint: z.string().nullable().optional(),
  stack_excerpt: z.string().nullable().optional(),
});
export type FailedPayload = z.infer<typeof FailedPayloadSchema>;

// ---------------------------------------------------------------------------
// 4. Streaming, Coalesced Batch, Routing & System Heartbeat Payloads
// ---------------------------------------------------------------------------

/** 4.1 STREAM_CHUNK: Coalesced thought trace or markdown output delta. */
export const StreamChunkPayloadSchema = z.object({
  kind: z.literal("STREAM_CHUNK"),
  task_id: z.string(),
  stream_channel: z.enum(["THOUGHT", "ASSISTANT_TEXT", "TOOL_STDOUT"]),
  delta_text: z.string(),
  accumulated_tokens: z.number().int().nonnegative(),
});
export type StreamChunkPayload = z.infer<typeof StreamChunkPayloadSchema>;

/** 4.2 BATCH_PROGRESS: Throttled (20 Hz max) high-frequency worker progress. */
export const BatchProgressPayloadSchema = z.object({
  kind: z.literal("BATCH_PROGRESS"),
  task_id: z.string(),
  phase: z.string(),
  completed_items: z.number().int().nonnegative(),
  total_items: z.number().int().positive(),
  fraction: z.number().min(0).max(1),
  eta_seconds: z.number().nonnegative().nullable(),
  throughput_items_per_sec: z.number().nonnegative(),
  current_item_label: z.string().nullable(),
  coalesced_event_count: z.number().int().min(1),
});
export type BatchProgressPayload = z.infer<typeof BatchProgressPayloadSchema>;

/** 4.3 CONTEXT_HANDOFF: Triggers spatial data-packet beam animation between studio bays. */
export const ContextHandoffPayloadSchema = z.object({
  kind: z.literal("CONTEXT_HANDOFF"),
  from_task_id: z.string(),
  to_task_id: z.string(),
  from_agent_id: z.string(),
  to_agent_id: z.string(),
  from_subagent: SubagentTypeSchema,
  to_subagent: SubagentTypeSchema,
  packet_type: z.enum([
    "PROMPT_TOKENS",
    "CLIP_MANIFEST",
    "TRANSCRIPT_SLICES",
    "VLM_TAGS",
    "OTIO_DELTA",
    "VALIDATION_TOKEN",
    "NLE_COMMIT_BATCH",
  ]),
  payload_bytes: z.number().int().nonnegative(),
  token_count: z.number().int().nonnegative().default(0),
  clip_count: z.number().int().nonnegative().default(0),
  summary: z.string(),
});
export type ContextHandoffPayload = z.infer<typeof ContextHandoffPayloadSchema>;

/** 4.4 RESOURCE_HEARTBEAT: Sampled at 1 Hz on the Mac Studio host. */
export const ResourceHeartbeatPayloadSchema = z.object({
  kind: z.literal("RESOURCE_HEARTBEAT"),
  host_cpu_percent: z.number().min(0).max(100),
  sidecar_rss_mb: z.number().nonnegative(),
  unified_memory_used_gb: z.number().nonnegative(),
  unified_memory_total_gb: z.number().positive(),
  gpu_lock_holder: z.string().nullable(),
  active_workers: z.number().int().nonnegative(),
  dropped_debug_events: z.number().int().nonnegative(),
  nle_connected: z.object({
    premiere: z.boolean(),
    resolve: z.boolean(),
  }),
});
export type ResourceHeartbeatPayload = z.infer<typeof ResourceHeartbeatPayloadSchema>;

export const TelemetryPayloadSchema = z.discriminatedUnion("kind", [
  SpawnPayloadSchema,
  PlanningPayloadSchema,
  ToolInvocationPayloadSchema,
  WaitingUpstreamPayloadSchema,
  MutationEmittedPayloadSchema,
  CompletedPayloadSchema,
  FailedPayloadSchema,
  StreamChunkPayloadSchema,
  BatchProgressPayloadSchema,
  ContextHandoffPayloadSchema,
  ResourceHeartbeatPayloadSchema,
]);
export type TelemetryPayload = z.infer<typeof TelemetryPayloadSchema>;

// ---------------------------------------------------------------------------
// 5. Canonical Telemetry Envelope
// ---------------------------------------------------------------------------

export const TelemetryEnvelopeSchema = z.object({
  schema_version: z.literal("vibecut.telemetry.v1"),
  /** Monotonically increasing 1-based sequence ID per trace_id. */
  seq_id: z.number().int().positive(),
  /** Time-ordered UUIDv7 identifier (e.g. "evt_0195f3a2..."). */
  event_id: z.string().min(8),
  /** Root conversation turn or batch ingest job trace ID. */
  trace_id: z.string().min(6),
  /** Unique identifier of the emitting agent instance (e.g. "worker.vlm.01"). */
  agent_id: z.string().min(2),
  /** Functional role category used for DAG node styling and Studio Bay placement. */
  subagent_type: SubagentTypeSchema,
  /** Parent task ID in the execution DAG (null for the root orchestrator task). */
  parent_task_id: z.string().nullable(),
  /** Wall-clock Unix epoch timestamp in milliseconds. */
  timestamp_ms: z.number().positive(),
  /** High-resolution monotonic clock in nanoseconds for exact duration math. */
  monotonic_ns: z.number().nonnegative(),
  /** Log severity tier for the Terminal / Replay Log pane. */
  severity: LogSeveritySchema,
  /** Discriminated event type matching payload.kind. */
  event_type: TelemetryEventTypeSchema,
  /** Strongly-typed event payload. */
  payload: TelemetryPayloadSchema,
});
export type TelemetryEnvelope = z.infer<typeof TelemetryEnvelopeSchema>;

// ---------------------------------------------------------------------------
// 6. Delivery tiers (visualizer-spec.md §1.2)
// ---------------------------------------------------------------------------

/** Tier 0: never dropped by the bus. The rest (Tier 1) may be coalesced or shed under load. */
export const CRITICAL_EVENT_TYPES: ReadonlySet<TelemetryEventType> = new Set<TelemetryEventType>([
  "SPAWN",
  "PLANNING",
  "TOOL_INVOCATION",
  "WAITING_UPSTREAM",
  "MUTATION_EMITTED",
  "COMPLETED",
  "FAILED",
  "CONTEXT_HANDOFF",
]);

export const SUBAGENT_TYPES = SubagentTypeSchema.options;
export const LOG_SEVERITIES = LogSeveritySchema.options;
