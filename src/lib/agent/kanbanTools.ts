/**
 * The project's Kanban board as agent tools (PLAN.md "Phase 23", docs/specs/kanban-spec.md §5.1). The
 * same seven run in both execution modes: in-app for the editing agent, and forwarded to the supervising
 * editor in orchestrated mode (tool_bus.py's KANBAN_TOOLS). All but kanban_sync_markers only change the
 * app's board, so they aren't reviewed; kanban_sync_markers writes the timeline's markers, so it is
 * (toolKinds.ts). kanban_seed_from_findings only reads the timeline (review_edit's automatic check,
 * check_pacing, read_client_notes) and writes cards.
 */
import { nleCall } from "../ipc";
import { useKanbanStore } from "../../store/useKanbanStore";
import { useNleStateStore } from "../../store/useNleStateStore";
import type { HostMarker } from "../../types/timeline";
import type { NleHost } from "../../types/nle";
import {
  KANBAN_CATEGORIES,
  KANBAN_COLUMNS,
  KANBAN_PRIORITIES,
  KANBAN_SUBAGENT_ROLES,
  type KanbanCard,
  type KanbanCategory,
  type KanbanColumnId,
  type KanbanPriority,
} from "../../types/kanban";
import { newlyUnblocked, readyWaveFrontier, unresolvedBlockers } from "../kanban/dag";
import { resolveAssignee, MAX_PLAN_CARDS, type CardInput, type CardPatch, type PlanCardInput } from "../kanban/board";
import { type Args, bool, clock, type Executor, optNum, optStr } from "./args";
import { reviewExecutors } from "./reviewTools";
import { pacingExecutors } from "./pacingTools";
import { clientNotesExecutors, DONE_MARK } from "./clientNotesTools";
import type { ToolContext, ToolDeclaration } from "./tools";

const STRING_LIST = { type: "ARRAY", items: { type: "STRING" } };
const CATEGORY = { type: "STRING", enum: [...KANBAN_CATEGORIES] };
const PRIORITY = { type: "STRING", enum: [...KANBAN_PRIORITIES] };
const ROLE = { type: "STRING", enum: [...KANBAN_SUBAGENT_ROLES], description: "The sub-agent. Optional; the category's own by default." };
const STATION = { type: "STRING", description: 'A Telemetry Studio desk such as "worker.whisper", "app.audio_mix". Optional.' };

/** The fields a new card can have, shared by kanban_create_card and each of kanban_plan_workflow's cards. */
const cardFields = (columns: readonly KanbanColumnId[]) => ({
  title: { type: "STRING", description: "Short, specific task." },
  description: { type: "STRING", description: "What done looks like. Optional." },
  category: CATEGORY,
  priority: { ...PRIORITY, description: "Default medium." },
  column: { type: "STRING", enum: [...columns], description: "Default ready." },
  assigneeRole: ROLE,
  stationKey: STATION,
  timeline: { type: "STRING", description: "The timeline it's for. Optional." },
  startSeconds: { type: "NUMBER", description: "Where on the timeline it starts (seconds). Optional." },
  endSeconds: { type: "NUMBER", description: "Where it ends (seconds). Optional." },
  tracks: { ...STRING_LIST, description: 'Track labels such as "V1", "A2". Optional.' },
  clipIds: { ...STRING_LIST, description: "Timeline clip ids or pool aliases. Optional." },
  mediaPaths: { ...STRING_LIST, description: "Source files. Optional." },
  checklist: { ...STRING_LIST, description: "Steps to tick off. Optional." },
  autoPrompt: { type: "STRING", description: "Exactly what to ask the agent when the card runs. Optional; the description is used otherwise." },
});

