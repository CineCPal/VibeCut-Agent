// Ported from VibeCut's src/lib/harmonize.test.ts (the pure parts), plus the draft placement
// (hostDraft.placeHarmonizedDraft, withoutTakes, referenceZeroIn; PLAN.md, "Harmonizer in the agent").
import { describe, expect, it } from "vitest";
import type { HostTimeline } from "../../types/timeline";
import type { HarmonySegment } from "../types/harmony";
import { draftFromSnapshot, placeHarmonizedDraft, referenceZeroIn, withoutTakes } from "./connect/hostDraft";
import { parseHarmonyResult, placeTake, syncOnClip, takeSpeedRange, takeTiming } from "./harmonize";
import { remapProblem } from "./timeRemap";

const seg = (refStart: number, refEnd: number, takeStart: number, takeEnd: number, flagged = false): HarmonySegment => ({
  refStart,
  refEnd,
  takeStart,
  takeEnd,
  flagged,
});

/** Starts 2 s into the take; the first 10 s of the reference match 10 s of take, the next 10 s only 9.5 s. */
const DRIFTING = [seg(0, 10, 2, 12), seg(10, 20, 12, 21.5, true)];

describe("takeTiming", () => {
  it("maps each stretch boundary to a point of the take's time map", () => {
    const timing = takeTiming(DRIFTING, 60)!;
    expect(timing).toMatchObject({ refStart: 0, sourceIn: 2, sourceOut: 21.5, duration: 20 });
    expect(timing.timeRemap).toEqual([
      { t: 0, s: 2 },
      { t: 10, s: 12 },
      { t: 20, s: 21.5 },
    ]);
    expect(timing.flagged).toEqual([{ start: 10, end: 20, speed: 0.95 }]);
    expect(takeSpeedRange(timing)).toEqual({ min: 0.95, max: 1 });
  });

  it("leaves out the map when the take plays at normal speed", () => {
    const timing = takeTiming([seg(1.5, 11.5, 0, 10)], 60)!;
    expect(timing.timeRemap).toBeUndefined();
    expect(timing).toMatchObject({ refStart: 1.5, sourceIn: 0, sourceOut: 10, duration: 10 });
  });

  it("keeps take times inside the file and bridges points that would stall, reverse or race", () => {
    const timing = takeTiming(
      [seg(0, 5, -1, 5), seg(5, 6, 5, 5), seg(6, 10, 5, 9), seg(10, 10.001, 9, 30), seg(10.001, 12, 30, 32)],
      31,
    )!;
    expect(remapProblem(timing.timeRemap!, timing)).toBeNull();
    expect(timing.sourceIn).toBe(0);
    expect(timing.sourceOut).toBeLessThanOrEqual(31);
  });

  it("gives up when nothing usable is left", () => {
    expect(takeTiming([], 10)).toBeNull();
    expect(takeTiming([seg(0, 0.01, 0, 0.01)], 10)).toBeNull();
  });
});

describe("placeTake", () => {
  it("puts the take at the reference's time 0 plus where it starts", () => {
    const timing = takeTiming([seg(3, 13, 0, 10)], 60)!;
    expect(placeTake(timing, 100)!.startTime).toBe(103);
  });

  it("cuts off what would fall before the start of the timeline", () => {
    const placed = placeTake(takeTiming(DRIFTING, 60)!, -12)!;
    expect(placed.startTime).toBe(0);
    expect(placed.duration).toBeCloseTo(8);
    expect(placed.sourceIn).toBeCloseTo(13.9); // 10 s at 1x, then 2 s at 0.95x
    expect(placed.flagged).toEqual([{ start: 0, end: 8, speed: 0.95 }]);
    expect(placeTake(takeTiming(DRIFTING, 60)!, -40)).toBeNull();
  });
});

