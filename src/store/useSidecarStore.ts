import { create } from "zustand";
import type {
  JobStatus,
  SessionStatus,
  SidecarCommand,
  SidecarEvent,
  SidecarExitPayload,
  SidecarJob,
} from "../types/sidecar";

const MAX_LOG_LINES = 50;
const MAX_JOBS = 20;

export const INITIAL_SESSION: SessionStatus = { state: "starting", version: null, python: null, message: null };

export interface SidecarState {
  session: SessionStatus;
  /** One-shot jobs, newest first. Progress reduction is ported from VibeCut's `useSidecarStore`. */
  jobs: SidecarJob[];
  setSession: (session: SessionStatus) => void;
  addJob: (job: { id: string; command: SidecarCommand; label: string }, now?: number) => void;
  /** Applies one protocol event; events for unknown or finished jobs are ignored. */
  applyEvent: (jobId: string, event: SidecarEvent) => void;
  applyExit: (exit: SidecarExitPayload, now?: number) => void;
  /** Marks a job that could not be started. */
  fail: (jobId: string, message: string, now?: number) => void;
  markCancelling: (jobId: string) => void;
  clearFinished: () => void;
}

const ACTIVE: JobStatus[] = ["starting", "running"];
export const isActive = (job: SidecarJob): boolean => ACTIVE.includes(job.status);

const text = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);
const number = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

export function reduceEvent(job: SidecarJob, event: SidecarEvent): SidecarJob {
  switch (event.type) {
    case "starting":
      return { ...job, status: "running" };
    case "status":
      return { ...job, status: "running", phase: text(event.phase) ?? job.phase, detail: text(event.detail) ?? null };
    case "progress": {
      const fraction = number(event.fraction);
      return {
        ...job,
        status: "running",
        fraction: fraction === undefined ? job.fraction : Math.min(1, Math.max(0, fraction)),
        phase: text(event.phase) ?? job.phase,
        detail: text(event.detail) ?? job.detail,
      };
    }
    case "log": {
      const line = text(event.line);
      return line ? { ...job, log: [...job.log, line].slice(-MAX_LOG_LINES) } : job;
    }
    case "error":
      return { ...job, error: text(event.message) ?? "The sidecar reported an error" };
    case "result": {
      const { type, ...result } = event;
      return { ...job, status: "running", result };
    }
    default:
      return job;
  }
}

const update = (jobs: SidecarJob[], id: string, change: (job: SidecarJob) => SidecarJob): SidecarJob[] => {
  const index = jobs.findIndex((j) => j.id === id);
  if (index < 0) return jobs;
  const next = [...jobs];
  next[index] = change(jobs[index]);
  return next;
};

export const useSidecarStore = create<SidecarState>()((set) => ({
  session: INITIAL_SESSION,
  jobs: [],

  setSession: (session) => set({ session }),

  addJob: ({ id, command, label }, now = Date.now()) =>
    set((s) => ({
      jobs: [
        {
          id,
          command,
          label,
          status: "starting" as const,
          startedAt: now,
          endedAt: null,
          fraction: null,
          phase: null,
          detail: null,
          error: null,
          result: null,
          log: [],
        },
        ...s.jobs,
      ].slice(0, MAX_JOBS),
    })),

  applyEvent: (jobId, event) =>
    set((s) => ({ jobs: update(s.jobs, jobId, (job) => (isActive(job) ? reduceEvent(job, event) : job)) })),

  applyExit: (exit, now = Date.now()) =>
    set((s) => ({
      jobs: update(s.jobs, exit.jobId, (job) => {
        if (!isActive(job)) return job;
        const base = { ...job, endedAt: now, detail: null };
        if (exit.cancelled) return { ...base, status: "cancelled" };
        const failed = Boolean(job.error) || Boolean(exit.message) || (exit.code !== null && exit.code !== 0);
        if (failed) {
          const error = job.error ?? exit.message ?? `The sidecar stopped (exit code ${exit.code ?? "unknown"})`;
          return { ...base, status: "failed", error };
        }
        return { ...base, status: "done", fraction: 1 };
      }),
    })),

  fail: (jobId, message, now = Date.now()) =>
    set((s) => ({
      jobs: update(s.jobs, jobId, (job) => ({ ...job, status: "failed", error: message, endedAt: now, detail: null })),
    })),

  markCancelling: (jobId) =>
    set((s) => ({ jobs: update(s.jobs, jobId, (job) => (isActive(job) ? { ...job, detail: "Stopping…" } : job)) })),

  clearFinished: () => set((s) => ({ jobs: s.jobs.filter(isActive) })),
}));

/** Seconds left, estimated from progress so far; null until there is enough to go on. */
export function etaSeconds(job: SidecarJob, now: number): number | null {
  if (!isActive(job) || job.fraction === null || job.fraction < 0.03 || job.fraction >= 1) return null;
  const elapsed = (now - job.startedAt) / 1000;
  return elapsed > 1 ? (elapsed * (1 - job.fraction)) / job.fraction : null;
}

/** "42 s", "3 min 05 s", "1 h 02 min". */
export function formatDuration(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  if (total < 60) return `${total} s`;
  const minutes = Math.floor(total / 60);
  if (minutes < 60) return `${minutes} min ${String(total % 60).padStart(2, "0")} s`;
  return `${Math.floor(minutes / 60)} h ${String(minutes % 60).padStart(2, "0")} min`;
}
