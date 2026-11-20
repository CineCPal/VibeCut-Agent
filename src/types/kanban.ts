/**
 * The project Kanban board (`vibecut.kanban.v1`, docs/specs/kanban-spec.md, PLAN.md "Phase 23").
 * Shared by the main window (src/), the in-host panels (src-premiere-panel-ui/) and the agent's
 * `kanban_*` tools (src/lib/agent/kanbanTools.ts). Stored per editor project by src-tauri/src/kanban.rs.
 */
import type { NleHost } from "./nle";

export const KANBAN_SCHEMA_VERSION = "vibecut.kanban.v1" as const;

export const KANBAN_COLUMNS = ["backlog", "ready", "in_progress", "review", "done", "blocked"] as const;
export type KanbanColumnId = (typeof KANBAN_COLUMNS)[number];

export const KANBAN_COLUMN_META: Record<KanbanColumnId, { label: string; shortLabel: string; hint: string }> = {
  backlog: { label: "Backlog", shortLabel: "Backlog", hint: "Client notes, QC findings, and unscheduled editorial ideas" },
  ready: {
    label: "Ready",
    shortLabel: "Ready",
    hint: "Scoped tasks assigned to a sub-agent or bot, ready to execute once dependencies finish",
  },
  in_progress: {
    label: "In Progress",
    shortLabel: "Active",
    hint: "Currently executing in the orchestrator, a local sub-agent worker, or a background bot",
  },
  review: {
    label: "Needs Review",
    shortLabel: "Review",
    hint: "Awaiting your Apply/Skip on an edit review card, a validated OTIO delta, or an open draft",
  },
  done: { label: "Done", shortLabel: "Done", hint: "Committed to the timeline or media cache, linked to reversible Edit Log entries" },
  blocked: {
    label: "Blocked",
    shortLabel: "Blocked",
    hint: "Halted by offline media, locked tracks, a stale timeline, or a declined review",
  },
};

export const KANBAN_PRIORITIES = ["critical", "high", "medium", "low"] as const;
export type KanbanPriority = (typeof KANBAN_PRIORITIES)[number];

/** Wave order: lower runs first. */
export const PRIORITY_RANK: Record<KanbanPriority, number> = { critical: 0, high: 1, medium: 2, low: 3 };

export const KANBAN_CATEGORIES = ["ingest", "transcript", "story", "broll", "cut", "audio", "color", "gfx", "qc", "delivery"] as const;
export type KanbanCategory = (typeof KANBAN_CATEGORIES)[number];

export const KANBAN_SUBAGENT_ROLES = [
  "MASTER_ORCHESTRATOR",
  "INGEST_TRANSCRIBE",
  "VISION_TAGGER",
  "BROLL_RETRIEVER",
  "PACING_CUTTER",
  "AUDIO_ENGINEER",
  "COLOR_GRADER",
  "HUMAN_EDITOR",
] as const;
export type KanbanAssigneeRole = (typeof KANBAN_SUBAGENT_ROLES)[number];

export interface KanbanAssignee {
  /** The sub-agent role (`SubagentType` in packages/contracts/telemetry.ts), or HUMAN_EDITOR. */
  role: KanbanAssigneeRole;
  /** A Telemetry Studio desk (apps/visualizer/src/lib/studio/stations.ts), e.g. "worker.whisper". */
  stationKey: string;
  /** The badge on the card, e.g. "Whisper STT". */
  label: string;
}

export interface KanbanTimelineContext {
  timeline: string | null;
  /** Timeline seconds; a card with a start can jump the playhead and carry a marker. */
  startSeconds: number | null;
  endSeconds: number | null;
  tracks: string[];
  clipIds: string[];
  mediaPaths: string[];
  /** The editor marker mirroring this card, when marker sync placed one. */
  markerId: string | null;
}

export interface KanbanJobProgress {
  /** 0..1, or null when indeterminate. */
  fraction: number | null;
  phase: string | null;
  etaSeconds: number | null;
}

export interface KanbanCardExecution {
  mode: "agent_turn" | "background_bot" | "manual";
  /** What the agent is asked when the card runs; the description is used when this is empty. */
  autoPrompt: string | null;
  /** The sidecar job working on the card (useSidecarStore), attached while the card's turn ran. */
  activeJobId: string | null;
  /** The Telemetry Studio trace, when known. */
  traceId: string | null;
  /** Live progress of `activeJobId`. Kept in memory only; never saved. */
  progress: KanbanJobProgress | null;
  /** The `vtok_*` token of the card's passing `propose_otio_delta`. */
  validationToken: string | null;
  deltaId: string | null;
  /** The chat's pending "Review edits first" tool card waiting for Apply or Skip. */
  reviewCardId: string | null;
  /** Edit Log entries (`e<n>`) this card made. */
  editLogIds: string[];
  /** What the card produced: `.otio` snapshots, transcripts, renders, summaries. */
  artifacts: string[];
  /** Why the card is blocked. */
  blockedReason: string | null;
}

