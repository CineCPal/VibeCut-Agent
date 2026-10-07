import { beforeEach, describe, expect, it } from "vitest";
import { KEEP_CHATS, KEEP_DAYS, recentTotals, useUsageStore } from "./useUsageStore";
import { dayKey } from "../lib/agent/usage";

const DAY = 86_400_000;
const usage = { promptTokens: 1000, cachedTokens: 0, outputTokens: 100, thoughtsTokens: 0, steps: 1 };
const store = () => useUsageStore.getState();

describe("useUsageStore", () => {
  beforeEach(() => useUsageStore.setState({ plan: null, planAt: null, days: {}, chats: {} }));

  it("counts a turn by day, model and chat, and persists it", () => {
    const at = new Date(2026, 9, 7, 12).getTime();
    store().addTurn("claude-sonnet-5-5", "c1", usage, at);
    store().addTurn("claude-sonnet-5-5", "c1", usage, at + 1000);
    store().addTurn("gemini", "c2", usage, at);
    expect(store().days["2026-10-07"]["claude-sonnet-5-5"]).toMatchObject({ turns: 2, promptTokens: 2000, outputTokens: 200 });
    expect(store().days["2026-10-07"].gemini?.costUsd).toBeNull();
    expect(store().chats.c1).toMatchObject({ turns: 2, updatedAt: at + 1000 });
    expect(JSON.parse(localStorage.getItem("vibecut-agent.usage") ?? "{}").state.chats.c2.turns).toBe(1);
  });

  it(`keeps ${KEEP_DAYS} days and the ${KEEP_CHATS} latest chats`, () => {
    const now = new Date(2026, 9, 7, 12).getTime();
    store().addTurn("gemini", "old", usage, now - KEEP_DAYS * DAY);
    store().addTurn("gemini", "new", usage, now);
    expect(Object.keys(store().days)).toEqual([dayKey(now)]);
    const chats = Object.fromEntries(Array.from({ length: KEEP_CHATS }, (_, i) => [`c${i}`, { turns: 1, promptTokens: 0, cachedTokens: 0, outputTokens: 0, costUsd: null, updatedAt: i }]));
    useUsageStore.setState({ chats });
    store().addTurn("gemini", "latest", usage, now);
    expect(Object.keys(store().chats)).toHaveLength(KEEP_CHATS);
    expect(store().chats.c0).toBeUndefined();
    expect(store().chats.latest).toBeDefined();
  });

  it("forgets a deleted chat and merges plan reports", () => {
    store().addTurn("gemini", "c1", usage);
    store().forgetChat("c1");
    expect(store().chats.c1).toBeUndefined();
    store().setPlan({ fiveHour: { used: 0.1 }, weekly: { used: 0.2 } }, 5);
    store().setPlan({ fiveHour: { used: 0.3 } }, 9);
    expect(store()).toMatchObject({ plan: { fiveHour: { used: 0.3 }, weekly: { used: 0.2 } }, planAt: 9 });
  });

  it("sums the last few days by model", () => {
    const now = new Date(2026, 9, 7, 12).getTime();
    store().addTurn("gemini", "a", usage, now);
    store().addTurn("gemini", "a", usage, now - 3 * DAY);
    store().addTurn("gemini", "a", usage, now - 8 * DAY);
    expect(recentTotals(store().days, 7, now).gemini?.turns).toBe(2);
    expect(recentTotals(store().days, 1, now).gemini?.turns).toBe(1);
  });
});
