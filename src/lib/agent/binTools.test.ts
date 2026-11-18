import { beforeEach, describe, expect, it, vi } from "vitest";

const jobs = vi.hoisted(() => ({ runJob: vi.fn(), jobId: () => "j1", awaitJob: vi.fn() }));
vi.mock("../jobs", () => jobs);
const ipc = vi.hoisted(() => ({ nleCall: vi.fn(), startSidecar: vi.fn(), cancelSidecar: vi.fn(async () => undefined), chooseSavePath: vi.fn() }));
vi.mock("../ipc", () => ipc);

import { binExecutors, binParams, binSelection, binToolDeclarations, runsFor } from "./binTools";
import { binsContext } from "./awareness";
import { DEFAULT_OPTIONS, useBrollStore } from "../../store/useBrollStore";
import { useAgentStore } from "../../store/useAgentStore";
import { useBinRunStore, type BinRun } from "../../store/useBinRunStore";

const run = binExecutors({ host: "resolve", timeline: "Edit", step: "s1", stepText: "x" });

const POOL = {
  bins: [{ path: "Master/Drone", clips: 2 }],
  clips: [
    { id: "1", name: "a", bin: "Master/Drone", type: "Video", filePath: "/d/a.mov", usage: 0 },
    { id: "2", name: "b", bin: "Master/Drone", type: "Video + Audio", filePath: "/d/b.mov", usage: 0 },
  ],
};

const binRun = (binPath: string, host: "resolve" | "premiere" = "resolve"): BinRun => ({
  host,
  binPath,
  at: 1,
  contentAware: false,
  brief: "",
  ranked: [],
  analyzed: 0,
  cached: 0,
  failed: [],
  warnings: [],
  duplicates: 0,
  skipped: [],
  tagged: 0,
});

beforeEach(() => {
  vi.clearAllMocks();
  useBinRunStore.getState().clear();
  useBrollStore.setState({ ...DEFAULT_OPTIONS, folder: "/tab", contentAware: false, brief: "", dedupe: false, lastResult: null, excluded: {} });
  useAgentStore.setState({ status: "thinking" });
  ipc.nleCall.mockResolvedValue(POOL);
});

describe("the bin tools' declarations", () => {
  it("declares the four tools with the editor's words", () => {
    const names = binToolDeclarations("premiere").map((d) => d.name);
    expect(names).toEqual(["analyze_bin", "build_bin_selects", "index_bin_visuals", "find_clips_by_content"]);
    expect(binToolDeclarations("resolve")[0].description).toContain("Media Pool folders");
    expect(binToolDeclarations("premiere")[1].description).toContain("NEW sequence");
  });
});

describe("options", () => {
  it("takes the Analyze tab's options with the call's changes, without changing the tab", () => {
    const { params, notes } = binParams({ brief: "harbor", segmentsPerClip: 3 });
    expect(params).toMatchObject({ contentAware: false, brief: "", maxSegments: 3 });
    expect(notes).toEqual(["the brief needs contentAware, so it wasn't used"]);
    expect(binParams({ contentAware: true, brief: "harbor" }).params).toMatchObject({ contentAware: true, brief: "harbor" });
    expect(useBrollStore.getState().maxSegments).toBe(DEFAULT_OPTIONS.maxSegments);
    expect(() => binParams({ segmentsPerClip: 40 })).toThrow("segmentsPerClip");
    expect(() => binParams({ segmentSeconds: 0.1 })).toThrow("segmentSeconds");
  });

  it("maps the selection words to the Analyzer's", () => {
    expect(binSelection({ include: "best", best: 5, order: "name" })).toMatchObject({ topMode: "topn", topN: 5, sequenceOrder: "name" });
    expect(binSelection({ include: "minScore", minScore: 60 })).toMatchObject({ topMode: "threshold", minScore: 60 });
    expect(() => binSelection({ include: "some" })).toThrow("include");
    expect(() => binSelection({ minScore: 120 })).toThrow("minScore");
  });

  it("finds analyzed runs by bin name, the latest by default, in this editor only", () => {
    expect(() => runsFor("resolve", undefined)).toThrow("call analyze_bin first");
    useBinRunStore.getState().keepRun(binRun("Master/Drone"));
    useBinRunStore.getState().keepRun(binRun("Master/Interviews"));
    useBinRunStore.getState().keepRun(binRun("Proj/Elsewhere", "premiere"));
    expect(runsFor("resolve", undefined).map((r) => r.binPath)).toEqual(["Master/Interviews"]);
    expect(runsFor("resolve", ["drone", "Interviews"]).map((r) => r.binPath)).toEqual(["Master/Drone", "Master/Interviews"]);
    expect(() => runsFor("resolve", ["Elsewhere"])).toThrow("isn't an analyzed bin");
  });
});

