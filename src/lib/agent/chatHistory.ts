/**
 * Past chats and the edit log, kept across restarts (PLAN.md, Phase 8a). Rust files them as JSON in the
 * app's data folder (chat_store.rs); this module decides what's saved and when.
 *
 * - The current chat is saved `SAVE_DELAY_MS` after its messages or history change, once it has a user
 *   message. When the chat itself changes (New chat, or opening a past one), the old one is saved at once.
 * - The edit log is saved the same way, once the saved one has been loaded at launch.
 * - At launch: the list, the edit log, and the chat that was open (its id is remembered).
 * - Saves run one after another, so an older one never lands after a newer one.
 */
import { deleteChatFile, listChats, loadChatFile, loadEditLogFile, saveChatFile, saveEditLogFile } from "../ipc";
import { newConversation } from "./controller";
import { describeError } from "./context";
import { useAgentStore, type AgentState } from "../../store/useAgentStore";
import { useChatHistoryStore } from "../../store/useChatHistoryStore";
import { parseSavedEditLog, savedEditLog, useEditLogStore } from "../../store/useEditLogStore";
import type { ChatMessage, ChatProvider } from "../../types/agent";
import { AI_CHOICES } from "../../types/agent";
import type { SavedChat } from "../../types/history";

export const SAVE_DELAY_MS = 400;
/** Past this (as JSON), a chat is saved without the model's history; Rust's limit per file is 16 MB. */
export const MAX_HISTORY_CHARS = 12 * 1024 * 1024;
export const TITLE_CHARS = 60;
export const HISTORY_DROPPED_NOTE =
  "This chat is too long to keep the model's memory of it after a restart; the transcript is saved.";

const PROVIDERS: readonly ChatProvider[] = ["gemini", "claude", "claude-code"];
const PROVIDER_NAME: Record<ChatProvider, string> = { gemini: "Gemini", claude: "Claude (API key)", "claude-code": "Claude (subscription)" };
const ROLES: readonly ChatMessage["role"][] = ["user", "assistant", "system", "tool", "error"];

type ChatFields = Pick<AgentState, "chatId" | "messages" | "history" | "historyProvider" | "aiChoice">;

/** The list's name for a chat: its first request, on one line. */
export function chatTitle(messages: ChatMessage[]): string {
  const first = messages.find((m) => m.role === "user")?.text.replace(/\s+/g, " ").trim() ?? "";
  return first.length > TITLE_CHARS ? `${first.slice(0, TITLE_CHARS - 1).trimEnd()}…` : first;
}

/** The chat as it's saved; null until it has a user message. */
export function savedChatFrom(state: ChatFields, now = Date.now()): SavedChat | null {
  if (!state.messages.some((m) => m.role === "user")) return null;
  let size: number;
  try {
    size = JSON.stringify(state.history).length;
  } catch {
    size = Infinity;
  }
  const dropped = size > MAX_HISTORY_CHARS;
  return {
    version: 1,
    id: state.chatId,
    title: chatTitle(state.messages),
    createdAt: state.messages[0].createdAt,
    updatedAt: now,
    provider: state.historyProvider,
    aiChoice: state.aiChoice,
    messages: state.messages,
    history: dropped ? [] : state.history,
    ...(dropped ? { historyDropped: true } : {}),
  };
}

