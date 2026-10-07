/**
 * The usage tracker's arithmetic (Phase 9b): what a turn cost, how totals add up, and how the plan's
 * windows read. Pure functions; the store is src/store/useUsageStore.ts.
 */
import { AI_CHOICES, type AiChoiceId, type ChatUsage } from "../../types/agent";
import type { PlanLimits, PlanWindow, UsageTotals } from "../../types/usage";

/** Claude API prices per million tokens (input, output, cache read), as of 2026-10. */
export const PRICES: Record<string, { input: number; output: number; cacheRead: number }> = {
  "claude-opus-5-5": { input: 4, output: 20, cacheRead: 0.2 },
  "claude-sonnet-5-5": { input: 2, output: 10, cacheRead: 0.2 },
};

/** A turn's estimated cost in dollars, or null when it isn't known. API-key Claude turns are priced
 * from their tokens (cache writes at the input rate, so a little under); subscription turns carry
 * Claude Code's own figure; Gemini's model is an alias whose price moves, so it isn't guessed. */
export function turnCost(choiceId: AiChoiceId, usage: ChatUsage): number | null {
  const choice = AI_CHOICES.find((c) => c.id === choiceId);
  if (!choice) return null;
  if (choice.chatProvider === "claude-code") return typeof usage.costUsd === "number" ? usage.costUsd : null;
  const price = choice.model ? PRICES[choice.model] : undefined;
  if (choice.chatProvider !== "claude" || !price) return null;
  const fresh = Math.max(0, usage.promptTokens - usage.cachedTokens);
  return (fresh * price.input + usage.cachedTokens * price.cacheRead + usage.outputTokens * price.output) / 1_000_000;
}

export const EMPTY_TOTALS: UsageTotals = { turns: 0, promptTokens: 0, cachedTokens: 0, outputTokens: 0, costUsd: null };

export function addTotals(a: UsageTotals | undefined, b: UsageTotals): UsageTotals {
  const base = a ?? EMPTY_TOTALS;
  return {
    turns: base.turns + b.turns,
    promptTokens: base.promptTokens + b.promptTokens,
    cachedTokens: base.cachedTokens + b.cachedTokens,
    outputTokens: base.outputTokens + b.outputTokens,
    costUsd: base.costUsd === null && b.costUsd === null ? null : (base.costUsd ?? 0) + (b.costUsd ?? 0),
  };
}

export function totalsOf(choiceId: AiChoiceId, usage: ChatUsage): UsageTotals {
  return { turns: 1, promptTokens: usage.promptTokens, cachedTokens: usage.cachedTokens, outputTokens: usage.outputTokens, costUsd: turnCost(choiceId, usage) };
}

/** "2026-10-07" for a time, in local time. */
export function dayKey(time: number): string {
  const d = new Date(time);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Reads `/usage`'s text (checked on Claude Code 2.1.292):
 *   Current session: 0% used · resets Oct 7 at 10:09am (America/New_York)
 *   Current week (all models): 3% used · resets Oct 13 at 12:59am (America/New_York)
 * Other weekly lines (a single model's) are left out. Null when neither line is there. */
export function parsePlanUsage(text: string): PlanLimits | null {
  const limits: PlanLimits = {};
  for (const line of text.split("\n")) {
    const match = /^\s*Current (session|week \(all models\)|week)\s*:\s*(\d+(?:\.\d+)?)% used(?:\s*·\s*resets\s+(.+?))?\s*$/.exec(line);
    if (!match) continue;
    const window: PlanWindow = { used: Number(match[2]) / 100, ...(match[3] ? { resetsText: match[3] } : {}) };
    if (match[1] === "session") limits.fiveHour ??= window;
    else limits.weekly ??= window;
  }
  return limits.fiveHour || limits.weekly ? limits : null;
}

/** A newer report over an older one: each window it has replaces the old; the others stay. */
export function mergePlan(old: PlanLimits | null, next: PlanLimits): PlanLimits {
  return { ...(old ?? {}), ...next };
}

/** How full a window is, for its colour: at a limit, close to one (75%+), or fine. */
export function windowLevel(window: PlanWindow | undefined, status?: string): "full" | "warn" | "ok" {
  if (!window) return "ok";
  if (window.used >= 0.9 || status === "rejected") return "full";
  return window.used >= 0.75 ? "warn" : "ok";
}

export function percent(used: number): string {
  return `${Math.round(used * 100)}%`;
}

/** "in 2 h 10 m" / "in 3 d 4 h" until a reset in epoch seconds; the reported words when there's none. */
export function resetsIn(window: PlanWindow, now: number): string | null {
  if (typeof window.resetsAt === "number") {
    const minutes = Math.max(0, Math.round((window.resetsAt * 1000 - now) / 60_000));
    if (minutes < 60) return `in ${minutes} m`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `in ${hours} h ${minutes % 60} m`;
    return `in ${Math.floor(hours / 24)} d ${hours % 24} h`;
  }
  return window.resetsText ? window.resetsText.replace(/\s*\([^)]*\)\s*$/, "") : null;
}

export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 10_000) return `${Math.round(n / 1000)}k`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

export function formatCost(usd: number | null): string {
  if (usd === null) return "—";
  return usd < 0.01 && usd > 0 ? "<$0.01" : `$${usd.toFixed(2)}`;
}
