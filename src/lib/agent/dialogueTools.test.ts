import { beforeEach, describe, expect, it, vi } from "vitest";

const ipc = vi.hoisted(() => ({ nleCall: vi.fn() }));
vi.mock("../ipc", () => ipc);
const jobs = vi.hoisted(() => ({ runJob: vi.fn() }));
vi.mock("../jobs", () => jobs);

import { roomToneGaps, soundClips } from "./dialogueTools";
import { executorsFor, runTool, type ToolContext } from "./tools";
import { emptyConnection, useConnectionStore } from "../../store/useConnectionStore";
import { useEditLogStore } from "../../store/useEditLogStore";
import type { HostClip, HostTimeline } from "../../types/timeline";

const clip = (id: string, start: number, end: number, over: Partial<HostClip> = {}): HostClip => ({ id, name: id, start, end, enabled: true, sourceIn: 10, sourceOut: 10 + end - start, filePath: "/m/int.mov", ...over });

/** An interview with its sound split into two channel clips (A1, A2), then a second shot. */
const VIEW: HostTimeline = {
  project: "Doc",
  timeline: "Main",
  fps: 25,
  startTimecode: "00:00:00:00",
  duration: 20,
  isCurrent: true,
  tracks: [
    { type: "video", index: 1, name: "", enabled: true, clips: [clip("v1", 0, 8, { linkedIds: ["a1", "a2"] }), clip("v2", 8, 20, { filePath: "/m/b.mov", sourceIn: 0, sourceOut: 12, linkedIds: ["a3"] })] },
    { type: "audio", index: 1, name: "", enabled: true, clips: [clip("a1", 0, 8, { channel: 1, volumeDb: -3, linkedIds: ["v1"] }), clip("a3", 8, 20, { filePath: "/m/b.mov", sourceIn: 0, sourceOut: 12, linkedIds: ["v2"] })] },
    { type: "audio", index: 2, name: "", enabled: true, clips: [clip("a2", 0, 8, { channel: 2, volumeDb: -3, linkedIds: ["v1"] })] },
  ],
  markers: [],
};

describe("which sound is cleaned", () => {
  it("takes a picture's linked sound, once per recording at a place", () => {
    expect(soundClips(VIEW.tracks, ["v1"]).map((c) => c.id)).toEqual(["a1"]);
    expect(soundClips(VIEW.tracks, ["a3", "v2"]).map((c) => c.id)).toEqual(["a3"]);
  });

  it("refuses unknown clips, sped-up sound, and sound already off", () => {
    expect(() => soundClips(VIEW.tracks, ["zz"])).toThrow("no clip zz");
    const fast = [{ type: "audio", clips: [clip("s", 0, 4, { speed: 2 })] }];
    expect(() => soundClips(fast, ["s"])).toThrow("speed change");
    const off = [{ type: "audio", clips: [clip("s", 0, 4, { enabled: false })] }];
    expect(() => soundClips(off, ["s"])).toThrow("already switched off");
  });
});

