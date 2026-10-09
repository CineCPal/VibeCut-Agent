import { describe, expect, it } from "vitest";
import type { MediaAsset } from "../types/media";
import type { Clip, Track } from "../types/timeline";
import type { WaveformPeaks } from "../types/waveform";
import { lintEdit, type LintInput } from "./editLint";

const FPS = 25;

const asset = (id: string, over: Partial<MediaAsset> = {}): MediaAsset => ({
  id,
  fileName: `${id}.mp4`,
  filePath: `/media/${id}.mp4`,
  type: "video",
  durationSeconds: 120,
  hasAudio: true,
  createdAt: "",
  ...over,
});

const clip = (id: string, over: Partial<Clip>): Clip => ({
  id,
  mediaAssetId: "a",
  trackId: "v1",
  startTime: 0,
  duration: 10,
  sourceIn: 0,
  sourceOut: 10,
  name: id,
  ...over,
});

const track = (id: string, type: Track["type"], clips: Clip[]): Track => ({ id, type, name: id, order: 0, clipIds: clips.map((c) => c.id), height: 50 });

function input(tracks: Array<[string, Track["type"], Clip[]]>, over: Partial<LintInput> = {}): LintInput {
  const all = tracks.flatMap(([, , clips]) => clips);
  return {
    tracks: tracks.map(([id, type, clips]) => track(id, type, clips)),
    clipsById: Object.fromEntries(all.map((c) => [c.id, c])),
    assetsById: { a: asset("a"), b: asset("b") },
    frameRate: FPS,
    ...over,
  };
}

const RATE = 10;
/** Peaks from per-second levels (each second is RATE identical buckets). */
function peaks(levels: number[]): WaveformPeaks {
  const maxes = levels.flatMap((l) => Array<number>(RATE).fill(l));
  return { peaksPerSecond: RATE, mins: maxes.map((m) => -m), maxes };
}

const categories = (i: LintInput) => lintEdit(i).map((f) => f.category);

