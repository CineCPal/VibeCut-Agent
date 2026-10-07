/**
 * The usage tracker (Phase 9b): the Claude plan's limits as Claude Code last reported them, and the
 * tokens each model used, by day and by chat. Kept in this browser's localStorage; nothing leaves the
 * machine. The arithmetic is in lib/agent/usage.ts.
 */
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { addTotals, dayKey, mergePlan, totalsOf } from "../lib/agent/usage";
import type { AiChoiceId, ChatUsage } from "../types/agent";
import type { DayTotals, PlanLimits, UsageTotals } from "../types/usage";

/** How many days, and how many chats, are kept. */
export const KEEP_DAYS = 30;
export const KEEP_CHATS = 200;

export interface ChatTotals extends UsageTotals {
  updatedAt: number;
}

export interface UsageState {
  plan: PlanLimits | null;
  /** When the plan was last reported (ms), or null. */
  planAt: number | null;
  days: Record<string, DayTotals>;
  chats: Record<string, ChatTotals>;
  setPlan: (limits: PlanLimits, at?: number) => void;
  /** Counts a finished turn. */
  addTurn: (choiceId: AiChoiceId, chatId: string, usage: ChatUsage, at?: number) => void;
  /** Forgets a deleted chat's totals (its tokens stay in the day's). */
  forgetChat: (chatId: string) => void;
}

function keepRecentDays(days: Record<string, DayTotals>, now: number): Record<string, DayTotals> {
  const oldest = dayKey(now - (KEEP_DAYS - 1) * 86_400_000);
  return Object.fromEntries(Object.entries(days).filter(([day]) => day >= oldest));
}

function keepRecentChats(chats: Record<string, ChatTotals>): Record<string, ChatTotals> {
  const entries = Object.entries(chats);
  if (entries.length <= KEEP_CHATS) return chats;
  return Object.fromEntries(entries.sort(([, a], [, b]) => b.updatedAt - a.updatedAt).slice(0, KEEP_CHATS));
}

export const useUsageStore = create<UsageState>()(
  persist(
    (set) => ({
      plan: null,
      planAt: null,
      days: {},
      chats: {},
      setPlan: (limits, at = Date.now()) => set((state) => ({ plan: mergePlan(state.plan, limits), planAt: at })),
      addTurn: (choiceId, chatId, usage, at = Date.now()) =>
        set((state) => {
          const turn = totalsOf(choiceId, usage);
          const day = dayKey(at);
          const today = state.days[day] ?? {};
          return {
            days: keepRecentDays({ ...state.days, [day]: { ...today, [choiceId]: addTotals(today[choiceId], turn) } }, at),
            chats: keepRecentChats({ ...state.chats, [chatId]: { ...addTotals(state.chats[chatId], turn), updatedAt: at } }),
          };
        }),
      forgetChat: (chatId) =>
        set((state) => {
          if (!(chatId in state.chats)) return {};
          const chats = { ...state.chats };
          delete chats[chatId];
          return { chats };
        }),
    }),
    {
      name: "vibecut-agent.usage",
      storage: createJSONStorage(() => localStorage),
      partialize: (state) => ({ plan: state.plan, planAt: state.planAt, days: state.days, chats: state.chats }),
    },
  ),
);

/** Totals over the last `count` days (today included), by model. */
export function recentTotals(days: Record<string, DayTotals>, count: number, now = Date.now()): DayTotals {
  const out: DayTotals = {};
  for (let i = 0; i < count; i += 1) {
    const day = days[dayKey(now - i * 86_400_000)] ?? {};
    for (const [id, totals] of Object.entries(day) as [AiChoiceId, UsageTotals][]) out[id] = addTotals(out[id], totals);
  }
  return out;
}
