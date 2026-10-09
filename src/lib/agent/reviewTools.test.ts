import { beforeEach, describe, expect, it, vi } from "vitest";

const ipc = vi.hoisted(() => ({ nleCall: vi.fn() }));
vi.mock("../ipc", () => ipc);
const jobs = vi.hoisted(() => ({ runJob: vi.fn() }));
vi.mock("../jobs", () => jobs);
const tauri = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => tauri);

import { deliveryChecks, forgetLastReview, lintTimeline, loudnessFindings, ordered, UNCHANGED_REVIEW_NOTE, type CheckFinding } from "./reviewTools";
import { executorsFor, runTool, type ToolContext } from "./tools";
import { fileKey } from "./transcriptTools";
import { emptyConnection, useConnectionStore } from "../../store/useConnectionStore";
import type { HostClip, HostTimeline, HostTrack } from "../../types/timeline";

const clip = (id: string, start: number, end: number, over: Partial<HostClip> = {}): HostClip => ({
  id,
  name: id,
  start,
  end,
  enabled: true,
  sourceIn: 0,
  filePath: `/m/${id}.mov`,
  ...over,
});

const track = (type: HostTrack["type"], index: number, clips: HostClip[], enabled: boolean | null = true): HostTrack => ({ type, index, name: "", enabled, clips });

const timeline = (tracks: HostTrack[], duration = 30): HostTimeline => ({
  project: "Doc",
  timeline: "Main",
  fps: 25,
  startTimecode: "00:00:00:00",
  duration,
  isCurrent: true,
  tracks,
  markers: [],
});

describe("the lint's view of a host timeline", () => {
  it("keeps the host's ids, links picture to sound, and leaves the picture silent", () => {
    const view = timeline([
      track("video", 1, [clip("v1", 0, 10, { linkedIds: ["a1"], filePath: "/m/cam.mov" })]),
      track("audio", 1, [clip("a1", 0, 10, { linkedIds: ["v1"], filePath: "/m/cam.mov", volumeDb: -6 }), clip("off", 10, 12, { enabled: false })]),
      track("video", 2, [clip("title", 2, 4, { filePath: undefined })]),
    ]);
    const input = lintTimeline(view);
    expect(input.tracks.map((t) => t.id)).toEqual(["V2", "V1", "A1"]);
    expect(input.clipsById.v1.volume).toBe(0);
    expect(input.clipsById.a1.volume).toBeCloseTo(0.501, 3);
    expect(input.clipsById.v1.linkId).toBe(input.clipsById.a1.linkId);
    expect(input.clipsById.off).toBeUndefined();
    // A title counts as picture, with no file and no sound.
    expect(input.assetsById[input.clipsById.title.mediaAssetId]).toMatchObject({ hasAudio: false });
    expect(input.frameRate).toBe(25);
  });

  it("marks offline media and carries the sync offsets found this connection", () => {
    const view = timeline([
      track("video", 1, [clip("cam", 0, 10, { offline: true })]),
      track("audio", 1, [clip("rec", 0, 10, { filePath: "/m/rec.wav" })]),
    ]);
    const input = lintTimeline(view, { "/m/cam.mov|/m/rec.wav": -2.5 });
    expect(input.offline?.has(fileKey("/m/cam.mov"))).toBe(true);
    expect(input.assetsById[fileKey("/m/cam.mov")].syncedAudio).toEqual([{ assetId: fileKey("/m/rec.wav"), offset: -2.5, method: "waveform" }]);
  });
});

