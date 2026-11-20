import { beforeEach, describe, expect, it, vi } from "vitest";
import { nleState } from "../../test/nleFixtures";
import type { HostMarker } from "../../types/timeline";

const ipc = vi.hoisted(() => ({
  nleCall: vi.fn(),
  getKanbanBoard: vi.fn(async () => null),
  setKanbanBoard: vi.fn(async () => undefined),
}));
vi.mock("../ipc", () => ipc);
const finders = vi.hoisted(() => ({ review: vi.fn(), pacing: vi.fn(), notes: vi.fn() }));
vi.mock("./reviewTools", () => ({ reviewExecutors: () => ({ review_edit: finders.review }) }));
vi.mock("./pacingTools", () => ({ pacingExecutors: () => ({ check_pacing: finders.pacing }) }));
vi.mock("./clientNotesTools", () => ({ DONE_MARK: "✓ ", clientNotesExecutors: () => ({ read_client_notes: finders.notes }) }));

import { classifyFinding, kanbanExecutors, kanbanToolDeclarations, markerName, MARKER_COLORS } from "./kanbanTools";
import { needsReview } from "./toolKinds";
import { resetKanbanStoreForTests, useKanbanStore } from "../../store/useKanbanStore";
import { initialHosts, useNleStateStore } from "../../store/useNleStateStore";
import type { ToolContext } from "./tools";

const CTX: ToolContext = { host: "resolve", timeline: "Main", step: "m1", stepText: "plan it" };
const tools = () => kanbanExecutors(CTX);
const kanban = () => useKanbanStore.getState();
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const result = (outcome: { result: unknown }) => outcome.result as any;

function editorMarkers(markers: HostMarker[]) {
  const calls: { command: string; args: Record<string, unknown> }[] = [];
  ipc.nleCall.mockImplementation(async (_host: string, command: string, args: Record<string, unknown>) => {
    calls.push({ command, args });
    if (command === "list_markers") return { markers };
    if (command === "add_markers") {
      const added = (args.markers as { time: number; name: string }[]).map((m, i) => ({ id: `m${100 + i}`, time: m.time, name: m.name }));
      return { added, alreadyThere: [], refusedAt: [] };
    }
    if (command === "update_marker") return { id: args.markerId, time: 0, name: args.name };
    throw new Error(`unexpected ${command}`);
  });
  return calls;
}

const marker = (over: Partial<HostMarker>): HostMarker => ({ id: "m1", time: 10, name: "", color: "Blue", note: "", duration: 0, ...over });

