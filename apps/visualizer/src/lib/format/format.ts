/** Small formatters shared by the panes. */
import type { DagNodeStatus } from "../../types/dag";
import type { AvatarState } from "../../types/studio";

export const STATUS_COLOR: Readonly<Record<DagNodeStatus, string>> = {
  PENDING_SPAWN: "#72808a",
  SPAWNED: "#99928a",
  PLANNING: "#4a90d9",
  WAITING_UPSTREAM: "#ffb300",
  TOOL_EXECUTION: "#38bdf8",
  MUTATION_EMITTED: "#ffb300",
  COMPLETED: "#00c853",
  FAILED: "#ff5252",
};

/** The avatar a DAG node's status reads as (for its badge). */
export function avatarForStatus(status: DagNodeStatus): AvatarState {
  switch (status) {
    case "PLANNING":
    case "SPAWNED":
      return "PROCESSING_THINKING";
    case "WAITING_UPSTREAM":
      return "LISTENING";
    case "TOOL_EXECUTION":
      return "READING_ASSET";
    case "MUTATION_EMITTED":
      return "WRITING_OTIO";
    case "COMPLETED":
      return "SUCCESS_CELEBRATE";
    case "FAILED":
      return "BLOCKED_ERROR";
    default:
      return "IDLE";
  }
}

export function formatMs(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return "–";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 2 : 1)}s`;
  const m = Math.floor(ms / 60_000);
  return `${m}m${Math.round((ms % 60_000) / 1000)}s`;
}

export function formatCount(n: number): string {
  return n.toLocaleString("en-US");
}

/** A count in a few characters, for a badge: 980, 12.3k, 1.2M. */
export function formatShortCount(n: number): string {
  const abs = Math.abs(n);
  if (abs < 1000) return String(Math.round(n));
  if (abs < 1_000_000) return `${(n / 1000).toFixed(abs < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(abs < 10_000_000 ? 1 : 0)}M`;
}

export function formatClock(ms: number): string {
  const d = new Date(ms);
  const pad = (v: number, w = 2) => String(v).padStart(w, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
}

export function isRunning(status: DagNodeStatus): boolean {
  return status !== "COMPLETED" && status !== "FAILED" && status !== "PENDING_SPAWN";
}