describe("clean_dialogue", () => {
  const context: ToolContext = { host: "resolve", timeline: "Main", step: "s1", stepText: "clean up the interview" };
  const sent = (command: string) => ipc.nleCall.mock.calls.filter((c) => c[1] === command).map((c) => c[2]);

  beforeEach(() => {
    vi.clearAllMocks();
    useEditLogStore.setState({ entries: [], backups: {}, restoredIds: { premiere: {}, resolve: {} } });
    useConnectionStore.setState({ connections: { premiere: emptyConnection("Doc"), resolve: emptyConnection("Doc") } });
    jobs.runJob.mockResolvedValue({
      status: "done",
      result: {
        files: [
          { path: "/m/int.mov", output: "/m/int.vca-clean-light.wav", duration: 60, reused: false },
          { path: "/m/b.mov", error: "the file has no sound" },
        ],
      },
    });
    ipc.nleCall.mockImplementation(async (_h: string, command: string, args: { clips?: { path: string; at: number }[]; itemIds?: string[] }) => {
      if (command === "read_timeline") return VIEW;
      if (command === "backup_timeline") return { backup: "Main (before VibeCut 1)" };
      if (command === "add_clips") return { changes: (args.clips ?? []).map((c, i) => ({ kind: "added", itemIds: [`n${i}`], name: c.path, at: c.at, tracks: ["A3"] })), refused: [], addedTracks: ["A3"] };
      if (command === "set_clips_enabled") return { changes: (args.itemIds ?? []).map((id) => ({ kind: "enabled", itemId: id })), refused: [] };
      return {};
    });
  });

  it("lays the cleaned sound under the clip and switches the original channels off, under one step", async () => {
    const out = await runTool(executorsFor(context), "clean_dialogue", { clipIds: ["v1", "v2"], strength: "light" });
    expect(jobs.runJob.mock.calls[0][0]).toBe("media-clean");
    expect(jobs.runJob.mock.calls[0][2]).toEqual({ paths: ["/m/int.mov", "/m/b.mov"], strength: "light" });
    expect((sent("add_clips")[0] as { clips: unknown[] }).clips).toEqual([
      { path: "/m/int.vca-clean-light.wav", at: 0, sourceIn: 10, sourceOut: 18, picture: false, sound: true, volumeDb: -3 },
    ]);
    expect(sent("set_clips_enabled")).toEqual([{ timeline: "Main", itemIds: ["a1", "a2"], enabled: false }]);
    expect(sent("backup_timeline")).toHaveLength(1);
    expect(new Set(useEditLogStore.getState().entries.map((e) => e.step))).toEqual(new Set(["s1"]));
    expect(out.summary).toBe("Cleaned the dialogue (light) of 1 clip(s): the cleaned sound is on A3 and the original switched off; 1 file(s) failed");
    expect(out.result).toMatchObject({ failed: ["b.mov: the file has no sound"], originalsSwitchedOff: ["a1", "a2"] });
  });

  it("switches nothing off when the cleaned sound couldn't be placed", async () => {
    ipc.nleCall.mockImplementation(async (_h: string, command: string) => {
      if (command === "read_timeline") return VIEW;
      if (command === "backup_timeline") return { backup: "b" };
      if (command === "add_clips") return { changes: [], refused: [{ clip: 0, reason: "Resolve didn't place it on A3" }] };
      return {};
    });
    const out = await runTool(executorsFor(context), "clean_dialogue", { clipIds: ["a1"] });
    expect(String((out.result as { error?: string }).error)).toContain("couldn't be placed: Resolve didn't place it on A3");
    expect(sent("set_clips_enabled")).toEqual([]);
  });

  it("is refused while a draft is open", async () => {
    useConnectionStore.getState().setDraft("resolve", { base: "Main", fps: 25, duration: 20, video: [], audio: [], markers: [], notCarried: [], changes: ["x"] });
    const out = await runTool(executorsFor(context), "clean_dialogue", { clipIds: ["a1"] });
    expect(String((out.result as { error?: string }).error)).toContain("A draft of");
    expect(jobs.runJob).not.toHaveBeenCalled();
  });
});

