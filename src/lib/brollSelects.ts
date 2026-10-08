/**
 * The Analyze tab's selects (PLAN.md, "Phase 10"): which clips and segments go into the exported XML and
 * the built timeline. Mirrors `pipeline.select_results` and `order_for_sequence`
 * (vibecut_agent/broll/pipeline.py), plus the segments the user unticked, so both exports get the same cut.
 */
import type { RankedClip } from "../types/broll";
import type { AnalyzerOptions } from "../store/useBrollStore";

export interface SelectSegment {
  start: number;
  end: number;
  /** Its index in the clip's `segments`. */
  index: number;
}

export interface SelectClip {
  path: string;
  filename: string;
  score: number;
  energy: number | null;
  segments: SelectSegment[];
}

export interface Selects {
  clips: SelectClip[];
  segments: number;
  /** The reel's length, in seconds. */
  seconds: number;
}

type SelectOptions = Pick<AnalyzerOptions, "topMode" | "topN" | "minScore" | "sequenceOrder">;

/** A clip's segments, falling back to its best window when the result had none. */
export function segmentsOf(clip: RankedClip): { start: number; end: number; score: number }[] {
  return clip.segments.length ? clip.segments : [{ start: clip.bestStart, end: clip.bestEnd, score: clip.score }];
}

/** The clips the selection keeps (all, top N or a minimum score; near-duplicates skipped when asked), in
 * sequence order, each with its ticked segments. A clip with every segment unticked is left out. */
export function selects(
  ranked: RankedClip[],
  options: SelectOptions,
  excluded: Record<string, number[]>,
  skipDuplicates: boolean,
): Selects {
  let kept = ranked.filter((c) => !(skipDuplicates && c.duplicateOf)).sort((a, b) => b.score - a.score);
  if (options.topMode === "topn") kept = kept.slice(0, Math.max(1, Math.floor(options.topN)));
  else if (options.topMode === "threshold") kept = kept.filter((c) => c.score >= options.minScore);
  if (options.sequenceOrder === "name") kept = [...kept].sort((a, b) => a.filename.toLowerCase().localeCompare(b.filename.toLowerCase()));

  const clips: SelectClip[] = [];
  for (const clip of kept) {
    const out = excluded[clip.path] ?? [];
    const segments = segmentsOf(clip)
      .map((s, index) => ({ start: s.start, end: s.end, index }))
      .filter((s) => !out.includes(s.index) && s.end > s.start);
    if (segments.length) clips.push({ path: clip.path, filename: clip.filename, score: clip.score, energy: clip.energy, segments });
  }
  const all = clips.flatMap((c) => c.segments);
  return { clips, segments: all.length, seconds: all.reduce((sum, s) => sum + (s.end - s.start), 0) };
}

/** The paths of the clips the selection keeps, for marking the rest in the list. */
export function selectedPaths(ranked: RankedClip[], options: SelectOptions, skipDuplicates: boolean): Set<string> {
  return new Set(selects(ranked, options, {}, skipDuplicates).clips.map((c) => c.path));
}

/** Where each segment goes on a new timeline: back to back from 0, in selects order. */
export function timelineLayout(clips: SelectClip[]): { path: string; filename: string; sourceIn: number; sourceOut: number; at: number }[] {
  let at = 0;
  const out = [];
  for (const clip of clips) {
    for (const s of clip.segments) {
      out.push({ path: clip.path, filename: clip.filename, sourceIn: s.start, sourceOut: s.end, at: Math.round(at * 1000) / 1000 });
      at += s.end - s.start;
    }
  }
  return out;
}