export function kanbanToolDeclarations(): ToolDeclaration[] {
  return [
    {
      name: "kanban_list_cards",
      description:
        "Lists the project's Kanban board: column counts, the cards that can run now (the wave frontier), and the cards, filtered if you like. The snapshot shows a summary; use this for every card's details.",
      parameters: {
        type: "OBJECT",
        properties: {
          column: { type: "STRING", enum: [...KANBAN_COLUMNS] },
          category: CATEGORY,
          assigneeRole: { type: "STRING", enum: [...KANBAN_SUBAGENT_ROLES] },
          includeDone: { type: "BOOLEAN", description: "Default true." },
        },
      },
    },
    {
      name: "kanban_plan_workflow",
      description: `Breaks a multi-step request into dependency-linked cards on the project's Kanban board, in one go (at most ${MAX_PLAN_CARDS}). Give each card a tempId ("t1", "t2"…) and name the cards it waits on in blockedBy, by tempId or by an existing card's kb_<n> id; parentTempId groups steps under an epic card. Each card goes to its category's sub-agent unless you name assigneeRole or stationKey. Loops are refused. Returns the new kb_<n> ids and which can run first.`,
      parameters: {
        type: "OBJECT",
        properties: {
          clearExistingReadyAndBacklog: { type: "BOOLEAN", description: "Remove the board's Backlog and Ready cards first. Default false." },
          autoAdvanceWave: { type: "BOOLEAN", description: "When a card finishes, start the next runnable one. Default: unchanged." },
          cards: {
            type: "ARRAY",
            items: {
              type: "OBJECT",
              properties: {
                tempId: { type: "STRING", description: 'This card\'s name within the plan, e.g. "t1".' },
                ...cardFields(["backlog", "ready", "in_progress"]),
                blockedBy: { ...STRING_LIST, description: "tempIds in this plan, or kb_<n> ids on the board, that must be done first." },
                parentTempId: { type: "STRING", description: "The epic card's tempId. Optional." },
              },
              required: ["title", "category"],
            },
          },
        },
        required: ["cards"],
      },
    },
    {
      name: "kanban_create_card",
      description: "Adds one card to the project's Kanban board and returns its kb_<n> id.",
      parameters: {
        type: "OBJECT",
        properties: { ...cardFields(KANBAN_COLUMNS), blockedBy: { ...STRING_LIST, description: "kb_<n> ids that must be done first." } },
        required: ["title", "category"],
      },
    },
    {
      name: "kanban_update_card",
      description:
        'Changes one card. Move it to "in_progress" when you start it, and to "done" when its work is finished, with the editLogIds or artifacts it produced, or to "blocked" with blockedReason. Only the fields you pass change; editLogIds and artifacts are added to the card\'s. Says which cards finishing it let run.',
      parameters: {
        type: "OBJECT",
        properties: {
          cardId: { type: "STRING", description: 'The card, e.g. "kb_3".' },
          column: { type: "STRING", enum: [...KANBAN_COLUMNS] },
          title: { type: "STRING" },
          description: { type: "STRING" },
          priority: PRIORITY,
          category: CATEGORY,
          assigneeRole: ROLE,
          stationKey: STATION,
          blockedBy: { ...STRING_LIST, description: "Replaces the cards it waits on (kb_<n> ids)." },
          blockedReason: { type: "STRING", description: "Why it's blocked." },
          checkItemsDone: { ...STRING_LIST, description: "Checklist items to tick: their ids (c1…) or exact text." },
          editLogIds: { ...STRING_LIST, description: "Edit Log ids (e<n>) the card made." },
          artifacts: { ...STRING_LIST, description: "What it produced: file paths or short summaries." },
          validationToken: { type: "STRING", description: "A passing propose_otio_delta's vtok_ token." },
          deltaId: { type: "STRING" },
        },
        required: ["cardId"],
      },
    },
    {
      name: "kanban_delete_cards",
      description: "Removes cards from the project's Kanban board (and from the cards that wait on them), or every Done card with clearDone.",
      parameters: { type: "OBJECT", properties: { cardIds: STRING_LIST, clearDone: { type: "BOOLEAN" } } },
    },
    {
      name: "kanban_seed_from_findings",
      description:
        "Turns findings into timecoded Kanban cards, each assigned to the sub-agent that fixes that kind of problem: review_edit's automatic check (no vision critic), check_pacing, or client notes (notesText, or the timeline's open markers when you leave it out). Cards already on the board (same title and time) are skipped. Only reads the timeline.",
      parameters: {
        type: "OBJECT",
        properties: {
          source: { type: "STRING", enum: ["review_edit", "check_pacing", "client_notes"] },
          notesText: { type: "STRING", description: "The client's notes, pasted. Optional; with client_notes and no text, the timeline's markers are read." },
          targetColumn: { type: "STRING", enum: ["backlog", "ready"], description: "Default ready." },
        },
        required: ["source"],
      },
    },
    {
      name: "kanban_sync_markers",
      description: `Mirrors the board on the open timeline's markers. board_to_timeline puts a marker named "[kb_<n>] <title>" at each time-ranged card's start, coloured by column (Yellow backlog/ready, Cyan in progress, Purple review, Red blocked, Green done, with "${DONE_MARK.trim()} " before a done card's name). timeline_to_board marks cards done whose marker was ticked with "${DONE_MARK.trim()} ", and adds markers named "TODO:", "NOTE:" or "FIX:" to the Backlog. Default both.`,
      parameters: {
        type: "OBJECT",
        properties: {
          direction: { type: "STRING", enum: ["board_to_timeline", "timeline_to_board", "both"] },
          includeDone: { type: "BOOLEAN", description: "Also mark done cards. Default false." },
        },
      },
    },
  ];
}

