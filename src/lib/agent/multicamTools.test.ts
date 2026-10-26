import { beforeEach, describe, expect, it, vi } from "vitest";

const ipc = vi.hoisted(() => ({ nleCall: vi.fn(), startSidecar: vi.fn(), cancelSidecar: vi.fn() }));
vi.mock("../ipc", () => ipc);
const core = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ ...core, convertFileSrc: (p: string) => p }));
const jobs = vi.hoisted(() => ({ runJob: vi.fn() }));
vi.mock("../jobs", () => jobs);

import { type Angle, applyShots, levelActivity, planShots, RATE, speakerActivity, type PlanOptions } from "./multicamTools";
import { executorsFor, runTool, type ToolContext } from "./tools";
import { emptyConnection, useConnectionStore } from "../../store/useConnectionStore";
import { initialHosts, useNleStateStore } from "../../store/useNleStateStore";
import { nleState } from "../../test/nleFixtures";
import type { HostDraft } from "../../vibecut/lib/connect/hostDraft";
import type { HostClip, HostTimeline } from "../../types/timeline";
import type { TranscriptData } from "../../vibecut/types/transcript";

const ANGLES: Angle[] = [
  { track: 1, speakers: ["ana"], mics: ["/m/ana.wav"] },
  { track: 2, speakers: ["ben"], mics: ["/m/ben.wav"] },
];

/** Every track covered for `seconds`. */
const covered = (seconds: number, tracks = [1, 2, 3]) => Array.from({ length: seconds * RATE }, () => new Set(tracks));
const options = (over: Partial<PlanOptions> = {}): PlanOptions => ({
  from: 0,
  fps: 25,
  coverage: covered(60),
  minShotSeconds: 2,
  leadFrames: 0,
  cutaway: "none",
  maxShotSeconds: 12,
  cutawaySeconds: 2.5,
  ...over,
});
const turn = (start: number, end: number, speaker: string) => ({ start, end, speaker, file: "/m/mix.wav" });
const brief = (shots: { start: number; end: number; track: number }[]) => shots.map((s) => [s.start, s.end, s.track]);

describe("who is talking", () => {
  it("maps transcript lines to the angle of their speaker", () => {
    const activity = speakerActivity([turn(0, 1, "Ana"), turn(0.5, 2, "Ben"), turn(1, 2, "Cal")], ANGLES, 0, 2);
    expect(activity).toHaveLength(20);
    expect(activity[0]).toEqual([0]);
    expect(activity[7]).toEqual([0, 1]);
    expect(activity[15]).toEqual([1]);
  });

  it("maps a line to the angle of its mic when the angle names no speakers", () => {
    const angles = [{ track: 1, speakers: [], mics: ["/m/ana.wav"] }, ANGLES[1]];
    expect(speakerActivity([{ start: 0, end: 1, speaker: "SPEAKER_00", file: "/m/ana.wav" }], angles, 0, 1)[3]).toEqual([0]);
  });

  it("picks the loudest mic, and both when they're within a few dB", () => {
    const quiet = -Infinity;
    const levels = [
      [-20, -20, -20, -30, quiet],
      [-35, -22, quiet, -20, quiet],
    ];
    expect(levelActivity(levels, -40, 4, 0)).toEqual([[0], [0, 1], [0], [1], []]);
  });
});

