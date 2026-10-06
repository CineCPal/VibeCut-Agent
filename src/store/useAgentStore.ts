import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import type { AgentStatus, AiChoiceId, ChatMessage, ChatProvider, ChatUsage } from "../types/agent";
import { AI_CHOICES } from "../types/agent";
import { newId } from "../lib/id";

export interface AgentState {
  messages: ChatMessage[];
  status: AgentStatus;
  /** Why the agent can't chat, or what failed; shown under the composer. */
  statusDetail: string | null;
  aiChoice: AiChoiceId;
  draft: string;
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
  addMessage: (message: Omit<ChatMessage, "id" | "createdAt"> & Partial<Pick<ChatMessage, "id" | "createdAt">>) => string;
  updateMessage: (id: string, patch: Partial<Omit<ChatMessage, "id">>) => void;
  setStatus: (status: AgentStatus, detail?: string | null) => void;
  setAiChoice: (choice: AiChoiceId) => void;
  setDraft: (draft: string) => void;
  setSession: (jobId: string, sessionKey: string) => void;
  /** The sidecar's job ended (or never started): the next message starts a new one. */
  endSession: () => void;
  finishTurn: (history: unknown[], provider: ChatProvider, usage: ChatUsage | null) => void;
  setActivity: (activity: string | null) => void;
  /** Starts over: no messages, no history. */
  clear: () => void;
}

export const AGENT_OFFLINE_DETAIL = "Agent sidecar not running";

export const useAgentStore = create<AgentState>()(
  persist(
    (set) => ({
      messages: [],
      status: "offline",
      statusDetail: AGENT_OFFLINE_DETAIL,
      aiChoice: "gemini",
      draft: "",
      jobId: null,
      sessionKey: null,
      history: [],
      historyProvider: null,
      activity: null,
      usage: null,
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
      setStatus: (status, detail = null) => set({ status, statusDetail: detail }),
      setAiChoice: (choice) => {
        if (AI_CHOICES.some((c) => c.id === choice)) set({ aiChoice: choice });
      },
      setDraft: (draft) => set({ draft }),
      setSession: (jobId, sessionKey) => set({ jobId, sessionKey }),
      endSession: () => set({ jobId: null, sessionKey: null, activity: null }),
      finishTurn: (history, provider, usage) => set({ history, historyProvider: provider, usage, activity: null }),
      setActivity: (activity) => set({ activity }),
      clear: () => set({ messages: [], draft: "", history: [], historyProvider: null, usage: null, activity: null }),
    }),
    {
      name: "vibecut-agent.agent",
      storage: createJSONStorage(() => localStorage),
      partialize: (state) => ({ aiChoice: state.aiChoice }),
    },
  ),
);