const oneOf = <T extends string>(allowed: readonly T[], value: unknown, key: string): T | undefined => {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "string" && (allowed as readonly string[]).includes(value)) return value as T;
  throw new Error(`${key} must be one of ${allowed.join(", ")}`);
};

const stringList = (args: Args, key: string): string[] | undefined => {
  const value = args[key];
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value) || !value.every((v) => typeof v === "string")) throw new Error(`${key} must be a list of strings`);
  return value as string[];
};

/** A card input from a tool call's arguments (kanban_create_card, or one card of a plan). */
function cardInput(args: Args): CardInput {
  const category = oneOf(KANBAN_CATEGORIES, args.category, "category");
  if (!category) throw new Error(`category must be one of ${KANBAN_CATEGORIES.join(", ")}`);
  return {
    title: optStr(args, "title") ?? "",
    category,
    description: optStr(args, "description"),
    priority: oneOf(KANBAN_PRIORITIES, args.priority, "priority"),
    column: oneOf(KANBAN_COLUMNS, args.column, "column"),
    assigneeRole: oneOf(KANBAN_SUBAGENT_ROLES, args.assigneeRole, "assigneeRole"),
    stationKey: optStr(args, "stationKey"),
    timeline: optStr(args, "timeline"),
    startSeconds: optNum(args, "startSeconds"),
    endSeconds: optNum(args, "endSeconds"),
    tracks: stringList(args, "tracks"),
    clipIds: stringList(args, "clipIds"),
    mediaPaths: stringList(args, "mediaPaths"),
    blockedBy: stringList(args, "blockedBy"),
    checklist: stringList(args, "checklist"),
    autoPrompt: optStr(args, "autoPrompt"),
    createdBy: "orchestrator",
  };
}

/** A card as tool results show it: what's set, plus what it still waits on. */
export function cardView(card: KanbanCard, all: readonly KanbanCard[]): Record<string, unknown> {
  const ctx = card.timelineContext;
  const exec = card.execution;
  const waitingOn = unresolvedBlockers(card, all).map((c) => c.id);
  return {
    id: card.id,
    title: card.title,
    ...(card.description ? { description: card.description } : {}),
    column: card.column,
    priority: card.priority,
    category: card.category,
    assignee: card.assignee,
    ...(ctx.timeline ? { timeline: ctx.timeline } : {}),
    ...(ctx.startSeconds !== null ? { startSeconds: ctx.startSeconds } : {}),
    ...(ctx.endSeconds !== null ? { endSeconds: ctx.endSeconds } : {}),
    ...(ctx.tracks.length ? { tracks: ctx.tracks } : {}),
    ...(ctx.clipIds.length ? { clipIds: ctx.clipIds } : {}),
    ...(ctx.mediaPaths.length ? { mediaPaths: ctx.mediaPaths } : {}),
    ...(card.blockedBy.length ? { blockedBy: card.blockedBy } : {}),
    ...(waitingOn.length ? { waitingOn } : {}),
    ...(card.parentCardId ? { parentCardId: card.parentCardId } : {}),
    ...(card.checklist.length ? { checklist: card.checklist } : {}),
    ...(exec.autoPrompt ? { autoPrompt: exec.autoPrompt } : {}),
    ...(exec.blockedReason ? { blockedReason: exec.blockedReason } : {}),
    ...(exec.editLogIds.length ? { editLogIds: exec.editLogIds } : {}),
    ...(exec.artifacts.length ? { artifacts: exec.artifacts } : {}),
    ...(exec.deltaId ? { deltaId: exec.deltaId } : {}),
    ...(exec.reviewCardId ? { waitingForReview: true } : {}),
    ...(exec.progress ? { progress: exec.progress } : {}),
  };
}

const counts = (cards: readonly KanbanCard[]) => Object.fromEntries(KANBAN_COLUMNS.map((c) => [c, cards.filter((card) => card.column === c).length]));

