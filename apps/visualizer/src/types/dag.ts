/** The execution DAG's nodes and edges (visualizer-spec.md §2.2, verbatim). */
import type {
  ArtifactRef,
  DeltaOpSummary,
  HardwareBackend,
  SubagentType,
} from "@vibecut/contracts";

export type DagNodeStatus =
  | "PENDING_SPAWN"
  | "SPAWNED"
  | "PLANNING"
  | "WAITING_UPSTREAM"
  | "TOOL_EXECUTION"
  | "MUTATION_EMITTED"
  | "COMPLETED"
  | "FAILED";

export interface DagNodeMetrics {
  spawned_at_ms: number;
  started_at_ms: number | null;
  completed_at_ms: number | null;
  /** Live elapsed or final duration in ms. */
  latency_ms: number;
  ttfb_ms: number | null;
  input_tokens: number;
  output_tokens: number;
  cached_tokens: number;
  token_rate_tps: number;
  cost_usd: number;
  rss_memory_mb: number;
  requires_gpu_lock: boolean;
  gpu_lock_held: boolean;
}

export interface DagNodeProgress {
  phase: string;
  completed_items: number;
  total_items: number;
  fraction: number;
  eta_seconds: number | null;
  throughput_items_per_sec: number;
  current_item_label: string | null;
}

export interface DagNode {
  task_id: string;
  trace_id: string;
  parent_task_id: string | null;
  agent_id: string;
  subagent_type: SubagentType;
  task_label: string;
  model_id: string;
  hardware_backend: HardwareBackend;
  status: DagNodeStatus;
  /** Monotonic watermark of the highest seq_id applied to this node's status. */
  last_status_seq_id: number;
  /** Upstream task IDs this node depends on. */
  dependencies: string[];
  /** Downstream task IDs waiting on this node. */
  dependents: string[];
  metrics: DagNodeMetrics;
  progress: DagNodeProgress | null;
  /** Streaming thought trace buffer (capped to 64 KB in UI memory). */
  thought_stream: string;
  /** Active or last executed tool call payload. */
  active_tool_call: {
    tool_call_id: string;
    tool_name: string;
    arguments: Record<string, unknown>;
  } | null;
  /** Intermediate artifacts produced by this node. */
  artifacts: ArtifactRef[];
  /** OTIO delta operations emitted by this node. */
  emitted_mutations: {
    delta_id: string;
    mutation_stage: "PROPOSED" | "VALIDATED" | "COMMITTED" | "ROLLED_BACK";
    validation_token: string | null;
    operations: DeltaOpSummary[];
  }[];
  /** Error state if status === "FAILED". */
  error: {
    error_code: string;
    error_message: string;
    recoverable: boolean;
    retry_attempt: number;
    remediation_hint: string | null;
  } | null;
  /** Memoized layout coordinates computed by Sugiyama layout engine. */
  layout: {
    rank: number;
    order: number;
    x: number;
    y: number;
    width: number;
    height: number;
  };
}

export interface DagEdge {
  edge_id: string;
  source_task_id: string;
  target_task_id: string;
  edge_kind: "SPAWN_PARENT" | "DATA_DEPENDENCY" | "CONTEXT_HANDOFF";
  packet_type: string | null;
  transfer_count: number;
  total_bytes: number;
  total_tokens: number;
  last_active_ms: number;
}
