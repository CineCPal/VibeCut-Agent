import { beforeEach, describe, expect, it, vi } from "vitest";

const ipc = vi.hoisted(() => ({ nleCall: vi.fn(), startSidecar: vi.fn(), cancelSidecar: vi.fn() }));
vi.mock("../ipc", () => ipc);
const core = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ ...core, convertFileSrc: (p: string) => p }));
const jobs = vi.hoisted(() => ({ runJob: vi.fn() }));
vi.mock("../jobs", () => jobs);

import { pacingFindings, pacingProfile, speechGaps, timelineShots, type Shot } from "./pacingTools";
import { executorsFor, runTool, type ToolContext } from "./tools";
import { emptyConnection, useConnectionStore } from "../../store/useConnectionStore";
import { initialHosts, useNleStateStore } from "../../store/useNleStateStore";
import { nleState } from "../../test/nleFixtures";
import type { HostClip, HostTimeline } from "../../types/timeline";
import type { TranscriptData } from "../../vibecut/types/transcript";

const CAM = "/m/cam.mov";
const clip = (id: string, start: number, end: number, sourceIn: number, filePath: string, extra: Partial<HostClip> = {}): HostClip => ({
  id,
  name: id,
  start,
  end,
  enabled: true,
  sourceIn,
  sourceOut: sourceIn + end - start,
  filePath,
  ...extra,
});
/** A 60 s interview on V1/A1 (linked), with B-roll on V2 at 10–14 s and 30–33 s. */
const TIMELINE: HostTimeline = {
  project: "Doc",
  timeline: "Main",
  fps: 25,
  startTimecode: "00:00:00:00",
  duration: 60,
  isCurrent: true,
  tracks: [
    { type: "video", index: 1, name: "", enabled: true, clips: [clip("v1", 0, 60, 0, CAM, { linkedIds: ["a1"] })] },
    { type: "video", index: 2, name: "", enabled: true, clips: [clip("b1", 10, 14, 0, "/m/b1.mov"), clip("b2", 30, 33, 5, "/m/b2.mov")] },
    { type: "audio", index: 1, name: "", enabled: true, clips: [clip("a1", 0, 60, 0, CAM, { linkedIds: ["v1"] })] },
  ],
  markers: [],
};
const TRANSCRIPT: TranscriptData = {
  segments: [
    { start: 0.5, end: 20, text: "First answer.", speaker: "Speaker 1" },
    { start: 25, end: 59, text: "Second answer.", speaker: "Speaker 1" },
  ],
  speakers: ["Speaker 1"],
  speakerLabels: {},
  excludedSpeakers: [],
};

/** `count` shots of `length` seconds from `from`. */
const run = (from: number, count: number, length: number): Shot[] => Array.from({ length: count }, (_, i) => ({ start: from + i * length, end: from + (i + 1) * length }));
const judge = (shots: Shot[], deadAir: { start: number; end: number }[] | null = null, target = {}) => {
  const range = { start: shots[0].start, end: shots[shots.length - 1].end };
  const profile = pacingProfile(shots, deadAir, range);
  return { profile, findings: pacingFindings(profile, shots, deadAir, target) };
};

