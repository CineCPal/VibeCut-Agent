/**
 * The "VibeCut Agent" panels in Premiere Pro and DaVinci Resolve (`vibecut.host.panels.v1`,
 * docs/specs/host-panels-plan.md) and the app: `state.json` (what the Chat and History tabs show) and the
 * actions a panel writes to `inbox/`. The B-roll tab reads `broll.json` (types/brollPanel.ts). Shared by
 * the app (src/lib/hostChatBridge.ts) and the panels (src-premiere-panel-ui/), and checked again by Rust
 * (src-tauri/src/host_chat.rs). No key, token or profile path is ever part of it.
 */
import type { AgentStatus, AiChoiceId, ClaudeFamily, EffortLevel, GeminiEffort, ToolFinding } from "./agent";
import type { PanelBrollAction } from "./brollPanel";
import type { NleConnectionStatus, NleHost } from "./nle";
import type { JobStatus } from "./sidecar";
import type { DayTotals, PlanLimits, UsageTotals } from "./usage";

/** 2: the editors' lights, the usage tracker, the last reply's timing, and `analyzer.json` (panel 0.20.0). */
export const HOST_PANEL_VERSION = 2;

export interface HostPanelToolCall {
  /** The tool message's id: a review card's id (`review_decision`). */
  id: string;
  name: string;
  /** The tool message's text. */
  summary: string;
  args: string;
  result?: string;
  state: "running" | "done" | "failed" | "pending" | "declined";
  findings?: ToolFinding[];
}

export interface HostPanelMessage {
  id: string;
  role: "user" | "assistant" | "tool" | "error" | "system";
  text: string;
  createdAt: number;
  /** "pending" while a reply streams in. */
  status?: "pending" | "done";
  tool?: HostPanelToolCall;
  /** How many images went with it (the panel doesn't get the images themselves). */
  imageCount?: number;
}

export interface HostPanelQueuedItem {
  id: string;
  text: string;
  imageCount: number;
}

export interface HostPanelHistoryEntry {
  id: string;
  title: string;
  updatedAt: number;
  messageCount: number;
}

export interface HostPanelPrompt {
  id: string;
  name: string;
  body: string;
}

/** One editor's light in the header, as the window's Pr/Re pills show it. */
export interface HostPanelEditorLight {
  host: NleHost;
  status: NleConnectionStatus;
  /** "Doc · Main", or what the connection lacks. */
  detail: string | null;
}

/** The usage tracker (the window's UsageMeter): the Claude plan's windows and the tokens used. */
export interface HostPanelUsage {
  plan: PlanLimits | null;
  planAt: number | null;
  /** This chat's totals, or null before its first turn. */
  chat: UsageTotals | null;
  today: DayTotals;
  week: DayTotals;
  /** The model labels, by id, for the totals tables. */
  labels: { id: AiChoiceId; label: string; subscription: boolean }[];
}

export interface HostPanelStateFile {
  version: typeof HOST_PANEL_VERSION;
  /** Stamped on every write, so the panel re-renders only on a change. */
  publishedAt: number;
  host: NleHost;
  editor: {
    connected: boolean;
    status: string;
    product: string | null;
    version: string | null;
    project: string | null;
    timeline: string | null;
    timelines: string[];
    /** Why the agent can't work in this editor now, or null. */
    noEditor: string | null;
    /** Why B-roll can't be placed now, or null. */
    noPlace: string | null;
  };
  /** Both editors, for the header's lights. */
  editors: HostPanelEditorLight[];
  usage: HostPanelUsage;
  agent: {
    status: AgentStatus;
    statusDetail: string | null;
    activity: string | null;
    aiChoice: AiChoiceId;
    choices: { id: AiChoiceId; label: string }[];
    effort: Record<ClaudeFamily, EffortLevel>;
    geminiEffort: GeminiEffort;
    reviewEdits: boolean;
    /** Claude Code is calling the agent's tools from outside (MCP). */
    outsideRunning: boolean;
    /** How long the last reply took to start ("first words 1.2 s · …"), or null. */
    lastReply: string | null;
  };
  chat: {
    chatId: string;
    title: string;
    /** The newest messages only (MAX_PANEL_MESSAGES). */
    messages: HostPanelMessage[];
    queue: HostPanelQueuedItem[];
    queuePaused: boolean;
    canRetry: boolean;
    /** Why Retry and Edit can't run now, or null. */
    rewindBlocked: string | null;
    /** The last turn's timeline edits that Retry would revert first. */
    lastTurnEdits: number;
    /** The latest request's edits that Revert undoes. */
    revertable: number;
    /** Those edits were made before the app last restarted. */
    earlierSessionRevert: boolean;
  };
  openDraft: {
    base: string;
    changes: string[];
    duration: number;
  } | null;
  history: HostPanelHistoryEntry[];
  prompts: HostPanelPrompt[];
  /** The answer to the panel's last action that has one (Revert, a draft, a failure). */
  notice: {
    actionId: string | null;
    text: string;
    failed: boolean;
    at: number;
  } | null;
}

