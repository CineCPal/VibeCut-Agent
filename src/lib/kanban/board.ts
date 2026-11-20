/**
 * The board's operations as pure functions (docs/specs/kanban-spec.md §4.1): each takes a board and
 * returns a new one, or throws an Error whose message can go straight to the user or the agent. The
 * store (src/store/useKanbanStore.ts) applies them and saves; the tools and the panels go through it.
 */
import { detectCycle } from "./dag";
import {
  CARD_ID,
  DEFAULT_CATEGORY_ASSIGNEE,
  DEFAULT_ROLE_ASSIGNEE,
  KANBAN_CATEGORIES,
  KANBAN_COLUMNS,
  KANBAN_PRIORITIES,
  KANBAN_SCHEMA_VERSION,
  KANBAN_SUBAGENT_ROLES,
  emptyExecution,
  emptyTimelineContext,
  type KanbanAssignee,
  type KanbanAssigneeRole,
  type KanbanBoardFile,
  type KanbanCard,
  type KanbanCardExecution,
  type KanbanCardOrigin,
  type KanbanCategory,
  type KanbanChecklistItem,
  type KanbanColumnId,
  type KanbanHost,
  type KanbanPriority,
  type KanbanTimelineContext,
} from "../../types/kanban";

/** The Studio desks a card can name (spec §1), with the role that sits at each and its badge. */
export const STATIONS: Record<string, { role: KanbanAssigneeRole; label: string }> = {
  "orchestrator.supervisor": { role: "MASTER_ORCHESTRATOR", label: "Claude / Supervisor" },
  "app.kanban": { role: "MASTER_ORCHESTRATOR", label: "Kanban Board" },
  "app.project": { role: "MASTER_ORCHESTRATOR", label: "Project" },
  "worker.whisper": { role: "INGEST_TRANSCRIBE", label: "Whisper" },
  "app.transcripts": { role: "INGEST_TRANSCRIBE", label: "Transcripts" },
  "worker.vlm": { role: "VISION_TAGGER", label: "Vision Model" },
  "app.broll_analyzer": { role: "VISION_TAGGER", label: "Analyzer" },
  "app.thumbnails": { role: "VISION_TAGGER", label: "Thumbnails" },
  "worker.vector": { role: "BROLL_RETRIEVER", label: "Vector Index" },
  "app.broll_library": { role: "BROLL_RETRIEVER", label: "B-roll Library" },
  "app.media_pool": { role: "BROLL_RETRIEVER", label: "Bins" },
  "worker.otio_cutter": { role: "PACING_CUTTER", label: "OTIO Cutter" },
  "app.timeline": { role: "PACING_CUTTER", label: "Timeline" },
  "app.review": { role: "PACING_CUTTER", label: "Review & QC" },
  "app.style": { role: "PACING_CUTTER", label: "Style" },
  "worker.audio_sync": { role: "AUDIO_ENGINEER", label: "Boundaries" },
  "app.audio_sync": { role: "AUDIO_ENGINEER", label: "Sync" },
  "app.audio_mix": { role: "AUDIO_ENGINEER", label: "Mix" },
  "app.audio_repair": { role: "AUDIO_ENGINEER", label: "Repair" },
  "worker.color_nle": { role: "COLOR_GRADER", label: "Editor Link" },
  "app.color": { role: "COLOR_GRADER", label: "Colour" },
  "app.finishing": { role: "COLOR_GRADER", label: "Transform" },
  "app.titles": { role: "COLOR_GRADER", label: "Titles" },
  "app.markers": { role: "COLOR_GRADER", label: "Markers" },
  "app.deliver": { role: "COLOR_GRADER", label: "Deliver" },
  "human.editor": { role: "HUMAN_EDITOR", label: "Human Editor" },
};

export const MAX_TITLE_CHARS = 200;
export const MAX_DESCRIPTION_CHARS = 4000;
export const MAX_CHECKLIST_ITEMS = 30;
export const MAX_PLAN_CARDS = 30;

/** What a new card may say; everything but the title and category has a default. */
export interface CardInput {
  title: string;
  category: KanbanCategory;
  description?: string;
  priority?: KanbanPriority;
  column?: KanbanColumnId;
  assigneeRole?: KanbanAssigneeRole;
  stationKey?: string;
  timeline?: string | null;
  startSeconds?: number | null;
  endSeconds?: number | null;
  tracks?: string[];
  clipIds?: string[];
  mediaPaths?: string[];
  blockedBy?: string[];
  parentCardId?: string | null;
  checklist?: string[];
  autoPrompt?: string | null;
  mode?: KanbanCardExecution["mode"];
  createdBy?: KanbanCardOrigin;
}