describe("pacing, measured", () => {
  it("takes the picture that plays as the shots, B-roll on top included", () => {
    expect(timelineShots(TIMELINE)).toEqual([
      { start: 0, end: 10, clipId: "v1", name: "v1" },
      { start: 10, end: 14, clipId: "b1", name: "b1" },
      { start: 14, end: 30, clipId: "v1", name: "v1" },
      { start: 30, end: 33, clipId: "b2", name: "b2" },
      { start: 33, end: 60, clipId: "v1", name: "v1" },
    ]);
  });

  it("counts a split that plays on as one shot, and a jump in the source as a cut", () => {
    const view = (sourceIn: number): HostTimeline => ({ ...TIMELINE, tracks: [{ type: "video", index: 1, name: "", enabled: true, clips: [clip("c1", 0, 5, 0, CAM), clip("c2", 5, 10, sourceIn, CAM)] }] });
    expect(timelineShots(view(5)).map((s) => [s.start, s.end])).toEqual([[0, 10]]);
    expect(timelineShots(view(20)).map((s) => [s.start, s.end, s.clipId])).toEqual([
      [0, 5, "c1"],
      [5, 10, "c2"],
    ]);
  });

  it("gives shot lengths, cut rates and a curve", () => {
    const { profile } = judge(timelineShots(TIMELINE));
    expect(profile).toMatchObject({ shots: 5, cutsPerMinute: 4, medianShot: 10, meanShot: 12, p90Shot: 22.6 });
    expect(profile.longestShots[0]).toMatchObject({ start: 33, end: 60, seconds: 27, clipId: "v1" });
    expect(profile.curve).toEqual([
      { start: 0, end: 15, cutsPerMinute: 8 },
      { start: 15, end: 30, cutsPerMinute: 0 },
      { start: 30, end: 45, cutsPerMinute: 8 },
      { start: 45, end: 60, cutsPerMinute: 0 },
    ]);
    expect(profile.deadAir).toBeUndefined();
  });

  it("finds the stretches with no words between the first line and the last", () => {
    const lines = [
      { start: 0, end: 4 },
      { start: 3, end: 6 },
      { start: 9, end: 10 },
      { start: 10.5, end: 12 },
    ];
    expect(speechGaps(lines, { start: 0, end: 11 })).toEqual([
      { start: 6, end: 9 },
      { start: 10, end: 10.5 },
    ]);
    const { profile, findings } = judge(run(0, 6, 2), speechGaps(lines, { start: 0, end: 12 }));
    expect(profile.deadAir).toEqual({ seconds: 3.5, share: 0.29, longest: [{ start: 6, end: 9, seconds: 3 }, { start: 10, end: 10.5, seconds: 0.5 }] });
    expect(findings.map((f) => [f.category, f.time, f.end, f.severity])).toEqual([["dead_air", 6, 9, "medium"]]);
  });
});

describe("pacing, judged", () => {
  it("notes a long shot, and not the slow stretch it explains", () => {
    const { findings } = judge([...run(0, 10, 3), { start: 30, end: 55, clipId: "held" }, ...run(55, 10, 3)]);
    expect(findings.map((f) => [f.category, f.time, f.end, f.severity, f.clipIds])).toEqual([["long_shot", 30, 55, "medium", ["held"]]]);
    expect(findings[0].message).toContain("3× this edit's median shot of 3s");
  });

  it("notes a slow stretch against the edit's own rate", () => {
    const { profile, findings } = judge([...run(0, 15, 2), ...run(30, 4, 7.5), ...run(60, 15, 2)]);
    expect(profile.cutsPerMinute).toBe(22);
    expect(findings.map((f) => [f.category, f.time, f.end])).toEqual([["slow_stretch", 30, 60]]);
    expect(findings[0].message).toContain("cuts 8 times a minute against this edit's 22 overall");
  });

  it("notes a slow opening", () => {
    const { findings } = judge([{ start: 0, end: 14 }, ...run(14, 23, 2)]);
    expect(findings.map((f) => [f.category, f.time, f.end, f.severity])).toEqual([
      ["long_shot", 0, 14, "low"],
      ["slow_opening", 0, 15, "medium"],
    ]);
  });

  it("judges against a target when one is given", () => {
    const shots = [{ start: 0, end: 14 }, ...run(14, 23, 2)];
    const { findings } = judge(shots, null, { medianShot: 1.5, maxShot: 20 });
    expect(findings.map((f) => f.category)).toEqual(["slow_opening", "pace"]);
    expect(findings[1].message).toBe("The median shot is 2s against the target's 1.5s: slower than asked.");
    expect(judge(shots, null, { medianShot: 2 }).findings.map((f) => f.category)).toEqual(["long_shot", "slow_opening"]);
  });
});

