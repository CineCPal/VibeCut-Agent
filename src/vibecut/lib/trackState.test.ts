import { describe, expect, it } from "vitest";
import type { Clip, Track } from "../types/timeline";
import { applyTrackSwitches, editPoints, isSyncLocked, isTargeted, isTrackAudible, isTrackEnabled, nextEditPoint, soloActive, patchedTrackId, prevEditPoint, targetedTrackIds } from "./trackState";

function track(id: string, type: Track["type"], extra: Partial<Track> = {}): Track {
  return { id, type, name: id, order: 0, clipIds: [], height: 48, ...extra };
}

function clip(id: string, trackId: string, startTime: number, duration: number): Clip {
  return { id, mediaAssetId: "m", trackId, startTime, duration, sourceIn: 0, sourceOut: duration, name: id };
}

function state(...tracks: Track[]) {
  return { sequence: { trackIds: tracks.map((t) => t.id) }, tracksById: Object.fromEntries(tracks.map((t) => [t.id, t])) };
}

describe("track options", () => {
  it("default to sync-locked and targeted", () => {
    expect(isSyncLocked(track("V1", "video"))).toBe(true);
    expect(isTargeted(track("V1", "video"))).toBe(true);
    expect(isSyncLocked(track("V1", "video", { syncLocked: false }))).toBe(false);
    expect(isTargeted(track("V1", "video", { targeted: false }))).toBe(false);
    expect(isSyncLocked(undefined)).toBe(false);
  });

  it("patch the marked track, or else the first of its type", () => {
    const plain = state(track("V2", "video"), track("V1", "video"), track("A1", "audio"));
    expect(patchedTrackId(plain, "video")).toBe("V2");
    expect(patchedTrackId(plain, "audio")).toBe("A1");
    const marked = state(track("V2", "video"), track("V1", "video", { sourcePatched: true }), track("A1", "audio"));
    expect(patchedTrackId(marked, "video")).toBe("V1");
    expect(patchedTrackId(state(track("V1", "video")), "audio")).toBeNull();
  });

  it("lists targeted tracks in timeline order", () => {
    expect(targetedTrackIds(state(track("V1", "video"), track("A1", "audio", { targeted: false }), track("A2", "audio")))).toEqual(["V1", "A2"]);
  });
});

describe("track switches", () => {
  it("default to enabled and audible", () => {
    expect(isTrackEnabled(track("V1", "video"))).toBe(true);
    expect(isTrackAudible(track("A1", "audio"))).toBe(true);
    expect(isTrackAudible(track("A1", "audio", { muted: true }))).toBe(false);
    expect(isTrackAudible(track("V1", "video", { enabled: false }))).toBe(false);
    // Audio tracks can't be disabled (they have Solo instead), so a stray flag is ignored.
    expect(isTrackAudible(track("A1", "audio", { enabled: false }))).toBe(true);
    expect(isTrackEnabled(undefined)).toBe(false);
  });

  it("hear only soloed audio tracks while any is soloed, and silence video tracks' own sound", () => {
    const tracks = [track("V1", "video"), track("A1", "audio", { soloed: true }), track("A2", "audio")];
    const solo = soloActive(tracks);
    expect(solo).toBe(true);
    expect(tracks.map((t) => isTrackAudible(t, solo))).toEqual([false, true, false]);
    expect(isTrackAudible(track("A1", "audio", { soloed: true, muted: true }), true)).toBe(false);
    expect(soloActive([track("V1", "video", { soloed: true })])).toBe(false);
  });

  it("silence the clips a solo leaves out but keep their place", () => {
    const tracks = [track("A1", "audio", { clipIds: ["a"], soloed: true }), track("A2", "audio", { clipIds: ["b"] })];
    const clipsById = { a: clip("a", "A1", 0, 2), b: clip("b", "A2", 0, 2) };
    const out = applyTrackSwitches(tracks, clipsById);
    expect(out.tracks.map((t) => t.clipIds)).toEqual([["a"], ["b"]]);
    expect(out.clipsById.a).toBe(clipsById.a);
    expect(out.clipsById.b.volume).toBe(0);
  });

  it("leave the timeline untouched when nothing is switched off", () => {
    const tracks = [track("V1", "video", { clipIds: ["v"] })];
    const clipsById = { v: clip("v", "V1", 0, 2) };
    const out = applyTrackSwitches(tracks, clipsById);
    expect(out.tracks).toBe(tracks);
    expect(out.clipsById).toBe(clipsById);
  });

  it("empty a disabled track and silence the clips on disabled and muted tracks", () => {
    const tracks = [
      track("V1", "video", { clipIds: ["v"], enabled: false }),
      track("A1", "audio", { clipIds: ["a"], muted: true }),
      track("A2", "audio", { clipIds: ["b"] }),
    ];
    const clipsById = { v: clip("v", "V1", 0, 2), a: clip("a", "A1", 0, 2), b: clip("b", "A2", 0, 2) };
    const out = applyTrackSwitches(tracks, clipsById);
    expect(out.tracks.map((t) => t.clipIds)).toEqual([[], ["a"], ["b"]]);
    expect(out.clipsById.v.volume).toBe(0);
    expect(out.clipsById.a.volume).toBe(0);
    expect(out.clipsById.b).toBe(clipsById.b);
    expect(clipsById.a.volume).toBeUndefined();
  });
});

describe("edit points", () => {
  const clips = Object.fromEntries(
    [clip("a", "V1", 0, 5), clip("b", "V1", 5, 3), clip("c", "A1", 2, 10)].map((c) => [c.id, c]),
  );

  it("are the clip starts and ends on the given tracks, merged", () => {
    expect(editPoints(clips, ["V1"])).toEqual([0, 5, 8]);
    expect(editPoints(clips, ["V1", "A1"])).toEqual([0, 2, 5, 8, 12]);
  });

  it("step forward and back from a time, skipping the one under it", () => {
    expect(nextEditPoint(clips, ["V1"], 5)).toBe(8);
    expect(nextEditPoint(clips, ["V1"], 8)).toBeNull();
    expect(prevEditPoint(clips, ["V1", "A1"], 5)).toBe(2);
    expect(prevEditPoint(clips, ["V1"], 0)).toBeNull();
  });
});
