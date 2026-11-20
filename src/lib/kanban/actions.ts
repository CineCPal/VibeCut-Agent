/**
 * What the board's buttons do (PLAN.md "Phase 23"), shared by the main window's Board tab
 * (components/kanban/) and the panels' Board tab (hostChatBridge.ts), so both behave the same. Each
 * returns a line to show; none throws.
 */
import { nleCall } from "../ipc";
import { answerReview } from "../agent/review";
import { revertTimelineEdits } from "../agent/edits";
import { kanbanExecutors } from "../agent/kanbanTools";
import type { ToolContext } from "../agent/tools";
import { useAgentStore } from "../../store/useAgentStore";
import { useEditLogStore } from "../../store/useEditLogStore";
import { useKanbanStore } from "../../store/useKanbanStore";
import { useNleStateStore } from "../../store/useNleStateStore";
import { useUiStore } from "../../store/useUiStore";
import { NLE_HOSTS, NLE_LABELS, type NleHost } from "../../types/nle";
import { KANBAN_COLUMNS, KANBAN_COLUMN_META, type KanbanCard, type KanbanColumnId } from "../../types/kanban";
import { cardMention } from "./runner";

export interface ActionResult {
  ok: boolean;
  message: string;
}

const describe = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** The connected editor whose project the board on show is, or null (the global board, or no editor). */
export function boardHost(): NleHost | null {
  const { scope, loaded } = useKanbanStore.getState();
  const hosts = useNleStateStore.getState().hosts;
  if (!loaded) return null;
  return NLE_HOSTS.find((h) => h === scope.host && hosts[h].status === "connected" && hosts[h].project?.trim() === scope.project) ?? null;
}

/** A tool context for the board's own buttons: the board's editor and its open timeline. */
export function boardToolContext(): ToolContext | null {
  const host = boardHost();
  if (!host) return null;
  return { host, timeline: useNleStateStore.getState().hosts[host].timeline, step: `kanban-${Date.now()}`, stepText: "Kanban board" };
}

/** "Resolve · VibeCut 7a", or "Global Workspace". */
export function boardLabel(): string {
  const { scope } = useKanbanStore.getState();
  return scope.host === "global" ? "Global Workspace" : `${NLE_LABELS[scope.host]} · ${scope.project}`;
}

const NO_EDITOR = "Open the project in Premiere or Resolve first";

async function runTool(name: "kanban_seed_from_findings" | "kanban_sync_markers", args: Record<string, unknown>): Promise<ActionResult> {
  const context = boardToolContext();
  if (!context) return { ok: false, message: NO_EDITOR };
  try {
    const outcome = await kanbanExecutors(context)[name](args);
    return { ok: true, message: outcome.summary };
  } catch (error) {
    return { ok: false, message: describe(error) };
  }
}

export type SeedSource = "review_edit" | "check_pacing" | "client_notes";

/** Cards from the automatic check, the pacing check, or the timeline's markers (as client notes). */
export const seedFromFindings = (source: SeedSource, targetColumn: "backlog" | "ready" = "ready") =>
  runTool("kanban_seed_from_findings", { source, targetColumn });

/** The board both ways with the open timeline's markers. */
export const syncBoardMarkers = () => runTool("kanban_sync_markers", { direction: "both" });

/** Moves a card one column left (-1) or right (+1). */
export function moveCard(cardId: string, step: -1 | 1): ActionResult {
  const card = useKanbanStore.getState().board.cards.find((c) => c.id === cardId);
  if (!card) return { ok: false, message: `${cardId} isn't on the board` };
  const at = KANBAN_COLUMNS.indexOf(card.column) + step;
  if (at < 0 || at >= KANBAN_COLUMNS.length) return { ok: false, message: `${cardId} can't move further` };
  return setColumn(cardId, KANBAN_COLUMNS[at]);
}

