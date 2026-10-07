import { describe, expect, it } from "vitest";
import { addTotals, dayKey, formatCost, formatTokens, mergePlan, parsePlanUsage, resetsIn, turnCost, windowLevel } from "./usage";

const usage = (over: Partial<Record<string, number>> = {}) => ({ promptTokens: 0, cachedTokens: 0, outputTokens: 0, thoughtsTokens: 0, steps: 1, ...over });

// `/usage` as Claude Code 2.1.292 printed it (Work profile, 2026-10-07).
const USAGE_TEXT = `You are currently using your subscription to power your Claude Code usage

Current session: 0% used · resets Oct 7 at 10:09am (America/New_York)
Current week (all models): 3% used · resets Oct 13 at 12:59am (America/New_York)

What's contributing to your limits usage?
Last 24h · 12 requests · 8 sessions
  Top MCP servers: vibecut 3%`;

describe("usage arithmetic", () => {
  it("prices API turns from their tokens, with cached input at the cache-read rate", () => {
    expect(turnCost("claude-opus-5-5", usage({ promptTokens: 1_000_000, cachedTokens: 500_000, outputTokens: 100_000 }))).toBeCloseTo(0.5 * 4 + 0.5 * 0.2 + 0.1 * 20);
    expect(turnCost("claude-sonnet-5-5", usage({ promptTokens: 2_000_000 }))).toBeCloseTo(4);
  });

  it("takes Claude Code's own figure for the subscription, and doesn't guess Gemini's", () => {
    expect(turnCost("claude-code-opus-5-5", usage({ costUsd: 0.0158 }))).toBe(0.0158);
    expect(turnCost("claude-code-opus-5-5", usage())).toBeNull();
    expect(turnCost("gemini", usage({ promptTokens: 5000 }))).toBeNull();
  });

  it("adds totals, keeping an unknown cost unknown until one is known", () => {
    const gemini = { turns: 1, promptTokens: 10, cachedTokens: 0, outputTokens: 5, costUsd: null };
    expect(addTotals(undefined, gemini).costUsd).toBeNull();
    expect(addTotals(gemini, { ...gemini, costUsd: 0.5 })).toMatchObject({ turns: 2, promptTokens: 20, outputTokens: 10, costUsd: 0.5 });
  });

  it("names days in local time", () => {
    expect(dayKey(new Date(2026, 9, 7, 23, 59).getTime())).toBe("2026-10-07");
    expect(dayKey(new Date(2026, 0, 3).getTime())).toBe("2026-01-03");
  });

  it("reads /usage's session and all-models week, and nothing from other text", () => {
    expect(parsePlanUsage(USAGE_TEXT)).toEqual({
      fiveHour: { used: 0, resetsText: "Oct 7 at 10:09am (America/New_York)" },
      weekly: { used: 0.03, resetsText: "Oct 13 at 12:59am (America/New_York)" },
    });
    expect(parsePlanUsage("Current week (Opus): 40% used\nCurrent week (all models): 12% used")).toEqual({ weekly: { used: 0.12 } });
    expect(parsePlanUsage("You are using an API key")).toBeNull();
  });

  it("lets a newer report replace only the windows it has", () => {
    const old = { status: "allowed", fiveHour: { used: 0.1 }, weekly: { used: 0.2 } };
    expect(mergePlan(old, { status: "allowed_warning", fiveHour: { used: 0.8 } })).toEqual({ status: "allowed_warning", fiveHour: { used: 0.8 }, weekly: { used: 0.2 } });
    expect(mergePlan(null, { weekly: { used: 0.3 } })).toEqual({ weekly: { used: 0.3 } });
  });

  it("colours a window by how full it is", () => {
    expect(windowLevel({ used: 0.5 })).toBe("ok");
    expect(windowLevel({ used: 0.75 })).toBe("warn");
    expect(windowLevel({ used: 0.9 })).toBe("full");
    expect(windowLevel({ used: 0.1 }, "rejected")).toBe("full");
    expect(windowLevel(undefined)).toBe("ok");
  });

  it("says when a window resets", () => {
    const now = 1_000_000_000_000;
    expect(resetsIn({ used: 0, resetsAt: now / 1000 + 45 * 60 }, now)).toBe("in 45 m");
    expect(resetsIn({ used: 0, resetsAt: now / 1000 + 130 * 60 }, now)).toBe("in 2 h 10 m");
    expect(resetsIn({ used: 0, resetsAt: now / 1000 + 50 * 3600 }, now)).toBe("in 2 d 2 h");
    expect(resetsIn({ used: 0, resetsText: "Oct 7 at 10:09am (America/New_York)" }, now)).toBe("Oct 7 at 10:09am");
    expect(resetsIn({ used: 0 }, now)).toBeNull();
  });

  it("formats tokens and dollars compactly", () => {
    expect([formatTokens(950), formatTokens(1500), formatTokens(42_000), formatTokens(3_400_000)]).toEqual(["950", "1.5k", "42k", "3.4M"]);
    expect([formatCost(null), formatCost(0.004), formatCost(1.234)]).toEqual(["—", "<$0.01", "$1.23"]);
  });
});
