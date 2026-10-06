// Speed changes and ramps (time remapping). A clip's `timeRemap` is a list of points from
// `(0, sourceIn)` to `(duration, sourceOut)`; between two points the clip plays at one constant speed.
// Every place that turns timeline time into source time, or back, goes through this file so a clip
// with no map keeps the plain 1:1 arithmetic it always had (see PLAN.md, "Speed ramps").
//
// Keyframes and eased ramps: an eased speed change is baked into the map as a few in-between points
// marked `ramp`, so playback and export only ever see straight-line stretches. The Inspector and the
// chat agent edit a `SpeedPlan` instead (a start speed, then "from this source time on, play at this
// speed"), which `speedPlanOf` reads back from the points and `buildRemap` turns into points again.
import type { Clip, RemapPoint } from "../types/timeline";

export const MIN_SPEED = 0.05;
export const MAX_SPEED = 20;
/** In-between steps of one eased ramp (an even number, so the keyframe sits on the middle step). */
const RAMP_STEPS = 8;
/** A ramp takes at most this share of the stretch on either side of its keyframe. */
const RAMP_SHARE = 0.4;
/** Points closer together than this (seconds) are treated as one. */
const POINT_EPSILON = 1e-6;
/** A map whose only stretch plays within this of normal speed is dropped. */
const UNITY_EPSILON = 1e-6;

/** The parts of a clip its timing depends on. */
export type Timed = Pick<Clip, "sourceIn" | "sourceOut" | "duration" | "timeRemap">;
export type PlacedTimed = Timed & Pick<Clip, "startTime">;

/** One stretch of a clip that plays at one speed. Times are seconds from the clip's start. */
export interface SpeedSegment {
  start: number;
  end: number;
  sourceStart: number;
  sourceEnd: number;
  speed: number;
}

/** A speed change at a keyframe: from source time `s` on, the clip plays at `speed`. */
export interface SpeedKey {
  s: number;
  speed: number;
  /** Seconds of source the change is eased over, centred on `s`. 0 is an instant change. */
  ease: number;
}

/** How a clip's speed changes over its source, the form the Inspector and the agent edit. */
export interface SpeedPlan {
  /** Speed from the clip's in point until the first key. */
  startSpeed: number;
  /** Sorted by `s`, each strictly inside the clip's source range. */
  keys: SpeedKey[];
}

export function clampSpeed(speed: number): number {
  return Math.min(MAX_SPEED, Math.max(MIN_SPEED, speed));
}

export function isRetimed(clip: Pick<Clip, "timeRemap">): boolean {
  return clip.timeRemap !== undefined;
}

function speedOf(a: RemapPoint, b: RemapPoint): number {
  return (b.s - a.s) / (b.t - a.t);
}

/** The clip's map, including the implied straight line of a clip with none. */
export function remapPoints(clip: Timed): RemapPoint[] {
  return clip.timeRemap ?? [
    { t: 0, s: clip.sourceIn },
    { t: clip.duration, s: clip.sourceOut },
  ];
}

