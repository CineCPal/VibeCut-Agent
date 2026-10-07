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
  onSidecarEvent: vi.fn(async (h: (p: SidecarEventPayload) => void) => ((handlers.event = h), () => undefined)),
  onSidecarExit: vi.fn(async (h: (p: SidecarExitPayload) => void) => ((handlers.exit = h), () => undefined)),
}));
vi.mock("../ipc", () => ipc);

import { newConversation, sendUserMessage, startAgentService, stopTurn } from "./controller";
import { useAgentStore } from "../../store/useAgentStore";
import { initialHosts, useNleStateStore } from "../../store/useNleStateStore";
import { useSidecarStore } from "../../store/useSidecarStore";
import { useSystemStore } from "../../store/useSystemStore";

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
    useAgentStore.setState({ messages: [], status: "idle", statusDetail: null, aiChoice: "gemini", jobId: null, sessionKey: null, history: [], historyProvider: null, activity: null });
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
});