describe("where room tone goes", () => {
  /** Picture on V1 cut into three shots with holes at 4–5 s and 9–9.6 s, its stereo sound split into channel
   * clips on A1 and A2, and a 30 s hole before a last shot; music runs on A3 throughout. */
  const shot = (n: number, start: number, end: number, over: Partial<HostClip> = {}) => [
    clip(`v${n}`, start, end, { linkedIds: [`l${n}`, `r${n}`], ...over }),
    clip(`l${n}`, start, end, { channel: 1, linkedIds: [`v${n}`], ...over }),
    clip(`r${n}`, start, end, { channel: 2, linkedIds: [`v${n}`], ...over }),
  ];
  const shots = [shot(1, 0, 4), shot(2, 5, 9, { filePath: "/m/two.mov" }), shot(3, 9.6, 12), shot(4, 42, 44)];
  const TRACKS = [
    { type: "video" as const, index: 1, name: "", enabled: true, clips: shots.map((s) => s[0]) },
    { type: "audio" as const, index: 1, name: "", enabled: true, clips: shots.map((s) => s[1]) },
    { type: "audio" as const, index: 2, name: "", enabled: true, clips: shots.map((s) => s[2]) },
    { type: "audio" as const, index: 3, name: "", enabled: true, clips: [clip("m", 0, 44, { filePath: "/m/music.wav" })] },
  ];
  const options = { minSeconds: 0, maxSeconds: 10 };

  it("fills each hole on every dialogue track, from the clip it follows, and leaves long ones", () => {
    const plan = roomToneGaps(TRACKS, 25, options);
    expect(plan.tracks).toEqual([1, 2]);
    expect(plan.gaps.map((g) => [g.start, g.end, g.fills.map((f) => `${f.track}:${f.clip.id}`)])).toEqual([
      [4, 5, ["1:l1", "2:r1"]],
      [9, 9.6, ["1:l2", "2:r2"]],
    ]);
    expect(plan.long).toEqual([{ start: 12, end: 42 }]);
  });

  it("doesn't count a hole one track covers, and keeps to start, end and minSeconds", () => {
    const covered = TRACKS.map((t) => (t.index === 2 && t.type === "audio" ? { ...t, clips: [...t.clips, clip("fill", 4, 5)] } : t));
    expect(roomToneGaps(covered, 25, options).gaps.map((g) => g.start)).toEqual([9]);
    expect(roomToneGaps(TRACKS, 25, { ...options, minSeconds: 0.7 }).gaps.map((g) => g.start)).toEqual([4]);
    // A range starting inside a hole fills from there, from the clips after it.
    const late = roomToneGaps(TRACKS, 25, { ...options, start: 9.2, maxSeconds: 60 });
    expect(late.gaps.map((g) => [g.start, g.end, g.fills.map((f) => f.clip.id)])).toEqual([
      [9.2, 9.6, ["l3", "r3"]],
      [12, 42, ["l3", "r3"]],
    ]);
  });

  it("needs tracks when no sound is linked to a picture, and names a track that isn't there", () => {
    const loose = TRACKS.filter((t) => t.type === "audio").map((t) => ({ ...t, clips: t.clips.map((c) => ({ ...c, linkedIds: [] })) }));
    expect(() => roomToneGaps(loose, 25, options)).toThrow("give tracks");
    expect(roomToneGaps(loose, 25, { ...options, tracks: [1] }).gaps).toHaveLength(2);
    expect(() => roomToneGaps(TRACKS, 25, { ...options, tracks: [7] })).toThrow("no audio track A7");
  });
});