export interface KanbanChecklistItem {
  id: string;
  text: string;
  done: boolean;
}

export type KanbanCardOrigin = "user" | "orchestrator" | "subagent" | "bot" | "client_notes" | "qc_lint";

export interface KanbanCard {
  /** "kb_1", "kb_2", ...: never reused on a board. */
  id: string;
  title: string;
  description: string;
  column: KanbanColumnId;
  priority: KanbanPriority;
  category: KanbanCategory;
  assignee: KanbanAssignee;
  timelineContext: KanbanTimelineContext;
  /** Cards that must be done before this one can run. */
  blockedBy: string[];
  parentCardId: string | null;
  checklist: KanbanChecklistItem[];
  execution: KanbanCardExecution;
  createdBy: KanbanCardOrigin;
  createdAt: number;
  updatedAt: number;
  completedAt: number | null;
}

/** The board's host: an editor, or "global" for the board kept when no editor project is open. */
export type KanbanHost = NleHost | "global";

export interface KanbanBoardFile {
  schemaVersion: typeof KANBAN_SCHEMA_VERSION;
  host: KanbanHost;
  project: string;
  /** The next card's number ("kb_<n>"); never goes down. */
  nextCardSeq: number;
  /** When on, a finished card's turn or job starts the next runnable Ready card. */
  autoAdvanceWave: boolean;
  updatedAt: number;
  cards: KanbanCard[];
}

export const GLOBAL_PROJECT = "Workspace";

/** The sub-agent and desk a card goes to when it names only its category (spec §2.1). */
export const DEFAULT_CATEGORY_ASSIGNEE: Record<KanbanCategory, KanbanAssignee> = {
  ingest: { role: "VISION_TAGGER", stationKey: "worker.vlm", label: "Vision Ingest" },
  transcript: { role: "INGEST_TRANSCRIBE", stationKey: "worker.whisper", label: "Whisper STT" },
  story: { role: "MASTER_ORCHESTRATOR", stationKey: "orchestrator.supervisor", label: "Story Supervisor" },
  broll: { role: "BROLL_RETRIEVER", stationKey: "worker.vector", label: "B-Roll Retriever" },
  cut: { role: "PACING_CUTTER", stationKey: "worker.otio_cutter", label: "OTIO Cutter" },
  audio: { role: "AUDIO_ENGINEER", stationKey: "app.audio_mix", label: "Audio Engineer" },
  color: { role: "COLOR_GRADER", stationKey: "app.color", label: "Colour Grader" },
  gfx: { role: "COLOR_GRADER", stationKey: "app.titles", label: "Titles & Captions" },
  qc: { role: "PACING_CUTTER", stationKey: "app.review", label: "Review & QC" },
  delivery: { role: "COLOR_GRADER", stationKey: "app.deliver", label: "Deliver & Export" },
};

/** The desk a role goes to when a card names a role but no desk. */
export const DEFAULT_ROLE_ASSIGNEE: Record<KanbanAssigneeRole, KanbanAssignee> = {
  MASTER_ORCHESTRATOR: { role: "MASTER_ORCHESTRATOR", stationKey: "orchestrator.supervisor", label: "Story Supervisor" },
  INGEST_TRANSCRIBE: { role: "INGEST_TRANSCRIBE", stationKey: "worker.whisper", label: "Whisper STT" },
  VISION_TAGGER: { role: "VISION_TAGGER", stationKey: "worker.vlm", label: "Vision Model" },
  BROLL_RETRIEVER: { role: "BROLL_RETRIEVER", stationKey: "worker.vector", label: "B-Roll Retriever" },
  PACING_CUTTER: { role: "PACING_CUTTER", stationKey: "worker.otio_cutter", label: "OTIO Cutter" },
  AUDIO_ENGINEER: { role: "AUDIO_ENGINEER", stationKey: "app.audio_mix", label: "Audio Engineer" },
  COLOR_GRADER: { role: "COLOR_GRADER", stationKey: "app.color", label: "Colour Grader" },
  HUMAN_EDITOR: { role: "HUMAN_EDITOR", stationKey: "human.editor", label: "Human Editor" },
};

export function emptyExecution(): KanbanCardExecution {
  return {
    mode: "agent_turn",
    autoPrompt: null,
    activeJobId: null,
    traceId: null,
    progress: null,
    validationToken: null,
    deltaId: null,
    reviewCardId: null,
    editLogIds: [],
    artifacts: [],
    blockedReason: null,
  };
}

export function emptyTimelineContext(): KanbanTimelineContext {
  return { timeline: null, startSeconds: null, endSeconds: null, tracks: [], clipIds: [], mediaPaths: [], markerId: null };
}

export function emptyBoard(host: KanbanHost, project: string, now = Date.now()): KanbanBoardFile {
  return { schemaVersion: KANBAN_SCHEMA_VERSION, host, project, nextCardSeq: 1, autoAdvanceWave: false, updatedAt: now, cards: [] };
}

/** "kb_12" -> true; card ids are always this shape. */
export const CARD_ID = /^kb_\d+$/;
