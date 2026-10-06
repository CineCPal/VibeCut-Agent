import { describe, expect, it } from "vitest";
import type { Clip } from "../types/timeline";
import type { WaveformPeaks } from "../types/waveform";
import { dbToAmplitude, findSilentRanges, type SilenceOptions } from "./silence";

const RATE = 10; // peaks per second, coarse to keep the fixtures readable

/** Peaks from a list of per-second levels (each second becomes RATE identical buckets). */
function peaksFromSeconds(levels: number[]): WaveformPeaks {
  const maxes = levels.flatMap((l) => Array<number>(RATE).fill(l));
  return { peaksPerSecond: RATE, mins: maxes.map((m) => -m), maxes };
}

const clip = (over: Partial<Clip>): Clip => ({
  id: "c",
  mediaAssetId: "a",
  trackId: "t",
  startTime: 0,
  duration: 10,
  sourceIn: 0,
  sourceOut: 10,
  name: "c",
  ...over,
});

const opts = (over: Partial<SilenceOptions> = {}): SilenceOptions => ({ minDurationSeconds: 0.7, thresholdDb: -40, handleSeconds: 0, ...over });

const LOUD = 0.5;
const QUIET = 0.001; // -60 dBFS

const near = (ranges: { start: number; end: number }[]) => ranges.map((r) => ({ start: +r.start.toFixed(2), end: +r.end.toFixed(2) }));

describe("dbToAmplitude", () => {
  it("converts dBFS to linear amplitude", () => {
    expect(dbToAmplitude(0)).toBe(1);
    expect(dbToAmplitude(-20)).toBeCloseTo(0.1);
  });
});

describe("findSilentRanges", () => {
  it("finds a quiet stretch at least the minimum duration long", () => {
    const peaks = peaksFromSeconds([LOUD, LOUD, QUIET, QUIET, LOUD]);
    expect(near(findSilentRanges([{ clip: clip({ duration: 5, sourceOut: 5 }), peaks }], opts()))).toEqual([{ start: 2, end: 4 }]);
  });

  it("ignores pauses shorter than the minimum", () => {
    const peaks = peaksFromSeconds([LOUD, QUIET, LOUD]);
    expect(findSilentRanges([{ clip: clip({ duration: 3, sourceOut: 3 }), peaks }], opts({ minDurationSeconds: 1.5 }))).toEqual([]);
  });

  it("shrinks each range by the handle at both ends", () => {
    const peaks = peaksFromSeconds([LOUD, QUIET, QUIET, LOUD]);
    expect(near(findSilentRanges([{ clip: clip({ duration: 4, sourceOut: 4 }), peaks }], opts({ handleSeconds: 0.2 })))).toEqual([{ start: 1.2, end: 2.8 }]);
  });

  it("maps source time to timeline time through the clip's start and sourceIn", () => {
    // Source seconds 3-4 are quiet; the clip uses source 2-6 placed at timeline 10.
    const peaks = peaksFromSeconds([LOUD, LOUD, LOUD, QUIET, LOUD, LOUD]);
    const c = clip({ startTime: 10, duration: 4, sourceIn: 2, sourceOut: 6 });
    expect(near(findSilentRanges([{ clip: c, peaks }], opts({ minDurationSeconds: 0.5 })))).toEqual([{ start: 11, end: 12 }]);
  });

  it("is not silent where any overlapping clip is loud", () => {
    const quiet = peaksFromSeconds([QUIET, QUIET, QUIET]);
    const loudMiddle = peaksFromSeconds([QUIET, LOUD, QUIET]);
    const ranges = findSilentRanges(
      [
        { clip: clip({ id: "v", duration: 3, sourceOut: 3 }), peaks: quiet },
        { clip: clip({ id: "music", trackId: "a2", duration: 3, sourceOut: 3 }), peaks: loudMiddle },
      ],
      opts({ minDurationSeconds: 0.5 }),
    );
    expect(near(ranges)).toEqual([
      { start: 0, end: 1 },
      { start: 2, end: 3 },
    ]);
  });

  it("scales by clip volume, so a muted clip counts as silent", () => {
    const peaks = peaksFromSeconds([LOUD, LOUD]);
    expect(near(findSilentRanges([{ clip: clip({ duration: 2, sourceOut: 2, volume: 0 }), peaks }], opts()))).toEqual([{ start: 0, end: 2 }]);
  });

  it("does not report gaps between clips", () => {
    const peaks = peaksFromSeconds([QUIET, QUIET, QUIET, QUIET]);
    const ranges = findSilentRanges(
      [
        { clip: clip({ id: "a", startTime: 0, duration: 1, sourceOut: 1 }), peaks },
        { clip: clip({ id: "b", startTime: 3, duration: 1, sourceOut: 1 }), peaks },
      ],
      opts({ minDurationSeconds: 0.5 }),
    );
    expect(near(ranges)).toEqual([
      { start: 0, end: 1 },
      { start: 3, end: 4 },
    ]);
  });

  it("only looks inside the requested window", () => {
    const peaks = peaksFromSeconds([QUIET, QUIET, QUIET, QUIET]);
    expect(near(findSilentRanges([{ clip: clip({ duration: 4, sourceOut: 4 }), peaks }], opts({ startTime: 1, endTime: 3 })))).toEqual([{ start: 1, end: 3 }]);
  });

  it("returns nothing with no audible clips", () => {
    expect(findSilentRanges([], opts())).toEqual([]);
  });
});
