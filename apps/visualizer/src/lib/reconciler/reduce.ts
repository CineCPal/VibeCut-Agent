/**
 * The pure reducer: envelopes into the visualizer's state (visualizer-spec.md §2). It mutates the state it
 * is given, so the store runs it inside an Immer draft and the time-travel scrubber runs it on a plain
 * copy. The same envelopes in the same order always give the same state.
 *
 * The causal lattice guard (§2.3 A): PENDING_SPAWN (0) < SPAWNED (1) < {PLANNING, WAITING_UPSTREAM,
 * TOOL_EXECUTION} (2) < MUTATION_EMITTED (3) < {COMPLETED, FAILED} (4). A status applies only when its rank
 * is higher, or when both are rank 2 and its seq is newer. A late event can't undo a finished task. The
 * one way back is a retry: a SPAWN for a task that failed recoverably (PLAN.md, "Phase 22", V13).
 *
 * At 100,000 rows (PLAN.md, "The log at 100k rows"), two things are kept off Immer's per-write path:
 * - The log is appended once per call as a new frozen array, which Immer neither drafts nor walks. Pushing
 *   into a drafted 100k array made Immer copy and re-check it on every batch.
 * - Packet sprites are capped once per call, not with a splice per event, which went through the draft's
 *   proxy once per element.
 */
import type {
  ResourceHeartbeatPayload,
  SubagentType,
  TelemetryEnvelope,
} from "@vibecut/contracts";
import { SUBAGENT_TYPES } from "@vibecut/contracts";
import type { DagEdge, DagNode, DagNodeStatus } from "../../types/dag";
import type { DataPacketSprite, PacketType, StudioBayState } from "../../types/studio";
import type { MutationRecord } from "../../types/timeline";
import { avatarOnEvent, avatarOnInbound, idleBay } from "../studio/avatarFsm";
import { MAX_ACTIVE_PACKETS, makePacket } from "../studio/packets";

export const STATUS_RANK: Readonly<Record<DagNodeStatus, number>> = {
  PENDING_SPAWN: 0,
  SPAWNED: 1,
  PLANNING: 2,
  WAITING_UPSTREAM: 2,
  TOOL_EXECUTION: 2,
  MUTATION_EMITTED: 3,
  COMPLETED: 4,
  FAILED: 4,
};

/** The thought stream kept per node (64 KB of text). */
export const MAX_THOUGHT_CHARS = 64 * 1024;
export const MAX_LOGS = 100_000;

export interface TraceState {
  trace_id: string | null;
  nodes: Record<string, DagNode>;
  edges: Record<string, DagEdge>;
  studioBays: Record<SubagentType, StudioBayState>;
  activePackets: DataPacketSprite[];
  mutations: Record<string, MutationRecord>;
  logs: TelemetryEnvelope[];
  max_seq_id: number;
  event_count: number;
  heartbeat: ResourceHeartbeatPayload | null;
  /** Bumped whenever a node or edge is added: the DAG layout runs only then. */
  topology_version: number;
}

export interface ReduceOptions {
  /** Spawn packet sprites (live view); off for time-travel projections. */
  packets?: boolean;
  /** The wall clock for packets (Date.now()). */
  nowMs?: number;
  /** Keep each envelope in `logs` (the live view); off for projections, which read the live log. */
  keepLogs?: boolean;
  /** Inside an Immer draft: `logs` as it was, not drafted, so appending never walks a 100k-row proxy. */
  logsBefore?: readonly TelemetryEnvelope[];
}

export function createTraceState(traceId: string | null = null): TraceState {
  return {
    trace_id: traceId,
    nodes: {},
    edges: {},
    studioBays: Object.fromEntries(SUBAGENT_TYPES.map((s) => [s, idleBay(s)])) as Record<
      SubagentType,
      StudioBayState
    >,
    activePackets: [],
    mutations: {},
    logs: [],
    max_seq_id: 0,
    event_count: 0,
    heartbeat: null,
    topology_version: 0,
  };
}

