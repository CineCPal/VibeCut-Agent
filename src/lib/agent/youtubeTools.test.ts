import { beforeEach, describe, expect, it, vi } from "vitest";

const ipc = vi.hoisted(() => ({ nleCall: vi.fn(), startSidecar: vi.fn(), cancelSidecar: vi.fn() }));
vi.mock("../ipc", () => ipc);
const core = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ ...core, convertFileSrc: (p: string) => p }));
const jobs = vi.hoisted(() => ({ runJob: vi.fn() }));
vi.mock("../jobs", () => jobs);

import { executorsFor, runTool, type ToolContext } from "./tools";
import { chapterTime, checkChapters, pickThumbnails, thumbnailMoments, type Scored } from "./youtubeTools";
import { timelineShots } from "./pacingTools";
import { emptyConnection, useConnectionStore } from "../../store/useConnectionStore";
import { initialHosts, useNleStateStore } from "../../store/useNleStateStore";
import { nleState } from "../../test/nleFixtures";
import type { HostClip, HostTimeline } from "../../types/timeline";

const clip = (id: string, start: number, end: number, sourceIn: number, filePath: string): HostClip => ({ id, name: id, start, end, enabled: true, sourceIn, sourceOut: sourceIn + end - start, filePath });
/** 60 s: an interview on V1 (sourced from 100 s in), B-roll on V2 at 10-14 s and a 2 s cutaway at 30-32 s. */
const TIMELINE: HostTimeline = {
  project: "Doc",
  timeline: "Main",
  fps: 25,
  startTimecode: "00:00:00:00",
  duration: 60,
  isCurrent: true,
  tracks: [
    { type: "video", index: 1, name: "", enabled: true, clips: [clip("v1", 0, 60, 100, "/m/cam.mov")] },
    { type: "video", index: 2, name: "", enabled: true, clips: [clip("b1", 10, 14, 0, "/m/b1.mov"), clip("b2", 30, 32, 5, "/m/b2.mov")] },
  ],
  markers: [],
};

describe("chapters", () => {
  it("formats times as YouTube reads them", () => {
    expect(chapterTime(0, false)).toBe("0:00");
    expect(chapterTime(754.9, false)).toBe("12:34");
    expect(chapterTime(3723, true)).toBe("1:02:03");
    expect(chapterTime(65, true)).toBe("0:01:05");
  });

  it("moves a first chapter near the start to 0:00 and lists what breaks the rules", () => {
    const ok = checkChapters([{ time: 40, title: "Results" }, { time: 4, title: " Intro " }, { time: 20, title: "How it started" }], 60);
    expect(ok.problems).toEqual([]);
    expect(ok.fixed).toEqual(['"Intro" moved from 0:04 to 0:00 (YouTube\'s first chapter starts the video)']);
    expect(ok.text).toBe("0:00 Intro\n0:20 How it started\n0:40 Results");
    const bad = checkChapters([{ time: 30, title: "Late" }, { time: 52, title: "Short end" }], 60);
    expect(bad.problems).toEqual([
      "the first chapter must start at 0:00: add one for the opening (it's 0:30 now)",
      "YouTube needs at least 3 chapters (there are 2)",
      '"Short end" is 8s long; each chapter must be at least 10s (merge it or move a boundary)',
    ]);
  });
});

describe("thumbnail moments and picks", () => {
  it("samples each shot where a file is seen, in file time", () => {
    const moments = thumbnailMoments(TIMELINE, timelineShots(TIMELINE));
    // v1 0-10 (3), b1 10-14 (3), v1 14-30 (3), b2 30-32 (middle only), v1 32-60 (3).
    expect(moments.map((m) => [m.time, m.clipId])).toEqual([
      [2.5, "v1"], [5, "v1"], [7.5, "v1"], [11, "b1"], [12, "b1"], [13, "b1"], [18, "v1"], [22, "v1"], [26, "v1"], [31, "b2"], [39, "v1"], [46, "v1"], [53, "v1"],
    ]);
    expect(moments[0].fileTime).toBe(102.5);
    expect(moments[9].fileTime).toBe(6);
    expect(thumbnailMoments(TIMELINE, timelineShots(TIMELINE), 4).map((m) => m.time)).toEqual([2.5, 11, 18, 31]);
  });

  it("picks the best of different shots, never two at one moment, leaving dark frames out", () => {
    const at = (time: number, shot: number, score: number): Scored => ({ time, shot, score, path: "/m/a.mov", fileTime: time, clipId: "c", name: "c", sharpness: 0, exposure: 0, colour: 0 });
    const scored = [at(1, 0, 90), at(1.5, 0, 89), at(5, 0, 80), at(12, 1, 60), at(20, 2, 0)];
    expect(pickThumbnails(scored, 2).map((s) => s.time)).toEqual([1, 12]);
    // Past one a shot, the next best of any shot that isn't at the same moment.
    expect(pickThumbnails(scored, 4).map((s) => s.time)).toEqual([1, 12, 5]);
  });
});

