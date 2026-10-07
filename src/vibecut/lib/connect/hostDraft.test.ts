import { describe, expect, it } from "vitest";
import type { HostTimeline } from "../../types/connect";
import { addDraftMarkers, arrangeSections, draftAsTimeline, draftClipAt, draftFromPlan, draftFromSnapshot, isSoundOnly, keptBetween, placeClip, rebuildRequest, removeRanges, reshapeDraftClip, syncedPictures } from "./hostDraft";

// A 10 s interview at 25 fps: A.mov on V1 with its linked sound on A1 (at -6 dB), B-roll on V2,
// a transition and a title, and two markers.
const SNAPSHOT: HostTimeline = {
  project: "Doc",
  timeline: "Interview",
  fps: 25,
  startTimecode: "01:00:00:00",
  duration: 10,
  isCurrent: true,
  tracks: [
    {
      type: "video",
      index: 1,
      name: "",
      enabled: true,
      clips: [
        { id: "v1", name: "A.mov", start: 0, end: 10, enabled: true, sourceIn: 20, sourceOut: 30, filePath: "/m/A.mov", linkedIds: ["a1"], fusion: true },
        { id: "x1", name: "Cross Dissolve", start: 9.5, end: 10, enabled: true, kind: "effect" },
      ],
    },
    {
      type: "video",
      index: 2,
      name: "",
      enabled: true,
      clips: [
        { id: "v2", name: "B.mov", start: 3, end: 6, enabled: true, sourceIn: 0, sourceOut: 6, speed: 2, filePath: "/m/B.mov" },
        { id: "t1", name: "Text+", start: 7, end: 8, enabled: true, sourceIn: 0 },
      ],
    },
    { type: "audio", index: 1, name: "", enabled: true, clips: [{ id: "a1", name: "A.mov", start: 0, end: 10, enabled: true, sourceIn: 20, sourceOut: 30, filePath: "/m/A.mov", volumeDb: -6, linkedIds: ["v1"] }] },
  ],
  markers: [
    { id: "f25", time: 1, name: "Hook", color: "Red", note: "", duration: 0.04 },
    { id: "f200", time: 8, name: "Outro", color: "Blue", note: "", duration: 0.04 },
  ],
};

const draft = () => draftFromSnapshot(SNAPSHOT);

describe("draftFromSnapshot", () => {
  it("keeps clips with files, links picture to sound, and says what it can't carry", () => {
    const d = draft();
    expect(d.video[0].clips).toHaveLength(1);
    expect(d.video[0].clips[0]).toMatchObject({ originId: "v1", sourcePath: "/m/A.mov", sourceIn: 20, sourceOut: 30, speed: 1, linkGroup: "a1" });
    expect(d.audio[0].clips[0]).toMatchObject({ volumeDb: -6, linkGroup: "a1" });
    expect(d.video[1].clips.map((c) => c.sourceName)).toEqual(["B.mov"]);
    expect(d.notCarried).toEqual(["1 transition or generator", "1 clip with no source file (titles, compound clips)", "Fusion effects on 1 clip"]);
    expect(d.markers.map((m) => m.time)).toEqual([1, 8]);
  });
});

