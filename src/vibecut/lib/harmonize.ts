// Harmonizer's alignment turned into timeline clips (PLAN.md, "Harmonizer in the agent"), ported verbatim
// from VibeCut's src/lib/harmonize.ts (plus `sameRecording`). Pure: the agent's harmonize_takes puts the
// result in the draft (hostDraft.placeHarmonizedDraft).
//
// Harmonizer maps reference time to take time in stretches. A take placed with its reference time 0
// at timeline time `ref0` plays each stretch at the speed that keeps it on the reference: the clip's
// time map has a point at every stretch boundary, `t = refTime - first refTime` and `s = takeTime`.
import type { HarmonyResult, HarmonySegment } from "../types/harmony";
import type { RemapPoint } from "../types/timeline";
import { MIN_CLIP_DURATION_SECONDS } from "./timeline";
import { MAX_SPEED, MIN_SPEED, sliceClip } from "./timeRemap";

const POINT_EPSILON = 1e-4;

/** Where a take goes relative to its reference, and the speed changes that keep it there. */
export interface TakeTiming {
  /** Reference seconds where the take's clip starts. */
  refStart: number;
  sourceIn: number;
  sourceOut: number;
  duration: number;
  /** Missing when the take plays at normal speed throughout. */
  timeRemap?: RemapPoint[];
  /** Stretches Harmonizer flagged, in seconds from the clip's start, with the speed they play at. */
  flagged: Array<{ start: number; end: number; speed: number }>;
}

/**
 * The clip timing for a take from its stretches. Take times are kept inside the file, and a point that
 * would make the take stand still, run backwards or play outside 0.05x..20x is left out (the stretches
 * either side join up), so the result is always a valid time map. Null when nothing usable is left.
 */
export function takeTiming(segments: HarmonySegment[], takeDuration: number): TakeTiming | null {
  if (segments.length === 0) return null;
  const clampTake = (s: number) => Math.min(takeDuration, Math.max(0, s));
  const raw = [
    { ref: segments[0].refStart, take: clampTake(segments[0].takeStart) },
    ...segments.map((seg) => ({ ref: seg.refEnd, take: clampTake(seg.takeEnd) })),
  ];
  const kept = [raw[0]];
  for (const point of raw.slice(1)) {
    const last = kept[kept.length - 1];
    const dRef = point.ref - last.ref;
    const dTake = point.take - last.take;
    if (dRef < POINT_EPSILON || dTake < POINT_EPSILON) continue;
    const speed = dTake / dRef;
    if (speed < MIN_SPEED || speed > MAX_SPEED) continue;
    kept.push(point);
  }
  if (kept.length < 2) return null;

  const ref0 = kept[0].ref;
  const points: RemapPoint[] = kept.map((p) => ({ t: p.ref - ref0, s: p.take }));
  const duration = points[points.length - 1].t;
  if (duration < MIN_CLIP_DURATION_SECONDS) return null;
  const single = points.length === 2 && Math.abs((points[1].s - points[0].s) / points[1].t - 1) <= 1e-6;

  const flagged = segments
    .filter((seg) => seg.flagged && seg.refEnd > seg.refStart)
    .map((seg) => ({
      start: Math.max(0, seg.refStart - ref0),
      end: Math.min(duration, seg.refEnd - ref0),
      speed: (seg.takeEnd - seg.takeStart) / (seg.refEnd - seg.refStart),
    }))
    .filter((f) => f.end > f.start);

  return {
    refStart: ref0,
    sourceIn: points[0].s,
    sourceOut: points[points.length - 1].s,
    duration,
    ...(single ? {} : { timeRemap: points }),
    flagged,
  };
}

/** A take's clip as it lands on the timeline with the reference's time 0 at `ref0`. */
export interface PlacedTake extends TakeTiming {
  startTime: number;
}

/**
 * The take's clip with the reference's time 0 at timeline time `ref0`. Anything that would fall before
 * the start of the timeline is cut off. Null when nothing of the take is left.
 */
export function placeTake(timing: TakeTiming, ref0: number): PlacedTake | null {
  const start = ref0 + timing.refStart;
  if (start >= 0) return { ...timing, startTime: start };
  const cut = -start;
  if (timing.duration - cut < MIN_CLIP_DURATION_SECONDS) return null;
  const sliced = sliceClip(timing, cut, timing.duration);
  return {
    ...sliced,
    refStart: timing.refStart + cut,
    startTime: 0,
    flagged: timing.flagged
      .map((f) => ({ ...f, start: Math.max(0, f.start - cut), end: f.end - cut }))
      .filter((f) => f.end > f.start),
  };
}