/** The index of the stretch holding `value` (the first or last stretch for values beyond the ends). */
function stretchIndex(points: RemapPoint[], key: "t" | "s", value: number): number {
  let lo = 0;
  let hi = points.length - 2;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (points[mid][key] <= value) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/**
 * The source time shown `offset` seconds after the clip's start. Past either end the edge stretch's
 * speed carries on, which is what a trim that lengthens the clip uncovers.
 */
export function sourceAtOffset(clip: Timed, offset: number): number {
  const map = clip.timeRemap;
  if (!map) return clip.sourceIn + offset;
  const i = stretchIndex(map, "t", offset);
  return map[i].s + (offset - map[i].t) * speedOf(map[i], map[i + 1]);
}

/** Seconds after the clip's start at which source time `source` shows (carrying on past either end). */
export function offsetAtSource(clip: Timed, source: number): number {
  const map = clip.timeRemap;
  if (!map) return source - clip.sourceIn;
  const i = stretchIndex(map, "s", source);
  return map[i].t + (source - map[i].s) / speedOf(map[i], map[i + 1]);
}

/** The source time the clip shows at timeline time `time`. */
export function sourceAt(clip: PlacedTimed, time: number): number {
  return sourceAtOffset(clip, time - clip.startTime);
}

/** The timeline time at which the clip shows source time `source`. */
export function timelineAt(clip: PlacedTimed, source: number): number {
  return clip.startTime + offsetAtSource(clip, source);
}

/** The clip's speed `offset` seconds after its start (1 for a clip with no map). */
export function speedAtOffset(clip: Timed, offset: number): number {
  const map = clip.timeRemap;
  if (!map) return 1;
  const i = stretchIndex(map, "t", offset);
  return speedOf(map[i], map[i + 1]);
}

/** Seconds after the clip's start of the next speed change after `offset`, or null when there is none. */
export function nextSpeedChange(clip: Timed, offset: number): number | null {
  const map = clip.timeRemap;
  if (!map) return null;
  for (let i = 1; i < map.length - 1; i++) {
    if (map[i].t > offset + POINT_EPSILON) return map[i].t;
  }
  return null;
}

export function speedSegments(clip: Timed): SpeedSegment[] {
  const points = remapPoints(clip);
  const segments: SpeedSegment[] = [];
  for (let i = 0; i + 1 < points.length; i++) {
    const a = points[i];
    const b = points[i + 1];
    segments.push({ start: a.t, end: b.t, sourceStart: a.s, sourceEnd: b.s, speed: speedOf(a, b) });
  }
  return segments;
}

/** The slowest and fastest speed the clip plays at. */
export function speedRange(clip: Timed): { min: number; max: number } {
  const speeds = speedSegments(clip).map((seg) => seg.speed);
  return { min: Math.min(...speeds), max: Math.max(...speeds) };
}

/** The clip's single speed, or null when it changes speed. */
export function constantSpeed(clip: Timed): number | null {
  const map = clip.timeRemap;
  if (!map) return 1;
  const { min, max } = speedRange(clip);
  return max - min <= UNITY_EPSILON * Math.max(1, max) ? speedOf(map[0], map[map.length - 1]) : null;
}

/** A map that plays at normal speed throughout says nothing: it is dropped. */
function normalized(points: RemapPoint[]): RemapPoint[] | undefined {
  if (points.length === 2 && Math.abs(speedOf(points[0], points[1]) - 1) <= UNITY_EPSILON) return undefined;
  return points;
}

/** The map of the clip's `[from, to]` (seconds from its start; either may lie beyond the clip). */
function windowOf(map: RemapPoint[], clip: Timed, from: number, to: number): RemapPoint[] {
  const points: RemapPoint[] = [{ t: 0, s: sourceAtOffset(clip, from) }];
  for (const p of map) {
    if (p.t > from + POINT_EPSILON && p.t < to - POINT_EPSILON) points.push({ ...p, t: p.t - from });
  }
  points.push({ t: to - from, s: sourceAtOffset(clip, to) });
  return points;
}

/** The timing fields of a clip whose map is `points`. */
function timingFrom<C extends Timed>(clip: C, points: RemapPoint[]): C {
  const map = normalized(points);
  const { timeRemap: _old, ...rest } = clip;
  return {
    ...rest,
    sourceIn: points[0].s,
    sourceOut: points[points.length - 1].s,
    duration: points[points.length - 1].t,
    ...(map ? { timeRemap: map } : {}),
  } as C;
}

/**
 * The clip cut down to `[from, to]`, in seconds from its start (a split or a range cut). Its start
 * on the timeline is left for the caller to set.
 */
export function sliceClip<C extends Timed>(clip: C, from: number, to: number): C {
  if (!clip.timeRemap) {
    const sourceIn = clip.sourceIn + from;
    return { ...clip, sourceIn, sourceOut: sourceIn + (to - from), duration: to - from };
  }
  return timingFrom(clip, windowOf(clip.timeRemap, clip, from, to));
}

/**
 * The clip with its head moved by `startDelta` and its tail by `endDelta` timeline seconds (a trim;
 * positive moves the edge later). Its start on the timeline is left for the caller to set.
 */
export function retrimClip<C extends Timed>(clip: C, startDelta: number, endDelta: number): C {
  if (!clip.timeRemap) {
    return {
      ...clip,
      sourceIn: clip.sourceIn + startDelta,
      sourceOut: clip.sourceOut + endDelta,
      duration: clip.duration - startDelta + endDelta,
    };
  }
  return timingFrom(clip, windowOf(clip.timeRemap, clip, startDelta, clip.duration + endDelta));
}

/**
 * `a` with `b` appended: `b` picks up in the same file where `a` leaves off (a dissolve's out-going
 * clip and its tail). The result runs for both lengths.
 */
export function joinClips<C extends Timed>(a: C, b: Timed): C {
  const first = remapPoints(a);
  const second = remapPoints(b).slice(1).map((p) => ({ ...p, t: p.t + a.duration }));
  return timingFrom(a, [...first, ...second]);
}

/** Timeline seconds of media before the clip's in point (how far its head can be pulled out). */
export function headroomBefore(clip: Timed): number {
  return clip.timeRemap ? -offsetAtSource(clip, 0) : clip.sourceIn;
}

/** Timeline seconds of media after the clip's out point, in a file `mediaDuration` long. */
export function headroomAfter(clip: Timed, mediaDuration: number): number {
  return clip.timeRemap ? offsetAtSource(clip, mediaDuration) - clip.duration : mediaDuration - clip.sourceOut;
}

/** Why `points` can't be a map for a clip with these in and out points, or null when it can. */
export function remapProblem(points: RemapPoint[], clip: Pick<Clip, "sourceIn" | "sourceOut" | "duration">): string | null {
  if (points.length < 2) return "needs at least two points";
  for (const p of points) {
    if (!Number.isFinite(p.t) || !Number.isFinite(p.s)) return "has a point that is not a number";
  }
  const first = points[0];
  const last = points[points.length - 1];
  const tolerance = 1e-4;
  if (Math.abs(first.t) > tolerance || Math.abs(first.s - clip.sourceIn) > tolerance) {
    return "does not start at the clip's in point";
  }
  if (Math.abs(last.t - clip.duration) > tolerance || Math.abs(last.s - clip.sourceOut) > tolerance) {
    return "does not end at the clip's out point";
  }
  for (let i = 1; i < points.length; i++) {
    if (points[i].t <= points[i - 1].t || points[i].s <= points[i - 1].s) return "does not keep moving forward";
    const speed = speedOf(points[i - 1], points[i]);
    if (speed < MIN_SPEED * 0.999 || speed > MAX_SPEED * 1.001) {
      return `plays at ${speed.toFixed(3)}x, outside ${MIN_SPEED}x to ${MAX_SPEED}x`;
    }
  }
  return null;
}

/** Reads the plan a map was built from: keyframes are the points not marked `ramp`. */
export function speedPlanOf(clip: Timed): SpeedPlan {
  const points = remapPoints(clip);
  const last = points.length - 1;
  const visible = points.map((p, i) => (i === 0 || i === last || !p.ramp ? i : -1)).filter((i) => i >= 0);
  /**
   * The speed that holds between visible points `from` and `to`: the longest stretch there, since a
   * ramp's steps are each shorter than the steady stretch it leaves between two keyframes.
   */
  const steady = (from: number, to: number): number => {
    let best = from;
    for (let j = from + 1; j < to; j++) {
      if (points[j + 1].s - points[j].s > points[best + 1].s - points[best].s) best = j;
    }
    return speedOf(points[best], points[best + 1]);
  };
  const keys: SpeedKey[] = [];
  for (let v = 1; v + 1 < visible.length; v++) {
    const i = visible[v];
    // A keyframe's ramp is at most half the steps on each side of it.
    let before = i;
    while (before - 1 > 0 && points[before - 1].ramp && i - before < RAMP_STEPS / 2) before--;
    let after = i;
    while (after + 1 < last && points[after + 1].ramp && after - i < RAMP_STEPS / 2) after++;
    keys.push({ s: points[i].s, speed: steady(i, visible[v + 1]), ease: points[after].s - points[before].s });
  }
  return { startSpeed: steady(0, visible[1]), keys };
}

/**
 * The map that plays source `[sourceIn, sourceOut]` by `plan`. Speeds are held to 0.05x..20x, keys
 * outside the range are dropped, and each ease is shortened so a steady stretch always remains
 * between two keyframes.
 */
export function buildRemap(sourceIn: number, sourceOut: number, plan: SpeedPlan): RemapPoint[] {
  const keys = plan.keys
    .filter((k) => k.s > sourceIn + POINT_EPSILON && k.s < sourceOut - POINT_EPSILON)
    .sort((a, b) => a.s - b.s)
    .filter((k, i, all) => i === 0 || k.s - all[i - 1].s > POINT_EPSILON);
  const bounds = [sourceIn, ...keys.map((k) => k.s), sourceOut];
  const speeds = [plan.startSpeed, ...keys.map((k) => k.speed)].map(clampSpeed);

  // Source positions with the speed of the stretch that follows each one.
  const marks: Array<{ s: number; speed: number; ramp: boolean }> = [{ s: sourceIn, speed: speeds[0], ramp: false }];
  keys.forEach((key, index) => {
    const i = index + 1;
    const before = speeds[i - 1];
    const after = speeds[i];
    const half = Math.min(
      Math.max(0, key.ease) / 2,
      RAMP_SHARE * (bounds[i] - bounds[i - 1]),
      RAMP_SHARE * (bounds[i + 1] - bounds[i]),
    );
    if (half <= POINT_EPSILON || before === after) {
      marks.push({ s: key.s, speed: after, ramp: false });
      return;
    }
    const step = (2 * half) / RAMP_STEPS;
    for (let j = 0; j <= RAMP_STEPS; j++) {
      const speed = j === RAMP_STEPS ? after : before + ((after - before) * (j + 0.5)) / RAMP_STEPS;
      marks.push({ s: key.s - half + j * step, speed, ramp: j !== RAMP_STEPS / 2 });
    }
  });

  const points: RemapPoint[] = [];
  let t = 0;
  marks.forEach((mark, i) => {
    points.push(mark.ramp ? { t, s: mark.s, ramp: true } : { t, s: mark.s });
    const nextS = i + 1 < marks.length ? marks[i + 1].s : sourceOut;
    t += (nextS - mark.s) / mark.speed;
  });
  points.push({ t, s: sourceOut });
  return points;
}

/**
 * The clip replayed by `plan` over the same source range: its duration follows from the speeds.
 * Its start on the timeline stays where it was.
 */
export function withSpeedPlan<C extends Timed>(clip: C, plan: SpeedPlan): C {
  return timingFrom(clip, buildRemap(clip.sourceIn, clip.sourceOut, plan));
}

/** The clip at one speed throughout (1 removes any speed change). */
export function withConstantSpeed<C extends Timed>(clip: C, speed: number): C {
  return withSpeedPlan(clip, { startSpeed: speed, keys: [] });
}

/**
 * The clip playing source `[sourceIn, sourceOut]` by an explicit map, with the source range taken
 * from the map's ends (how Harmonizer's alignment lands on a clip).
 */
export function withRemapPoints<C extends Timed>(clip: C, points: RemapPoint[]): C {
  return timingFrom(clip, points);
}

/**
 * Where a keyframe dragged to `offset` seconds after the clip's start lands in source time, kept
 * clear of its neighbours. Null when there is no such keyframe.
 */
export function draggedKeySource(clip: Timed, keyIndex: number, offset: number): number | null {
  const plan = speedPlanOf(clip);
  const key = plan.keys[keyIndex];
  if (!key) return null;
  const lo = keyIndex > 0 ? plan.keys[keyIndex - 1].s : clip.sourceIn;
  const hi = keyIndex + 1 < plan.keys.length ? plan.keys[keyIndex + 1].s : clip.sourceOut;
  const margin = Math.min(0.05, (hi - lo) / 4);
  return Math.min(hi - margin, Math.max(lo + margin, sourceAtOffset(clip, offset)));
}

/** The plan with keyframe `keyIndex` moved to source time `s`. */
export function moveKey(plan: SpeedPlan, keyIndex: number, s: number): SpeedPlan {
  return { ...plan, keys: plan.keys.map((k, i) => (i === keyIndex ? { ...k, s } : k)) };
}

/** The plan with a keyframe at source time `s` that changes nothing yet (it keeps the speed there). */
export function addKey(clip: Timed, s: number): SpeedPlan {
  const plan = speedPlanOf(clip);
  if (s <= clip.sourceIn + POINT_EPSILON || s >= clip.sourceOut - POINT_EPSILON) return plan;
  if (plan.keys.some((k) => Math.abs(k.s - s) <= POINT_EPSILON)) return plan;
  const before = plan.keys.filter((k) => k.s < s);
  const speed = before.length > 0 ? before[before.length - 1].speed : plan.startSpeed;
  return { ...plan, keys: [...plan.keys, { s, speed, ease: 0 }].sort((a, b) => a.s - b.s) };
}

/** The plan without keyframe `keyIndex`; the speed before it carries on. */
export function removeKey(plan: SpeedPlan, keyIndex: number): SpeedPlan {
  return { ...plan, keys: plan.keys.filter((_, i) => i !== keyIndex) };
}

/**
 * The plan for "from each of these source times on, play at this speed" (the agent's form). A point
 * at or before the in point sets the start speed; without one the clip starts at normal speed.
 */
export function planFromChanges(
  clip: Pick<Clip, "sourceIn">,
  changes: Array<{ sourceTime: number; speed: number }>,
  ease = 0,
): SpeedPlan {
  const sorted = [...changes].sort((a, b) => a.sourceTime - b.sourceTime);
  let startSpeed = 1;
  const keys: SpeedKey[] = [];
  for (const change of sorted) {
    if (change.sourceTime <= clip.sourceIn + POINT_EPSILON) startSpeed = change.speed;
    else keys.push({ s: change.sourceTime, speed: change.speed, ease });
  }
  return { startSpeed, keys };
}

/** A short description of a clip's speed, e.g. "50%" or "ramp 97–103%". Null at normal speed. */
export function describeSpeed(clip: Timed): string | null {
  if (!clip.timeRemap) return null;
  const single = constantSpeed(clip);
  if (single !== null) return `${formatPercent(single)}`;
  const { min, max } = speedRange(clip);
  return `ramp ${formatPercent(min, false)}–${formatPercent(max)}`;
}

function formatPercent(speed: number, sign = true): string {
  const pct = speed * 100;
  const text = Math.abs(pct - Math.round(pct)) < 0.05 ? String(Math.round(pct)) : pct.toFixed(1);
  return sign ? `${text}%` : text;
}

/** How high a speed sits on the clip, 0 (bottom) to 1 (top): 25% at the bottom, 400% at the top, 100% in the middle. */
export function speedHeight(speed: number): number {
  return Math.min(1, Math.max(0, 0.5 + Math.log2(speed) / 4));
}

/** A moment of a clip's drift: `d` seconds of source ahead of (or, negative, behind) a steady pace, `t` seconds after its start. */
export interface DriftPoint {
  t: number;
  d: number;
}

/**
 * How far the clip's map pushes each moment ahead of or behind playing its source at one steady pace
 * (its average speed, start to end). This is what Harmonizer's speed changes add up to; the overall
 * speed is the badge's. Exact at each point of the map, straight in between. Empty without a map.
 */
export function driftCurve(clip: Timed): DriftPoint[] {
  const map = clip.timeRemap;
  if (!map || clip.duration <= 0) return [];
  const pace = (clip.sourceOut - clip.sourceIn) / clip.duration;
  return map.map((p) => ({ t: p.t, d: p.s - (clip.sourceIn + p.t * pace) }));
}

/** The furthest behind (min, ≤ 0) and ahead (max, ≥ 0) the clip's drift goes. */
export function driftRange(clip: Timed): { min: number; max: number } {
  const ds = driftCurve(clip).map((p) => p.d);
  return { min: Math.min(0, ...ds), max: Math.max(0, ...ds) };
}

/** A short description of the clip's drift, e.g. "±180 ms" or "±1.2 s". Null when it never strays a millisecond. */
export function describeDrift(clip: Timed): string | null {
  const { min, max } = driftRange(clip);
  const most = Math.max(-min, max);
  if (most < 0.001) return null;
  return most < 1 ? `±${Math.round(most * 1000)} ms` : `±${most.toFixed(1)} s`;
}

/** Speeds outside these are flagged (the same bounds Harmonizer flags a stretch by). */
export const FLAG_SPEED_MIN = 0.5;
export const FLAG_SPEED_MAX = 2;
/** A stretch this far from normal speed (±10%) is drawn at full strength. */
const TONE_FULL = Math.log2(1.1);

export type SpeedToneKind = "slow" | "fast" | "normal" | "flagged";

/** How a stretch's speed is coloured: slowed, sped up, normal or flagged, and how strongly (0 to 1). */
export function speedTone(speed: number): { kind: SpeedToneKind; intensity: number } {
  if (speed < FLAG_SPEED_MIN || speed > FLAG_SPEED_MAX) return { kind: "flagged", intensity: 1 };
  if (Math.abs(speed - 1) <= UNITY_EPSILON) return { kind: "normal", intensity: 0 };
  return { kind: speed < 1 ? "slow" : "fast", intensity: Math.min(1, Math.abs(Math.log2(speed)) / TONE_FULL) };
}

/**
 * How high a speed sits on the clip, 0 (bottom) to 1 (top), on a log scale fitted to the clip's own
 * range (always including 100%), so 97–103% fills the clip as 25–400% would. 0.5 for a single speed.
 */
export function localSpeedHeight(speed: number, range: { min: number; max: number }): number {
  const lo = Math.log2(Math.min(range.min, 1));
  const hi = Math.log2(Math.max(range.max, 1));
  if (hi - lo < 1e-9) return 0.5;
  return 0.1 + 0.8 * Math.min(1, Math.max(0, (Math.log2(speed) - lo) / (hi - lo)));
}
