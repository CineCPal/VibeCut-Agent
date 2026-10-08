import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

/** Settings → General → Notifications (Phase 11e). Remembered. */
export interface NotifyState {
  /** Notify when the agent finishes or needs you while the window is hidden or behind another app. */
  enabled: boolean;
  /** With a sound. */
  sound: boolean;
  setEnabled: (on: boolean) => void;
  setSound: (on: boolean) => void;
}

export const useNotifyStore = create<NotifyState>()(
  persist(
    (set) => ({
      enabled: true,
      sound: false,
      setEnabled: (enabled) => set({ enabled: enabled === true }),
      setSound: (sound) => set({ sound: sound === true }),
    }),
    { name: "vibecut-agent.notify", storage: createJSONStorage(() => localStorage) },
  ),
);