describe("removeRanges", () => {
  it("ripple-deletes across every track, cutting clips and moving markers", () => {
    const d = removeRanges(draft(), [{ start: 2, end: 4 }]);
    expect(d.duration).toBe(8);
    expect(d.video[0].clips.map((c) => [c.start, c.end, c.sourceIn, c.sourceOut])).toEqual([
      [0, 2, 20, 22],
      [2, 8, 24, 30],
    ]);
    // The 2x B-roll loses its first second (2 s of source) and closes up.
    expect(d.video[1].clips.map((c) => [c.start, c.end, c.sourceIn, c.sourceOut, c.speed])).toEqual([[2, 4, 2, 6, 2]]);
    expect(d.audio[0].clips.map((c) => [c.start, c.end])).toEqual([
      [0, 2],
      [2, 8],
    ]);
    expect(d.markers.map((m) => [m.name, m.time])).toEqual([
      ["Hook", 1],
      ["Outro", 6],
    ]);
    expect(d.changes).toEqual(["Removed 1 range (2s)"]);
  });

  it("merges overlapping ranges and refuses to remove everything or nothing sensible", () => {
    expect(keptBetween([{ start: 2, end: 5 }, { start: 4, end: 6 }, { start: 9, end: 20 }], 10)).toEqual([
      { start: 0, end: 2 },
      { start: 6, end: 9 },
    ]);
    expect(() => removeRanges(draft(), [{ start: 0, end: 10 }])).toThrow("whole timeline");
    expect(() => removeRanges(draft(), [{ start: 3, end: 3 }])).toThrow("end after it starts");
    expect(() => removeRanges(draft(), [{ start: 12, end: 13 }])).toThrow("outside the timeline");
  });

  it("leaves no flash frame when a range stops just short of the end or of the next range", () => {
    expect(keptBetween([{ start: 2, end: 5 }, { start: 5.04, end: 7 }, { start: 8, end: 9.97 }], 10)).toEqual([
      { start: 0, end: 2 },
      { start: 7, end: 8 },
    ]);
    const d = removeRanges(draft(), [{ start: 6, end: 9.96 }]);
    expect(d.duration).toBeCloseTo(6, 6);
  });

  it("snaps to frames so repeated edits don't drift", () => {
    const d = removeRanges(removeRanges(draft(), [{ start: 1.013, end: 2.011 }]), [{ start: 0.5, end: 0.52 }]);
    for (const c of [...d.video[0].clips, ...d.audio[0].clips]) {
      expect(Math.abs(c.start * 25 - Math.round(c.start * 25))).toBeLessThan(1e-6);
      expect(Math.abs(c.end * 25 - Math.round(c.end * 25))).toBeLessThan(1e-6);
    }
  });
});

describe("arrangeSections", () => {
  it("plays sections in the given order and drops the rest", () => {
    const d = arrangeSections(draft(), [
      { start: 6, end: 10 },
      { start: 0, end: 2 },
    ]);
    expect(d.duration).toBe(6);
    expect(d.video[0].clips.map((c) => [c.start, c.end, c.sourceIn])).toEqual([
      [0, 4, 26],
      [4, 6, 20],
    ]);
    expect(d.video[1].clips).toEqual([]);
    expect(d.markers.map((m) => [m.name, m.time])).toEqual([
      ["Outro", 2],
      ["Hook", 5],
    ]);
  });
});

describe("placeClip", () => {
  it("puts B-roll on the lowest free track above V1 and moves nothing else", () => {
    const d = placeClip(draft(), { sourcePath: "/broll/city.mov", sourceIn: 10, sourceOut: 12, at: 7 });
    expect(d.video[1].clips.map((c) => [c.sourceName, c.start, c.end, c.sourceIn, c.sourceOut])).toEqual([
      ["B.mov", 3, 6, 0, 6],
      ["city.mov", 7, 9, 10, 12],
    ]);
    expect(d.video[0].clips).toEqual(draft().video[0].clips);
    expect(d.changes).toEqual(["Placed city.mov on V2 at 7s (2s)"]);
  });

  it("opens a new track when the ones above V1 are busy, and can bring the clip's sound", () => {
    const d = placeClip(draft(), { sourcePath: "/broll/city.mov", sourceIn: 0, sourceOut: 2, at: 4, withSound: true, volumeDb: -12 });
    expect(d.video).toHaveLength(3);
    expect(d.video[2].clips[0].linkGroup).toBeDefined();
    expect(d.audio).toHaveLength(2);
    expect(d.audio[1].clips[0]).toMatchObject({ sourceName: "city.mov", volumeDb: -12, linkGroup: d.video[2].clips[0].linkGroup });
  });

  it("lengthens the timeline when it runs past the end, and refuses a busy chosen track", () => {
    expect(placeClip(draft(), { sourcePath: "/b.mov", sourceIn: 0, sourceOut: 4, at: 9 }).duration).toBe(13);
    expect(() => placeClip(draft(), { sourcePath: "/b.mov", sourceIn: 0, sourceOut: 1, at: 4, videoTrack: 2 })).toThrow("V2 already has a clip");
    expect(() => placeClip(draft(), { sourcePath: "/b.mov", sourceIn: 0, sourceOut: 1, at: 4, videoTrack: 5 })).toThrow("There is no V5");
    expect(() => placeClip(draft(), { sourcePath: "b.mov", sourceIn: 0, sourceOut: 1, at: 0 })).toThrow("absolute path");
  });

  it("uses V1 on an empty timeline", () => {
    const empty = { ...draft(), video: [], audio: [] };
    expect(placeClip(empty, { sourcePath: "/b.mov", sourceIn: 0, sourceOut: 1, at: 0 }).video[0].clips).toHaveLength(1);
  });
});

