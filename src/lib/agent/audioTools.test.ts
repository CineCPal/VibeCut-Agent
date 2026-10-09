import { beforeEach, describe, expect, it, vi } from "vitest";

const ipc = vi.hoisted(() => ({ nleCall: vi.fn() }));
vi.mock("../ipc", () => ipc);
const jobs = vi.hoisted(() => ({ runJob: vi.fn() }));
vi.mock("../jobs", () => jobs);

import { filePart, levelFor, soundBetween, soundClips } from "./audioTools";
import { executorsFor, runTool, type ToolContext } from "./tools";
import { emptyConnection, useConnectionStore } from "../../store/useConnectionStore";
import { useEditLogStore } from "../../store/useEditLogStore";
import type { HostClip, HostTimeline } from "../../types/timeline";

const clip = (id: string, start: number, end: number, over: Partial<HostClip> = {}): HostClip => ({
  id,
  name: `${id}.wav`,
  start,
  end,
  enabled: true,
  sourceIn: 5,
  filePath: `/m/${id}.wav`,
  ...over,
});

const VIEW: HostTimeline = {
  project: "Doc",
  timeline: "Main",
  fps: 25,
  startTimecode: "00:00:00:00",
  duration: 30,
  isCurrent: true,
  tracks: [
    { type: "video", index: 1, name: "", enabled: true, clips: [clip("v1", 0, 10, { linkedIds: ["d1"], filePath: "/m/v1.mov" })] },
    { type: "audio", index: 1, name: "", enabled: true, clips: [clip("d1", 0, 10, { linkedIds: ["v1"], volumeDb: -3 }), clip("d2", 10, 20, { enabled: false })] },
    { type: "audio", index: 2, name: "", enabled: true, clips: [clip("music", 0, 30, { sourceIn: 0, speed: 2 })] },
    { type: "audio", index: 3, name: "", enabled: false, clips: [clip("muted", 0, 30)] },
  ],
  markers: [],
};

const level = (lufs: number | null, peak: number | null = -6) => ({ integratedLufs: lufs, loudnessRange: 4, truePeakDb: peak, maxShortTermLufs: lufs === null ? null : lufs + 3 });

describe("which sound is measured", () => {
  it("maps a clip's timeline span to its file, through speed and reverse", () => {
    expect(filePart(clip("x", 2, 6))).toEqual({ from: 5, to: 9 });
    expect(filePart(clip("x", 2, 6), 3, 4)).toEqual({ from: 6, to: 7 });
    expect(filePart(clip("x", 2, 6, { speed: 2 }))).toEqual({ from: 5, to: 13 });
    expect(filePart(clip("x", 2, 6, { speed: -1, sourceIn: 10 }))).toEqual({ from: 6, to: 10 });
  });

  it("takes a picture's linked sound, and the heard clips in a range", () => {
    expect(soundClips(VIEW, ["v1"]).map((h) => h.clip.id)).toEqual(["d1"]);
    expect(() => soundClips(VIEW, ["nope"])).toThrow(/no clip nope/);
    // A clip that's off and a track that's off aren't heard.
    expect(soundBetween(VIEW, 8, 12).map((h) => [h.clip.id, h.from, h.to])).toEqual([
      ["d1", 13, 15],
      ["music", 16, 24],
    ]);
  });

  it("works out the level for a target, within the limits and under the peak", () => {
    expect(levelFor(level(-20, -10), -14, -1)).toEqual({ volumeDb: 6, reachedLufs: -14, peakLimited: false, capped: false });
    expect(levelFor(level(-20, -4), -14, -1)).toEqual({ volumeDb: 3, reachedLufs: -17, peakLimited: true, capped: false });
    expect(levelFor(level(-20, -4), -14, null)).toMatchObject({ volumeDb: 6, peakLimited: false });
    expect(levelFor(level(-50, -40), -14, -1)).toMatchObject({ volumeDb: 20, capped: true });
    expect(levelFor(level(null), -14, -1)).toBeNull();
  });
});

