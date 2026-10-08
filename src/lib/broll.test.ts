import { beforeEach, describe, expect, it, vi } from "vitest";

const ipc = vi.hoisted(() => ({ startSidecar: vi.fn(), cancelSidecar: vi.fn(), nleCall: vi.fn(), chooseSavePath: vi.fn() }));
vi.mock("./ipc", () => ipc);

import { cancelJob, startAnalysis, startMatch } from "./broll";
import { DEFAULT_OPTIONS, useBrollStore } from "../store/useBrollStore";
import { useSidecarStore } from "../store/useSidecarStore";

describe("broll actions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    ipc.startSidecar.mockResolvedValue(undefined);
    ipc.cancelSidecar.mockResolvedValue(undefined);
    localStorage.clear();
    useSidecarStore.setState({ jobs: [] });
    useBrollStore.setState({ ...DEFAULT_OPTIONS, folder: "/Volumes/Media/Broll", contentAware: false, brief: "", dedupe: false, query: "", analyzeJobId: null, matchJobId: null, lastResult: null, excluded: {} });
  });

  it("analyzes technically unless content-aware scoring is on", async () => {
    useBrollStore.setState({ brief: "ignored without content-aware", dedupe: true });
    await startAnalysis();
    const [id, command, request] = ipc.startSidecar.mock.calls[0];
    expect(command).toBe("broll-analyze");
    expect(request).toEqual({ folder: "/Volumes/Media/Broll", enableEnergy: false, windowSec: 4, maxSegments: 1, minGapSec: 1 });
    expect(useBrollStore.getState().analyzeJobId).toBe(id);
    expect(useSidecarStore.getState().jobs[0]).toMatchObject({ id, command: "broll-analyze", label: "Analyze Broll", status: "starting" });
  });

  it("sends the brief and dedupe with content-aware scoring", async () => {
    useBrollStore.setState({ contentAware: true, brief: "  night streets ", dedupe: true });
    await startAnalysis();
    expect(ipc.startSidecar.mock.calls[0][2]).toEqual({
      folder: "/Volumes/Media/Broll",
      enableEnergy: true,
      windowSec: 4,
      maxSegments: 1,
      minGapSec: 1,
      energyWeight: 0.35,
      brief: "night streets",
      relevanceWeight: 0.35,
      dedupe: true,
    });
  });

  it("searches with one query", async () => {
    useBrollStore.setState({ query: " a dog on a beach " });
    await startMatch();
    expect(ipc.startSidecar).toHaveBeenCalledWith(expect.any(String), "broll-match", {
      folder: "/Volumes/Media/Broll",
      queries: [{ id: "q", text: "a dog on a beach" }],
      topK: 8,
    });
  });

  it("does nothing without a folder or a query", async () => {
    useBrollStore.setState({ folder: null });
    await startAnalysis();
    useBrollStore.setState({ folder: "/x", query: "  " });
    await startMatch();
    expect(ipc.startSidecar).not.toHaveBeenCalled();
  });

  it("marks a job that couldn't start as failed, and cancels", async () => {
    ipc.startSidecar.mockRejectedValue(new Error("uv not found"));
    await startAnalysis();
    const job = useSidecarStore.getState().jobs[0];
    expect(job).toMatchObject({ status: "failed", error: "uv not found" });

    useSidecarStore.getState().addJob({ id: "j2", command: "broll-match", label: "x" });
    await cancelJob("j2");
    expect(ipc.cancelSidecar).toHaveBeenCalledWith("j2");
    expect(useSidecarStore.getState().jobs[0].detail).toBe("Stopping…");
  });

  it("forgets the jobs, not the options, when the folder changes; caps the brief", () => {
    useBrollStore.setState({ analyzeJobId: "a", matchJobId: "m", contentAware: true });
    useBrollStore.getState().setFolder("/other");
    expect(useBrollStore.getState()).toMatchObject({ folder: "/other", analyzeJobId: null, matchJobId: null, contentAware: true });
    useBrollStore.getState().setBrief("x".repeat(250));
    expect(useBrollStore.getState().brief).toHaveLength(200);
    useBrollStore.getState().setDedupe(true);
    useBrollStore.getState().setContentAware(false);
    expect(useBrollStore.getState().dedupe).toBe(false);
  });
});

