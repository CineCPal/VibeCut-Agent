import { beforeEach, describe, expect, it, vi } from "vitest";

const ipc = vi.hoisted(() => ({ nleCall: vi.fn(), startSidecar: vi.fn(), cancelSidecar: vi.fn() }));
vi.mock("../ipc", () => ipc);
const jobs = vi.hoisted(() => ({ runJob: vi.fn() }));
vi.mock("../jobs", () => jobs);

import { closeGaps, findGaps, replaceDraftClip, type Replacement } from "./draftEditTools";
import { forgetMediaFacts } from "./mediaInfo";
import { executorsFor, runTool, type ToolContext } from "./tools";
import { emptyConnection, useConnectionStore } from "../../store/useConnectionStore";
import { initialHosts, useNleStateStore } from "../../store/useNleStateStore";
import { nleState } from "../../test/nleFixtures";
import { insertDraftClip, overwriteDraftClip, type DraftClip, type HostDraft } from "../../vibecut/lib/connect/hostDraft";
import type { HostClip, HostTimeline } from "../../types/timeline";

const clip = (sourcePath: string, start: number, end: number, sourceIn: number, extra: Partial<DraftClip> = {}): DraftClip => ({
  sourcePath,
  sourceName: sourcePath.slice(3),
  start,
  end,
  sourceIn,
  sourceOut: sourceIn + end - start,
  speed: 1,
  enabled: true,
  volumeDb: null,
  ...extra,
});

/** A from 2 to 6 s and B from 8 to 12 s, picture and sound linked; B-roll on V2 from 9 to 10 s; the
 * timeline runs on to 14 s. Gaps everywhere: 0–2, 6–8 and 12–14. */
const DRAFT: HostDraft = {
  base: "Interview",
  fps: 25,
  duration: 14,
  video: [
    { type: "video", clips: [clip("/m/a.mov", 2, 6, 10, { linkGroup: "a" }), clip("/m/b.mov", 8, 12, 0, { linkGroup: "b" })] },
    { type: "video", clips: [clip("/m/broll.mov", 9, 10, 0)] },
  ],
  audio: [{ type: "audio", clips: [clip("/m/a.mov", 2, 6, 10, { linkGroup: "a", volumeDb: -3 }), clip("/m/b.mov", 8, 12, 0, { linkGroup: "b" })] }],
  markers: [
    { time: 7, name: "In the gap", color: "Blue", note: "", duration: 0 },
    { time: 9, name: "On B", color: "Blue", note: "", duration: 0 },
  ],
  notCarried: [],
  changes: [],
};
const spans = (clips: DraftClip[]) => clips.map((c) => [c.start, c.end, c.sourceIn, c.sourceOut]);

describe("close gaps", () => {
  it("finds the stretches where every track is empty, the end included", () => {
    expect(findGaps(DRAFT)).toEqual([
      { start: 0, end: 2 },
      { start: 6, end: 8 },
      { start: 12, end: 14 },
    ]);
    expect(findGaps(DRAFT, { minSeconds: 3 })).toEqual([]);
    expect(findGaps(DRAFT, { from: 5, to: 9 })).toEqual([{ start: 6, end: 8 }]);
  });

  it("moves everything after each gap earlier on every track, and keeps every marker", () => {
    const next = closeGaps(DRAFT);
    expect(spans(next.video[0].clips)).toEqual([
      [0, 4, 10, 14],
      [4, 8, 0, 4],
    ]);
    expect(spans(next.video[1].clips)).toEqual([[5, 6, 0, 1]]);
    expect(spans(next.audio[0].clips)).toEqual(spans(next.video[0].clips));
    expect(next.audio[0].clips[0].volumeDb).toBe(-3);
    expect(next.markers.map((m) => [m.name, m.time])).toEqual([
      ["In the gap", 4],
      ["On B", 5],
    ]);
    expect(next.duration).toBe(8);
    expect(next.changes).toEqual(["Closed 3 gaps (6s)"]);
  });

  it("leaves a stretch only some tracks are empty in, and says when there's nothing to close", () => {
    const full: HostDraft = { ...DRAFT, video: [DRAFT.video[1]], audio: [{ type: "audio", clips: [clip("/m/song.wav", 0, 14, 0)] }] };
    expect(() => closeGaps(full)).toThrow("There are no gaps");
    expect(() => closeGaps(DRAFT, { minSeconds: 5 })).toThrow("no gaps of 5s or more");
  });
});

