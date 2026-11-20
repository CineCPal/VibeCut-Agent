import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { nleState } from "../../test/nleFixtures";

const ipc = vi.hoisted(() => ({
  nleCall: vi.fn(),
  getKanbanBoard: vi.fn(async () => null),
  setKanbanBoard: vi.fn(async () => undefined),
}));
vi.mock("../../lib/ipc", () => ipc);
const runner = vi.hoisted(() => ({
  runKanbanCard: vi.fn(async (id: string) => ({ ok: true, message: `Started ${id}` })),
  runReadyWave: vi.fn(async () => ({ started: ["kb_1"], message: "Sent a wave of 1 card(s): kb_1" })),
  cardMention: (card: { id: string; title: string }) => ({ kind: "card", label: card.id, ref: card.id, detail: card.title }),
}));
vi.mock("../../lib/kanban/runner", () => runner);
const review = vi.hoisted(() => ({ answerReview: vi.fn(() => true) }));
vi.mock("../../lib/agent/review", () => review);

import { KanbanPanel } from "./KanbanPanel";
import { timeLabel } from "./KanbanCardItem";
import { resetKanbanStoreForTests, useKanbanStore } from "../../store/useKanbanStore";
import { initialHosts, useNleStateStore } from "../../store/useNleStateStore";
import { useAgentStore } from "../../store/useAgentStore";
import { useUiStore } from "../../store/useUiStore";
import { useEditLogStore } from "../../store/useEditLogStore";
import { emptyBoard } from "../../types/kanban";

const kanban = () => useKanbanStore.getState();

function connect(project: string | null) {
  const hosts = initialHosts();
  hosts.resolve = nleState("resolve", { project });
  useNleStateStore.setState({ hosts, preferredHost: "auto" });
}

function loadBoard(host: "resolve" | "global" = "resolve", project = "Doc") {
  useKanbanStore.setState({ loaded: true, scope: { host, project }, board: emptyBoard(host, project, 0), error: null });
}