describe("the Kanban tools", () => {
  beforeEach(() => {
    resetKanbanStoreForTests();
    vi.clearAllMocks();
    const hosts = initialHosts();
    hosts.resolve = nleState("resolve", { project: "Doc" });
    useNleStateStore.setState({ hosts, preferredHost: "auto" });
  });

  it("declares seven tools with literal names, enums only on strings, and reviews only marker sync", () => {
    const declarations = kanbanToolDeclarations();
    expect(declarations.map((d) => d.name)).toEqual([
      "kanban_list_cards",
      "kanban_plan_workflow",
      "kanban_create_card",
      "kanban_update_card",
      "kanban_delete_cards",
      "kanban_seed_from_findings",
      "kanban_sync_markers",
    ]);
    expect(declarations.filter((d) => needsReview(d.name)).map((d) => d.name)).toEqual(["kanban_sync_markers"]);
  });

  it("loads the connected project's board before the first change", async () => {
    await tools().kanban_create_card({ title: "Transcribe", category: "transcript" });
    expect(ipc.getKanbanBoard).toHaveBeenCalledWith("resolve", "Doc");
    expect(kanban().scope).toEqual({ host: "resolve", project: "Doc" });
    expect(kanban().board.cards[0]).toMatchObject({ id: "kb_1", assignee: { role: "INGEST_TRANSCRIBE", stationKey: "worker.whisper" } });
    expect(ipc.setKanbanBoard).toHaveBeenCalled();
  });

  it("refuses without an editor project", async () => {
    useNleStateStore.setState({ hosts: initialHosts() });
    await expect(tools().kanban_list_cards({})).rejects.toThrow("No project is open");
  });

  it("plans a workflow and says what can run first", async () => {
    const outcome = await tools().kanban_plan_workflow({
      autoAdvanceWave: true,
      cards: [
        { tempId: "t1", title: "Transcribe the interviews", category: "transcript", checklist: ["A cam", "B cam"] },
        { tempId: "t2", title: "Assemble soundbites", category: "story", blockedBy: ["t1"] },
        { tempId: "t3", title: "Duck music", category: "audio", blockedBy: ["t2"], startSeconds: 12, endSeconds: 40 },
      ],
    });
    expect(result(outcome).tempIds).toEqual({ t1: "kb_1", t2: "kb_2", t3: "kb_3" });
    expect(result(outcome).frontier).toEqual(["kb_1"]);
    expect(result(outcome).created[2]).toMatchObject({ id: "kb_3", blockedBy: ["kb_2"], waitingOn: ["kb_2"], startSeconds: 12, endSeconds: 40 });
    expect(kanban().board.autoAdvanceWave).toBe(true);
    await expect(tools().kanban_plan_workflow({ cards: [{ tempId: "a", title: "A", category: "cut", blockedBy: ["a"] }] })).rejects.toThrow("can't wait on itself");
  });

  it("updates a card, binds the turn when started, and says what finishing it unblocks", async () => {
    await tools().kanban_plan_workflow({
      cards: [
        { tempId: "a", title: "Cut", category: "cut", checklist: ["Trim pauses", "Keep the laugh"] },
        { tempId: "b", title: "Mix", category: "audio", blockedBy: ["a"] },
      ],
    });
    await tools().kanban_update_card({ cardId: "kb_1", column: "in_progress" });
    expect(kanban().activeTurnCardId).toBe("kb_1");
    const done = await tools().kanban_update_card({ cardId: "kb_1", column: "done", editLogIds: ["e4"], artifacts: ["Cut.otio"], checkItemsDone: ["c1", "keep the laugh"] });
    expect(result(done).unblocked).toEqual(["kb_2"]);
    expect(done.summary).toContain("kb_2 can run now");
    expect(kanban().activeTurnCardId).toBeNull();
    expect(kanban().board.cards[0]).toMatchObject({ column: "done", execution: { editLogIds: ["e4"], artifacts: ["Cut.otio"] } });
    expect(kanban().board.cards[0].checklist.every((i) => i.done)).toBe(true);
    await tools().kanban_update_card({ cardId: "kb_2", column: "blocked", blockedReason: "Music file offline" });
    expect(kanban().board.cards[1].execution.blockedReason).toBe("Music file offline");
    await tools().kanban_update_card({ cardId: "kb_2", column: "ready" });
    expect(kanban().board.cards[1].execution.blockedReason).toBeNull();
    await tools().kanban_update_card({ cardId: "kb_2", stationKey: "app.audio_repair" });
    expect(kanban().board.cards[1].assignee).toMatchObject({ role: "AUDIO_ENGINEER", stationKey: "app.audio_repair", label: "Repair" });
    await expect(tools().kanban_update_card({ cardId: "kb_9", column: "done" })).rejects.toThrow("isn't on the board");
    await expect(tools().kanban_update_card({ cardId: "kb_1", checkItemsDone: ["nope"] })).rejects.toThrow("no checklist item nope");
    await expect(tools().kanban_update_card({ cardId: "kb_1" })).rejects.toThrow("Nothing to change");
  });

  it("lists with filters, and deletes or clears done cards", async () => {
    await tools().kanban_plan_workflow({
      cards: [
        { title: "A", category: "cut", column: "backlog" },
        { title: "B", category: "audio" },
      ],
    });
    await tools().kanban_update_card({ cardId: "kb_2", column: "done" });
    const listed = await tools().kanban_list_cards({ includeDone: false });
    expect(result(listed).cards.map((c: { id: string }) => c.id)).toEqual(["kb_1"]);
    expect(result(listed).counts).toMatchObject({ backlog: 1, done: 1 });
    expect(result(await tools().kanban_list_cards({ assigneeRole: "AUDIO_ENGINEER" })).cards).toHaveLength(1);
    const cleared = await tools().kanban_delete_cards({ clearDone: true, cardIds: ["kb_77"] });
    expect(result(cleared)).toMatchObject({ deleted: ["kb_2"], notOnBoard: ["kb_77"] });
    await expect(tools().kanban_delete_cards({})).rejects.toThrow("Give cardIds");
  });

  it("seeds cards from the automatic check, each to the sub-agent for its kind of problem, skipping ones already there", async () => {
    finders.review.mockResolvedValue({
      summary: "Reviewed the cut: 3 problem(s)",
      result: {
        automaticCheck: [
          { time: 4, severity: "high", category: "flash_frame", message: "A 1-frame flash at 4.0s", clipIds: ["c2"] },
          { time: 20, end: 30, severity: "medium", category: "loudness", message: "Too loud: -9 LUFS", clipIds: [] },
          { time: 50, severity: "low", category: "mid_word_cut", message: "Cut mid-word", clipIds: ["c5"] },
        ],
      },
    });
    const outcome = await tools().kanban_seed_from_findings({ source: "review_edit" });
    expect(finders.review).toHaveBeenCalledWith({ visual: false });
    const cards = kanban().board.cards;
    expect(cards.map((c) => [c.title, c.category, c.assignee.stationKey, c.priority, c.createdBy])).toEqual([
      ["A 1-frame flash at 4.0s", "qc", "worker.color_nle", "high", "qc_lint"],
      ["Too loud: -9 LUFS", "audio", "app.audio_mix", "medium", "qc_lint"],
      ["Cut mid-word", "cut", "worker.otio_cutter", "low", "qc_lint"],
    ]);
    expect(cards[1].timelineContext).toMatchObject({ timeline: "Main", startSeconds: 20, endSeconds: 30 });
    expect(outcome.summary).toContain("Added 3 card(s) to ready");
    const again = await tools().kanban_seed_from_findings({ source: "review_edit", targetColumn: "backlog" });
    expect(result(again)).toMatchObject({ created: [], skipped: 3 });
  });

  it("seeds from pacing and from client notes (pasted, or the timeline's markers)", async () => {
    finders.pacing.mockResolvedValue({ summary: "Pacing of Main", result: { findings: [{ time: 60, end: 75, severity: "medium", category: "dead_air", message: "15 s of dead air", clipIds: [] }] } });
    await tools().kanban_seed_from_findings({ source: "check_pacing" });
    expect(kanban().board.cards[0]).toMatchObject({ category: "audio", assignee: { role: "AUDIO_ENGINEER" } });

    finders.notes.mockResolvedValue({
      summary: "2 client note(s)",
      result: { notes: [{ time: 42, text: "Logo too small" }, { time: 80, text: "Add b-roll of the lab here" }, { time: 900, text: "x", problem: "past the end" }], general: ["Music feels slow overall"] },
    });
    await tools().kanban_seed_from_findings({ source: "client_notes", notesText: "0:42 logo too small" });
    expect(finders.notes).toHaveBeenCalledWith({ text: "0:42 logo too small" });
    expect(kanban().board.cards.slice(1).map((c) => [c.title, c.category, c.createdBy])).toEqual([
      ["Logo too small", "gfx", "client_notes"],
      ["Add b-roll of the lab here", "broll", "client_notes"],
      ["Music feels slow overall", "audio", "client_notes"],
    ]);
    await tools().kanban_seed_from_findings({ source: "client_notes" });
    expect(finders.notes).toHaveBeenLastCalledWith({ fromMarkers: true });
  });

  it("classifies findings and notes", () => {
    expect(classifyFinding("true_peak", "").category).toBe("audio");
    expect(classifyFinding("slow_opening", "").category).toBe("cut");
    expect(classifyFinding("", "the grade is too dark").category).toBe("color");
    expect(classifyFinding("", "tighten this").category).toBe("cut");
  });

  it("pushes time-ranged cards to the timeline as colour-coded markers, and updates them as they move", async () => {
    await tools().kanban_plan_workflow({
      cards: [
        { title: "Fix the flash", category: "qc", startSeconds: 4 },
        { title: "No time", category: "cut" },
        { title: "Other timeline", category: "cut", timeline: "Alt", startSeconds: 9 },
        { title: "Ducking", category: "audio", startSeconds: 20, endSeconds: 30, column: "in_progress" },
      ],
    });
    let calls = editorMarkers([]);
    const pushed = await tools().kanban_sync_markers({ direction: "board_to_timeline" });
    const add = calls.find((c) => c.command === "add_markers")!;
    expect(add.args.markers).toEqual([
      { time: 4, name: "[kb_1] Fix the flash", color: "Yellow" },
      { time: 20, name: "[kb_4] Ducking", color: "Cyan", duration: 10 },
    ]);
    expect(result(pushed).added).toEqual(["kb_1", "kb_4"]);
    expect(kanban().board.cards[0].timelineContext.markerId).toBe("m100");

    await tools().kanban_update_card({ cardId: "kb_1", column: "done" });
    calls = editorMarkers([marker({ id: "m100", time: 4, name: "[kb_1] Fix the flash", color: "Yellow" }), marker({ id: "m101", time: 20, name: "[kb_4] Ducking", color: "Cyan" })]);
    await tools().kanban_sync_markers({ direction: "board_to_timeline", includeDone: true });
    expect(calls.filter((c) => c.command === "update_marker").map((c) => c.args)).toEqual([{ timeline: "Main", markerId: "m100", name: "✓ [kb_1] Fix the flash", color: MARKER_COLORS.done }]);
    expect(calls.some((c) => c.command === "add_markers")).toBe(false);
  });

  it("pulls ticked board markers and TODO markers into the board", async () => {
    await tools().kanban_create_card({ title: "Fix the flash", category: "qc", startSeconds: 4, column: "in_progress" });
    editorMarkers([
      marker({ id: "m1", time: 4, name: "✓ [kb_1] Fix the flash" }),
      marker({ id: "m2", time: 30, name: "FIX: logo is soft", note: "client" }),
      marker({ id: "m3", time: 45, name: "Just a marker" }),
    ]);
    const pulled = await tools().kanban_sync_markers({ direction: "timeline_to_board" });
    expect(result(pulled)).toMatchObject({ markedDone: ["kb_1"], imported: ["kb_2"] });
    expect(kanban().board.cards[1]).toMatchObject({ title: "logo is soft", column: "backlog", priority: "high", category: "gfx", timelineContext: { startSeconds: 30, markerId: "m2" } });
    // Pulling again imports nothing new, and the user's own TODO marker is never renamed by a push.
    const calls = editorMarkers([marker({ id: "m1", time: 4, name: "✓ [kb_1] Fix the flash", color: "Green" }), marker({ id: "m2", time: 30, name: "FIX: logo is soft" })]);
    const both = await tools().kanban_sync_markers({});
    expect(result(both).imported).toEqual([]);
    expect(calls.filter((c) => c.command !== "list_markers")).toEqual([]);
  });

  it("names board markers with the card id first", async () => {
    await tools().kanban_create_card({ title: "A".repeat(200), category: "cut" });
    const name = markerName(kanban().board.cards[0]);
    expect(name.startsWith("[kb_1] ")).toBe(true);
    expect(name.length).toBeLessThanOrEqual(80);
    await expect(kanbanExecutors({ ...CTX, timeline: null }).kanban_sync_markers({})).rejects.toThrow("No timeline is open");
  });
});
