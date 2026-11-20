import { create } from "zustand";
import { getKanbanBoard, setKanbanBoard } from "../lib/ipc";
import {
  createCardOn,
  deleteCardsOn,
  forSaving,
  normalizeBoard,
  planWorkflowOn,
  toggleChecklistOn,
  updateCardOn,
  type CardInput,
  type CardPatch,
  type PlanCardInput,
} from "../lib/kanban/board";
import { selectActiveHost, useNleStateStore, type NleStoreState } from "./useNleStateStore";
import { GLOBAL_PROJECT, emptyBoard, type KanbanBoardFile, type KanbanCard, type KanbanCardOrigin, type KanbanHost, type KanbanJobProgress } from "../types/kanban";

/** Saves wait this long for more changes, so a burst of updates is one write. */
export const SAVE_DELAY_MS = 250;

export interface KanbanScope {
  host: KanbanHost;
  project: string;
}

/** What `recordCardCommit` is told about an orchestrated commit (orchestratorTools.ts). */
export interface CardCommit {
  editId: string;
  deltaId?: string | null;
  validationToken?: string | null;
  otioPath?: string | null;
}

/**
 * The project's Kanban board (PLAN.md "Phase 23", docs/specs/kanban-spec.md §4.1): one board per editor
 * project, or the global board while none is open. Changes apply at once and are saved shortly after
 * (kanban.rs), one save at a time in order. The operations themselves are lib/kanban/board.ts's.
 */
export interface KanbanState {
  scope: KanbanScope;
  board: KanbanBoardFile;
  /** False while the scope's board is being read; changes wait for it. */
  loaded: boolean;
  /** The last read or save problem, shown on the board. */
  error: string | null;
  /** The card the running chat turn works on (lifecycleSync.ts binds it as a turn starts). */
  activeTurnCardId: string | null;
  /** Loads the board for the editor project open now (or the global board). */
  loadForActiveProject: () => Promise<void>;
  loadScope: (scope: KanbanScope) => Promise<void>;
  createCard: (input: CardInput) => KanbanCard;
  planWorkflow: (
    inputs: readonly PlanCardInput[],
    options?: { clearExisting?: boolean; autoAdvanceWave?: boolean; createdBy?: KanbanCardOrigin },
  ) => { created: KanbanCard[]; removed: string[] };
  updateCard: (cardId: string, patch: CardPatch) => KanbanCard;
  toggleChecklistItem: (cardId: string, checkId: string) => KanbanCard;
  deleteCards: (cardIds: readonly string[]) => string[];
  clearDoneCards: () => string[];
  setAutoAdvanceWave: (on: boolean) => void;
  setActiveTurnCardId: (cardId: string | null) => void;
  /** Live progress for a card's job: kept in memory, never saved, so it doesn't write on every tick. */
  setProgress: (cardId: string, progress: KanbanJobProgress | null) => void;
  /** Links an orchestrated commit to its card: the edit, the delta, its token, the `.otio` snapshot. */
  recordCardCommit: (cardId: string, commit: CardCommit) => KanbanCard | null;
  /** Writes any waiting change now; resolves when every save so far has finished. */
  flush: () => Promise<void>;
}

/** The board for what the editor has open: its project, or the global board without one. */
export function activeScope(nle: Pick<NleStoreState, "hosts" | "preferredHost"> = useNleStateStore.getState()): KanbanScope {
  const host = selectActiveHost(nle);
  const project = host ? nle.hosts[host].project?.trim() : null;
  return host && project ? { host, project } : { host: "global", project: GLOBAL_PROJECT };
}

export const sameScope = (a: KanbanScope, b: KanbanScope) => a.host === b.host && (a.host === "global" || a.project === b.project);

const describe = (error: unknown) => (error instanceof Error ? error.message : String(error));

let timer: ReturnType<typeof setTimeout> | null = null;
let chain: Promise<void> = Promise.resolve();
// Bumped by each load, so a slow read for a project the editor has since left is dropped.
let loadToken = 0;

