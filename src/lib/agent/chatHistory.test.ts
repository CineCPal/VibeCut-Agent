import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatSummary, SavedChat } from "../../types/history";

const ipc = vi.hoisted(() => ({
  listChats: vi.fn(),
  loadChatFile: vi.fn(),
  saveChatFile: vi.fn(),
  deleteChatFile: vi.fn(),
  loadEditLogFile: vi.fn(),
  saveEditLogFile: vi.fn(),
  startSidecar: vi.fn(),
  sendToSidecar: vi.fn(),
  cancelSidecar: vi.fn(),
  nleCall: vi.fn(),
  onSidecarEvent: vi.fn(async () => () => undefined),
  onSidecarExit: vi.fn(async () => () => undefined),
}));
vi.mock("../ipc", () => ipc);

import {
  HISTORY_DROPPED_NOTE,
  MAX_HISTORY_CHARS,
  SAVE_DELAY_MS,
  chatTitle,
  deleteChat,
  openChat,
  parseSavedChat,
  resetChatHistoryForTests,
  restoreOnLaunch,
  savedChatFrom,
  startChatHistory,
} from "./chatHistory";
import { newConversation, sendUserMessage } from "./controller";
import { useAgentStore } from "../../store/useAgentStore";
import { useChatHistoryStore } from "../../store/useChatHistoryStore";
import { useEditLogStore } from "../../store/useEditLogStore";
import { initialHosts, useNleStateStore } from "../../store/useNleStateStore";
import type { ChatMessage } from "../../types/agent";

const msg = (id: string, role: ChatMessage["role"], text: string, createdAt = 1000): ChatMessage => ({ id, role, text, createdAt });

const savedChat = (id: string, extra: Partial<SavedChat> = {}): SavedChat => ({
  version: 1,
  id,
  title: "Mark the hook",
  createdAt: 1000,
  updatedAt: 2000,
  provider: "gemini",
  aiChoice: "gemini",
  messages: [msg("u1", "user", "Mark the hook"), msg("a1", "assistant", "Marked it.")],
  history: [{ role: "user", parts: [{ text: "Mark the hook" }] }],
  ...extra,
});

const summary = (id: string): ChatSummary => ({ id, title: "Mark the hook", createdAt: 1000, updatedAt: 2000, messageCount: 2 });
const agent = () => useAgentStore.getState();
const settle = async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
};

