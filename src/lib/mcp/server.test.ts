import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SidecarEventPayload, SidecarExitPayload } from "../../types/sidecar";
import { nleState } from "../../test/nleFixtures";

const ipc = vi.hoisted(() => ({
  startSidecar: vi.fn(),
  sendToSidecar: vi.fn(),
  cancelSidecar: vi.fn(),
  nleCall: vi.fn(),
  onSidecarEvent: vi.fn(async (_h: (p: SidecarEventPayload) => void) => () => undefined),
  onSidecarExit: vi.fn(async (_h: (p: SidecarExitPayload) => void) => () => undefined),
  getMcpStatus: vi.fn(),
  mcpReply: vi.fn(),
  onMcpOutside: vi.fn(async () => () => undefined),
  onMcpRequest: vi.fn(async () => () => undefined),
}));
vi.mock("../ipc", () => ipc);

import { handleRequest, isReadTool, OUTSIDE_LABEL, OUTSIDE_STEP_GAP_MS } from "./server";
import { sendUserMessage, startAgentService } from "../agent/controller";
import { useAgentStore } from "../../store/useAgentStore";
import { useMcpStore } from "../../store/useMcpStore";
import { initialHosts, useNleStateStore } from "../../store/useNleStateStore";
import { useSidecarStore } from "../../store/useSidecarStore";
import { useSystemStore } from "../../store/useSystemStore";
import type { McpReply, McpRequest } from "../../types/mcp";

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
const call = (name: string, args: Record<string, unknown> = {}, caller = "outside"): Promise<McpReply> =>
  handleRequest({ id: "r1", caller, kind: "call_tool", name, args } satisfies McpRequest);
const result = (reply: McpReply) => {
  if (!reply.ok) throw new Error(`expected ok, got ${reply.error}`);
  return reply.result as Record<string, unknown>;
};