/** The board's colour for each column's marker (spec §5.1.7); valid in both editors. */
export const MARKER_COLORS: Record<KanbanColumnId, string> = {
  backlog: "Yellow",
  ready: "Yellow",
  in_progress: "Cyan",
  review: "Purple",
  blocked: "Red",
  done: "Green",
};
const MARKER_NAME_CHARS = 80;
/** A board marker's name: "[kb_3] title", or "✓ [kb_3] title" when done. */
const BOARD_MARKER = /^(✓\s*)?\[(kb_\d+)\]/;
const IMPORT_MARKER = /^(TODO|NOTE|FIX)\s*:\s*/i;

export const markerName = (card: KanbanCard) => `${card.column === "done" ? DONE_MARK : ""}[${card.id}] ${card.title}`.slice(0, MARKER_NAME_CHARS);

/** What kind of work a finding or a note is: its category and, when not the category's own, its desk. */
export function classifyFinding(category: string, text: string): { category: KanbanCategory; stationKey?: string } {
  switch (category) {
    case "loudness":
    case "true_peak":
    case "no_sound":
    case "level_jump":
    case "clipping":
    case "dead_air":
      return { category: "audio" };
    case "flash_frame":
    case "black":
    case "offline":
    case "switched_off":
    case "past_end":
      return { category: "qc", stationKey: "worker.color_nle" };
    case "mid_word_cut":
    case "out_of_sync":
    case "long_shot":
    case "slow_stretch":
    case "slow_opening":
    case "pace":
      return { category: "cut" };
    default: {
      const t = text.toLowerCase();
      if (/\bb-?roll\b|cutaway|cover (this|it|the)/.test(t)) return { category: "broll" };
      if (/colou?r|grade|exposure|too (dark|bright)|skin ?tone|white balance/.test(t)) return { category: "color" };
      if (/music|audio|sound|loud|quiet|volume|mix|noise|\bvo\b/.test(t)) return { category: "audio" };
      if (/title|lower third|caption|subtitle|logo|text|graphic/.test(t)) return { category: "gfx" };
      return { category: "cut" };
    }
  }
}

const SEVERITY_PRIORITY: Record<string, KanbanPriority> = { high: "high", medium: "medium", low: "low" };
const titleOf = (text: string) => {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > 80 ? `${line.slice(0, 79)}…` : line;
};
const dedupeKey = (title: string, start: number | null | undefined) => `${title.toLowerCase()}|${start === null || start === undefined ? "" : Math.round(start * 10)}`;

interface Finding {
  time?: number;
  end?: number;
  severity?: string;
  category?: string;
  text: string;
  clipIds?: string[];
}