describe("rebuildRequest", () => {
  it("sends tracks bottom to top with levels, links per cut piece, speed and grade sources", () => {
    const d = addDraftMarkers(removeRanges(draft(), [{ start: 2, end: 4 }]), [{ time: 3, name: "New", color: "Green", note: "", duration: 0 }]);
    const request = rebuildRequest(d) as { timeline: string; tracks: { type: string; clips: Record<string, unknown>[] }[]; grades: unknown[]; markers: unknown[] };
    expect(request.timeline).toBe("Interview");
    expect(request.tracks.map((t) => t.type)).toEqual(["audio", "video", "video"]);
    const [a1, v1, v2] = request.tracks;
    expect(a1.clips[0]).toMatchObject({ volume: expect.closeTo(0.501, 3), linkGroup: "a1@0" });
    expect(v1.clips.map((c) => c.linkGroup)).toEqual(["a1@0", "a1@50"]);
    expect(v1.clips[0]).toMatchObject({ sourceInSeconds: 20, sourceOutSeconds: 22, volume: 1, hasAudio: false });
    expect(v2.clips[0].timeMap).toEqual([
      { t: 0, s: 2 },
      { t: 2, s: 6 },
    ]);
    expect(request.grades).toEqual([
      { originId: "v1", trackIndex: 1, start: 0, end: 2 },
      { originId: "v1", trackIndex: 1, start: 2, end: 8 },
      { originId: "v2", trackIndex: 2, start: 2, end: 4 },
    ]);
    expect(request.markers).toHaveLength(3);
  });

  it("orders several audio tracks An ... A1, as the builders number them top-down", () => {
    const d = placeClip(draft(), { sourcePath: "/b.mov", sourceIn: 0, sourceOut: 1, at: 0, withSound: true });
    const request = rebuildRequest(d, "Tight cut") as { name: string; tracks: { type: string; clips: { sourceName: string }[] }[] };
    expect(request.name).toBe("Tight cut");
    expect(request.tracks.filter((t) => t.type === "audio").map((t) => t.clips[0].sourceName)).toEqual(["b.mov", "A.mov"]);
  });
});

describe("reshapeDraftClip without its linked clips", () => {
  it("slips the sound alone, leaving its picture", () => {
    // draft-0 is A.mov on V1, draft-2 its linked sound on A1.
    const next = reshapeDraftClip(draft(), "draft-2", { slip: 0.2, withLinked: false });
    expect(next.audio[0].clips[0]).toMatchObject({ sourceIn: 20.2, sourceOut: 30.2, start: 0, end: 10 });
    expect(next.video[0].clips[0]).toMatchObject({ sourceIn: 20, sourceOut: 30 });
  });
});

describe("draftAsTimeline", () => {
  it("draws the draft with the Connect page's timeline view", () => {
    const view = draftAsTimeline(removeRanges(draft(), [{ start: 2, end: 4 }]), "Doc");
    expect(view.timeline).toBe("Interview — draft");
    expect(view.duration).toBe(8);
    expect(view.tracks.map((t) => `${t.type}${t.index}:${t.clips.length}`)).toEqual(["video1:2", "video2:1", "audio1:2"]);
  });

  it("gives each clip its file and links the picture and sound pieces that sit together", () => {
    const view = draftAsTimeline(removeRanges(draft(), [{ start: 2, end: 4 }]), "Doc");
    const [v1, v2, a1] = [view.tracks[0].clips, view.tracks[1].clips, view.tracks[2].clips];
    expect(v1.map((c) => c.filePath)).toEqual(["/m/A.mov", "/m/A.mov"]);
    expect(v1[0].linkedIds).toEqual([a1[0].id]);
    expect(v1[1].linkedIds).toEqual([a1[1].id]);
    expect(a1[1].linkedIds).toEqual([v1[1].id]);
    expect(v2[0].linkedIds).toBeUndefined();
  });
});

