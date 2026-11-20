import { describe, expect, it } from "vitest";
import { detectCycle, isCardExecutable, newlyUnblocked, readyWaveFrontier, unresolvedBlockers } from "./dag";
import { createCardOn } from "./board";
import { emptyBoard, type KanbanBoardFile, type KanbanCard, type KanbanColumnId, type KanbanPriority } from "../../types/kanban";

function boardOf(specs: { column?: KanbanColumnId; priority?: KanbanPriority; blockedBy?: string[]; at?: number }[]): KanbanCard[] {
  let board: KanbanBoardFile = emptyBoard("resolve", "Doc", 0);
  specs.forEach((spec, i) => {
    // Links are added after every card exists, so forward references are fine here.
    board = createCardOn(board, { title: `Card ${i + 1}`, category: "cut", column: spec.column, priority: spec.priority }, spec.at ?? i).board;
  });
  return board.cards.map((card, i) => ({ ...card, blockedBy: specs[i].blockedBy ?? [] }));
}

describe("the board's dependency graph", () => {
  it("only cards still on the board and not done block", () => {
    const cards = boardOf([{ column: "done" }, { column: "in_progress" }, { blockedBy: ["kb_1", "kb_2", "kb_99"] }]);
    expect(unresolvedBlockers(cards[2], cards).map((c) => c.id)).toEqual(["kb_2"]);
    expect(isCardExecutable(cards[2], cards)).toBe(false);
    const finished = cards.map((c) => (c.id === "kb_2" ? { ...c, column: "done" as const } : c));
    expect(isCardExecutable(finished[2], finished)).toBe(true);
  });

  it("only Ready cards are executable", () => {
    const cards = boardOf([{ column: "backlog" }, { column: "blocked" }, { column: "ready" }]);
    expect(cards.map((c) => isCardExecutable(c, cards))).toEqual([false, false, true]);
  });

  it("the wave frontier runs the most urgent first, then the oldest", () => {
    const cards = boardOf([
      { priority: "low", at: 1 },
      { priority: "critical", at: 5 },
      { priority: "high", at: 3 },
      { priority: "high", at: 2 },
      { priority: "critical", blockedBy: ["kb_1"], at: 0 },
      { column: "backlog", priority: "critical" },
    ]);
    expect(readyWaveFrontier(cards).map((c) => c.id)).toEqual(["kb_2", "kb_4", "kb_3", "kb_1"]);
  });

  it("finds loops and says which cards go round", () => {
    expect(detectCycle([{ id: "a", blockedBy: ["b"] }, { id: "b", blockedBy: ["c"] }, { id: "c", blockedBy: [] }])).toBeNull();
    expect(detectCycle([{ id: "a", blockedBy: ["b"] }, { id: "b", blockedBy: ["c"] }, { id: "c", blockedBy: ["a"] }])).toEqual(["a", "b", "c", "a"]);
    expect(detectCycle([{ id: "a", blockedBy: ["a"] }])).toEqual(["a", "a"]);
    // A link to a card that isn't there is not a loop.
    expect(detectCycle([{ id: "a", blockedBy: ["gone"] }])).toBeNull();
    // A diamond is fine.
    expect(detectCycle([{ id: "d", blockedBy: ["b", "c"] }, { id: "b", blockedBy: ["a"] }, { id: "c", blockedBy: ["a"] }, { id: "a", blockedBy: [] }])).toBeNull();
  });

  it("says which cards a finished card lets run", () => {
    const cards = boardOf([{ column: "done" }, { blockedBy: ["kb_1"] }, { blockedBy: ["kb_1", "kb_2"] }, { column: "backlog", blockedBy: ["kb_1"] }]);
    expect(newlyUnblocked("kb_1", cards).map((c) => c.id)).toEqual(["kb_2"]);
  });
});
