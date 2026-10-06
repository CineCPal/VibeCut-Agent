// VibeCut's sync.test.ts; its transcript-store block (shiftTranscript with VibeCut's store) is left out.
import { describe, expect, it } from "vitest";
import type { MediaAsset } from "../types/media";
import type { Clip, Track } from "../types/timeline";
import {
  expectedAlignment,
  primarySource,
  recorderRange,
  slipIntoSync,
  syncFramesByClip,
  transcriptionPaths,
  syncErrorFrames,
  syncErrorSeconds,
} from "./sync";

const base = { createdAt: "2026-09-27T00:00:00.000Z" };
const camera: MediaAsset = {
  ...base,
  id: "cam",
  fileName: "A001.mov",
  filePath: "/shoot/A001.mov",
  type: "video",
  durationSeconds: 60,
  hasAudio: true,
  syncedAudio: [{ assetId: "roll", offset: -100, method: "waveform" }],
};
const roll: MediaAsset = { ...base, id: "roll", fileName: "ZOOM0001.WAV", filePath: "/shoot/ZOOM0001.WAV", type: "audio", durationSeconds: 3600 };
const other: MediaAsset = { ...base, id: "other", fileName: "music.wav", filePath: "/music.wav", type: "audio", durationSeconds: 200 };
const assetsById = { cam: camera, roll, other };

const tracksById: Record<string, Track> = {
  v1: { id: "v1", type: "video", name: "V1", order: 0, clipIds: [], height: 64 },
  a1: { id: "a1", type: "audio", name: "A1", order: 1, clipIds: [], height: 48 },
  a2: { id: "a2", type: "audio", name: "A2", order: 2, clipIds: [], height: 48 },
};
const clip = (id: string, mediaAssetId: string, trackId: string, startTime: number, sourceIn: number, duration: number, linkId?: string): Clip => ({
  id,
  mediaAssetId,
  trackId,
  startTime,
  sourceIn,
  sourceOut: sourceIn + duration,
  duration,
  name: id,
  ...(linkId ? { linkId } : {}),
});

describe("recorderRange", () => {
  it("maps camera time into a long roll", () => {
    expect(recorderRange(5, 45, -100, 3600)).toEqual({ sourceIn: 105, sourceOut: 145, startDelta: 0 });
  });

  it("starts later when the recorder began after the camera", () => {
    expect(recorderRange(0, 20, 2, 28)).toEqual({ sourceIn: 0, sourceOut: 18, startDelta: 2 });
  });

  it("stops where the recording ends", () => {
    expect(recorderRange(20, 40, 2, 28)).toEqual({ sourceIn: 18, sourceOut: 28, startDelta: 0 });
  });

  it("is null when the recording does not cover the clip", () => {
    expect(recorderRange(40, 50, 2, 28)).toBeNull();
    expect(recorderRange(0, 2.05, 2, 28)).toBeNull();
  });
});

describe("transcriptionPaths", () => {
  it("sends a synced camera clip's recording instead, once per file", () => {
    const second: MediaAsset = { ...camera, id: "cam2", filePath: "/shoot/A002.mov" };
    expect(transcriptionPaths([camera, second, roll, other], { ...assetsById, cam2: second })).toEqual(["/shoot/ZOOM0001.WAV", "/music.wav"]);
  });
});

describe("alignment and sync errors", () => {
  const picture = clip("v", "cam", "v1", 10, 5, 40, "L");
  const sound = clip("r", "roll", "a1", 10, 105, 40, "L");
  const scratch = clip("s", "cam", "a2", 10, 5, 40, "L");
  const byId = (...clips: Clip[]) => Object.fromEntries(clips.map((c) => [c.id, c]));

  it("knows the offset between a picture and its synced recording", () => {
    expect(expectedAlignment(camera, camera, assetsById)).toBe(0);
    expect(expectedAlignment(camera, roll, assetsById)).toBe(-100);
    expect(expectedAlignment(camera, other, assetsById)).toBeUndefined();
    expect(primarySource(camera, assetsById)?.asset.id).toBe("roll");
  });

  it("reports nothing for a pair in sync", () => {
    const clips = byId(picture, sound, scratch);
    expect(syncErrorSeconds(sound, clips, tracksById, assetsById)).toBeCloseTo(0);
    expect(syncErrorSeconds(scratch, clips, tracksById, assetsById)).toBeCloseTo(0);
    expect(syncErrorSeconds(picture, clips, tracksById, assetsById)).toBe(0);
  });

  it("measures a slipped recording on both the sound and the picture", () => {
    const slipped = { ...sound, sourceIn: 104.9, sourceOut: 144.9 };
    const clips = byId(picture, slipped, scratch);
    // The sound plays 0.1 s of the roll earlier than it should, so it is 0.1 s late.
    expect(syncErrorSeconds(slipped, clips, tracksById, assetsById)).toBeCloseTo(0.1);
    expect(syncErrorSeconds(picture, clips, tracksById, assetsById)).toBeCloseTo(-0.1);
    expect(syncErrorFrames(0.1, 25)).toBe(3);
  });

  it("maps every clip's out-of-sync frames in one pass, as syncErrorSeconds measures them", () => {
    const slipped = { ...sound, sourceIn: 104.9, sourceOut: 144.9 };
    const other2 = clip("v2", "cam", "v1", 60, 5, 40, "M"); // a second, unrelated group in sync
    const clips = byId(picture, slipped, scratch, other2);
    const map = syncFramesByClip(clips, tracksById, assetsById, 25);
    expect(Object.keys(map).sort()).toEqual(["r", "v"]); // only the slipped pair is out of sync
    for (const c of Object.values(clips)) {
      const error = syncErrorSeconds(c, clips, tracksById, assetsById);
      expect(map[c.id] ?? 0).toBe(error === undefined ? 0 : syncErrorFrames(error, 25));
    }
    // The same inputs give back the same map, not a recomputed one.
    expect(syncFramesByClip(clips, tracksById, assetsById, 25)).toBe(map);
  });

  it("slips a recording back into sync without moving it", () => {
    const slipped = { ...sound, sourceIn: 104.9, sourceOut: 144.9 };
    const result = slipIntoSync(slipped, byId(picture, slipped), tracksById, assetsById);
    expect(result).toEqual({ sourceIn: expect.closeTo(105, 6) });
  });

  it("refuses to slip past the start of the recording", () => {
    const early = { ...sound, startTime: 10, sourceIn: 0, sourceOut: 40 };
    const result = slipIntoSync(early, byId({ ...picture, sourceIn: 0, sourceOut: 40 }, { ...early, startTime: 0 }), tracksById, {
      ...assetsById,
      cam: { ...camera, syncedAudio: [{ assetId: "roll", offset: 5, method: "waveform" }] },
    });
    expect(result).toHaveProperty("error");
  });

  it("ignores unlinked clips and files with no known relation", () => {
    expect(syncErrorSeconds({ ...sound, linkId: undefined }, byId(picture, sound), tracksById, assetsById)).toBeUndefined();
    const music = clip("m", "other", "a1", 10, 0, 40, "L");
    expect(syncErrorSeconds(music, byId(picture, music), tracksById, assetsById)).toBeUndefined();
  });
});

