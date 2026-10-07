import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import type { AgentStatus, AiChoiceId, ChatMessage, ChatProvider, ChatUsage, LastTurn, PendingImage, StoryFirstPass } from "../types/agent";
import { AI_CHOICES } from "../types/agent";
import { newId } from "../lib/id";
import { lastTurnFrom } from "../lib/agent/rewind";
import type { SavedChat } from "../types/history";

export interface AgentState {
  /** The conversation's id in the past-chats list (Phase 8a); a new one after `clear`. Remembered, so
   * the app reopens it at launch. */
  chatId: string;
  messages: ChatMessage[];
  status: AgentStatus;
  /** Why the agent can't chat, or what failed; shown under the composer. */
  statusDetail: string | null;
  aiChoice: AiChoiceId;
  /** Which model reads long footage first for the Story Editor (Phase 7e). */
  storyFirstPass: StoryFirstPass;
  draft: string;
  /** Images in the composer, to go with the next message (Phase 8g). */
  pendingImages: PendingImage[];
  /** The running `chat` sidecar job, and what it was started for ("<provider>:<host>"). */
  jobId: string | null;
  sessionKey: string | null;
  /** The conversation so far, in the provider's own format (the sidecar's `result.history`). */
  history: unknown[];
  historyProvider: ChatProvider | null;
  /** What the agent is doing right now, while a turn runs. */
  activity: string | null;
  /** Token use of the last turn. */
  usage: ChatUsage | null;
  /** The last message's turn, for Retry and Edit (Phase 8c); null when there's none to take back. */
  lastTurn: LastTurn | null;
  /** The user message being edited in the composer (Phase 8c), or null. */
  editingMessageId: string | null;
  /** The chat's names (Phase 8d): the user's, and the model's after its first answer. */
  customTitle: string | null;
  autoTitle: string | null;
  /** Whether the chat's model names each new chat (Settings → Chat). Remembered. */
  autoTitles: boolean;
  addMessage: (message: Omit<ChatMessage, "id" | "createdAt"> & Partial<Pick<ChatMessage, "id" | "createdAt">>) => string;
  updateMessage: (id: string, patch: Partial<Omit<ChatMessage, "id">>) => void;
  /** Adds streamed text to a message (Phase 8b). */
  appendToMessage: (id: string, text: string) => void;
  removeMessage: (id: string) => void;
  setStatus: (status: AgentStatus, detail?: string | null) => void;
  setAiChoice: (choice: AiChoiceId) => void;
  setStoryFirstPass: (choice: StoryFirstPass) => void;
  setDraft: (draft: string) => void;
  setPendingImages: (images: PendingImage[]) => void;
  setSession: (jobId: string, sessionKey: string) => void;
  /** The sidecar's job ended (or never started): the next message starts a new one. */
  endSession: () => void;
  finishTurn: (history: unknown[], provider: ChatProvider, usage: ChatUsage | null) => void;
  setActivity: (activity: string | null) => void;
  setLastTurn: (turn: LastTurn | null) => void;
  setEditing: (messageId: string | null) => void;
  setTitles: (titles: { customTitle?: string | null; autoTitle?: string | null }) => void;
  setAutoTitles: (on: boolean) => void;
  /** Takes the last turn back: its message and everything after it go, and the history is as it was
   * sent with it. The controller checks it may (rewindLastTurn) before calling this. */
  takeBackLastTurn: () => void;
  /** Starts over: no messages, no history, a new chat id. */
  clear: () => void;
  /** Shows a saved chat in place of the current one. The caller ends the running job first. */
  loadChat: (chat: SavedChat) => void;
}

export const AGENT_OFFLINE_DETAIL = "Agent sidecar not running";

export const useAgentStore = create<AgentState>()(
  persist(
    (set) => ({
      chatId: newId(),
      messages: [],
      status: "offline",
      statusDetail: AGENT_OFFLINE_DETAIL,
      aiChoice: "gemini",
      storyFirstPass: "same",
      draft: "",
      pendingImages: [],
      jobId: null,
      sessionKey: null,
      history: [],
      historyProvider: null,
      activity: null,
      usage: null,
      lastTurn: null,
      editingMessageId: null,
      customTitle: null,
      autoTitle: null,
      autoTitles: true,
      addMessage: (message) => {
        const id = message.id ?? newId();
        const createdAt = message.createdAt ?? Date.now();
        set((state) => ({ messages: [...state.messages, { ...message, id, createdAt }] }));
        return id;
      },
      updateMessage: (id, patch) =>
        set((state) => ({
          messages: state.messages.map((m) => (m.id === id ? { ...m, ...patch } : m)),
        })),
      appendToMessage: (id, text) =>
        set((state) => ({
          messages: state.messages.map((m) => (m.id === id ? { ...m, text: m.text + text } : m)),
        })),
      removeMessage: (id) => set((state) => ({ messages: state.messages.filter((m) => m.id !== id) })),
      setStatus: (status, detail = null) => set({ status, statusDetail: detail }),
      setAiChoice: (choice) => {
        if (AI_CHOICES.some((c) => c.id === choice)) set({ aiChoice: choice });
      },
      setStoryFirstPass: (storyFirstPass) => set({ storyFirstPass: storyFirstPass === "gemini" ? "gemini" : "same" }),
      setDraft: (draft) => set({ draft }),
      setPendingImages: (pendingImages) => set({ pendingImages }),
      setSession: (jobId, sessionKey) => set({ jobId, sessionKey }),
      endSession: () => set({ jobId: null, sessionKey: null, activity: null }),
      finishTurn: (history, provider, usage) => set({ history, historyProvider: provider, usage, activity: null }),
      setActivity: (activity) => set({ activity }),
      setLastTurn: (lastTurn) => set({ lastTurn }),
      setEditing: (editingMessageId) => set({ editingMessageId }),
      setTitles: (titles) => set(titles),
      setAutoTitles: (autoTitles) => set({ autoTitles: autoTitles === true }),
      takeBackLastTurn: () =>
        set((state) => {
          const turn = state.lastTurn;
          const at = turn ? state.messages.findIndex((m) => m.id === turn.userMessageId) : -1;
          if (!turn || at < 0) return {};
          return {
            messages: state.messages.slice(0, at),
            history: turn.history,
            historyProvider: turn.history.length ? turn.historyProvider : null,
            lastTurn: null,
            editingMessageId: null,
            usage: null,
          };
        }),
      clear: () =>
        set({ chatId: newId(), messages: [], draft: "", pendingImages: [], history: [], historyProvider: null, usage: null, activity: null, lastTurn: null, editingMessageId: null, customTitle: null, autoTitle: null }),
      loadChat: (chat) =>
        set({
          chatId: chat.id,
          messages: chat.messages,
          history: chat.history,
          historyProvider: chat.provider,
          draft: "",
          pendingImages: [],
          usage: null,
          activity: null,
          jobId: null,
          sessionKey: null,
          lastTurn: lastTurnFrom(chat.rewind, chat),
          editingMessageId: null,
          customTitle: chat.customTitle ?? null,
          autoTitle: chat.autoTitle ?? null,
        }),
    }),
    {
      name: "vibecut-agent.agent",
      storage: createJSONStorage(() => localStorage),
      partialize: (state) => ({ aiChoice: state.aiChoice, storyFirstPass: state.storyFirstPass, chatId: state.chatId, autoTitles: state.autoTitles }),
    },
  ),
);
