/**
 * Asks Claude Code for the plan's usage (`/usage`, no model call; Phase 9b) when the window comes to the
 * front and the last report is older than REFRESH_AFTER_MS, and on the popover's Refresh. Chat turns on
 * the subscription keep it current in between, from their own reports.
 */
import { getClaudeCodeUsage } from "../ipc";
import { useSystemStore } from "../../store/useSystemStore";
import { useUsageStore } from "../../store/useUsageStore";
import { claudeCodeUsable } from "../../types/agent";
import { parsePlanUsage } from "./usage";

export const REFRESH_AFTER_MS = 15 * 60_000;

let running: Promise<string | null> | null = null;

/** Reads the plan's usage now. Resolves to why it couldn't, or null when it did. */
export function refreshPlan(): Promise<string | null> {
  running ??= getClaudeCodeUsage()
    .then((text) => {
      const limits = parsePlanUsage(text);
      if (!limits) return "Claude Code's usage report didn't list the plan's limits.";
      useUsageStore.getState().setPlan(limits);
      return null;
    })
    .catch((error: unknown) => (error instanceof Error ? error.message : String(error)))
    .finally(() => {
      running = null;
    });
  return running;
}

/** Whether a refresh is due: Claude Code is set up and the last report is old (or there's none). */
export function planRefreshDue(now = Date.now()): boolean {
  if (!claudeCodeUsable(useSystemStore.getState().claudeCode)) return false;
  const at = useUsageStore.getState().planAt;
  return at === null || now - at > REFRESH_AFTER_MS;
}

/** Refreshes on focus when due. Call once; returns the cleanup. */
export function startPlanRefresh(): () => void {
  const onFocus = () => {
    if (planRefreshDue()) void refreshPlan();
  };
  onFocus();
  // Claude Code's status arrives after launch; check again once it has.
  const unsubscribe = useSystemStore.subscribe((state, before) => {
    if (state.claudeCode !== before.claudeCode) onFocus();
  });
  window.addEventListener("focus", onFocus);
  return () => {
    unsubscribe();
    window.removeEventListener("focus", onFocus);
  };
}
