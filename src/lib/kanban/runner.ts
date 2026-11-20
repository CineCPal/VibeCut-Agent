/**
 * Runs Kanban cards (docs/specs/kanban-spec.md §4.4): one card, or the wave of Ready cards with nothing
 * left to wait on, each as a chat message to the editing agent or the supervising editor. A message that
 * can't go now waits in the chat's queue (at most MAX_QUEUE). The card is bound to the turn when its
 * message starts (lifecycleSync.ts), not here, so queued cards bind in the order they actually run.
 */
import { submitMessage } from "../agent/controller";
import { clock } from "../agent/args";
import { MAX_QUEUE, useAgentStore } from "../../store/useAgentStore";
import { useKanbanStore } from "../../store/useKanbanStore";
import type { ChatMention } from "../../types/agent";
import type { KanbanCard } from "../../types/kanban";
import { readyWaveFrontier, unresolvedBlockers } from "./dag";

/** The tag a card's message starts with; lifecycleSync reads it back to bind the turn. */
export const TASK_TAG = /^\[Kanban Task (kb_\d+)\]/;

/** The message that runs a card: its scope, instructions and open checklist, and how to report back. */
export function buildCardExecutionPrompt(card: KanbanCard): string {
  const ctx = card.timelineContext;
  const scope: string[] = [];
  if (ctx.timeline) scope.push(`timeline "${ctx.timeline}"`);
  if (ctx.startSeconds !== null && ctx.endSeconds !== null) scope.push(`range ${clock(ctx.startSeconds)}–${clock(ctx.endSeconds)}`);
  else if (ctx.startSeconds !== null) scope.push(`at ${clock(ctx.startSeconds)}`);
  if (ctx.tracks.length) scope.push(`tracks ${ctx.tracks.join(", ")}`);
  if (ctx.clipIds.length) scope.push(`clips ${ctx.clipIds.join(", ")}`);
  if (ctx.mediaPaths.length) scope.push(`files ${ctx.mediaPaths.join(", ")}`);
  const open = card.checklist.filter((item) => !item.done).map((item) => `  - [ ] ${item.text}`);
  const instructions = card.execution.autoPrompt?.trim() || card.description.trim() || card.title;
  return [
    `[Kanban Task ${card.id}] Run card @${card.id} ("${card.title}"), assigned to ${card.assignee.label} (${card.assignee.role} / ${card.assignee.stationKey}).`,
    scope.length ? `Target scope: ${scope.join(" · ")}.` : null,
    `Instructions: ${instructions}`,
    open.length ? `Remaining checklist:\n${open.join("\n")}` : null,
    `When it's finished, call kanban_update_card to move ${card.id} to "done" with what it produced (or to "blocked" with blockedReason if something stops it).`,
  ]
    .filter(Boolean)
    .join("\n");
}

/** The @-mention that tells the model exactly which card the message is about. */
export function cardMention(card: KanbanCard): ChatMention {
  return { kind: "card", label: card.id, ref: card.id, detail: `${card.title} · ${card.assignee.label}` };
}

const RUNNABLE = new Set<KanbanCard["column"]>(["backlog", "ready", "blocked"]);

/** Sends one card to the agent. Refused while it waits on unfinished cards, is already running, or is done. */
export async function runKanbanCard(cardId: string): Promise<{ ok: boolean; message: string }> {
  const store = useKanbanStore.getState();
  const card = store.loaded ? store.board.cards.find((c) => c.id === cardId) : undefined;
  if (!card) return { ok: false, message: store.loaded ? `${cardId} isn't on the board` : "The board is still loading" };
  if (!RUNNABLE.has(card.column)) {
    return { ok: false, message: card.column === "done" ? `${card.id} is already done` : `${card.id} is already running` };
  }
  const blockers = unresolvedBlockers(card, store.board.cards);
  if (blockers.length) return { ok: false, message: `${card.id} is waiting on ${blockers.map((b) => `${b.id} ("${b.title}")`).join(", ")}` };
  const outcome = await submitMessage(buildCardExecutionPrompt(card), [], [cardMention(card)]);
  if (!outcome) return { ok: false, message: "The agent can't take it now: it's offline, or its queue is full" };
  // The card may have changed while the message went; only its column and progress change here.
  if (useKanbanStore.getState().board.cards.some((c) => c.id === card.id)) {
    useKanbanStore.getState().updateCard(card.id, {
      column: "in_progress",
      execution: { blockedReason: null, progress: outcome === "queued" ? { fraction: null, phase: "Queued", etaSeconds: null } : null },
    });
  }
  return {
    ok: true,
    message: outcome === "queued" ? `Queued ${card.id} ("${card.title}")` : `Started ${card.id} ("${card.title}") with ${card.assignee.label}`,
  };
}

/** Sends every Ready card with nothing to wait on, most urgent first, as far as the chat's queue has room. */
export async function runReadyWave(): Promise<{ started: string[]; message: string }> {
  const store = useKanbanStore.getState();
  if (!store.loaded) return { started: [], message: "The board is still loading" };
  const frontier = readyWaveFrontier(store.board.cards);
  if (!frontier.length) {
    const waiting = store.board.cards.filter((c) => c.column === "ready").length;
    return {
      started: [],
      message: waiting ? `All ${waiting} Ready card(s) are waiting on cards that aren't done` : "No cards are in the Ready column",
    };
  }
  const agent = useAgentStore.getState();
  const room = MAX_QUEUE - agent.queue.length + (agent.status === "idle" && !agent.queue.length ? 1 : 0);
  const started: string[] = [];
  let problem: string | null = null;
  for (const card of frontier.slice(0, Math.max(0, room))) {
    const result = await runKanbanCard(card.id);
    if (!result.ok) {
      problem = result.message;
      break;
    }
    started.push(card.id);
  }
  const left = frontier.length - started.length;
  const parts = [
    started.length ? `Sent a wave of ${started.length} card(s): ${started.join(", ")}` : `Couldn't send the wave${problem ? `: ${problem}` : ""}`,
    left && started.length ? `${left} more wait for room in the chat's queue` : null,
  ];
  return { started, message: parts.filter(Boolean).join("; ") };
}
