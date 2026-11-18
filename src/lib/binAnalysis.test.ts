import { beforeEach, describe, expect, it, vi } from "vitest";

const jobs = vi.hoisted(() => ({ runJob: vi.fn(), jobId: () => "j1", awaitJob: vi.fn() }));
vi.mock("./jobs", () => jobs);
const ipc = vi.hoisted(() => ({ nleCall: vi.fn(), startSidecar: vi.fn(), cancelSidecar: vi.fn(), chooseSavePath: vi.fn() }));
vi.mock("./ipc", () => ipc);
const broll = vi.hoisted(() => ({ buildTimelineFromSegments: vi.fn() }));
vi.mock("./broll", async (importOriginal) => ({ ...(await importOriginal<typeof import("./broll")>()), buildTimelineFromSegments: broll.buildTimelineFromSegments }));

import { analyzeBin, buildBinSelects, fuse, markerFor, scoreColor, selectsName } from "./binAnalysis";
import { useBinRunStore, type ShotTag } from "../store/useBinRunStore";
import type { RankedClip } from "../types/broll";

const PARAMS = { contentAware: false, brief: "", dedupe: false, windowSec: 4, maxSegments: 1, minGapSec: 1, energyWeight: 35, relevanceWeight: 35 };

const clip = (path: string, score: number, extra: Partial<RankedClip> = {}): RankedClip => ({
  path,
  filename: path.split("/").pop() as string,
  score,
  bestStart: 2,
  bestEnd: 6,
  duration: 20,
  segments: [{ start: 2, end: 6, score }],
  energy: null,
  relevance: null,
  duplicateOf: null,
  ...extra,
});

const shot = (start: number, end: number, usability: number | null, description = "Harbor at dusk"): ShotTag => ({
  start,
  end,
  shot_scale: "WS",
  camera_movement: "STATIC",
  description,
  visual_tags: ["harbor", "boats"],
  editorial_usability_score: usability,
});

const result = (ranked: RankedClip[]) => ({ analyzed: ranked.length, cached: 1, cancelled: false, failed: [], warnings: [], exportPath: null, ranked, duplicates: 0 });

beforeEach(() => {
  vi.clearAllMocks();
  useBinRunStore.getState().clear();
  ipc.nleCall.mockImplementation(async (_host: string, command: string) => {
    if (command === "read_media_pool") {
      return {
        bins: [{ path: "P/Drone", clips: 3 }],
        clips: [
          { id: "1", name: "a", bin: "P/Drone", type: "Video", filePath: "/d1/a.mov", usage: 0 },
          { id: "2", name: "b", bin: "P/Drone", type: "Video", filePath: "/d2/b.mov", usage: 0 },
          { id: "3", name: "c", bin: "P/Drone", type: "Video", filePath: "/d1/c.mov", usage: 0 },
        ],
      };
    }
    if (command === "add_markers") return { added: [{}, {}], alreadyThere: [], refusedAt: [] };
    throw new Error(`unexpected ${command}`);
  });
});

describe("shot tags blended into the Analyzer's scores", () => {
  it("weights each tagged shot's usability by how long the segments cover it", () => {
    // 2–6 s covers 1 s of a 40 shot and 3 s of an 80 shot: usability 70; 0.75 * 90 + 0.25 * 70 = 85.
    const fused = fuse(clip("/d/a.mov", 90), [shot(0, 3, 40, "Pier"), shot(3, 10, 80), shot(12, 14, 10)]);
    expect([fused.score, fused.analyzerScore, fused.usability]).toEqual([85, 90, 70]);
    expect(fused.visual).toEqual({ description: "Harbor at dusk", tags: ["harbor", "boats"], shotScale: "WS", movement: "STATIC" });
  });

  it("keeps the Analyzer's score with no tags, or tags that don't cover a segment", () => {
    expect(fuse(clip("/d/a.mov", 90), null)).toMatchObject({ score: 90, usability: null, visual: null });
    expect(fuse(clip("/d/a.mov", 90), [shot(10, 12, 20)])).toMatchObject({ score: 90, usability: null, visual: null });
    expect(fuse(clip("/d/a.mov", 90), [shot(0, 10, null)])).toMatchObject({ score: 90, usability: null });
  });
});