describe("placing a pick", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    const { useEditLogStore } = await import("../store/useEditLogStore");
    useEditLogStore.setState({ entries: [], backups: {}, restoredIds: { premiere: {}, resolve: {} } });
  });

  it("says what's missing before an editor and timeline are open", async () => {
    const { initialHosts, useNleStateStore } = await import("../store/useNleStateStore");
    const { placementTarget } = await import("./broll");
    useNleStateStore.setState({ hosts: initialHosts(), preferredHost: "auto" });
    expect(placementTarget()).toBe("Connect Premiere Pro or DaVinci Resolve to place clips");
    const hosts = initialHosts();
    hosts.resolve = { ...hosts.resolve, status: "connected", timeline: null };
    useNleStateStore.setState({ hosts });
    expect(placementTarget()).toBe("Open a timeline in Resolve to place clips");
  });

  it("places the best stretch at the playhead as its own revertible request", async () => {
    const { initialHosts, useNleStateStore } = await import("../store/useNleStateStore");
    const { useEditLogStore } = await import("../store/useEditLogStore");
    const { placeAtPlayhead } = await import("./broll");
    const hosts = initialHosts();
    hosts.premiere = { ...hosts.premiere, status: "connected", timeline: "Main", project: "Doc" };
    useNleStateStore.setState({ hosts, preferredHost: "auto" });
    ipc.nleCall.mockImplementation(async (_h: string, command: string) => {
      if (command === "get_playhead") return { time: 12.5 };
      if (command === "backup_timeline") return { backup: "Main (before VibeCut 1)" };
      return { changes: [{ kind: "added", name: "b.mov", at: 12.5, end: 16.5, tracks: ["V2", "A3"] }], refused: [] };
    });
    const summary = await placeAtPlayhead({ path: "/m/b.mov", filename: "b.mov", start: 2, end: 6 });
    expect(ipc.nleCall).toHaveBeenCalledWith("premiere", "add_clips", { timeline: "Main", clips: [{ path: "/m/b.mov", sourceIn: 2, sourceOut: 6, at: 12.5 }] });
    expect(summary).toBe('Added 1 clip to the sequence: "b.mov" at 12.5s on V2+A3 (backup: "Main (before VibeCut 1)")');
    expect(useEditLogStore.getState().entries[0]).toMatchObject({ tool: "place_broll", stepText: "Place b.mov" });
  });
});

const clip = (path: string, score: number, segments: [number, number][]) => ({
  path,
  filename: path.split("/").pop() as string,
  score,
  bestStart: segments[0][0],
  bestEnd: segments[0][1],
  duration: 30,
  segments: segments.map(([start, end]) => ({ start, end, score })),
  energy: null,
  relevance: null,
  duplicateOf: null,
});

/** Finishes a job the way the sidecar bridge would: a result event, then a clean exit. */
function finish(id: string, result: Record<string, unknown>) {
  useSidecarStore.getState().applyEvent(id, { type: "result", ...result });
  useSidecarStore.getState().applyExit({ jobId: id, code: 0, cancelled: false, message: null });
}

