import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import type { NleHost, NleState, PreferredHost } from "../types/nle";
import { NLE_HOSTS } from "../types/nle";

export interface NleStoreState {
  hosts: Record<NleHost, NleState>;
  preferredHost: PreferredHost;
  /** Applies a state pushed by Rust (`nle-state`) or read with `nle_state`. */
  applyState: (state: NleState) => void;
  setPreferredHost: (host: PreferredHost) => void;
}

export function emptyHostState(host: NleHost): NleState {
  return {
    host,
    status: "connecting",
    message: null,
    product: null,
    version: null,
    project: null,
    timeline: null,
    timelines: [],
    reason: null,
    changedAt: 0,
  };
}

export function initialHosts(): Record<NleHost, NleState> {
  return { premiere: emptyHostState("premiere"), resolve: emptyHostState("resolve") };
}

/** The editor the agent works with: the preferred one if it's connected, else the first connected one. */
export function selectActiveHost(state: Pick<NleStoreState, "hosts" | "preferredHost">): NleHost | null {
  const { hosts, preferredHost } = state;
  if (preferredHost !== "auto" && hosts[preferredHost].status === "connected") return preferredHost;
  return NLE_HOSTS.find((host) => hosts[host].status === "connected") ?? null;
}

export const useNleStateStore = create<NleStoreState>()(
  persist(
    (set) => ({
      hosts: initialHosts(),
      preferredHost: "auto",
      applyState: (next) =>
        set((state) => {
          // An older state can arrive after a newer one (the mount-time read racing a push).
          if (next.changedAt < state.hosts[next.host].changedAt) return state;
          return { hosts: { ...state.hosts, [next.host]: next } };
        }),
      setPreferredHost: (preferredHost) => set({ preferredHost }),
    }),
    {
      name: "vibecut-agent.nle",
      storage: createJSONStorage(() => localStorage),
      partialize: (state) => ({ preferredHost: state.preferredHost }),
    },
  ),
);
