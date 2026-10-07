/**
 * Names each new chat with its own model (PLAN.md, Phase 8d): once a chat's first answer is in, a
 * `chat-title` sidecar job asks the chat's provider for a short name, which the History list then shows
 * unless the user named the chat. On by default; Settings → Chat turns it off. A failed job changes
 * nothing; the first request stays the name.
 */
import { runJob } from "../jobs";
import { nameChatAutomatically } from "./chatHistory";
import { useAgentStore, type AgentState } from "../../store/useAgentStore";
import { AI_CHOICES } from "../../types/agent";

/** Chats already asked about this run, so a chat is named once. */
const asked = new Set<string>();

/** What to ask for, or null when this chat shouldn't be named now. */
export function titleRequest(state: AgentState): Record<string, unknown> | null {
  if (!state.autoTitles || state.status !== "idle" || state.customTitle || state.autoTitle || asked.has(state.chatId)) return null;
  const request = state.messages.find((m) => m.role === "user");
  const reply = state.messages.find((m) => m.role === "assistant" && m.status !== "pending" && m.text.trim());
  if (!request || !reply) return null;
  const choice = AI_CHOICES.find((c) => c.id === state.aiChoice) ?? AI_CHOICES[0];
  return {
    provider: choice.chatProvider,
    ...(choice.model ? { model: choice.model } : {}),
    request: request.text,
    reply: reply.text,
  };
}

async function nameChat(chatId: string, request: Record<string, unknown>): Promise<void> {
  asked.add(chatId);
  const job = await runJob("chat-title", "Name the chat", request);
  const title = job?.status === "done" ? job.result?.title : undefined;
  if (typeof title === "string" && title.trim()) await nameChatAutomatically(chatId, title).catch(() => undefined);
}

/** Watches for a chat's first finished answer. Call once. */
export function startChatTitles(): () => void {
  return useAgentStore.subscribe((state, prev) => {
    // Only as a turn ends: opening a chat (or restoring one at launch) costs nothing. A chat from before
    // this was added is named after its next answer.
    if (state.status !== "idle" || (prev.status !== "thinking" && prev.status !== "stopping")) return;
    const request = titleRequest(state);
    if (request) void nameChat(state.chatId, request);
  });
}

/** Test hook. */
export function resetChatTitlesForTests(): void {
  asked.clear();
}
