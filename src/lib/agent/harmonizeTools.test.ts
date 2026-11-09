import { beforeEach, describe, expect, it, vi } from "vitest";

const ipc = vi.hoisted(() => ({ nleCall: vi.fn() }));
vi.mock("../ipc", () => ipc);
const jobs = vi.hoisted(() => ({ runJob: vi.fn() }));
vi.mock("../jobs", () => jobs);

import { harmonizeExecutors, harmonizeRequest, hasPicture } from "./harmonizeTools";
import { forgetMediaFacts } from "./mediaInfo";
import { emptyConnection, useConnectionStore } from "../../store/useConnectionStore";
import type { HostTimeline } from "../../types/timeline";
import type { ToolContext } from "./tools";

const VIEW: HostTimeline = {
  project: "Recital",
  timeline: "Main",
  fps: 25,
  startTimecode: "00:00:00:00",
  duration: 30,
  isCurrent: true,
  tracks: [
    {
      type: "video",
      index: 1,
      name: "V1",
      enabled: true,
      clips: [
        { id: "v1", name: "take1.mov", start: 0, end: 20, enabled: true, sourceIn: 0, sourceOut: 20, filePath: "/m/take1.mov", linkedIds: ["a1"] },
        { id: "v2", name: "intro.mov", start: 20, end: 30, enabled: true, sourceIn: 0, sourceOut: 10, filePath: "/m/intro.mov" },
      ],
    },
    { type: "audio", index: 1, name: "A1", enabled: true, clips: [{ id: "a1", name: "take1.mov", start: 0, end: 20, enabled: true, sourceIn: 0, sourceOut: 20, filePath: "/m/take1.mov", linkedIds: ["v1"] }] },
  ],
  markers: [],
};

const seg = (refStart: number, refEnd: number, takeStart: number, takeEnd: number, flagged = false) => ({ refStart, refEnd, takeStart, takeEnd, flagged });
const take = (path: string, segments: ReturnType<typeof seg>[], offsetConfidence = 90, sameRecording = false) => ({
  path,
  duration: 60,
  offset: segments[0].takeStart - segments[0].refStart,
  offsetConfidence,
  leadIn: segments[0].refStart,
  skippedAnchors: 0,
  flaggedCount: segments.filter((s) => s.flagged).length,
  sameRecording,
  segments,
});
const HARMONY = {
  cancelled: false,
  referencePath: "/m/reference.wav",
  referenceDuration: 25,
  anchorCount: 40,
  takes: [
    take("/m/take1.mov", [seg(0, 10, 2, 12), seg(10, 20, 12, 21.5, true)]),
    take("/m/zoom.wav", [seg(0, 20, 0.5, 20.5)], 25, true),
    take("/m/other.mov", [seg(0, 20, 3, 23)], 0),
  ],
};
const FACTS = {
  "/m/reference.wav": { duration: 25, video: null, audio: { codec: "pcm", channels: 2, sampleRate: 48000 } },
  "/m/take1.mov": { duration: 60, video: { codec: "h264", width: 1920, height: 1080, fps: 25 }, audio: { codec: "aac", channels: 2, sampleRate: 48000 } },
  "/m/zoom.wav": { duration: 60, video: null, audio: { codec: "pcm", channels: 2, sampleRate: 48000 } },
};

const ctx = (): ToolContext => ({ host: "resolve", timeline: "Main", step: "m1", stepText: "line up the takes" });