describe("parseHarmonyResult", () => {
  it("reads the sidecar's result and refuses anything else", () => {
    const parsed = parseHarmonyResult({
      referencePath: "/r.wav",
      referenceDuration: 20,
      anchorCount: 30,
      takes: [{ path: "/a.mov", duration: 30, offset: 2, offsetConfidence: 50, leadIn: 0, skippedAnchors: 1, flaggedCount: 1, segments: DRIFTING }],
    });
    expect(parsed?.takes[0].segments).toEqual(DRIFTING);
    expect(parsed?.takes[0].sameRecording).toBe(false);
    expect(parsed?.takes[0].inSync).toEqual([]);
    const withSync = parseHarmonyResult({
      referencePath: "/r.wav",
      takes: [{ path: "/a.mov", syncErrorMs: 12.5, inSync: [{ refStart: 1, refEnd: 9 }, { refStart: 5, refEnd: 5 }, { refStart: "x" }], segments: DRIFTING }],
    });
    expect(withSync?.takes[0]).toMatchObject({ inSync: [{ refStart: 1, refEnd: 9 }], syncErrorMs: 12.5 });
    expect(parseHarmonyResult({ referencePath: "/r.wav", takes: [{ path: "/a.mov", sameRecording: true, segments: DRIFTING }] })?.takes[0].sameRecording).toBe(true);
    expect(parseHarmonyResult({ referencePath: "/r.wav", takes: [{ path: "/a.mov", segments: [{ refStart: "x" }] }] })).toBeNull();
    expect(parseHarmonyResult(null)).toBeNull();
  });
});

const VIEW: HostTimeline = {
  project: "Recital",
  timeline: "Main",
  fps: 25,
  startTimecode: "00:00:00:00",
  duration: 30,
  isCurrent: true,
  tracks: [
    {
      type: "video",
      index: 1,
      name: "V1",
      enabled: true,
      clips: [
        { id: "v1", name: "take1.mov", start: 0, end: 20, enabled: true, sourceIn: 0, sourceOut: 20, filePath: "/m/take1.mov", linkedIds: ["a1"] },
        { id: "v2", name: "intro.mov", start: 20, end: 30, enabled: true, sourceIn: 0, sourceOut: 10, filePath: "/m/intro.mov" },
      ],
    },
    {
      type: "audio",
      index: 1,
      name: "A1",
      enabled: true,
      clips: [{ id: "a1", name: "take1.mov", start: 0, end: 20, enabled: true, sourceIn: 0, sourceOut: 20, filePath: "/m/take1.mov", linkedIds: ["v1"] }],
    },
    {
      type: "audio",
      index: 2,
      name: "A2",
      enabled: true,
      clips: [{ id: "a2", name: "reference.wav", start: 5, end: 25, enabled: true, sourceIn: 3, sourceOut: 23, filePath: "/m/reference.wav" }],
    },
  ],
  markers: [],
};

describe("syncOnClip", () => {
  it("puts the in-sync ranges on the clip and marks the stretches between them, leaving out slivers", () => {
    // The clip shows reference 2..22.
    const sync = syncOnClip(
      [
        { refStart: 0, refEnd: 8 },
        { refStart: 8.3, refEnd: 12 },
        { refStart: 15, refEnd: 30 },
      ],
      2,
      20,
    );
    expect(sync.inSync).toEqual([
      { start: 0, end: 6 },
      { start: expect.closeTo(6.3, 9), end: 10 },
      { start: 13, end: 20 },
    ]);
    expect(sync.outOfSync).toEqual([{ start: 10, end: 13 }]);
    expect(syncOnClip([], 0, 10).outOfSync).toEqual([{ start: 0, end: 10 }]);
  });
});