function placeholder(state: TraceState, taskId: string, env: TelemetryEnvelope): DagNode {
  const existing = state.nodes[taskId];
  if (existing) return existing;
  const node: DagNode = {
    task_id: taskId,
    trace_id: env.trace_id,
    parent_task_id: null,
    agent_id: env.agent_id,
    subagent_type: env.subagent_type,
    task_label: taskId,
    model_id: "",
    hardware_backend: "CPU_NEON",
    status: "PENDING_SPAWN",
    last_status_seq_id: 0,
    dependencies: [],
    dependents: [],
    metrics: {
      spawned_at_ms: env.timestamp_ms,
      started_at_ms: null,
      completed_at_ms: null,
      latency_ms: 0,
      ttfb_ms: null,
      input_tokens: 0,
      output_tokens: 0,
      cached_tokens: 0,
      token_rate_tps: 0,
      cost_usd: 0,
      rss_memory_mb: 0,
      requires_gpu_lock: false,
      gpu_lock_held: false,
    },
    progress: null,
    thought_stream: "",
    active_tool_call: null,
    artifacts: [],
    emitted_mutations: [],
    error: null,
    layout: { rank: 0, order: 0, x: 0, y: 0, width: 0, height: 0 },
  };
  state.nodes[taskId] = node;
  state.topology_version += 1;
  return node;
}

/** The lattice guard: true when `status` was applied. */
export function advanceStatus(node: DagNode, status: DagNodeStatus, seqId: number, retry = false): boolean {
  const current = STATUS_RANK[node.status];
  const next = STATUS_RANK[status];
  if (retry || next > current || (next === 2 && current === 2 && seqId > node.last_status_seq_id)) {
    node.status = status;
    node.last_status_seq_id = seqId;
    return true;
  }
  return false;
}

function addEdge(
  state: TraceState,
  source: string,
  target: string,
  kind: DagEdge["edge_kind"],
  env: TelemetryEnvelope,
): DagEdge {
  const edgeId = `${kind}:${source}->${target}`;
  let edge = state.edges[edgeId];
  if (!edge) {
    edge = {
      edge_id: edgeId,
      source_task_id: source,
      target_task_id: target,
      edge_kind: kind,
      packet_type: null,
      transfer_count: 0,
      total_bytes: 0,
      total_tokens: 0,
      last_active_ms: env.timestamp_ms,
    };
    state.edges[edgeId] = edge;
    state.topology_version += 1;
    const from = placeholder(state, source, env);
    const to = placeholder(state, target, env);
    if (!from.dependents.includes(target)) from.dependents.push(target);
    if (!to.dependencies.includes(source)) to.dependencies.push(source);
  }
  return edge;
}

/** Capped to MAX_ACTIVE_PACKETS by `reduceEnvelopes`, once per batch. */
function pushPacket(state: TraceState, packet: DataPacketSprite): void {
  state.activePackets.push(packet);
}

/**
 * `logs` with `envs` appended, frozen, keeping the newest MAX_LOGS once it passes 1.1 × MAX_LOGS. Pass the
 * plain (not drafted) array: the store reads it from its current state.
 */
export function appendLogs(logs: readonly TelemetryEnvelope[], envs: readonly TelemetryEnvelope[]): TelemetryEnvelope[] {
  let next = logs.concat(envs);
  if (next.length > MAX_LOGS * 1.1) next = next.slice(next.length - MAX_LOGS);
  return Object.freeze(next) as TelemetryEnvelope[];
}

function markStarted(node: DagNode, env: TelemetryEnvelope): void {
  if (node.metrics.started_at_ms === null) node.metrics.started_at_ms = env.timestamp_ms;
}

function appendThought(node: DagNode, text: string): void {
  const joined = node.thought_stream + text;
  node.thought_stream = joined.length > MAX_THOUGHT_CHARS ? joined.slice(joined.length - MAX_THOUGHT_CHARS) : joined;
}