describe("Phase 10: options, kept results, XML and timeline", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    localStorage.clear();
    useSidecarStore.setState({ jobs: [] });
    useBrollStore.setState({ ...DEFAULT_OPTIONS, folder: "/m", contentAware: false, brief: "", dedupe: false, analyzeJobId: null, lastResult: null, excluded: {} });
    const { useEditLogStore } = await import("../store/useEditLogStore");
    useEditLogStore.setState({ entries: [], backups: {}, restoredIds: { premiere: {}, resolve: {} } });
  });

  it("sends the segment options and workers, and keeps a finished run with what it was asked", async () => {
    useBrollStore.setState({ windowSec: 2.5, maxSegments: 3, minGapSec: 0.5, workers: 2 });
    ipc.startSidecar.mockResolvedValue(undefined);
    await startAnalysis();
    const [id, , request] = ipc.startSidecar.mock.calls[0];
    expect(request).toEqual({ folder: "/m", enableEnergy: false, windowSec: 2.5, maxSegments: 3, minGapSec: 0.5, workers: 2 });
    useBrollStore.getState().toggleSegment("/m/a.mov", 1);
    finish(id, { ranked: [clip("/m/a.mov", 80, [[0, 2.5]])], analyzed: 1, cached: 0, cancelled: false, failed: [], warnings: [], duplicates: 0, exportPath: null });
    await vi.waitFor(() => expect(useBrollStore.getState().lastResult).not.toBeNull());
    const kept = useBrollStore.getState().lastResult!;
    expect(kept.folder).toBe("/m");
    expect(kept.params).toMatchObject({ windowSec: 2.5, maxSegments: 3, minGapSec: 0.5, contentAware: false });
    expect(kept.result.ranked).toHaveLength(1);
    expect(useBrollStore.getState().excluded).toEqual({});
  });

  it("doesn't keep a cancelled run", async () => {
    ipc.startSidecar.mockResolvedValue(undefined);
    await startAnalysis();
    const [id] = ipc.startSidecar.mock.calls[0];
    finish(id, { ranked: [], cancelled: true, analyzed: 0, cached: 0, failed: [], warnings: [], duplicates: 0 });
    await new Promise((r) => setTimeout(r, 0));
    expect(useBrollStore.getState().lastResult).toBeNull();
  });

  it("exports the chosen segments as a Premiere XML through broll-export", async () => {
    const { exportSelectsXml } = await import("./broll");
    const { selects } = await import("./brollSelects");
    ipc.chooseSavePath.mockResolvedValue("/out/Gym");
    ipc.startSidecar.mockImplementation(async (id: string) => {
      finish(id, { exportPath: "/out/Gym.xml", clips: 2, segments: 3, seconds: 95.2 });
    });
    useBrollStore.setState({ sequenceName: "  Gym  " });
    const chosen = selects([clip("/m/a.mov", 80, [[0, 2], [5, 8]]), clip("/m/b.mov", 60, [[1, 4]])], DEFAULT_OPTIONS, {}, true);
    const done = await exportSelectsXml(chosen);
    expect(ipc.chooseSavePath).toHaveBeenCalledWith("Export Premiere XML", "/m/m selects.xml", ["xml"]);
    const [, command, request] = ipc.startSidecar.mock.calls[0];
    expect(command).toBe("broll-export");
    expect(request).toEqual({
      folder: "/m",
      outputPath: "/out/Gym.xml",
      sequenceName: "Gym",
      showEnergy: false,
      clips: [
        { path: "/m/a.mov", score: 80, energy: null, segments: [{ start: 0, end: 2 }, { start: 5, end: 8 }] },
        { path: "/m/b.mov", score: 60, energy: null, segments: [{ start: 1, end: 4 }] },
      ],
    });
    expect(done).toEqual({ text: "Wrote 3 segments from 2 clips (1:35). In Premiere: File → Import.", path: "/out/Gym.xml" });
  });

  it("does nothing when the save dialog is cancelled, and reports a failed export", async () => {
    const { exportSelectsXml } = await import("./broll");
    const { selects } = await import("./brollSelects");
    const chosen = selects([clip("/m/a.mov", 80, [[0, 2]])], DEFAULT_OPTIONS, {}, true);
    ipc.chooseSavePath.mockResolvedValue(null);
    expect(await exportSelectsXml(chosen)).toBeNull();
    expect(ipc.startSidecar).not.toHaveBeenCalled();
    ipc.chooseSavePath.mockResolvedValue("/out/x.xml");
    ipc.startSidecar.mockImplementation(async (id: string) => {
      useSidecarStore.getState().fail(id, "a.mov hasn't been analyzed yet; analyze the folder first");
    });
    await expect(exportSelectsXml(chosen)).rejects.toThrow("hasn't been analyzed");
  });

  it("builds a new timeline of the selects back to back, in batches of 50, as one revertible request", async () => {
    const { initialHosts, useNleStateStore } = await import("../store/useNleStateStore");
    const { useEditLogStore } = await import("../store/useEditLogStore");
    const { useConnectionStore } = await import("../store/useConnectionStore");
    const { buildSelectsTimeline } = await import("./broll");
    const { selects } = await import("./brollSelects");
    const hosts = initialHosts();
    hosts.resolve = { ...hosts.resolve, status: "connected", timeline: "Timeline 28", project: "VibeCut 7a" };
    useNleStateStore.setState({ hosts, preferredHost: "auto" });
    useBrollStore.setState({ sequenceName: "VCA 10 selects" });
    ipc.nleCall.mockImplementation(async (_h: string, command: string, args: { clips?: unknown[] }) => {
      if (command === "create_timeline") return { timeline: "VCA 10 selects" };
      if (command === "backup_timeline") return { backup: "VCA 10 selects (before VibeCut 1)" };
      return { changes: (args.clips ?? []).map((_, i) => ({ kind: "added", name: `c${i}`, at: i, end: i + 1, tracks: ["V1", "A1"] })), refused: [] };
    });
    const ranked = Array.from({ length: 30 }, (_, i) => clip(`/m/c${String(i).padStart(2, "0")}.mov`, 90 - i, [[0, 1], [10, 12]]));
    const chosen = selects(ranked, DEFAULT_OPTIONS, {}, true);
    const progress: string[] = [];
    const summary = await buildSelectsTimeline(chosen, (t) => progress.push(t));

    expect(ipc.nleCall).toHaveBeenCalledWith("resolve", "create_timeline", { timeline: "Timeline 28", name: "VCA 10 selects" });
    expect(useConnectionStore.getState().connections.resolve.madeTimelines).toContain("VCA 10 selects");
    const adds = ipc.nleCall.mock.calls.filter((c) => c[1] === "add_clips");
    expect(adds.map((c) => (c[2] as { clips: unknown[] }).clips.length)).toEqual([50, 10]);
    const first = (adds[0][2] as { timeline: string; clips: { at: number; sourceIn: number; sourceOut: number }[] });
    expect(first.timeline).toBe("VCA 10 selects");
    expect(first.clips.slice(0, 3)).toEqual([
      { path: "/m/c00.mov", sourceIn: 0, sourceOut: 1, at: 0 },
      { path: "/m/c00.mov", sourceIn: 10, sourceOut: 12, at: 1 },
      { path: "/m/c01.mov", sourceIn: 0, sourceOut: 1, at: 3 },
    ]);
    const entries = useEditLogStore.getState().entries;
    expect(entries).toHaveLength(2);
    expect(new Set(entries.map((e) => e.step)).size).toBe(1);
    expect(entries[0]).toMatchObject({ tool: "build_broll_selects", timeline: "VCA 10 selects" });
    expect(progress).toEqual(['Making "VCA 10 selects" in Resolve…', "Placing 1–50 of 60…", "Placing 51–60 of 60…"]);
    expect(summary).toBe('Made "VCA 10 selects" in Resolve with 60 segments (1:30); Revert in the Agent tab takes the clips back.');
  });

  it("refuses to build without an editor or while a Story Editor draft is open", async () => {
    const { initialHosts, useNleStateStore } = await import("../store/useNleStateStore");
    const { useConnectionStore } = await import("../store/useConnectionStore");
    const { buildBlocked } = await import("./broll");
    useNleStateStore.setState({ hosts: initialHosts(), preferredHost: "auto" });
    expect(buildBlocked()).toBe("Connect Premiere Pro or DaVinci Resolve to build a timeline");
    const hosts = initialHosts();
    hosts.premiere = { ...hosts.premiere, status: "connected", timeline: null };
    useNleStateStore.setState({ hosts });
    expect(buildBlocked()).toBeNull();
    useConnectionStore.getState().setDraft("premiere", { base: "Main", changes: [] } as never);
    expect(buildBlocked()).toBe("A Story Editor draft is open in Premiere; send or discard it first");
    useConnectionStore.getState().setDraft("premiere", null);
  });
});