/** A job's progress, as the window's JobProgress shows it. */
export interface HostPanelJob {
  label: string;
  status: JobStatus;
  /** 0..1, or null before the job reports progress. */
  fraction: number | null;
  detail: string | null;
  /** Seconds left, when it can be told. */
  eta: number | null;
  error: string | null;
}

/** A clip of the Analyzer's ranking or search, named by its place in the list (the panel never names paths). */
export interface HostAnalyzerClip {
  filename: string;
  score: number;
  start: number;
  end: number;
  duration: number;
  segments: { start: number; end: number; score?: number }[];
  /** Ranked clips: the segment indices left out of the selects. */
  excluded?: number[];
  /** Ranked clips: false when the Include setting leaves it out. */
  inSelection?: boolean;
  chips: string[];
  note: string | null;
}

/** `analyzer.json`: the window's Analyze tab (the B-roll Analyzer), for the panel's Analyze tab. */
export interface HostAnalyzerFile {
  version: typeof HOST_PANEL_VERSION;
  publishedAt: number;
  folder: string | null;
  contentAware: boolean;
  dedupe: boolean;
  brief: string;
  query: string;
  options: {
    windowSec: number;
    maxSegments: number;
    minGapSec: number;
    energyWeight: number;
    relevanceWeight: number;
    workers: number | null;
    topMode: "all" | "topn" | "threshold";
    topN: number;
    minScore: number;
    sequenceOrder: "score" | "name";
    sequenceName: string;
  };
  analyzeJob: HostPanelJob | null;
  matchJob: HostPanelJob | null;
  exportJob: HostPanelJob | null;
  analysis: {
    total: number;
    cached: number;
    duplicates: number;
    issues: string[];
    /** The scoring options changed since this run. */
    stale: string[];
    /** The best clips only (MAX_PANEL_CLIPS). */
    ranked: HostAnalyzerClip[];
  } | null;
  matches: HostAnalyzerClip[];
  selects: { segments: number; clips: number; seconds: number } | null;
  /** Why Build timeline, and Place, can't run now (null when they can). */
  buildBlocked: string | null;
  placeBlocked: string | null;
  /** Export, build, place or Source's last answer; `exported` when there's an XML to show in Finder. */
  notice: { actionId: string | null; text: string; failed: boolean; at: number; exported: boolean } | null;
}

/** The Analyzer options a panel may set, and their values. */
export type HostAnalyzerOption =
  | { key: "windowSec" | "maxSegments" | "minGapSec" | "energyWeight" | "relevanceWeight" | "topN" | "minScore"; value: number }
  | { key: "workers"; value: number | null }
  | { key: "topMode"; value: "all" | "topn" | "threshold" }
  | { key: "sequenceOrder"; value: "score" | "name" }
  | { key: "sequenceName" | "brief"; value: string }
  | { key: "contentAware" | "dedupe"; value: boolean };

/** Which list an Analyzer clip action names. */
export type HostAnalyzerList = "ranked" | "matches";

/** What a panel writes to `inbox/<id>.json`. */
export type HostChatAction =
  | { id: string; type: "hello" | "stop" | "new_chat" | "retry" | "revert" | "queue_clear" | "queue_resume" | "draft_send" | "draft_discard" }
  | { id: string; type: "send"; text: string }
  | { id: string; type: "edit_last"; text: string }
  | { id: string; type: "load_chat"; chatId: string }
  | { id: string; type: "review_decision"; cardId: string; decision: "apply" | "skip" | "all" }
  | { id: string; type: "set_model"; aiChoice: AiChoiceId }
  | { id: string; type: "set_effort"; family: ClaudeFamily; effort: EffortLevel }
  | { id: string; type: "set_gemini_effort"; effort: GeminiEffort }
  | { id: string; type: "set_review_edits"; on: boolean }
  | { id: string; type: "queue_remove"; queueId: string }
  | { id: string; type: "set_playhead"; seconds: number }
  | { id: string; type: "open_window"; view?: "chat" | "library" | "broll" | "visualizer" }
  | { id: string; type: "usage_refresh" }
  | { id: string; type: "analyzer_start" | "analyzer_cancel" | "analyzer_reset_options" | "analyzer_export" | "analyzer_build" | "analyzer_reveal_export" }
  | { id: string; type: "analyzer_set_folder"; path: string }
  | ({ id: string; type: "analyzer_set_option" } & HostAnalyzerOption)
  | { id: string; type: "analyzer_match"; query: string }
  | { id: string; type: "analyzer_toggle_segment"; clip: number; segment: number }
  | { id: string; type: "analyzer_place" | "analyzer_source"; list: HostAnalyzerList; clip: number; segment: number }
  | { id: string; type: "analyzer_reveal"; list: HostAnalyzerList; clip: number }
  | PanelBrollAction;
