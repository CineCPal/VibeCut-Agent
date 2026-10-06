import { beforeEach, describe, expect, it, vi } from "vitest";

const ipc = vi.hoisted(() => ({ startSidecar: vi.fn(), cancelSidecar: vi.fn(), nleCall: vi.fn() }));
vi.mock("./ipc", () => ipc);

import { cancelJob, startAnalysis, startMatch } from "./broll";
import { useBrollStore } from "../store/useBrollStore";
import { useSidecarStore } from "../store/useSidecarStore";

describe("broll actions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    ipc.startSidecar.mockResolvedValue(undefined);
    ipc.cancelSidecar.mockResolvedValue(undefined);
    localStorage.clear();
    useSidecarStore.setState({ jobs: [] });
    useBrollStore.setState({ folder: "/Volumes/Media/Broll", contentAware: false, brief: "", dedupe: false, query: "", analyzeJobId: null, matchJobId: null });
  });

  it("analyzes technically unless content-aware scoring is on", async () => {
    useBrollStore.setState({ brief: "ignored without content-aware", dedupe: true });
    await startAnalysis();
    const [id, command, request] = ipc.startSidecar.mock.calls[0];
    expect(command).toBe("broll-analyze");
    expect(request).toEqual({ folder: "/Volumes/Media/Broll", enableEnergy: false });
    expect(useBrollStore.getState().analyzeJobId).toBe(id);
    expect(useSidecarStore.getState().jobs[0]).toMatchObject({ id, command: "broll-analyze", label: "Analyze Broll", status: "starting" });
  });

  it("sends the brief and dedupe with content-aware scoring", async () => {
    useBrollStore.setState({ contentAware: true, brief: "  night streets ", dedupe: true });
    await startAnalysis();
    expect(ipc.startSidecar.mock.calls[0][2]).toEqual({ folder: "/Volumes/Media/Broll", enableEnergy: true, brief: "night streets", dedupe: true });
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