export function kanbanExecutors(context: ToolContext): Record<string, Executor> {
  const { host } = context;

  /** The connected editor project's board, loaded if the board on show is another one. */
  const board = async () => {
    const project = useNleStateStore.getState().hosts[host].project?.trim();
    if (!project) throw new Error("No project is open in the editor, so there's no project board");
    const store = useKanbanStore.getState();
    if (!store.loaded || store.scope.host !== host || store.scope.project !== project) await store.loadScope({ host, project });
    return useKanbanStore.getState();
  };

  /** Writes now, so the result can say if the save failed. */
  const saved = async () => {
    await useKanbanStore.getState().flush();
    const error = useKanbanStore.getState().error;
    return error ? { warning: error } : {};
  };

  const project = () => useKanbanStore.getState().board.project;

  return {
    kanban_list_cards: async (args) => {
      const store = await board();
      const column = oneOf(KANBAN_COLUMNS, args.column, "column");
      const category = oneOf(KANBAN_CATEGORIES, args.category, "category");
      const role = oneOf(KANBAN_SUBAGENT_ROLES, args.assigneeRole, "assigneeRole");
      const includeDone = bool(args, "includeDone", true);
      const all = store.board.cards;
      const cards = all.filter(
        (c) => (!column || c.column === column) && (!category || c.category === category) && (!role || c.assignee.role === role) && (includeDone || column === "done" || c.column !== "done"),
      );
      const frontier = readyWaveFrontier(all).map((c) => c.id);
      return {
        summary: `Kanban board for "${project()}": ${all.length} card(s), ${frontier.length} ready to run${cards.length !== all.length ? `; ${cards.length} match` : ""}`,
        result: { project: project(), counts: counts(all), frontier, autoAdvanceWave: store.board.autoAdvanceWave, cards: cards.map((c) => cardView(c, all)) },
      };
    },

    kanban_plan_workflow: async (args) => {
      const store = await board();
      const raw = args.cards;
      if (!Array.isArray(raw) || !raw.length) throw new Error("cards must be a non-empty list");
      const inputs: PlanCardInput[] = raw.map((value, i) => {
        if (typeof value !== "object" || value === null) throw new Error(`cards[${i}] must be an object`);
        const card = value as Args;
        return { ...cardInput(card), tempId: optStr(card, "tempId"), parentTempId: optStr(card, "parentTempId") };
      });
      const autoAdvance = typeof args.autoAdvanceWave === "boolean" ? args.autoAdvanceWave : undefined;
      const { created, removed } = store.planWorkflow(inputs, { clearExisting: bool(args, "clearExistingReadyAndBacklog"), autoAdvanceWave: autoAdvance, createdBy: "orchestrator" });
      const all = useKanbanStore.getState().board.cards;
      const frontier = readyWaveFrontier(all).map((c) => c.id);
      const temp = Object.fromEntries(inputs.flatMap((input, i) => (input.tempId ? [[input.tempId, created[i].id]] : [])));
      return {
        summary: `Planned ${created.length} card(s) on "${project()}": ${created.map((c) => `${c.id} ${c.title}`).join("; ")}${removed.length ? ` (cleared ${removed.length} old)` : ""}`,
        result: { created: created.map((c) => cardView(c, all)), tempIds: temp, frontier, ...(removed.length ? { removed } : {}), ...(await saved()) },
      };
    },

    kanban_create_card: async (args) => {
      const store = await board();
      const card = store.createCard(cardInput(args));
      return {
        summary: `Added ${card.id} "${card.title}" to ${card.column} (${card.assignee.label})`,
        result: { card: cardView(card, useKanbanStore.getState().board.cards), ...(await saved()) },
      };
    },

    kanban_update_card: async (args) => {
      const store = await board();
      const cardId = optStr(args, "cardId");
      const current = store.board.cards.find((c) => c.id === cardId);
      if (!cardId || !current) throw new Error(`${cardId ?? "cardId"} isn't on the board; kanban_list_cards lists the cards`);
      const column = oneOf(KANBAN_COLUMNS, args.column, "column");
      const category = oneOf(KANBAN_CATEGORIES, args.category, "category");
      const role = oneOf(KANBAN_SUBAGENT_ROLES, args.assigneeRole, "assigneeRole");
      const station = optStr(args, "stationKey");
      const patch: CardPatch = {};
      for (const key of ["title", "description"] as const) {
        const value = optStr(args, key);
        if (value !== undefined) patch[key] = value;
      }
      if (column) patch.column = column;
      const priority = oneOf(KANBAN_PRIORITIES, args.priority, "priority");
      if (priority) patch.priority = priority;
      if (category) patch.category = category;
      // A new category alone keeps the card's sub-agent; naming a role or desk reassigns it.
      if (role || station) patch.assignee = resolveAssignee(category ?? current.category, role, station);
      const blockedBy = stringList(args, "blockedBy");
      if (blockedBy) patch.blockedBy = blockedBy;
      const execution: NonNullable<CardPatch["execution"]> = {};
      const reason = optStr(args, "blockedReason");
      if (reason !== undefined) execution.blockedReason = reason.trim() || null;
      else if (column && column !== "blocked") execution.blockedReason = null;
      const edits = stringList(args, "editLogIds");
      if (edits) execution.editLogIds = [...new Set([...current.execution.editLogIds, ...edits])];
      const artifacts = stringList(args, "artifacts");
      if (artifacts) execution.artifacts = [...new Set([...current.execution.artifacts, ...artifacts])];
      for (const key of ["validationToken", "deltaId"] as const) {
        const value = optStr(args, key);
        if (value) execution[key] = value;
      }
      if (column === "done" || column === "blocked" || column === "ready" || column === "backlog") execution.progress = null;
      if (Object.keys(execution).length) patch.execution = execution;
      const ticks = stringList(args, "checkItemsDone");
      if (ticks) {
        const wanted = new Set(ticks.map((t) => t.trim().toLowerCase()));
        const unknown = [...wanted].filter((w) => !current.checklist.some((item) => item.id.toLowerCase() === w || item.text.toLowerCase() === w));
        if (unknown.length) throw new Error(`${cardId} has no checklist item ${unknown.join(", ")}; its items are ${current.checklist.map((i) => `${i.id} "${i.text}"`).join(", ") || "none"}`);
        patch.checklist = current.checklist.map((item) => (wanted.has(item.id.toLowerCase()) || wanted.has(item.text.toLowerCase()) ? { ...item, done: true } : item));
      }
      if (!Object.keys(patch).length) throw new Error("Nothing to change: pass at least one field");
      const card = store.updateCard(cardId, patch);
      // The card the agent starts is the turn's card, so its edits and jobs are linked to it.
      if (card.column === "in_progress") useKanbanStore.getState().setActiveTurnCardId(card.id);
      const all = useKanbanStore.getState().board.cards;
      const unblocked = card.column === "done" && current.column !== "done" ? newlyUnblocked(card.id, all).map((c) => c.id) : [];
      return {
        summary: `${card.id} "${card.title}" is ${card.column === current.column ? "updated" : `now ${card.column}`}${unblocked.length ? `; ${unblocked.join(", ")} can run now` : ""}`,
        result: { card: cardView(card, all), ...(unblocked.length ? { unblocked } : {}), ...(await saved()) },
      };
    },

    kanban_delete_cards: async (args) => {
      const store = await board();
      const ids = stringList(args, "cardIds") ?? [];
      const clearDone = bool(args, "clearDone");
      if (!ids.length && !clearDone) throw new Error("Give cardIds, or clearDone=true");
      const unknown = ids.filter((id) => !store.board.cards.some((c) => c.id === id));
      const deleted = [...store.deleteCards(ids), ...(clearDone ? useKanbanStore.getState().clearDoneCards() : [])];
      return {
        summary: deleted.length ? `Removed ${deleted.length} card(s) from the board: ${deleted.join(", ")}` : "No cards removed",
        result: { deleted, ...(unknown.length ? { notOnBoard: unknown } : {}), ...(await saved()) },
      };
    },

    kanban_seed_from_findings: async (args) => {
      await board();
      const source = oneOf(["review_edit", "check_pacing", "client_notes"] as const, args.source, "source");
      if (!source) throw new Error("source must be one of review_edit, check_pacing, client_notes");
      const column = oneOf(["backlog", "ready"] as const, args.targetColumn, "targetColumn") ?? "ready";
      const notesText = optStr(args, "notesText");
      let findings: Finding[];
      let read: string;
      if (source === "review_edit") {
        const outcome = await reviewExecutors(context).review_edit({ visual: false });
        const result = outcome.result as { automaticCheck?: { time: number; end?: number; severity: string; category: string; message: string; clipIds: string[] }[] };
        findings = (result.automaticCheck ?? []).map((f) => ({ time: f.time, end: f.end, severity: f.severity, category: f.category, text: f.message, clipIds: f.clipIds }));
        read = outcome.summary;
      } else if (source === "check_pacing") {
        const outcome = await pacingExecutors(context).check_pacing({});
        const result = outcome.result as { findings?: { time: number; end: number; severity: string; category: string; message: string; clipIds: string[] }[] };
        findings = (result.findings ?? []).map((f) => ({ time: f.time, end: f.end, severity: f.severity, category: f.category, text: f.message, clipIds: f.clipIds }));
        read = outcome.summary.split("\n")[0];
      } else {
        const outcome = await clientNotesExecutors(context).read_client_notes(notesText ? { text: notesText } : { fromMarkers: true });
        const result = outcome.result as { notes?: { time: number; end?: number; text: string; problem?: string }[]; general?: string[] };
        findings = [
          ...(result.notes ?? []).filter((n) => !n.problem && n.text.trim()).map((n) => ({ time: n.time, end: n.end, text: n.text })),
          ...(result.general ?? []).map((text) => ({ text })),
        ];
        read = outcome.summary.split("\n")[0];
      }
      const existing = new Set(useKanbanStore.getState().board.cards.map((c) => dedupeKey(c.title, c.timelineContext.startSeconds)));
      const inputs: PlanCardInput[] = [];
      let skipped = 0;
      for (const finding of findings) {
        const title = titleOf(finding.text);
        const key = dedupeKey(title, finding.time);
        if (!title || existing.has(key)) {
          skipped++;
          continue;
        }
        existing.add(key);
        const kind = classifyFinding(finding.category ?? "", finding.text);
        inputs.push({
          title,
          description: `${finding.text}${finding.time !== undefined ? ` (found by ${source} at ${clock(finding.time)})` : ` (from ${source})`}`,
          category: kind.category,
          stationKey: kind.stationKey,
          priority: SEVERITY_PRIORITY[finding.severity ?? ""] ?? "medium",
          column,
          timeline: context.timeline,
          startSeconds: finding.time ?? null,
          endSeconds: finding.end !== undefined && finding.time !== undefined && finding.end >= finding.time ? finding.end : null,
          clipIds: finding.clipIds,
          createdBy: source === "client_notes" ? "client_notes" : "qc_lint",
        });
      }
      const kept = inputs.slice(0, MAX_PLAN_CARDS);
      const created = kept.length ? useKanbanStore.getState().planWorkflow(kept, { createdBy: "qc_lint" }).created : [];
      const all = useKanbanStore.getState().board.cards;
      const left = inputs.length - kept.length;
      return {
        summary: `${read}. Added ${created.length} card(s) to ${column}${skipped ? `; ${skipped} already on the board` : ""}${left ? `; ${left} more not added (at most ${MAX_PLAN_CARDS} at once)` : ""}`,
        result: { source, created: created.map((c) => cardView(c, all)), skipped, ...(left ? { notAdded: left } : {}), ...(created.length ? await saved() : {}) },
      };
    },

    kanban_sync_markers: async (args) => {
      await board();
      const timeline = context.timeline;
      if (!timeline) throw new Error("No timeline is open in the editor, so there are no markers to sync");
      const direction = oneOf(["board_to_timeline", "timeline_to_board", "both"] as const, args.direction, "direction") ?? "both";
      const includeDone = bool(args, "includeDone");
      return syncMarkers(host, timeline, direction, includeDone, saved);
    },
  };
}

