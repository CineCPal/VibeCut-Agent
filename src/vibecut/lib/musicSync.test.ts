import { describe, expect, it } from "vitest";
import type { RoughCutPlan, RoughCutSegment } from "./sidecarResults";
import { snapPlanToBeats } from "./musicSync";

const seg = (extra: Partial<RoughCutSegment>): RoughCutSegment => ({
  track: "main",
  mediaPath: "/media/a.mov",
  name: "a.mov",
  sourceIn: 0,
  sourceOut: 2,
  start: 0,
  audioMode: "silent",
  duckDb: -12,
  ...extra,
});

const plan = (segments: RoughCutSegment[]): RoughCutPlan => ({ sequenceName: "Cut", segments, unreadable: 0 });

describe("snapPlanToBeats", () => {
  it("snaps a main segment's start to a nearby onset within tolerance", () => {
    const result = snapPlanToBeats(plan([seg({ start: 1.0, sourceOut: 3 })]), [1.08], 0.15);
    expect(result.segments[0].start).toBe(1.08);
  });

  it("leaves a segment's start alone when no onset is within tolerance", () => {
    const result = snapPlanToBeats(plan([seg({ start: 1.0, sourceOut: 3 })]), [5.0], 0.15);
    expect(result.segments[0].start).toBe(1.0);
  });

  it("returns the plan unchanged when there are no onsets at all", () => {
    const original = plan([seg({ start: 1.0, sourceOut: 3 })]);
    expect(snapPlanToBeats(original, [])).toBe(original);
  });

  it("never lets a snap push a segment before the previous main segment's end", () => {
    // Two touching 2s segments (0-2, 2-4). An onset near the second's start pulls it earlier than
    // the first segment's own end would allow.
    const segments = [seg({ start: 0, sourceOut: 2 }), seg({ start: 2, sourceOut: 4 })];
    const result = snapPlanToBeats(plan(segments), [1.9], 0.2);
    expect(result.segments[0].start).toBe(0);
    expect(result.segments[1].start).toBeGreaterThanOrEqual(result.segments[0].start + 2);
  });

  it("snaps main segments independently in order, carrying each shift forward as the next floor", () => {
    const segments = [seg({ start: 0, sourceOut: 1 }), seg({ start: 1.4, sourceOut: 3 })];
    // First segment (duration 1s) snaps 0.1s later, ending at 1.1; the second's own nearby onset
    // (1.45) is still past that floor, so it snaps there rather than being clamped by the first.
    const result = snapPlanToBeats(plan(segments), [0.1, 1.45], 0.2);
    expect(result.segments[0].start).toBe(0.1);
    expect(result.segments[1].start).toBe(1.45);
  });

  it("leaves B-roll segments untouched", () => {
    const broll = seg({ track: "broll", start: 0.5, sourceOut: 2 });
    const result = snapPlanToBeats(plan([broll]), [0.52], 0.15);
    expect(result.segments[0]).toBe(broll);
  });

  it("preserves segment identity (no new object) when nothing changes", () => {
    const original = seg({ start: 1.0, sourceOut: 3 });
    const result = snapPlanToBeats(plan([original]), [5.0], 0.15);
    expect(result.segments[0]).toBe(original);
  });
});
