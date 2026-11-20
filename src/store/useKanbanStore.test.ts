import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { nleState } from "../test/nleFixtures";
import type { KanbanBoardFile } from "../types/kanban";

const ipc = vi.hoisted(() => ({
  getKanbanBoard: vi.fn(),
  setKanbanBoard: vi.fn(),
}));
vi.mock("../lib/ipc", () => ipc);

import { SAVE_DELAY_MS, activeScope, resetKanbanStoreForTests, useKanbanStore } from "./useKanbanStore";
import { initialHosts, useNleStateStore } from "./useNleStateStore";

const store = () => useKanbanStore.getState();

function connect(project: string | null) {
  const hosts = initialHosts();
  hosts.resolve = nleState("resolve", { project });
  useNleStateStore.setState({ hosts, preferredHost: "auto" });
}

describe("useKanbanStore", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetKanbanStoreForTests();
    ipc.getKanbanBoard.mockReset().mockResolvedValue(null);
    ipc.setKanbanBoard.mockReset().mockResolvedValue(undefined);
    connect("Doc");
  });
  afterEach(() => vi.useRealTimers());

  it("uses the editor's project, or the global board without one", () => {
    expect(activeScope()).toEqual({ host: "resolve", project: "Doc" });
    connect(null);
    expect(activeScope()).toEqual({ host: "global", project: "Workspace" });
    useNleStateStore.setState({ hosts: initialHosts() });
    expect(activeScope()).toEqual({ host: "global", project: "Workspace" });
  });

  it("loads the project's board, fresh when it has none", async () => {
    await store().loadForActiveProject();
    expect(ipc.getKanbanBoard).toHaveBeenCalledWith("resolve", "Doc");
    expect(store()).toMatchObject({ loaded: true, scope: { host: "resolve", project: "Doc" } });
    expect(store().board).toMatchObject({ host: "resolve", project: "Doc", nextCardSeq: 1, cards: [] });
    // The same project again doesn't read again.
    await store().loadForActiveProject();
    expect(ipc.getKanbanBoard).toHaveBeenCalledTimes(1);
  });

  it("refuses changes until the board is loaded", () => {
    expect(() => store().createCard({ title: "A", category: "cut" })).toThrow("still loading");
  });

  it("saves a burst of changes once, without live progress", async () => {
    await store().loadForActiveProject();
    const card = store().createCard({ title: "Tighten pauses", category: "cut" });
    store().updateCard(card.id, { priority: "high" });
    store().setProgress(card.id, { fraction: 0.4, phase: "Cutting", etaSeconds: 9 });
    expect(ipc.setKanbanBoard).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(SAVE_DELAY_MS);
    expect(ipc.setKanbanBoard).toHaveBeenCalledTimes(1);
    const [host, project, saved] = ipc.setKanbanBoard.mock.calls[0] as [string, string, KanbanBoardFile];
    expect([host, project]).toEqual(["resolve", "Doc"]);
    expect(saved.cards[0]).toMatchObject({ id: "kb_1", priority: "high" });
    expect(saved.cards[0].execution.progress).toBeNull();
    expect(store().board.cards[0].execution.progress).toMatchObject({ fraction: 0.4 });
  });

  it("saves the board being left under its own project before switching", async () => {
    await store().loadForActiveProject();
    store().createCard({ title: "Doc's card", category: "cut" });
    ipc.getKanbanBoard.mockResolvedValueOnce({ schemaVersion: "vibecut.kanban.v1", nextCardSeq: 4, cards: [{ id: "kb_3", title: "Other's" }] });
    connect("Other");
    await store().loadForActiveProject();
    expect(ipc.setKanbanBoard).toHaveBeenCalledTimes(1);
    expect(ipc.setKanbanBoard.mock.calls[0].slice(0, 2)).toEqual(["resolve", "Doc"]);
    expect(store().scope).toEqual({ host: "resolve", project: "Other" });
    expect(store().board.cards.map((c) => c.id)).toEqual(["kb_3"]);
    expect(store().createCard({ title: "Next", category: "cut" }).id).toBe("kb_4");
  });

  it("drops a slow read for a project the editor has since left", async () => {
    let finishFirst: (value: unknown) => void = () => undefined;
    ipc.getKanbanBoard.mockImplementationOnce(() => new Promise((resolve) => (finishFirst = resolve)));
    const first = store().loadScope({ host: "resolve", project: "Doc" });
    await vi.advanceTimersByTimeAsync(0);
    await store().loadScope({ host: "global", project: "Workspace" });
    finishFirst({ schemaVersion: "vibecut.kanban.v1", nextCardSeq: 2, cards: [{ id: "kb_1", title: "stale" }] });
    await first;
    expect(store().scope.host).toBe("global");
    expect(store().board.cards).toEqual([]);
  });

  it("an unreadable board starts empty and says so", async () => {
    ipc.getKanbanBoard.mockRejectedValueOnce(new Error("Couldn't read the project's Kanban board: bad JSON"));
    await store().loadForActiveProject();
    expect(store().loaded).toBe(true);
    expect(store().error).toContain("starts empty");
    expect(store().board.cards).toEqual([]);
  });

  it("a failed save is shown, and cleared by the next one that works", async () => {
    await store().loadForActiveProject();
    ipc.setKanbanBoard.mockRejectedValueOnce(new Error("A Kanban board can hold at most 512 KB"));
    store().createCard({ title: "A", category: "cut" });
    await store().flush();
    expect(store().error).toContain("512 KB");
    store().createCard({ title: "B", category: "cut" });
    await store().flush();
    expect(store().error).toBeNull();
  });

  it("plans, deletes and clears done cards", async () => {
    await store().loadForActiveProject();
    const { created } = store().planWorkflow([
      { tempId: "a", title: "A", category: "transcript" },
      { tempId: "b", title: "B", category: "cut", blockedBy: ["a"] },
    ]);
    expect(created.map((c) => c.id)).toEqual(["kb_1", "kb_2"]);
    store().updateCard("kb_1", { column: "done" });
    expect(store().clearDoneCards()).toEqual(["kb_1"]);
    expect(store().board.cards[0]).toMatchObject({ id: "kb_2", blockedBy: [] });
    store().setAutoAdvanceWave(true);
    expect(store().board.autoAdvanceWave).toBe(true);
  });

  it("unbinds the turn's card when it's done or blocked, or deleted", async () => {
    await store().loadForActiveProject();
    store().createCard({ title: "A", category: "cut" });
    store().setActiveTurnCardId("kb_1");
    store().updateCard("kb_1", { column: "in_progress" });
    expect(store().activeTurnCardId).toBe("kb_1");
    store().updateCard("kb_1", { column: "blocked" });
    expect(store().activeTurnCardId).toBeNull();
    store().setActiveTurnCardId("kb_1");
    store().deleteCards(["kb_1"]);
    expect(store().activeTurnCardId).toBeNull();
  });

  it("records an orchestrated commit on its card and finishes it", async () => {
    await store().loadForActiveProject();
    store().createCard({ title: "Cut", category: "cut", column: "in_progress" });
    const card = store().recordCardCommit("kb_1", { editId: "e4", deltaId: "d1", validationToken: "vtok_abc", otioPath: "/tmp/a.otio" });
    expect(card).toMatchObject({ column: "done", execution: { editLogIds: ["e4"], deltaId: "d1", validationToken: "vtok_abc", artifacts: ["/tmp/a.otio"] } });
    // Recording the same edit again doesn't double it; a Backlog card keeps its column.
    expect(store().recordCardCommit("kb_1", { editId: "e4" })?.execution.editLogIds).toEqual(["e4"]);
    store().createCard({ title: "Later", category: "cut", column: "backlog" });
    expect(store().recordCardCommit("kb_2", { editId: "e5" })?.column).toBe("backlog");
    expect(store().recordCardCommit("kb_9", { editId: "e6" })).toBeNull();
  });
});
