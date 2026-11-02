/** One log line for an envelope (the terminal dock). */
import type { TelemetryEnvelope } from "@vibecut/contracts";

export function summarize(env: TelemetryEnvelope): string {
  const p = env.payload;
  switch (p.kind) {
    case "SPAWN":
      return `SPAWN ${p.task_id} ${p.task_label} (${p.model_id || p.hardware_backend})`;
    case "PLANNING":
      return `PLANNING ${p.task_id} ${p.planning_phase}: ${p.thought_summary}`;
    case "TOOL_INVOCATION":
      return `TOOL ${p.task_id} ${p.tool_name}${p.requires_gpu_lock ? " [GPU]" : ""}`;
    case "WAITING_UPSTREAM":
      return `WAIT ${p.task_id} ${p.wait_reason}${p.blocking_task_ids.length ? ` on ${p.blocking_task_ids.join(", ")}` : ""}`;
    case "MUTATION_EMITTED":
      return `MUTATION_EMITTED ${p.delta_id} ${p.mutation_stage} (${p.operations.length} ops${p.validation_token ? `, ${p.validation_token.slice(0, 13)}…` : ""})`;
    case "COMPLETED":
      return `COMPLETED ${p.task_id} in ${Math.round(p.latency_ms)} ms: ${p.output_summary}`;
    case "FAILED":
      return `FAILED ${p.task_id} ${p.error_code}: ${p.error_message}`;
    case "STREAM_CHUNK":
      return `${p.stream_channel} ${p.task_id}: ${p.delta_text.replace(/\s+/g, " ").trim()}`;
    case "BATCH_PROGRESS":
      return `PROGRESS ${p.task_id} ${p.phase} ${p.completed_items}/${p.total_items} (${Math.round(p.fraction * 100)}%)${p.coalesced_event_count > 1 ? ` ×${p.coalesced_event_count}` : ""}`;
    case "CONTEXT_HANDOFF":
      return `HANDOFF ${p.from_task_id} → ${p.to_task_id} ${p.packet_type} (${p.payload_bytes} B): ${p.summary}`;
    case "RESOURCE_HEARTBEAT":
      return `HEARTBEAT cpu ${p.host_cpu_percent}% rss ${p.sidecar_rss_mb} MB gpu ${p.gpu_lock_holder ?? "free"}`;
  }
}

export function taskOf(env: TelemetryEnvelope): string | null {
  const p = env.payload;
  if ("task_id" in p) return p.task_id;
  if (p.kind === "CONTEXT_HANDOFF") return p.to_task_id;
  return null;
}