async function syncMarkers(
  host: NleHost,
  timeline: string,
  direction: "board_to_timeline" | "timeline_to_board" | "both",
  includeDone: boolean,
  saved: () => Promise<Record<string, unknown>>,
) {
  const call = <T>(command: string, args: Record<string, unknown> = {}) => nleCall<T>(host, command, { timeline, ...args });
  const store = () => useKanbanStore.getState();
  const { markers } = await call<{ markers: HostMarker[] }>("list_markers");
  const report: Record<string, unknown> = {};
  const lines: string[] = [];

  if (direction !== "board_to_timeline") {
    const finished: string[] = [];
    const imported: string[] = [];
    for (const marker of markers) {
      const linked = BOARD_MARKER.exec(marker.name);
      if (linked) {
        const card = store().board.cards.find((c) => c.id === linked[2]);
        if (card && linked[1] && card.column !== "done") {
          store().updateCard(card.id, { column: "done", execution: { progress: null, blockedReason: null } });
          finished.push(card.id);
        }
        continue;
      }
      const todo = IMPORT_MARKER.exec(marker.name);
      if (!todo) continue;
      const known = store().board.cards.some((c) => c.timelineContext.markerId === marker.id || dedupeKey(c.title, c.timelineContext.startSeconds) === dedupeKey(titleOf(marker.name.slice(todo[0].length)), marker.time));
      const text = marker.name.slice(todo[0].length).trim();
      if (known || !text) continue;
      const kind = classifyFinding("", `${text} ${marker.note}`);
      const card = store().createCard({
        title: titleOf(text),
        description: marker.note ? `${marker.note} (from the marker at ${clock(marker.time)})` : `From the marker at ${clock(marker.time)}`,
        category: kind.category,
        stationKey: kind.stationKey,
        column: "backlog",
        priority: todo[1].toUpperCase() === "FIX" ? "high" : "medium",
        timeline,
        startSeconds: marker.time,
        endSeconds: marker.duration > 0.05 ? marker.time + marker.duration : null,
        createdBy: "user",
      });
      store().updateCard(card.id, { timelineContext: { markerId: marker.id } });
      imported.push(card.id);
    }
    report.markedDone = finished;
    report.imported = imported;
    lines.push(`${finished.length} card(s) marked done from ticked markers, ${imported.length} imported from TODO/NOTE/FIX markers`);
  }

  if (direction !== "timeline_to_board") {
    const byCard = new Map<string, HostMarker>();
    const byId = new Map(markers.map((m) => [m.id, m]));
    for (const marker of markers) {
      const linked = BOARD_MARKER.exec(marker.name);
      if (linked) byCard.set(linked[2], marker);
    }
    const cards = store().board.cards.filter(
      (c) => c.timelineContext.startSeconds !== null && (!c.timelineContext.timeline || c.timelineContext.timeline === timeline) && (includeDone || c.column !== "done"),
    );
    const toAdd: KanbanCard[] = [];
    const updated: string[] = [];
    const problems: string[] = [];
    for (const card of cards) {
      const own = card.timelineContext.markerId ? byId.get(card.timelineContext.markerId) : undefined;
      // A card imported from the user's own TODO marker keeps that marker as it is.
      if (own && !BOARD_MARKER.test(own.name)) continue;
      const marker = byCard.get(card.id);
      if (!marker) {
        toAdd.push(card);
        continue;
      }
      const name = markerName(card);
      const color = MARKER_COLORS[card.column];
      if (marker.name !== name || marker.color.toLowerCase() !== color.toLowerCase()) {
        try {
          const changed = await call<{ id: string }>("update_marker", { markerId: marker.id, name, color });
          if (changed.id !== card.timelineContext.markerId) store().updateCard(card.id, { timelineContext: { markerId: changed.id } });
          updated.push(card.id);
        } catch (error) {
          problems.push(`${card.id}: ${error instanceof Error ? error.message : String(error)}`);
        }
      } else if (marker.id !== card.timelineContext.markerId) {
        store().updateCard(card.id, { timelineContext: { markerId: marker.id } });
      }
    }
    let added: string[] = [];
    let alreadyThere = 0;
    if (toAdd.length) {
      const result = await call<{ added: { id: string; time: number; name: string }[]; alreadyThere: string[]; refusedAt: number[] }>("add_markers", {
        markers: toAdd.map((card) => ({
          time: card.timelineContext.startSeconds,
          name: markerName(card),
          color: MARKER_COLORS[card.column],
          ...(card.description ? { note: card.description.slice(0, 200) } : {}),
          ...(card.timelineContext.endSeconds !== null ? { duration: Math.max(0, card.timelineContext.endSeconds - (card.timelineContext.startSeconds ?? 0)) } : {}),
        })),
      });
      added = result.added.flatMap((m) => {
        const id = BOARD_MARKER.exec(m.name)?.[2];
        if (!id) return [];
        store().updateCard(id, { timelineContext: { markerId: m.id } });
        return [id];
      });
      alreadyThere = result.alreadyThere.length;
      if (result.refusedAt.length) problems.push(`the editor refused markers at ${result.refusedAt.map(clock).join(", ")}`);
    }
    report.added = added;
    report.updated = updated;
    if (alreadyThere) report.alreadyHadAMarker = alreadyThere;
    if (problems.length) report.problems = problems;
    lines.push(`${added.length} marker(s) added, ${updated.length} updated${alreadyThere ? `, ${alreadyThere} frame(s) already had a marker` : ""}`);
  }

  return { summary: `Synced the board with "${timeline}"'s markers: ${lines.join("; ")}`, result: { timeline, ...report, ...(await saved()) } };
}

