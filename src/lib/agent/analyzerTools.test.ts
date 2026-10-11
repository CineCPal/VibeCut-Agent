import { beforeEach, describe, expect, it, vi } from "vitest";

const jobs = vi.hoisted(() => ({ runJob: vi.fn(), jobId: () => "j1", awaitJob: vi.fn() }));
vi.mock("../jobs", () => jobs);
const ipc = vi.hoisted(() => ({ chooseSavePath: vi.fn(), nleCall: vi.fn(), startSidecar: vi.fn(), cancelSidecar: vi.fn(async () => undefined) }));
vi.mock("../ipc", () => ipc);

import { analyzerExecutors, LISTED_CLIPS } from "./analyzerTools";
import { DEFAULT_OPTIONS, useBrollStore } from "../../store/useBrollStore";
import { useAgentStore } from "../../store/useAgentStore";
import type { RankedClip } from "../../types/broll";

const clip = (name: string, score: number, extra: Partial<RankedClip> = {}): RankedClip => ({
  path: `/f/${name}`,
  filename: name,
  score,
  bestStart: 1,
  bestEnd: 5,
  duration: 10,
  segments: [{ start: 1, end: 5, score }],
  energy: null,
  relevance: null,
  duplicateOf: null,
  ...extra,
});

const RANKED = [clip("a.mov", 90), clip("b.mov", 70), clip("c.mov", 40, { duplicateOf: "a.mov" }), ...Array.from({ length: 20 }, (_, i) => clip(`z${i}.mov`, 10))];
const RESULT = { analyzed: 23, cached: 3, cancelled: false, failed: [], warnings: [], exportPath: null, ranked: RANKED, duplicates: 1 };

const run = analyzerExecutors();

beforeEach(() => {
  vi.clearAllMocks();
  useBrollStore.setState({ ...DEFAULT_OPTIONS, folder: "/old", contentAware: false, brief: "", dedupe: false, lastResult: null, excluded: {} });
  useAgentStore.setState({ status: "thinking" });
  jobs.runJob.mockImplementation(async (_c: string, _l: string, _r: unknown, onStart?: (id: string) => void) => {
    onStart?.("j1");
    return { id: "j1", status: "done", result: RESULT, error: null };
  });
});

describe("the agent drives the Analyze tab (Phase 16e)", () => {
  it("analyzes a folder with the tab's options, keeps the result in the tab and lists the best clips", async () => {
    const outcome = await run.analyze_broll_folder({ folder: "/f", segmentsPerClip: 3, brief: "bread" });
    const [command, label, request] = jobs.runJob.mock.calls[0];
    expect([command, label]).toEqual(["broll-analyze", "Analyze f"]);
    // The brief needs content-aware scoring, which wasn't on, so it isn't sent.
    expect(request).toEqual({ folder: "/f", enableEnergy: false, windowSec: 4, maxSegments: 3, minGapSec: 1 });
    const s = useBrollStore.getState();
    expect([s.folder, s.maxSegments, s.analyzeJobId, s.lastResult?.folder]).toEqual(["/f", 3, "j1", "/f"]);
    expect(outcome.summary).toBe("Analyzed f: 23 clip(s) ranked (3 from the cache), 1 near-duplicate(s); the selects keep 22 segment(s), 88s; the brief needs contentAware, so it wasn't used");
    const result = outcome.result as { best: { file: string; segments: string[] }[] };
    expect(result.best).toHaveLength(LISTED_CLIPS);
    expect(result.best[0]).toEqual({ file: "a.mov", score: 90, segments: ["1s–5s"] });
  });

  it("refuses a relative folder and reports a failed run", async () => {
    await expect(run.analyze_broll_folder({ folder: "f" })).rejects.toThrow("absolute");
    jobs.runJob.mockResolvedValueOnce({ id: "j1", status: "failed", result: null, error: "Not a folder: /f" });
    await expect(run.analyze_broll_folder({ folder: "/f" })).rejects.toThrow("Not a folder: /f");
  });

  it("exports the selects with the selection given, to a path or through the save dialog", async () => {
    await run.analyze_broll_folder({ folder: "/f" });
    jobs.runJob.mockResolvedValue({ id: "e", status: "done", result: { exportPath: "/out/x.xml", warnings: [], clips: 2, segments: 2, seconds: 8 }, error: null });
    const out = await run.export_broll_selects({ include: "best", best: 2, sequenceName: "Bread", outputPath: "/out/x.xml" });
    const request = jobs.runJob.mock.calls.at(-1)![2] as { outputPath: string; sequenceName: string; clips: { path: string }[] };
    expect([request.outputPath, request.sequenceName, request.clips.map((c) => c.path)]).toEqual(["/out/x.xml", "Bread", ["/f/a.mov", "/f/b.mov"]]);
    expect(ipc.chooseSavePath).not.toHaveBeenCalled();
    expect(useBrollStore.getState().topMode).toBe("topn");
    expect(out.summary).toContain("Resolve: File → Import → Timeline");

    ipc.chooseSavePath.mockResolvedValueOnce(null);
    expect((await run.export_broll_selects({})).summary).toBe("The user cancelled the save dialog; nothing was written");
    await expect(run.export_broll_selects({ outputPath: "x.xml" })).rejects.toThrow("absolute path ending in .xml");
    await expect(run.export_broll_selects({ include: "some" })).rejects.toThrow('include must be "all", "best" or "minScore"');
  });

  it("needs an analysis of the tab's folder before exporting or building", async () => {
    await expect(run.export_broll_selects({})).rejects.toThrow("call analyze_broll_folder first");
    await expect(run.build_broll_selects_timeline({})).rejects.toThrow("call analyze_broll_folder first");
  });
});
