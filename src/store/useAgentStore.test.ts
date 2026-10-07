import { beforeEach, describe, expect, it } from "vitest";
import { AGENT_OFFLINE_DETAIL, useAgentStore } from "./useAgentStore";
import type { AiChoiceId } from "../types/agent";

describe("useAgentStore", () => {
  beforeEach(() => {
    localStorage.clear();
    useAgentStore.setState({ messages: [], status: "offline", statusDetail: AGENT_OFFLINE_DETAIL, aiChoice: "gemini", draft: "" });
  });

  it("starts offline until the sidecar reports in", () => {
    expect(useAgentStore.getState()).toMatchObject({ status: "offline", statusDetail: AGENT_OFFLINE_DETAIL });
  });

  it("adds messages with generated ids and timestamps", () => {
    const id = useAgentStore.getState().addMessage({ role: "user", text: "Nest the interview clips" });
    const [message] = useAgentStore.getState().messages;
    expect(message).toMatchObject({ id, role: "user", text: "Nest the interview clips" });
    expect(typeof message.createdAt).toBe("number");
  });

  it("keeps explicit ids and updates by id", () => {
    useAgentStore.getState().addMessage({ id: "a", role: "user", text: "one", status: "pending" });
    useAgentStore.getState().addMessage({ id: "b", role: "assistant", text: "two" });
    useAgentStore.getState().updateMessage("a", { status: "done" });
    const [a, b] = useAgentStore.getState().messages;
    expect(a).toMatchObject({ id: "a", status: "done", text: "one" });
    expect(b).toMatchObject({ id: "b", text: "two" });
  });

  it("sets status with an optional detail", () => {
    useAgentStore.getState().setStatus("idle");
    expect(useAgentStore.getState()).toMatchObject({ status: "idle", statusDetail: null });
    useAgentStore.getState().setStatus("error", "Sidecar exited");
    expect(useAgentStore.getState()).toMatchObject({ status: "error", statusDetail: "Sidecar exited" });
  });

  it("only accepts known AI choices and persists the choice", () => {
    useAgentStore.getState().setAiChoice("claude-opus-5-5");
    useAgentStore.getState().setAiChoice("gpt-9" as AiChoiceId);
    expect(useAgentStore.getState().aiChoice).toBe("claude-opus-5-5");
    const saved = JSON.parse(localStorage.getItem("vibecut-agent.agent") ?? "{}");
    expect(saved.state).toEqual({ aiChoice: "claude-opus-5-5", storyFirstPass: "same", chatId: useAgentStore.getState().chatId });
  });

  it("keeps the Story Editor's first-pass choice to the two known ones", () => {
    useAgentStore.getState().setStoryFirstPass("gemini");
    expect(useAgentStore.getState().storyFirstPass).toBe("gemini");
    useAgentStore.getState().setStoryFirstPass("openai" as never);
    expect(useAgentStore.getState().storyFirstPass).toBe("same");
  });

  it("clear empties messages and the draft, as a new chat", () => {
    const before = useAgentStore.getState().chatId;
    useAgentStore.getState().addMessage({ role: "user", text: "x" });
    useAgentStore.getState().setDraft("half-typed");
    useAgentStore.getState().clear();
    expect(useAgentStore.getState()).toMatchObject({ messages: [], draft: "" });
    expect(useAgentStore.getState().chatId).not.toBe(before);
  });

  it("loadChat shows a saved chat with its history, and no job", () => {
    useAgentStore.setState({ jobId: "j", sessionKey: "k", draft: "half" });
    const messages = [{ id: "u", role: "user" as const, text: "go", createdAt: 1 }];
    useAgentStore.getState().loadChat({
      version: 1, id: "c-old", title: "go", createdAt: 1, updatedAt: 2, provider: "claude-code", aiChoice: "claude-code-sonnet-5-5",
      messages, history: [{ claudeCodeSession: "s1" }],
    });
    expect(useAgentStore.getState()).toMatchObject({
      chatId: "c-old", messages, history: [{ claudeCodeSession: "s1" }], historyProvider: "claude-code", jobId: null, sessionKey: null, draft: "",
    });
  });
});
