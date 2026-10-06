import { X } from "lucide-react";
import { useNow } from "../../hooks/useNow";
import { cancelJob } from "../../lib/broll";
import { etaSeconds, formatDuration, isActive } from "../../store/useSidecarStore";
import type { SidecarJob } from "../../types/sidecar";

/** A job's progress: percentage, ETA, what it's on, and Cancel (AGENTS.md §8: deterministic progress). */
export function JobProgress({ job }: { job: SidecarJob }) {
  const active = isActive(job);
  const now = useNow(active);
  const eta = etaSeconds(job, now);
  const percent = job.fraction === null ? null : Math.round(job.fraction * 100);

  if (!active) {
    if (job.status === "failed") {
      return (
        <p role="alert" className="rounded-md border border-loss/50 bg-loss/10 px-2.5 py-1.5 text-xs text-white">
          {job.error}
        </p>
      );
    }
    if (job.status === "cancelled") return <p className="text-xs text-cool-grey">Cancelled.</p>;
    return null;
  }

  return (
    <div className="rounded-md border border-border bg-surface px-2.5 py-2">
      <div className="flex items-center justify-between gap-2 text-[11px]">
        <span className="truncate text-white">{job.label}</span>
        <button
          type="button"
          onClick={() => void cancelJob(job.id)}
          aria-label={`Cancel ${job.label}`}
          className="rounded p-0.5 text-cool-grey hover:text-loss"
        >
          <X size={13} aria-hidden="true" />
        </button>
      </div>
      <div
        role="progressbar"
        aria-label={job.label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent ?? undefined}
        className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-canvas"
      >
        <div
          className={`h-full rounded-full bg-athletic-blue-light transition-[width] duration-300 ${percent === null ? "w-1/3 animate-pulse" : ""}`}
          style={percent === null ? undefined : { width: `${percent}%` }}
        />
      </div>
      <div className="mt-1 flex justify-between gap-2 font-mono text-[11px] text-cool-grey">
        <span className="truncate">{job.detail ?? job.phase ?? "Starting…"}</span>
        <span className="shrink-0">
          {percent === null ? "" : `${percent}%`}
          {eta !== null ? ` · ${formatDuration(eta)} left` : ""}
        </span>
      </div>
    </div>
  );
}
