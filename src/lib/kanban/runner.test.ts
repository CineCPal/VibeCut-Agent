import { beforeEach, describe, expect, it, vi } from "vitest";

const controller = vi.hoisted(() => ({ submitMessage: vi.fn() }));
vi.mock("../agent/controller", () => controller);
vi.mock("../ipc", () => ({ getKanbanBoard: vi.fn(), setKanbanBoard: vi.fn(async () => undefined) }));

import { buildCardExecutionPrompt, cardMention, runKanbanCard, runReadyWave, TASK_TAG } from "./runner";
import { keptMentions } from "../agent/mentions";
import { resetKanbanStoreForTests, useKanbanStore } from "../../store/useKanbanStore";
import { useAgentStore } from "../../store/useAgentStore";
import { emptyBoard } from "../../types/kanban";

const store = () => useKanbanStore.getState();

describe("the Kanban runner", () => {
  beforeEach(() => {
    resetKanbanStoreForTests();
    useKanbanStore.setState({ loaded: true, scope: { host: "resolve", project: "Doc" }, board: emptyBoard("resolve", "Doc", 0) });
    useAgentStore.setState({ status: "idle", queue: [], queuePaused: false });
    controller.submitMessage.mockReset().mockResolvedValue("sent");
  });

  it("asks for the card with its scope, instructions and open checklist", () => {
    const card = store().createCard({
      title: "Tighten pauses",
      category: "cut",
      timeline: "Main",
      startSeconds: 15,
      endSeconds: 105,
      tracks: ["V1", "A1"],
      checklist: ["Keep the laugh", "Under 60 s"],
      autoPrompt: "Remove pauses over 0.4 s",
    });
    store().toggleChecklistItem(card.id, "c1");
    const prompt = buildCardExecutionPrompt(store().board.cards[0]);
    expect(TASK_TAG.exec(prompt)?.[1]).toBe("kb_1");
    expect(prompt).toContain('Run card @kb_1 ("Tighten pauses"), assigned to OTIO Cutter (PACING_CUTTER / worker.otio_cutter)');
    expect(prompt).toContain('Target scope: timeline "Main" · range 15.0s–105.0s · tracks V1, A1.');
    expect(prompt).toContain("Instructions: Remove pauses over 0.4 s");
    expect(prompt).toContain("  - [ ] Under 60 s");
    expect(prompt).not.toContain("Keep the laugh");
    expect(prompt).toContain('move kb_1 to "done"');
  });

  it("its mention survives the chat's check that the @ is in the text", () => {
    const card = store().createCard({ title: "A", category: "cut" });
    expect(keptMentions(buildCardExecutionPrompt(card), [cardMention(card)])).toHaveLength(1);
  });

  it("runs a card: Active when sent, Active and Queued when it waits", async () => {
    store().createCard({ title: "A", category: "cut" });
    store().createCard({ title: "B", category: "cut" });
    expect(await runKanbanCard("kb_1")).toMatchObject({ ok: true, message: expect.stringContaining("Started kb_1") });
    expect(store().board.cards[0]).toMatchObject({ column: "in_progress", execution: { progress: null } });
    controller.submitMessage.mockResolvedValueOnce("queued");
    expect(await runKanbanCard("kb_2")).toMatchObject({ ok: true, message: 'Queued kb_2 ("B")' });
    expect(store().board.cards[1].execution.progress).toMatchObject({ phase: "Queued" });
  });

  it("refuses cards waiting on others, running, done, or that the agent can't take", async () => {
    store().planWorkflow([
      { tempId: "a", title: "A", category: "cut" },
      { tempId: "b", title: "B", category: "cut", blockedBy: ["a"] },
    ]);
    expect(await runKanbanCard("kb_2")).toEqual({ ok: false, message: 'kb_2 is waiting on kb_1 ("A")' });
    store().updateCard("kb_1", { column: "in_progress" });
    expect((await runKanbanCard("kb_1")).message).toBe("kb_1 is already running");
    store().updateCard("kb_1", { column: "done" });
    expect((await runKanbanCard("kb_1")).message).toBe("kb_1 is already done");
    controller.submitMessage.mockResolvedValueOnce(false);
    expect(await runKanbanCard("kb_2")).toMatchObject({ ok: false });
    expect(store().board.cards[1].column).toBe("ready");
    expect((await runKanbanCard("kb_9")).message).toBe("kb_9 isn't on the board");
    expect(controller.submitMessage).toHaveBeenCalledTimes(1);
  });

  it("a wave sends the frontier in priority order, as far as the queue has room", async () => {
    store().planWorkflow([
      { tempId: "low", title: "Low", category: "cut", priority: "low" },
      { title: "Critical", category: "cut", priority: "critical" },
      { title: "Waits", category: "cut", blockedBy: ["low"] },
    ]);
    const result = await runReadyWave();
    expect(result.started).toEqual(["kb_2", "kb_1"]);
    expect(controller.submitMessage.mock.calls.map((c) => TASK_TAG.exec(c[0] as string)?.[1])).toEqual(["kb_2", "kb_1"]);

    // A busy agent with a nearly full queue takes only what fits.
    resetKanbanStoreForTests();
    useKanbanStore.setState({ loaded: true, board: emptyBoard("resolve", "Doc", 0) });
    store().planWorkflow([1, 2, 3].map((n) => ({ title: `Card ${n}`, category: "cut" as const })));
    useAgentStore.setState({ status: "thinking", queue: [1, 2, 3, 4].map((n) => ({ id: `q${n}`, text: "x", images: [], mentions: [] })) });
    controller.submitMessage.mockResolvedValue("queued");
    const busy = await runReadyWave();
    expect(busy.started).toEqual(["kb_1"]);
    expect(busy.message).toContain("2 more wait for room");
  });

  it("says why there's no wave", async () => {
    expect((await runReadyWave()).message).toBe("No cards are in the Ready column");
    store().planWorkflow([
      { tempId: "a", title: "A", category: "cut", column: "backlog" },
      { title: "B", category: "cut", blockedBy: ["a"] },
    ]);
    expect((await runReadyWave()).message).toBe("All 1 Ready card(s) are waiting on cards that aren't done");
  });
});