export function reduceEnvelope(state: TraceState, env: TelemetryEnvelope, options: ReduceOptions = {}): void {
  const p = env.payload;
  const packets = options.packets ?? false;
  const now = options.nowMs ?? env.timestamp_ms;
  if (state.trace_id === null) state.trace_id = env.trace_id;
  state.event_count += 1;
  state.max_seq_id = Math.max(state.max_seq_id, env.seq_id);

  const bay = state.studioBays[env.subagent_type];
  if (p.kind !== "CONTEXT_HANDOFF" && p.kind !== "RESOURCE_HEARTBEAT") avatarOnEvent(bay, env);

  switch (p.kind) {
    case "SPAWN": {
      const node = placeholder(state, p.task_id, env);
      const retry = node.status === "FAILED" && node.error?.recoverable === true;
      node.trace_id = env.trace_id;
      node.parent_task_id = env.parent_task_id;
      node.agent_id = env.agent_id;
      node.subagent_type = env.subagent_type;
      node.task_label = p.task_label;
      node.model_id = p.model_id;
      node.hardware_backend = p.hardware_backend;
      node.metrics.spawned_at_ms = env.timestamp_ms;
      if (retry) {
        node.error = null;
        node.metrics.completed_at_ms = null;
        node.metrics.started_at_ms = null;
      }
      advanceStatus(node, "SPAWNED", env.seq_id, retry);
      for (const upstream of p.upstream_task_ids) {
        addEdge(state, upstream, p.task_id, "DATA_DEPENDENCY", env);
      }
      if (env.parent_task_id && !p.upstream_task_ids.includes(env.parent_task_id)) {
        addEdge(state, env.parent_task_id, p.task_id, "SPAWN_PARENT", env);
      }
      break;
    }
    case "PLANNING": {
      const node = placeholder(state, p.task_id, env);
      markStarted(node, env);
      advanceStatus(node, "PLANNING", env.seq_id);
      appendThought(node, `${node.thought_stream ? "\n" : ""}▸ ${p.planning_phase}: ${p.thought_summary}\n`);
      break;
    }
    case "WAITING_UPSTREAM": {
      const node = placeholder(state, p.task_id, env);
      advanceStatus(node, "WAITING_UPSTREAM", env.seq_id);
      node.metrics.gpu_lock_held = false;
      break;
    }
    case "TOOL_INVOCATION": {
      const node = placeholder(state, p.task_id, env);
      markStarted(node, env);
      advanceStatus(node, "TOOL_EXECUTION", env.seq_id);
      node.active_tool_call = { tool_call_id: p.tool_call_id, tool_name: p.tool_name, arguments: p.arguments };
      node.metrics.requires_gpu_lock = p.requires_gpu_lock;
      node.metrics.gpu_lock_held = p.requires_gpu_lock;
      if (packets && env.subagent_type !== "MASTER_ORCHESTRATOR") {
        pushPacket(state, makePacket("MASTER_ORCHESTRATOR", env.subagent_type, "PROMPT_TOKENS", JSON.stringify(p.arguments).length, now, p.tool_name));
      }
      break;
    }
    case "MUTATION_EMITTED": {
      const node = placeholder(state, p.task_id, env);
      advanceStatus(node, "MUTATION_EMITTED", env.seq_id);
      const already = node.emitted_mutations.some(
        (m) => m.delta_id === p.delta_id && m.mutation_stage === p.mutation_stage,
      );
      if (!already) {
        node.emitted_mutations.push({
          delta_id: p.delta_id,
          mutation_stage: p.mutation_stage,
          validation_token: p.validation_token,
          operations: p.operations,
        });
      }
      const before = state.mutations[p.delta_id];
      state.mutations[p.delta_id] = {
        delta_id: p.delta_id,
        task_id: p.task_id,
        subagent: before?.subagent ?? env.subagent_type,
        mutation_stage: p.mutation_stage,
        validation_token: p.validation_token ?? before?.validation_token ?? null,
        target_host: p.target_host,
        target_timeline: p.target_timeline,
        timeline_fps: p.timeline_fps,
        narrative_rationale: p.narrative_rationale,
        operations: p.operations,
        seq_id: env.seq_id,
        first_seq_id: before?.first_seq_id ?? env.seq_id,
      };
      if (packets) {
        const to: SubagentType = p.mutation_stage === "COMMITTED" ? "COLOR_GRADER" : "MASTER_ORCHESTRATOR";
        const kind: PacketType = p.mutation_stage === "COMMITTED" ? "NLE_COMMIT_BATCH" : "OTIO_DELTA";
        if (to !== env.subagent_type) {
          pushPacket(state, makePacket(env.subagent_type, to, kind, JSON.stringify(p.operations).length, now, p.delta_id));
        }
      }
      break;
    }
    case "COMPLETED": {
      const node = placeholder(state, p.task_id, env);
      advanceStatus(node, "COMPLETED", env.seq_id);
      node.metrics.completed_at_ms = env.timestamp_ms;
      node.metrics.latency_ms = p.latency_ms;
      node.metrics.ttfb_ms = p.ttfb_ms;
      node.metrics.input_tokens = Math.max(node.metrics.input_tokens, p.input_tokens);
      node.metrics.output_tokens = Math.max(node.metrics.output_tokens, p.output_tokens);
      node.metrics.cached_tokens = p.cached_tokens;
      node.metrics.cost_usd = p.cost_usd;
      node.metrics.rss_memory_mb = p.peak_memory_mb;
      node.metrics.token_rate_tps = p.latency_ms > 0 ? (node.metrics.output_tokens * 1000) / p.latency_ms : 0;
      node.metrics.gpu_lock_held = false;
      node.artifacts = p.artifacts;
      node.progress = node.progress ? { ...node.progress, fraction: 1, eta_seconds: 0 } : null;
      break;
    }
    case "FAILED": {
      const node = placeholder(state, p.task_id, env);
      advanceStatus(node, "FAILED", env.seq_id);
      node.metrics.completed_at_ms = env.timestamp_ms;
      node.metrics.gpu_lock_held = false;
      node.error = {
        error_code: p.error_code,
        error_message: p.error_message,
        recoverable: p.recoverable,
        retry_attempt: p.retry_attempt,
        remediation_hint: p.remediation_hint ?? null,
      };
      break;
    }
    case "STREAM_CHUNK": {
      const node = placeholder(state, p.task_id, env);
      markStarted(node, env);
      if (p.stream_channel !== "TOOL_STDOUT") appendThought(node, p.delta_text);
      node.metrics.output_tokens = Math.max(node.metrics.output_tokens, p.accumulated_tokens);
      const elapsed = env.timestamp_ms - (node.metrics.started_at_ms ?? env.timestamp_ms);
      if (elapsed > 0) node.metrics.token_rate_tps = (p.accumulated_tokens * 1000) / elapsed;
      break;
    }
    case "BATCH_PROGRESS": {
      const node = placeholder(state, p.task_id, env);
      markStarted(node, env);
      node.progress = {
        phase: p.phase,
        completed_items: p.completed_items,
        total_items: p.total_items,
        fraction: p.fraction,
        eta_seconds: p.eta_seconds,
        throughput_items_per_sec: p.throughput_items_per_sec,
        current_item_label: p.current_item_label,
      };
      break;
    }
    case "CONTEXT_HANDOFF": {
      if (p.from_task_id !== p.to_task_id) {
        const edge = addEdge(state, p.from_task_id, p.to_task_id, "CONTEXT_HANDOFF", env);
        edge.packet_type = p.packet_type;
        edge.transfer_count += 1;
        edge.total_bytes += p.payload_bytes;
        edge.total_tokens += p.token_count;
        edge.last_active_ms = env.timestamp_ms;
      }
      avatarOnInbound(state.studioBays[p.to_subagent], env);
      if (packets && p.from_subagent !== p.to_subagent) {
        const label = p.clip_count > 0 ? `×${p.clip_count}` : null;
        pushPacket(state, makePacket(p.from_subagent, p.to_subagent, p.packet_type, p.payload_bytes, now, label));
      }
      break;
    }
    case "RESOURCE_HEARTBEAT":
      state.heartbeat = p;
      break;
  }
}

export function reduceEnvelopes(
  state: TraceState,
  envs: readonly TelemetryEnvelope[],
  options: ReduceOptions = {},
): void {
  for (const env of envs) reduceEnvelope(state, env, options);
  if (options.keepLogs ?? true) state.logs = appendLogs(options.logsBefore ?? state.logs, envs);
  if (options.packets && state.activePackets.length) {
    const now = options.nowMs ?? Date.now();
    const alive = state.activePackets.filter((pkt) => pkt.born_ms + pkt.duration_ms > now).slice(-MAX_ACTIVE_PACKETS);
    if (alive.length !== state.activePackets.length) state.activePackets = alive;
  }
}

/** Upstream and downstream task ids of a node (for highlighting a selection's edges). */
export function neighbourhood(state: Pick<TraceState, "edges">, taskId: string): Set<string> {
  const ids = new Set<string>([taskId]);
  for (const edge of Object.values(state.edges)) {
    if (edge.source_task_id === taskId) ids.add(edge.target_task_id);
    if (edge.target_task_id === taskId) ids.add(edge.source_task_id);
  }
  return ids;
}
