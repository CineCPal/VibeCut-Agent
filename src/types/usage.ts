/**
 * The usage tracker (Phase 9b): the Claude plan's limits, and the tokens each model used.
 */
import type { AiChoiceId } from "./agent";

/** One of the plan's windows. `used` is a fraction (above 1 when usage ran past the cap). */
export interface PlanWindow {
  used: number;
  /** When it resets, in epoch seconds (from a chat turn's report). */
  resetsAt?: number;
  /** When it resets, as `/usage` words it ("Oct 7 at 10:09am (America/New_York)"). */
  resetsText?: string;
}

/** The plan's usage as Claude Code reports it: a turn's `rate_limit_event` (claude_code_chat.plan_limits)
 * or the `/usage` command (planUsage.parsePlanUsage). */
export interface PlanLimits {
  /** "allowed", "allowed_warning" (close to a limit) or "rejected" (at one). Absent from `/usage`. */
  status?: string;
  /** The window that limits right now. */
  limiting?: string;
  fiveHour?: PlanWindow;
  weekly?: PlanWindow;
  weeklyOverage?: PlanWindow;
}

/** Tokens used, summed over turns. `costUsd` is an estimate: API rates for an API key; Claude Code's
 * own reckoning for the subscription, which the plan pays for. Null when unknown (Gemini). */
export interface UsageTotals {
  turns: number;
  promptTokens: number;
  cachedTokens: number;
  outputTokens: number;
  costUsd: number | null;
}

/** A day's totals by model ("YYYY-MM-DD" in local time). */
export type DayTotals = Partial<Record<AiChoiceId, UsageTotals>>;
