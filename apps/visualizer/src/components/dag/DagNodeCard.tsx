/**
 * One DAG node (visualizer-spec.md §2.2): status halo, avatar, label and model, a latency pill (live while
 * it runs), tokens, GPU-lock and artifact badges, and progress.
 */
import { memo } from "react";
import { useNow } from "../../hooks/useTicker";
import { SUBAGENT_SHORT } from "../../lib/studio/bays";
import { avatarForStatus, formatCount, formatMs, isRunning, STATUS_COLOR } from "../../lib/format/format";
import type { DagNode } from "../../types/dag";
import { AvatarBadge } from "../studio/AvatarBadge";

export interface DagNodeCardProps {
  node: DagNode;
  selected: boolean;
  dimmed: boolean;
  highlighted: boolean;
  onSelect: (taskId: string) => void;
}

export const DagNodeCard = memo(function DagNodeCard({ node, selected, dimmed, highlighted, onSelect }: DagNodeCardProps) {
  const running = isRunning(node.status);
  const now = useNow(250, running);
  const color = STATUS_COLOR[node.status];
  const started = node.metrics.started_at_ms ?? node.metrics.spawned_at_ms;
  const latency = running ? Math.max(0, now - started) : node.metrics.latency_ms;
  const tokens = node.metrics.input_tokens + node.metrics.output_tokens;
  const { layout } = node;
  return (
    <button
      type="button"
      className="absolute flex flex-col gap-1 rounded-md border bg-surface p-2 text-left font-sans text-xs transition-opacity"
      style={{
        left: layout.x,
        top: layout.y,
        width: layout.width,
        height: layout.height,
        borderColor: selected ? "#e6edf3" : color,
        boxShadow: `0 0 0 ${selected ? 2 : 1}px ${color}${running ? "" : "66"}${highlighted ? ", 0 0 12px #4a90d9" : ""}`,
        opacity: dimmed ? 0.35 : 1,
      }}
      aria-pressed={selected}
      aria-label={`${node.task_label}, ${node.subagent_type}, ${node.status.replaceAll("_", " ").toLowerCase()}`}
      data-task-id={node.task_id}
      data-status={node.status}
      onClick={(e) => {
        e.stopPropagation();
        onSelect(node.task_id);
      }}
    >
      <span className="flex items-center gap-2">
        <AvatarBadge subagent={node.subagent_type} state={avatarForStatus(node.status)} size={24} animate={running} />
        <span className="min-w-0 flex-1">
          <span className="block truncate font-semibold text-[#e6edf3]">{node.task_label}</span>
          <span className="block truncate font-mono text-[10px] text-cool-grey">
            {SUBAGENT_SHORT[node.subagent_type]} · {node.model_id || node.agent_id}
          </span>
        </span>
      </span>
      <span className="flex flex-wrap items-center gap-1 font-mono text-[10px]">
        <span className="rounded px-1" style={{ color, border: `1px solid ${color}` }}>
          {node.status.replaceAll("_", " ")}
        </span>
        <span className="rounded border border-border px-1 text-warm-grey" title="Latency">
          {formatMs(latency)}
        </span>
        {tokens > 0 && (
          <span className="rounded border border-border px-1 text-warm-grey" title="Tokens in → out">
            {formatCount(node.metrics.input_tokens)}→{formatCount(node.metrics.output_tokens)}
          </span>
        )}
        {node.metrics.gpu_lock_held && (
          <span className="rounded border border-warning px-1 text-warning" title="Holding the GPU lock">
            GPU
          </span>
        )}
        {node.artifacts.length > 0 && (
          <span className="rounded border border-profit px-1 text-profit" title="Artifacts">
            ◆{node.artifacts.length}
          </span>
        )}
        {node.emitted_mutations.length > 0 && (
          <span className="rounded border border-warning px-1 text-warning" title="OTIO deltas">
            Δ{node.emitted_mutations.at(-1)?.operations.length ?? 0}
          </span>
        )}
      </span>
      {node.progress && node.status !== "COMPLETED" && (
        <span className="mt-auto block h-1 w-full overflow-hidden rounded bg-border" aria-hidden="true">
          <span className="block h-full bg-[#38bdf8]" style={{ width: `${Math.round(node.progress.fraction * 100)}%` }} />
        </span>
      )}
    </button>
  );
});