/** How a take's speed varies, for summaries: slowest and fastest, as playback speeds. */
export function takeSpeedRange(timing: Pick<TakeTiming, "timeRemap" | "sourceIn" | "sourceOut" | "duration">): { min: number; max: number } {
  const points = timing.timeRemap ?? [
    { t: 0, s: timing.sourceIn },
    { t: timing.duration, s: timing.sourceOut },
  ];
  const speeds = points.slice(1).map((p, i) => (p.s - points[i].s) / (p.t - points[i].t));
  return { min: Math.min(...speeds), max: Math.max(...speeds) };
}

/** A sidecar `align` result, checked field by field. Null when it isn't one. */
export function parseHarmonyResult(raw: unknown): HarmonyResult | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
  if (typeof r.referencePath !== "string" || !Array.isArray(r.takes)) return null;
  const takes: HarmonyResult["takes"] = [];
  for (const t of r.takes) {
    if (typeof t !== "object" || t === null) return null;
    const take = t as Record<string, unknown>;
    if (typeof take.path !== "string" || !Array.isArray(take.segments)) return null;
    const segments: HarmonySegment[] = [];
    for (const s of take.segments) {
      if (typeof s !== "object" || s === null) return null;
      const seg = s as Record<string, unknown>;
      const [refStart, refEnd, takeStart, takeEnd] = [seg.refStart, seg.refEnd, seg.takeStart, seg.takeEnd].map(num);
      if (refStart === null || refEnd === null || takeStart === null || takeEnd === null) return null;
      segments.push({ refStart, refEnd, takeStart, takeEnd, flagged: seg.flagged === true });
    }
    takes.push({
      path: take.path,
      duration: num(take.duration) ?? 0,
      offset: num(take.offset) ?? 0,
      offsetConfidence: num(take.offsetConfidence) ?? 0,
      leadIn: num(take.leadIn) ?? 0,
      skippedAnchors: num(take.skippedAnchors) ?? 0,
      flaggedCount: num(take.flaggedCount) ?? segments.filter((s) => s.flagged).length,
      sameRecording: take.sameRecording === true,
      inSync: Array.isArray(take.inSync)
        ? take.inSync.flatMap((r) => {
            const range = (typeof r === "object" && r !== null ? r : {}) as Record<string, unknown>;
            const [a, b] = [num(range.refStart), num(range.refEnd)];
            return a !== null && b !== null && b > a ? [{ refStart: a, refEnd: b }] : [];
          })
        : [],
      syncErrorMs: num(take.syncErrorMs) ?? 0,
      segments,
    });
  }
  return {
    referencePath: r.referencePath,
    referenceDuration: num(r.referenceDuration) ?? 0,
    anchorCount: num(r.anchorCount) ?? 0,
    takes,
  };
}

/** Out-of-sync stretches shorter than this aren't worth a marker. */
export const MIN_OUT_OF_SYNC_SECONDS = 0.5;

/**
 * The take's in-sync reference ranges as seconds from the start of its clip, which shows reference
 * `refStart` to `refStart + duration` (PLAN.md, "Harmonizer: a smooth tempo curve"), and the stretches of
 * the clip between them (out of sync, at least MIN_OUT_OF_SYNC_SECONDS long).
 */
export function syncOnClip(inSync: { refStart: number; refEnd: number }[], refStart: number, duration: number): { inSync: { start: number; end: number }[]; outOfSync: { start: number; end: number }[] } {
  const on = inSync
    .map((r) => ({ start: Math.max(0, r.refStart - refStart), end: Math.min(duration, r.refEnd - refStart) }))
    .filter((r) => r.end > r.start)
    .sort((a, b) => a.start - b.start);
  const outOfSync: { start: number; end: number }[] = [];
  let at = 0;
  for (const r of [...on, { start: duration, end: duration }]) {
    if (r.start - at >= MIN_OUT_OF_SYNC_SECONDS) outOfSync.push({ start: at, end: r.start });
    at = Math.max(at, r.end);
  }
  return { inSync: on, outOfSync };
}
