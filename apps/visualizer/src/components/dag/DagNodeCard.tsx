/**
 * One DAG node (visualizer-spec.md §2.2): status halo, avatar, label and model, a latency pill (live while
 * it runs), tokens, GPU-lock and artifact badges, and progress. Compact (`labelPx` > 0, when the DAG is
 * zoomed out): the avatar, the label at that size (about 13 px on screen) and the status as the card's
 * colour; the rest is in the inspector and the tooltip.
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
  /** The compact card's label size in px (0: the full card). */
  labelPx?: number;
}

export const DagNodeCard = memo(function DagNodeCard({ node, selected, dimmed, highlighted, onSelect, labelPx = 0 }: DagNodeCardProps) {
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
        borderWidth: labelPx ? Math.max(1, Math.round(labelPx / 8)) : undefined,
        // Compact, the status shows as the card's colour.
        background: labelPx ? `${color}26` : undefined,
        boxShadow: `0 0 0 ${selected ? 2 : 1}px ${color}${running ? "" : "66"}${highlighted ? ", 0 0 12px #4a90d9" : ""}`,
        opacity: dimmed ? 0.35 : 1,
      }}
      aria-pressed={selected}
      aria-label={`${node.task_label}, ${node.subagent_type}, ${node.status.replaceAll("_", " ").toLowerCase()}`}
      title={labelPx ? `${node.task_label} · ${SUBAGENT_SHORT[node.subagent_type]} · ${node.status.replaceAll("_", " ").toLowerCase()} · ${formatMs(latency)}` : undefined}
      data-task-id={node.task_id}
      data-status={node.status}
      data-compact={labelPx ? "true" : undefined}
      onClick={(e) => {
        e.stopPropagation();
        onSelect(node.task_id);
      }}
    >
      {labelPx ? (
        <span className="flex h-full min-h-0 items-center gap-2">
          <AvatarBadge subagent={node.subagent_type} state={avatarForStatus(node.status)} size={Math.min(44, Math.round(labelPx * 1.25))} animate={running} />
          <span
            className="min-w-0 flex-1 overflow-hidden break-words font-semibold leading-tight text-[#e6edf3]"
            style={{
              fontSize: labelPx,
              display: "-webkit-box",
              // As many lines as the card's height holds at that size.
              WebkitLineClamp: Math.max(1, Math.floor((layout.height - 16) / (labelPx * 1.25))),
              WebkitBoxOrient: "vertical",
            }}
          >
            {node.task_label}
          </span>
        </span>
      ) : (
        <>
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
        </>
      )}
      {node.progress && node.status !== "COMPLETED" && (
        <span
          className="mt-auto block w-full shrink-0 overflow-hidden rounded bg-border"
          style={{ height: labelPx ? Math.max(4, Math.round(labelPx / 3)) : 4 }}
          aria-hidden="true"
        >
          <span className="block h-full bg-[#38bdf8]" style={{ width: `${Math.round(node.progress.fraction * 100)}%` }} />
        </span>
      )}
    </button>
  );
});