/** One card of a plan: `tempId` names it for the plan's other cards' `blockedBy` and `parentTempId`. */
export interface PlanCardInput extends Omit<CardInput, "parentCardId"> {
  tempId?: string;
  parentTempId?: string;
}

export interface CardPatch {
  title?: string;
  description?: string;
  column?: KanbanColumnId;
  priority?: KanbanPriority;
  category?: KanbanCategory;
  assignee?: KanbanAssignee;
  timelineContext?: Partial<KanbanTimelineContext>;
  blockedBy?: string[];
  parentCardId?: string | null;
  checklist?: KanbanChecklistItem[];
  execution?: Partial<KanbanCardExecution>;
}

const oneOf = <T extends string>(allowed: readonly T[], value: unknown, what: string): T => {
  if (typeof value === "string" && (allowed as readonly string[]).includes(value)) return value as T;
  throw new Error(`${what} must be one of ${allowed.join(", ")}`);
};

const cleanTitle = (title: unknown): string => {
  const text = typeof title === "string" ? title.replace(/\s+/g, " ").trim() : "";
  if (!text) throw new Error("A card needs a title");
  return text.slice(0, MAX_TITLE_CHARS);
};

const seconds = (value: unknown, what: string): number | null => {
  if (value === undefined || value === null) return null;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) throw new Error(`${what} must be a time in seconds, 0 or more`);
  return value;
};

const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((v): v is string => typeof v === "string" && v.trim() !== "").map((v) => v.trim()) : [];

/** The card's sub-agent and desk: the ones it names, else its category's (spec §2.1). */
export function resolveAssignee(category: KanbanCategory, role?: KanbanAssigneeRole, stationKey?: string): KanbanAssignee {
  const byCategory = DEFAULT_CATEGORY_ASSIGNEE[category];
  if (stationKey) {
    const station = STATIONS[stationKey];
    if (!station) throw new Error(`${stationKey} isn't a Studio desk; use one of ${Object.keys(STATIONS).join(", ")}`);
    if (role && role !== station.role) throw new Error(`${stationKey} is a ${station.role} desk, not ${role}`);
    return stationKey === byCategory.stationKey ? byCategory : { role: station.role, stationKey, label: station.label };
  }
  if (role) {
    if (!(KANBAN_SUBAGENT_ROLES as readonly string[]).includes(role)) {
      throw new Error(`assigneeRole must be one of ${KANBAN_SUBAGENT_ROLES.join(", ")}`);
    }
    return role === byCategory.role ? byCategory : DEFAULT_ROLE_ASSIGNEE[role];
  }
  return byCategory;
}

export const checklistOf = (texts: readonly string[]): KanbanChecklistItem[] =>
  texts.slice(0, MAX_CHECKLIST_ITEMS).map((text, i) => ({ id: `c${i + 1}`, text: text.slice(0, MAX_TITLE_CHARS), done: false }));

function buildCard(input: CardInput, id: string, now: number): KanbanCard {
  const category = oneOf(KANBAN_CATEGORIES, input.category, "category");
  const start = seconds(input.startSeconds, "startSeconds");
  const end = seconds(input.endSeconds, "endSeconds");
  if (start !== null && end !== null && end < start) throw new Error("endSeconds must come after startSeconds");
  const column = input.column === undefined ? "ready" : oneOf(KANBAN_COLUMNS, input.column, "column");
  return {
    id,
    title: cleanTitle(input.title),
    description: (input.description ?? "").trim().slice(0, MAX_DESCRIPTION_CHARS),
    column,
    priority: input.priority === undefined ? "medium" : oneOf(KANBAN_PRIORITIES, input.priority, "priority"),
    category,
    assignee: resolveAssignee(category, input.assigneeRole, input.stationKey),
    timelineContext: {
      ...emptyTimelineContext(),
      timeline: input.timeline?.trim() || null,
      startSeconds: start,
      endSeconds: end,
      tracks: strings(input.tracks),
      clipIds: strings(input.clipIds),
      mediaPaths: strings(input.mediaPaths),
    },
    blockedBy: [...new Set(strings(input.blockedBy))],
    parentCardId: input.parentCardId ?? null,
    checklist: checklistOf(strings(input.checklist)),
    execution: { ...emptyExecution(), mode: input.mode ?? "agent_turn", autoPrompt: input.autoPrompt?.trim() || null },
    createdBy: input.createdBy ?? "user",
    createdAt: now,
    updatedAt: now,
    completedAt: column === "done" ? now : null,
  };
}

