import { describe, expect, it } from "vitest";
import { segmentsOf, selectedPaths, selects, timelineLayout } from "./brollSelects";
import { DEFAULT_OPTIONS } from "../store/useBrollStore";
import type { RankedClip } from "../types/broll";

const clip = (filename: string, score: number, segments: [number, number][], duplicateOf: string | null = null): RankedClip => ({
  path: `/m/${filename}`,
  filename,
  score,
  bestStart: segments[0]?.[0] ?? 0,
  bestEnd: segments[0]?.[1] ?? 4,
  duration: 60,
  segments: segments.map(([start, end]) => ({ start, end, score })),
  energy: null,
  relevance: null,
  duplicateOf,
});

const ranked = [clip("b.mov", 90, [[0, 4], [10, 14]]), clip("C.mov", 70, [[2, 6]]), clip("a.mov", 50, [[1, 5]]), clip("d.mov", 85, [[0, 4]], "/m/b.mov")];

describe("selects", () => {
  it("keeps every clip best first, leaves near-duplicates out and sums the reel", () => {
    const s = selects(ranked, DEFAULT_OPTIONS, {}, true);
    expect(s.clips.map((c) => c.filename)).toEqual(["b.mov", "C.mov", "a.mov"]);
    expect(s.segments).toBe(4);
    expect(s.seconds).toBe(16);
    expect(selects(ranked, DEFAULT_OPTIONS, {}, false).clips.map((c) => c.filename)).toEqual(["b.mov", "d.mov", "C.mov", "a.mov"]);
  });

  it("keeps the best N, or those at a minimum score, as pipeline.select_results does", () => {
    expect(selects(ranked, { ...DEFAULT_OPTIONS, topMode: "topn", topN: 2 }, {}, true).clips.map((c) => c.filename)).toEqual(["b.mov", "C.mov"]);
    expect(selects(ranked, { ...DEFAULT_OPTIONS, topMode: "threshold", minScore: 70 }, {}, true).clips.map((c) => c.filename)).toEqual(["b.mov", "C.mov"]);
    expect(selects(ranked, { ...DEFAULT_OPTIONS, topMode: "topn", topN: 0 }, {}, true).clips).toHaveLength(1);
  });

  it("orders by file name without regard to case", () => {
    const s = selects(ranked, { ...DEFAULT_OPTIONS, sequenceOrder: "name" }, {}, true);
    expect(s.clips.map((c) => c.filename)).toEqual(["a.mov", "b.mov", "C.mov"]);
  });

  it("leaves out unticked segments, and a clip with none left", () => {
    const s = selects(ranked, DEFAULT_OPTIONS, { "/m/b.mov": [0], "/m/a.mov": [0] }, true);
    expect(s.clips.map((c) => [c.filename, c.segments.map((x) => x.index)])).toEqual([
      ["b.mov", [1]],
      ["C.mov", [0]],
    ]);
    // Unticking doesn't change which clips the Include setting keeps.
    expect([...selectedPaths(ranked, { ...DEFAULT_OPTIONS, topMode: "topn", topN: 1 }, true)]).toEqual(["/m/b.mov"]);
  });

  it("falls back to the best window for a result with no segments", () => {
    const bare = { ...clip("x.mov", 60, []), bestStart: 3, bestEnd: 7 };
    expect(segmentsOf(bare)).toEqual([{ start: 3, end: 7, score: 60 }]);
  });

  it("lays the segments back to back from 0", () => {
    const s = selects(ranked, DEFAULT_OPTIONS, {}, true);
    expect(timelineLayout(s.clips).map((x) => [x.filename, x.sourceIn, x.sourceOut, x.at])).toEqual([
      ["b.mov", 0, 4, 0],
      ["b.mov", 10, 14, 4],
      ["C.mov", 2, 6, 8],
      ["a.mov", 1, 5, 12],
    ]);
  });
});
