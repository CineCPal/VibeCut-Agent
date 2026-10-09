import { describe, expect, it } from "vitest";
import type { Clip, Track } from "../types/timeline";
import { fadeLevel } from "./playback/envelope";
import {
  activeTransition,
  expandTransitions,
  maxTransitionSeconds,
  nearestCut,
  pictureFadeLevel,
  planTransition,
  soundFadeLevel,
  transitionTrackId,
  type RenderClip,
} from "./transitions";

function clip(id: string, trackId: string, startTime: number, duration: number, sourceIn: number, extra: Partial<Clip> = {}): Clip {
  return { id, mediaAssetId: "m", trackId, startTime, duration, sourceIn, sourceOut: sourceIn + duration, name: id, ...extra };
}

function track(id: string, type: Track["type"], clipIds: string[]): Track {
  return { id, type, name: id.toUpperCase(), order: 0, clipIds, height: 48 };
}

const media = () => 30;
const byId = (...clips: Clip[]) => Object.fromEntries(clips.map((c) => [c.id, c]));

// V1: a [0,4) from 5–9 of its file, b [4,10) from 10–16.
const a = clip("a", "v1", 0, 4, 5, { transitionOut: { kind: "dissolve", duration: 1 } });
const b = clip("b", "v1", 4, 6, 10);

describe("maxTransitionSeconds", () => {
  it("is limited by half of either clip, and for a dissolve by the media past the cut", () => {
    expect(maxTransitionSeconds(a, b, "dipToBlack", media)).toBe(4);
    // a has 21 s of file after its out point; b has 10 s before its in point; a is only 4 s long.
    expect(maxTransitionSeconds(a, b, "dissolve", media)).toBe(4);
    const noHead = { ...b, sourceIn: 0.3, sourceOut: 6.3 };
    expect(maxTransitionSeconds(a, noHead, "dissolve", media)).toBe(0.6);
    expect(maxTransitionSeconds(a, noHead, "dissolve", () => 9)).toBe(0);
  });
});

describe("activeTransition", () => {
  it("plays only while a clip starts at the cut, clamped to what fits now", () => {
    expect(activeTransition(byId(a, b), a, media)).toMatchObject({ kind: "dissolve", duration: 1, cut: 4 });
    expect(activeTransition(byId(a, { ...b, startTime: 5 }), a, media)).toBeNull();
    const long = { ...a, transitionOut: { kind: "dissolve" as const, duration: 20 } };
    expect(activeTransition(byId(long, b), long, media)?.duration).toBe(4);
  });
});

describe("planTransition", () => {
  it("clamps to what fits and says why it refuses", () => {
    expect(planTransition(byId(a, b), a, "dissolve", 10, media)).toEqual({ ok: true, transition: { kind: "dissolve", duration: 4 }, requested: 10 });
    expect(planTransition(byId(a, b), a, null, 0, media)).toEqual({ ok: true, transition: null, requested: null });
    expect(planTransition(byId(a), a, "dissolve", 1, media)).toMatchObject({ ok: false, error: expect.stringMatching(/no cut/) });
    expect(planTransition(byId(a, b), a, "dissolve", 1, () => 9)).toMatchObject({ ok: false, error: expect.stringMatching(/handles/) });
    expect(planTransition(byId(a, b), a, "dissolve", 0, media)).toMatchObject({ ok: false });
  });
});

describe("nearestCut", () => {
  it("is the clip ending at the cut closest to the time", () => {
    const c = clip("c", "v1", 10, 2, 0);
    const clips = byId(a, b, c);
    expect(nearestCut(clips, track("v1", "video", ["a", "b", "c"]), 9)?.id).toBe("b");
    expect(nearestCut(clips, track("v1", "video", ["a", "b", "c"]), 1)?.id).toBe("a");
  });
});