describe("check_pacing", () => {
  const ctx: ToolContext = { host: "resolve", timeline: "Main", step: "s1", stepText: "does it drag?" };
  const tool = (args: Record<string, unknown> = {}) => runTool(executorsFor(ctx), "check_pacing", args);
  const errorOf = (outcome: { result: unknown }) => String((outcome.result as { error?: unknown }).error);

  beforeEach(() => {
    vi.clearAllMocks();
    useConnectionStore.setState({ connections: { premiere: emptyConnection("Doc"), resolve: emptyConnection("Doc") } });
    useNleStateStore.setState({ hosts: { ...initialHosts(), resolve: nleState("resolve") } });
    ipc.nleCall.mockResolvedValue(TIMELINE);
    core.invoke.mockImplementation(async (command: string, args: { mediaPath: string }) => (command === "read_transcript" && args.mediaPath === CAM ? TRANSCRIPT : null));
  });

  it("measures the timeline, with dead air from the transcripts", async () => {
    const out = await tool();
    expect(jobs.runJob).not.toHaveBeenCalled();
    expect(out.summary).toBe('Pacing of "Main" (0.0s–60.0s): 5 shot(s), 4 cuts a minute, median shot 10s; 1 dead air');
    const result = out.result as { judgedAgainst: string; profile: { deadAir: { seconds: number } }; findings: { category: string; time: number; end: number }[] };
    expect(result.judgedAgainst).toContain("this edit itself");
    expect(result.profile.deadAir.seconds).toBe(5);
    expect(result.findings.map((f) => [f.category, f.time, f.end])).toEqual([["dead_air", 20, 25]]);
    expect(out.findings?.[0]).toMatchObject({ time: 20, end: 25, severity: "medium", source: "check" });
  });

  it("looks inside long shots for cuts when asked", async () => {
    jobs.runJob.mockResolvedValue({ result: { cuts: [{ time: 45, score: 0.5 }], start: 33, end: 60, fps: 25, frames: 675 } });
    const out = await tool({ splitLongClips: true });
    expect(jobs.runJob).toHaveBeenCalledTimes(1);
    expect(jobs.runJob).toHaveBeenCalledWith("media-shots", 'Find the shots in "v1"', { path: CAM, start: 33, end: 60, sensitivity: "normal" });
    expect((out.result as { profile: { shots: number } }).profile.shots).toBe(6);
  });

  it("falls back to the sound level when nothing is transcribed", async () => {
    core.invoke.mockResolvedValue(null);
    const maxes = Array.from({ length: 600 }, (_, i) => (i >= 200 && i < 250 ? 0.0001 : 0.5));
    jobs.runJob.mockResolvedValue({ status: "done", result: { peaks: { [CAM]: { peaksPerSecond: 10, mins: maxes.map((m) => -m), maxes } }, failed: [] } });
    const out = await tool();
    expect(jobs.runJob.mock.calls[0][0]).toBe("audio-peaks");
    const result = out.result as { findings: { category: string; time: number; end: number }[]; notes: string[] };
    expect(result.findings.map((f) => f.category)).toEqual(["dead_air"]);
    expect(result.findings[0].time).toBeCloseTo(20, 0);
    expect(result.findings[0].end).toBeCloseTo(25, 0);
    expect(result.notes[0]).toContain("from the sound level");
  });

  it("measures a file from its cuts", async () => {
    jobs.runJob.mockResolvedValue({ result: { cuts: [{ time: 4, score: 0.5 }, { time: 9, score: 0.4 }], start: 0, end: 12, fps: 25, frames: 300 } });
    const out = await tool({ path: "/m/reference.mp4", target: { medianShot: 4 } });
    expect(jobs.runJob).toHaveBeenCalledWith("media-shots", "Find the shots in reference.mp4", { path: "/m/reference.mp4", start: 0, sensitivity: "normal" });
    const result = out.result as { path: string; target: unknown; profile: { shots: number; medianShot: number }; notes: string[] };
    expect(result.path).toBe("/m/reference.mp4");
    expect(result.target).toEqual({ medianShot: 4 });
    expect(result.profile).toMatchObject({ shots: 3, medianShot: 4 });
    expect(result.notes[0]).toContain("has no transcript");
  });

  it("refuses bad requests and passes on a failed job", async () => {
    expect(errorOf(await tool({ path: "reference.mp4" }))).toContain("absolute");
    expect(errorOf(await tool({ start: 10, end: 5 }))).toContain("end must be after start");
    expect(errorOf(await tool({ target: { maxShot: 0 } }))).toContain("target.maxShot must be more than 0");
    expect(errorOf(await tool({ start: 70 }))).toContain("must be inside");
    jobs.runJob.mockResolvedValue({ error: "ffmpeg couldn't read it" });
    expect(errorOf(await tool({ path: "/m/broken.mp4" }))).toContain("ffmpeg couldn't read it");
  });
});
