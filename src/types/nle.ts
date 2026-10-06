export type NleHost = "premiere" | "resolve";

export const NLE_HOSTS: readonly NleHost[] = ["premiere", "resolve"];

export const NLE_LABELS: Record<NleHost, string> = {
  premiere: "Premiere Pro",
  resolve: "DaVinci Resolve",
};

/** Mirrors `NleStatus` in `src-tauri/src/nle.rs`. */
export type NleConnectionStatus = "connecting" | "connected" | "disconnected" | "error" | "unavailable";

/** Why a host's state last changed (`reason` in `vibecut_agent/nle/watch.py`). */
export type NleChangeReason =
  | "unavailable"
  | "connected"
  | "disconnected"
  | "reconnected"
  | "restarted"
  | "project_changed"
  | "timeline_changed"
  | "timelines_changed";

/** Mirrors `NleState` in `src-tauri/src/nle.rs`, pushed as `nle-state`. */
export interface NleState {
  host: NleHost;
  status: NleConnectionStatus;
  /** Why the editor isn't connected, or what went wrong. */
  message: string | null;
  product: string | null;
  version: string | null;
  project: string | null;
  /** The timeline open in the editor now. */
  timeline: string | null;
  timelines: string[];
  reason: NleChangeReason | null;
  /** Epoch seconds of the last change. */
  changedAt: number;
}

export type PreferredHost = "auto" | NleHost;

/** Mirrors `PremierePanelStatus` in `src-tauri/src/premiere_panel.rs`. */
export interface PremierePanelStatus {
  premiereInstalled: boolean;
  bundledVersion: string | null;
  installedVersion: string | null;
  installedPath: string;
  debugMode: boolean;
  running: boolean;
}
