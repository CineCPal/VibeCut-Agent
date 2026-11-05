import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(), convertFileSrc: (p: string) => p }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(() => Promise.resolve(() => undefined)) }));
const controller = vi.hoisted(() => ({
  submitMessage: vi.fn(),
  stopTurn: vi.fn(),
  retryLastTurn: vi.fn(),
  sendEditedMessage: vi.fn(),
  newConversation: vi.fn(),
  resumeQueue: vi.fn(),
}));
vi.mock("./agent/controller", async (original) => ({ ...(await original<typeof import("./agent/controller")>()), ...controller }));
const edits = vi.hoisted(() => ({ revertLastRequest: vi.fn() }));
vi.mock("./agent/edits", async (original) => ({ ...(await original<typeof import("./agent/edits")>()), ...edits }));
const review = vi.hoisted(() => ({ answerReview: vi.fn() }));
vi.mock("./agent/review", async (original) => ({ ...(await original<typeof import("./agent/review")>()), ...review }));
const history = vi.hoisted(() => ({ openChat: vi.fn() }));
vi.mock("./agent/chatHistory", async (original) => ({ ...(await original<typeof import("./agent/chatHistory")>()), ...history }));
const ipc = vi.hoisted(() => ({ nleCall: vi.fn() }));
vi.mock("./ipc", async (original) => ({ ...(await original<typeof import("./ipc")>()), ...ipc }));
const lib = vi.hoisted(() => ({ openLibrary: vi.fn(), placeShot: vi.fn(), importShots: vi.fn(), searchLibrary: vi.fn(), openInSourceMonitor: vi.fn() }));
vi.mock("./library", async (original) => ({ ...(await original<typeof import("./library")>()), ...lib }));
const broll = vi.hoisted(() => ({
  startAnalysis: vi.fn(),
  startMatch: vi.fn(),
  cancelJob: vi.fn(),
  placeAtPlayhead: vi.fn(),
  exportSelectsXml: vi.fn(),
  buildSelectsTimeline: vi.fn(),
}));
vi.mock("./broll", async (original) => ({ ...(await original<typeof import("./broll")>()), ...broll }));
const plan = vi.hoisted(() => ({ refreshPlan: vi.fn() }));
vi.mock("./agent/planRefresh", async (original) => ({ ...(await original<typeof import("./agent/planRefresh")>()), ...plan }));

import { buildHostAnalyzerFile, buildHostBrollFile, buildHostStateFile, handleHostChatAction, MAX_PANEL_MESSAGES } from "./hostChatBridge";
import { DEFAULT_OPTIONS, useBrollStore } from "../store/useBrollStore";
import { useConnectionStore } from "../store/useConnectionStore";
import { useSidecarStore } from "../store/useSidecarStore";
import { useUsageStore } from "../store/useUsageStore";
import { useTurnTimingStore } from "./agent/turnTiming";
import type { AnalyzeResult } from "../types/broll";
import { useAgentStore } from "../store/useAgentStore";
import { initialHosts, useNleStateStore } from "../store/useNleStateStore";
import { useMcpStore } from "../store/useMcpStore";
import { nleState } from "../test/nleFixtures";

const connectBoth = () =>
  useNleStateStore.setState({
    hosts: { ...initialHosts(), premiere: nleState("premiere", { timeline: "Main" }), resolve: nleState("resolve", { timeline: "Edit 1" }) },
    preferredHost: "auto",
  });