describe("planning the shots", () => {
  it("cuts on each change of speaker and holds through the pauses", () => {
    const activity = speakerActivity([turn(0, 5, "Ana"), turn(6, 10, "Ben"), turn(13, 20, "Ana")], ANGLES, 0, 20);
    expect(brief(planShots(activity, ANGLES, options()))).toEqual([
      [0, 6, 1],
      [6, 13, 2],
      [13, 20, 1],
    ]);
  });

  it("folds a short interjection into the shot before", () => {
    const activity = speakerActivity([turn(0, 8, "Ana"), turn(8, 8.6, "Ben"), turn(8.6, 16, "Ana")], ANGLES, 0, 16);
    expect(brief(planShots(activity, ANGLES, options()))).toEqual([[0, 16, 1]]);
  });

  it("cuts a few frames before the words", () => {
    const activity = speakerActivity([turn(0, 5, "Ana"), turn(6, 10, "Ben")], ANGLES, 0, 10);
    expect(brief(planShots(activity, ANGLES, options({ leadFrames: 5 })))).toEqual([
      [0, 5.8, 1],
      [5.8, 10, 2],
    ]);
  });

  it("goes to the wide when both talk, and never to an angle with no picture", () => {
    const both = speakerActivity([turn(0, 10, "Ana"), turn(4, 10, "Ben")], ANGLES, 0, 10);
    expect(brief(planShots(both, ANGLES, options({ wideTrack: 3 })))).toEqual([
      [0, 4, 1],
      [4, 10, 3],
    ]);
    // Ben's camera stopped at 5 s: his line after it stays on Ana.
    const coverage = covered(10).map((s, i) => (i >= 50 ? new Set([1]) : s));
    const late = speakerActivity([turn(0, 3, "Ana"), turn(6, 10, "Ben")], ANGLES, 0, 10);
    expect(brief(planShots(late, ANGLES, options({ coverage })))).toEqual([[0, 10, 1]]);
  });

  it("breaks a long shot with cutaways to the wide or the listener", () => {
    const activity = speakerActivity([turn(0, 4, "Ben"), turn(4, 34, "Ana")], ANGLES, 0, 34);
    const wide = planShots(activity, ANGLES, options({ cutaway: "wide", wideTrack: 3 }));
    expect(wide.map((s) => s.track)).toEqual([2, 1, 3, 1, 3, 1]);
    // Two cutaways of 2.5 s, evenly spaced through Ana's 30 s, on whole frames.
    for (const s of wide) expect(Math.abs(s.start * 25 - Math.round(s.start * 25))).toBeLessThan(1e-6);
    expect(wide.filter((s) => s.reason === "cutaway").map((s) => [Math.round(s.start), Math.round(s.end - s.start)])).toEqual([
      [13, 3],
      [23, 3],
    ]);
    const listener = planShots(activity, ANGLES, options({ cutaway: "listener" }));
    expect(listener.filter((s) => s.reason === "cutaway").map((s) => s.track)).toEqual([2, 2]);
  });
});

const draftClip = (sourcePath: string, start: number, end: number, sourceIn = 0) => ({
  sourcePath,
  sourceName: sourcePath.slice(3),
  start,
  end,
  sourceIn,
  sourceOut: sourceIn + end - start,
  speed: 1,
  enabled: true,
  volumeDb: null,
});

const DRAFT: HostDraft = {
  base: "Pod",
  fps: 25,
  duration: 20,
  video: [
    { type: "video", clips: [draftClip("/m/camA.mov", 0, 20, 100)] },
    { type: "video", clips: [draftClip("/m/camB.mov", 0, 20)] },
    { type: "video", clips: [draftClip("/m/logo.png", 0, 3)] },
  ],
  audio: [
    { type: "audio", clips: [draftClip("/m/ana.wav", 0, 20)] },
    { type: "audio", clips: [draftClip("/m/ben.wav", 0, 20)] },
  ],
  markers: [],
  notCarried: [],
  changes: [],
};

describe("applying the shots", () => {
  it("cuts each angle at its shots' edges and switches it off between, leaving other tracks alone", () => {
    const shots = [
      { start: 0, end: 6, track: 1, reason: "speaker" as const },
      { start: 6, end: 13, track: 2, reason: "speaker" as const },
      { start: 13, end: 20, track: 1, reason: "speaker" as const },
    ];
    const next = applyShots(DRAFT, shots, [1, 2], 0, 20, "cut");
    const state = (track: number) => next.video[track].clips.map((c) => [c.start, c.end, c.sourceIn, c.enabled]);
    expect(state(0)).toEqual([
      [0, 6, 100, true],
      [6, 13, 106, false],
      [13, 20, 113, true],
    ]);
    expect(state(1)).toEqual([
      [0, 6, 0, false],
      [6, 13, 6, true],
      [13, 20, 13, false],
    ]);
    expect(next.video[2]).toBe(DRAFT.video[2]);
    expect(next.audio).toBe(DRAFT.audio);
    expect(next.changes).toEqual(["cut"]);
  });

  it("leaves what's outside the range as it was", () => {
    const next = applyShots(DRAFT, [{ start: 10, end: 20, track: 2, reason: "speaker" }], [1, 2], 10, 20, "cut");
    expect(next.video[0].clips.map((c) => [c.start, c.end, c.enabled])).toEqual([
      [0, 10, true],
      [10, 20, false],
    ]);
  });
});

// ----------------------------------------------------------------------------- the tool

