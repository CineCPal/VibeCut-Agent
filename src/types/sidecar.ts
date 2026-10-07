/** Mirrors the serde shapes in `src-tauri/src/sidecar.rs`. */

/** Commands the frontend may start with `sidecar_start` (`session` and the editor watchers are started by Rust). */
export type SidecarCommand = "health" | "chat" | "broll-analyze" | "broll-match" | "broll-spyglass" | "transcribe" | "audio-peaks" | "assemble" | "chat-title";

/** One protocol event: a JSON object with a string `type` (see `vibecut_agent/protocol.py`). */
export interface SidecarEvent {
  type: string;
  [key: string]: unknown;
}

export interface SidecarEventPayload {
  jobId: string;
  command: string;
  event: SidecarEvent;
}

export interface SidecarExitPayload {
  jobId: string;
  code: number | null;
  cancelled: boolean;
  message: string | null;
}

export type SessionState = "starting" | "ready" | "stopped";

export interface SessionStatus {
  state: SessionState;
  version: string | null;
  python: string | null;
  message: string | null;
}

export interface SidecarInfo {
  uvPath: string;
  pythonRoot: string;
  installed: boolean;
  environment: string | null;
}

export type JobStatus = "starting" | "running" | "done" | "failed" | "cancelled";

export interface SidecarJob {
  id: string;
  command: SidecarCommand;
  label: string;
  status: JobStatus;
  startedAt: number;
  endedAt: number | null;
  /** 0..1, or null until the job reports progress. */
  fraction: number | null;
  phase: string | null;
  detail: string | null;
  error: string | null;
  result: Record<string, unknown> | null;
  log: string[];
}