describe("MCP bridge requests", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    ipc.startSidecar.mockResolvedValue(undefined);
    ipc.sendToSidecar.mockResolvedValue(undefined);
    ipc.nleCall.mockImplementation(async (_host: string, command: string, args: Record<string, unknown>) => {
      if (command === "read_timeline") return TIMELINE;
      if (command === "list_markers") return { markers: [] };
      if (command === "add_markers") {
        const markers = args.markers as { time: number; name: string }[];
        return { added: markers.map((m) => ({ id: `f${m.time * 25}`, time: m.time, name: m.name })), alreadyThere: [], refusedAt: [] };
      }
      throw new Error(`unexpected ${command}`);
    });
    const hosts = initialHosts();
    hosts.resolve = nleState("resolve");
    hosts.premiere = nleState("premiere", { status: "disconnected" });
    useNleStateStore.setState({ hosts, preferredHost: "auto" });
    useSidecarStore.setState({ session: { state: "ready", version: "0.1.0", python: "3.14.0", message: null } });
    useSystemStore.setState({ keys: { gemini: true, anthropic: true, geminiSource: "keychain", anthropicSource: "keychain", huggingface: false, huggingfaceSource: null } });
    useAgentStore.setState({ messages: [], status: "idle", statusDetail: null, aiChoice: "gemini", jobId: null, sessionKey: null, history: [], historyProvider: null, activity: null });
    useMcpStore.setState({ outsideAllowed: true, lastOutsideAt: null, outsideRunning: 0, outsideStep: null });
    startAgentService();
    await flush();
  });

  it("lists the connected editor's own tools plus the two bridge tools", async () => {
    const tools = result(await handleRequest({ id: "r1", caller: "outside", kind: "list_tools" })).tools as { name: string }[];
    const names = tools.map((t) => t.name);
    expect(names).toContain("add_markers");
    expect(names).toContain("revert_timeline_edits");
    expect(names.slice(-2)).toEqual(["get_editor_context", "get_instructions"]);
  });

  it("lists only get_editor_context, which says why, when no editor is connected", async () => {
    useNleStateStore.setState({ hosts: initialHosts() });
    const tools = result(await handleRequest({ id: "r1", caller: "outside", kind: "list_tools" })).tools as { name: string }[];
    expect(tools.map((t) => t.name)).toEqual(["get_editor_context"]);
    expect(result(await call("get_editor_context")).context).toMatch(/No editor is connected/);
    const refused = await call("add_markers", { markers: [{ time: 1, name: "Hook" }] });
    expect(refused).toMatchObject({ ok: false, error: expect.stringMatching(/No editor is connected/) });
  });

  it("returns the chat's own snapshot and instructions", async () => {
    const context = result(await call("get_editor_context"));
    expect(context.editor).toBe("resolve");
    expect(context.context).toMatch(/^\[Resolve timeline "Main" in project "Doc"/);
    expect(ipc.nleCall).toHaveBeenCalledWith("resolve", "read_timeline", { timeline: "Main" });
    expect(result(await call("get_instructions")).instructions).toContain("DaVinci Resolve");
  });

  it("runs an outside call on the open timeline and notes it in the chat", async () => {
    const reply = await call("add_markers", { markers: [{ time: 1, name: "Hook" }] });
    expect(result(reply).added).toEqual([{ id: "f25", time: 1, name: "Hook" }]);
    expect(reply).toMatchObject({ summary: 'Added 1 marker(s) in Resolve: "Hook" at 1.0s' });
    expect(agent().messages.at(-1)).toMatchObject({ role: "tool", text: `${OUTSIDE_LABEL}: Added 1 marker(s) in Resolve: "Hook" at 1.0s` });
    expect(useMcpStore.getState().outsideRunning).toBe(0);
  });

  it("returns a failed tool as an error result the model can read", async () => {
    const reply = await call("remove_everything");
    expect(result(reply)).toEqual({ error: "Unknown tool: remove_everything" });
  });

  it("groups outside calls into one step until a pause", async () => {
    await call("list_markers");
    const first = useMcpStore.getState().outsideStep!.id;
    await call("list_markers");
    expect(useMcpStore.getState().outsideStep!.id).toBe(first);
    useMcpStore.setState({ outsideStep: { id: first, lastAt: Date.now() - OUTSIDE_STEP_GAP_MS - 1 } });
    await call("list_markers");
    expect(useMcpStore.getState().outsideStep!.id).not.toBe(first);
    expect(first).toMatch(/^outside-/);
  });

  it("refuses outside edits while the in-app chat is working, but lets reads through", async () => {
    useAgentStore.setState({ status: "thinking" });
    expect(await call("add_markers", { markers: [{ time: 1, name: "Hook" }] })).toMatchObject({ ok: false, error: expect.stringMatching(/own chat is working/) });
    expect(result(await call("list_markers"))).toEqual({ markers: [] });
    expect(ipc.nleCall).not.toHaveBeenCalledWith("resolve", "add_markers", expect.anything());
  });

  it("runs outside calls one at a time, in order", async () => {
    const order: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    ipc.nleCall.mockImplementation(async (_host: string, _command: string, args: Record<string, unknown>) => {
      const markers = args.markers as { time: number; name: string }[];
      order.push(`start ${markers[0].name}`);
      if (markers[0].name === "A") await gate;
      order.push(`end ${markers[0].name}`);
      return { added: [], alreadyThere: [], refusedAt: [] };
    });
    const a = call("add_markers", { markers: [{ time: 1, name: "A" }] });
    const b = call("add_markers", { markers: [{ time: 2, name: "B" }] });
    await flush();
    expect(useMcpStore.getState().outsideRunning).toBe(2);
    release();
    await Promise.all([a, b]);
    expect(order).toEqual(["start A", "end A", "start B", "end B"]);
  });

  it("runs the chat job's own calls as part of its turn, and refuses an ended chat", async () => {
    expect(await call("add_markers", {}, "gone-job")).toEqual({ ok: false, error: "That VibeCut Agent chat has ended." });
    await sendUserMessage("mark the hook");
    const jobId = agent().jobId!;
    const reply = await call("add_markers", { markers: [{ time: 1, name: "Hook" }] }, jobId);
    expect(result(reply).added).toEqual([{ id: "f25", time: 1, name: "Hook" }]);
    expect(agent().messages.at(-1)).toMatchObject({ role: "tool", text: 'Added 1 marker(s) in Resolve: "Hook" at 1.0s' });
    expect(useMcpStore.getState().outsideStep).toBeNull();
  });

  it("keeps the composer from starting a turn while an outside call runs", async () => {
    useMcpStore.setState({ outsideRunning: 1 });
    await sendUserMessage("go");
    expect(ipc.startSidecar).not.toHaveBeenCalled();
  });

  it("knows which tools only read", () => {
    for (const name of ["list_markers", "get_transcript", "find_broll", "describe_spyglass_folder", "search_media_pool", "get_editor_context", "get_instructions"]) {
      expect(isReadTool(name)).toBe(true);
    }
    for (const name of ["add_markers", "set_playhead_time", "select_clip", "revert_timeline_edits", "transcribe_clips"]) {
      expect(isReadTool(name)).toBe(false);
    }
  });
});