describe("the in-host panels' app side", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useAgentStore.getState().clear();
    useAgentStore.setState({ status: "idle", statusDetail: null, activity: null, queue: [], queuePaused: false, lastTurn: null, customTitle: null, autoTitle: null });
    useMcpStore.setState({ outsideRunning: 0 });
    connectBoth();
  });

  it("publishes the chat, the model and the editor without anything secret", () => {
    const store = useAgentStore.getState();
    store.addMessage({ role: "user", text: "Tighten the intro", attachments: [{ id: "i1", name: "a.png", mime: "image/png", width: 1, height: 1, bytes: 1 }] });
    store.addMessage({ role: "assistant", text: "Working on it", status: "pending" });
    const card = store.addMessage({ role: "tool", text: "Trim clip 3 by 2 s", tool: { name: "trim_clip", args: "{}", state: "pending" } });
    useAgentStore.setState({ customTitle: "Intro pass", reviewEdits: true });

    const file = buildHostStateFile("resolve", 42);
    expect(file).toMatchObject({ version: 2, publishedAt: 42, host: "resolve", notice: null });
    expect(file.editor).toMatchObject({ connected: true, timeline: "Edit 1", noEditor: null });
    expect(file.agent).toMatchObject({ status: "idle", reviewEdits: true, outsideRunning: false });
    expect(file.agent.choices.map((c) => c.id)).toContain("claude-code-opus-5-5");
    expect(file.chat.title).toBe("Intro pass");
    const [user, reply, tool] = file.chat.messages;
    expect(user).toMatchObject({ role: "user", imageCount: 1 });
    expect(reply).toMatchObject({ role: "assistant", status: "pending" });
    expect(tool.tool).toEqual({ id: card, name: "trim_clip", summary: "Trim clip 3 by 2 s", args: "{}", state: "pending" });
    expect(JSON.stringify(file)).not.toMatch(/api[_-]?key|access[_-]?token|refresh[_-]?token|hf_[a-z0-9]|claude-profiles|CLAUDE_CONFIG_DIR/i);
  });

  it("keeps the newest messages only, and says why an editor isn't there", () => {
    for (let i = 0; i < MAX_PANEL_MESSAGES + 5; i += 1) useAgentStore.getState().addMessage({ role: "user", text: `m${i}` });
    useNleStateStore.setState({ hosts: { ...initialHosts(), premiere: nleState("premiere") } });
    const file = buildHostStateFile("resolve");
    expect(file.chat.messages).toHaveLength(MAX_PANEL_MESSAGES);
    expect(file.chat.messages[0].text).toBe("m5");
    expect(file.editor.connected).toBe(false);
    expect(file.editor.noEditor).toBeTruthy();
    expect(buildHostBrollFile("resolve").editor.noEditor).toContain("DaVinci Resolve");
  });

  it("works on the editor whose panel sent the message", async () => {
    controller.submitMessage.mockResolvedValue("sent");
    useNleStateStore.setState({ preferredHost: "premiere" });
    await handleHostChatAction("resolve", { id: "a1", type: "send", text: "Add a dissolve" });
    expect(useNleStateStore.getState().preferredHost).toBe("resolve");
    expect(controller.submitMessage).toHaveBeenCalledWith("Add a dissolve");

    // A setting isn't an editor's: it leaves the editor alone.
    await handleHostChatAction("premiere", { id: "a2", type: "set_review_edits", on: false });
    expect(useNleStateStore.getState().preferredHost).toBe("resolve");
    expect(useAgentStore.getState().reviewEdits).toBe(false);
  });

  it("doesn't switch to an editor that isn't connected", async () => {
    controller.submitMessage.mockResolvedValue("sent");
    useNleStateStore.setState({ hosts: { ...initialHosts(), premiere: nleState("premiere") }, preferredHost: "premiere" });
    await handleHostChatAction("resolve", { id: "a1", type: "send", text: "hi" });
    expect(useNleStateStore.getState().preferredHost).toBe("premiere");
  });

  it("answers review cards with the panel's decision", async () => {
    review.answerReview.mockReturnValueOnce(true).mockReturnValueOnce(true).mockReturnValueOnce(false);
    for (const decision of ["apply", "skip", "all"] as const) await handleHostChatAction("premiere", { id: `a-${decision}`, type: "review_decision", cardId: "m1", decision });
    expect(review.answerReview.mock.calls).toEqual([
      ["m1", "apply"],
      ["m1", "skip"],
      ["m1", "all"],
    ]);
    expect(buildHostStateFile("premiere").notice).toMatchObject({ actionId: "a-all", failed: true });
  });

  it("stops, retries, edits and starts over through the app's own controller", async () => {
    await handleHostChatAction("premiere", { id: "a1", type: "stop" });
    await handleHostChatAction("premiere", { id: "a2", type: "retry" });
    await handleHostChatAction("premiere", { id: "a3", type: "edit_last", text: "shorter" });
    await handleHostChatAction("premiere", { id: "a4", type: "new_chat" });
    await handleHostChatAction("premiere", { id: "a5", type: "load_chat", chatId: "c1" });
    expect(controller.stopTurn).toHaveBeenCalledTimes(1);
    expect(controller.retryLastTurn).toHaveBeenCalledTimes(1);
    expect(controller.sendEditedMessage).toHaveBeenCalledWith("shorter");
    expect(controller.newConversation).toHaveBeenCalledWith();
    expect(history.openChat).toHaveBeenCalledWith("c1");
  });

  it("reverts and reports it in the chat and the panel", async () => {
    edits.revertLastRequest.mockResolvedValue({ summary: "Reverted 2 timeline changes", result: {} });
    await handleHostChatAction("resolve", { id: "a1", type: "revert" });
    expect(edits.revertLastRequest).toHaveBeenCalledWith({ byUser: true });
    expect(useAgentStore.getState().messages.at(-1)).toMatchObject({ role: "tool", text: "Reverted 2 timeline changes" });
    expect(buildHostStateFile("resolve").notice).toMatchObject({ actionId: "a1", text: "Reverted 2 timeline changes", failed: false });
  });

  it("turns a failure into the panel's notice and an error in the chat", async () => {
    controller.retryLastTurn.mockRejectedValue(new Error("Finish or stop the current request first"));
    await handleHostChatAction("premiere", { id: "a1", type: "retry" });
    expect(buildHostStateFile("premiere").notice).toMatchObject({ actionId: "a1", text: "Finish or stop the current request first", failed: true });
    expect(useAgentStore.getState().messages.at(-1)).toMatchObject({ role: "error" });
  });

  it("refuses a send it can't make, saying why", async () => {
    controller.submitMessage.mockResolvedValue(false);
    useAgentStore.setState({ status: "offline", statusDetail: "Agent sidecar not running" });
    await handleHostChatAction("premiere", { id: "a1", type: "send", text: "hi" });
    expect(buildHostStateFile("premiere").notice).toMatchObject({ text: "Not sent: Agent sidecar not running", failed: true });
  });

  it("moves the editor's playhead on its open timeline", async () => {
    await handleHostChatAction("resolve", { id: "a1", type: "set_playhead", seconds: 12.5 });
    expect(ipc.nleCall).toHaveBeenCalledWith("resolve", "set_playhead", { timeline: "Edit 1", time: 12.5 });
  });

  it("hands B-roll actions to the Library for the panel's editor", async () => {
    await handleHostChatAction("resolve", { id: "a1", type: "broll_place", key: "s1" });
    await handleHostChatAction("premiere", { id: "a2", type: "broll_search", query: "dusk" });
    await handleHostChatAction("resolve", { id: "a3", type: "hello" });
    expect(lib.placeShot).toHaveBeenCalledWith("s1", "resolve");
    expect(lib.searchLibrary).toHaveBeenCalledWith("dusk");
    expect(lib.openLibrary).toHaveBeenCalledTimes(1);
  });

  it("publishes both editors' lights, the usage tracker and the last reply's timing", () => {
    useUsageStore.setState({
      plan: { fiveHour: { used: 0.3 } },
      planAt: 5,
      days: { [new Date().toLocaleDateString("en-CA")]: { gemini: { turns: 1, promptTokens: 100, cachedTokens: 0, outputTokens: 20, costUsd: 0.01 } } },
      chats: { [useAgentStore.getState().chatId]: { turns: 2, promptTokens: 300, cachedTokens: 0, outputTokens: 40, costUsd: null, updatedAt: 1 } },
    });
    useTurnTimingStore.setState({ last: { marks: { firstWords: 1.4 }, warm: true } as never });
    const file = buildHostStateFile("premiere");
    expect(file.version).toBe(2);
    expect(file.editors.map((e) => [e.host, e.status])).toEqual([
      ["premiere", "connected"],
      ["resolve", "connected"],
    ]);
    expect(file.usage.plan?.fiveHour?.used).toBe(0.3);
    expect(file.usage.chat).toEqual({ turns: 2, promptTokens: 300, cachedTokens: 0, outputTokens: 40, costUsd: null });
    expect(file.usage.labels.find((l) => l.id === "claude-code-opus-5-5")?.subscription).toBe(true);
    expect(file.agent.lastReply).toContain("first words");
  });

  it("refreshes the plan's usage, and says why it couldn't", async () => {
    plan.refreshPlan.mockResolvedValue("Claude Code isn't signed in");
    await handleHostChatAction("premiere", { id: "a1", type: "usage_refresh" });
    expect(plan.refreshPlan).toHaveBeenCalledTimes(1);
    expect(buildHostStateFile("premiere").notice).toMatchObject({ actionId: "a1", text: "Claude Code isn't signed in", failed: true });
    expect(useAgentStore.getState().messages).toHaveLength(0);
  });
});

