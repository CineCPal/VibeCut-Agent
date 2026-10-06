import { describe, expect, it } from "vitest";
import type { Clip } from "../types/timeline";
import {
  addKey,
  buildRemap,
  constantSpeed,
  describeDrift,
  describeSpeed,
  driftCurve,
  driftRange,
  draggedKeySource,
  headroomAfter,
  headroomBefore,
  localSpeedHeight,
  moveKey,
  nextSpeedChange,
  offsetAtSource,
  planFromChanges,
  remapProblem,
  removeKey,
  retrimClip,
  sliceClip,
  sourceAt,
  sourceAtOffset,
  speedAtOffset,
  speedPlanOf,
  speedRange,
  speedSegments,
  speedTone,
  timelineAt,
  withConstantSpeed,
  withRemapPoints,
  withSpeedPlan,
} from "./timeRemap";

function clip(overrides: Partial<Clip> = {}): Clip {
  return {
    id: "c",
    mediaAssetId: "a",
    trackId: "t",
    startTime: 10,
    duration: 4,
    sourceIn: 2,
    sourceOut: 6,
    name: "Clip",
    ...overrides,
  };
}

/** Source 2..6 at 2x for the first 2 s of source, then 0.5x: 1 s + 4 s on the timeline. */
function ramped(): Clip {
  return withSpeedPlan(clip(), { startSpeed: 2, keys: [{ s: 4, speed: 0.5, ease: 0 }] });
}

describe("a clip with no map", () => {
  it("maps 1:1 exactly as before", () => {
    const c = clip();
    expect(sourceAt(c, 11.5)).toBe(3.5);
    expect(timelineAt(c, 3.5)).toBe(11.5);
    expect(speedAtOffset(c, 1)).toBe(1);
    expect(nextSpeedChange(c, 0)).toBeNull();
    expect(constantSpeed(c)).toBe(1);
    expect(describeSpeed(c)).toBeNull();
  });

  it("slices and trims with the same arithmetic as the old code", () => {
    expect(sliceClip(clip(), 1, 3)).toMatchObject({ sourceIn: 3, sourceOut: 5, duration: 2 });
    expect(retrimClip(clip(), 0.5, -1)).toMatchObject({ sourceIn: 2.5, sourceOut: 5, duration: 2.5 });
    expect(headroomBefore(clip())).toBe(2);
    expect(headroomAfter(clip(), 10)).toBe(4);
  });
});

describe("constant speed", () => {
  it("changes the duration and keeps the source range", () => {
    const c = withConstantSpeed(clip(), 2);
    expect(c).toMatchObject({ sourceIn: 2, sourceOut: 6, duration: 2 });
    expect(sourceAt(c, 11)).toBe(4);
    expect(timelineAt(c, 5)).toBe(11.5);
    expect(constantSpeed(c)).toBe(2);
    expect(describeSpeed(c)).toBe("200%");
  });

  it("drops the map at normal speed", () => {
    const c = withConstantSpeed(withConstantSpeed(clip(), 0.5), 1);
    expect(c.timeRemap).toBeUndefined();
    expect(c.duration).toBe(4);
  });

  it("clamps speeds to the supported range", () => {
    expect(withConstantSpeed(clip(), 1000).duration).toBeCloseTo(4 / 20);
    expect(withConstantSpeed(clip(), 0).duration).toBeCloseTo(4 / 0.05);
  });
});

describe("speed changes", () => {
  it("maps both ways through each stretch", () => {
    const c = ramped();
    expect(c.duration).toBeCloseTo(5);
    expect(sourceAtOffset(c, 0.5)).toBeCloseTo(3);
    expect(sourceAtOffset(c, 3)).toBeCloseTo(5);
    expect(offsetAtSource(c, 5)).toBeCloseTo(3);
    expect(speedAtOffset(c, 0.5)).toBeCloseTo(2);
    expect(speedAtOffset(c, 2)).toBeCloseTo(0.5);
    expect(nextSpeedChange(c, 0)).toBeCloseTo(1);
    expect(nextSpeedChange(c, 1.5)).toBeNull();
    expect(speedRange(c)).toEqual({ min: 0.5, max: 2 });
    expect(describeSpeed(c)).toBe("ramp 50–200%");
  });

  it("carries the edge speed on past either end", () => {
    const c = ramped();
    expect(sourceAtOffset(c, -0.5)).toBeCloseTo(1);
    expect(sourceAtOffset(c, 6)).toBeCloseTo(6.5);
    expect(headroomBefore(c)).toBeCloseTo(1);
    expect(headroomAfter(c, 7)).toBeCloseTo(2);
  });

  it("splits into two pieces that play the same frames", () => {
    const c = ramped();
    const left = sliceClip(c, 0, 2);
    const right = sliceClip(c, 2, c.duration);
    expect(left).toMatchObject({ sourceIn: 2, duration: 2 });
    expect(left.sourceOut).toBeCloseTo(4.5);
    expect(right.sourceIn).toBeCloseTo(4.5);
    expect(right.sourceOut).toBeCloseTo(6);
    expect(right.duration).toBeCloseTo(3);
    expect(constantSpeed(right)).toBeCloseTo(0.5);
    expect(remapProblem(left.timeRemap!, left)).toBeNull();
    expect(remapProblem(right.timeRemap!, right)).toBeNull();
  });

  it("trims outwards at the edge speed", () => {
    const c = retrimClip(ramped(), -0.5, 1);
    expect(c.sourceIn).toBeCloseTo(1);
    expect(c.sourceOut).toBeCloseTo(6.5);
    expect(c.duration).toBeCloseTo(6.5);
    expect(remapProblem(c.timeRemap!, c)).toBeNull();
  });

  it("drops a slice that lands at normal speed back to a plain clip", () => {
    const c = withSpeedPlan(clip({ sourceOut: 10, duration: 8 }), { startSpeed: 1, keys: [{ s: 6, speed: 2, ease: 0 }] });
    const head = sliceClip(c, 0, 3);
    expect(head.timeRemap).toBeUndefined();
    expect(head).toMatchObject({ sourceIn: 2, duration: 3 });
    expect(head.sourceOut).toBeCloseTo(5);
  });
});