describe("delivery checks", () => {
  const categories = (f: CheckFinding[]) => f.map((x) => [x.category, x.time]);

  it("finds offline media, switched-off clips and switched-off tracks", () => {
    const view = timeline([
      track("video", 1, [clip("v1", 0, 10, { offline: true }), clip("v2", 10, 20, { enabled: false })]),
      track("video", 2, [clip("v3", 4, 6)], false),
      track("audio", 1, [clip("a1", 0, 20, { filePath: "/m/a.wav" })]),
    ], 20);
    expect(categories(deliveryChecks(view))).toEqual([
      ["offline", 0],
      ["switched_off", 10],
      ["switched_off", 4],
    ]);
    // Out of range, nothing.
    expect(deliveryChecks(view, { start: 12, end: 14 }).map((f) => f.category)).toEqual(["switched_off"]);
  });

  it("finds a short stray after the end, but not a long second half", () => {
    const stray = timeline([track("video", 1, [clip("v1", 0, 60), clip("tail", 75, 77)]), track("audio", 1, [clip("a1", 0, 60, { filePath: "/m/a.wav" }), clip("a2", 75, 77, { filePath: "/m/a.wav" })])], 77);
    const found = deliveryChecks(stray).filter((f) => f.category === "past_end");
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ time: 75, clipIds: ["tail", "a2"] });
    const secondHalf = timeline([track("video", 1, [clip("v1", 0, 60), clip("part2", 63, 120)]), track("audio", 1, [clip("a1", 0, 120, { filePath: "/m/a.wav" })])], 120);
    expect(deliveryChecks(secondHalf).filter((f) => f.category === "past_end")).toEqual([]);
  });

  it("finds picture with no sound under it, only when the timeline has sound", () => {
    const view = timeline([
      track("video", 1, [clip("v1", 0, 20)]),
      track("audio", 1, [clip("a1", 0, 8, { filePath: "/m/a.wav" }), clip("quiet", 8, 12, { filePath: "/m/a.wav", volumeDb: -96 }), clip("a2", 12.5, 20, { filePath: "/m/a.wav" })]),
    ], 20);
    const gaps = deliveryChecks(view).filter((f) => f.category === "no_sound");
    expect(gaps.map((g) => [g.time, g.end, g.severity])).toEqual([[8, 12.5, "medium"]]);
    expect(deliveryChecks(timeline([track("video", 1, [clip("v1", 0, 20)])], 20))).toEqual([]);
  });

  it("checks loudness after each clip's level, and true peaks", () => {
    const rows = [
      { clipId: "a", name: "A", time: 0, levelDb: 0, integratedLufs: -14.5, truePeakDb: -3 },
      { clipId: "b", name: "B", time: 5, levelDb: 6, integratedLufs: -26, truePeakDb: -2 },
      { clipId: "c", name: "C", time: 9, levelDb: 0, integratedLufs: null, truePeakDb: null },
    ];
    const found = loudnessFindings(rows, -14);
    expect(found.map((f) => [f.clipIds[0], f.category, f.severity])).toEqual([
      ["b", "loudness", "medium"],
      ["b", "true_peak", "high"],
    ]);
    expect(found[0].message).toMatch(/-20\.0 LUFS, 6\.0 LU under/);
  });

  it("orders by time and keeps the most severe when there are too many", () => {
    const many: CheckFinding[] = Array.from({ length: 70 }, (_, i) => ({ time: i, severity: i < 5 ? "high" : "low", category: "no_sound", message: "", clipIds: [] }));
    const kept = ordered(many);
    expect(kept).toHaveLength(60);
    expect(kept.filter((f) => f.severity === "high")).toHaveLength(5);
    expect(kept.map((f) => f.time)).toEqual([...kept.map((f) => f.time)].sort((a, b) => a - b));
  });
});