describe("the YouTube tools", () => {
  const ctx: ToolContext = { host: "resolve", timeline: "Main", step: "y1", stepText: "package it for YouTube" };
  const tool = (name: string, args: Record<string, unknown>) => runTool(executorsFor(ctx), name, args);
  const errorOf = (outcome: { result: unknown }) => String((outcome.result as { error?: unknown }).error);

  beforeEach(() => {
    vi.clearAllMocks();
    useConnectionStore.setState({ connections: { premiere: emptyConnection("Doc"), resolve: emptyConnection("Doc") } });
    useNleStateStore.setState({ hosts: { ...initialHosts(), resolve: nleState("resolve") } });
    ipc.nleCall.mockImplementation(async (_host: string, command: string, args: { times?: number[] }) =>
      command === "export_stills" ? { folder: "/r/Doc", stills: (args.times ?? []).map((t) => ({ time: t, path: `/r/Doc/Main thumbnail ${t}.png` })) } : TIMELINE,
    );
  });

  it("make_chapters gives the list to paste, or what to fix", async () => {
    const ok = await tool("make_chapters", { chapters: [{ time: 0, title: "Intro" }, { time: 20, title: "Middle" }, { time: 40, title: "End" }] });
    expect(ok.summary).toBe("3 chapters ready for YouTube\n0:00 Intro\n0:20 Middle\n0:40 End");
    const short = await tool("make_chapters", { chapters: [{ time: 0, title: "Intro" }, { time: 20, title: "Middle" }, { time: 40, title: "End" }], end: 45 });
    expect((short.result as { ok: boolean }).ok).toBe(false);
    expect(short.summary).toContain('"End" is 5s long');
    expect(errorOf(await tool("make_chapters", { chapters: [{ time: -1, title: "x" }] }))).toContain("chapters[0].time");
  });

  it("find_thumbnails scores the moments and shows the best on one sheet", async () => {
    jobs.runJob.mockImplementation(async (name: string, _title: string, request: { frames?: { path: string; time: number }[] }) => {
      if (name === "media-thumbs") {
        return { result: { frames: request.frames!.map((f, index) => ({ index, ok: true, score: f.path === "/m/b1.mov" ? 80 : f.path === "/m/b2.mov" ? 0 : 50 + index, sharpness: 70, exposure: 80, colour: 40 })) } };
      }
      return { result: { images: [{ mime: "image/jpeg", data: "AAAA" }], frames: [] } };
    });
    const out = await tool("find_thumbnails", { count: 3 });
    const frames = jobs.runJob.mock.calls[0][2].frames as unknown[];
    expect(jobs.runJob.mock.calls[0][0]).toBe("media-thumbs");
    expect(frames).toHaveLength(13);
    const candidates = (out.result as { candidates: { time: number; clipId: string }[] }).candidates;
    // The B-roll first (80), then the interview's two best, from different shots.
    expect(candidates.map((c) => [c.time, c.clipId])).toEqual([[11, "b1"], [53, "v1"], [26, "v1"]]);
    expect(jobs.runJob.mock.calls[1][0]).toBe("media-frames");
    expect(jobs.runJob.mock.calls[1][2].shots[0]).toEqual({ path: "/m/b1.mov", time: 1, label: "11.0s" });
    expect(out.images).toHaveLength(1);
  });

  it("export_thumbnails saves the editor's frames and makes the YouTube JPEGs", async () => {
    jobs.runJob.mockResolvedValue({ result: { jpegs: [{ from: "/r/Doc/Main thumbnail 11.png", path: "/r/Doc/Main thumbnail 11 YouTube.jpg", width: 1280, height: 720, bytes: 300000 }] } });
    const out = await tool("export_thumbnails", { times: [11] });
    expect(ipc.nleCall).toHaveBeenCalledWith("resolve", "export_stills", { timeline: "Main", times: [11] });
    expect(jobs.runJob).toHaveBeenCalledWith("media-thumbs", "Make 1 YouTube thumbnail(s)", { youtube: ["/r/Doc/Main thumbnail 11.png"] });
    expect(out.summary).toBe("Saved 1 still(s) in /r/Doc\n11.0s: Main thumbnail 11.png\nand 1 YouTube JPEG(s): Main thumbnail 11 YouTube.jpg");
    jobs.runJob.mockClear();
    await tool("export_thumbnails", { times: [11], youtube: false });
    expect(jobs.runJob).not.toHaveBeenCalled();
    expect(errorOf(await tool("export_thumbnails", { times: [] }))).toContain("times must list 1 to 12");
  });
});
