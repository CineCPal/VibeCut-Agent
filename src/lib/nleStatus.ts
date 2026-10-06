import type { Tone } from "../components/common/StatusDot";
import type { NleChangeReason, NleConnectionStatus, NleState, PremierePanelStatus } from "../types/nle";

export const CONNECTION_TONE: Record<NleConnectionStatus, Tone> = {
  connected: "ok",
  connecting: "warn",
  disconnected: "off",
  error: "bad",
  unavailable: "off",
};

export const CONNECTION_TEXT: Record<NleConnectionStatus, string> = {
  connected: "Connected",
  connecting: "Connecting…",
  disconnected: "Not connected",
  error: "Error",
  unavailable: "Not installed",
};

/**
 * Changes after which anything read from the editor before is stale: a new connection, a restart, or
 * another project. The agent re-reads its timeline after these (PLAN.md, Phase 3).
 */
export const RESYNC_REASONS: readonly NleChangeReason[] = ["connected", "reconnected", "restarted", "project_changed"];

export function needsResync(state: Pick<NleState, "status" | "reason">): boolean {
  return state.status === "connected" && state.reason !== null && RESYNC_REASONS.includes(state.reason);
}

/** "Doc · Main", or what the connection lacks. */
export function connectionDetail(state: NleState): string | null {
  if (state.status !== "connected") return state.message;
  if (!state.project) return "No project open";
  return state.timeline ? `${state.project} · ${state.timeline}` : state.project;
}

/** What the user should do next for the Premiere panel, or null when it's running and current. */
export function panelAdvice(panel: PremierePanelStatus): string | null {
  if (!panel.premiereInstalled) return "Premiere Pro isn't installed.";
  if (!panel.installedVersion) return "Install the panel, then start or restart Premiere Pro.";
  if (panel.bundledVersion && panel.installedVersion !== panel.bundledVersion) {
    return `Update the panel (installed ${panel.installedVersion}, this app has ${panel.bundledVersion}), then restart Premiere Pro.`;
  }
  if (!panel.debugMode) {
    return "Premiere only loads unsigned panels with CEP's PlayerDebugMode on: run `defaults write com.adobe.CSXS.12 PlayerDebugMode 1` in Terminal, then restart Premiere Pro.";
  }
  if (!panel.running) return "Installed. Start or restart Premiere Pro to load it.";
  return null;
}