describe("eased ramps", () => {
  const plan = { startSpeed: 1, keys: [{ s: 6, speed: 0.5, ease: 2 }] };
  const eased = () => withSpeedPlan(clip({ sourceOut: 12, duration: 10 }), plan);

  it("steps smoothly between the two speeds", () => {
    const c = eased();
    const speeds = speedSegments(c).map((s) => s.speed);
    for (let i = 1; i < speeds.length; i++) expect(speeds[i]).toBeLessThanOrEqual(speeds[i - 1] + 1e-9);
    expect(speeds[0]).toBe(1);
    expect(speeds[speeds.length - 1]).toBe(0.5);
    expect(speeds.length).toBeGreaterThan(4);
    expect(remapProblem(c.timeRemap!, c)).toBeNull();
  });

  it("reads back the plan it was built from", () => {
    const back = speedPlanOf(eased());
    expect(back.startSpeed).toBeCloseTo(1);
    expect(back.keys).toHaveLength(1);
    expect(back.keys[0].s).toBeCloseTo(6);
    expect(back.keys[0].speed).toBeCloseTo(0.5);
    expect(back.keys[0].ease).toBeCloseTo(2);
  });

  it("reads back neighbouring ramps as separate keyframes", () => {
    const two = { startSpeed: 1, keys: [{ s: 5, speed: 2, ease: 4 }, { s: 8, speed: 0.5, ease: 4 }] };
    const back = speedPlanOf(withSpeedPlan(clip({ sourceOut: 12, duration: 10 }), two));
    expect(back.startSpeed).toBeCloseTo(1);
    expect(back.keys.map((k) => k.s)).toEqual([5, 8]);
    expect(back.keys[0].speed).toBeCloseTo(2);
    expect(back.keys[1].speed).toBeCloseTo(0.5);
  });

  it("shortens an ease that would swallow its neighbours", () => {
    const points = buildRemap(0, 10, { startSpeed: 1, keys: [{ s: 1, speed: 2, ease: 100 }] });
    const firstRamp = points.find((p) => p.ramp)!;
    expect(firstRamp.s).toBeGreaterThan(0.5);
  });
});

describe("keyframe editing", () => {
  it("reads a plain map's points as keyframes (Harmonizer's segments)", () => {
    const c = withRemapPoints(clip(), [
      { t: 0, s: 2 },
      { t: 1, s: 3.1 },
      { t: 3, s: 5 },
      { t: 4, s: 6 },
    ]);
    const plan = speedPlanOf(c);
    expect(plan.startSpeed).toBeCloseTo(1.1);
    expect(plan.keys.map((k) => k.s)).toEqual([3.1, 5]);
    expect(plan.keys.every((k) => k.ease === 0)).toBe(true);
    // Rebuilding from the plan gives the same map back.
    expect(withSpeedPlan(c, plan).timeRemap!.map((p) => [p.t, p.s])).toEqual(
      c.timeRemap!.map((p) => [expect.closeTo(p.t, 9), expect.closeTo(p.s, 9)]),
    );
  });

  it("adds a keyframe that changes nothing, then edits and removes it", () => {
    const c = withConstantSpeed(clip(), 2);
    const added = addKey(c, 4);
    expect(added.keys).toEqual([{ s: 4, speed: 2, ease: 0 }]);
    expect(withSpeedPlan(c, added).duration).toBeCloseTo(2);
    const slowed = { ...added, keys: [{ ...added.keys[0], speed: 0.5 }] };
    expect(withSpeedPlan(c, slowed).duration).toBeCloseTo(1 + 4);
    expect(removeKey(slowed, 0).keys).toEqual([]);
  });

  it("keeps a dragged keyframe clear of its neighbours and the clip's ends", () => {
    const c = ramped();
    expect(draggedKeySource(c, 0, 100)).toBeLessThan(6);
    expect(draggedKeySource(c, 0, -100)).toBeGreaterThan(2);
    expect(draggedKeySource(c, 3, 1)).toBeNull();
    const moved = withSpeedPlan(c, moveKey(speedPlanOf(c), 0, 5));
    // 3 s of source at 2x, then 1 s at 0.5x.
    expect(moved.duration).toBeCloseTo(1.5 + 2);
  });

  it("builds a plan from the agent's source-time changes", () => {
    const plan = planFromChanges(clip(), [
      { sourceTime: 4, speed: 0.5 },
      { sourceTime: 0, speed: 2 },
    ]);
    expect(plan).toEqual({ startSpeed: 2, keys: [{ s: 4, speed: 0.5, ease: 0 }] });
    expect(planFromChanges(clip(), [{ sourceTime: 3, speed: 3 }]).startSpeed).toBe(1);
  });
});