describe("the audio tools", () => {
  const context: ToolContext = { host: "resolve", timeline: "Main", step: "s1", stepText: "level it" };
  const sent = (command: string) => ipc.nleCall.mock.calls.filter((c) => c[1] === command).map((c) => c[2]);

  beforeEach(() => {
    vi.clearAllMocks();
    useEditLogStore.setState({ entries: [], backups: {}, restoredIds: { premiere: {}, resolve: {} } });
    useConnectionStore.setState({ connections: { premiere: emptyConnection("Doc"), resolve: emptyConnection("Doc") } });
    ipc.nleCall.mockImplementation(async (_h: string, command: string, args: { levels?: { itemId: string; volumeDb: number }[] }) => {
      if (command === "read_timeline") return VIEW;
      if (command === "backup_timeline") return { backup: "Main (before VibeCut 1)" };
      if (command === "set_clip_levels") return { changes: (args.levels ?? []).map((l) => ({ kind: "level", name: l.itemId, itemId: l.itemId, before: -3, after: l.volumeDb })), refused: [] };
      return {};
    });
  });

  it("measure_loudness reports each clip with its level", async () => {
    jobs.runJob.mockResolvedValue({ status: "done", result: { levels: [{ index: 0, ...level(-23.4) }] } });
    const outcome = await runTool(executorsFor(context), "measure_loudness", { clipIds: ["v1"] });
    expect(jobs.runJob.mock.calls[0][0]).toBe("media-loudness");
    expect(jobs.runJob.mock.calls[0][2]).toEqual({ ranges: [{ path: "/m/d1.wav", start: 5, end: 15 }] });
    expect(outcome.result).toMatchObject({ clips: [{ clipId: "d1", track: "A1", levelDb: -3, integratedLufs: -23.4, truePeakDb: -6 }] });
  });

  it("normalize_loudness sets levels through set_clip_levels, one backup", async () => {
    jobs.runJob.mockResolvedValue({ status: "done", result: { levels: [{ index: 0, ...level(-23.4, -10) }, { index: 1, ...level(-14, -2) }] } });
    const outcome = await runTool(executorsFor(context), "normalize_loudness", { clipIds: ["d1", "music"], targetLufs: -16 });
    expect(sent("set_clip_levels")).toEqual([{ timeline: "Main", levels: [{ itemId: "d1", volumeDb: 7.4 }, { itemId: "music", volumeDb: -2 }] }]);
    expect(outcome.summary).toMatch(/^Levelled 2 clip\(s\) to -16 LUFS/);
    expect(useEditLogStore.getState().entries).toHaveLength(1);
  });

  it("normalize_loudness refuses while a draft is open, and a silly target", async () => {
    const bad = await runTool(executorsFor(context), "normalize_loudness", { clipIds: ["d1"], targetLufs: 0 });
    expect((bad.result as { error: string }).error).toMatch(/between -40 and -5/);
    useConnectionStore.setState((s) => ({ connections: { ...s.connections, resolve: { ...s.connections.resolve, draft: { base: "Main", changes: ["x"] } as never } } }));
    const drafting = await runTool(executorsFor(context), "normalize_loudness", { clipIds: ["d1"] });
    expect((drafting.result as { error: string }).error).toMatch(/A draft of "Main" is open/);
  });

  it("find_beats maps the file's beats onto the timeline through the clip's speed", async () => {
    jobs.runJob.mockResolvedValue({ status: "done", result: { bpm: 60, confidence: 0.8, beats: [0.5, 1.5, 2.5, 60.5] } });
    const outcome = await runTool(executorsFor(context), "find_beats", { clipId: "music", end: 10 });
    // 2x speed: the file's first 20 s play in the timeline's first 10 s, at twice the tempo.
    expect(jobs.runJob.mock.calls[0][2]).toEqual({ path: "/m/music.wav", start: 0, end: 20 });
    expect(outcome.result).toMatchObject({ bpm: 120, beats: [0.25, 0.75, 1.25] });
  });
});