describe("harmonize_takes (Harmonizer in the agent)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    forgetMediaFacts();
    useConnectionStore.setState({ connections: { premiere: emptyConnection("Recital"), resolve: emptyConnection("Recital") } });
    ipc.nleCall.mockImplementation(async (_h: string, command: string) => (command === "read_timeline" ? VIEW : {}));
    jobs.runJob.mockImplementation(async (command: string) => {
      if (command === "media-info") return { status: "done", result: { info: FACTS } };
      if (command === "media-harmonize") return { status: "done", result: HARMONY };
      return undefined;
    });
  });

  it("runs Harmonizer on the files named and lines the takes up in the draft, replacing a take's clips already there", async () => {
    const outcome = await harmonizeExecutors(ctx()).harmonize_takes({ reference: "/m/reference.wav", takes: ["v1", "/m/zoom.wav", "/m/other.mov"], sameRecorder: ["/m/zoom.wav"] });
    const harmonize = jobs.runJob.mock.calls.find((c) => c[0] === "media-harmonize")!;
    expect(harmonize[2]).toEqual({ referencePath: "/m/reference.wav", takePaths: ["/m/take1.mov", "/m/zoom.wav", "/m/other.mov"], noRetime: ["/m/zoom.wav"] });

    const draft = useConnectionStore.getState().connections.resolve.draft!;
    // take1 was at 0 on the timeline: the takes go where it was, and its old clips are gone.
    expect(draft.video.map((t) => t.clips.map((c) => [c.sourceName, c.start]))).toEqual([[["intro.mov", 20]], [["take1.mov", 0]]]);
    expect(draft.video[1].clips[0].timeRemap).toHaveLength(3);
    const audio = draft.audio.flatMap((t) => t.clips).map((c) => [c.sourceName, c.start, c.enabled]);
    expect(audio).toEqual(expect.arrayContaining([["reference.wav", 0, true], ["zoom.wav", 0, false], ["take1.mov", 0, false]]));
    expect(audio).toHaveLength(3);
    expect(draft.markers.map((m) => [m.time, m.name])).toEqual([[10, "Check sync: take1.mov at 95%"]]);

    expect(outcome.summary).toContain("Lined up 2 take(s) with reference.wav from 0.0s");
    expect(outcome.summary).toContain("replaced 2 earlier clip(s) of the takes");
    expect(outcome.summary).toContain("1 stretch(es) marked in red");
    expect(outcome.summary).toContain("unsure of zoom.wav");
    expect(outcome.summary).toContain("left out other.mov, which don't sound like this performance");
    expect((outcome.result as { notThisPerformance: unknown }).notThisPerformance).toEqual([{ take: "other.mov", confidence: 0 }]);
    expect(outcome.summary).toContain("send_to_resolve builds it");
    const result = outcome.result as { takes: Record<string, unknown>[] };
    expect(result.takes[0]).toMatchObject({ take: "take1.mov", picture: true, slowestPercent: 95, fastestPercent: 100, confidence: 90, flagged: [{ start: 10, end: 20, speedPercent: 95 }] });
    expect(result.takes[1]).toMatchObject({ take: "zoom.wav", picture: false, sameRecording: true, unsure: expect.stringContaining("another piece") });
  });

  it("places a take that doesn't match only with placeAll, and refuses when none match", async () => {
    await harmonizeExecutors(ctx()).harmonize_takes({ reference: "/m/reference.wav", takes: ["v1", "/m/zoom.wav", "/m/other.mov"], placeAll: true });
    const placed = useConnectionStore.getState().connections.resolve.draft!.video.flatMap((t) => t.clips).map((c) => c.sourceName);
    expect(placed).toContain("other.mov");

    useConnectionStore.setState({ connections: { premiere: emptyConnection("Recital"), resolve: emptyConnection("Recital") } });
    jobs.runJob.mockImplementation(async (command: string) =>
      command === "media-harmonize" ? { status: "done", result: { ...HARMONY, takes: [HARMONY.takes[2]] } } : { status: "done", result: { info: FACTS } },
    );
    await expect(harmonizeExecutors(ctx()).harmonize_takes({ reference: "/m/reference.wav", takes: ["/m/other.mov"] })).rejects.toThrow("None of the takes sounds like reference.wav: other.mov (confidence 0)");
    expect(useConnectionStore.getState().connections.resolve.draft).toBeNull();
  });

  it("lines up with the reference's clip already on the timeline", async () => {
    const withReference: HostTimeline = {
      ...VIEW,
      tracks: [...VIEW.tracks, { type: "audio", index: 2, name: "A2", enabled: true, clips: [{ id: "r1", name: "reference.wav", start: 6, end: 26, enabled: true, sourceIn: 1, sourceOut: 21, filePath: "/m/reference.wav" }] }],
    };
    ipc.nleCall.mockImplementation(async (_h: string, command: string) => (command === "read_timeline" ? withReference : {}));
    const outcome = await harmonizeExecutors(ctx()).harmonize_takes({ reference: "r1", takes: ["/m/zoom.wav"] });
    const draft = useConnectionStore.getState().connections.resolve.draft!;
    expect(draft.audio.flatMap((t) => t.clips).filter((c) => c.sourceName === "reference.wav")).toHaveLength(1);
    expect(draft.audio.flatMap((t) => t.clips).find((c) => c.sourceName === "zoom.wav")).toMatchObject({ start: 5 });
    expect(outcome.summary).toContain("its clip already on the timeline");
  });

  it("refuses a bad request before running anything, and says why Harmonizer failed", async () => {
    const run = harmonizeExecutors(ctx()).harmonize_takes;
    await expect(run({ reference: "/m/reference.wav", takes: [] })).rejects.toThrow("non-empty");
    await expect(run({ reference: "/m/reference.wav", takes: ["/m/reference.wav"] })).rejects.toThrow("can't also be a take");
    await expect(run({ reference: "/m/reference.wav", takes: ["/m/a.mov"], sameRecorder: ["/m/b.mov"] })).rejects.toThrow("sameRecorder");
    await expect(run({ reference: "p404", takes: ["/m/a.mov"] })).rejects.toThrow("isn't a clip");
    expect(jobs.runJob.mock.calls.filter((c) => c[0] === "media-harmonize")).toEqual([]);

    jobs.runJob.mockImplementation(async (command: string) => (command === "media-harmonize" ? { status: "failed", error: "zoom.wav has no sound to line up", result: null } : { status: "done", result: { info: {} } }));
    await expect(run({ reference: "/m/reference.wav", takes: ["/m/zoom.wav"] })).rejects.toThrow("zoom.wav has no sound to line up");
    expect(useConnectionStore.getState().connections.resolve.draft).toBeNull();
  });

  it("checks requests as the sidecar does, and tells picture from sound", () => {
    expect(() => harmonizeRequest("/r.wav", Array.from({ length: 17 }, (_, i) => `/t${i}.mov`), [])).toThrow("At most 16");
    expect(() => harmonizeRequest("/r.wav", ["/a.mov", "/a.mov"], [])).toThrow("listed twice");
    expect(hasPicture("/m/song.WAV")).toBe(false);
    expect(hasPicture("/m/cam.mov")).toBe(true);
  });
});
