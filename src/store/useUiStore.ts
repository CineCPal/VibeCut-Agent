import { create } from "zustand";
import type { View } from "../types/system";

/** The panels: the agent chat, the Spyglass B-roll Library, and the B-roll analyzer ("broll", the Analyze tab). */
export type Tab = "chat" | "library" | "broll";
/** "notes": the project's notes (Phase 13c, ⌘⇧N); not a tray destination, so not a `View`. */
export type Overlay = "settings" | "about" | "notes";
/** Settings' tabs (Phase 11a). */
export type SettingsTab = "general" | "agent" | "accounts" | "editors" | "library";

export interface UiState {
  tab: Tab;
  overlay: Overlay | null;
  /** The Settings tab shown last; Settings opens on it again (for this run of the app). */
  settingsTab: SettingsTab;
  setSettingsTab: (tab: SettingsTab) => void;
  /** Keep on Top of Editors, as Rust last reported it; null until known. */
  keepOnTop: boolean | null;
  /** Whether the window is the Mini Player (Phase 9c), as Rust last reported it. */
  miniPlayer: boolean;
  setMiniPlayerState: (on: boolean) => void;
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
  settingsTab: "agent",
  setSettingsTab: (settingsTab) => set({ settingsTab }),
  keepOnTop: null,
  miniPlayer: false,
  setMiniPlayerState: (miniPlayer) => set({ miniPlayer }),
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