describe("fill_room_tone", () => {
  const context: ToolContext = { host: "resolve", timeline: "Main", step: "s2", stepText: "fill the holes" };
  const sent = (command: string) => ipc.nleCall.mock.calls.filter((c) => c[1] === command).map((c) => c[2]);
  /** Two shots of one recording with holes at 8–9 s and 15–15.6 s on A1, its level -3 dB. */
  const HOLES: HostTimeline = {
    ...VIEW,
    tracks: [
      { type: "video", index: 1, name: "", enabled: true, clips: [clip("v1", 0, 8, { linkedIds: ["a1"] }), clip("v2", 9, 15, { sourceIn: 40, sourceOut: 46, linkedIds: ["a2"] }), clip("v3", 15.6, 20, { sourceIn: 50, sourceOut: 54.4, linkedIds: ["a3"] })] },
      { type: "audio", index: 1, name: "", enabled: true, clips: [clip("a1", 0, 8, { volumeDb: -3, linkedIds: ["v1"] }), clip("a2", 9, 15, { sourceIn: 40, sourceOut: 46, linkedIds: ["v2"] }), clip("a3", 15.6, 20, { sourceIn: 50, sourceOut: 54.4, linkedIds: ["v3"] })] },
    ],
  };

  beforeEach(() => {
    vi.clearAllMocks();
    useEditLogStore.setState({ entries: [], backups: {}, restoredIds: { premiere: {}, resolve: {} } });
    useConnectionStore.setState({ connections: { premiere: emptyConnection("Doc"), resolve: emptyConnection("Doc") } });
    jobs.runJob.mockResolvedValue({
      status: "done",
      result: { files: [{ path: "/m/int.mov", output: "/r/Doc/Room tone/int room tone ab12.wav", duration: 4, sample: { start: 47.2, seconds: 2 }, levelDb: -52, contrastDb: 28, quiet: true, reused: false }] },
    });
    ipc.nleCall.mockImplementation(async (_h: string, command: string, args: { clips?: { path: string; at: number; audioTrack?: number }[] }) => {
      if (command === "read_timeline") return HOLES;
      if (command === "backup_timeline") return { backup: "Main (before VibeCut 2)" };
      if (command === "add_clips") return { changes: (args.clips ?? []).map((c, i) => ({ kind: "added", itemIds: [`t${i}`], name: c.path, at: c.at, tracks: [`A${c.audioTrack}`] })), refused: [] };
      return {};
    });
  });

  it("makes one room tone per recording and lays it in each hole on the dialogue's own track, under one step", async () => {
    const out = await runTool(executorsFor(context), "fill_room_tone", {});
    expect(jobs.runJob.mock.calls[0][0]).toBe("media-roomtone");
    expect(jobs.runJob.mock.calls[0][2]).toEqual({ sources: [{ path: "/m/int.mov", start: 0, end: 76, seconds: 4 }], project: "Doc" });
    expect((sent("add_clips")[0] as { clips: unknown[] }).clips).toEqual([
      { path: "/r/Doc/Room tone/int room tone ab12.wav", at: 8, sourceIn: 0, sourceOut: 1, audioTrack: 1, picture: false, sound: true, volumeDb: -3 },
      // The second hole starts further into the room tone, so the two don't repeat each other.
      { path: "/r/Doc/Room tone/int room tone ab12.wav", at: 15, sourceIn: 1.68, sourceOut: 2.28, audioTrack: 1, picture: false, sound: true },
    ]);
    expect(sent("backup_timeline")).toHaveLength(1);
    expect(new Set(useEditLogStore.getState().entries.map((e) => e.step))).toEqual(new Set(["s2"]));
    expect(out.summary).toBe("Filled 2 hole(s) in the dialogue with room tone (1.6 s on A1)");
  });

  it("uses a given room tone recording for every hole, and says when a recording had no clear pause", async () => {
    jobs.runJob.mockResolvedValue({ status: "done", result: { files: [{ path: "/m/tone.wav", output: "/r/tone room tone 1.wav", duration: 5, quiet: false, contrastDb: 4 }] } });
    const out = await runTool(executorsFor(context), "fill_room_tone", { path: "/m/tone.wav", tracks: [1] });
    expect(jobs.runJob.mock.calls[0][2]).toEqual({ sources: [{ path: "/m/tone.wav", seconds: 4 }], project: "Doc" });
    expect((sent("add_clips")[0] as { clips: { path: string }[] }).clips.map((c) => c.path)).toEqual(["/r/tone room tone 1.wav", "/r/tone room tone 1.wav"]);
    expect(out.summary).toContain("tone.wav had no clear pause, so check by ear");
  });

  it("changes nothing when there are no holes, and is refused while a draft is open", async () => {
    ipc.nleCall.mockImplementation(async (_h: string, command: string) => (command === "read_timeline" ? VIEW : {}));
    const out = await runTool(executorsFor(context), "fill_room_tone", { maxSeconds: 5 });
    expect(out.summary).toBe("There are no holes to fill in the dialogue on A1, A2");
    expect(jobs.runJob).not.toHaveBeenCalled();
    expect(sent("add_clips")).toEqual([]);

    useConnectionStore.getState().setDraft("resolve", { base: "Main", fps: 25, duration: 20, video: [], audio: [], markers: [], notCarried: [], changes: ["x"] });
    const refused = await runTool(executorsFor(context), "fill_room_tone", {});
    expect(String((refused.result as { error?: string }).error)).toContain("A draft of");
  });

  it("reports a recording it couldn't make room tone from", async () => {
    jobs.runJob.mockResolvedValue({ status: "done", result: { files: [{ path: "/m/int.mov", error: "no stretch of room tone in it: it's too short, or silent throughout" }] } });
    const out = await runTool(executorsFor(context), "fill_room_tone", {});
    expect(String((out.result as { error?: string }).error)).toContain("int.mov: no stretch of room tone");
    expect(sent("add_clips")).toEqual([]);
  });
});
