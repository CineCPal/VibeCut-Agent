import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PanelBrollFile } from "../src/types/brollPanel";
import type { HostAnalyzerFile, HostChatAction, HostPanelMessage, HostPanelStateFile } from "../src/types/hostPanel";
import { timecodeSeconds } from "./Markdown";
import { HostApp } from "./HostApp";
import type { Transport } from "./transport";

const message = (id: string, over: Partial<HostPanelMessage> = {}): HostPanelMessage => ({ id, role: "user", text: id, createdAt: 1, ...over });

function stateFile(over: Partial<HostPanelStateFile> = {}, chat: Partial<HostPanelStateFile["chat"]> = {}): HostPanelStateFile {
  return {
    version: 2,
    publishedAt: 1,
    host: "premiere",
    editor: { connected: true, status: "connected", product: "Premiere Pro", version: "26.5", project: "Doc", timeline: "Main", timelines: ["Main"], noEditor: null, noPlace: null },
    editors: [
      { host: "premiere", status: "connected", detail: "Doc · Main" },
      { host: "resolve", status: "disconnected", detail: "Resolve isn't running" },
    ],
    usage: {
      plan: { fiveHour: { used: 0.42, resetsAt: Math.floor(Date.now() / 1000) + 7200 }, weekly: { used: 0.81 } },
      planAt: Date.now() - 120_000,
      chat: { turns: 3, promptTokens: 12_000, cachedTokens: 8_000, outputTokens: 2_400, costUsd: 0.31 },
      today: { "claude-code-opus-5-5": { turns: 5, promptTokens: 40_000, cachedTokens: 0, outputTokens: 5_000, costUsd: 1.2 } },
      week: { "claude-code-opus-5-5": { turns: 20, promptTokens: 400_000, cachedTokens: 0, outputTokens: 50_000, costUsd: 12 } },
      labels: [
        { id: "gemini", label: "Gemini 3.8 Flash", subscription: false },
        { id: "claude-code-opus-5-5", label: "Claude Opus 5.5 (subscription)", subscription: true },
      ],
    },
    agent: {
      status: "idle",
      statusDetail: null,
      activity: null,
      aiChoice: "claude-code-opus-5-5",
      choices: [
        { id: "gemini", label: "Gemini 3.8 Flash" },
        { id: "claude-code-opus-5-5", label: "Claude Opus 5.5 (subscription)" },
      ],
      effort: { opus: "medium", sonnet: "medium" },
      geminiEffort: "medium",
      reviewEdits: false,
      outsideRunning: false,
      lastReply: "first words 1.4 s · timeline read 0.2 s",
    },
    chat: {
      chatId: "c1",
      title: "Intro pass",
      messages: [],
      queue: [],
      queuePaused: false,
      canRetry: false,
      rewindBlocked: null,
      lastTurnEdits: 0,
      revertable: 0,
      earlierSessionRevert: false,
      ...chat,
    },
    openDraft: null,
    history: [
      { id: "c1", title: "Intro pass", updatedAt: Date.now(), messageCount: 4 },
      { id: "c2", title: "Colour notes", updatedAt: Date.now() - 3 * 86_400_000, messageCount: 9 },
    ],
    prompts: [{ id: "p1", name: "tighten", body: "Tighten every pause over a second" }],
    notice: null,
    ...over,
  };
}

const BROLL: PanelBrollFile = {
  version: 1,
  publishedAt: 1,
  indexMissing: false,
  folders: [],
  scopes: [],
  scopeLabel: "All folders",
  mode: "browse",
  query: "",
  shots: [{ key: "s1", filename: "dusk.mov", start: 0, end: 4, status: "ok" }],
  hasMore: false,
  total: 1,
  busy: null,
  error: null,
  pool: [],
  paths: { s1: "/Volumes/Archive/dusk.mov" },
  editor: { connected: true, timeline: "Main", noEditor: null, noPlace: null },
  notice: null,
};

