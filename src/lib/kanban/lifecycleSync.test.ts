import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { nleState } from "../../test/nleFixtures";

const controller = vi.hoisted(() => ({ submitMessage: vi.fn(async () => "sent") }));
vi.mock("../agent/controller", () => controller);
const ipc = vi.hoisted(() => ({ getKanbanBoard: vi.fn(async () => null), setKanbanBoard: vi.fn(async () => undefined) }));
vi.mock("../ipc", () => ipc);

import { cardOfMessage, kanbanContext, startKanbanSync } from "./lifecycleSync";
import { buildCardExecutionPrompt } from "./runner";
import { resetKanbanStoreForTests, useKanbanStore } from "../../store/useKanbanStore";
import { useAgentStore } from "../../store/useAgentStore";
import { useSidecarStore } from "../../store/useSidecarStore";
import { useEditLogStore } from "../../store/useEditLogStore";
import { initialHosts, useNleStateStore } from "../../store/useNleStateStore";
import { emptyBoard, type KanbanColumnId } from "../../types/kanban";
import type { EditEntry } from "../../types/edits";

const kanban = () => useKanbanStore.getState();
const agent = () => useAgentStore.getState();
const card = (id: string) => kanban().board.cards.find((c) => c.id === id);
const column = (id: string): KanbanColumnId | undefined => card(id)?.column;

function connect(project: string | null) {
  const hosts = initialHosts();
  hosts.resolve = nleState("resolve", { project });
  useNleStateStore.setState({ hosts, preferredHost: "auto" });
}

/** A turn as the controller runs it: busy, then the user's message. */
function startTurn(text: string, mentions: { kind: "card"; label: string; ref: string }[] = []) {
  agent().setStatus("thinking");
  agent().addMessage({ role: "user", text, status: "done", ...(mentions.length ? { mentions } : {}) });
}
const endTurn = () => agent().setStatus("idle");

function logEdit(over: Partial<EditEntry> = {}) {
  return useEditLogStore.getState().log({ step: "m1", stepText: "x", host: "resolve", timeline: "Main", tool: "delete_clips", summary: "Deleted 1 clip", backup: "b", changes: [], ...over });
}