describe("insert and overwrite without picture", () => {
  it("inserts a sound-only file on audio alone, still moving every track", () => {
    const next = insertDraftClip(DRAFT, { sourcePath: "/m/vo.wav", sourceIn: 0, sourceOut: 2, at: 8, audioTrack: 2, withPicture: false });
    expect(next.video[0].clips.map((c) => c.sourcePath)).toEqual(["/m/a.mov", "/m/b.mov"]);
    expect(spans(next.video[0].clips)[1]).toEqual([10, 14, 0, 4]);
    expect(spans(next.audio[1].clips)).toEqual([[8, 10, 0, 2]]);
    expect(next.audio[1].clips[0].linkGroup).toBeUndefined();
  });

  it("overwrites picture alone, leaving the sound under it", () => {
    const next = overwriteDraftClip(DRAFT, { sourcePath: "/m/c.mov", sourceIn: 0, sourceOut: 1, at: 3, withSound: false });
    expect(spans(next.video[0].clips).slice(0, 3)).toEqual([
      [2, 3, 10, 11],
      [3, 4, 0, 1],
      [4, 6, 12, 14],
    ]);
    expect(next.audio).toEqual(DRAFT.audio);
    expect(next.changes[0]).toBe("Overwrote 1s at 3s on V1 with c.mov");
    expect(() => insertDraftClip(DRAFT, { sourcePath: "/m/c.mov", sourceIn: 0, sourceOut: 1, at: 3, withSound: false, withPicture: false })).toThrow("picture, its sound or both");
  });
});

const NEW: Replacement = { sourcePath: "/m/c.mov", sourceIn: 5, keepLinked: false, hasPicture: true, hasSound: true, length: 30 };

describe("replace a clip", () => {
  it("puts the new file's picture and sound in the clip's place, keeping its level", () => {
    const next = replaceDraftClip(DRAFT, "draft-0", NEW);
    const [v, a] = [next.video[0].clips[0], next.audio[0].clips[0]];
    expect([v.sourcePath, ...spans([v])[0]]).toEqual(["/m/c.mov", 2, 6, 5, 9]);
    expect([a.sourcePath, ...spans([a])[0], a.volumeDb]).toEqual(["/m/c.mov", 2, 6, 5, 9, -3]);
    expect(v.linkGroup).toBe(a.linkGroup);
    expect(v.linkGroup).not.toBe("a");
    expect(v.originId).toBeUndefined();
    expect(next.video[0].clips[1]).toBe(DRAFT.video[0].clips[1]);
    expect(next.changes[0]).toBe('Replaced "a.mov" at 2s (4s) with c.mov from 5s');
  });

  it("keeps the linked sound when asked, and takes it out when the new file has none", () => {
    const kept = replaceDraftClip(DRAFT, "draft-0", { ...NEW, keepLinked: true });
    expect(kept.audio[0].clips[0]).toBe(DRAFT.audio[0].clips[0]);
    expect(kept.video[0].clips[0].linkGroup).toBeUndefined();
    const silent = replaceDraftClip(DRAFT, "draft-0", { ...NEW, hasSound: false });
    expect(silent.audio[0].clips.map((c) => c.sourcePath)).toEqual(["/m/b.mov"]);
    expect(silent.changes[0]).toContain("linked sound taken out (c.mov has none)");
  });

  it("refuses a file too short to fill the clip, or without the part it replaces", () => {
    expect(() => replaceDraftClip(DRAFT, "draft-0", { ...NEW, length: 7 })).toThrow("c.mov is 7s long, so from 5s it has 2s, and the clip is 4s");
    expect(() => replaceDraftClip(DRAFT, "draft-0", { ...NEW, sourcePath: "/m/vo.wav", hasPicture: false })).toThrow("vo.wav has no picture");
    // draft-3 is A1's first clip.
    expect(() => replaceDraftClip(DRAFT, "draft-3", { ...NEW, hasSound: false })).toThrow("c.mov has no sound");
  });

  it("keeps a sound clip's channel when the new file has it", () => {
    const split: HostDraft = { ...DRAFT, audio: [{ type: "audio", clips: [clip("/m/a.mov", 2, 6, 10, { linkGroup: "a", channels: [2] })] }] };
    expect(replaceDraftClip(split, "draft-0", { ...NEW, channels: 2 }).audio[0].clips[0].channels).toEqual([2]);
    expect(replaceDraftClip(split, "draft-0", { ...NEW, channels: 1 }).audio[0].clips[0].channels).toBeUndefined();
  });
});

