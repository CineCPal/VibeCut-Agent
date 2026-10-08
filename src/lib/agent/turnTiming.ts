/**
 * How long a turn took to start answering (Phase 11f): marks from Send to the first words of the reply,
 * kept for the status bar's tooltip and logged to the console. Only the turn in progress is timed;
 * marks after its first words, or for a turn that isn't timed, are ignored.
 */
import { create } from "zustand";

export type TimingMark = "context" | "sent" | "status" | "firstWords";

export interface TurnTiming {
  /** Milliseconds from Send to each mark reached. */
  marks: Partial<Record<TimingMark, number>>;
  /** Whether the message went to a job already running (else one was started for it). */
  warm: boolean;
}

interface TimingState {
  last: TurnTiming | null;
  setLast: (last: TurnTiming) => void;
}

export const useTurnTimingStore = create<TimingState>()((set) => ({
  last: null,
  setLast: (last) => set({ last }),
}));

let startedAt: number | null = null;
let current: TurnTiming | null = null;
const now = () => performance.now();

export function startTiming(): void {
  startedAt = now();
  current = { marks: {}, warm: false };
}

export function markTiming(mark: TimingMark, warm?: boolean): void {
  if (startedAt === null || !current || current.marks[mark] !== undefined) return;
  current.marks[mark] = Math.round(now() - startedAt);
  if (warm !== undefined) current.warm = warm;
  if (mark === "firstWords") {
    useTurnTimingStore.getState().setLast(current);
    console.info(`[VibeCut] turn timing: ${describeTiming(current)}`);
    startedAt = null;
    current = null;
  }
}

/** Stops timing a turn that ended without words (an error, Stop, a tool-only answer). */
export function dropTiming(): void {
  startedAt = null;
  current = null;
}

const seconds = (ms: number) => `${(ms / 1000).toFixed(1)} s`;

export function describeTiming(timing: TurnTiming): string {
  const { context, sent, status, firstWords } = timing.marks;
  const parts = [
    firstWords !== undefined ? `first words ${seconds(firstWords)}` : null,
    context !== undefined ? `timeline read ${seconds(context)}` : null,
    sent !== undefined ? `sent ${seconds(sent)} (${timing.warm ? "running job" : "new job"})` : null,
    status !== undefined ? `model called ${seconds(status)}` : null,
  ];
  return parts.filter(Boolean).join(" · ");
}