describe("chat history (Phase 8a)", () => {
  let stop: (() => void) | null = null;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    resetChatHistoryForTests();
    ipc.listChats.mockResolvedValue([]);
    ipc.loadEditLogFile.mockResolvedValue(null);
    ipc.saveChatFile.mockImplementation(async (id: string) => [summary(id)]);
    ipc.saveEditLogFile.mockResolvedValue(undefined);
    ipc.deleteChatFile.mockResolvedValue([]);
    ipc.sendToSidecar.mockResolvedValue(undefined);
    ipc.startSidecar.mockResolvedValue(undefined);
    ipc.cancelSidecar.mockResolvedValue(undefined);
    useNleStateStore.setState({ hosts: initialHosts(), preferredHost: "auto" });
    useAgentStore.setState({ chatId: "c-now", messages: [], status: "idle", aiChoice: "gemini", jobId: null, sessionKey: null, history: [], historyProvider: null });
    useEditLogStore.setState({ entries: [], backups: {}, restoredIds: { premiere: {}, resolve: {} }, floorSeq: 1 });
    useChatHistoryStore.setState({ chats: null, saveError: null });
  });

  afterEach(() => {
    stop?.();
    stop = null;
    vi.useRealTimers();
  });

  it("titles a chat by its first request, on one line", () => {
    expect(chatTitle([msg("t", "tool", "ran"), msg("u", "user", "  Mark\n the   hook ")])).toBe("Mark the hook");
    expect(chatTitle([msg("u", "user", "x".repeat(80))])).toBe(`${"x".repeat(59)}…`);
    expect(chatTitle([])).toBe("");
  });

  it("saves nothing until there's a request, and drops a history too big to keep", () => {
    const base = { chatId: "c", messages: [msg("s", "system", "hi")], history: [], historyProvider: null, aiChoice: "gemini" as const };
    expect(savedChatFrom(base)).toBeNull();
    const big = savedChatFrom({ ...base, messages: [msg("u", "user", "go")], history: ["x".repeat(MAX_HISTORY_CHARS)], historyProvider: "gemini" }, 5);
    expect(big).toMatchObject({ id: "c", title: "go", createdAt: 1000, updatedAt: 5, history: [], historyDropped: true });
  });

  it("checks a chat read back from disk", () => {
    expect(parseSavedChat(null)).toBeNull();
    expect(parseSavedChat({ id: "x", messages: [] })).toBeNull();
    const parsed = parseSavedChat({ ...savedChat("x"), messages: [msg("u", "user", "go"), { id: 3 }], provider: "openai", aiChoice: "gpt" });
    expect(parsed?.messages).toHaveLength(1);
    expect(parsed?.provider).toBeNull();
    expect(parsed?.history).toEqual([]);
    expect(parsed?.aiChoice).toBe("gemini");
  });

  it("saves the chat a moment after it changes, once, and keeps the list Rust answers", async () => {
    stop = startChatHistory();
    await settle();
    agent().addMessage({ role: "user", text: "Mark the hook" });
    agent().addMessage({ role: "assistant", text: "Marked it." });
    expect(ipc.saveChatFile).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(SAVE_DELAY_MS);
    expect(ipc.saveChatFile).toHaveBeenCalledTimes(1);
    const [id, chat] = ipc.saveChatFile.mock.calls[0] as [string, SavedChat];
    expect(id).toBe("c-now");
    expect(chat).toMatchObject({ version: 1, id: "c-now", title: "Mark the hook", provider: null, aiChoice: "gemini" });
    expect(chat.messages.map((m) => m.text)).toEqual(["Mark the hook", "Marked it."]);
    expect(useChatHistoryStore.getState().chats).toEqual([summary("c-now")]);
  });

  it("saves the chat being left at once when New chat starts another", async () => {
    stop = startChatHistory();
    await settle();
    agent().addMessage({ role: "user", text: "first chat" });
    await newConversation();
    await settle();
    expect(ipc.saveChatFile).toHaveBeenCalledTimes(1);
    expect(ipc.saveChatFile.mock.calls[0][0]).toBe("c-now");
    expect(agent().chatId).not.toBe("c-now");
    await vi.advanceTimersByTimeAsync(SAVE_DELAY_MS);
    expect(ipc.saveChatFile).toHaveBeenCalledTimes(1);
  });

  it("says once in the transcript when the model's memory was too big to keep", async () => {
    stop = startChatHistory();
    await settle();
    agent().addMessage({ role: "user", text: "go" });
    agent().finishTurn(["x".repeat(MAX_HISTORY_CHARS)], "gemini", null);
    await vi.advanceTimersByTimeAsync(SAVE_DELAY_MS);
    await vi.advanceTimersByTimeAsync(SAVE_DELAY_MS);
    expect(agent().messages.filter((m) => m.text === HISTORY_DROPPED_NOTE)).toHaveLength(1);
    const last = ipc.saveChatFile.mock.calls.at(-1)?.[1] as SavedChat;
    expect(last.historyDropped).toBe(true);
    expect(last.messages.at(-1)?.text).toBe(HISTORY_DROPPED_NOTE);
  });

  it("a failed save is reported, and the chat goes on", async () => {
    ipc.saveChatFile.mockRejectedValue(new Error("disk full"));
    stop = startChatHistory();
    await settle();
    agent().addMessage({ role: "user", text: "go" });
    await vi.advanceTimersByTimeAsync(SAVE_DELAY_MS);
    expect(useChatHistoryStore.getState().saveError).toBe("Couldn't save this chat: disk full");
  });

  it("at launch, loads the edit log and reopens the chat that was open, without saving it again", async () => {
    ipc.listChats.mockResolvedValue([summary("c-now")]);
    ipc.loadChatFile.mockResolvedValue(savedChat("c-now"));
    ipc.loadEditLogFile.mockResolvedValue({
      version: 1,
      entries: [{ id: "e1", step: "u1", stepText: "x", at: 1, host: "resolve", timeline: "Main", tool: "t", summary: "s", backup: "b", changes: [] }],
      backups: {},
      restoredIds: { premiere: {}, resolve: {} },
    });
    stop = startChatHistory();
    await vi.advanceTimersByTimeAsync(0);
    expect(agent().messages.map((m) => m.text)).toEqual(["Mark the hook", "Marked it."]);
    expect(agent().historyProvider).toBe("gemini");
    expect(useEditLogStore.getState().entries[0]).toMatchObject({ id: "e1", fromEarlierRun: true });
    await vi.advanceTimersByTimeAsync(SAVE_DELAY_MS);
    expect(ipc.saveChatFile).not.toHaveBeenCalled();
  });

  it("never saves the edit log before the saved one was read", async () => {
    ipc.loadEditLogFile.mockRejectedValue(new Error("no folder"));
    stop = startChatHistory();
    await settle();
    useEditLogStore.getState().log({ step: "m", stepText: "x", host: "resolve", timeline: "Main", tool: "t", summary: "s", backup: "b", changes: [] });
    await vi.advanceTimersByTimeAsync(SAVE_DELAY_MS);
    expect(ipc.saveEditLogFile).not.toHaveBeenCalled();
  });

  it("saves the edit log as it changes once it's loaded", async () => {
    stop = startChatHistory();
    await settle();
    useEditLogStore.getState().log({ step: "m", stepText: "x", host: "resolve", timeline: "Main", tool: "t", summary: "s", backup: "b", changes: [] });
    await vi.advanceTimersByTimeAsync(SAVE_DELAY_MS);
    expect(ipc.saveEditLogFile).toHaveBeenCalledTimes(1);
    expect(ipc.saveEditLogFile.mock.calls[0][0]).toMatchObject({ version: 1, entries: [{ id: "e1", step: "m" }], nextSeq: 2 });
  });

  it("opening a past chat ends the running job, and the next message resends its history", async () => {
    stop = startChatHistory();
    await settle();
    agent().addMessage({ role: "user", text: "current" });
    useAgentStore.setState({ jobId: "job-1", sessionKey: "gemini:none" });
    ipc.loadChatFile.mockResolvedValue(savedChat("c-old"));
    await openChat("c-old");
    expect(ipc.sendToSidecar).toHaveBeenCalledWith("job-1", { type: "end_session" });
    expect(agent()).toMatchObject({ chatId: "c-old", jobId: null, historyProvider: "gemini" });
    await settle();
    expect(ipc.saveChatFile.mock.calls[0][0]).toBe("c-now");

    await sendUserMessage("and the outro");
    expect(ipc.startSidecar).toHaveBeenCalledWith(expect.any(String), "chat", expect.objectContaining({ provider: "gemini", history: savedChat("c-old").history }));
  });

  it("says when a past chat was with another model", async () => {
    useAgentStore.setState({ aiChoice: "claude-code-sonnet-5-5" });
    ipc.loadChatFile.mockResolvedValue(savedChat("c-old"));
    await openChat("c-old");
    expect(agent().messages.at(-1)).toMatchObject({ role: "system", text: expect.stringContaining("Earlier messages were with Gemini") });
  });

  it("an unreadable chat is refused and nothing changes", async () => {
    ipc.loadChatFile.mockResolvedValue({ junk: true });
    await expect(openChat("c-old")).rejects.toThrow("That chat can't be read");
    expect(agent().chatId).toBe("c-now");
  });

  it("deleting the open chat starts a new one, and never saves the deleted one again", async () => {
    stop = startChatHistory();
    await settle();
    agent().addMessage({ role: "user", text: "doomed" });
    await deleteChat("c-now");
    await vi.advanceTimersByTimeAsync(SAVE_DELAY_MS);
    expect(ipc.deleteChatFile).toHaveBeenCalledWith("c-now");
    expect(agent().chatId).not.toBe("c-now");
    expect(agent().messages).toEqual([]);
    expect(ipc.saveChatFile).not.toHaveBeenCalled();
  });

  it("restoreOnLaunch leaves a chat alone that's already under way", async () => {
    agent().addMessage({ role: "user", text: "typed fast" });
    ipc.listChats.mockResolvedValue([summary("c-now")]);
    await restoreOnLaunch();
    expect(ipc.loadChatFile).not.toHaveBeenCalled();
  });
});
