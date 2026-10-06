/** What the Rust side reads from Spyglass's index (src-tauri/src/spyglass.rs, spyglass_archive.rs; ported from VibeCut). Read only. */

export interface SpyglassTagCount {
  label: string;
  count: number;
}

export interface SpyglassDateRange {
  /** yyyy-mm-dd */
  from: string;
  to: string;
}

export interface SpyglassFolder {
  name: string;
  /** The folder's path as Spyglass shows it; pass it back to expand the folder or to search in it. */
  path: string;
  isRoot: boolean;
  /** Shots anywhere under the folder. */
  shotCount: number;
  hasChildren: boolean;
  /** False when the folder cannot be reached now (its drive is not attached). */
  online: boolean;
  topTags: SpyglassTagCount[];
  dateRange: SpyglassDateRange | null;
}

export interface SpyglassScopeSummary {
  clipCount: number;
  shotCount: number;
  /** Shots with a technical quality score / an energy score. */
  technicalCount: number;
  energyCount: number;
  dateRange: SpyglassDateRange | null;
  topTags: SpyglassTagCount[];
}

export interface SpyglassResolvedScope {
  clipIds: number[];
  summary: SpyglassScopeSummary;
}

export type SpyglassFileStatus = "ok" | "offline" | "changed";

export interface SpyglassBrowseShot {
  shotId: number;
  path: string;
  filename: string;
  start: number;
  end: number;
  /** What Spyglass's vision model (moondream2) saw in the shot's keyframe. */
  caption: string | null;
  tags: string[];
  technical: number | null;
  energy: number | null;
  recordedAt: string | null;
  /** Words spoken during the shot, when Spyglass transcribed the clip. */
  transcript: string | null;
  /** The keyframe image (already allowed for display), when it exists. */
  keyframe: string | null;
  status: SpyglassFileStatus;
}

export interface SpyglassBrowsePage {
  summary: SpyglassScopeSummary;
  shots: SpyglassBrowseShot[];
}

/** Where the index in use came from (spyglass.rs `IndexSource`). */
export type SpyglassIndexSource = "environment" | "chosen" | "default";

export interface SpyglassIndexInfo {
  path: string;
  source: SpyglassIndexSource;
  /** The index chosen in Settings, shown when the environment overrides it. */
  chosen: string | null;
}

/** One match of a `broll-spyglass` search (vibecut_agent/broll/commands.py run_spyglass). */
export interface SpyglassMatch {
  path: string;
  filename: string;
  start: number;
  end: number;
  /** Spyglass's own hybrid score (0 to about 1); only comparable within one search. */
  score: number;
  visual: number | null;
  caption: string | null;
  tags: string[];
  technical: number | null;
  tagMatch: boolean;
  transcriptMatch: boolean;
  shotId: number | null;
  energy: number | null;
  recordedAt: string | null;
  status: SpyglassFileStatus;
  model?: string | null;
}

export interface SpyglassSearchResult {
  indexPath: string;
  indexed: number;
  warnings: string[];
  matches: { id: string; text: string; results: SpyglassMatch[] }[];
  cancelled: boolean;
}
