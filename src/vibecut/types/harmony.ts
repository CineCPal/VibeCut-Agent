// Harmonizer (PLAN.md, "Harmonizer"): several takes of one performance lined up with a clean
// reference recording, each take following its own tempo drift.

/** One stretch of a take: reference seconds `refStart..refEnd` show take seconds `takeStart..takeEnd`. */
export interface HarmonySegment {
  refStart: number;
  refEnd: number;
  takeStart: number;
  takeEnd: number;
  /** Plays at a speed outside what Harmonizer trusts (by default 0.5x to 2x): worth a look. */
  flagged: boolean;
}

/** One take in the result of the sidecar's `align` command. */
export interface HarmonyTake {
  path: string;
  duration: number;
  /** Seconds the take started after the reference (negative when before). */
  offset: number;
  offsetConfidence: number;
  /** Seconds of the reference before the take has anything to show. */
  leadIn: number;
  skippedAnchors: number;
  flaggedCount: number;
  segments: HarmonySegment[];
}

export interface HarmonyResult {
  referencePath: string;
  referenceDuration: number;
  anchorCount: number;
  takes: HarmonyTake[];
}

/** Kept on a take's media asset: how it lines up with its reference, so it can be placed again. */
export interface TakeHarmony {
  referenceAssetId: string;
  segments: HarmonySegment[];
}
