import { create } from "zustand";
import type { ChatSummary } from "../types/history";

/** The past-chats list as Rust last answered it (Phase 8a), and why the last save failed, if it did. */
export interface ChatHistoryState {
  /** Null until it's been read at launch. */
  chats: ChatSummary[] | null;
  saveError: string | null;
  setChats: (chats: ChatSummary[]) => void;
  setSaveError: (error: string | null) => void;
}

export const useChatHistoryStore = create<ChatHistoryState>()((set) => ({
  chats: null,
  saveError: null,
  setChats: (chats) => set({ chats }),
  setSaveError: (saveError) => set({ saveError }),
}));