describe("analyze_bin", () => {
  it("analyzes the bin and lists its best clips with what they show", async () => {
    jobs.runJob.mockImplementation(async (command: string) => {
      if (command === "broll-analyze") {
        const clip = (name: string, score: number) => ({ path: `/d/${name}`, filename: name, score, bestStart: 1, bestEnd: 5, duration: 9, segments: [{ start: 1, end: 5, score }], energy: null, relevance: null, duplicateOf: null });
        return { status: "done", result: { analyzed: 2, cached: 0, cancelled: false, failed: [], warnings: [], exportPath: null, ranked: [clip("a.mov", 80), clip("b.mov", 60)], duplicates: 0 } };
      }
      return { status: "done", result: { files: [{ path: "/d/b.mov", shots: [{ start: 0, end: 9, shot_scale: "CU", camera_movement: "HANDHELD", description: "A gull", visual_tags: ["bird"], editorial_usability_score: 100 }] }] } };
    });
    const outcome = await run.analyze_bin({ bin: "Drone" });
    expect(ipc.nleCall).toHaveBeenCalledWith("resolve", "read_media_pool", { timeline: "Edit" });
    expect(outcome.summary).toBe('Analyzed "Drone": 2 clips ranked (0 from the cache), 1 with shot tags blended in');
    const result = outcome.result as { best: Record<string, unknown>[]; tagged: number };
    expect(result.tagged).toBe(1);
    expect(result.best[1]).toEqual({ file: "b.mov", path: "/d/b.mov", score: 70, analyzerScore: 60, usability: 100, segments: ["1s–5s"], shows: "A gull", shot: "CU HANDHELD", tags: ["bird"] });
    expect(binsContext("resolve")).toBe('[BINS: analyzed: "Drone" (2 clips, 1 tagged)]');
    expect(binsContext("premiere")).toBeNull();
  });

  it("needs a bin", async () => {
    await expect(run.analyze_bin({})).rejects.toThrow("bin must name a bin");
  });
});

describe("index_bin_visuals", () => {
  it("explains a missing model before starting a long ingest", async () => {
    jobs.runJob.mockResolvedValueOnce({
      status: "done",
      result: { files: [], health: { vlm: { model: "qwen3-vl:8b-instruct", available: false, detail: "not pulled" }, vector: { model: "BAAI/bge-m3", available: true, detail: "ready" } } },
    });
    await expect(run.index_bin_visuals({ bin: "Drone" })).rejects.toThrow('the vision model qwen3-vl:8b-instruct isn\'t ready (not pulled). Start Ollama and pull the model (e.g. "ollama pull qwen3-vl:8b-instruct")');
    expect(jobs.runJob).toHaveBeenCalledTimes(1);
  });

  it("looks at and indexes the bin's files, and remembers the bin", async () => {
    const healthy = { model: "m", available: true, detail: "ready" };
    jobs.runJob.mockResolvedValueOnce({ status: "done", result: { files: [], health: { vlm: healthy, vector: healthy } } });
    jobs.runJob.mockResolvedValueOnce({
      status: "done",
      result: { files: [{ path: "/d/a.mov", shots: 4, indexed: 4, errors: [] }, { path: "/d/b.mov", shots: 0, indexed: 0, errors: ["vision: no picture"] }] },
    });
    const outcome = await run.index_bin_visuals({ bin: "Drone", force: true });
    const [command, label, request] = jobs.runJob.mock.calls[1];
    expect([command, label]).toEqual(["ingest-index", "Index Drone's shots"]);
    expect(request).toEqual({ paths: ["/d/a.mov", "/d/b.mov"], stages: ["vision", "index"], sampleStrategy: "scene_cuts", force: true });
    expect(outcome.summary).toBe('Indexed "Drone": 2 files, 4 shots tagged, 1 with problems');
    expect(useBinRunStore.getState().indexed["resolve:Master/Drone"]).toMatchObject({ files: 2, shots: 4, failed: 1 });
    expect(binsContext("resolve")).toBe('[BINS: indexed for find_clips_by_content: "Drone" (4 shots)]');
  });
});

describe("find_clips_by_content", () => {
  const hit = {
    hit_id: "h",
    rank: 1,
    media_path: "/d/a.mov",
    filename: "a.mov",
    source_range: { start_time: { value: 50, rate: 25 }, duration: { value: 100, rate: 25 } },
    start_tc: "00:00:02:00",
    end_tc: "00:00:06:00",
    scores: { rrf_combined: 100, dense_cosine: 0.8, siglip_visual: null, technical_quality: 82 },
    evidence: { matched_modality: "vlm_shot", transcript_excerpt: null, speaker: null, shot_scale: "WS", camera_movement: "STATIC", vlm_description: "The harbor at dusk", visual_tags: ["harbor"] },
  };

  it("searches the bin's files with the filters and returns placeable stretches", async () => {
    jobs.runJob.mockResolvedValue({ status: "done", result: { hits: [hit] } });
    const outcome = await run.find_clips_by_content({ query: "harbor at dusk", bin: "Drone", shotScales: ["ws"], minQuality: 50, topK: 3 });
    expect(jobs.runJob).toHaveBeenCalledWith("vector-search", 'Find "harbor at dusk"', {
      query: "harbor at dusk",
      modality: "visual",
      top_k: 3,
      scope_paths: ["/d/a.mov", "/d/b.mov"],
      filters: { shot_scales: ["WS"], min_technical_score: 50 },
    });
    expect(outcome.summary).toBe('Found 1 match in "Drone" for "harbor at dusk"');
    expect((outcome.result as { hits: unknown[] }).hits[0]).toEqual({ rank: 1, file: "a.mov", path: "/d/a.mov", start: 2, end: 6, score: 100, quality: 82, shot: "WS STATIC", shows: "The harbor at dusk", tags: ["harbor"] });
  });

  it("says how to fill an empty index, and checks its arguments", async () => {
    jobs.runJob.mockResolvedValue({ status: "done", result: { hits: [] } });
    const outcome = await run.find_clips_by_content({ query: "harbor" });
    expect(outcome.result).toMatchObject({ hits: [], note: expect.stringContaining("index_bin_visuals") });
    expect(ipc.nleCall).not.toHaveBeenCalled();
    await expect(run.find_clips_by_content({ query: "x" })).rejects.toThrow("query");
    await expect(run.find_clips_by_content({ query: "harbor", shotScales: ["HUGE"] })).rejects.toThrow("shotScales");
    await expect(run.find_clips_by_content({ query: "harbor", topK: 30 })).rejects.toThrow("topK");
  });
});
