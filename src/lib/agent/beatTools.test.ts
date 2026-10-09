import { beforeEach, describe, expect, it, vi } from "vitest";

const ipc = vi.hoisted(() => ({ nleCall: vi.fn() }));
vi.mock("../ipc", () => ipc);
const jobs = vi.hoisted(() => ({ runJob: vi.fn() }));
vi.mock("../jobs", () => jobs);

import { beatSlots, fillSlots, freeVideoTrack, MAX_SLOTS } from "./beatTools";
import { forgetMediaFacts } from "./mediaInfo";
import { executorsFor, runTool, type ToolContext } from "./tools";
import { emptyConnection, useConnectionStore } from "../../store/useConnectionStore";
import { useEditLogStore } from "../../store/useEditLogStore";
import type { HostClip, HostTimeline } from "../../types/timeline";

const clip = (id: string, start: number, end: number, over: Partial<HostClip> = {}): HostClip => ({ id, name: id, start, end, enabled: true, sourceIn: 0, filePath: `/m/${id}.mov`, ...over });

const VIEW: HostTimeline = {
  project: "Doc",
  timeline: "Main",
  fps: 25,
  startTimecode: "00:00:00:00",
  duration: 40,
  isCurrent: true,
  tracks: [
    { type: "video", index: 1, name: "", enabled: true, clips: [clip("int", 0, 40)] },
    { type: "video", index: 2, name: "", enabled: true, clips: [clip("logo", 30, 32)] },
    { type: "audio", index: 1, name: "", enabled: true, clips: [clip("song", 2, 34, { filePath: "/m/song.wav", sourceIn: 10 })] },
  ],
  markers: [],
};

describe("slots between the beats", () => {
  const beats = [0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5];

  it("cuts every Nth beat and closes the last slot N beats on, or at the end", () => {
    expect(beatSlots(beats, 2, 10, 25)).toEqual([
      { start: 0, end: 1 },
      { start: 1, end: 2 },
      { start: 2, end: 3 },
      { start: 3, end: 4 },
    ]);
    expect(beatSlots(beats, 4, 3.6, 25)).toEqual([
      { start: 0, end: 2 },
      { start: 2, end: 3.6 },
    ]);
    expect(beatSlots(beats, 1, 10, 25)).toHaveLength(8);
  });

  it("snaps to frames, moves cuts by an offset, and drops slivers", () => {
    const slots = beatSlots([1.013, 1.517, 2.021], 1, 2.03, 25, -0.04);
    // 0.973 → 0.96, 1.477 → 1.48, 1.981 → 2.0; the last slot would close at the end, 2.03 → 2.04: a
    // one-frame sliver, so dropped.
    expect(slots).toEqual([
      { start: 0.96, end: 1.48 },
      { start: 1.48, end: 2 },
    ]);
  });
});

describe("filling the slots", () => {
  const slots = [
    { start: 0, end: 2 },
    { start: 2, end: 4 },
    { start: 4, end: 6 },
    { start: 6, end: 9 },
  ];

  it("takes the shots in turn, each moving on through its range and starting again once it runs out", () => {
    const { placed, empty } = fillSlots(slots, [
      { path: "/a", name: "a", from: 10, to: 15 },
      { path: "/b", name: "b", from: 0, to: 4 },
    ]);
    expect(placed).toEqual([
      { shot: 0, at: 0, sourceIn: 10, sourceOut: 12 },
      { shot: 1, at: 2, sourceIn: 0, sourceOut: 2 },
      { shot: 0, at: 4, sourceIn: 12, sourceOut: 14 },
      // b has 2 s left and the slot is 3 s, so b starts again; a's 1 s is too short.
      { shot: 1, at: 6, sourceIn: 0, sourceOut: 3 },
    ]);
    expect(empty).toEqual([]);
  });

  it("passes over a shot too short for a slot, and leaves a slot nothing fits", () => {
    const { placed, empty } = fillSlots(slots, [{ path: "/s", name: "s", from: 0, to: 2.5 }]);
    expect(placed.map((p) => p.at)).toEqual([0, 2, 4]);
    expect(empty).toEqual([{ start: 6, end: 9 }]);
  });

  it("finds a video track that's empty over the stretch", () => {
    expect(freeVideoTrack(VIEW, 2, 20)).toBe(2);
    expect(freeVideoTrack(VIEW, 2, 31)).toBeNull();
  });
});

