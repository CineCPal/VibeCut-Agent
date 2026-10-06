import { describe, expect, it } from "vitest";
import { CONTEXT_CLIP_LIMIT, linkGroups, snapshotHeader, timelineLines } from "./snapshot";
import type { HostTimeline } from "../../types/timeline";

const timeline = (over: Partial<HostTimeline> = {}): HostTimeline => ({
  project: "Doc",
  timeline: "Main",
  fps: 23.976,
  startTimecode: "01:00:00:00",
  duration: 10,
  isCurrent: true,
  tracks: [
    {
      type: "video",
      index: 1,
      name: "Video 1",
      enabled: true,
      clips: [
        { id: "v1", name: "A.mov", start: 0, end: 3, enabled: true, sourceIn: 2, linkedIds: ["a1"] },
        { id: "x1", name: "Cross Dissolve", start: 2.5, end: 3.5, enabled: true, kind: "effect" },
      ],
    },
    {
      type: "audio",
      index: 1,
      name: "",
      enabled: false,
      clips: [{ id: "a1", name: "A.mov", start: 0, end: 3, enabled: false, volumeDb: -6, speed: 2, linkedIds: ["v1"] }],
    },
  ],
  markers: [{ id: "m1", time: 1, name: "Hook", color: "Red", note: "strong line", duration: 0 }],
  ...over,
});

describe("snapshot", () => {
  it("lists tracks, clips, links and markers like VibeCut's", () => {
    expect(timelineLines(timeline())).toEqual([
      'V1 "Video 1": 2 clip(s)',
      '  v1 "A.mov" 0.0s–3.0s (from 2.0s, link L1)',
      '  x1 "Cross Dissolve" 2.5s–3.5s (transition/generator)',
      "A1 (off): 1 clip(s)",
      '  a1 "A.mov" 0.0s–3.0s (speed 200%, -6 dB, off, link L1)',
      'Markers:\n  m1 1.0s Red "Hook" (strong line)',
    ]);
  });

  it("groups linked clips by their smallest id", () => {
    expect(linkGroups(timeline())).toEqual(new Map([["v1", "a1"], ["a1", "a1"]]));
  });

  it("abridges long timelines", () => {
    const clips = Array.from({ length: CONTEXT_CLIP_LIMIT + 5 }, (_, i) => ({ id: `c${i}`, name: "x", start: i, end: i + 1, enabled: true }));
    const lines = timelineLines(timeline({ tracks: [{ type: "video", index: 1, name: "", enabled: true, clips }], markers: [] }));
    expect(lines).toContain("(abridged: 5 more clip(s); call list_timeline_clips)");
    expect(lines.at(-1)).toBe("Markers: none");
  });

  it("heads the snapshot, or says what's missing", () => {
    expect(snapshotHeader("premiere", timeline()).split("\n")[0]).toBe(
      '[Premiere sequence "Main" in project "Doc", 23.976 fps, 10.0s long, starts at 01:00:00:00]',
    );
    expect(snapshotHeader("resolve", null)).toBe("[Resolve timeline: none open (create_timeline makes one)]");
    expect(snapshotHeader("resolve", null, "couldn't be read")).toBe("[Resolve timeline: couldn't be read]");
    expect(snapshotHeader(null, null)).toMatch(/^\[No editor connected/);
  });
});
