import { beforeEach, describe, expect, it, vi } from "vitest";

const ipc = vi.hoisted(() => ({ nleCall: vi.fn() }));
vi.mock("../ipc", () => ipc);
const jobs = vi.hoisted(() => ({ runJob: vi.fn() }));
vi.mock("../jobs", () => jobs);

import { pictureAt, sourceTime, spread } from "./visionTools";
import { executorsFor, runTool, type ToolContext } from "./tools";
import { withImagesKept } from "./controller";
import { forgetMediaFacts } from "./mediaInfo";
import { imagesLeft, MAX_TURN_IMAGES, resetTurnImagesForTests, takeImages } from "./turnImages";
import { emptyConnection, useConnectionStore } from "../../store/useConnectionStore";
import type { HostClip, HostTimeline } from "../../types/timeline";

const clip = (id: string, start: number, end: number, over: Partial<HostClip> = {}): HostClip => ({
  id,
  name: `${id}.mov`,
  start,
  end,
  enabled: true,
  sourceIn: 10,
  filePath: `/m/${id}.mov`,
  ...over,
});

const VIEW: HostTimeline = {
  project: "Doc",
  timeline: "Main",
  fps: 25,
  startTimecode: "00:00:00:00",
  duration: 20,
  isCurrent: true,
  tracks: [
    { type: "video", index: 1, name: "", enabled: true, clips: [clip("a", 0, 8), clip("b", 8, 14, { speed: 2 })] },
    { type: "video", index: 2, name: "", enabled: true, clips: [clip("over", 4, 6), clip("off", 10, 12, { enabled: false }), clip("title", 12, 13, { kind: "effect", filePath: undefined })] },
    { type: "video", index: 3, name: "", enabled: false, clips: [clip("hidden", 0, 20)] },
    { type: "audio", index: 1, name: "", enabled: true, clips: [clip("snd", 0, 8)] },
  ],
  markers: [],
  inOut: { in: 2, out: 6 },
};

const SHEET = { mime: "image/jpeg", data: "aGk=", width: 1536, height: 900 };

describe("where frames come from", () => {
  it("spreads frames over a span, in the middle of each part", () => {
    expect(spread(0, 6, 3)).toEqual([1, 3, 5]);
    expect(spread(2, 4, 1)).toEqual([3]);
    expect(spread(0, 1, 50)).toHaveLength(12);
  });

  it("maps timeline time to file time through the clip's speed", () => {
    expect(sourceTime(clip("x", 4, 8), 5)).toBe(11);
    expect(sourceTime(clip("x", 4, 8, { speed: 2 }), 5)).toBe(12);
    expect(sourceTime(clip("x", 4, 8, { speed: -1 }), 5)).toBe(9);
  });

  it("sees the highest picture that's on", () => {
    expect(pictureAt(VIEW, 5)?.clip.id).toBe("over");
    expect(pictureAt(VIEW, 7)?.clip.id).toBe("a");
    // A clip that's off, a title and a track that's off don't count.
    expect(pictureAt(VIEW, 11)?.clip.id).toBe("b");
    expect(pictureAt(VIEW, 12.5)?.clip.id).toBe("b");
    expect(pictureAt(VIEW, 16)).toBeNull();
  });
});

