import { create } from "zustand";

/**
 * The MCP bridge's state in the app (PLAN.md, Phase 7a): whether outside control is allowed (Rust
 * saves it), outside calls running now (the composer waits for them), and the current outside step,
 * which groups an outside run's edits under one backup and one Revert.
 */
export interface McpState {
  /** Null until Rust has said. */
  outsideAllowed: boolean | null;
  lastOutsideAt: number | null;
  outsideRunning: number;
  /** The step outside edits join until `OUTSIDE_STEP_GAP_MS` passes without an outside call. */
  outsideStep: { id: string; lastAt: number } | null;
  setStatus: (outsideAllowed: boolean, lastOutsideAt: number | null) => void;
  setOutsideStep: (step: { id: string; lastAt: number } | null) => void;
  outsideStarted: () => void;
  outsideFinished: () => void;
}

export const useMcpStore = create<McpState>()((set) => ({
  outsideAllowed: null,
  lastOutsideAt: null,
  outsideRunning: 0,
  outsideStep: null,
  setStatus: (outsideAllowed, lastOutsideAt) => set({ outsideAllowed, lastOutsideAt }),
  setOutsideStep: (outsideStep) => set({ outsideStep }),
  outsideStarted: () => set((s) => ({ outsideRunning: s.outsideRunning + 1, lastOutsideAt: Date.now() })),
  outsideFinished: () => set((s) => ({ outsideRunning: Math.max(0, s.outsideRunning - 1) })),
}));
