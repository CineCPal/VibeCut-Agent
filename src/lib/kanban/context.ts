/**
 * The board as the chat snapshot tells the agent (docs/specs/kanban-spec.md §4.3.5). Kept apart from
 * lifecycleSync.ts so lib/agent/context.ts can read it without pulling in the runner and the controller.
 */
import { clock } from "../agent/args";
import { useKanbanStore } from "../../store/useKanbanStore";
import { KANBAN_COLUMNS, type KanbanBoardFile, type KanbanCard } from "../../types/kanban";

export const MAX_CONTEXT_CHARS = 2400;

const span = (card: KanbanCard) => {
  const { timeline, startSeconds, endSeconds } = card.timelineContext;
  if (startSeconds === null) return null;
  const range = endSeconds !== null ? `${clock(startSeconds)}–${clock(endSeconds)}` : clock(startSeconds);
  return `tl: ${timeline ? `${timeline} ` : ""}${range}`;
};

function contextLine(card: KanbanCard): string {
  const notes = [
    span(card),
    card.blockedBy.length ? `blockedBy: ${card.blockedBy.join(", ")}` : null,
    card.column === "review" ? `waiting review${card.execution.validationToken ? `, ${card.execution.validationToken.slice(0, 12)}…` : ""}` : null,
    card.column === "blocked" && card.execution.blockedReason ? `blocked: ${card.execution.blockedReason}` : null,
    card.execution.progress?.phase ?? null,
    card.execution.editLogIds.length ? `edits: ${card.execution.editLogIds.join(", ")}` : null,
  ].filter(Boolean);
  return `- ${card.id} [${card.column.toUpperCase()} | ${card.priority} | ${card.category} | ${card.assignee.label} (${card.assignee.stationKey})] "${card.title}"${notes.length ? ` (${notes.join("; ")})` : ""}`;
}

/**
 * The board's column counts and the cards that matter now (Active, Review, Blocked, Ready, then up to 5
 * Backlog and the 3 latest Done), at most MAX_CONTEXT_CHARS. Empty for an empty board: KANBAN_INSTRUCTION
 * already says how to start one, and an empty board adds nothing to every message.
 */
export function kanbanContext(board: KanbanBoardFile): string {
  if (!board.cards.length) return "";
  const by = (column: KanbanCard["column"]) => board.cards.filter((c) => c.column === column);
  const head = `[KANBAN BOARD for "${board.project}" (${KANBAN_COLUMNS.map((c) => `${by(c).length} ${c}`).join(", ")})]`;
  const tail = "[END KANBAN BOARD]";
  const shown = [
    ...by("in_progress"),
    ...by("review"),
    ...by("blocked"),
    ...by("ready"),
    ...by("backlog").slice(0, 5),
    ...by("done")
      .sort((a, b) => (b.completedAt ?? 0) - (a.completedAt ?? 0))
      .slice(0, 3),
  ];
  const lines: string[] = [];
  let used = head.length + tail.length + 2;
  for (const card of shown) {
    const line = contextLine(card);
    if (used + line.length + 1 > MAX_CONTEXT_CHARS - 60) {
      lines.push(`- … ${shown.length - lines.length} more (kanban_list_cards lists them)`);
      break;
    }
    lines.push(line);
    used += line.length + 1;
  }
  return [head, ...lines, tail].join("\n");
}

/** The snapshot's board block for this editor project, or "" when its board isn't the one loaded. */
export function kanbanContextFor(host: string, project: string | null): string {
  const { loaded, scope, board } = useKanbanStore.getState();
  if (!loaded || !project || scope.host !== host || scope.project !== project.trim()) return "";
  return kanbanContext(board);
}
