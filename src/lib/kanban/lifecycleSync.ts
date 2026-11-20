/**
 * Keeps the Kanban board true to what actually happens (docs/specs/kanban-spec.md §4.3), so cards don't
 * depend on the model remembering to update them:
 *
 * - The board follows the editor's open project (or the global board without one).
 * - A turn started by a card's message (`[Kanban Task kb_n]`, which makes it Active) or naming one card
 *   with @ is that card's turn (`activeTurnCardId`) until it ends. A card still Active when its turn ends with nothing running
 *   goes to Needs Review: the work is done but nobody said so.
 * - Long sidecar jobs started during a card's turn are that card's (background bots); their progress
 *   shows on it, and when one ends after the turn, the card is done (or blocked if it failed).
 * - A "Review edits first" card held during a card's turn puts the card in Needs Review; Skip blocks it.
 * - Edit Log entries made during a card's turn (or naming it) are linked to it; when every one of a done
 *   card's edits is reverted, it goes back to Ready to be cut again.
 * - Cards queued in the chat and dropped from the queue go back to Ready.
 */
import { useAgentStore } from "../../store/useAgentStore";
import { useEditLogStore } from "../../store/useEditLogStore";
import { activeScope, sameScope, useKanbanStore } from "../../store/useKanbanStore";
import { useNleStateStore } from "../../store/useNleStateStore";
import { etaSeconds, isActive, useSidecarStore } from "../../store/useSidecarStore";
import type { ChatMessage } from "../../types/agent";
import type { SidecarCommand, SidecarJob } from "../../types/sidecar";
import type { KanbanCard } from "../../types/kanban";
import { runReadyWave, TASK_TAG } from "./runner";

export { kanbanContext, kanbanContextFor, MAX_CONTEXT_CHARS } from "./context";

/** The sidecar jobs that are a card's background work; quick reads (media-info, peaks…) never are. */
export const BOT_COMMANDS: ReadonlySet<SidecarCommand> = new Set<SidecarCommand>([
  "transcribe",
  "broll-analyze",
  "broll-export",
  "broll-spyglass",
  "ingest-index",
  "media-clean",
  "media-roomtone",
  "media-titles",
  "media-harmonize",
  "media-shots",
  "media-style",
  "media-thumbs",
  "assemble",
]);