describe("KanbanPanel", () => {
  beforeEach(() => {
    resetKanbanStoreForTests();
    vi.clearAllMocks();
    connect("Doc");
    loadBoard();
    useAgentStore.setState({ draft: "", draftMentions: [] });
    useUiStore.setState({ tab: "kanban" });
    useEditLogStore.setState({ entries: [] });
  });

  it("waits for the board, then shows an empty one with what to do", () => {
    useKanbanStore.setState({ loaded: false });
    const { rerender } = render(<KanbanPanel />);
    expect(screen.getByText("Opening the board…")).toBeInTheDocument();
    act(() => loadBoard());
    rerender(<KanbanPanel />);
    expect(screen.getByText("This board is empty.")).toBeInTheDocument();
    expect(screen.getByText("DaVinci Resolve · Doc")).toBeInTheDocument();
  });

  it("names the global board when no editor project is open, and keeps the editor buttons off", () => {
    connect(null);
    loadBoard("global", "Workspace");
    kanban().createCard({ title: "Plan the shoot", category: "story" });
    render(<KanbanPanel />);
    expect(screen.getByText("Global Workspace")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Sync markers/ })).toBeDisabled();
    expect(screen.getByRole("combobox", { name: "Seed from QC" })).toBeDisabled();
  });

  it("lays the cards out in six columns with their sub-agent, and counts the wave", () => {
    kanban().planWorkflow([
      { tempId: "a", title: "Transcribe", category: "transcript", priority: "high" },
      { title: "Cut the A-roll", category: "cut", blockedBy: ["a"], startSeconds: 42, endSeconds: 75.5 },
      { title: "Old idea", category: "audio", column: "backlog" },
    ]);
    render(<KanbanPanel />);
    for (const name of ["Backlog", "Ready", "In Progress", "Needs Review", "Done", "Blocked"]) expect(screen.getByRole("region", { name })).toBeInTheDocument();
    const ready = screen.getByRole("region", { name: "Ready" });
    expect(within(ready).getAllByRole("article")).toHaveLength(2);
    expect(within(ready).getByText("Whisper STT")).toBeInTheDocument();
    expect(within(ready).getByText("high")).toBeInTheDocument();
    expect(within(ready).getByText("Waiting on kb_1")).toBeInTheDocument();
    expect(within(ready).getByText("0:42–1:15.5")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Run wave \(1\)/ })).toBeEnabled();
    expect(screen.getByText("3 cards · 1 ready to run")).toBeInTheDocument();
  });

  it("runs a card and a wave", async () => {
    kanban().createCard({ title: "Transcribe", category: "transcript" });
    render(<KanbanPanel />);
    await act(async () => fireEvent.click(screen.getByRole("button", { name: /^Run$/ })));
    expect(runner.runKanbanCard).toHaveBeenCalledWith("kb_1");
    expect(screen.getByRole("status")).toHaveTextContent("Started kb_1");
    await act(async () => fireEvent.click(screen.getByRole("button", { name: /Run wave/ })));
    expect(runner.runReadyWave).toHaveBeenCalled();
    expect(screen.getByRole("status")).toHaveTextContent("Sent a wave of 1 card(s): kb_1");
  });

  it("filters by sub-agent and by text", () => {
    kanban().planWorkflow([
      { title: "Transcribe", category: "transcript" },
      { title: "Duck the music", category: "audio" },
    ]);
    render(<KanbanPanel />);
    fireEvent.click(screen.getByRole("button", { name: "Audio" }));
    expect(screen.getAllByRole("article").map((a) => a.getAttribute("aria-label"))).toEqual(["kb_2 Duck the music"]);
    fireEvent.click(screen.getByRole("button", { name: "All" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Search cards" }), { target: { value: "transc" } });
    expect(screen.getAllByRole("article").map((a) => a.getAttribute("aria-label"))).toEqual(["kb_1 Transcribe"]);
  });

  it("adds a card from the quick-add row", async () => {
    render(<KanbanPanel />);
    fireEvent.click(screen.getByRole("button", { name: /Add card/ }));
    fireEvent.change(screen.getByRole("textbox", { name: "Card title" }), { target: { value: "Grade the B-cam" } });
    fireEvent.change(screen.getByRole("combobox", { name: "Category" }), { target: { value: "color" } });
    fireEvent.change(screen.getByRole("combobox", { name: "Column" }), { target: { value: "backlog" } });
    await act(async () => {
      fireEvent.submit(screen.getByRole("form", { name: "Add a card" }));
    });
    expect(kanban().board.cards[0]).toMatchObject({ title: "Grade the B-cam", category: "color", column: "backlog", assignee: { label: "Colour Grader" }, createdBy: "user" });
    expect(screen.getByRole("status")).toHaveTextContent("Added kb_1 for Colour Grader");
    expect(screen.queryByRole("form", { name: "Add a card" })).not.toBeInTheDocument();
  });

  it("moves, deletes, and mentions a card in the chat", () => {
    kanban().createCard({ title: "Tighten pauses", category: "cut" });
    render(<KanbanPanel />);
    fireEvent.click(screen.getByRole("button", { name: "Move kb_1 right" }));
    expect(kanban().board.cards[0].column).toBe("in_progress");
    fireEvent.click(screen.getByRole("button", { name: "Chat about kb_1" }));
    expect(useAgentStore.getState().draft).toBe("@kb_1 ");
    expect(useAgentStore.getState().draftMentions).toEqual([{ kind: "card", label: "kb_1", ref: "kb_1", detail: "Tighten pauses" }]);
    expect(useUiStore.getState().tab).toBe("chat");
    fireEvent.click(screen.getByRole("button", { name: "Delete kb_1" }));
    expect(kanban().board.cards).toEqual([]);
  });

  it("answers a held review from the card, and shows live progress", () => {
    kanban().createCard({ title: "Cut", category: "cut", column: "review" });
    kanban().updateCard("kb_1", { execution: { reviewCardId: "msg-7" } });
    kanban().createCard({ title: "Transcribe", category: "transcript", column: "in_progress" });
    kanban().setProgress("kb_2", { fraction: 0.42, phase: "Clip 2 of 3", etaSeconds: 65 });
    render(<KanbanPanel />);
    fireEvent.click(screen.getByRole("button", { name: /Apply/ }));
    expect(review.answerReview).toHaveBeenCalledWith("msg-7", "apply");
    expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "42");
    expect(screen.getByText("Clip 2 of 3")).toBeInTheDocument();
    expect(screen.getByText(/42% · 1 min 05 s left/)).toBeInTheDocument();
  });

  it("toggles auto-wave and seeds from QC", async () => {
    ipc.nleCall.mockResolvedValue({ markers: [] });
    render(<KanbanPanel />);
    fireEvent.click(screen.getByRole("checkbox", { name: "Auto-wave" }));
    expect(kanban().board.autoAdvanceWave).toBe(true);
    await act(async () => fireEvent.change(screen.getByRole("combobox", { name: "Seed from QC" }), { target: { value: "client_notes" } }));
    // No markers on the timeline: the reason is shown, nothing is added.
    expect(screen.getByRole("status").textContent).not.toBe("");
    expect(kanban().board.cards).toEqual([]);
  });

  it("reads timeline positions as editors write them", () => {
    expect(timeLabel(42)).toBe("0:42");
    expect(timeLabel(75.5)).toBe("1:15.5");
    expect(timeLabel(3723)).toBe("1:02:03");
  });
});
