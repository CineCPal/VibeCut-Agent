/**
 * The few pieces of VibeCut's src/lib/timeline.ts that its transcript and draft modules use, copied
 * verbatim (PLAN.md, "Phase 6b"). The rest of that file is VibeCut's own editor and isn't ported.
 */

/** Shortest clip a cut may leave (VibeCut's MIN_CLIP_DURATION_SECONDS). */
export const MIN_CLIP_DURATION_SECONDS = 0.1;

export interface TimeRange {
  start: number;
  end: number;
}

/** Sorted, non-overlapping ranges; empty, reversed and non-finite ones are dropped and negative starts clamped to 0. */
export function mergeRanges(ranges: TimeRange[]): TimeRange[] {
  const valid = ranges
    .filter((r) => Number.isFinite(r.start) && Number.isFinite(r.end))
    .map((r) => ({ start: Math.max(0, r.start), end: r.end }))
    .filter((r) => r.end > r.start + 1e-9)
    .sort((a, b) => a.start - b.start);
  const merged: TimeRange[] = [];
  for (const range of valid) {
    const last = merged[merged.length - 1];
    if (last && range.start <= last.end + 1e-9) last.end = Math.max(last.end, range.end);
    else merged.push({ ...range });
  }
  return merged;
}
