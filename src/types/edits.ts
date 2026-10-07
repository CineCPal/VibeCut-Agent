import type { NleHost } from "./nle";

/**
 * One change a direct edit made, as the editor's edit commands record it (vibecut_agent/nle/
 * premiere_edit.py and resolve_edit.py, ported from VibeCut). The app keeps these and sends them back
 * to `revert_timeline_changes`; only the fields the app reads are typed, the rest ride along.
 */
export interface TimelineChange {
  kind: "added" | "deleted" | "enabled" | "level" | "reshaped" | "fade" | "transition" | "duck" | "split" | "link";
  name?: string;
  itemId?: string;
  itemIds?: string[];
  incomingId?: string;
  deletedWith?: string[];
  at?: number;
  end?: number;
  start?: number;
  tracks?: string[];
  track?: [string, number];
  before?: unknown;
  after?: unknown;
  which?: "fadeIn" | "fadeOut";
  clamped?: boolean;
  spans?: number;
  duckDb?: number;
  cut?: number;
  how?: string;
  groups?: number;
  notCarried?: string[];
  retracked?: boolean;
  items?: { before: { id: string; track: [string, number]; start: number; end: number; sourceStartFrame?: number }; after: { id: string; track: [string, number]; start: number; end: number; sourceStartFrame?: number }; right?: { id: string } }[];
  /** "link": the clips' link groups before and after (links.py). */
  groupsBefore?: string[][];
  groupsAfter?: string[][];
  [key: string]: unknown;
}

/** What every edit command answers. */
export interface EditResult {
  changes: TimelineChange[];
  refused: { clip?: number; itemId?: string; reason: string }[];
  addedTracks?: string[];
  /** Clips the edit replaced (Resolve's reshape and split): old id -> new id. */
  renamed?: Record<string, string>;
}

/** One logged edit: an agent tool call (or a B-roll placement) that changed the timeline. */
export interface EditEntry {
  id: string;
  /** The request it was made for: the user message's id, or a B-roll placement's own. */
  step: string;
  stepText: string;
  at: number;
  host: NleHost;
  timeline: string;
  tool: string;
  summary: string;
  /** The copy made before the request's first edit. */
  backup: string;
  changes: TimelineChange[];
  reverted?: { at: number; changedSince: number; failed: number; lost: string[] };
  /** Made before this launch (loaded from the saved log, Phase 8a): its clips may have changed since. */
  fromEarlierRun?: boolean;
}

export interface RevertResult {
  reverted: { kind: string; name: string }[];
  changedSince: { name: string; reason: string }[];
  failed: { name: string; reason: string }[];
  lost: string[];
  gradedFromBackup?: string[];
  restoredIds: Record<string, string>;
}