function checkLinks(cards: readonly KanbanCard[]): void {
  const ids = new Set(cards.map((c) => c.id));
  for (const card of cards) {
    for (const id of card.blockedBy) {
      if (id === card.id) throw new Error(`${card.id} can't wait on itself`);
      if (!ids.has(id)) throw new Error(`${card.id} waits on ${id}, which isn't on the board`);
    }
    if (card.parentCardId !== null && !ids.has(card.parentCardId)) {
      throw new Error(`${card.id}'s parent ${card.parentCardId} isn't on the board`);
    }
  }
  const loop = detectCycle(cards);
  if (loop) throw new Error(`Those dependencies go round in a circle: ${loop.join(" → ")}`);
}

/** Adds one card; returns the board and the card. */
export function createCardOn(board: KanbanBoardFile, input: CardInput, now = Date.now()): { board: KanbanBoardFile; card: KanbanCard } {
  const card = buildCard(input, `kb_${board.nextCardSeq}`, now);
  const cards = [...board.cards, card];
  checkLinks(cards);
  return { board: { ...board, cards, nextCardSeq: board.nextCardSeq + 1, updatedAt: now }, card };
}

/**
 * Adds a plan's cards in one go (spec §4.1 `planWorkflow`). `blockedBy` and `parentTempId` may name the
 * plan's own cards by `tempId` or cards already on the board by `kb_<n>`. With `clearExisting`, the
 * board's Backlog and Ready cards go first.
 */
export function planWorkflowOn(
  board: KanbanBoardFile,
  inputs: readonly PlanCardInput[],
  options: { clearExisting?: boolean; autoAdvanceWave?: boolean; createdBy?: KanbanCardOrigin } = {},
  now = Date.now(),
): { board: KanbanBoardFile; created: KanbanCard[]; removed: string[] } {
  if (!inputs.length) throw new Error("A plan needs at least one card");
  if (inputs.length > MAX_PLAN_CARDS) throw new Error(`A plan can add at most ${MAX_PLAN_CARDS} cards at once`);
  let start = board;
  let removed: string[] = [];
  if (options.clearExisting) {
    removed = board.cards.filter((c) => c.column === "backlog" || c.column === "ready").map((c) => c.id);
    start = deleteCardsOn(board, removed, now).board;
  }
  const temp = new Map<string, string>();
  inputs.forEach((input, i) => {
    const tempId = input.tempId?.trim();
    if (!tempId) return;
    if (CARD_ID.test(tempId)) throw new Error(`tempId ${tempId} looks like a card id; use names like "t1"`);
    if (temp.has(tempId)) throw new Error(`tempId ${tempId} is used twice`);
    temp.set(tempId, `kb_${start.nextCardSeq + i}`);
  });
  const existing = new Set(start.cards.map((c) => c.id));
  const resolve = (ref: string, what: string): string => {
    const id = temp.get(ref) ?? (existing.has(ref) ? ref : null);
    if (!id) throw new Error(`${what} names ${ref}, which is neither a tempId in this plan nor a card on the board`);
    return id;
  };
  const created = inputs.map((input, i) => {
    const label = input.tempId ?? input.title;
    return buildCard(
      {
        ...input,
        createdBy: input.createdBy ?? options.createdBy ?? "orchestrator",
        blockedBy: strings(input.blockedBy).map((ref) => resolve(ref, `"${label}"'s blockedBy`)),
        parentCardId: input.parentTempId ? resolve(input.parentTempId, `"${label}"'s parentTempId`) : null,
      },
      `kb_${start.nextCardSeq + i}`,
      now,
    );
  });
  const cards = [...start.cards, ...created];
  checkLinks(cards);
  return {
    board: {
      ...start,
      cards,
      nextCardSeq: start.nextCardSeq + inputs.length,
      autoAdvanceWave: options.autoAdvanceWave ?? start.autoAdvanceWave,
      updatedAt: now,
    },
    created,
    removed,
  };
}

