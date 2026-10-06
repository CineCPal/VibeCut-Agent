/** The B-roll analyzer's results (vibecut_agent/broll/commands.py, ported from VibeCut). */

/** One clip of an `analyze` result, best first. Scores are 0 to 100. */
export interface RankedClip {
  path: string;
  filename: string;
  score: number;
  /** The best window to use, in seconds into the clip. */
  bestStart: number;
  bestEnd: number;
  duration: number;
  segments: { start: number; end: number; score: number }[];
  /** Null unless content-aware scoring ran. */
  energy: number | null;
  /** Null unless a brief was given with content-aware scoring. */
  relevance: number | null;
  /** The better take this one nearly duplicates (dedupe only). */
  duplicateOf: string | null;
}

export interface AnalyzeResult {
  analyzed: number;
  cached: number;
  cancelled: boolean;
  failed: { path: string; message: string }[];
  warnings: string[];
  ranked: RankedClip[];
  duplicates: number;
}

/** One hit of a `match` text search. */
export interface MatchHit {
  path: string;
  filename: string;
  /** The rank score: blends `relative` (0–100 among the folder) with `technical` quality. */
  combined: number;
  similarity: number;
  relative: number;
  technical: number | null;
  start: number;
  end: number;
  duration: number;
}

export interface MatchResult {
  indexed: number;
  cached: number;
  cancelled: boolean;
  failed: { path: string; message: string }[];
  warnings: string[];
  matches: { id: string; text: string; results: MatchHit[] }[];
}