describe("review_edit", () => {
  const context: ToolContext = { host: "resolve", timeline: "Main", step: "s1", stepText: "check it" };
  let view: HostTimeline;

  beforeEach(() => {
    vi.clearAllMocks();
    forgetLastReview();
    useConnectionStore.setState({ connections: { premiere: emptyConnection("Doc"), resolve: emptyConnection("Doc") } });
    view = timeline([
      // A 2-frame flash at 10 s, then black from 10.08 to 11.
      track("video", 1, [clip("v1", 0, 10, { linkedIds: ["a1"], filePath: "/m/int.mov" }), clip("flash", 10, 10.08), clip("v2", 11, 20, { filePath: "/m/int.mov", sourceIn: 11 })]),
      // The interview's sound, cut inside "hello" at 4.2 s of the file.
      track("audio", 1, [clip("a1", 0, 4.2, { linkedIds: ["v1"], filePath: "/m/int.mov" }), clip("a2", 4.2, 20, { filePath: "/m/int.mov", sourceIn: 6 })]),
    ], 20);
    ipc.nleCall.mockImplementation(async (_h: string, command: string) => {
      if (command === "read_timeline") return view;
      throw new Error(`unexpected ${command}`);
    });
    tauri.invoke.mockImplementation(async (command: string) => {
      if (command === "read_transcript") return { segments: [{ start: 3.5, end: 5, text: "hello there", speaker: "S1", words: [{ text: "hello", start: 4, end: 4.5 }, { text: "there", start: 4.6, end: 5 }] }] };
      return null;
    });
    jobs.runJob.mockImplementation(async (command: string, _label: string, request: { ranges?: unknown[] }) => {
      // Loud enough everywhere that the cut inside the word is heard.
      if (command === "audio-peaks") return { result: { peaks: { "/m/int.mov": { peaksPerSecond: 100, mins: Array(3000).fill(-0.3), maxes: Array(3000).fill(0.3) } } } };
      if (command === "media-loudness") return { result: { levels: (request.ranges ?? []).map((_, index) => ({ index, integratedLufs: -20, loudnessRange: 3, truePeakDb: -6, maxShortTermLufs: -17 })) } };
      throw new Error(`unexpected job ${command}`);
    });
  });

  it("reports the lint's and the delivery findings, with clip ids, as rows for the card", async () => {
    const out = await runTool(executorsFor(context), "review_edit", {});
    const result = out.result as { automaticCheck: { category: string; time: number; clipIds: string[] }[] };
    const cats = result.automaticCheck.map((f) => f.category);
    expect(cats).toEqual(expect.arrayContaining(["mid_word_cut", "flash_frame", "black"]));
    expect(result.automaticCheck.find((f) => f.category === "mid_word_cut")).toMatchObject({ time: 4.2 });
    expect(result.automaticCheck.find((f) => f.category === "flash_frame")?.clipIds).toEqual(["flash"]);
    expect(out.summary).toMatch(/problem\(s\) found by the automatic check/);
    expect(out.findings?.length).toBe(result.automaticCheck.length);
    expect(out.findings?.[0]).toMatchObject({ source: "check" });
    // No loudness target: nothing is measured.
    expect(jobs.runJob.mock.calls.map((c) => c[0])).toEqual(["audio-peaks"]);
  });

  it("measures loudness against a target and keeps to the range", async () => {
    const out = await runTool(executorsFor(context), "review_edit", { startTime: 12, endTime: 20, targetLufs: -14 });
    const result = out.result as { automaticCheck: { category: string; time: number; clipIds: string[] }[] };
    expect(result.automaticCheck.map((f) => f.category)).toEqual(["loudness"]);
    expect(result.automaticCheck[0]).toMatchObject({ time: 12, clipIds: ["a2"] });
    const loudness = jobs.runJob.mock.calls.find((c) => c[0] === "media-loudness");
    // a2 plays the file from 6 s at 4.2 s, so 12–20 s of the timeline is 13.8–21.8 s of the file.
    expect(loudness?.[2]).toEqual({ ranges: [{ path: "/m/int.mov", start: expect.closeTo(13.8, 6), end: expect.closeTo(21.8, 6) }] });
  });

  it("answers an unchanged timeline from the last review, and reviews again after a change", async () => {
    const executors = executorsFor(context);
    await runTool(executors, "review_edit", {});
    const again = await runTool(executors, "review_edit", {});
    expect(again.summary).toMatch(/unchanged since the last review/);
    expect((again.result as { note: string }).note).toBe(UNCHANGED_REVIEW_NOTE);
    expect(jobs.runJob).toHaveBeenCalledTimes(1);
    view = { ...view, tracks: view.tracks.map((t) => (t.type === "video" ? { ...t, clips: t.clips.filter((c) => c.id !== "flash") } : t)) };
    const fresh = await runTool(executors, "review_edit", {});
    expect(fresh.summary).not.toMatch(/unchanged/);
    expect((fresh.result as { automaticCheck: { category: string }[] }).automaticCheck.map((f) => f.category)).not.toContain("flash_frame");
  });

  it("refuses a backwards range and an impossible target", async () => {
    expect((await runTool(executorsFor(context), "review_edit", { startTime: 5, endTime: 2 })).result).toMatchObject({ error: expect.stringMatching(/endTime must be after/) });
    expect((await runTool(executorsFor(context), "review_edit", { targetLufs: 3 })).result).toMatchObject({ error: expect.stringMatching(/targetLufs/) });
  });
});