describe("remapProblem", () => {
  it("accepts a good map and names what is wrong with a bad one", () => {
    const c = ramped();
    expect(remapProblem(c.timeRemap!, c)).toBeNull();
    expect(remapProblem([{ t: 0, s: 2 }], c)).toMatch(/two points/);
    expect(remapProblem([{ t: 0, s: 3 }, { t: 5, s: 6 }], c)).toMatch(/in point/);
    expect(remapProblem([{ t: 0, s: 2 }, { t: 3, s: 6 }], c)).toMatch(/out point/);
    expect(
      remapProblem([{ t: 0, s: 2 }, { t: 3, s: 1 }, { t: 5, s: 6 }], c),
    ).toMatch(/forward/);
    expect(remapProblem([{ t: 0, s: 2 }, { t: 5, s: 6 }], { ...c, sourceOut: 200, duration: 5 })).toMatch(/out point/);
  });
});

describe("drift and speed tone (what RemapOverlay draws)", () => {
  it("has no drift at one steady speed, whatever that speed is", () => {
    expect(driftCurve(clip())).toEqual([]);
    const half = withConstantSpeed(clip(), 0.5);
    expect(driftCurve(half).every((p) => Math.abs(p.d) < 1e-9)).toBe(true);
    expect(describeDrift(half)).toBeNull();
  });

  it("measures each point's push ahead of or behind the clip's average pace", () => {
    // 4 s of source over 4 s: 1.5x for the first second, then slower to catch back to the same end.
    const c = withRemapPoints(clip(), [
      { t: 0, s: 2 },
      { t: 1, s: 3.5 },
      { t: 4, s: 6 },
    ]);
    expect(driftCurve(c)).toEqual([
      { t: 0, d: 0 },
      { t: 1, d: 0.5 },
      { t: 4, d: 0 },
    ]);
    expect(driftRange(c)).toEqual({ min: 0, max: 0.5 });
    expect(describeDrift(c)).toBe("±500 ms");
  });

  it("describes a push over a second in seconds", () => {
    const c = withRemapPoints(clip({ duration: 10, sourceIn: 0, sourceOut: 10 }), [
      { t: 0, s: 0 },
      { t: 5, s: 3.8 },
      { t: 10, s: 10 },
    ]);
    expect(describeDrift(c)).toBe("±1.2 s");
  });

  it("tones slowed and sped-up stretches by how far from 100%, and flags Harmonizer's bounds", () => {
    expect(speedTone(1)).toEqual({ kind: "normal", intensity: 0 });
    expect(speedTone(0.97).kind).toBe("slow");
    expect(speedTone(1.03).kind).toBe("fast");
    expect(speedTone(1.03).intensity).toBeGreaterThan(0.2);
    expect(speedTone(1.03).intensity).toBeLessThan(0.4);
    expect(speedTone(1.2).intensity).toBe(1);
    expect(speedTone(0.49).kind).toBe("flagged");
    expect(speedTone(2.01).kind).toBe("flagged");
    expect(speedTone(2).kind).toBe("fast");
  });

  it("fits the speed line to the clip's own range, always including 100%", () => {
    const range = { min: 0.97, max: 1.03 };
    expect(localSpeedHeight(0.97, range)).toBeCloseTo(0.1);
    expect(localSpeedHeight(1.03, range)).toBeCloseTo(0.9);
    expect(localSpeedHeight(1, range)).toBeGreaterThan(0.45);
    expect(localSpeedHeight(1, range)).toBeLessThan(0.55);
    // A clip that only plays faster still has 100% at the bottom of its scale.
    expect(localSpeedHeight(1, { min: 1.5, max: 2 })).toBeCloseTo(0.1);
    expect(localSpeedHeight(2, { min: 2, max: 2 })).toBeCloseTo(0.9);
    expect(localSpeedHeight(1, { min: 1, max: 1 })).toBe(0.5);
  });
});