export const useKanbanStore = create<KanbanState>()((set, get) => {
  const writeNow = (): Promise<void> => {
    const { scope, board } = get();
    const saving = forSaving(board);
    chain = chain
      .then(() => setKanbanBoard(scope.host, scope.project, saving))
      .then(
        () => {
          if (get().error) set({ error: null });
        },
        (error: unknown) => set({ error: `Couldn't save the board: ${describe(error)}` }),
      );
    return chain;
  };
  const scheduleSave = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      void writeNow();
    }, SAVE_DELAY_MS);
  };
  const ready = () => {
    if (!get().loaded) throw new Error("The board is still loading; try again in a moment");
    return get().board;
  };
  const commit = (board: KanbanBoardFile) => {
    set({ board });
    scheduleSave();
  };

  return {
    scope: { host: "global", project: GLOBAL_PROJECT },
    board: emptyBoard("global", GLOBAL_PROJECT, 0),
    loaded: false,
    error: null,
    activeTurnCardId: null,

    loadForActiveProject: () => {
      const scope = activeScope();
      return get().loaded && sameScope(scope, get().scope) ? Promise.resolve() : get().loadScope(scope);
    },

    loadScope: async (scope) => {
      // The board being left is saved first, under its own project.
      await get().flush();
      const token = ++loadToken;
      set({ scope, board: emptyBoard(scope.host, scope.project), loaded: false, error: null, activeTurnCardId: null });
      try {
        const saved = await getKanbanBoard(scope.host, scope.project);
        if (token !== loadToken) return;
        set({ board: saved ? normalizeBoard(saved, scope.host, scope.project) : emptyBoard(scope.host, scope.project), loaded: true });
      } catch (error) {
        if (token !== loadToken) return;
        // An unreadable board starts empty here; it's only written over once something changes.
        set({ loaded: true, error: `Couldn't read this project's board, so it starts empty: ${describe(error)}` });
      }
    },

    createCard: (input) => {
      const { board, card } = createCardOn(ready(), input);
      commit(board);
      return card;
    },

    planWorkflow: (inputs, options) => {
      const { board, created, removed } = planWorkflowOn(ready(), inputs, options);
      commit(board);
      return { created, removed };
    },

    updateCard: (cardId, patch) => {
      const { board, card } = updateCardOn(ready(), cardId, patch);
      commit(board);
      if (get().activeTurnCardId === cardId && (card.column === "done" || card.column === "blocked")) set({ activeTurnCardId: null });
      return card;
    },

    toggleChecklistItem: (cardId, checkId) => {
      const { board, card } = toggleChecklistOn(ready(), cardId, checkId);
      commit(board);
      return card;
    },

    deleteCards: (cardIds) => {
      const { board, deleted } = deleteCardsOn(ready(), cardIds);
      if (deleted.length) {
        commit(board);
        if (get().activeTurnCardId && deleted.includes(get().activeTurnCardId as string)) set({ activeTurnCardId: null });
      }
      return deleted;
    },

    clearDoneCards: () => get().deleteCards(ready().cards.filter((c) => c.column === "done").map((c) => c.id)),

    setAutoAdvanceWave: (on) => {
      const board = ready();
      if (board.autoAdvanceWave !== on) commit({ ...board, autoAdvanceWave: on, updatedAt: Date.now() });
    },

    setActiveTurnCardId: (activeTurnCardId) => set({ activeTurnCardId }),

    setProgress: (cardId, progress) =>
      set((s) => ({
        board: {
          ...s.board,
          cards: s.board.cards.map((c) => (c.id === cardId ? { ...c, execution: { ...c.execution, progress } } : c)),
        },
      })),

    recordCardCommit: (cardId, info) => {
      const card = get().loaded ? get().board.cards.find((c) => c.id === cardId) : undefined;
      if (!card) return null;
      const editLogIds = card.execution.editLogIds.includes(info.editId) ? card.execution.editLogIds : [...card.execution.editLogIds, info.editId];
      const artifacts = info.otioPath && !card.execution.artifacts.includes(info.otioPath) ? [...card.execution.artifacts, info.otioPath] : card.execution.artifacts;
      const finishing = card.column === "in_progress" || card.column === "review";
      return get().updateCard(cardId, {
        ...(finishing ? { column: "done" as const } : {}),
        execution: {
          editLogIds,
          artifacts,
          deltaId: info.deltaId ?? card.execution.deltaId,
          validationToken: info.validationToken ?? card.execution.validationToken,
          ...(finishing ? { reviewCardId: null, progress: null, blockedReason: null } : {}),
        },
      });
    },

    flush: () => {
      if (timer) {
        clearTimeout(timer);
        timer = null;
        return writeNow();
      }
      return chain;
    },
  };
});

/** Resets the store between tests. */
export function resetKanbanStoreForTests(): void {
  if (timer) clearTimeout(timer);
  timer = null;
  chain = Promise.resolve();
  loadToken++;
  useKanbanStore.setState({
    scope: { host: "global", project: GLOBAL_PROJECT },
    board: emptyBoard("global", GLOBAL_PROJECT, 0),
    loaded: false,
    error: null,
    activeTurnCardId: null,
  });
}