/** Changes one card. Moving into Done stamps `completedAt`; moving out clears it. */
export function updateCardOn(board: KanbanBoardFile, cardId: string, patch: CardPatch, now = Date.now()): { board: KanbanBoardFile; card: KanbanCard } {
  const current = board.cards.find((c) => c.id === cardId);
  if (!current) throw new Error(`${cardId} isn't on the board`);
  const category = patch.category === undefined ? current.category : oneOf(KANBAN_CATEGORIES, patch.category, "category");
  const column = patch.column === undefined ? current.column : oneOf(KANBAN_COLUMNS, patch.column, "column");
  const timelineContext = { ...current.timelineContext, ...patch.timelineContext };
  if (timelineContext.startSeconds !== null && timelineContext.endSeconds !== null && timelineContext.endSeconds < timelineContext.startSeconds) {
    throw new Error("endSeconds must come after startSeconds");
  }
  const card: KanbanCard = {
    ...current,
    title: patch.title === undefined ? current.title : cleanTitle(patch.title),
    description: patch.description === undefined ? current.description : patch.description.trim().slice(0, MAX_DESCRIPTION_CHARS),
    column,
    priority: patch.priority === undefined ? current.priority : oneOf(KANBAN_PRIORITIES, patch.priority, "priority"),
    category,
    assignee: patch.assignee ?? current.assignee,
    timelineContext,
    blockedBy: patch.blockedBy === undefined ? current.blockedBy : [...new Set(strings(patch.blockedBy))],
    parentCardId: patch.parentCardId === undefined ? current.parentCardId : patch.parentCardId,
    checklist: patch.checklist ?? current.checklist,
    execution: { ...current.execution, ...patch.execution },
    updatedAt: now,
    completedAt: column === "done" ? (current.column === "done" ? current.completedAt : now) : null,
  };
  const cards = board.cards.map((c) => (c.id === cardId ? card : c));
  if (patch.blockedBy !== undefined || patch.parentCardId !== undefined) checkLinks(cards);
  return { board: { ...board, cards, updatedAt: now }, card };
}

/** Removes cards, and their ids from the rest's `blockedBy` and `parentCardId`. Unknown ids are skipped. */
export function deleteCardsOn(board: KanbanBoardFile, cardIds: readonly string[], now = Date.now()): { board: KanbanBoardFile; deleted: string[] } {
  const gone = new Set(cardIds.filter((id) => board.cards.some((c) => c.id === id)));
  if (!gone.size) return { board, deleted: [] };
  const cards = board.cards
    .filter((c) => !gone.has(c.id))
    .map((c) =>
      c.blockedBy.some((id) => gone.has(id)) || (c.parentCardId !== null && gone.has(c.parentCardId))
        ? { ...c, blockedBy: c.blockedBy.filter((id) => !gone.has(id)), parentCardId: c.parentCardId !== null && gone.has(c.parentCardId) ? null : c.parentCardId, updatedAt: now }
        : c,
    );
  return { board: { ...board, cards, updatedAt: now }, deleted: [...gone] };
}

/** Flips one checklist item. */
export function toggleChecklistOn(board: KanbanBoardFile, cardId: string, checkId: string, now = Date.now()): { board: KanbanBoardFile; card: KanbanCard } {
  const card = board.cards.find((c) => c.id === cardId);
  if (!card) throw new Error(`${cardId} isn't on the board`);
  if (!card.checklist.some((item) => item.id === checkId)) throw new Error(`${cardId} has no checklist item ${checkId}`);
  return updateCardOn(board, cardId, { checklist: card.checklist.map((item) => (item.id === checkId ? { ...item, done: !item.done } : item)) }, now);
}

/** What is saved: the board without live progress, which only means something while the app runs. */
export function forSaving(board: KanbanBoardFile): KanbanBoardFile {
  return { ...board, cards: board.cards.map((c) => (c.execution.progress ? { ...c, execution: { ...c.execution, progress: null } } : c)) };
}

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const str = (value: unknown, fallback: string): string => (typeof value === "string" ? value : fallback);
const strOrNull = (value: unknown): string | null => (typeof value === "string" ? value : null);
const numOrNull = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? value : null);
const pick = <T extends string>(allowed: readonly T[], value: unknown, fallback: T): T =>
  typeof value === "string" && (allowed as readonly string[]).includes(value) ? (value as T) : fallback;