export function setColumn(cardId: string, column: KanbanColumnId): ActionResult {
  try {
    const card = useKanbanStore.getState().updateCard(cardId, {
      column,
      execution: column === "blocked" ? {} : { blockedReason: null, ...(column === "in_progress" ? {} : { progress: null }) },
    });
    return { ok: true, message: `${card.id} is now ${KANBAN_COLUMN_META[column].label}` };
  } catch (error) {
    return { ok: false, message: describe(error) };
  }
}

/** Puts "@kb_3" in the chat's composer, with its mention, and shows the chat. */
export function chatAboutCard(cardId: string): ActionResult {
  const card = useKanbanStore.getState().board.cards.find((c) => c.id === cardId);
  if (!card) return { ok: false, message: `${cardId} isn't on the board` };
  const agent = useAgentStore.getState();
  const tag = `@${card.id}`;
  if (!agent.draft.includes(tag)) agent.setDraft(`${agent.draft}${agent.draft && !/\s$/.test(agent.draft) ? " " : ""}${tag} `);
  if (!agent.draftMentions.some((m) => m.kind === "card" && m.ref === card.id)) agent.setDraftMentions([...agent.draftMentions, cardMention(card)]);
  useUiStore.getState().setTab("chat");
  return { ok: true, message: `Mentioned ${card.id} in the chat` };
}

/** Answers the chat's review card the board card is waiting on. */
export function answerCardReview(cardId: string, decision: "apply" | "skip"): ActionResult {
  const card = useKanbanStore.getState().board.cards.find((c) => c.id === cardId);
  const reviewId = card?.execution.reviewCardId;
  if (!card || !reviewId) return { ok: false, message: `${cardId} isn't waiting for a review` };
  if (!answerReview(reviewId, decision)) {
    useKanbanStore.getState().updateCard(card.id, { execution: { reviewCardId: null } });
    return { ok: false, message: "That change isn't waiting any more" };
  }
  return { ok: true, message: decision === "apply" ? `Applying ${card.id}'s change` : `Skipped ${card.id}'s change` };
}

/** The card's edits that can still be reverted. */
export function revertableEdits(card: KanbanCard): string[] {
  const entries = useEditLogStore.getState().entries;
  return card.execution.editLogIds.filter((id) => entries.some((e) => e.id === id && !e.reverted));
}

/** Reverts every edit the card made; the sync then puts it back in Ready. */
export async function revertCard(cardId: string): Promise<ActionResult> {
  const card = useKanbanStore.getState().board.cards.find((c) => c.id === cardId);
  if (!card) return { ok: false, message: `${cardId} isn't on the board` };
  const ids = revertableEdits(card);
  if (!ids.length) return { ok: false, message: `${card.id} has no edits left to revert` };
  try {
    const outcome = await revertTimelineEdits(ids, { byUser: true });
    return { ok: true, message: outcome.summary };
  } catch (error) {
    return { ok: false, message: describe(error) };
  }
}

/** Moves the editor's playhead to the card's start. */
export async function jumpToCard(cardId: string): Promise<ActionResult> {
  const card = useKanbanStore.getState().board.cards.find((c) => c.id === cardId);
  const host = boardHost();
  const start = card?.timelineContext.startSeconds;
  if (!card || start === null || start === undefined) return { ok: false, message: `${cardId} has no time on the timeline` };
  if (!host) return { ok: false, message: NO_EDITOR };
  const timeline = card.timelineContext.timeline ?? useNleStateStore.getState().hosts[host].timeline;
  if (!timeline) return { ok: false, message: "No timeline is open in the editor" };
  try {
    await nleCall(host, "set_playhead", { timeline, time: start });
    return { ok: true, message: `Moved the playhead to ${card.id}` };
  } catch (error) {
    return { ok: false, message: describe(error) };
  }
}

/** The editor's playhead, for a new card's start; null without an editor or a timeline. */
export async function playheadSeconds(): Promise<number | null> {
  const host = boardHost();
  const timeline = host ? useNleStateStore.getState().hosts[host].timeline : null;
  if (!host || !timeline) return null;
  try {
    const { time } = await nleCall<{ time: number }>(host, "get_playhead", { timeline });
    return Number.isFinite(time) ? time : null;
  } catch {
    return null;
  }
}