describe("harmonized takes in the draft", () => {
  const timing = (segments: HarmonySegment[], zero: number) => placeTake(takeTiming(segments, 60)!, zero)!;

  it("takes out clips of the takes and what's linked to them, and nothing else", () => {
    const draft = draftFromSnapshot(VIEW);
    const { draft: cleared, removed, earliestStart } = withoutTakes(draft, ["/m/take1.mov"]);
    expect(removed).toBe(2);
    expect(earliestStart).toBe(0);
    expect(cleared.video[0].clips.map((c) => c.sourceName)).toEqual(["intro.mov"]);
    expect(cleared.audio[0].clips).toEqual([]);
    expect(cleared.audio[1].clips.map((c) => c.sourceName)).toEqual(["reference.wav"]);
    expect(withoutTakes(draft, ["/m/other.mov"])).toEqual({ draft, removed: 0, earliestStart: null });
  });

  it("finds the reference's time 0 from its clip on an audio track", () => {
    const draft = draftFromSnapshot(VIEW);
    expect(referenceZeroIn(draft, "/m/reference.wav")).toBe(2);
    expect(referenceZeroIn(draft, "/m/take1.mov")).toBe(0);
    expect(referenceZeroIn(draft, "/m/nowhere.wav")).toBeNull();
  });

  it("puts the reference on an audio track, each take on its own video track (the first on top) with its sound off beneath, and red markers", () => {
    const { draft } = withoutTakes(draftFromSnapshot(VIEW), ["/m/take1.mov"]);
    const first = timing(DRIFTING, 40);
    const second = timing([seg(0, 20, 0.5, 20.5)], 40);
    const next = placeHarmonizedDraft(draft, { sourcePath: "/m/reference.wav", duration: 25 }, 40, [
      { sourcePath: "/m/take1.mov", ...first, hasSound: true },
      { sourcePath: "/m/take2.mov", ...second, hasSound: true },
    ]);
    // A1 was left empty by the take taken out, so the reference goes there.
    expect(next.audio[0].clips.map((c) => [c.sourceName, c.start, c.end, c.sourceIn, c.sourceOut])).toEqual([["reference.wav", 40, 65, 0, 25]]);
    // V1 still has intro.mov; take2 (placed first) gets V2, take1 V3: the first take on top.
    expect(next.video.map((t) => t.clips.map((c) => c.sourceName))).toEqual([["intro.mov"], ["take2.mov"], ["take1.mov"]]);
    const picture = next.video[2].clips[0];
    expect(picture).toMatchObject({ start: 40, end: 60, sourceIn: 2, sourceOut: 21.5 });
    expect(picture.timeRemap).toEqual([
      { t: 0, s: 2 },
      { t: 10, s: 12 },
      { t: 20, s: 21.5 },
    ]);
    const sound = next.audio.flatMap((t) => t.clips).find((c) => c.sourceName === "take1.mov")!;
    expect(sound).toMatchObject({ enabled: false, linkGroup: picture.linkGroup, timeRemap: picture.timeRemap });
    expect(next.markers).toEqual([expect.objectContaining({ time: 50, name: "Check sync: take1.mov at 95%", color: "Red", duration: 10 })]);
    expect(next.changes.at(-1)).toBe("Lined up 2 takes with reference.wav from 40s");
  });

  it("lines up with the reference already there, puts a take with no picture on an audio track switched off, and placing again replaces the markers", () => {
    const base = draftFromSnapshot(VIEW);
    const zero = referenceZeroIn(base, "/m/reference.wav")!;
    const take = { sourcePath: "/m/zoom.wav", ...timing(DRIFTING, zero), hasSound: true, hasPicture: false, outOfSync: [{ start: 3, end: 5 }] };
    const once = placeHarmonizedDraft(base, { sourcePath: "/m/reference.wav", duration: 25 }, zero, [take], { addReference: false });
    const all = [...once.video, ...once.audio].flatMap((t) => t.clips);
    expect(all.filter((c) => c.sourceName === "reference.wav")).toHaveLength(1);
    expect(once.video.flatMap((t) => t.clips).map((c) => c.sourceName)).toEqual(["take1.mov", "intro.mov"]);
    expect(once.audio.at(-1)!.clips[0]).toMatchObject({ sourceName: "zoom.wav", start: 2, enabled: false });
    expect(once.markers.map((m) => [m.time, m.name, m.duration])).toEqual([
      [5, "Out of sync: zoom.wav", 2],
      [12, "Check sync: zoom.wav at 95%", 10],
    ]);

    const { draft: cleared } = withoutTakes(once, ["/m/zoom.wav"]);
    expect(cleared.markers).toEqual([]);
    expect(cleared.audio.flatMap((t) => t.clips).some((c) => c.sourceName === "zoom.wav")).toBe(false);
  });
});