describe("draftFromPlan", () => {
  const seg = (track: "main" | "broll", mediaPath: string | null, start: number, sourceIn: number, sourceOut: number, audioMode = "silent") => ({
    track,
    mediaPath,
    name: mediaPath?.split("/").pop() ?? "x",
    sourceIn,
    sourceOut,
    start,
    audioMode,
    duckDb: -12,
  });

  it("lays main cuts end to end with linked sound, stacks overlapping B-roll, and notes what it can't do", () => {
    const draft = draftFromPlan("Interview", 25, {
      sequenceName: "Bakery",
      unreadable: 0,
      segments: [
        seg("main", "/m/A.mov", 0, 10, 14),
        seg("main", "/m/B.mov", 4, 2, 5),
        seg("main", null, 7, 0, 1),
        seg("broll", "/b/1.mov", 1, 0, 3),
        seg("broll", "/b/2.mov", 2, 0, 2, "mix"),
        seg("broll", "/b/3.mov", 5, 0, 1, "duck_main"),
      ],
    });
    expect(draft.name).toBe("Bakery");
    expect(draft.base).toBe("Interview");
    expect(draft.video[0].clips.map((c) => [c.sourceName, c.start, c.end])).toEqual([
      ["A.mov", 0, 4],
      ["B.mov", 4, 7],
    ]);
    expect(draft.video[0].clips.map((c) => c.linkGroup)).toEqual(draft.audio[0].clips.map((c) => c.linkGroup));
    // 1.mov (1–4) and 2.mov (2–4) overlap, so 2.mov goes up a track; 3.mov fits back on V2.
    expect(draft.video.slice(1).map((t) => t.clips.map((c) => c.sourceName))).toEqual([["1.mov", "3.mov"], ["2.mov"]]);
    expect(draft.audio[1].clips.map((c) => c.sourceName)).toEqual(["2.mov", "3.mov"]);
    expect(draft.notCarried).toEqual(["1 cut had no source file and was left out", "the interview isn't lowered under 1 B-roll clip the plan wanted ducked"]);
    expect(draft.duration).toBe(7);
    expect(draft.changes).toEqual(['Story Editor: "Bakery", 2 cuts and 3 B-roll clips (7s)']);
  });

  // Live, 2026-10-06: transcripts made from the recorder's WAVs put the WAV on V1, and Premiere imported
  // the sequence as nothing. A WAV cut now takes its picture from the camera synced to it.
  const SYNCED = {
    tracks: [
      { type: "video", clips: [{ id: "v1", start: 0, sourceIn: 100, sourceOut: 400, filePath: "/m/RiaC.MP4", linkedIds: ["a1", "w1"] }] },
      { type: "audio", clips: [{ id: "a1", start: 0, sourceIn: 100, sourceOut: 400, filePath: "/m/RiaC.MP4", linkedIds: ["v1", "w1"] }] },
      { type: "audio", clips: [{ id: "w1", start: 0, sourceIn: 2.5, sourceOut: 302.5, filePath: "/m/RiaC.WAV", linkedIds: ["v1", "a1"] }] },
      { type: "audio", clips: [{ id: "w2", start: 400, sourceIn: 0, sourceOut: 50, filePath: "/m/Lonely.WAV", linkedIds: [] }] },
    ],
  };

  it("finds each recorder file's synced camera and offset", () => {
    expect(syncedPictures(SYNCED)).toEqual(new Map([["/m/RiaC.WAV", { cameraPath: "/m/RiaC.MP4", offset: 97.5, cameraIn: 100, cameraOut: 400 }]]));
  });

  // The length snaps to whole frames at 29.97 fps, so 5 s of source becomes 5.005 s.
  it("takes a WAV cut's picture from its synced camera, and leaves an unsynced one as sound only", () => {
    const draft = draftFromPlan(
      "ALW Course Piece",
      29.97,
      { sequenceName: "Story", unreadable: 0, segments: [seg("main", "/m/RiaC.WAV", 0, 20, 25), seg("main", "/m/Lonely.WAV", 5, 1, 3), seg("main", "/m/RiaC.WAV", 7, 400, 402)] },
      syncedPictures(SYNCED),
    );
    expect(draft.video[0].clips.map((c) => [c.sourcePath, c.sourceIn, c.sourceOut, c.linkGroup])).toEqual([["/m/RiaC.MP4", 117.5, 122.505, "story-0"]]);
    expect(draft.audio[0].clips.map((c) => [c.sourcePath, c.sourceIn, c.linkGroup])).toEqual([
      ["/m/RiaC.WAV", 20, "story-0"],
      ["/m/Lonely.WAV", 1, "story-1"],
      ["/m/RiaC.WAV", 400, "story-2"],
    ]);
    expect(draft.notCarried).toEqual(["2 cuts from a sound recording with no synced camera have sound only (sync the camera first to get picture)"]);
    expect(draft.changes[0]).toContain("3 cuts");
    expect(draft.changes[0]).toContain("picture from the synced camera for 1 cut");
    expect(isSoundOnly("/m/x.Wav") && !isSoundOnly("/m/x.mov")).toBe(true);
  });
});

