import { describe, expect, it } from "vitest";
import { createCardOn, deleteCardsOn, forSaving, normalizeBoard, planWorkflowOn, resolveAssignee, toggleChecklistOn, updateCardOn } from "./board";
import { DEFAULT_CATEGORY_ASSIGNEE, emptyBoard, type KanbanBoardFile } from "../../types/kanban";

const fresh = (): KanbanBoardFile => emptyBoard("resolve", "Doc", 0);

describe("Kanban board operations", () => {
  it("numbers cards kb_1, kb_2… and fills in the category's sub-agent", () => {
    const one = createCardOn(fresh(), { title: "  Transcribe   interviews ", category: "transcript", checklist: ["A cam", "B cam"] }, 10);
    expect(one.card).toMatchObject({
      id: "kb_1",
      title: "Transcribe interviews",
      column: "ready",
      priority: "medium",
      assignee: DEFAULT_CATEGORY_ASSIGNEE.transcript,
      checklist: [
        { id: "c1", text: "A cam", done: false },
        { id: "c2", text: "B cam", done: false },
      ],
      createdAt: 10,
      completedAt: null,
    });
    const two = createCardOn(one.board, { title: "Cut", category: "cut" });
    expect(two.card.id).toBe("kb_2");
    expect(two.board.nextCardSeq).toBe(3);
  });

  it("refuses bad cards with a reason", () => {
    expect(() => createCardOn(fresh(), { title: " ", category: "cut" })).toThrow("needs a title");
    expect(() => createCardOn(fresh(), { title: "x", category: "nope" as never })).toThrow("category must be one of");
    expect(() => createCardOn(fresh(), { title: "x", category: "cut", startSeconds: 5, endSeconds: 2 })).toThrow("after startSeconds");
    expect(() => createCardOn(fresh(), { title: "x", category: "cut", blockedBy: ["kb_9"] })).toThrow("isn't on the board");
  });

  it("resolves desks and roles, and refuses a desk of another role", () => {
    expect(resolveAssignee("cut", undefined, "app.timeline")).toEqual({ role: "PACING_CUTTER", stationKey: "app.timeline", label: "Timeline" });
    expect(resolveAssignee("cut", "AUDIO_ENGINEER")).toMatchObject({ role: "AUDIO_ENGINEER", stationKey: "app.audio_mix" });
    expect(resolveAssignee("audio", "AUDIO_ENGINEER")).toBe(DEFAULT_CATEGORY_ASSIGNEE.audio);
    expect(() => resolveAssignee("cut", "AUDIO_ENGINEER", "worker.whisper")).toThrow("INGEST_TRANSCRIBE desk");
    expect(() => resolveAssignee("cut", undefined, "app.nowhere")).toThrow("isn't a Studio desk");
  });

  it("plans a workflow, turning tempIds into card ids", () => {
    const start = createCardOn(fresh(), { title: "Existing", category: "ingest" }).board;
    const { board, created } = planWorkflowOn(
      start,
      [
        { tempId: "epic", title: "Deliver the 60 s cut", category: "story", column: "backlog" },
        { tempId: "t1", title: "Transcribe", category: "transcript", parentTempId: "epic", blockedBy: ["kb_1"] },
        { tempId: "t2", title: "Assemble soundbites", category: "cut", blockedBy: ["t1"], parentTempId: "epic" },
        { title: "Duck music", category: "audio", blockedBy: ["t2"] },
      ],
      { autoAdvanceWave: true },
      5,
    );
    expect(created.map((c) => [c.id, c.blockedBy, c.parentCardId])).toEqual([
      ["kb_2", [], null],
      ["kb_3", ["kb_1"], "kb_2"],
      ["kb_4", ["kb_3"], "kb_2"],
      ["kb_5", ["kb_4"], null],
    ]);
    expect(created[0].createdBy).toBe("orchestrator");
    expect(board.nextCardSeq).toBe(6);
    expect(board.autoAdvanceWave).toBe(true);
  });

  it("refuses a plan that loops, names an unknown card, or reuses a tempId", () => {
    expect(() =>
      planWorkflowOn(fresh(), [
        { tempId: "a", title: "A", category: "cut", blockedBy: ["b"] },
        { tempId: "b", title: "B", category: "cut", blockedBy: ["a"] },
      ]),
    ).toThrow("go round in a circle: kb_1 → kb_2 → kb_1");
    expect(() => planWorkflowOn(fresh(), [{ title: "A", category: "cut", blockedBy: ["t9"] }])).toThrow("neither a tempId");
    expect(() =>
      planWorkflowOn(fresh(), [
        { tempId: "a", title: "A", category: "cut" },
        { tempId: "a", title: "B", category: "cut" },
      ]),
    ).toThrow("used twice");
    expect(() => planWorkflowOn(fresh(), [])).toThrow("at least one card");
  });

  it("can clear Backlog and Ready before planning, keeping the counter", () => {
    let board = fresh();
    board = createCardOn(board, { title: "Old idea", category: "cut", column: "backlog" }).board;
    board = createCardOn(board, { title: "Done thing", category: "cut", column: "done" }).board;
    const planned = planWorkflowOn(board, [{ title: "New", category: "cut" }], { clearExisting: true });
    expect(planned.removed).toEqual(["kb_1"]);
    expect(planned.board.cards.map((c) => c.id)).toEqual(["kb_2", "kb_3"]);
  });

  it("stamps completedAt into Done and clears it on the way out, and refuses a loop", () => {
    let board = fresh();
    board = createCardOn(board, { title: "A", category: "cut" }).board;
    board = createCardOn(board, { title: "B", category: "cut", blockedBy: ["kb_1"] }).board;
    const done = updateCardOn(board, "kb_1", { column: "done" }, 50);
    expect(done.card.completedAt).toBe(50);
    expect(updateCardOn(done.board, "kb_1", { title: "A2" }, 60).card.completedAt).toBe(50);
    expect(updateCardOn(done.board, "kb_1", { column: "ready" }, 70).card.completedAt).toBeNull();
    expect(() => updateCardOn(board, "kb_1", { blockedBy: ["kb_2"] })).toThrow("circle");
    expect(() => updateCardOn(board, "kb_9", { title: "x" })).toThrow("isn't on the board");
    expect(updateCardOn(board, "kb_1", { execution: { blockedReason: "Drive offline" } }).card.execution).toMatchObject({ blockedReason: "Drive offline", editLogIds: [] });
  });

  it("deleting cards removes them from the rest's links", () => {
    let board = fresh();
    board = planWorkflowOn(board, [
      { tempId: "p", title: "Parent", category: "story" },
      { tempId: "a", title: "A", category: "cut", parentTempId: "p" },
      { title: "B", category: "cut", blockedBy: ["a", "p"] },
    ]).board;
    const { board: after, deleted } = deleteCardsOn(board, ["kb_1", "kb_2", "kb_77"]);
    expect(deleted).toEqual(["kb_1", "kb_2"]);
    expect(after.cards).toHaveLength(1);
    expect(after.cards[0]).toMatchObject({ id: "kb_3", blockedBy: [], parentCardId: null });
    expect(after.nextCardSeq).toBe(4);
  });

  it("toggles checklist items", () => {
    const board = createCardOn(fresh(), { title: "A", category: "cut", checklist: ["x", "y"] }).board;
    const toggled = toggleChecklistOn(board, "kb_1", "c2");
    expect(toggled.card.checklist.map((i) => i.done)).toEqual([false, true]);
    expect(() => toggleChecklistOn(board, "kb_1", "c9")).toThrow("no checklist item");
  });

  it("never saves live progress", () => {
    let board = createCardOn(fresh(), { title: "A", category: "cut" }).board;
    board = updateCardOn(board, "kb_1", { execution: { progress: { fraction: 0.5, phase: "x", etaSeconds: 3 } } }).board;
    expect(forSaving(board).cards[0].execution.progress).toBeNull();
    expect(board.cards[0].execution.progress).not.toBeNull();
  });

  it("reads a saved board defensively", () => {
    const board = normalizeBoard(
      {
        nextCardSeq: 2,
        cards: [
          { id: "kb_5", title: "Kept", column: "weird", category: "audio", blockedBy: ["kb_5", "kb_9", "kb_6"], execution: { editLogIds: ["e1", 3], progress: { fraction: 1 } } },
          { id: "kb_6", title: "Other" },
          { id: "bad id", title: "dropped" },
          { id: "kb_5", title: "duplicate dropped" },
          "nonsense",
        ],
      },
      "premiere",
      "Doc",
    );
    expect(board.cards.map((c) => c.id)).toEqual(["kb_5", "kb_6"]);
    expect(board.cards[0]).toMatchObject({ column: "backlog", blockedBy: ["kb_6"], assignee: DEFAULT_CATEGORY_ASSIGNEE.audio });
    expect(board.cards[0].execution).toMatchObject({ editLogIds: ["e1"], progress: null });
    expect(board.nextCardSeq).toBe(7);
    expect(board).toMatchObject({ host: "premiere", project: "Doc", schemaVersion: "vibecut.kanban.v1" });
    expect(() => normalizeBoard({ cards: "no" }, "resolve", "Doc")).toThrow("isn't a board");
  });
});