function analyzerFile(over: Partial<HostAnalyzerFile> = {}): HostAnalyzerFile {
  return {
    version: 2,
    publishedAt: 1,
    folder: "/Volumes/Footage/Day 1",
    contentAware: true,
    dedupe: false,
    brief: "",
    query: "",
    options: { windowSec: 4, maxSegments: 2, minGapSec: 1, energyWeight: 35, relevanceWeight: 35, workers: null, topMode: "all", topN: 10, minScore: 0, sequenceOrder: "score", sequenceName: "B-Roll Selects" },
    analyzeJob: null,
    matchJob: null,
    exportJob: null,
    analysis: {
      total: 2,
      cached: 1,
      duplicates: 0,
      issues: [],
      stale: [],
      ranked: [
        { filename: "pier.mov", score: 88, start: 2, end: 6, duration: 30, segments: [{ start: 2, end: 6, score: 88 }, { start: 14, end: 18, score: 71 }], excluded: [], inSelection: true, chips: ["energy 60"], note: null },
        { filename: "gulls.mov", score: 54, start: 0, end: 4, duration: 12, segments: [{ start: 0, end: 4, score: 54 }], excluded: [0], inSelection: true, chips: [], note: null },
      ],
    },
    matches: [],
    selects: { segments: 2, clips: 1, seconds: 8 },
    buildBlocked: null,
    placeBlocked: null,
    notice: null,
    ...over,
  };
}

let sent: HostChatAction[];

function transport(state: HostPanelStateFile | null, alive = true, extras: Partial<Transport> = {}): Transport {
  return {
    readAnalyzer: vi.fn(async () => analyzerFile()),
    ...extras,
    readState: vi.fn(async () => state),
    readBroll: vi.fn(async () => BROLL),
    readThumb: vi.fn(async () => null),
    agentAliveAt: vi.fn(async () => (alive ? Date.now() : null)),
    send: vi.fn(async (action: HostChatAction) => {
      sent.push(action);
    }),
    heartbeat: vi.fn(async () => undefined),
  };
}

/** Mounts the panel and lets its first read land. */
async function mount(state: HostPanelStateFile | null, alive = true, extras: Partial<Transport> = {}) {
  const t = transport(state, alive, extras);
  render(<HostApp transport={t} hostName="Premiere Pro" />);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(300);
  });
  return t;
}

const last = () => sent[sent.length - 1];
const withoutId = (action: HostChatAction) => {
  const { id: _id, ...rest } = action;
  return rest;
};

