import { beforeEach, describe, expect, it } from "vitest";
import { cleanOptions, DEFAULT_OPTIONS, MAX_KEPT_CLIPS, runParams, staleOptions, useBrollStore } from "./useBrollStore";
import type { AnalyzeResult } from "../types/broll";

const result = (n: number): AnalyzeResult => ({
  analyzed: n,
  cached: 0,
  cancelled: false,
  failed: [],
  warnings: [],
  exportPath: null,
  duplicates: 0,
  ranked: Array.from({ length: n }, (_, i) => ({ path: `/m/${i}.mov`, filename: `${i}.mov`, score: 50, bestStart: 0, bestEnd: 4, duration: 10, segments: [], energy: null, relevance: null, duplicateOf: null })),
});

describe("useBrollStore options", () => {
  beforeEach(() => {
    localStorage.clear();
    useBrollStore.setState({ ...DEFAULT_OPTIONS, folder: "/m", contentAware: false, brief: "", dedupe: false, lastResult: null, excluded: {}, preview: null });
  });

  it("clamps numbers to the analyzer's ranges and rounds them", () => {
    const { setOption } = useBrollStore.getState();
    setOption("windowSec", 0.1);
    setOption("maxSegments", 2.6);
    setOption("minGapSec", 99);
    setOption("energyWeight", -5);
    setOption("workers", 64);
    expect(useBrollStore.getState()).toMatchObject({ windowSec: 0.5, maxSegments: 3, minGapSec: 30, energyWeight: 0, workers: 32 });
    setOption("workers", null);
    expect(useBrollStore.getState().workers).toBeNull();
    useBrollStore.getState().resetOptions();
    expect(useBrollStore.getState()).toMatchObject(DEFAULT_OPTIONS);
  });

  it("cleans a saved or hand-edited set, keeping only known choices", () => {
    expect(cleanOptions({ windowSec: "8", topMode: "best", sequenceOrder: "name", maxSegments: Number.NaN, sequenceName: "x".repeat(200) })).toEqual({
      ...DEFAULT_OPTIONS,
      sequenceOrder: "name",
      sequenceName: "x".repeat(120),
    });
  });

  it("remembers the options, the last result and the ticks between runs", () => {
    useBrollStore.getState().setOption("maxSegments", 4);
    useBrollStore.getState().keepResult("/m", runParams(useBrollStore.getState()), result(2));
    useBrollStore.getState().toggleSegment("/m/0.mov", 1);
    useBrollStore.getState().setPreview({ path: "/m/0.mov", index: 0 });
    const saved = JSON.parse(localStorage.getItem("vibecut-agent.broll") as string);
    expect(saved.version).toBe(2);
    expect(saved.state).toMatchObject({ maxSegments: 4, excluded: { "/m/0.mov": [1] }, lastResult: { folder: "/m" } });
    expect(saved.state.preview).toBeUndefined();
  });

  it("caps a kept result and resets the ticks", () => {
    useBrollStore.getState().toggleSegment("/m/0.mov", 0);
    useBrollStore.getState().keepResult("/m", runParams(useBrollStore.getState()), result(MAX_KEPT_CLIPS + 20));
    expect(useBrollStore.getState().lastResult?.result.ranked).toHaveLength(MAX_KEPT_CLIPS);
    expect(useBrollStore.getState().excluded).toEqual({});
  });

  it("toggles a segment out and back in", () => {
    const { toggleSegment } = useBrollStore.getState();
    toggleSegment("/m/a.mov", 2);
    toggleSegment("/m/a.mov", 0);
    expect(useBrollStore.getState().excluded).toEqual({ "/m/a.mov": [0, 2] });
    toggleSegment("/m/a.mov", 0);
    toggleSegment("/m/a.mov", 2);
    expect(useBrollStore.getState().excluded).toEqual({});
  });

  it("names the scoring options changed since the kept run, ignoring weights that weren't used", () => {
    useBrollStore.getState().keepResult("/m", runParams(useBrollStore.getState()), result(1));
    expect(staleOptions(useBrollStore.getState())).toEqual([]);
    useBrollStore.getState().setOption("energyWeight", 80);
    expect(staleOptions(useBrollStore.getState())).toEqual([]);
    useBrollStore.getState().setOption("maxSegments", 3);
    useBrollStore.getState().setContentAware(true);
    expect(staleOptions(useBrollStore.getState())).toEqual(["content-aware scoring", "segments per clip", "energy weight"]);
    // Selection options don't change the scores.
    useBrollStore.getState().setOption("topMode", "topn");
    expect(staleOptions(useBrollStore.getState())).toHaveLength(3);
    useBrollStore.setState({ folder: "/other" });
    expect(staleOptions(useBrollStore.getState())).toEqual([]);
  });
});

describe("useBrollStore migration", () => {
  it("brings a Phase 4 save up to date with every option at its default", async () => {
    localStorage.setItem("vibecut-agent.broll", JSON.stringify({ version: 0, state: { folder: "/old", contentAware: true, brief: "night", dedupe: true } }));
    await useBrollStore.persist.rehydrate();
    expect(useBrollStore.getState()).toMatchObject({ ...DEFAULT_OPTIONS, folder: "/old", contentAware: true, brief: "night", dedupe: true });
  });

  it("cleans bad saved values instead of using them", async () => {
    localStorage.setItem("vibecut-agent.broll", JSON.stringify({ version: 2, state: { folder: "/m", windowSec: -3, topMode: 7 } }));
    await useBrollStore.persist.rehydrate();
    expect(useBrollStore.getState()).toMatchObject({ windowSec: 0.5, topMode: "all" });
  });
});
