import { beforeEach, describe, expect, it, vi } from "vitest";

const ipc = vi.hoisted(() => ({ nleCall: vi.fn() }));
vi.mock("../ipc", () => ipc);

import { dipsWithin, duckMusic, speechSpans } from "./duck";
import { useEditLogStore } from "../../store/useEditLogStore";
import type { HostClip, HostTimeline } from "../../types/timeline";

const timeline = (music: HostClip[]): HostTimeline => ({
  project: "Doc",
  timeline: "Main",
  fps: 25,
  startTimecode: "00:00:00:00",
  duration: 30,
  isCurrent: true,
  tracks: [
    { type: "audio", index: 1, name: "Dialogue", enabled: true, clips: [{ id: "d1", name: "Int.wav", start: 2, end: 6, enabled: true }, { id: "d2", name: "Int.wav", start: 6.5, end: 9, enabled: true }] },
    { type: "audio", index: 2, name: "Music", enabled: true, clips: music },
  ],
  markers: [],
});

describe("duck_music", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useEditLogStore.setState({ entries: [], backups: {}, restoredIds: { premiere: {}, resolve: {} } });
  });

  it("joins dialogue into spans and keeps dips clear of the clip's edges", () => {
    expect(speechSpans([{ start: 6.5, end: 9 }, { start: 2, end: 6 }], 0.2, 0.4, 1)).toEqual([{ start: 1.8, end: 9.4 }]);
    expect(speechSpans([{ start: 2, end: 3 }, { start: 8, end: 9 }], 0, 0, 1)).toEqual([{ start: 2, end: 3 }, { start: 8, end: 9 }]);
    expect(dipsWithin([{ start: 0, end: 3 }, { start: 3.4, end: 5 }, { start: 9.9, end: 20 }], 0, 10, 0.3, 0.04)).toEqual([{ start: 0.3, end: 5 }]);
  });

  it("keyframes Premiere's music under where the dialogue clips sit", async () => {
    ipc.nleCall.mockImplementation(async (_h: string, command: string) => {
      if (command === "read_timeline") return timeline([{ id: "m1", name: "Song.wav", start: 0, end: 20, enabled: true }]);
      if (command === "backup_timeline") return { backup: "B" };
      return { changes: [{ kind: "duck", name: "Song.wav", itemId: "m1", spans: 1, duckDb: -12 }], refused: [] };
    });
    const outcome = await duckMusic({ host: "premiere", timeline: "Main", step: "m", stepText: "" }, { musicClipIds: ["m1"] });
    const duck = ipc.nleCall.mock.calls.find((c) => c[1] === "duck_clip")![2];
    expect(duck).toEqual({ timeline: "Main", itemId: "m1", spans: [{ start: 1.8, end: 9.4 }], duckDb: -12, rampSeconds: 0.3 });
    expect(outcome.summary).toBe('"Song.wav" ducked 12 dB under dialogue in 1 place (backup: "B")');
    expect(useEditLogStore.getState().entries).toHaveLength(1);
  });

  it("takes explicit spans, and refuses non-music ids and nothing to duck under", async () => {
    ipc.nleCall.mockImplementation(async (_h: string, command: string) => {
      if (command === "read_timeline") return timeline([{ id: "m1", name: "Song.wav", start: 0, end: 20, enabled: true }]);
      if (command === "backup_timeline") return { backup: "B" };
      return { changes: [], refused: [] };
    });
    const ctx = { host: "premiere" as const, timeline: "Main", step: "m", stepText: "" };
    await duckMusic(ctx, { musicClipIds: ["m1"], spans: [{ start: 12, end: 14 }], leadSeconds: 0, tailSeconds: 0 });
    expect(ipc.nleCall.mock.calls.find((c) => c[1] === "duck_clip")![2].spans).toEqual([{ start: 12, end: 14 }]);
    await expect(duckMusic(ctx, { musicClipIds: ["zz"] })).rejects.toThrow("zz isn't a sound clip");
    await expect(duckMusic(ctx, { musicClipIds: ["m1"], dialogueClipIds: ["m1"] })).rejects.toThrow("no dialogue to duck under");
    await expect(duckMusic(ctx, { musicClipIds: ["m1"], duckDb: -60 })).rejects.toThrow("duckDb");
  });

  it("splits, turns down and crossfades Resolve's music, reading the timeline as it changes", async () => {
    // The music splits at 1.8 and 9.4 (newest cut first); then the middle piece is under dialogue.
    let music: HostClip[] = [{ id: "m1", name: "Song.wav", start: 0, end: 20, enabled: true, volumeDb: -2 }];
    ipc.nleCall.mockImplementation(async (_h: string, command: string, args: { itemIds?: string[]; time?: number }) => {
      if (command === "read_timeline") return timeline(music);
      if (command === "backup_timeline") return { backup: "B" };
      if (command === "split_clips") {
        const piece = music.find((c) => c.id === args.itemIds![0])!;
        const right = { ...piece, id: `${piece.id}r`, start: args.time! };
        music = [...music.filter((c) => c !== piece), { ...piece, end: args.time! }, right].sort((a, b) => a.start - b.start);
        return { changes: [{ kind: "split", name: "Song.wav", cut: args.time, items: [] }], refused: [] };
      }
      if (command === "set_clip_levels") return { changes: [{ kind: "level", name: "Song.wav", before: -2, after: -14 }], refused: [] };
      if (command === "set_transition") return { changes: [{ kind: "transition", name: "Song.wav", cut: 0, after: { type: "Cross Fade", seconds: 0.3 } }], refused: [] };
      throw new Error(command);
    });
    const outcome = await duckMusic({ host: "resolve", timeline: "Main", step: "m", stepText: "" }, { musicClipIds: ["m1"] });
    expect(ipc.nleCall.mock.calls.filter((c) => c[1] === "split_clips").map((c) => c[2].time)).toEqual([9.4, 1.8]);
    expect(ipc.nleCall.mock.calls.find((c) => c[1] === "set_clip_levels")![2].levels).toEqual([{ itemId: "m1r", volumeDb: -14 }]);
    expect(ipc.nleCall.mock.calls.filter((c) => c[1] === "set_transition")).toHaveLength(2);
    expect(outcome.summary).toBe('Cut "Song.wav" at 2 points, turned 1 piece down 12 dB, crossfaded 2 cuts over 0.3s');
    expect(useEditLogStore.getState().entries.map((e) => e.tool)).toEqual(Array(5).fill("duck_music"));
  });
});