const hclip = (id: string, start: number, end: number, filePath: string, over: Partial<HostClip> = {}): HostClip => ({ id, name: id, start, end, enabled: true, sourceIn: 0, filePath, ...over });
const TIMELINE: HostTimeline = {
  project: "Pod",
  timeline: "Main",
  fps: 25,
  startTimecode: "00:00:00:00",
  duration: 20,
  isCurrent: true,
  tracks: [
    { type: "video", index: 1, name: "", enabled: true, clips: [hclip("va", 0, 20, "/m/camA.mov")] },
    { type: "video", index: 2, name: "", enabled: true, clips: [hclip("vb", 0, 20, "/m/camB.mov")] },
    { type: "audio", index: 1, name: "", enabled: true, clips: [hclip("aa", 0, 20, "/m/ana.wav")] },
    { type: "audio", index: 2, name: "", enabled: true, clips: [hclip("ab", 0, 20, "/m/ben.wav")] },
  ],
  markers: [],
};

/** Peaks at 10 per second, loud (0.3) where `loud` says, else near silence. */
const peaks = (loud: (t: number) => boolean) => {
  const maxes = Array.from({ length: 200 }, (_, i) => (loud(i / 10) ? 0.3 : 0.001));
  return { peaksPerSecond: 10, maxes, mins: maxes.map((m) => -m) };
};

const ctx: ToolContext = { host: "resolve", timeline: "Main", step: "s1", stepText: "cut the podcast by speaker" };
const run = (args: Record<string, unknown>) => runTool(executorsFor(ctx), "cut_by_speaker", args);

describe("cut_by_speaker", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useConnectionStore.setState({ connections: { premiere: emptyConnection("Pod"), resolve: emptyConnection("Pod") } });
    useNleStateStore.setState({ hosts: { ...initialHosts(), resolve: nleState("resolve") } });
    ipc.nleCall.mockResolvedValue(TIMELINE);
  });

  it("cuts by the loudest mic into the draft", async () => {
    jobs.runJob.mockResolvedValue({ result: { peaks: { "/m/ana.wav": peaks((t) => t < 8), "/m/ben.wav": peaks((t) => t >= 8) } } });
    const out = await run({ angles: [{ track: 1, mic: "aa" }, { track: 2, mic: "ab" }], leadFrames: 0, cutaway: "none" });
    expect(jobs.runJob.mock.calls[0][0]).toBe("audio-peaks");
    const result = out.result as { by: string; shots: number; screenTime: Record<string, number> };
    expect(result.by).toBe("loudness");
    expect(result.shots).toBe(2);
    const draft = useConnectionStore.getState().connections.resolve.draft!;
    // The switch lands within a few frames of 8 s (the levels are smoothed over half a second).
    const [a, b] = [draft.video[0].clips, draft.video[1].clips];
    expect(a.map((c) => c.enabled)).toEqual([true, false]);
    expect(b.map((c) => c.enabled)).toEqual([false, true]);
    expect(a[0].end).toBeCloseTo(8, 0);
    expect(b[1].start).toBe(a[0].end);
    expect(draft.changes[0]).toContain("Cut 2 angles by who's loudest");
  });

  it("cuts by the transcript's speakers", async () => {
    const transcript: TranscriptData = {
      segments: [
        { start: 0, end: 9, text: "Welcome to the show.", speaker: "Speaker 1" },
        { start: 10, end: 20, text: "Thanks for having me.", speaker: "Speaker 2" },
      ],
      speakers: ["Speaker 1", "Speaker 2"],
      speakerLabels: {},
      excludedSpeakers: [],
    };
    core.invoke.mockImplementation(async (cmd: string, a: { mediaPath: string }) => (cmd === "read_transcript" && a.mediaPath === "/m/ana.wav" ? transcript : null));
    const out = await run({ angles: [{ track: 1, speakers: ["Speaker 1"] }, { track: 2, speakers: ["Speaker 2"] }], leadFrames: 0, cutaway: "none" });
    expect((out.result as { by: string }).by).toBe("transcript");
    const draft = useConnectionStore.getState().connections.resolve.draft!;
    expect(draft.video[1].clips.map((c) => [c.start, c.enabled])).toEqual([
      [0, false],
      [10, true],
    ]);
    expect(out.summary).toContain("not transcribed: ben.wav");
  });

  it("refuses unknown speakers, one angle, and a wide that's also an angle", async () => {
    const error = async (args: Record<string, unknown>) => String(((await run(args)).result as { error?: unknown }).error);
    expect(await error({ angles: [{ track: 1, mic: "aa" }] })).toContain("at least two angles");
    expect(await error({ angles: [{ track: 1, mic: "aa" }, { track: 2, mic: "ab" }], wideTrack: 2 })).toContain("both an angle and the wide");
    expect(await error({ angles: [{ track: 1, mic: "aa" }, { track: 5, mic: "ab" }] })).toContain("from 1 to 2");
  });
});
