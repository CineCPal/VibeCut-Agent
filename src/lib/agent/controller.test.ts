import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SidecarEventPayload, SidecarExitPayload } from "../../types/sidecar";
import { nleState } from "../../test/nleFixtures";

const handlers = vi.hoisted(() => ({
  event: null as ((p: SidecarEventPayload) => void) | null,
  exit: null as ((p: SidecarExitPayload) => void) | null,
}));
const ipc = vi.hoisted(() => ({
  startSidecar: vi.fn(),
  sendToSidecar: vi.fn(),
  cancelSidecar: vi.fn(),
  nleCall: vi.fn(),
  saveChatAttachment: vi.fn(async () => undefined),
  loadChatAttachment: vi.fn(async () => ({ mime: "image/png", data: "QUJD" })),
  onSidecarEvent: vi.fn(async (h: (p: SidecarEventPayload) => void) => ((handlers.event = h), () => undefined)),
  onSidecarExit: vi.fn(async (h: (p: SidecarExitPayload) => void) => ((handlers.exit = h), () => undefined)),
}));
vi.mock("../ipc", () => ipc);

import {
  cancelEditing,
  editQueued,
  newConversation,
  resumeQueue,
  runChatTool,
  DECLINED_ERROR,
  submitMessage,
  warmUp,
  retryLastTurn,
  rewindBlockReason,
  rewindLastTurn,
  sendEditedMessage,
  sendUserMessage,
  startAgentService,
  startEditingLastMessage,
  stopTurn,
  TOOL_DETAIL_CHARS,
  toolDetail,
} from "./controller";
import { useEditLogStore } from "../../store/useEditLogStore";
import { describeTiming, useTurnTimingStore } from "./turnTiming";
import { answerReview } from "./review";
import { clearAttachmentCache } from "./attachments";
import type { PendingImage } from "../../types/agent";
import { useMcpStore } from "../../store/useMcpStore";
import type { EditEntry } from "../../types/edits";
import { useAgentStore } from "../../store/useAgentStore";
import { initialHosts, useNleStateStore } from "../../store/useNleStateStore";
import { useSidecarStore } from "../../store/useSidecarStore";
import { useSystemStore } from "../../store/useSystemStore";
import { useUsageStore } from "../../store/useUsageStore";

const TIMELINE = {
  project: "Doc",
  timeline: "Main",
  fps: 25,
  startTimecode: "01:00:00:00",
  duration: 10,
  isCurrent: true,
  tracks: [],
  markers: [],
};

const agent = () => useAgentStore.getState();
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
const event = (e: Record<string, unknown>) => handlers.event?.({ jobId: agent().jobId!, command: "chat", event: e as never });