describe("the VibeCut Agent panel in an editor", () => {
  beforeEach(() => {
    sent = [];
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("says hello, then shows the editor and the chat", async () => {
    await mount(stateFile());
    expect(sent[0]).toMatchObject({ type: "hello" });
    expect(screen.getByText("Doc · Main")).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Chat" })).toHaveAttribute("aria-selected", "true");
  });

  it("says when the app isn't running", async () => {
    await mount(null, false);
    expect(screen.getByText(/isn't running — launch it from the top menu bar/)).toBeInTheDocument();
    expect(screen.queryByRole("tablist")).toBeNull();
  });

  it("switches between Chat, B-roll and History", async () => {
    await mount(stateFile());
    fireEvent.click(screen.getByRole("tab", { name: "Library" }));
    expect(screen.getByText("dusk.mov")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("tab", { name: "History" }));
    expect(screen.getByText("Colour notes")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("tab", { name: "Chat" }));
    expect(screen.getByRole("textbox", { name: "Message" })).toBeInTheDocument();
  });

  it("sends a trimmed message with Enter and empties the box", async () => {
    await mount(stateFile());
    const box = screen.getByRole("textbox", { name: "Message" });
    fireEvent.change(box, { target: { value: "  Add a dissolve " } });
    fireEvent.keyDown(box, { key: "Enter" });
    expect(withoutId(last())).toEqual({ type: "send", text: "Add a dissolve" });
    expect(box).toHaveValue("");
  });

  it("offers Queue and Stop while the agent works", async () => {
    await mount(stateFile({ agent: { ...stateFile().agent, status: "thinking", activity: "Reading the timeline…" } }));
    expect(screen.getByText("Reading the timeline…", { exact: false })).toHaveClass("vc-working");
    expect(screen.getByRole("button", { name: "Queue" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Stop the agent" }));
    expect(withoutId(last())).toEqual({ type: "stop" });
  });

  it("answers a change waiting for review with Apply, Skip or Apply all", async () => {
    const card = message("m2", { role: "tool", text: "Trim clip 3 by 2 s", tool: { id: "m2", name: "trim_clip", summary: "Trim clip 3 by 2 s", args: "{}", state: "pending" } });
    await mount(stateFile({}, { messages: [message("m1"), card] }));
    const group = screen.getByRole("group", { name: "Change waiting for review" });
    fireEvent.click(within(group).getByRole("button", { name: "Apply" }));
    expect(withoutId(last())).toEqual({ type: "review_decision", cardId: "m2", decision: "apply" });
    fireEvent.click(within(group).getByRole("button", { name: "Skip" }));
    expect(withoutId(last())).toEqual({ type: "review_decision", cardId: "m2", decision: "skip" });
    fireEvent.click(within(group).getByRole("button", { name: "Apply all" }));
    expect(withoutId(last())).toEqual({ type: "review_decision", cardId: "m2", decision: "all" });
  });

  it("reverts the latest request and starts a new chat", async () => {
    await mount(stateFile({}, { messages: [message("m1")], revertable: 2 }));
    fireEvent.click(screen.getByRole("button", { name: "Revert 2 edits" }));
    expect(withoutId(last())).toEqual({ type: "revert" });
    fireEvent.click(screen.getByRole("button", { name: "New chat" }));
    expect(withoutId(last())).toEqual({ type: "new_chat" });
  });

  it("retries or edits the last message", async () => {
    await mount(stateFile({}, { messages: [message("m1", { text: "Cut the ums" }), message("m2", { role: "assistant", text: "Done" })], canRetry: true, lastTurnEdits: 3 }));
    fireEvent.click(screen.getByRole("button", { name: "Revert 3 & retry" }));
    expect(withoutId(last())).toEqual({ type: "retry" });
    const box = screen.getByRole("textbox", { name: "Message" });
    fireEvent.keyDown(box, { key: "ArrowUp" });
    expect(box).toHaveValue("Cut the ums");
    fireEvent.change(box, { target: { value: "Cut the ums and the ahs" } });
    fireEvent.keyDown(box, { key: "Enter" });
    expect(withoutId(last())).toEqual({ type: "edit_last", text: "Cut the ums and the ahs" });
  });

  it("moves the playhead from a timecode in a reply", async () => {
    await mount(stateFile({}, { messages: [message("m1", { role: "assistant", text: "The laugh at 1:05 runs long." })] }));
    fireEvent.click(screen.getByRole("button", { name: "Go to 1:05" }));
    expect(withoutId(last())).toEqual({ type: "set_playhead", seconds: 65 });
    expect(timecodeSeconds("01:00:05:12")).toBe(3605);
  });

  it("sends or discards the open draft, and works the queue", async () => {
    await mount(
      stateFile(
        { openDraft: { base: "Main", changes: ["cut 0:10–0:12"], duration: 95 } },
        { messages: [message("m1")], queue: [{ id: "q1", text: "then add music", imageCount: 0 }], queuePaused: true },
      ),
    );
    const draft = screen.getByRole("region", { name: "Draft" });
    expect(draft).toHaveTextContent("Draft of “Main”: 1 change, 1:35");
    fireEvent.click(within(draft).getByRole("button", { name: "Discard" }));
    expect(withoutId(last())).toEqual({ type: "draft_discard" });
    const queue = screen.getByRole("region", { name: "Queued messages" });
    fireEvent.click(within(queue).getByRole("button", { name: "Send next" }));
    expect(withoutId(last())).toEqual({ type: "queue_resume" });
    fireEvent.click(within(queue).getByRole("button", { name: "Remove “then add music” from the queue" }));
    expect(withoutId(last())).toEqual({ type: "queue_remove", queueId: "q1" });
  });

  it("changes the model, effort and Review edits", async () => {
    await mount(stateFile());
    fireEvent.change(screen.getByRole("combobox", { name: "Effort" }), { target: { value: "xhigh" } });
    expect(withoutId(last())).toEqual({ type: "set_effort", family: "opus", effort: "xhigh" });
    fireEvent.change(screen.getByRole("combobox", { name: "Agent model" }), { target: { value: "gemini" } });
    expect(withoutId(last())).toEqual({ type: "set_model", aiChoice: "gemini" });
    fireEvent.click(screen.getByRole("checkbox", { name: "Review edits" }));
    expect(withoutId(last())).toEqual({ type: "set_review_edits", on: true });
  });

  it("fills a saved prompt from /", async () => {
    await mount(stateFile());
    const box = screen.getByRole("textbox", { name: "Message" });
    fireEvent.change(box, { target: { value: "/tig" } });
    fireEvent.keyDown(box, { key: "Enter" });
    expect(box).toHaveValue("Tighten every pause over a second");
    expect(sent.some((a) => a.type === "send")).toBe(false);
  });

  it("opens a past chat from History and goes back to Chat", async () => {
    await mount(stateFile());
    fireEvent.click(screen.getByRole("tab", { name: "History" }));
    fireEvent.change(screen.getByRole("searchbox", { name: "Filter chats" }), { target: { value: "colour" } });
    expect(screen.queryByText("Intro pass")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Colour notes/ }));
    expect(withoutId(last())).toEqual({ type: "load_chat", chatId: "c2" });
    expect(screen.getByRole("tab", { name: "Chat" })).toHaveAttribute("aria-selected", "true");
  });

  it("pops out the app's window for the tab it's on", async () => {
    await mount(stateFile());
    fireEvent.click(screen.getByRole("button", { name: "Window" }));
    expect(withoutId(last())).toEqual({ type: "open_window", view: "chat" });
    fireEvent.click(screen.getByRole("tab", { name: "Library" }));
    fireEvent.click(screen.getByRole("button", { name: "Window" }));
    expect(withoutId(last())).toEqual({ type: "open_window", view: "library" });
  });

  it("shows each editor's light, the agent's state and model, and the last reply's timing", async () => {
    await mount(stateFile());
    const lights = screen.getByRole("list", { name: "Editor connections" });
    expect(within(lights).getByText("Premiere Pro: Connected (Doc · Main)")).toBeInTheDocument();
    expect(within(lights).getByText("DaVinci Resolve: Not connected (Resolve isn't running)")).toBeInTheDocument();
    const footer = screen.getByRole("contentinfo", { name: "Agent status" });
    expect(footer).toHaveTextContent("Ready");
    expect(footer).toHaveTextContent("Claude Opus 5.5 (subscription)");
    expect(footer).toHaveTextContent("first words 1.4 s");
  });

  it("opens the usage tracker with the plan, this chat and the totals, and refreshes it", async () => {
    await mount(stateFile());
    fireEvent.click(screen.getByRole("button", { name: "Usage" }));
    const pop = screen.getByRole("dialog", { name: "Usage" });
    expect(within(pop).getByRole("meter", { name: "5-hour limit used" })).toHaveAttribute("aria-valuenow", "42");
    expect(within(pop).getByRole("meter", { name: "This week used" })).toHaveAttribute("aria-valuenow", "81");
    expect(pop).toHaveTextContent(/Resets in 2 h/);
    expect(pop).toHaveTextContent("This chat: 14k tokens in 3 turns");
    expect(within(pop).getAllByText("Claude Opus 5.5 (subscription)")).toHaveLength(2);
    expect(pop).toHaveTextContent("≈$1.20");
    fireEvent.click(within(pop).getByRole("button", { name: "Refresh" }));
    expect(withoutId(last())).toEqual({ type: "usage_refresh" });
  });

  it("asks for the app to be updated when the versions differ", async () => {
    const t = transport(null);
    t.stateVersion = () => 3;
    render(<HostApp transport={t} hostName="Premiere Pro" />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });
    expect(screen.getByRole("alert")).toHaveTextContent("VibeCut Agent is newer than this panel");
  });

  it("formats a reply and copies it", async () => {
    const copyText = vi.fn();
    await mount(stateFile({}, { messages: [message("m1", { role: "assistant", text: "**Done.** Cut at 0:42:\n\n- one\n- two" })] }), true, { copyText });
    expect(screen.getByText("Done.").tagName).toBe("STRONG");
    expect(screen.getAllByRole("listitem").some((li) => li.textContent === "one")).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Go to 0:42" }));
    expect(withoutId(last())).toEqual({ type: "set_playhead", seconds: 42 });
    fireEvent.click(screen.getByRole("button", { name: "Copy message" }));
    expect(copyText).toHaveBeenCalledWith("**Done.** Cut at 0:42:\n\n- one\n- two");
  });

  it("opens a tool card to its arguments and result", async () => {
    const tool = (id: string, name: string) =>
      message(id, { role: "tool", text: `Ran ${name}`, tool: { id, name, summary: `Ran ${name}`, args: `{"clip":"${id}"}`, result: '{"ok":true}', state: "done" } });
    await mount(stateFile({}, { messages: [message("m1"), tool("t1", "trim_clip")] }));
    fireEvent.click(screen.getByRole("button", { name: /trim_clip/ }));
    expect(screen.getByText('{"clip":"t1"}')).toBeInTheDocument();
    expect(screen.getByText('{"ok":true}')).toBeInTheDocument();
  });

  it("runs the Analyzer: folder, options, analyze, segments, Source, Place, Export and Build", async () => {
    const chooseFolder = vi.fn(async () => "/Volumes/Footage/Day 2");
    await mount(stateFile(), true, { chooseFolder });
    fireEvent.click(screen.getByRole("tab", { name: "Analyze" }));
    expect(screen.getByText("/Volumes/Footage/Day 1")).toBeInTheDocument();

    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Change" })));
    expect(chooseFolder).toHaveBeenCalledWith("/Volumes/Footage/Day 1");
    expect(withoutId(last())).toEqual({ type: "analyzer_set_folder", path: "/Volumes/Footage/Day 2" });

    const length = screen.getByRole("spinbutton", { name: "Segment length" });
    fireEvent.change(length, { target: { value: "6" } });
    fireEvent.blur(length);
    expect(withoutId(last())).toEqual({ type: "analyzer_set_option", key: "windowSec", value: 6 });
    fireEvent.click(screen.getByRole("checkbox", { name: /Mark near-duplicate takes/ }));
    expect(withoutId(last())).toEqual({ type: "analyzer_set_option", key: "dedupe", value: true });
    fireEvent.click(screen.getByRole("button", { name: "Analyze folder" }));
    expect(withoutId(last())).toEqual({ type: "analyzer_start" });

    fireEvent.click(screen.getByRole("checkbox", { name: "Include gulls.mov 0:00–0:04 in the selects" }));
    expect(withoutId(last())).toEqual({ type: "analyzer_toggle_segment", clip: 1, segment: 0 });
    fireEvent.click(screen.getByRole("button", { name: "0:14–0:18 · 71" }));
    fireEvent.click(screen.getByRole("button", { name: "Place pier.mov at the playhead" }));
    expect(withoutId(last())).toEqual({ type: "analyzer_place", list: "ranked", clip: 0, segment: 1 });
  });

  it("exports the selects, and builds them unless the editor can't", async () => {
    await mount(stateFile());
    fireEvent.click(screen.getByRole("tab", { name: "Analyze" }));
    fireEvent.click(screen.getByRole("button", { name: "Build timeline" }));
    expect(withoutId(last())).toEqual({ type: "analyzer_build" });
    cleanup();
    sent = [];
    await mount(stateFile(), true, { readAnalyzer: vi.fn(async () => analyzerFile({ buildBlocked: "A Story Editor draft is open in Premiere; send or discard it first" })) });
    fireEvent.click(screen.getByRole("tab", { name: "Analyze" }));
    expect(screen.getByRole("button", { name: "Build timeline" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Export XML" }));
    expect(withoutId(last())).toEqual({ type: "analyzer_export" });
  });

  it("opens segments in the Source monitor and searches from the Analyzer", async () => {
    await mount(stateFile());
    fireEvent.click(screen.getByRole("tab", { name: "Analyze" }));
    expect(screen.getByText("Selects: 2 segments from 1 clip, 0:08")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Open gulls.mov in the Source monitor" }));
    expect(withoutId(last())).toEqual({ type: "analyzer_source", list: "ranked", clip: 1, segment: 0 });
    // Source waits for its answer, holding the other editor actions meanwhile.
    expect(screen.getByRole("button", { name: "Export XML" })).toBeDisabled();
    const box = screen.getByRole("textbox", { name: "Find shots" });
    fireEvent.change(box, { target: { value: "waves at dusk" } });
    fireEvent.keyDown(box, { key: "Enter" });
    expect(withoutId(last())).toEqual({ type: "analyzer_match", query: "waves at dusk" });
  });

  it("types a folder when the editor has no picker", async () => {
    await mount(stateFile());
    fireEvent.click(screen.getByRole("tab", { name: "Analyze" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Folder path" }), { target: { value: "/Volumes/Footage/Day 3" } });
    fireEvent.click(screen.getByRole("button", { name: "Use" }));
    expect(withoutId(last())).toEqual({ type: "analyzer_set_folder", path: "/Volumes/Footage/Day 3" });
  });

  it("shows a running analysis with its progress and ETA, and cancels it", async () => {
    const analyzeJob = { label: "Analyze Day 1", status: "running" as const, fraction: 0.5, detail: "pier.mov", eta: 75, error: null };
    await mount(stateFile(), true, { readAnalyzer: vi.fn(async () => analyzerFile({ analyzeJob })) });
    fireEvent.click(screen.getByRole("tab", { name: "Analyze" }));
    expect(screen.getByRole("progressbar", { name: "Analyze Day 1" })).toHaveAttribute("aria-valuenow", "50");
    expect(screen.getByText("50% · 1 min 15 s left")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Analyze folder" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Cancel Analyze Day 1" }));
    expect(withoutId(last())).toEqual({ type: "analyzer_cancel" });
  });
});