describe("the look_at tools", () => {
  const context: ToolContext = { host: "resolve", timeline: "Main", step: "s1", stepText: "look" };

  beforeEach(() => {
    resetTurnImagesForTests();
    forgetMediaFacts();
    jobs.runJob.mockReset();
    ipc.nleCall.mockReset();
    ipc.nleCall.mockImplementation(async (_host: string, command: string) => (command === "read_timeline" ? VIEW : {}));
    jobs.runJob.mockImplementation(async (command: string, _label: string, request: { shots: unknown[] }) =>
      command === "media-frames" ? { status: "done", result: { images: [SHEET], frames: request.shots.map((_, i) => ({ index: i + 1, label: "", ok: true })) } } : { status: "done", result: {} },
    );
    useConnectionStore.setState({ connections: { premiere: emptyConnection("Doc"), resolve: emptyConnection("Doc") } });
  });

  const shotsSent = () => (jobs.runJob.mock.calls.find((c) => c[0] === "media-frames")![2] as { shots: { path: string; time: number; label: string }[] }).shots;

  it("look_at_clip spreads frames over the clip and labels them with timeline time", async () => {
    const outcome = await runTool(executorsFor(context), "look_at_clip", { clipId: "b", count: 3 });
    expect(outcome.images).toEqual([SHEET]);
    expect(shotsSent()).toEqual([
      { path: "/m/b.mov", time: 12, label: "9.0s on the timeline" },
      { path: "/m/b.mov", time: 16, label: "11.0s on the timeline" },
      { path: "/m/b.mov", time: 20, label: "13.0s on the timeline" },
    ]);
    expect(outcome.result).toMatchObject({ speed: "200%: file times follow the clip's speed" });
  });

  it("look_at_clip refuses sound, effects and times outside the clip", async () => {
    expect(((await runTool(executorsFor(context), "look_at_clip", { clipId: "snd" })).result as { error: string }).error).toMatch(/sound only/);
    expect(((await runTool(executorsFor(context), "look_at_clip", { clipId: "title" })).result as { error: string }).error).toMatch(/no media file/);
    expect(((await runTool(executorsFor(context), "look_at_clip", { clipId: "a", times: [9] })).result as { error: string }).error).toMatch(/outside a/);
    expect(jobs.runJob).not.toHaveBeenCalled();
  });

  it("look_at_timeline takes the In–Out by default and lists gaps", async () => {
    await runTool(executorsFor(context), "look_at_timeline", { count: 2 });
    expect(shotsSent().map((s) => s.label)).toEqual(['3.0s · V1 "a.mov"', '5.0s · V2 "over.mov"']);
    const outcome = await runTool(executorsFor(context), "look_at_timeline", { times: [7, 16] });
    expect(outcome.result).toMatchObject({ frames: [{ n: 1, clipId: "a" }], gaps: ["16.0s: no picture (black)"] });
  });

  it("look_at_media reads a project clip's length to spread frames", async () => {
    useConnectionStore.setState((s) => ({
      connections: {
        ...s.connections,
        resolve: { ...s.connections.resolve, pool: { bins: [], clips: [{ id: "pool1", name: "City.mov", bin: "B", type: "Video", duration: 30, filePath: "/m/City.mov", usage: 0 }], timelines: [], truncated: false, selection: { pool: [], timeline: [], underPlayhead: null } } },
      },
    }));
    await runTool(executorsFor(context), "look_at_media", { clipId: "pool1", count: 3 });
    expect(shotsSent().map((s) => s.time)).toEqual([5, 15, 25]);
  });

  it("refuses once the request's images are used up", async () => {
    takeImages("s1", 2);
    takeImages("s1", 2);
    takeImages("s1", 2);
    takeImages("s1", 2);
    expect(imagesLeft("s1")).toBe(0);
    const outcome = await runTool(executorsFor(context), "look_at_clip", { clipId: "a" });
    expect((outcome.result as { error: string }).error).toMatch(/already shown you 8 images/);
    expect(jobs.runJob).not.toHaveBeenCalled();
    // The next request starts over.
    expect(imagesLeft("s2")).toBe(MAX_TURN_IMAGES);
  });

  it("holds back images past the budget and says so", () => {
    for (let i = 0; i < 3; i++) takeImages("s9", 2);
    takeImages("s9", 1);
    const kept = withImagesKept({ summary: "", result: { ok: true }, images: [SHEET, SHEET] }, "look_at_media", "s9");
    expect(kept.images).toHaveLength(1);
    expect(kept.result).toMatchObject({ ok: true, imagesWithheld: expect.stringMatching(/1 of look_at_media's 2/) });
  });
});