/**
 * A saved board, read defensively: missing or wrong fields get their defaults, cards without a usable id
 * are dropped, and `nextCardSeq` is kept above every card's number. Throws only when it isn't a board.
 */
export function normalizeBoard(raw: unknown, host: KanbanHost, project: string): KanbanBoardFile {
  if (!isObject(raw) || !Array.isArray(raw.cards)) throw new Error("The saved Kanban board isn't a board");
  const seen = new Set<string>();
  const cards: KanbanCard[] = [];
  for (const value of raw.cards) {
    if (!isObject(value) || typeof value.id !== "string" || !CARD_ID.test(value.id) || seen.has(value.id)) continue;
    seen.add(value.id);
    const category = pick(KANBAN_CATEGORIES, value.category, "cut");
    const assignee = isObject(value.assignee) && typeof value.assignee.stationKey === "string" && typeof value.assignee.label === "string"
      ? { role: pick(KANBAN_SUBAGENT_ROLES, value.assignee.role, DEFAULT_CATEGORY_ASSIGNEE[category].role), stationKey: value.assignee.stationKey, label: value.assignee.label }
      : DEFAULT_CATEGORY_ASSIGNEE[category];
    const ctx = isObject(value.timelineContext) ? value.timelineContext : {};
    const exec = isObject(value.execution) ? value.execution : {};
    const checklist = Array.isArray(value.checklist)
      ? value.checklist.filter(isObject).filter((i) => typeof i.id === "string" && typeof i.text === "string").map((i) => ({ id: i.id as string, text: i.text as string, done: i.done === true }))
      : [];
    cards.push({
      id: value.id,
      title: str(value.title, value.id),
      description: str(value.description, ""),
      column: pick(KANBAN_COLUMNS, value.column, "backlog"),
      priority: pick(KANBAN_PRIORITIES, value.priority, "medium"),
      category,
      assignee,
      timelineContext: {
        timeline: strOrNull(ctx.timeline),
        startSeconds: numOrNull(ctx.startSeconds),
        endSeconds: numOrNull(ctx.endSeconds),
        tracks: strings(ctx.tracks),
        clipIds: strings(ctx.clipIds),
        mediaPaths: strings(ctx.mediaPaths),
        markerId: strOrNull(ctx.markerId),
      },
      blockedBy: strings(value.blockedBy),
      parentCardId: strOrNull(value.parentCardId),
      checklist,
      execution: {
        mode: pick(["agent_turn", "background_bot", "manual"] as const, exec.mode, "agent_turn"),
        autoPrompt: strOrNull(exec.autoPrompt),
        activeJobId: strOrNull(exec.activeJobId),
        traceId: strOrNull(exec.traceId),
        progress: null,
        validationToken: strOrNull(exec.validationToken),
        deltaId: strOrNull(exec.deltaId),
        reviewCardId: strOrNull(exec.reviewCardId),
        editLogIds: strings(exec.editLogIds),
        artifacts: strings(exec.artifacts),
        blockedReason: strOrNull(exec.blockedReason),
      },
      createdBy: pick(["user", "orchestrator", "subagent", "bot", "client_notes", "qc_lint"] as const, value.createdBy, "user"),
      createdAt: numOrNull(value.createdAt) ?? 0,
      updatedAt: numOrNull(value.updatedAt) ?? 0,
      completedAt: numOrNull(value.completedAt),
    });
  }
  // Links to cards that are gone are dropped, so a hand-edited file can't block a card forever.
  for (const card of cards) {
    card.blockedBy = card.blockedBy.filter((id) => seen.has(id) && id !== card.id);
    if (card.parentCardId !== null && !seen.has(card.parentCardId)) card.parentCardId = null;
  }
  const highest = Math.max(0, ...cards.map((c) => Number(c.id.slice(3))));
  const saved = numOrNull(raw.nextCardSeq);
  return {
    schemaVersion: KANBAN_SCHEMA_VERSION,
    host,
    project,
    nextCardSeq: Math.max(saved !== null ? Math.floor(saved) : 1, highest + 1, 1),
    autoAdvanceWave: raw.autoAdvanceWave === true,
    updatedAt: numOrNull(raw.updatedAt) ?? 0,
    cards,
  };
}