/** A chat read back from disk, checked; null when it isn't one. Malformed messages are left out. */
export function parseSavedChat(value: unknown): SavedChat | null {
  if (typeof value !== "object" || value === null) return null;
  const v = value as Record<string, unknown>;
  if (typeof v.id !== "string" || !v.id || !Array.isArray(v.messages)) return null;
  const messages = v.messages.filter(
    (m): m is ChatMessage =>
      typeof m === "object" && m !== null && typeof (m as ChatMessage).id === "string" && ROLES.includes((m as ChatMessage).role) &&
      typeof (m as ChatMessage).text === "string" && typeof (m as ChatMessage).createdAt === "number",
  );
  if (messages.length === 0) return null;
  const provider = PROVIDERS.includes(v.provider as ChatProvider) ? (v.provider as ChatProvider) : null;
  const aiChoice = AI_CHOICES.find((c) => c.id === v.aiChoice)?.id ?? AI_CHOICES[0].id;
  return {
    version: 1,
    id: v.id,
    title: typeof v.title === "string" ? v.title : chatTitle(messages),
    createdAt: typeof v.createdAt === "number" ? v.createdAt : messages[0].createdAt,
    updatedAt: typeof v.updatedAt === "number" ? v.updatedAt : messages[messages.length - 1].createdAt,
    // A history without its provider can't be resent to anyone.
    provider,
    aiChoice,
    messages,
    history: provider && Array.isArray(v.history) ? v.history : [],
    ...(v.historyDropped === true ? { historyDropped: true } : {}),
  };
}

let queue: Promise<void> = Promise.resolve();
let chatTimer: ReturnType<typeof setTimeout> | null = null;
let editLogTimer: ReturnType<typeof setTimeout> | null = null;
let editLogReady = false;
/** True while a saved chat is being shown at launch: that's not a change to save. */
let quiet = false;
/** Chats deleted this run: a save already on its way for one is dropped. */
const deleted = new Set<string>();

function enqueue(job: () => Promise<void>): Promise<void> {
  queue = queue.then(job, job);
  return queue;
}

function saveChat(chat: SavedChat | null): Promise<void> {
  if (!chat) return Promise.resolve();
  if (chat.historyDropped && !chat.messages.some((m) => m.text === HISTORY_DROPPED_NOTE) && useAgentStore.getState().chatId === chat.id) {
    // Said once, in the transcript; adding it schedules the save that carries it.
    useAgentStore.getState().addMessage({ role: "system", text: HISTORY_DROPPED_NOTE });
  }
  return enqueue(async () => {
    if (deleted.has(chat.id)) return;
    try {
      useChatHistoryStore.getState().setChats(await saveChatFile(chat.id, chat));
      useChatHistoryStore.getState().setSaveError(null);
    } catch (error) {
      // A chat that can't be saved still works; Settings and the list don't need it.
      useChatHistoryStore.getState().setSaveError(`Couldn't save this chat: ${describeError(error)}`);
    }
  });
}

/** Saves the current chat now (pending changes included). */
export function flushChat(): Promise<void> {
  if (chatTimer) clearTimeout(chatTimer);
  chatTimer = null;
  return saveChat(savedChatFrom(useAgentStore.getState()));
}

function saveEditLog(): Promise<void> {
  if (!editLogReady) return Promise.resolve();
  const log = savedEditLog();
  return enqueue(async () => {
    try {
      await saveEditLogFile(log);
    } catch (error) {
      useChatHistoryStore.getState().setSaveError(`Couldn't save the edit log: ${describeError(error)}`);
    }
  });
}

/** Saves the edit log now (pending changes included). */
export function flushEditLog(): Promise<void> {
  if (editLogTimer) clearTimeout(editLogTimer);
  editLogTimer = null;
  return saveEditLog();
}

/** Reads the list, the edit log and the chat that was open when the app last quit. */
export async function restoreOnLaunch(): Promise<void> {
  const [chats, log] = await Promise.all([
    listChats().catch(() => null),
    loadEditLogFile().then(
      (value) => ({ ok: true as const, value }),
      () => ({ ok: false as const, value: null }),
    ),
  ]);
  if (chats) useChatHistoryStore.getState().setChats(chats);
  if (log.ok) {
    const saved = parseSavedEditLog(log.value);
    if (saved) useEditLogStore.getState().hydrate(saved);
    // Only now may the log be saved: before, an empty one would overwrite it.
    editLogReady = true;
    if (useEditLogStore.getState().entries.length) void flushEditLog();
  }
  const agent = useAgentStore.getState();
  if (!chats || agent.messages.length > 0 || !chats.some((c) => c.id === agent.chatId)) return;
  const chat = parseSavedChat(await loadChatFile(agent.chatId).catch(() => null));
  if (!chat || useAgentStore.getState().messages.length > 0 || useAgentStore.getState().jobId) return;
  quiet = true;
  try {
    useAgentStore.getState().loadChat(chat);
  } finally {
    quiet = false;
  }
}

