import { beforeEach, describe, expect, it, vi } from "vitest";

const ipc = vi.hoisted(() => ({ nleCall: vi.fn(), startSidecar: vi.fn(), cancelSidecar: vi.fn() }));
vi.mock("../ipc", () => ipc);
const jobs = vi.hoisted(() => ({ runJob: vi.fn() }));
vi.mock("../jobs", () => jobs);

import { onTimeline, pictureClip } from "./shotTools";
import { executorsFor, runTool, type ToolContext } from "./tools";
import { emptyConnection, useConnectionStore } from "../../store/useConnectionStore";
import { initialHosts, useNleStateStore } from "../../store/useNleStateStore";
import { nleState } from "../../test/nleFixtures";
import type { HostClip, HostTimeline } from "../../types/timeline";

const clip = (id: string, start: number, end: number, sourceIn: number, extra: Partial<HostClip> = {}): HostClip => ({
  id,
  name: id,
  start,
  end,
  enabled: true,
  sourceIn,
  sourceOut: sourceIn + end - start,
  filePath: "/m/export.mov",
  ...extra,
});
/** A flattened export placed from 30 s into its file, at 10 s on the timeline. */
const TIMELINE: HostTimeline = {
  project: "Doc",
  timeline: "Main",
  fps: 25,
  startTimecode: "00:00:00:00",
  duration: 30,
  isCurrent: true,
  tracks: [
    { type: "video", index: 1, name: "", enabled: true, clips: [clip("v1", 10, 30, 30, { linkedIds: ["a1"] })] },
    { type: "audio", index: 1, name: "", enabled: true, clips: [clip("a1", 10, 30, 30, { linkedIds: ["v1"] })] },
  ],
  markers: [],
};
const ctx: ToolContext = { host: "resolve", timeline: "Main", step: "s1", stepText: "find the shots" };

describe("shot changes", () => {
  it("takes a sound clip's linked picture, and refuses sound alone", () => {
    expect(pictureClip(TIMELINE.tracks, "a1").id).toBe("v1");
    const alone = [{ type: "audio", clips: [clip("a2", 0, 5, 0)] }];
    expect(() => pictureClip(alone, "a2")).toThrow("sound only");
    expect(() => pictureClip(TIMELINE.tracks, "x")).toThrow("no clip x");
  });

  it("puts file times on the timeline, at the clip's speed, leaving out its edges", () => {
    const cuts = [30, 34, 49.96, 50, 52].map((time) => ({ time, score: 0.5 }));
    expect(onTimeline(TIMELINE.tracks[0].clips[0], cuts, 25).map((c) => [c.time, c.sourceTime])).toEqual([
      [14, 34],
      [29.96, 49.96],
    ]);
    const fast = clip("v2", 0, 10, 0, { speed: 2 });
    expect(onTimeline(fast, [{ time: 8, score: 0.4 }], 25).map((c) => c.time)).toEqual([4]);
  });
});

describe("find_shot_changes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useConnectionStore.setState({ connections: { premiere: emptyConnection("Doc"), resolve: emptyConnection("Doc") } });
    useNleStateStore.setState({ hosts: { ...initialHosts(), resolve: nleState("resolve") } });
    ipc.nleCall.mockResolvedValue(TIMELINE);
    jobs.runJob.mockResolvedValue({ result: { cuts: [{ time: 34, score: 0.6 }, { time: 41.2, score: 0.3 }], start: 30, end: 50, fps: 25, frames: 500 } });
  });

  it("reads the part of the file a clip plays and answers in timeline seconds", async () => {
    const out = await runTool(executorsFor(ctx), "find_shot_changes", { clipId: "v1" });
    expect(jobs.runJob).toHaveBeenCalledWith("media-shots", 'Find the shot changes in "v1"', { path: "/m/export.mov", start: 30, end: 50, sensitivity: "normal" });
    expect(out.summary).toBe('Found 2 shot change(s) in "v1" between 10.0s and 30.0s: 14.0s, 21.2s');
    expect((out.result as { cuts: unknown[] }).cuts).toEqual([
      { time: 14, sourceTime: 34, score: 0.6 },
      { time: 21.2, sourceTime: 41.2, score: 0.3 },
    ]);
  });

  it("narrows to start and end, and reads a file in file seconds", async () => {
    await runTool(executorsFor(ctx), "find_shot_changes", { clipId: "v1", start: 12, end: 20, sensitivity: "high" });
    expect(jobs.runJob).toHaveBeenLastCalledWith("media-shots", expect.any(String), { path: "/m/export.mov", start: 32, end: 40, sensitivity: "high" });
    const out = await runTool(executorsFor(ctx), "find_shot_changes", { path: "/m/ref.mp4", start: 5 });
    expect(jobs.runJob).toHaveBeenLastCalledWith("media-shots", "Find the shot changes in ref.mp4", { path: "/m/ref.mp4", start: 5, sensitivity: "normal" });
    expect((out.result as { cuts: unknown[] }).cuts[0]).toEqual({ sourceTime: 34, score: 0.6 });
  });

  it("refuses without a clip or file, and passes a failed job's reason on", async () => {
    const none = await runTool(executorsFor(ctx), "find_shot_changes", {});
    expect(String((none.result as { error?: unknown }).error)).toContain("Give clipId");
    jobs.runJob.mockResolvedValue({ error: "export.mov has no picture to find shots in" });
    const failed = await runTool(executorsFor(ctx), "find_shot_changes", { path: "/m/export.mov" });
    expect(String((failed.result as { error?: unknown }).error)).toContain("no picture");
  });
});
