/** Envelope builders for the visualizer's tests. */
import type { SubagentType, TelemetryEnvelope, TelemetryPayload } from "@vibecut/contracts";

let next = 1;

export function env(
  seq: number,
  payload: TelemetryPayload,
  options: { trace?: string; subagent?: SubagentType; agent?: string; parent?: string | null; t?: number } = {},
): TelemetryEnvelope {
  return {
    schema_version: "vibecut.telemetry.v1",
    seq_id: seq,
    event_id: `evt_test_${next++}`,
    trace_id: options.trace ?? "trc_test",
    agent_id: options.agent ?? "worker.vlm.01",
    subagent_type: options.subagent ?? "VISION_TAGGER",
    parent_task_id: options.parent === undefined ? "task_root" : options.parent,
    timestamp_ms: options.t ?? 1_000_000 + seq * 10,
    monotonic_ns: seq * 1000,
    severity: payload.kind === "FAILED" ? "ERROR" : payload.kind === "MUTATION_EMITTED" ? "MUTATION" : "INFO",
    event_type: payload.kind,
    payload,
  };
}

export const spawn = (task: string, upstream: string[] = []): TelemetryPayload => ({
  kind: "SPAWN",
  task_id: task,
  task_label: `Task ${task}`,
  model_id: "qwen3-vl:8b-instruct",
  hardware_backend: "METAL_MPS",
  upstream_task_ids: upstream,
  input_summary: "a.mov",
  expected_timeout_ms: 60000,
});

export const planning = (task: string, thought = "Thinking"): TelemetryPayload => ({
  kind: "PLANNING",
  task_id: task,
  planning_phase: "INTENT_DECOMPOSITION",
  thought_summary: thought,
});

export const tool = (task: string, name = "analyze_shot_visuals"): TelemetryPayload => ({
  kind: "TOOL_INVOCATION",
  task_id: task,
  tool_call_id: `call_${task}`,
  tool_name: name,
  target_subagent: "VISION_TAGGER",
  arguments: { media_path: "/a.mov" },
  requires_gpu_lock: true,
  media_paths: ["/a.mov"],
});

export const completed = (task: string, latency = 120): TelemetryPayload => ({
  kind: "COMPLETED",
  task_id: task,
  latency_ms: latency,
  ttfb_ms: 10,
  input_tokens: 100,
  output_tokens: 40,
  cached_tokens: 0,
  cost_usd: 0,
  peak_memory_mb: 512,
  output_summary: "done",
  artifacts: [],
});

export const failed = (task: string, recoverable = true): TelemetryPayload => ({
  kind: "FAILED",
  task_id: task,
  error_code: "LOCAL_MODEL_UNAVAILABLE",
  error_message: "busy",
  recoverable,
  retry_attempt: 0,
  max_retries: 2,
});

export const waiting = (task: string): TelemetryPayload => ({
  kind: "WAITING_UPSTREAM",
  task_id: task,
  wait_reason: "GPU_METAL_LOCK",
  blocking_task_ids: ["task_other"],
  queue_depth: 1,
});

export const handoff = (from: string, to: string, fromSub: SubagentType, toSub: SubagentType): TelemetryPayload => ({
  kind: "CONTEXT_HANDOFF",
  from_task_id: from,
  to_task_id: to,
  from_agent_id: "a",
  to_agent_id: "b",
  from_subagent: fromSub,
  to_subagent: toSub,
  packet_type: "CLIP_MANIFEST",
  payload_bytes: 4096,
  token_count: 0,
  clip_count: 8,
  summary: "8 clips",
});