describe("a bin analyzed folder by folder", () => {
  it("runs the Analyzer once per folder with the bin's files, merges and blends in the tags", async () => {
    jobs.runJob.mockImplementation(async (command: string, _label: string, request: { folder?: string; paths?: string[] }) => {
      if (command === "broll-analyze") {
        return { status: "done", result: request.folder === "/d1" ? result([clip("/d1/a.mov", 60), clip("/d1/c.mov", 50)]) : result([clip("/d2/b.mov", 70)]) };
      }
      if (command === "vlm-tags") return { status: "done", result: { files: [{ path: "/d1/a.mov", shots: [shot(0, 10, 100)] }, { path: "/d1/c.mov", shots: null }, { path: "/d2/b.mov", shots: null }] } };
      throw new Error(command);
    });
    const { run, cancelled } = await analyzeBin("resolve", "drone", { params: PARAMS, workers: 2, useVisualTags: true });
    expect(cancelled).toBe(false);
    const analyses = jobs.runJob.mock.calls.filter((c) => c[0] === "broll-analyze");
    expect(analyses.map((c) => [c[1], c[2]])).toEqual([
      ["Analyze Drone (1/2)", { folder: "/d1", enableEnergy: false, windowSec: 4, maxSegments: 1, minGapSec: 1, workers: 2, files: ["/d1/a.mov", "/d1/c.mov"] }],
      ["Analyze Drone (2/2)", { folder: "/d2", enableEnergy: false, windowSec: 4, maxSegments: 1, minGapSec: 1, workers: 2, files: ["/d2/b.mov"] }],
    ]);
    // a.mov: 0.75 * 60 + 0.25 * 100 = 70, level with b.mov; the sort keeps the order it found them in.
    expect(run.ranked.map((c) => [c.filename, c.score])).toEqual([
      ["a.mov", 70],
      ["b.mov", 70],
      ["c.mov", 50],
    ]);
    expect([run.binPath, run.tagged, run.analyzed, run.cached]).toEqual(["P/Drone", 1, 3, 2]);
    expect(useBinRunStore.getState().runs["resolve:P/Drone"]).toBe(run);
  });

  it("keeps the other folders' scores when one folder fails, and skips the tags when asked", async () => {
    jobs.runJob.mockImplementation(async (_c: string, _l: string, request: { folder: string }) =>
      request.folder === "/d1" ? { status: "failed", error: "Not a folder: /d1" } : { status: "done", result: result([clip("/d2/b.mov", 70)]) },
    );
    const { run } = await analyzeBin("premiere", "Drone", { params: PARAMS, workers: null, useVisualTags: false });
    expect(run.ranked.map((c) => c.filename)).toEqual(["b.mov"]);
    expect(run.failed).toEqual([
      { path: "/d1/a.mov", message: "Not a folder: /d1" },
      { path: "/d1/c.mov", message: "Not a folder: /d1" },
    ]);
    expect(jobs.runJob.mock.calls.some((c) => c[0] === "vlm-tags")).toBe(false);
  });

  it("stops between folders when the user stops the turn, and keeps no run", async () => {
    let stopped = false;
    jobs.runJob.mockImplementation(async () => {
      stopped = true;
      return { status: "done", result: result([clip("/d1/a.mov", 60)]) };
    });
    const out = await analyzeBin("premiere", "Drone", { params: PARAMS, workers: null, useVisualTags: true, stop: { started: () => undefined, stopped: () => stopped } });
    expect(out.cancelled).toBe(true);
    expect(jobs.runJob).toHaveBeenCalledTimes(1);
    expect(useBinRunStore.getState().order).toEqual([]);
  });
});

describe("a bin's selects built as a new timeline", () => {
  const run = {
    host: "premiere" as const,
    binPath: "P/Drone",
    at: 1,
    contentAware: true,
    brief: "",
    ranked: [
      { ...fuse(clip("/d1/a.mov", 80, { energy: 61 }), [shot(0, 10, 80)]) },
      { ...fuse(clip("/d2/b.mov", 40), null) },
    ],
    analyzed: 2,
    cached: 0,
    failed: [],
    warnings: [],
    duplicates: 0,
    skipped: [],
    tagged: 1,
  };

  it("names the timeline after the bin and puts a scored marker on each segment", async () => {
    broll.buildTimelineFromSegments.mockResolvedValue({
      timeline: "Drone — B-roll selects",
      layout: [
        { path: "/d1/a.mov", filename: "a.mov", sourceIn: 2, sourceOut: 6, at: 0 },
        { path: "/d2/b.mov", filename: "b.mov", sourceIn: 2, sourceOut: 6, at: 4 },
      ],
      refused: [],
      seconds: 8,
      text: "Made it.",
    });
    const built = await buildBinSelects(run, { topMode: "all", topN: 10, minScore: 0, sequenceOrder: "score" }, { markers: true });
    const [host, name, clips, what] = broll.buildTimelineFromSegments.mock.calls[0];
    expect([host, name, what]).toEqual(["premiere", "Drone — B-roll selects", 'the "Drone" bin']);
    expect(clips.map((c: { path: string }) => c.path)).toEqual(["/d1/a.mov", "/d2/b.mov"]);
    const markerCall = ipc.nleCall.mock.calls.find((c) => c[1] === "add_markers");
    expect(markerCall?.[2]).toEqual({
      timeline: "Drone — B-roll selects",
      markers: [
        { time: 0, name: "a.mov · 80", color: "Green", duration: 4, note: "Score 80 · analyzer 80, usability 80 · energy 61\nWS, STATIC: Harbor at dusk\nTags: harbor, boats" },
        { time: 4, name: "b.mov · 40", color: "Red", duration: 4, note: "Score 40" },
      ],
    });
    expect(built.markers).toBe(2);
  });

  it("keeps the clips when the editor refuses the markers, and builds without them when asked", async () => {
    broll.buildTimelineFromSegments.mockResolvedValue({ timeline: "T", layout: [{ path: "/d1/a.mov", filename: "a.mov", sourceIn: 0, sourceOut: 1, at: 0 }], refused: [], seconds: 1, text: "Made it." });
    ipc.nleCall.mockRejectedValueOnce(new Error("Resolve said no"));
    const built = await buildBinSelects(run, { topMode: "topn", topN: 1, minScore: 0, sequenceOrder: "score" }, { markers: true });
    expect(built.markerProblem).toBe("Resolve said no");
    ipc.nleCall.mockClear();
    await buildBinSelects(run, { topMode: "all", topN: 1, minScore: 0, sequenceOrder: "score" }, { markers: false });
    expect(ipc.nleCall).not.toHaveBeenCalled();
  });

  it("refuses a selection that keeps nothing", async () => {
    await expect(buildBinSelects(run, { topMode: "threshold", topN: 1, minScore: 99, sequenceOrder: "score" }, { markers: true })).rejects.toThrow("keeps no segments");
  });

  it("names, colours and notes", () => {
    expect(selectsName("Proj/Footage/Drone")).toBe("Drone — B-roll selects");
    expect([scoreColor(75), scoreColor(74.9), scoreColor(50), scoreColor(10)]).toEqual(["Green", "Yellow", "Yellow", "Red"]);
    expect(markerFor(run.ranked[1], 1.23456, 2.00049).duration).toBe(2);
  });
});