describe("lintEdit", () => {
  it("finds nothing wrong with two clean, butted shots", () => {
    const i = input([["v1", "video", [clip("c1", {}), clip("c2", { mediaAssetId: "b", startTime: 10 })]]]);
    expect(lintEdit(i)).toEqual([]);
  });

  it("reports a gap in the picture as black, with its extent", () => {
    const i = input([["v1", "video", [clip("c1", {}), clip("c2", { mediaAssetId: "b", startTime: 12 })]]]);
    expect(lintEdit(i)).toMatchObject([{ category: "black", time: 10, end: 12, severity: "high", clipIds: ["c1", "c2"] }]);
  });

  it("ignores a gap shorter than a frame", () => {
    const i = input([["v1", "video", [clip("c1", {}), clip("c2", { mediaAssetId: "b", startTime: 10.01 })]]]);
    expect(categories(i)).toEqual([]);
  });

  it("reports black where only sound plays past the end of the picture", () => {
    const i = input([
      ["v1", "video", [clip("c1", {})]],
      ["a1", "audio", [clip("m1", { trackId: "a1", mediaAssetId: "b", duration: 15, sourceOut: 15 })]],
    ]);
    expect(lintEdit(i)).toMatchObject([{ category: "black", time: 10, end: 15 }]);
  });

  it("reports a shot shorter than six frames as a flash frame", () => {
    const i = input([
      [
        "v1",
        "video",
        [clip("c1", {}), clip("c2", { mediaAssetId: "b", startTime: 10, duration: 0.12, sourceOut: 0.12 }), clip("c3", { startTime: 10.12, sourceIn: 20, sourceOut: 30 })],
      ],
    ]);
    expect(lintEdit(i)).toMatchObject([{ category: "flash_frame", time: 10, clipIds: ["c2"] }]);
  });

  it("reports a cut inside a word once for a linked picture and sound pair", () => {
    const words = { a: [{ start: 9.8, end: 10.3, text: "budget" }] };
    const i = input(
      [
        ["v1", "video", [clip("c1", { linkId: "L" }), clip("c2", { mediaAssetId: "b", startTime: 10 })]],
        ["a1", "audio", [clip("s1", { trackId: "a1", linkId: "L" })]],
      ],
      { wordsByAssetId: words, assetsById: { a: asset("a"), b: asset("b", { hasAudio: false }) } },
    );
    const found = lintEdit(i).filter((f) => f.category === "mid_word_cut");
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ time: 10, message: expect.stringContaining('"budget"') });
    expect(found[0].clipIds.sort()).toEqual(["c1", "s1"]);
  });

  it("does not report a cut inside a word's timing when the sound there is silent, but does when it isn't", () => {
    // Seconds 0-9 speech, 10-11 silence: a transcriber stretched "Thanks" (9.8-10.6) back over the pause.
    const cut = (level: number) =>
      input([["v1", "video", [clip("c1", {}), clip("c2", { mediaAssetId: "b", startTime: 10 })]]], {
        wordsByAssetId: { a: [{ start: 9.8, end: 10.6, text: "Thanks" }] },
        peaksByAssetId: { a: peaks([...Array(9).fill(0.4), level, 0, 0.4]) },
      });
    // The cut sits at source 10s; 9.95-10.05 spans the end of second 9 and the start of second 10.
    expect(categories(cut(0))).toEqual([]);
    expect(categories(cut(0.4))).toContain("mid_word_cut");
  });

  it("does not report a cut right at a word's edge", () => {
    const i = input([["v1", "video", [clip("c1", {}), clip("c2", { mediaAssetId: "b", startTime: 10 })]]], {
      wordsByAssetId: { a: [{ start: 9.5, end: 10.01, text: "end" }] },
    });
    expect(categories(i)).toEqual([]);
  });

  it("reports a jump in level across a cut, but not into silence", () => {
    const loudB = input([["v1", "video", [clip("c1", {}), clip("c2", { mediaAssetId: "b", startTime: 10 })]]], {
      peaksByAssetId: { a: peaks(Array(20).fill(0.05)), b: peaks(Array(20).fill(0.5)) },
    });
    expect(lintEdit(loudB)).toMatchObject([{ category: "level_jump", time: 10, severity: "medium", clipIds: ["c1", "c2"], message: expect.stringContaining("20 dB louder") }]);

    const silentB = input([["v1", "video", [clip("c1", {}), clip("c2", { mediaAssetId: "b", startTime: 10 })]]], {
      peaksByAssetId: { a: peaks(Array(20).fill(0.5)), b: peaks(Array(20).fill(0.001)) },
    });
    expect(categories(silentB)).toEqual([]);
  });

  it("does not report a level change between two parts of the same recording", () => {
    const i = input([["v1", "video", [clip("c1", {}), clip("c2", { startTime: 10, sourceIn: 20, sourceOut: 30 })]]], {
      peaksByAssetId: { a: peaks([...Array(10).fill(0.5), ...Array(20).fill(0.02)]) },
    });
    expect(categories(i)).toEqual([]);
  });

  it("takes each clip's volume into account for level and clipping", () => {
    const i = input([["v1", "video", [clip("c1", { volume: 2.5 })]]], { peaksByAssetId: { a: peaks([0.2, 0.2, 0.5, 0.2, 0.2, 0.2, 0.2, 0.2, 0.2, 0.2]) } });
    expect(lintEdit(i)).toMatchObject([{ category: "clipping", time: 2, message: expect.stringContaining("250%") }]);
  });

  it("reports linked picture and sound that have drifted out of sync", () => {
    const i = input([
      ["v1", "video", [clip("c1", { linkId: "L" })]],
      ["a1", "audio", [clip("s1", { trackId: "a1", linkId: "L", startTime: 0.2, sourceIn: 0, sourceOut: 9.8, duration: 9.8 })]],
    ]);
    expect(lintEdit(i)).toMatchObject([{ category: "out_of_sync", severity: "high", message: expect.stringContaining("5 frames") }]);
  });

  it("checks a synced recording against its sync offset, not its source position", () => {
    const camera = asset("a", { syncedAudio: [{ assetId: "rec", offset: -100, method: "waveform" }] });
    const rec = asset("rec", { type: "audio", fileName: "rec.wav", durationSeconds: 3600 });
    const inSync = input(
      [
        ["v1", "video", [clip("c1", { linkId: "L" })]],
        ["a1", "audio", [clip("r1", { trackId: "a1", mediaAssetId: "rec", linkId: "L", sourceIn: 100, sourceOut: 110 })]],
      ],
      { assetsById: { a: camera, rec } },
    );
    expect(lintEdit(inSync).filter((f) => f.category === "out_of_sync")).toEqual([]);

    const slipped = input(
      [
        ["v1", "video", [clip("c1", { linkId: "L" })]],
        ["a1", "audio", [clip("r1", { trackId: "a1", mediaAssetId: "rec", linkId: "L", sourceIn: 100.2, sourceOut: 110.2 })]],
      ],
      { assetsById: { a: camera, rec } },
    );
    expect(lintEdit(slipped).filter((f) => f.category === "out_of_sync")).toMatchObject([
      { clipIds: ["c1", "r1"], message: expect.stringContaining("5 frames") },
    ]);
  });

  it("returns findings in timeline order", () => {
    const i = input([
      ["v1", "video", [clip("c1", {}), clip("c2", { mediaAssetId: "b", startTime: 11, duration: 0.1, sourceOut: 0.1 }), clip("c3", { startTime: 11.1, sourceIn: 20, sourceOut: 30 })]],
    ]);
    expect(lintEdit(i).map((f) => [f.category, f.time])).toEqual([
      ["black", 10],
      ["flash_frame", 11],
    ]);
  });

  it("is empty for an empty timeline", () => {
    expect(lintEdit(input([["v1", "video", []]]))).toEqual([]);
  });
});