describe("expandTransitions", () => {
  it("leaves a timeline without transitions untouched", () => {
    const plain = byId({ ...a, transitionOut: undefined }, b);
    const tracks = [track("v1", "video", ["a", "b"])];
    const result = expandTransitions(tracks, plain, media);
    expect(result.clipsById).toBe(plain);
    expect(result.tracks[0]).toBe(tracks[0]);
  });

  it("turns a dissolve into an early in-coming clip under a see-through tail of the out-going one", () => {
    const result = expandTransitions([track("v1", "video", ["a", "b"])], byId(a, b), media);
    expect(result.tracks.map((t) => t.id)).toEqual([transitionTrackId("v1"), "v1"]);
    const clips = result.clipsById;
    // a now ends where the dissolve starts, half a second before the cut.
    expect(clips.a).toMatchObject({ startTime: 0, duration: 3.5, sourceOut: 8.5 });
    const tail = clips["a~tail"];
    expect(tail).toMatchObject({ trackId: transitionTrackId("v1"), startTime: 3.5, duration: 1, sourceIn: 8.5, sourceOut: 9.5, fadeOut: 1, seeThrough: true });
    // b starts half a second early from before its in point; its sound fades in, its picture does not.
    expect(clips.b).toMatchObject({ startTime: 3.5, duration: 6.5, sourceIn: 9.5, fadeIn: 1, pictureFadeIn: 0, powerFades: true });
  });

  it("turns a dip to black into meeting fades and adds no track", () => {
    const dip = { ...a, transitionOut: { kind: "dipToBlack" as const, duration: 1 } };
    const result = expandTransitions([track("v1", "video", ["a", "b"])], byId(dip, b), media);
    expect(result.tracks.map((t) => t.id)).toEqual(["v1"]);
    expect(result.clipsById.a).toMatchObject({ startTime: 0, duration: 4, fadeOut: 0.5 });
    expect(result.clipsById.b).toMatchObject({ startTime: 4, fadeIn: 0.5 });
  });

  it("handles a clip with a transition at both ends", () => {
    const middle = { ...b, transitionOut: { kind: "dissolve" as const, duration: 2 } };
    const c = clip("c", "v1", 10, 4, 3);
    const result = expandTransitions([track("v1", "video", ["a", "b", "c"])], byId(a, middle, c), media);
    // b starts 0.5 s early (the dissolve from a) and ends 1 s before its cut (the dissolve into c).
    expect(result.clipsById.b).toMatchObject({ startTime: 3.5, duration: 5.5, sourceIn: 9.5, sourceOut: 15 });
    expect(result.clipsById["b~tail"]).toMatchObject({ startTime: 9, duration: 2, sourceIn: 15, sourceOut: 17 });
    expect(result.tracks.find((t) => t.id === transitionTrackId("v1"))?.clipIds).toEqual(["a~tail", "b~tail"]);
  });

  it("gives an audio crossfade two equal-power fades and no see-through flag", () => {
    const a1 = { ...a, trackId: "a1" };
    const b1 = { ...b, trackId: "a1" };
    const result = expandTransitions([track("a1", "audio", ["a", "b"])], byId(a1, b1), media);
    expect(result.clipsById["a~tail"]).toMatchObject({ fadeOut: 1, powerFades: true });
    expect(result.clipsById["a~tail"].seeThrough).toBeUndefined();
    expect(result.clipsById.b.pictureFadeIn).toBeUndefined();
  });
});

describe("render fade levels", () => {
  const tail: RenderClip = { ...clip("t", "x", 3.5, 1, 8.5), fadeOut: 1, powerFades: true };
  const incoming: RenderClip = { ...clip("b", "v1", 3.5, 6.5, 9.5), fadeIn: 1, pictureFadeIn: 0, powerFades: true };

  it("keeps crossfading sound at equal power through the middle", () => {
    const out = soundFadeLevel(tail, 4, fadeLevel);
    const into = soundFadeLevel(incoming, 4, fadeLevel);
    expect(out).toBeCloseTo(Math.SQRT1_2);
    expect(out * out + into * into).toBeCloseTo(1);
  });

  it("fades the see-through picture linearly and never the in-coming one", () => {
    expect(pictureFadeLevel(tail, 4, fadeLevel)).toBeCloseTo(0.5);
    expect(pictureFadeLevel(incoming, 3.6, fadeLevel)).toBe(1);
  });
});