describe("cut_to_beats", () => {
  const context: ToolContext = { host: "resolve", timeline: "Main", step: "s1", stepText: "cut it to the music" };
  const sent = (command: string) => ipc.nleCall.mock.calls.filter((c) => c[1] === command).map((c) => c[2]);
  let fileBeats: number[];

  beforeEach(() => {
    vi.clearAllMocks();
    forgetMediaFacts();
    useEditLogStore.setState({ entries: [], backups: {}, restoredIds: { premiere: {}, resolve: {} } });
    useConnectionStore.setState({ connections: { premiere: emptyConnection("Doc"), resolve: emptyConnection("Doc") } });
    useConnectionStore.getState().setPool("resolve", {
      project: "Doc",
      bins: [],
      clips: [{ id: "000a1", name: "Waves", bin: "Master", type: "Video", duration: 20, filePath: "/m/waves.mov", usage: 0, markIn: 2, markOut: 8 }],
    } as never);
    // 120 BPM in the file, from 10 s (the clip's source in): timeline 2 s on.
    fileBeats = Array.from({ length: 64 }, (_, i) => 10 + i * 0.5);
    jobs.runJob.mockImplementation(async (command: string, _label: string, request: { paths?: string[] }) => {
      if (command === "media-beats") return { status: "done", result: { bpm: 120, confidence: 0.86, beats: fileBeats } };
      if (command === "media-info") return { status: "done", result: { info: Object.fromEntries((request.paths ?? []).map((path) => [path, { duration: 30, video: null, audio: null }])) } };
      throw new Error(`unexpected job ${command}`);
    });
    ipc.nleCall.mockImplementation(async (_h: string, command: string, args: { clips?: { path: string; at: number }[] }) => {
      if (command === "read_timeline") return VIEW;
      if (command === "backup_timeline") return { backup: "Main (before VibeCut 1)" };
      if (command === "add_clips") return { changes: (args.clips ?? []).map((c, i) => ({ kind: "add", itemId: `new${i}`, name: c.path, at: c.at, tracks: ["V2"] })), refused: [] };
      if (command === "add_track") return { changes: [{ kind: "track", name: "V3" }], refused: [], addedTracks: ["V3"] };
      return {};
    });
  });

  it("lays the shots on the beats as picture only, on a free track, under one backup and one step", async () => {
    const out = await runTool(executorsFor(context), "cut_to_beats", {
      musicClipId: "song",
      shots: [{ clipId: "p1" }, { filePath: "/m/city.mov", sourceIn: 1, sourceOut: 9 }],
      start: 2,
      end: 10,
      everyBeats: 4,
    });
    expect(out.summary).toMatch(/^Cut 4 shot\(s\) to the beat of "song" \(120 BPM, a cut every 4 beats\) on V2, 2\.0s–10\.0s/);
    const [request] = sent("add_clips") as { clips: Record<string, unknown>[] }[];
    expect(request.clips).toEqual([
      // The pool clip's marked In–Out (2–8 s), then the file's given range, in turn.
      { path: "/m/waves.mov", at: 2, sourceIn: 2, sourceOut: 4, videoTrack: 2, picture: true, sound: false },
      { path: "/m/city.mov", at: 4, sourceIn: 1, sourceOut: 3, videoTrack: 2, picture: true, sound: false },
      { path: "/m/waves.mov", at: 6, sourceIn: 4, sourceOut: 6, videoTrack: 2, picture: true, sound: false },
      { path: "/m/city.mov", at: 8, sourceIn: 3, sourceOut: 5, videoTrack: 2, picture: true, sound: false },
    ]);
    expect(sent("backup_timeline")).toHaveLength(1);
    expect(sent("add_track")).toEqual([]);
    expect(new Set(useEditLogStore.getState().entries.map((e) => e.step))).toEqual(new Set(["s1"]));
    expect(out.result).toMatchObject({ bpm: 120, everyBeats: 4, videoTrack: 2, cuts: [2, 4, 6, 8] });
  });

  it("adds a track at the top when none is free, and batches many shots under the same step", async () => {
    const out = await runTool(executorsFor(context), "cut_to_beats", { musicClipId: "song", shots: [{ filePath: "/m/city.mov" }], everyBeats: 1 });
    expect(sent("add_track")).toEqual([{ timeline: "Main", type: "video", count: 1 }]);
    const batches = sent("add_clips") as { clips: { videoTrack: number }[] }[];
    // 2–34 s at a beat every 0.5 s: 64 shots, in two batches, all on the new V3.
    expect(batches.map((b) => b.clips.length)).toEqual([50, 14]);
    expect(batches.flatMap((b) => b.clips).every((c) => c.videoTrack === 3)).toBe(true);
    expect(sent("backup_timeline")).toHaveLength(1);
    expect(useEditLogStore.getState().entries.every((e) => e.step === "s1")).toBe(true);
    expect(out.result).toMatchObject({ newTrack: "V3" });
  });

  it("follows the music's speed onto the timeline", async () => {
    const fast: HostTimeline = { ...VIEW, tracks: VIEW.tracks.map((t) => (t.type === "audio" ? { ...t, clips: [clip("song", 2, 18, { filePath: "/m/song.wav", sourceIn: 10, speed: 2 })] } : t)) };
    ipc.nleCall.mockImplementation(async (_h: string, command: string, args: { clips?: { at: number }[] }) => {
      if (command === "read_timeline") return fast;
      if (command === "backup_timeline") return { backup: "b" };
      if (command === "add_clips") return { changes: (args.clips ?? []).map(() => ({ kind: "add" })), refused: [] };
      return {};
    });
    const out = await runTool(executorsFor(context), "cut_to_beats", { musicClipId: "song", shots: [{ filePath: "/m/city.mov" }], start: 2, end: 6, everyBeats: 2 });
    // Beats every 0.5 s of the file play every 0.25 s at 2×: a cut every 2 beats is every 0.5 s.
    // (Snapped to 25 fps frames: 2.5 s is half a frame, so it goes to 2.52.)
    expect((out.result as { cuts: number[]; bpm: number }).cuts).toEqual([2, 2.52, 3, 3.52, 4, 4.52, 5, 5.52]);
    expect((out.result as { bpm: number }).bpm).toBe(240);
  });

  it("refuses with no steady beat, while drafting, too many shots, and a bad step", async () => {
    jobs.runJob.mockImplementation(async (command: string) => (command === "media-beats" ? { status: "done", result: { bpm: 97, confidence: 0.12, beats: fileBeats } } : { status: "done", result: { files: [] } }));
    const flat = await runTool(executorsFor(context), "cut_to_beats", { musicClipId: "song", shots: [{ filePath: "/m/city.mov", sourceOut: 9 }] });
    expect((flat.result as { error: string }).error).toMatch(/no steady beat .*confidence 0\.12/);
    expect(sent("add_clips")).toEqual([]);

    fileBeats = Array.from({ length: MAX_SLOTS + 10 }, (_, i) => 10 + i * 0.1);
    jobs.runJob.mockImplementation(async () => ({ status: "done", result: { bpm: 600, confidence: 0.9, beats: fileBeats } }));
    const many = await runTool(executorsFor(context), "cut_to_beats", { musicClipId: "song", shots: [{ filePath: "/m/city.mov", sourceOut: 9 }], everyBeats: 1 });
    expect((many.result as { error: string }).error).toMatch(/at most 150 per call/);

    const step = await runTool(executorsFor(context), "cut_to_beats", { musicClipId: "song", shots: [{ filePath: "/m/city.mov" }], everyBeats: 3 });
    expect((step.result as { error: string }).error).toMatch(/everyBeats must be 1, 2, 4 or 8/);

    useConnectionStore.setState((s) => ({ connections: { ...s.connections, resolve: { ...s.connections.resolve, draft: { base: "Main", changes: ["x"] } as never } } }));
    const drafting = await runTool(executorsFor(context), "cut_to_beats", { musicClipId: "song", shots: [{ filePath: "/m/city.mov" }] });
    expect((drafting.result as { error: string }).error).toMatch(/A draft of "Main" is open/);
  });
});