/** Opens a past chat in place of the current one (which is already saved). Throws when it can't be read. */
export async function openChat(id: string): Promise<void> {
  const agent = useAgentStore.getState();
  if (agent.chatId === id || agent.status === "thinking" || agent.status === "stopping") return;
  const chat = parseSavedChat(await loadChatFile(id));
  if (!chat) throw new Error("That chat can't be read");
  await newConversation(chat);
  const current = AI_CHOICES.find((c) => c.id === useAgentStore.getState().aiChoice) ?? AI_CHOICES[0];
  if (chat.provider && chat.provider !== current.chatProvider) {
    useAgentStore.getState().addMessage({
      role: "system",
      text: `Earlier messages were with ${PROVIDER_NAME[chat.provider]}. With ${current.label}, the model starts without its memory of them; choose ${PROVIDER_NAME[chat.provider]} in Settings to continue where it left off.`,
    });
  }
}

/** Deletes a past chat; the current one starts over. */
export async function deleteChat(id: string): Promise<void> {
  deleted.add(id);
  try {
    useChatHistoryStore.getState().setChats(await deleteChatFile(id));
  } catch (error) {
    deleted.delete(id);
    throw error;
  }
  if (useAgentStore.getState().chatId === id) {
    if (chatTimer) clearTimeout(chatTimer);
    chatTimer = null;
    await newConversation();
  }
}

/** Saves the chat and the edit log as they change, and restores them at launch. Call once. */
export function startChatHistory(): () => void {
  const unsubscribeChat = useAgentStore.subscribe((state, prev) => {
    if (state.chatId !== prev.chatId) {
      // Another chat now: the one just left is saved as it was.
      if (chatTimer) clearTimeout(chatTimer);
      chatTimer = null;
      void saveChat(savedChatFrom(prev));
      return;
    }
    if (quiet) return;
    if (state.messages === prev.messages && state.history === prev.history && state.historyProvider === prev.historyProvider) return;
    if (chatTimer) clearTimeout(chatTimer);
    chatTimer = setTimeout(() => void flushChat(), SAVE_DELAY_MS);
  });
  const unsubscribeLog = useEditLogStore.subscribe((state, prev) => {
    if (state.entries === prev.entries && state.backups === prev.backups && state.restoredIds === prev.restoredIds) return;
    if (editLogTimer) clearTimeout(editLogTimer);
    editLogTimer = setTimeout(() => void flushEditLog(), SAVE_DELAY_MS);
  });
  // Quitting from the tray closes the webview: whatever is still waiting goes now.
  const onHide = () => {
    void flushChat();
    void flushEditLog();
  };
  window.addEventListener("pagehide", onHide);
  void restoreOnLaunch();
  return () => {
    unsubscribeChat();
    unsubscribeLog();
    window.removeEventListener("pagehide", onHide);
    if (chatTimer) clearTimeout(chatTimer);
    if (editLogTimer) clearTimeout(editLogTimer);
    chatTimer = editLogTimer = null;
  };
}

/** Test hook: forgets this module's state between tests. */
export function resetChatHistoryForTests(): void {
  queue = Promise.resolve();
  if (chatTimer) clearTimeout(chatTimer);
  if (editLogTimer) clearTimeout(editLogTimer);
  chatTimer = editLogTimer = null;
  editLogReady = false;
  quiet = false;
  deleted.clear();
}
