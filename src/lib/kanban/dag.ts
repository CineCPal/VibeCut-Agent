/**
 * The board's dependency graph (docs/specs/kanban-spec.md §4.2): which cards are waiting on others,
 * which can run now (the wave frontier), and whether a set of `blockedBy` links loops back on itself.
 * Pure: everything takes the cards it reads.
 */
import { PRIORITY_RANK, type KanbanCard } from "../../types/kanban";

/** The cards `card` waits on that are still on the board and not done. A dangling id doesn't block. */
export function unresolvedBlockers(card: KanbanCard, allCards: readonly KanbanCard[]): KanbanCard[] {
  if (!card.blockedBy.length) return [];
  const byId = new Map(allCards.map((c) => [c.id, c]));
  return card.blockedBy.flatMap((id) => {
    const blocker = byId.get(id);
    return blocker && blocker.column !== "done" ? [blocker] : [];
  });
}

/** A Ready card with nothing left to wait on. */
export function isCardExecutable(card: KanbanCard, allCards: readonly KanbanCard[]): boolean {
  return card.column === "ready" && unresolvedBlockers(card, allCards).length === 0;
}

/** Every card that can run now, most urgent first, then oldest first. */
export function readyWaveFrontier(allCards: readonly KanbanCard[]): KanbanCard[] {
  return allCards
    .filter((card) => isCardExecutable(card, allCards))
    .sort((a, b) => PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority] || a.createdAt - b.createdAt || seq(a.id) - seq(b.id));
}

const seq = (id: string) => Number(/^kb_(\d+)$/.exec(id)?.[1] ?? Number.MAX_SAFE_INTEGER);

/**
 * The first dependency loop among `cards`, as the ids around it with the first repeated at the end
 * (["kb_1", "kb_2", "kb_1"]), or null when there is none. Links to ids not in `cards` are ignored.
 */
export function detectCycle(cards: readonly { id: string; blockedBy: readonly string[] }[]): string[] | null {
  const links = new Map(cards.map((c) => [c.id, c.blockedBy]));
  // 0: not seen; 1: on the current path; 2: finished.
  const color = new Map<string, 0 | 1 | 2>();
  const path: string[] = [];
  const visit = (id: string): string[] | null => {
    color.set(id, 1);
    path.push(id);
    for (const next of links.get(id) ?? []) {
      if (!links.has(next)) continue;
      const state = color.get(next) ?? 0;
      if (state === 1) return [...path.slice(path.indexOf(next)), next];
      if (state === 0) {
        const found = visit(next);
        if (found) return found;
      }
    }
    path.pop();
    color.set(id, 2);
    return null;
  };
  for (const { id } of cards) {
    if ((color.get(id) ?? 0) === 0) {
      const found = visit(id);
      if (found) return found;
    }
  }
  return null;
}

/** The cards that `doneId` finishing just let run: Ready, waiting on it, and now waiting on nothing. */
export function newlyUnblocked(doneId: string, allCards: readonly KanbanCard[]): KanbanCard[] {
  return allCards.filter((card) => card.blockedBy.includes(doneId) && isCardExecutable(card, allCards));
}