/** The ground rules the system prompt gains (Phase 23). */
export const KANBAN_INSTRUCTION = `- The project has a Kanban board; the snapshot shows it once it has cards ([KANBAN BOARD]). Plan before you
  edit: when a request has more than one stage (transcribe then cut, cut then mix, several fixes across the
  timeline, or anything that waits on a background job or takes several turns), call kanban_plan_workflow
  before any other tool, one card per stage linked with blockedBy, each for its sub-agent (INGEST_TRANSCRIBE,
  VISION_TAGGER, BROLL_RETRIEVER, PACING_CUTTER, AUDIO_ENGINEER, COLOR_GRADER, or HUMAN_EDITOR for what only
  the user can do). Say which cards you made, then start the first one that can run. A single-step request
  (one change, one question, one read) doesn't go on the board. When the request continues work already on
  the board, use its cards instead of planning new ones.
- When you work on a card (a message starting "[Kanban Task kb_<n>]", or the user pointing at @kb_<n>),
  kanban_update_card it to "in_progress" first, and when it's finished to "done" with the editLogIds or
  artifacts it produced, or to "blocked" with blockedReason if something stops it.
- kanban_seed_from_findings turns review_edit, check_pacing or client notes into cards; kanban_sync_markers
  mirrors the board as colour-coded markers on the timeline when the user wants that.`;