describe("reshapeDraftClip", () => {
  // draft-0 is A.mov on V1, draft-1 is B.mov (2x) on V2, draft-2 is A.mov's sound on A1.
  const draft = () => draftFromSnapshot(SNAPSHOT);

  it("finds clips by the ids the page shows", () => {
    expect(draftClipAt(draft(), "draft-2")).toEqual({ kind: "audio", track: 0, index: 0 });
    expect(() => draftClipAt(draft(), "draft-9")).toThrow("no draft clip");
  });

  it("trims the start of a clip and its linked sound, leaving a gap", () => {
    const next = reshapeDraftClip(draft(), "draft-0", { sourceIn: 22 });
    for (const track of [next.video[0], next.audio[0]]) expect(track.clips[0]).toMatchObject({ start: 2, end: 10, sourceIn: 22, sourceOut: 30 });
    expect(next.changes).toEqual(['Trimmed "A.mov" in to 22s']);
  });

  it("ripple-trims an end: later clips on every track and the markers close up", () => {
    // Split where the B-roll starts, so V1 is A.mov 0-3 s and 3-10 s.
    const split = arrangeSections(draft(), [{ start: 0, end: 3 }, { start: 3, end: 10 }]);
    const next = reshapeDraftClip(split, "draft-0", { sourceOut: 22, ripple: true });
    expect(next.video[0].clips.map((c) => [c.start, c.end, c.sourceIn])).toEqual([[0, 2, 20], [2, 9, 23]]);
    expect(next.audio[0].clips.map((c) => [c.start, c.end])).toEqual([[0, 2], [2, 9]]);
    expect(next.video[1].clips[0]).toMatchObject({ start: 2, end: 5 });
    expect(next.markers.map((m) => m.time)).toEqual([1, 7]);
    expect(next.duration).toBe(9);
    expect(next.changes[next.changes.length - 1]).toBe('Trimmed "A.mov" out to 22s, rippling later clips -1s');
  });

  it("refuses a ripple that would push a clip into one spanning the edit", () => {
    // Split at 5 s: B-roll on V2 is cut into 3-5 s and 5-6 s, and rippling the second overlaps the first.
    const halves = arrangeSections(draft(), [{ start: 0, end: 5 }, { start: 5, end: 10 }]);
    expect(() => reshapeDraftClip(halves, "draft-0", { sourceOut: 24, ripple: true })).toThrow('would make "B.mov" and "B.mov" overlap');
  });

  it("slips a retimed clip in source seconds and moves one to free space", () => {
    const slipped = reshapeDraftClip(draft(), "draft-1", { slip: 1 });
    expect(slipped.video[1].clips[0]).toMatchObject({ start: 3, end: 6, sourceIn: 1, sourceOut: 7 });
    const moved = reshapeDraftClip(draft(), "draft-1", { start: 7 });
    expect(moved.video[1].clips[0]).toMatchObject({ start: 7, end: 10, sourceIn: 0 });
  });

  it("refuses overlaps, nothing to keep, and mixed changes", () => {
    expect(() => reshapeDraftClip(draft(), "draft-1", { start: 1, track: 1 })).toThrow('V1 has "A.mov"');
    expect(() => reshapeDraftClip(draft(), "draft-0", { sourceIn: 31 })).toThrow("nothing of the clip");
    expect(() => reshapeDraftClip(draft(), "draft-2", { sourceIn: 21, withLinked: false })).toThrow("withLinked false goes with slip only");
    expect(() => reshapeDraftClip(draft(), "draft-0", { sourceIn: 10 })).toThrow("before the timeline");
    expect(() => reshapeDraftClip(draft(), "draft-0", { slip: 1, ripple: true })).toThrow("ripple goes with a trim");
    expect(() => reshapeDraftClip(draft(), "draft-0", { slip: 1, start: 2 })).toThrow("one kind of change");
  });
});