describe("agent controller", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    ipc.startSidecar.mockResolvedValue(undefined);
    ipc.sendToSidecar.mockResolvedValue(undefined);
    ipc.cancelSidecar.mockResolvedValue(undefined);
    ipc.nleCall.mockImplementation(async (_host: string, command: string) => {
      if (command === "read_timeline") return TIMELINE;
      if (command === "add_markers") return { added: [{ id: "f25", time: 1, name: "Hook" }], alreadyThere: [], refusedAt: [] };
      throw new Error(`unexpected ${command}`);
    });
    const hosts = initialHosts();
    hosts.resolve = nleState("resolve");
    hosts.premiere = nleState("premiere", { status: "disconnected" });
    useNleStateStore.setState({ hosts, preferredHost: "auto" });
    useSidecarStore.setState({ session: { state: "ready", version: "0.1.0", python: "3.14.0", message: null } });
    useSystemStore.setState({ keys: { gemini: true, anthropic: true, geminiSource: "keychain", anthropicSource: "keychain", huggingface: false, huggingfaceSource: null } });
    useAgentStore.setState({ messages: [], status: "idle", statusDetail: null, aiChoice: "gemini", jobId: null, sessionKey: null, history: [], historyProvider: null, activity: null, lastTurn: null, editingMessageId: null, draft: "", draftMentions: [], queue: [], queuePaused: false, reviewEdits: false });
    useEditLogStore.setState({ entries: [], backups: {}, restoredIds: { premiere: {}, resolve: {} } });
    useMcpStore.setState({ outsideRunning: 0 });
    useUsageStore.setState({ plan: null, planAt: null, days: {}, chats: {} });
    ipc.saveChatAttachment.mockResolvedValue(undefined);
    ipc.loadChatAttachment.mockResolvedValue({ mime: "image/png", data: "QUJD" });
    clearAttachmentCache();
    startAgentService();
    await flush();
  });

  it("starts a chat job with the snapshot, the editor's tools and no key", async () => {
    await sendUserMessage("  mark the hook  ");
    expect(ipc.nleCall).toHaveBeenCalledWith("resolve", "read_timeline", { timeline: "Main" });
    const [jobId, command, request] = ipc.startSidecar.mock.calls[0];
    expect(command).toBe("chat");
    expect(jobId).toBe(agent().jobId);
    expect(request.provider).toBe("gemini");
    expect(request.model).toBeUndefined();
    expect(request.apiKey).toBeUndefined();
    expect(request.userMessage).toMatch(/^\[Resolve timeline "Main" in project "Doc"/);
    expect(request.userMessage.endsWith("\n\nmark the hook")).toBe(true);
    expect(request.toolDeclarations.map((t: { name: string }) => t.name)).toContain("add_markers");
    expect(request.systemInstruction).toContain("DaVinci Resolve");
    expect(agent().messages[0]).toMatchObject({ role: "user", text: "mark the hook" });
    expect(agent().status).toBe("thinking");
  });

  it("runs tool calls in order, answers each, and ends the turn on the result", async () => {
    await sendUserMessage("mark the hook");
    event({ type: "tool_calls", calls: [
      { id: "t1", name: "add_markers", args: { markers: [{ time: 1, name: "Hook" }] } },
      { id: "t2", name: "remove_everything", args: {} },
    ] }); // prettier-ignore
    await flush();
    expect(ipc.sendToSidecar).toHaveBeenNthCalledWith(1, agent().jobId, {
      type: "tool_result",
      id: "t1",
      result: { added: [{ id: "f25", time: 1, name: "Hook" }], alreadyThere: [], refusedAt: [] },
    });
    expect(ipc.sendToSidecar).toHaveBeenNthCalledWith(2, agent().jobId, { type: "tool_result", id: "t2", result: { error: "Unknown tool: remove_everything" } });
    expect(agent().messages.filter((m) => m.role === "tool").map((m) => m.text)).toEqual([
      'Added 1 marker(s) in Resolve: "Hook" at 1.0s',
      "Unknown tool remove_everything",
    ]);

    event({ type: "result", text: "Marked the hook at 1 s.", history: [{ role: "user" }], usage: { steps: 2 } });
    expect(agent()).toMatchObject({ status: "idle", history: [{ role: "user" }], historyProvider: "gemini", activity: null });
    expect(agent().messages.at(-1)).toMatchObject({ role: "assistant", text: "Marked the hook at 1 s." });
    expect(agent().usage?.steps).toBe(2);
  });

  it("shows each tool call as a card: running, then done or failed with its result (Phase 8f)", async () => {
    let finish: (value: unknown) => void = () => undefined;
    ipc.nleCall.mockImplementation(async (_host: string, command: string) => {
      if (command === "read_timeline") return TIMELINE;
      if (command === "add_markers") return new Promise((resolve) => (finish = resolve));
      throw new Error(`unexpected ${command}`);
    });
    await sendUserMessage("mark the hook");
    event({ type: "tool_calls", calls: [
      { id: "t1", name: "add_markers", args: { markers: [{ time: 1, name: "Hook" }] } },
      { id: "t2", name: "remove_everything", args: {} },
    ] }); // prettier-ignore
    await vi.waitFor(() => expect(agent().messages.at(-1)?.tool?.state).toBe("running"));
    expect(agent().messages.at(-1)).toMatchObject({ role: "tool", text: "Running add_markers…", tool: { name: "add_markers" } });
    expect(JSON.parse(agent().messages.at(-1)!.tool!.args)).toEqual({ markers: [{ time: 1, name: "Hook" }] });

    finish({ added: [{ id: "f25", time: 1, name: "Hook" }], alreadyThere: [], refusedAt: [] });
    await vi.waitFor(() => expect(ipc.sendToSidecar).toHaveBeenCalledTimes(2));
    const [first, second] = agent().messages.filter((m) => m.role === "tool");
    expect(first.tool).toMatchObject({ state: "done" });
    expect(JSON.parse(first.tool!.result!)).toMatchObject({ added: [{ id: "f25" }] });
    expect(second).toMatchObject({ text: "Unknown tool remove_everything", tool: { state: "failed" } });
  });

  it("adds no card for a call refused after Stop, and cuts long details", async () => {
    await sendUserMessage("go");
    await stopTurn();
    event({ type: "tool_calls", calls: [{ id: "t1", name: "add_markers", args: {} }] });
    await vi.waitFor(() => expect(ipc.sendToSidecar).toHaveBeenCalledWith(agent().jobId, expect.objectContaining({ type: "tool_result" })));
    expect(agent().messages.filter((m) => m.role === "tool")).toEqual([]);
    const long = toolDetail({ text: "x".repeat(TOOL_DETAIL_CHARS * 2) });
    expect(long.length).toBeLessThan(TOOL_DETAIL_CHARS + 80);
    expect(long).toMatch(/more characters not kept\)$/);
  });

  it("sends a follow-up to the same job with the history", async () => {
    await sendUserMessage("first");
    const jobId = agent().jobId;
    event({ type: "result", text: "ok", history: ["h1"] });
    await sendUserMessage("second");
    expect(ipc.startSidecar).toHaveBeenCalledTimes(1);
    expect(ipc.sendToSidecar).toHaveBeenCalledWith(jobId, expect.objectContaining({ type: "user_message", history: ["h1"] }));
  });

  it("starts over with a new job and empty history when the provider changes", async () => {
    await sendUserMessage("first");
    const first = agent().jobId;
    event({ type: "result", text: "ok", history: ["gemini-history"] });
    useAgentStore.getState().setAiChoice("claude-sonnet-5-5");
    await sendUserMessage("second");
    expect(ipc.sendToSidecar).toHaveBeenCalledWith(first, { type: "end_session" });
    const request = ipc.startSidecar.mock.calls[1][2];
    expect(request).toMatchObject({ provider: "claude", model: "claude-sonnet-5-5", history: [] });
  });

  it("runs Claude (subscription) with no key, its model, and Claude Code's session as history", async () => {
    useSystemStore.setState({
      keys: { gemini: false, anthropic: false, geminiSource: null, anthropicSource: null, huggingface: false, huggingfaceSource: null },
      claudeCode: { program: "/u/.local/bin/claude", programSaved: null, configDir: null, signedIn: true, email: null, subscription: "pro", detail: null },
    });
    useAgentStore.getState().setAiChoice("claude-code-opus-5-5");
    await sendUserMessage("mark the hook");
    const [, command, request] = ipc.startSidecar.mock.calls[0];
    expect(command).toBe("chat");
    expect(request).toMatchObject({ provider: "claude-code", model: "claude-opus-5-5", history: [] });
    expect(request.apiKey).toBeUndefined();
    expect(request.claudeCode).toBeUndefined();
    expect(agent().activity).toBe("Calling Claude (subscription)…");
    event({ type: "result", text: "Marked.", history: [{ claudeCodeSession: "s1" }], usage: { steps: 2 } });
    expect(agent()).toMatchObject({ status: "idle", history: [{ claudeCodeSession: "s1" }], historyProvider: "claude-code" });
  });

  it("sends Settings' effort for a Claude model and starts a new job when it changes (Phase 9a)", async () => {
    useAgentStore.getState().setAiChoice("claude-opus-5-5");
    await sendUserMessage("first");
    expect(ipc.startSidecar.mock.calls[0][2]).toMatchObject({ provider: "claude", effort: "medium" });
    event({ type: "result", text: "ok", history: ["h1"] });
    useAgentStore.getState().setEffort("opus", "max");
    await sendUserMessage("second");
    expect(ipc.startSidecar).toHaveBeenCalledTimes(2);
    expect(ipc.startSidecar.mock.calls[1][2]).toMatchObject({ effort: "max", history: ["h1"] });
    useAgentStore.getState().setEffort("opus", "medium");
  });

  it("sends Gemini (subscription) its own effort, and no Claude one (Phase 17)", async () => {
    useAgentStore.getState().setAiChoice("antigravity-gemini-3.8-flash");
    useAgentStore.getState().setAntigravityEffort("high");
    await sendUserMessage("go");
    expect(ipc.startSidecar.mock.calls[0][2]).toMatchObject({ provider: "antigravity", model: "gemini-3.8-flash", effort: "high" });
    useAgentStore.getState().setAntigravityEffort("medium");
    useAgentStore.getState().setAiChoice("gemini");
  });

  it("gives Gemini no effort", async () => {
    await sendUserMessage("go");
    expect(ipc.startSidecar.mock.calls[0][2].effort).toBeUndefined();
  });

  it("keeps the plan's limits and counts each turn's tokens and cost (Phase 9b)", async () => {
    useAgentStore.getState().setAiChoice("claude-sonnet-5-5");
    await sendUserMessage("go");
    event({ type: "rate_limit", limits: { status: "allowed", fiveHour: { used: 0.42, resetsAt: 1791382200 }, weekly: { used: "lots" } } });
    expect(useUsageStore.getState().plan).toEqual({ status: "allowed", fiveHour: { used: 0.42, resetsAt: 1791382200 } });
    event({ type: "result", text: "ok", history: [], usage: { promptTokens: 1_000_000, cachedTokens: 0, outputTokens: 100_000, thoughtsTokens: 0, steps: 1 } });
    const chat = useUsageStore.getState().chats[agent().chatId];
    expect(chat).toMatchObject({ turns: 1, promptTokens: 1_000_000, outputTokens: 100_000 });
    expect(chat.costUsd).toBeCloseTo(3);
  });

  it("stops a turn and reports it", async () => {
    await sendUserMessage("go");
    await stopTurn();
    expect(agent().status).toBe("stopping");
    expect(ipc.sendToSidecar).toHaveBeenCalledWith(agent().jobId, { type: "abort_turn" });
    event({ type: "result", text: "", history: [], aborted: true });
    expect(agent().messages.at(-1)).toMatchObject({ role: "error", text: "Stopped." });
    expect(agent().status).toBe("idle");
  });

  it("ends the session on an error or an unexpected exit", async () => {
    await sendUserMessage("go");
    event({ type: "error", message: "Gemini API returned HTTP 401" });
    expect(agent()).toMatchObject({ jobId: null, status: "idle" });
    expect(agent().messages.at(-1)).toMatchObject({ role: "error", text: "Gemini API returned HTTP 401" });

    await sendUserMessage("again");
    handlers.exit?.({ jobId: agent().jobId!, code: 1, cancelled: false, message: "Traceback: boom" });
    expect(agent().messages.at(-1)).toMatchObject({ role: "error", text: "Traceback: boom" });
    expect(agent().jobId).toBeNull();
  });

  it("reports a job that couldn't start, such as a missing key", async () => {
    ipc.startSidecar.mockRejectedValue(new Error("ANTHROPIC_API_KEY is not set."));
    await sendUserMessage("go");
    expect(agent().messages.at(-1)).toMatchObject({ role: "error", text: "ANTHROPIC_API_KEY is not set." });
    expect(agent()).toMatchObject({ jobId: null, status: "idle" });
  });

  it("works with no editor: no tools, and the snapshot says so", async () => {
    useNleStateStore.setState({ hosts: initialHosts() });
    await sendUserMessage("hello");
    const request = ipc.startSidecar.mock.calls[0][2];
    expect(request.toolDeclarations).toEqual([]);
    expect(request.userMessage).toMatch(/^\[No editor connected/);
    expect(ipc.nleCall).not.toHaveBeenCalled();
  });

  it("new chat ends the job and clears the conversation", async () => {
    await sendUserMessage("go");
    const jobId = agent().jobId;
    event({ type: "result", text: "ok", history: ["h"] });
    await newConversation();
    expect(ipc.sendToSidecar).toHaveBeenCalledWith(jobId, { type: "end_session" });
    expect(agent()).toMatchObject({ messages: [], history: [], jobId: null });
  });

  it("ignores messages unless idle, and events from other jobs", async () => {
    useAgentStore.setState({ status: "offline" });
    await sendUserMessage("go");
    expect(ipc.startSidecar).not.toHaveBeenCalled();
    useAgentStore.setState({ status: "idle" });
    await sendUserMessage("go");
    handlers.event?.({ jobId: "someone-else", command: "chat", event: { type: "result", text: "nope", history: [] } });
    expect(agent().status).toBe("thinking");
  });

  describe("streamed replies (Phase 8b)", () => {
    const assistants = () => agent().messages.filter((m) => m.role === "assistant");

    it("writes deltas into one live message and the result replaces its text", async () => {
      await sendUserMessage("go");
      event({ type: "reply_delta", text: "Hel" });
      event({ type: "reply_delta", text: "lo" });
      expect(assistants()).toHaveLength(1);
      expect(assistants()[0]).toMatchObject({ text: "Hello", status: "pending" });
      event({ type: "result", text: "Hello.", history: ["h"] });
      expect(assistants()).toHaveLength(1);
      expect(assistants()[0]).toMatchObject({ text: "Hello.", status: "done" });
      expect(agent().status).toBe("idle");
    });

    it("keeps text said before a tool call as its own message, ahead of the tool line", async () => {
      await sendUserMessage("mark the hook");
      event({ type: "reply_delta", text: "Let me look." });
      event({ type: "reply_break" });
      event({ type: "tool_calls", calls: [{ id: "a", name: "add_markers", args: { markers: [{ time: 1, name: "Hook" }] } }] });
      await vi.waitFor(() => expect(ipc.sendToSidecar).toHaveBeenCalled());
      event({ type: "reply_delta", text: "Marked." });
      event({ type: "result", text: "Marked.", history: [] });
      const roles = agent().messages.map((m) => `${m.role}:${m.status ?? ""}`);
      expect(roles).toEqual(["user:done", "assistant:done", "tool:", "assistant:done"]);
      expect(assistants().map((m) => m.text)).toEqual(["Let me look.", "Marked."]);
    });

    it("drops the live text on a reset, and a break with nothing said leaves nothing", async () => {
      await sendUserMessage("go");
      event({ type: "reply_delta", text: "Half" });
      event({ type: "reply_reset" });
      expect(assistants()).toHaveLength(0);
      event({ type: "reply_break" });
      event({ type: "reply_delta", text: "Whole." });
      event({ type: "result", text: "Whole.", history: [] });
      expect(assistants().map((m) => m.text)).toEqual(["Whole."]);
    });

    it("keeps what was written before Stop, then says it stopped", async () => {
      await sendUserMessage("go");
      event({ type: "reply_delta", text: "I'll trim the" });
      await stopTurn();
      event({ type: "result", text: "Stopped by the user.", history: [], aborted: true });
      const tail = agent().messages.slice(1).map((m) => [m.role, m.text, m.status]);
      expect(tail).toEqual([
        ["assistant", "I'll trim the", "done"],
        ["error", "Stopped.", undefined],
        ["assistant", "Stopped by the user.", undefined],
      ]);
    });

    it("leaves a half-written reply as it stood when the job fails", async () => {
      await sendUserMessage("go");
      event({ type: "reply_delta", text: "Partly" });
      event({ type: "error", message: "boom" });
      expect(assistants()[0]).toMatchObject({ text: "Partly", status: "done" });
      expect(agent().messages.at(-1)).toMatchObject({ role: "error", text: "boom" });
    });
  });

  describe("images (Phase 8g)", () => {
    const image = (id: string): PendingImage => ({ id, name: `${id}.png`, mime: "image/png", width: 4, height: 3, bytes: 3, data: "QUJD", dataUrl: "data:image/png;base64,QUJD" });

    it("files the images beside the chat, then sends them with the message", async () => {
      useAgentStore.setState({ chatId: "chat-1" });
      expect(await sendUserMessage("", [image("i1")])).toBe(true);
      expect(ipc.saveChatAttachment).toHaveBeenCalledWith("chat-1", "i1", "image/png", "QUJD");
      expect(agent().messages[0]).toMatchObject({ role: "user", text: "(image)", attachments: [{ id: "i1", name: "i1.png", width: 4, height: 3, bytes: 3 }] });
      expect(agent().messages[0].attachments![0]).not.toHaveProperty("data");
      expect(ipc.startSidecar.mock.calls[0][2]).toMatchObject({ attachments: [{ mime: "image/png", data: "QUJD" }] });

      event({ type: "result", text: "A frame.", history: ["h1"] });
      await sendUserMessage("and this?", [image("i2")]);
      expect(ipc.sendToSidecar).toHaveBeenCalledWith(agent().jobId, expect.objectContaining({ type: "user_message", attachments: [{ mime: "image/png", data: "QUJD" }] }));
      event({ type: "result", text: "Another.", history: ["h1", "h2"] });
      await sendUserMessage("no image");
      expect(ipc.sendToSidecar.mock.calls.at(-1)?.[1]).not.toHaveProperty("attachments");
    });

    it("sends nothing when the images can't be kept, and says so", async () => {
      ipc.saveChatAttachment.mockRejectedValueOnce(new Error("disk full"));
      expect(await sendUserMessage("look", [image("i1")])).toBe(false);
      expect(agent().messages).toEqual([expect.objectContaining({ role: "error", text: "Couldn't keep the image to send: disk full" })]);
      expect(agent().status).toBe("idle");
      expect(ipc.startSidecar).not.toHaveBeenCalled();
    });

    it("retry sends the images again, read back from beside the chat", async () => {
      useAgentStore.setState({ chatId: "chat-1" });
      await sendUserMessage("what's this?", [image("i1")]);
      event({ type: "result", text: "A frame.", history: ["h1"] });
      clearAttachmentCache();
      ipc.sendToSidecar.mockClear();
      await retryLastTurn();
      expect(ipc.loadChatAttachment).toHaveBeenCalledWith("chat-1", "i1");
      expect(ipc.sendToSidecar).toHaveBeenCalledWith(agent().jobId, expect.objectContaining({ userMessage: expect.stringContaining("what's this?"), attachments: [{ mime: "image/png", data: "QUJD" }] }));
      expect(agent().messages.filter((m) => m.role === "user")).toHaveLength(1);
    });

    it("editing puts the message's images back in the composer", async () => {
      useAgentStore.setState({ chatId: "chat-1" });
      await sendUserMessage("", [image("i1")]);
      event({ type: "result", text: "A frame.", history: ["h1"] });
      expect(startEditingLastMessage()).toBe(true);
      expect(agent().draft).toBe("");
      await vi.waitFor(() => expect(agent().pendingImages.map((i) => i.id)).toEqual(["i1"]));
      cancelEditing();
      expect(agent().pendingImages).toEqual([]);
    });
  });

  describe("Retry and Edit (Phase 8c)", () => {
    const edit = (id: string, step: string): EditEntry => ({
      id,
      step,
      stepText: "go",
      at: 1,
      host: "resolve",
      timeline: "Main",
      tool: "delete_clips",
      summary: `edit ${id}`,
      backup: "Main (before VibeCut 1)",
      changes: [{ kind: "deleted", name: "A.mov", itemId: "v1" }],
    });
    const userText = () => agent().messages.filter((m) => m.role === "user").map((m) => m.text);

    /** Two turns on Gemini: the second started from ["h1"] and ended with ["h1", "h2"]. */
    async function twoTurns() {
      await sendUserMessage("first");
      event({ type: "result", text: "one", history: ["h1"] });
      await sendUserMessage("second");
      event({ type: "result", text: "two", history: ["h1", "h2"] });
    }

    it("remembers the history each message was sent with", async () => {
      await twoTurns();
      expect(agent().lastTurn).toMatchObject({ history: ["h1"], historyProvider: "gemini" });
      expect(agent().messages.find((m) => m.id === agent().lastTurn?.userMessageId)?.text).toBe("second");
    });

    it("retry takes the last turn back and sends it again from where it started", async () => {
      await twoTurns();
      const jobId = agent().jobId;
      ipc.sendToSidecar.mockClear();
      await retryLastTurn();
      expect(userText()).toEqual(["first", "second"]);
      expect(agent().messages.map((m) => m.text)).toEqual(["first", "one", "second"]);
      const [sentTo, message] = ipc.sendToSidecar.mock.calls[0];
      expect(sentTo).toBe(jobId);
      expect(message).toMatchObject({ type: "user_message", history: ["h1"] });
      expect(message.userMessage.endsWith("\n\nsecond")).toBe(true);
    });

    it("an edited message replaces the last one", async () => {
      await twoTurns();
      expect(startEditingLastMessage()).toBe(true);
      expect(agent()).toMatchObject({ draft: "second" });
      await sendEditedMessage("second, but shorter");
      expect(userText()).toEqual(["first", "second, but shorter"]);
      expect(agent().editingMessageId).toBeNull();
      cancelEditing();
    });

    it("Claude Code goes back to the session the turn forked from", async () => {
      useAgentStore.setState({ aiChoice: "claude-code-sonnet-5-5" });
      await sendUserMessage("first");
      event({ type: "result", text: "one", history: [{ claudeCodeSession: "s1" }] });
      await sendUserMessage("second");
      event({ type: "result", text: "two", history: [{ claudeCodeSession: "s2" }] });
      ipc.sendToSidecar.mockClear();
      await retryLastTurn();
      expect(ipc.sendToSidecar.mock.calls[0][1]).toMatchObject({ history: [{ claudeCodeSession: "s1" }] });
    });

    it("reverts the turn's edits first, and says so", async () => {
      await twoTurns();
      useEditLogStore.setState({ entries: [edit("e1", agent().lastTurn!.userMessageId)] });
      ipc.nleCall.mockImplementation(async (_h: string, command: string) => {
        if (command === "read_timeline") return TIMELINE;
        if (command === "revert_timeline_changes") return { reverted: [{ kind: "deleted", name: "A.mov" }], changedSince: [], failed: [], lost: [], restoredIds: {} };
        throw new Error(`unexpected ${command}`);
      });
      const text = await rewindLastTurn();
      expect(text).toBe("second");
      expect(useEditLogStore.getState().entries[0].reverted).toBeTruthy();
      expect(agent().messages.at(-1)).toMatchObject({ role: "tool", text: "Reverted 1 timeline change" });
    });

    it("leaves the conversation alone when an edit couldn't be fully undone", async () => {
      await twoTurns();
      useEditLogStore.setState({ entries: [edit("e1", agent().lastTurn!.userMessageId)] });
      ipc.nleCall.mockImplementation(async (_h: string, command: string) => {
        if (command === "revert_timeline_changes")
          return { reverted: [], changedSince: [{ name: "A.mov", reason: "it was changed since" }], failed: [], lost: [], restoredIds: {} };
        throw new Error(`unexpected ${command}`);
      });
      await expect(rewindLastTurn()).rejects.toThrow(/Not every edit/);
      expect(userText()).toEqual(["first", "second"]);
      expect(agent().messages.at(-1)).toMatchObject({ role: "tool" });
    });

    it("refuses while busy, during outside calls, or when later edits would be reverted instead", async () => {
      expect(rewindBlockReason()).toMatch(/no message/);
      await twoTurns();
      expect(rewindBlockReason()).toBeNull();
      useMcpStore.setState({ outsideRunning: 1 });
      expect(rewindBlockReason()).toMatch(/outside/);
      useMcpStore.setState({ outsideRunning: 0 });
      useEditLogStore.setState({ entries: [edit("e1", agent().lastTurn!.userMessageId), edit("e2", "broll-place")] });
      expect(rewindBlockReason()).toMatch(/revert those first/);
      expect(startEditingLastMessage()).toBe(false);
      useAgentStore.setState({ status: "thinking" });
      expect(rewindBlockReason()).toMatch(/Finish or stop/);
    });

    it("a new chat has nothing to take back", async () => {
      await twoTurns();
      await newConversation();
      expect(agent().lastTurn).toBeNull();
    });
  });

  describe("the queue (Phase 11b)", () => {
    const sentTexts = () => agent().messages.filter((m) => m.role === "user").map((m) => m.text);

    it("queues while a turn runs and sends each in order as turns end", async () => {
      expect(await submitMessage("first")).toBe("sent");
      expect(await submitMessage("second")).toBe("queued");
      expect(await submitMessage("third")).toBe("queued");
      expect(sentTexts()).toEqual(["first"]);
      event({ type: "result", text: "One.", history: [] });
      await vi.waitFor(() => expect(sentTexts()).toEqual(["first", "second"]));
      expect(agent().queue.map((m) => m.text)).toEqual(["third"]);
      event({ type: "result", text: "Two.", history: [] });
      await vi.waitFor(() => expect(sentTexts()).toEqual(["first", "second", "third"]));
      expect(agent().queue).toEqual([]);
    });

    it("holds the queue after a Stop or an error until Send next", async () => {
      await submitMessage("first");
      await submitMessage("second");
      await stopTurn();
      expect(agent().queuePaused).toBe(true);
      event({ type: "result", text: "", aborted: true, history: [] });
      await flush();
      expect(sentTexts()).toEqual(["first"]);
      resumeQueue();
      await vi.waitFor(() => expect(sentTexts()).toEqual(["first", "second"]));
      event({ type: "error", message: "boom" });
      expect(agent().queue).toEqual([]);
    });

    it("holds at most five, waits for outside edits, and a new chat clears it", async () => {
      await submitMessage("first");
      for (let i = 0; i < 5; i++) expect(await submitMessage(`q${i}`)).toBe("queued");
      expect(await submitMessage("one too many")).toBe(false);
      useMcpStore.setState({ outsideRunning: 1 });
      event({ type: "result", text: "One.", history: [] });
      await flush();
      expect(sentTexts()).toEqual(["first"]);
      useMcpStore.setState({ outsideRunning: 0 });
      await vi.waitFor(() => expect(sentTexts()).toEqual(["first", "q0"]));
      event({ type: "result", text: "Two.", history: [] });
      await flush();
      useAgentStore.setState({ status: "idle" });
      await newConversation();
      expect(agent().queue).toEqual([]);
    });

    it("takes a queued message back to edit only into an empty box", async () => {
      await submitMessage("first");
      await submitMessage("second");
      const id = agent().queue[0].id;
      useAgentStore.setState({ draft: "typing" });
      expect(editQueued(id)).toBe(false);
      useAgentStore.setState({ draft: "" });
      expect(editQueued(id)).toBe(true);
      expect(agent().draft).toBe("second");
      expect(agent().queue).toEqual([]);
    });
  });

  describe("@-mentions (Phase 11c)", () => {
    const shot = { kind: "clip" as const, label: "Interview A", ref: "c7", detail: "V1 1.0s–5.0s" };

    it("tells the model what was pointed at, and keeps only the mentions still in the text", async () => {
      await sendUserMessage("Trim @Interview A", [], [shot, { kind: "timeline", label: "Gone", ref: "Gone" }]);
      const request = ipc.startSidecar.mock.calls[0][2];
      expect(request.userMessage).toContain('[MENTIONED: what the user pointed at with @ in this message]\n- @Interview A = clip id "c7" (V1 1.0s–5.0s)\n\nTrim @Interview A');
      expect(request.userMessage).not.toContain("Gone");
      expect(agent().messages[0].mentions).toEqual([shot]);
    });

    it("Retry sends the mentions again", async () => {
      await sendUserMessage("Trim @Interview A", [], [shot]);
      event({ type: "result", text: "Done.", history: [] });
      await retryLastTurn();
      expect(ipc.sendToSidecar.mock.calls.at(-1)?.[1].userMessage).toContain("- @Interview A = clip id");
    });
  });

  describe("faster first token (Phase 11f)", () => {
    it("a warm-up starts the job without a message, and the message then goes to it", async () => {
      warmUp();
      warmUp();
      expect(ipc.startSidecar).toHaveBeenCalledTimes(1);
      const [jobId, , request] = ipc.startSidecar.mock.calls[0];
      expect(request.userMessage).toBeUndefined();
      expect(request.toolDeclarations.length).toBeGreaterThan(0);
      await sendUserMessage("hello");
      expect(ipc.startSidecar).toHaveBeenCalledTimes(1);
      expect(ipc.sendToSidecar).toHaveBeenCalledWith(jobId, expect.objectContaining({ type: "user_message", userMessage: expect.stringMatching(/\n\nhello$/) }));
    });

    it("doesn't warm up while busy or with a job running", async () => {
      await sendUserMessage("hello");
      warmUp();
      expect(ipc.startSidecar).toHaveBeenCalledTimes(1);
    });

    it("reads the pool and the timeline side by side", async () => {
      const order: string[] = [];
      ipc.nleCall.mockImplementation(async (_host: string, command: string) => {
        order.push(`start ${command}`);
        await flush();
        order.push(`end ${command}`);
        if (command === "read_timeline") return TIMELINE;
        if (command === "read_media_pool") return { bins: [], clips: [], timelines: [], truncated: false, selection: { timeline: [], pool: [] } };
        throw new Error(`unexpected ${command}`);
      });
      await sendUserMessage("hello");
      expect(order.slice(0, 2)).toEqual(["start read_media_pool", "start read_timeline"]);
    });

    it("times the turn to its first words", async () => {
      await sendUserMessage("hello");
      event({ type: "status", detail: "Calling Gemini…" });
      event({ type: "reply_delta", text: "Hi" });
      const last = useTurnTimingStore.getState().last;
      expect(last?.warm).toBe(false);
      expect(Object.keys(last?.marks ?? {}).sort()).toEqual(["context", "firstWords", "sent", "status"]);
      expect(describeTiming(last!)).toMatch(/^first words \d+\.\d s · timeline read/);
    });
  });

  describe("Review edits first (Phase 11d)", () => {
    const cards = () => agent().messages.filter((m) => m.tool);
    const markerCall = { id: "t1", name: "add_markers", args: { markers: [{ time: 1, name: "Hook" }] } };

    beforeEach(() => useAgentStore.setState({ reviewEdits: true }));

    it("a change waits on its card; Apply runs it", async () => {
      await sendUserMessage("mark the hook");
      event({ type: "tool_calls", calls: [markerCall] });
      await flush();
      expect(cards()[0]).toMatchObject({ text: "Add markers (1)", tool: { state: "pending" } });
      expect(ipc.nleCall).not.toHaveBeenCalledWith("resolve", "add_markers", expect.anything());
      expect(answerReview(cards()[0].id, "apply")).toBe(true);
      await vi.waitFor(() => expect(cards()[0].tool?.state).toBe("done"));
      expect(ipc.sendToSidecar).toHaveBeenCalledWith(agent().jobId, expect.objectContaining({ type: "tool_result", id: "t1", result: expect.objectContaining({ added: expect.any(Array) }) }));
    });

    it("Skip tells the model the user declined, and nothing is run", async () => {
      await sendUserMessage("mark the hook");
      event({ type: "tool_calls", calls: [markerCall] });
      await flush();
      answerReview(cards()[0].id, "skip");
      await vi.waitFor(() => expect(cards()[0].tool?.state).toBe("declined"));
      expect(ipc.sendToSidecar).toHaveBeenCalledWith(agent().jobId, { type: "tool_result", id: "t1", result: { declined: true, error: DECLINED_ERROR } });
      expect(ipc.nleCall).not.toHaveBeenCalledWith("resolve", "add_markers", expect.anything());
    });

    it("Apply all lets the rest of that request through; reads never ask; Stop skips what waits", async () => {
      await sendUserMessage("mark twice");
      event({ type: "tool_calls", calls: [markerCall, { ...markerCall, id: "t2" }, { id: "t3", name: "list_markers", args: {} }] });
      await flush();
      answerReview(cards()[0].id, "all");
      await vi.waitFor(() => expect(cards().map((c) => c.tool?.state)).toEqual(["done", "done", expect.stringMatching(/done|failed/)]));
      event({ type: "result", text: "Done.", history: [] });

      await sendUserMessage("one more");
      event({ type: "tool_calls", calls: [{ ...markerCall, id: "t4" }] });
      await flush();
      expect(cards().at(-1)?.tool?.state).toBe("pending");
      await stopTurn();
      await vi.waitFor(() => expect(cards().at(-1)?.tool?.state).toBe("declined"));
    });

    it("with review off, changes run at once", async () => {
      useAgentStore.setState({ reviewEdits: false });
      await sendUserMessage("mark the hook");
      event({ type: "tool_calls", calls: [markerCall] });
      await vi.waitFor(() => expect(cards()[0].tool?.state).toBe("done"));
    });

    it("tells the MCP bridge to hold a call from Claude Code while it waits", async () => {
      await sendUserMessage("mark the hook");
      const onWait = vi.fn();
      const pending = runChatTool(agent().jobId!, "add_markers", markerCall.args, onWait);
      await flush();
      expect(onWait).toHaveBeenCalledTimes(1);
      answerReview(cards()[0].id, "apply");
      expect((await pending)?.summary).toMatch(/Added 1 marker/);
    });
  });
});