/** A card named in an edit's request: its task tag, "[kb_3]" or "@kb_3". */
const CARD_REF = /(?:\[Kanban Task |\[|@)(kb_\d+)\b/;
const BUSY = new Set(["thinking", "stopping"]);

/** The card a user message is about: its task tag, else the one card it @-mentions. */
export function cardOfMessage(message: Pick<ChatMessage, "text" | "mentions">): string | null {
  const tagged = TASK_TAG.exec(message.text);
  if (tagged) return tagged[1];
  const cards = (message.mentions ?? []).filter((m) => m.kind === "card");
  return cards.length === 1 ? cards[0].ref : null;
}

const findCard = (id: string | null) => (id ? useKanbanStore.getState().board.cards.find((c) => c.id === id) : undefined);

/** Applies a change to a card, ignoring one that's gone or a board that isn't loaded. */
function change(cardId: string, patch: Parameters<ReturnType<typeof useKanbanStore.getState>["updateCard"]>[1]): KanbanCard | null {
  try {
    return useKanbanStore.getState().loaded && findCard(cardId) ? useKanbanStore.getState().updateCard(cardId, patch) : null;
  } catch {
    return null;
  }
}

let advancing = false;

/** With auto-wave on, sends the next wave once the agent is free (spec §4.4). */
function advanceWaveSoon(): void {
  if (!useKanbanStore.getState().board.autoAdvanceWave || advancing) return;
  advancing = true;
  setTimeout(() => {
    advancing = false;
    const agent = useAgentStore.getState();
    if (agent.status !== "idle" || agent.queue.length || agent.queuePaused) return;
    void runReadyWave();
  }, 0);
}

/** Starts the synchronizer; returns its stop. */
export function startKanbanSync(): () => void {
  // --- The board follows the editor's project.
  void useKanbanStore.getState().loadForActiveProject();
  const unNle = useNleStateStore.subscribe((nle) => {
    if (!sameScope(activeScope(nle), useKanbanStore.getState().scope)) void useKanbanStore.getState().loadForActiveProject();
  });

  // --- Turns: bind the card a turn is about, and settle it when the turn ends.
  const seenMessages = new Set(useAgentStore.getState().messages.map((m) => m.id));
  let turnCard: string | null = null;
  let wasBusy = BUSY.has(useAgentStore.getState().status);

  const bound = () => useKanbanStore.getState().activeTurnCardId;
  const endTurn = () => {
    const id = turnCard ?? bound();
    turnCard = null;
    if (bound()) useKanbanStore.getState().setActiveTurnCardId(null);
    const card = findCard(id);
    if (!card) return;
    const job = card.execution.activeJobId ? useSidecarStore.getState().jobs.find((j) => j.id === card.execution.activeJobId) : undefined;
    if (card.column === "in_progress" && !(job && isActive(job)) && !card.execution.reviewCardId) {
      change(card.id, { column: "review", execution: { progress: null, activeJobId: null } });
    }
    if (card.column === "done") advanceWaveSoon();
  };

  const onMessages = (messages: ChatMessage[]) => {
    for (const message of messages) {
      if (seenMessages.has(message.id)) continue;
      seenMessages.add(message.id);
      if (message.role === "user") {
        // A new turn begins with its user message: the previous one (if any) is over.
        if (turnCard || bound()) endTurn();
        const id = cardOfMessage(message);
        const card = findCard(id);
        if (card && card.column !== "done") {
          turnCard = card.id;
          useKanbanStore.getState().setActiveTurnCardId(card.id);
          // A card's own message starts its work; a message that only @-mentions it just links the turn.
          if (TASK_TAG.test(message.text)) change(card.id, { column: "in_progress", execution: { progress: null, blockedReason: null } });
        }
      } else if (message.role === "tool" && message.tool?.state === "pending") {
        const id = bound();
        if (findCard(id)) change(id as string, { column: "review", execution: { reviewCardId: message.id } });
      }
    }
    // Review cards answered: Apply resumes the card's work, Skip blocks it.
    for (const card of useKanbanStore.getState().board.cards) {
      const reviewId = card.execution.reviewCardId;
      if (!reviewId) continue;
      const tool = messages.find((m) => m.id === reviewId)?.tool;
      if (!tool) {
        change(card.id, { execution: { reviewCardId: null } });
      } else if (tool.state === "declined") {
        change(card.id, { column: "blocked", execution: { reviewCardId: null, blockedReason: "Declined during edit review" } });
      } else if (tool.state !== "pending") {
        change(card.id, { column: card.column === "review" ? "in_progress" : card.column, execution: { reviewCardId: null } });
      }
    }
  };

  const unAgent = useAgentStore.subscribe((agent, previous) => {
    if (agent.messages !== previous.messages) onMessages(agent.messages);
    const busy = BUSY.has(agent.status);
    if (wasBusy && !busy && (turnCard || bound())) endTurn();
    wasBusy = busy;
    if (agent.queue !== previous.queue) requeueDropped();
  });

  // --- Cards queued in the chat whose message left the queue without starting go back to Ready. Checked
  // a moment later: a message leaves the queue just before its turn starts.
  let requeueTimer: ReturnType<typeof setTimeout> | null = null;
  const requeueDropped = () => {
    if (requeueTimer) return;
    requeueTimer = setTimeout(() => {
      requeueTimer = null;
      const queued = new Set(useAgentStore.getState().queue.map((m) => TASK_TAG.exec(m.text)?.[1]).filter(Boolean));
      for (const card of useKanbanStore.getState().board.cards) {
        if (card.column === "in_progress" && card.execution.progress?.phase === "Queued" && !queued.has(card.id) && card.id !== turnCard && card.id !== bound()) {
          change(card.id, { column: "ready", execution: { progress: null } });
        }
      }
    }, 0);
  };

  // --- Background bots: attach long jobs started during a card's turn; follow their progress and end.
  const seenJobs = new Set(useSidecarStore.getState().jobs.map((j) => j.id));
  const onJobs = (jobs: SidecarJob[]) => {
    for (const job of jobs) {
      if (seenJobs.has(job.id)) continue;
      seenJobs.add(job.id);
      const card = findCard(bound());
      if (!card || !BOT_COMMANDS.has(job.command)) continue;
      const current = card.execution.activeJobId ? jobs.find((j) => j.id === card.execution.activeJobId) : undefined;
      if (current && isActive(current)) continue;
      change(card.id, { execution: { activeJobId: job.id, mode: "background_bot" } });
    }
    const now = Date.now();
    for (const card of useKanbanStore.getState().board.cards) {
      const jobId = card.execution.activeJobId;
      if (!jobId) continue;
      const job = jobs.find((j) => j.id === jobId);
      if (!job) {
        // Cleared from the job list (or from an earlier run): its progress is no longer known.
        if (card.execution.progress) useKanbanStore.getState().setProgress(card.id, null);
        continue;
      }
      if (isActive(job)) {
        const progress = { fraction: job.fraction, phase: job.detail ?? job.phase, etaSeconds: etaSeconds(job, now) };
        const shown = card.execution.progress;
        if (!shown || shown.fraction !== progress.fraction || shown.phase !== progress.phase) useKanbanStore.getState().setProgress(card.id, progress);
        continue;
      }
      // Ended. During the card's own turn the turn decides; after it, the job's end is the card's.
      const artifacts = card.execution.artifacts.includes(`${job.label}: ${job.status}`) ? card.execution.artifacts : [...card.execution.artifacts, `${job.label}: ${job.status}`];
      if (card.id === bound()) {
        change(card.id, { execution: { activeJobId: null, progress: null, artifacts } });
      } else if (job.status === "done") {
        change(card.id, { column: card.column === "in_progress" ? "done" : card.column, execution: { activeJobId: null, progress: null, artifacts } });
        advanceWaveSoon();
      } else {
        change(card.id, {
          column: "blocked",
          execution: { activeJobId: null, progress: null, artifacts, blockedReason: job.error ?? (job.status === "cancelled" ? "Background job was cancelled" : "Background job failed") },
        });
      }
    }
  };
  const unJobs = useSidecarStore.subscribe((s, previous) => {
    if (s.jobs !== previous.jobs) onJobs(s.jobs);
  });

  // --- Edits: link new entries to their card; reverting all of a done card's edits reopens it.
  const seenEdits = new Set(useEditLogStore.getState().entries.map((e) => e.id));
  const unEdits = useEditLogStore.subscribe((log, previous) => {
    if (log.entries === previous.entries) return;
    for (const entry of log.entries) {
      if (seenEdits.has(entry.id)) continue;
      seenEdits.add(entry.id);
      if (entry.fromEarlierRun) continue;
      const id = bound() ?? CARD_REF.exec(`${entry.summary} ${entry.stepText}`)?.[1] ?? null;
      const card = findCard(id);
      if (card && !card.execution.editLogIds.includes(entry.id)) change(card.id, { execution: { editLogIds: [...card.execution.editLogIds, entry.id] } });
    }
    const byId = new Map(log.entries.map((e) => [e.id, e]));
    for (const card of useKanbanStore.getState().board.cards) {
      if (card.column !== "done" || !card.execution.editLogIds.length) continue;
      const present = card.execution.editLogIds.map((id) => byId.get(id)).filter((e) => e !== undefined);
      if (present.length && present.every((e) => Boolean(e.reverted))) {
        change(card.id, { column: "ready", execution: { blockedReason: null } });
      }
    }
  });

  return () => {
    unNle();
    unAgent();
    unJobs();
    unEdits();
    if (requeueTimer) clearTimeout(requeueTimer);
  };
}

