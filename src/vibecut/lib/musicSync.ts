import type { RoughCutPlan, RoughCutSegment } from "./sidecarResults";

function nearestOnset(onsets: number[], target: number, toleranceSeconds: number): number | null {
  let best: number | null = null;
  let bestDistance = Infinity;
  for (const onset of onsets) {
    const distance = Math.abs(onset - target);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = onset;
    }
  }
  if (best === null || bestDistance > toleranceSeconds) return null;
  return best;
}

export const DEFAULT_BEAT_SNAP_TOLERANCE_SECONDS = 0.15;

/**
 * Nudges each MAIN-track segment's start to the nearest detected onset within `toleranceSeconds`,
 * so the applied cut's edit points land close to a beat in the given music (see `beats.rs`'s onset
 * detection). B-roll segments are left untouched — they're already anchored relative to a main cut
 * (see gemini_client's `anchor_order`/`anchor_offset_seconds`), not independently snapped.
 *
 * Clamped so a snap can never push a segment's start before the previous (already-snapped) main
 * segment's end, and a segment's own duration is never changed — only where each cut *starts*,
 * matching how editors actually cut to a beat (the edit point, not stretched content). This can
 * introduce a small gap between two main cuts that used to sit exactly back to back; it never
 * introduces an overlap.
 */
export function snapPlanToBeats(
  plan: RoughCutPlan,
  onsets: number[],
  toleranceSeconds: number = DEFAULT_BEAT_SNAP_TOLERANCE_SECONDS,
): RoughCutPlan {
  if (onsets.length === 0) return plan;

  let minStart = 0;
  const snapped: RoughCutSegment[] = [];
  for (const segment of plan.segments) {
    if (segment.track !== "main") {
      snapped.push(segment);
      continue;
    }
    const duration = segment.sourceOut - segment.sourceIn;
    const onset = nearestOnset(onsets, segment.start, toleranceSeconds);
    const candidate = onset ?? segment.start;
    const newStart = Math.max(minStart, candidate);
    snapped.push(newStart === segment.start ? segment : { ...segment, start: newStart });
    minStart = newStart + duration;
  }
  return { ...plan, segments: snapped };
}
