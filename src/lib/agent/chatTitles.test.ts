import { beforeEach, describe, expect, it, vi } from "vitest";

const jobs = vi.hoisted(() => ({ runJob: vi.fn() }));
vi.mock("../jobs", () => jobs);
const history = vi.hoisted(() => ({ nameChatAutomatically: vi.fn() }));
vi.mock("./chatHistory", () => history);

import { resetChatTitlesForTests, startChatTitles, titleRequest } from "./chatTitles";
import { useAgentStore } from "../../store/useAgentStore";
import type { ChatMessage } from "../../types/agent";

const msg = (id: string, role: ChatMessage["role"], text: string, status?: ChatMessage["status"]): ChatMessage => ({ id, role, text, createdAt: 1, ...(status ? { status } : {}) });
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("chat titles (Phase 8d)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetChatTitlesForTests();
    jobs.runJob.mockResolvedValue({ status: "done", result: { title: "Hook markers" } });
    history.nameChatAutomatically.mockResolvedValue(undefined);
    useAgentStore.setState({
      chatId: "c1",
      status: "idle",
      aiChoice: "claude-code-sonnet-5-5",
      autoTitles: true,
      customTitle: null,
      autoTitle: null,
      messages: [msg("u", "user", "Mark the hook"), msg("t", "tool", "Added 1 marker"), msg("a", "assistant", "Marked it at 0:12.")],
    });
  });

  it("asks the chat's own provider and model, with the first request and answer", () => {
    expect(titleRequest(useAgentStore.getState())).toEqual({
      provider: "claude-code",
      model: "claude-sonnet-5-5",
      request: "Mark the hook",
      reply: "Marked it at 0:12.",
    });
  });

  it("doesn't ask when it's off, already named, still answering, or before an answer", () => {
    const state = useAgentStore.getState();
    expect(titleRequest({ ...state, autoTitles: false })).toBeNull();
    expect(titleRequest({ ...state, customTitle: "Mine" })).toBeNull();
    expect(titleRequest({ ...state, autoTitle: "Model's" })).toBeNull();
    expect(titleRequest({ ...state, status: "thinking" })).toBeNull();
    expect(titleRequest({ ...state, messages: [state.messages[0], msg("a", "assistant", "Mar", "pending")] })).toBeNull();
    expect(titleRequest({ ...state, messages: [state.messages[0]] })).toBeNull();
  });

  it("names a chat once, as a turn ends, and never just for opening it", async () => {
    const stop = startChatTitles();
    useAgentStore.setState({ chatId: "c2" });
    await flush();
    expect(jobs.runJob).not.toHaveBeenCalled();

    useAgentStore.setState({ status: "thinking" });
    useAgentStore.setState({ status: "idle" });
    await flush();
    expect(jobs.runJob).toHaveBeenCalledWith("chat-title", "Name the chat", expect.objectContaining({ request: "Mark the hook" }));
    expect(history.nameChatAutomatically).toHaveBeenCalledWith("c2", "Hook markers");

    useAgentStore.setState({ status: "thinking" });
    useAgentStore.setState({ status: "idle" });
    await flush();
    expect(jobs.runJob).toHaveBeenCalledTimes(1);
    stop();
  });

  it("a failed job leaves the name alone", async () => {
    jobs.runJob.mockResolvedValue({ status: "failed", result: null });
    const stop = startChatTitles();
    useAgentStore.setState({ status: "thinking" });
    useAgentStore.setState({ status: "idle" });
    await flush();
    expect(history.nameChatAutomatically).not.toHaveBeenCalled();
    stop();
  });
});