const ANALYSIS: AnalyzeResult = {
  analyzed: 2,
  cached: 0,
  cancelled: false,
  failed: [],
  warnings: [],
  exportPath: null,
  duplicates: 0,
  ranked: [
    { path: "/Footage/Day 1/pier.mov", filename: "pier.mov", score: 88, bestStart: 2, bestEnd: 6, duration: 30, segments: [{ start: 2, end: 6, score: 88 }, { start: 14, end: 18, score: 71 }], energy: 60, relevance: null, duplicateOf: null },
    { path: "/Footage/Day 1/gulls.mov", filename: "gulls.mov", score: 54, bestStart: 0, bestEnd: 4, duration: 12, segments: [{ start: 0, end: 4, score: 54 }], energy: null, relevance: null, duplicateOf: null },
  ],
};

describe("the panels' Analyze tab", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    connectBoth();
    useSidecarStore.setState({ jobs: [] });
    useBrollStore.setState({
      ...DEFAULT_OPTIONS,
      folder: "/Footage/Day 1",
      contentAware: false,
      dedupe: false,
      brief: "",
      query: "",
      analyzeJobId: null,
      matchJobId: null,
      excluded: {},
      lastResult: { folder: "/Footage/Day 1", params: { contentAware: false, brief: "", dedupe: false, windowSec: 4, maxSegments: 1, minGapSec: 1, energyWeight: 35, relevanceWeight: 35 }, result: ANALYSIS, at: 1 },
    });
  });

  it("publishes the folder, the options, the ranked clips by place and the selects, with no paths", () => {
    useBrollStore.setState({ excluded: { "/Footage/Day 1/gulls.mov": [0] } });
    const file = buildHostAnalyzerFile("resolve", 9);
    expect(file).toMatchObject({ version: 2, publishedAt: 9, folder: "/Footage/Day 1", buildBlocked: null, placeBlocked: null });
    expect(file.analysis?.ranked.map((c) => [c.filename, c.excluded, c.chips])).toEqual([
      ["pier.mov", [], ["energy 60"]],
      ["gulls.mov", [0], []],
    ]);
    expect(file.selects).toEqual({ segments: 2, clips: 1, seconds: 8 });
    expect(JSON.stringify(file.analysis)).not.toContain("/Footage/Day 1/");
  });

  it("says why Build and Place can't run in that editor", () => {
    useNleStateStore.setState({ hosts: { ...initialHosts(), premiere: nleState("premiere", { timeline: "Main" }) } });
    useConnectionStore.setState((s) => ({ connections: { ...s.connections, premiere: { ...s.connections.premiere, draft: { base: "Main" } as never } } }));
    expect(buildHostAnalyzerFile("premiere").buildBlocked).toContain("draft is open");
    expect(buildHostAnalyzerFile("resolve").placeBlocked).toContain("Connect Resolve");
    useConnectionStore.setState((s) => ({ connections: { ...s.connections, premiere: { ...s.connections.premiere, draft: null } } }));
  });

  it("sets the folder and options through the window's store, and starts the analysis", async () => {
    await handleHostChatAction("premiere", { id: "a1", type: "analyzer_set_folder", path: "/Footage/Day 2" });
    expect(useBrollStore.getState().folder).toBe("/Footage/Day 2");
    await handleHostChatAction("premiere", { id: "a2", type: "analyzer_set_option", key: "contentAware", value: true });
    await handleHostChatAction("premiere", { id: "a3", type: "analyzer_set_option", key: "windowSec", value: 500 });
    expect(useBrollStore.getState().contentAware).toBe(true);
    expect(useBrollStore.getState().windowSec).toBe(120);
    await handleHostChatAction("premiere", { id: "a4", type: "analyzer_start" });
    expect(broll.startAnalysis).toHaveBeenCalledTimes(1);
  });

  it("places, opens and ticks a clip named by its place in the list, in the panel's editor", async () => {
    broll.placeAtPlayhead.mockResolvedValue("Placed pier.mov");
    lib.openInSourceMonitor.mockResolvedValue("pier.mov is in the source viewer");
    await handleHostChatAction("resolve", { id: "a1", type: "analyzer_place", list: "ranked", clip: 0, segment: 1 });
    expect(broll.placeAtPlayhead).toHaveBeenCalledWith({ path: "/Footage/Day 1/pier.mov", filename: "pier.mov", start: 14, end: 18 }, { host: "resolve" });
    expect(buildHostAnalyzerFile("resolve").notice).toMatchObject({ actionId: "a1", text: "Placed pier.mov", failed: false });
    await handleHostChatAction("resolve", { id: "a2", type: "analyzer_source", list: "ranked", clip: 1, segment: 0 });
    expect(lib.openInSourceMonitor).toHaveBeenCalledWith("resolve", { path: "/Footage/Day 1/gulls.mov", filename: "gulls.mov", start: 0, end: 4 });
    await handleHostChatAction("resolve", { id: "a3", type: "analyzer_toggle_segment", clip: 0, segment: 1 });
    expect(useBrollStore.getState().excluded).toEqual({ "/Footage/Day 1/pier.mov": [1] });
    await handleHostChatAction("resolve", { id: "a4", type: "analyzer_place", list: "ranked", clip: 7, segment: 0 });
    expect(buildHostAnalyzerFile("resolve").notice).toMatchObject({ actionId: "a4", failed: true });
    expect(useAgentStore.getState().messages.some((m) => m.role === "error")).toBe(false);
  });

  it("exports beside the footage under a new name, and builds in the panel's editor", async () => {
    broll.exportSelectsXml.mockResolvedValue({ text: "Wrote 3 segments.", path: "/Footage/Day 1/Day 1 selects 2026-11-03 15.30.xml" });
    broll.buildSelectsTimeline.mockResolvedValue('Made "B-Roll Selects"');
    useNleStateStore.setState({ preferredHost: "premiere" });
    await handleHostChatAction("resolve", { id: "a1", type: "analyzer_export" });
    const [, , savePath] = broll.exportSelectsXml.mock.calls[0];
    expect(savePath).toMatch(/^\/Footage\/Day 1\/Day 1 selects \d{4}-\d{2}-\d{2} \d{2}\.\d{2}\.xml$/);
    expect(buildHostAnalyzerFile("resolve").notice).toMatchObject({ actionId: "a1", exported: true, failed: false });
    await handleHostChatAction("resolve", { id: "a2", type: "analyzer_build" });
    expect(useNleStateStore.getState().preferredHost).toBe("resolve");
    expect(broll.buildSelectsTimeline).toHaveBeenCalledTimes(1);
    expect(buildHostAnalyzerFile("resolve").notice).toMatchObject({ actionId: "a2", text: 'Made "B-Roll Selects"' });
  });

  it("searches only with content-aware scoring", async () => {
    await handleHostChatAction("premiere", { id: "a1", type: "analyzer_match", query: "waves" });
    expect(broll.startMatch).not.toHaveBeenCalled();
    expect(buildHostAnalyzerFile("premiere").notice).toMatchObject({ failed: true });
    useBrollStore.setState({ contentAware: true });
    await handleHostChatAction("premiere", { id: "a2", type: "analyzer_match", query: "waves" });
    expect(useBrollStore.getState().query).toBe("waves");
    expect(broll.startMatch).toHaveBeenCalledTimes(1);
  });
});
