import { create } from "zustand";
import type { View } from "../types/system";

export type Tab = "chat" | "broll";
export type Overlay = "settings" | "about";

export interface UiState {
  tab: Tab;
  overlay: Overlay | null;
  /** Keep on Top of Editors, as Rust last reported it; null until known. */
  keepOnTop: boolean | null;
  /** The chat's past-chats menu (Phase 8a; ⌘Y). */
  historyOpen: boolean;
  setHistoryOpen: (open: boolean) => void;
  setKeepOnTopState: (on: boolean) => void;
  setTab: (tab: Tab) => void;
  openOverlay: (overlay: Overlay) => void;
  closeOverlay: () => void;
  /** Applies a tray/hotkey destination: tabs switch the panel, settings/about open over it. */
  navigate: (view: View) => void;
}

export const useUiStore = create<UiState>()((set) => ({
  tab: "chat",
  overlay: null,
  keepOnTop: null,
  historyOpen: false,
  setHistoryOpen: (historyOpen) => set({ historyOpen }),
  setKeepOnTopState: (keepOnTop) => set({ keepOnTop }),
  setTab: (tab) => set({ tab }),
  openOverlay: (overlay) => set({ overlay }),
  closeOverlay: () => set({ overlay: null }),
  navigate: (view) => {
    if (view === "settings" || view === "about") set({ overlay: view });
    else set({ tab: view, overlay: null });
  },
}));