const hclip = (id: string, start: number, end: number, filePath: string, sourceIn: number, linkedIds?: string[]): HostClip => ({
  id,
  name: id,
  start,
  end,
  enabled: true,
  sourceIn,
  sourceOut: sourceIn + end - start,
  filePath,
  ...(linkedIds ? { linkedIds } : {}),
});
const TIMELINE: HostTimeline = {
  project: "Doc",
  timeline: "Main",
  fps: 25,
  startTimecode: "00:00:00:00",
  duration: 12,
  isCurrent: true,
  tracks: [
    { type: "video", index: 1, name: "", enabled: true, clips: [hclip("va", 0, 4, "/m/a.mov", 0, ["aa"]), hclip("vb", 6, 12, "/m/b.mov", 0, ["ab"])] },
    { type: "audio", index: 1, name: "", enabled: true, clips: [hclip("aa", 0, 4, "/m/a.mov", 0, ["va"]), hclip("ab", 6, 12, "/m/b.mov", 0, ["vb"])] },
  ],
  markers: [],
};
const ctx: ToolContext = { host: "resolve", timeline: "Main", step: "s1", stepText: "tighten it" };
const FACTS = {
  "/m/c.mov": { duration: 20, video: { codec: "prores", width: 1920, height: 1080, fps: 25 }, audio: { codec: "pcm", channels: 2, sampleRate: 48000 } },
  "/m/vo.wav": { duration: 3, video: null, audio: { codec: "pcm", channels: 1, sampleRate: 48000 } },
};

describe("the draft edit tools", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    forgetMediaFacts();
    useConnectionStore.setState({ connections: { premiere: emptyConnection("Doc"), resolve: emptyConnection("Doc") } });
    useNleStateStore.setState({ hosts: { ...initialHosts(), resolve: nleState("resolve") } });
    ipc.nleCall.mockResolvedValue(TIMELINE);
    jobs.runJob.mockImplementation(async (_kind: string, _title: string, input: { paths: string[] }) => ({
      result: { info: Object.fromEntries(input.paths.filter((p) => p in FACTS).map((p) => [p, FACTS[p as keyof typeof FACTS]])) },
    }));
  });

  const draft = () => useConnectionStore.getState().connections.resolve.draft!;

  it("close_gaps opens a draft and closes them", async () => {
    const out = await runTool(executorsFor(ctx), "close_gaps", {});
    expect(out.summary).toBe("Draft: Closed 1 gap (2s); now 10.0s");
    expect(draft().video[0].clips.map((c) => [c.start, c.end])).toEqual([
      [0, 4],
      [4, 10],
    ]);
  });

  it("insert_clip puts a WAV on audio alone, and refuses one cut past its end", async () => {
    const out = await runTool(executorsFor(ctx), "insert_clip", { path: "/m/vo.wav", sourceOut: 2, at: 4, audioTrack: 2 });
    expect(out.summary).toContain("Inserted vo.wav at 4s (2s)");
    expect(draft().video[0].clips.map((c) => c.start)).toEqual([0, 8]);
    expect(draft().audio[1].clips.map((c) => [c.sourcePath, c.start, c.end])).toEqual([["/m/vo.wav", 4, 6]]);
    const late = await runTool(executorsFor(ctx), "insert_clip", { path: "/m/vo.wav", sourceOut: 5, at: 0 });
    expect(String((late.result as { error?: unknown }).error)).toContain("vo.wav is 3s long");
  });

  it("insert_clip overwrites when asked", async () => {
    await runTool(executorsFor(ctx), "insert_clip", { path: "/m/c.mov", sourceIn: 1, sourceOut: 3, at: 1, mode: "overwrite" });
    expect(draft().video[0].clips.map((c) => [c.sourcePath, c.start, c.end])).toEqual([
      ["/m/a.mov", 0, 1],
      ["/m/c.mov", 1, 3],
      ["/m/a.mov", 3, 4],
      ["/m/b.mov", 6, 12],
    ]);
    expect(draft().duration).toBe(12);
  });

  it("replace_clip takes the timeline's own clip id", async () => {
    const out = await runTool(executorsFor(ctx), "replace_clip", { clipId: "vb", path: "/m/c.mov", sourceIn: 2 });
    expect(out.summary).toContain('Replaced "vb" at 6s (6s) with c.mov from 2s');
    expect(draft().audio[0].clips[1].sourcePath).toBe("/m/c.mov");
    const short = await runTool(executorsFor(ctx), "replace_clip", { clipId: "draft-0", path: "/m/c.mov", sourceIn: 18 });
    expect(String((short.result as { error?: unknown }).error)).toContain("c.mov is 20s long");
    const still = await runTool(executorsFor(ctx), "replace_clip", { clipId: "draft-0", path: "/m/card.png" });
    expect(String((still.result as { error?: unknown }).error)).toContain("card.png is a still");
  });
});