describe("the Kanban lifecycle sync", () => {
  let stop: () => void = () => undefined;

  beforeEach(async () => {
    vi.useFakeTimers();
    resetKanbanStoreForTests();
    ipc.getKanbanBoard.mockClear();
    agent().clear();
    useAgentStore.setState({ status: "idle", queue: [], queuePaused: false });
    useSidecarStore.setState({ jobs: [] });
    useEditLogStore.setState({ entries: [], floorSeq: 1 });
    connect("Doc");
    stop = startKanbanSync();
    await vi.advanceTimersByTimeAsync(0);
    kanban().planWorkflow([
      { tempId: "a", title: "Transcribe", category: "transcript" },
      { tempId: "b", title: "Cut", category: "cut", blockedBy: ["a"] },
    ]);
  });
  afterEach(() => {
    stop();
    vi.useRealTimers();
  });

  it("loads the board of the project the editor opens", async () => {
    expect(kanban().scope).toEqual({ host: "resolve", project: "Doc" });
    connect("Other");
    await vi.advanceTimersByTimeAsync(SAVE_WAIT);
    expect(kanban().scope).toEqual({ host: "resolve", project: "Other" });
    connect(null);
    await vi.advanceTimersByTimeAsync(SAVE_WAIT);
    expect(kanban().scope.host).toBe("global");
  });

  it("finds the card a message is about", () => {
    expect(cardOfMessage({ text: buildCardExecutionPrompt(card("kb_2")!) })).toBe("kb_2");
    expect(cardOfMessage({ text: "look at @kb_1", mentions: [{ kind: "card", label: "kb_1", ref: "kb_1" }] })).toBe("kb_1");
    expect(cardOfMessage({ text: "two", mentions: [{ kind: "card", label: "kb_1", ref: "kb_1" }, { kind: "card", label: "kb_2", ref: "kb_2" }] })).toBeNull();
    expect(cardOfMessage({ text: "no card" })).toBeNull();
  });

  it("binds a card's turn, and sends it to Needs Review when the turn ends with it still Active", () => {
    startTurn(buildCardExecutionPrompt(card("kb_1")!));
    expect(kanban().activeTurnCardId).toBe("kb_1");
    expect(column("kb_1")).toBe("in_progress");
    endTurn();
    expect(kanban().activeTurnCardId).toBeNull();
    expect(column("kb_1")).toBe("review");
  });

  it("a card the agent finished stays done, and a mention alone doesn't start a card", () => {
    startTurn(buildCardExecutionPrompt(card("kb_1")!));
    kanban().updateCard("kb_1", { column: "done" });
    endTurn();
    expect(column("kb_1")).toBe("done");
    startTurn("why is this waiting? @kb_2", [{ kind: "card", label: "kb_2", ref: "kb_2" }]);
    expect(kanban().activeTurnCardId).toBe("kb_2");
    expect(column("kb_2")).toBe("ready");
    endTurn();
    expect(column("kb_2")).toBe("ready");
  });

  it("a held review puts the card in Needs Review; Skip blocks it, Apply resumes it", () => {
    startTurn(buildCardExecutionPrompt(card("kb_1")!));
    const review = agent().addMessage({ role: "tool", text: "Delete 2 clips", tool: { name: "delete_clips", args: "{}", state: "pending" } });
    expect(card("kb_1")).toMatchObject({ column: "review", execution: { reviewCardId: review } });
    agent().updateMessage(review, { tool: { name: "delete_clips", args: "{}", state: "running" } });
    expect(card("kb_1")).toMatchObject({ column: "in_progress", execution: { reviewCardId: null } });
    const second = agent().addMessage({ role: "tool", text: "Delete 1 clip", tool: { name: "delete_clips", args: "{}", state: "pending" } });
    agent().updateMessage(second, { tool: { name: "delete_clips", args: "{}", state: "declined" } });
    expect(card("kb_1")).toMatchObject({ column: "blocked", execution: { reviewCardId: null, blockedReason: "Declined during edit review" } });
  });

  it("links edits to the turn's card (or the card they name) and reopens a done card whose edits are all reverted", () => {
    startTurn(buildCardExecutionPrompt(card("kb_1")!));
    const e1 = logEdit();
    const e2 = logEdit();
    kanban().updateCard("kb_1", { column: "done" });
    endTurn();
    const e3 = logEdit({ stepText: "[Kanban Task kb_2] Run card" });
    expect(card("kb_1")?.execution.editLogIds).toEqual([e1.id, e2.id]);
    expect(card("kb_2")?.execution.editLogIds).toEqual([e3.id]);
    const reverted = { at: 1, changedSince: 0, failed: 0, lost: [] };
    useEditLogStore.getState().markReverted(e1.id, reverted);
    expect(column("kb_1")).toBe("done");
    useEditLogStore.getState().markReverted(e2.id, reverted);
    expect(card("kb_1")).toMatchObject({ column: "ready", completedAt: null });
  });

  it("follows a background bot started in the card's turn, and finishes the card when it ends after the turn", () => {
    startTurn(buildCardExecutionPrompt(card("kb_1")!));
    useSidecarStore.getState().addJob({ id: "j-info", command: "media-info", label: "Media info" });
    useSidecarStore.getState().addJob({ id: "j1", command: "transcribe", label: "Transcribe 3 clips" });
    expect(card("kb_1")?.execution).toMatchObject({ activeJobId: "j1", mode: "background_bot" });
    endTurn();
    expect(column("kb_1")).toBe("in_progress");
    useSidecarStore.getState().applyEvent("j1", { type: "progress", fraction: 0.5, detail: "Clip 2 of 3" });
    expect(card("kb_1")?.execution.progress).toMatchObject({ fraction: 0.5, phase: "Clip 2 of 3" });
    useSidecarStore.getState().applyExit({ jobId: "j1", command: "transcribe", code: 0, cancelled: false } as never);
    expect(card("kb_1")).toMatchObject({ column: "done", execution: { activeJobId: null, progress: null, artifacts: ["Transcribe 3 clips: done"] } });
  });

  it("a failed background bot blocks its card with the job's error", () => {
    startTurn(buildCardExecutionPrompt(card("kb_1")!));
    useSidecarStore.getState().addJob({ id: "j2", command: "ingest-index", label: "Index bin" });
    endTurn();
    useSidecarStore.getState().fail("j2", "Ollama isn't running");
    expect(card("kb_1")).toMatchObject({ column: "blocked", execution: { blockedReason: "Ollama isn't running", activeJobId: null } });
  });

  it("a queued card dropped from the queue goes back to Ready", async () => {
    kanban().updateCard("kb_1", { column: "in_progress", execution: { progress: { fraction: null, phase: "Queued", etaSeconds: null } } });
    useAgentStore.setState({ queue: [{ id: "q1", text: buildCardExecutionPrompt(card("kb_1")!), images: [], mentions: [] }] });
    await vi.advanceTimersByTimeAsync(0);
    expect(column("kb_1")).toBe("in_progress");
    agent().clearQueue();
    await vi.advanceTimersByTimeAsync(0);
    expect(column("kb_1")).toBe("ready");
  });

  it("with auto-wave on, a finished card's turn sends the next runnable card", async () => {
    kanban().setAutoAdvanceWave(true);
    startTurn(buildCardExecutionPrompt(card("kb_1")!));
    kanban().updateCard("kb_1", { column: "done" });
    endTurn();
    await vi.advanceTimersByTimeAsync(0);
    expect(controller.submitMessage).toHaveBeenCalledWith(expect.stringMatching(/^\[Kanban Task kb_2\]/), [], expect.anything());
  });

  it("tells the agent the board, and nothing for an empty one", () => {
    expect(kanbanContext(emptyBoard("resolve", "Doc"))).toBe("");
    kanban().updateCard("kb_1", { column: "in_progress", timelineContext: { timeline: "Main", startSeconds: 15, endSeconds: 105 } });
    const text = kanbanContext(kanban().board);
    expect(text.split("\n")[0]).toBe('[KANBAN BOARD for "Doc" (0 backlog, 1 ready, 1 in_progress, 0 review, 0 done, 0 blocked)]');
    expect(text).toContain('- kb_1 [IN_PROGRESS | medium | transcript | Whisper STT (worker.whisper)] "Transcribe" (tl: Main 15.0s–105.0s)');
    expect(text).toContain("- kb_2 [READY | medium | cut | OTIO Cutter (worker.otio_cutter)] \"Cut\" (blockedBy: kb_1)");
    expect(text.endsWith("[END KANBAN BOARD]")).toBe(true);
  });

  it("keeps the board block under its cap", () => {
    kanban().planWorkflow(Array.from({ length: 30 }, (_, i) => ({ title: `A long card title number ${i} that takes some room`, category: "cut" as const })));
    const text = kanbanContext(kanban().board);
    expect(text.length).toBeLessThanOrEqual(2400);
    expect(text).toContain("more (kanban_list_cards lists them)");
  });
});

const SAVE_WAIT = 300;
