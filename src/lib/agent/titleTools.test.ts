import { beforeEach, describe, expect, it, vi } from "vitest";

const ipc = vi.hoisted(() => ({ nleCall: vi.fn() }));
vi.mock("../ipc", () => ipc);
const core = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ ...core, convertFileSrc: (p: string) => p }));
const jobs = vi.hoisted(() => ({ runJob: vi.fn() }));
vi.mock("../jobs", () => jobs);

import { placeThirds, SPEAKER_LEAD, titleTrack } from "./titleTools";
import { executorsFor, runTool, type ToolContext } from "./tools";
import { describeChange, needsReview } from "./toolKinds";
import { emptyConnection, useConnectionStore } from "../../store/useConnectionStore";
import { useEditLogStore } from "../../store/useEditLogStore";
import type { HostClip, HostTimeline } from "../../types/timeline";
import type { TranscriptData } from "../../vibecut/types/transcript";

const clip = (id: string, start: number, end: number, filePath: string, over: Partial<HostClip> = {}): HostClip => ({ id, name: id, start, end, enabled: true, sourceIn: 0, sourceOut: end - start, filePath, ...over });

/** A two-camera interview, 60 s at 1920x1080: A on V1, B on V2, their mics on A1 and A2. */
const view = (over: Partial<HostTimeline> = {}): HostTimeline => ({
  project: "Doc",
  timeline: "Main",
  fps: 25,
  startTimecode: "00:00:00:00",
  duration: 60,
  isCurrent: true,
  width: 1920,
  height: 1080,
  tracks: [
    { type: "video", index: 1, name: "", enabled: true, clips: [clip("va", 0, 60, "/m/camA.mov")] },
    { type: "video", index: 2, name: "", enabled: true, clips: [clip("vb", 0, 60, "/m/camB.mov")] },
    { type: "audio", index: 1, name: "", enabled: true, clips: [clip("aa", 0, 60, "/m/ana.wav")] },
    { type: "audio", index: 2, name: "", enabled: true, clips: [clip("ab", 0, 60, "/m/ben.wav")] },
  ],
  markers: [],
  ...over,
});

describe("where the lower thirds go", () => {
  const lines = [
    { start: 12, speaker: "Ben" },
    { start: 2, speaker: "Ana" },
    { start: 30, speaker: "Ana" },
  ];

  it("places one at its time, or a moment after its speaker first talks", () => {
    const thirds = placeThirds([{ name: "Ana Lima", title: "Director", speaker: "ana" }, { name: "Ben Cho", at: 20 }], lines, 5, 60);
    expect(thirds).toEqual([
      { name: "Ana Lima", title: "Director", at: 2 + SPEAKER_LEAD },
      { name: "Ben Cho", title: "", at: 20 },
    ]);
  });

  it("keeps one inside the timeline, and refuses overlaps and unknown speakers", () => {
    expect(placeThirds([{ name: "Ana", at: 58 }], null, 5, 60)[0].at).toBe(55);
    expect(() => placeThirds([{ name: "Ana", at: 10 }, { name: "Ben", at: 12 }], null, 5, 60)).toThrow("would overlap");
    expect(() => placeThirds([{ name: "Cal", speaker: "Cal" }], lines, 5, 60)).toThrow("the speakers are: Ben, Ana");
    expect(() => placeThirds([{ name: "Ana" }], lines, 5, 60)).toThrow("give at (seconds) or speaker");
    expect(() => placeThirds([], null, 5, 60)).toThrow("1 to 20");
  });

  it("goes on the track above the highest picture, adding it when there isn't one", () => {
    expect(titleTrack(view())).toEqual({ track: 3, add: true });
    const spare = view();
    spare.tracks.push({ type: "video", index: 3, name: "", enabled: true, clips: [] }, { type: "video", index: 4, name: "", enabled: true, clips: [] });
    expect(titleTrack(spare)).toEqual({ track: 3, add: false });
  });
});

describe("add_lower_thirds", () => {
  const context: ToolContext = { host: "resolve", timeline: "Main", step: "s1", stepText: "add name titles" };
  const sent = (command: string) => ipc.nleCall.mock.calls.filter((c) => c[1] === command).map((c) => c[2]);
  let current = view();

  beforeEach(() => {
    vi.clearAllMocks();
    current = view();
    useEditLogStore.setState({ entries: [], backups: {}, restoredIds: { premiere: {}, resolve: {} } });
    useConnectionStore.setState({ connections: { premiere: emptyConnection("Doc"), resolve: emptyConnection("Doc") } });
    jobs.runJob.mockImplementation(async (_name: string, _label: string, request: { titles: { name: string }[] }) => ({
      status: "done",
      result: { files: request.titles.map((t) => (t.name === "Broken" ? { name: t.name, error: "ffmpeg failed" } : { name: t.name, output: `/r/Doc/Lower thirds/${t.name}.mov`, reused: false })) },
    }));
    ipc.nleCall.mockImplementation(async (_h: string, command: string, args: { clips?: { path: string; at: number }[] }) => {
      if (command === "read_timeline") return current;
      if (command === "backup_timeline") return { backup: "Main (before VibeCut 1)" };
      if (command === "add_track") return { changes: [{ kind: "track-added" }], refused: [], addedTracks: ["V3"] };
      if (command === "add_clips") return { changes: (args.clips ?? []).map((c, i) => ({ kind: "added", itemIds: [`n${i}`], name: c.path, at: c.at, tracks: ["V3"] })), refused: [] };
      return {};
    });
  });

  it("renders the names at the timeline's size and lays them on a new track above the picture", async () => {
    const out = await runTool(executorsFor(context), "add_lower_thirds", {
      thirds: [{ name: "Ana Lima", title: "Director", at: 3 }, { name: "Broken", at: 20 }, { name: "Ben Cho", at: 40 }],
      seconds: 4,
      look: "clean",
    });
    expect(jobs.runJob.mock.calls[0][0]).toBe("media-titles");
    expect(jobs.runJob.mock.calls[0][2]).toEqual({
      titles: [{ name: "Ana Lima", title: "Director" }, { name: "Broken" }, { name: "Ben Cho" }],
      width: 1920,
      height: 1080,
      fps: 25,
      seconds: 4,
      look: "clean",
      position: "left",
      project: "Doc",
    });
    expect(sent("add_track")).toHaveLength(1);
    expect((sent("add_clips")[0] as { clips: unknown[] }).clips).toEqual([
      { path: "/r/Doc/Lower thirds/Ana Lima.mov", at: 3, sourceIn: 0, sourceOut: 4, videoTrack: 3, picture: true, sound: false },
      { path: "/r/Doc/Lower thirds/Ben Cho.mov", at: 40, sourceIn: 0, sourceOut: 4, videoTrack: 3, picture: true, sound: false },
    ]);
    expect(out.summary).toContain("Added 2 lower third(s) on V3 (a new track): Ana Lima at 3.0s, Ben Cho at 40.0s; 1 couldn't be rendered");
    expect((out.result as { failed: string[] }).failed).toEqual(["Broken: ffmpeg failed"]);
    // One request: the track and the clips revert together.
    expect(new Set(useEditLogStore.getState().entries.map((e) => e.step))).toEqual(new Set(["s1"]));
  });

  it("places by speaker from the transcripts", async () => {
    const transcript: TranscriptData = {
      segments: [
        { start: 4, end: 9, text: "Thanks for having me.", speaker: "Speaker 1" },
        { start: 20, end: 25, text: "It started with a wedding.", speaker: "Speaker 1" },
      ],
      speakers: ["Speaker 1"],
      speakerLabels: { "Speaker 1": "Ana" },
      excludedSpeakers: [],
    };
    core.invoke.mockImplementation(async (cmd: string, a: { mediaPath: string }) => (cmd === "read_transcript" && a.mediaPath === "/m/ana.wav" ? transcript : null));
    await runTool(executorsFor(context), "add_lower_thirds", { thirds: [{ name: "Ana Lima", speaker: "Ana" }] });
    expect((sent("add_clips")[0] as { clips: { at: number }[] }).clips[0].at).toBe(4 + SPEAKER_LEAD);
  });

  it("places by speaker after dropping the lines each mic only heard in the other's bleed", async () => {
    const heardBoth = (name: string): TranscriptData => ({
      segments: [
        { start: 0, end: 9, text: "Welcome to the show.", speaker: "Speaker 1" },
        { start: 10, end: 20, text: "Thanks for having me.", speaker: "Speaker 1" },
      ],
      speakers: ["Speaker 1"],
      speakerLabels: { "Speaker 1": name },
      excludedSpeakers: [],
    });
    core.invoke.mockImplementation(async (cmd: string, a: { mediaPath: string }) => (cmd !== "read_transcript" ? null : a.mediaPath === "/m/ana.wav" ? heardBoth("Ana") : a.mediaPath === "/m/ben.wav" ? heardBoth("Ben") : null));
    const peaks = (loud: (t: number) => boolean) => {
      const maxes = Array.from({ length: 600 }, (_, i) => (loud(i / 10) ? 0.3 : 0.003));
      return { peaksPerSecond: 10, maxes, mins: maxes.map((m) => -m) };
    };
    jobs.runJob.mockImplementation(async (name: string, _label: string, request: { titles?: { name: string }[] }) =>
      name === "audio-peaks"
        ? { status: "done", result: { peaks: { "/m/ana.wav": peaks((t) => t < 9.5), "/m/ben.wav": peaks((t) => t >= 9.5) } } }
        : { status: "done", result: { files: (request.titles ?? []).map((t) => ({ name: t.name, output: `/r/${t.name}.mov` })) } },
    );
    await runTool(executorsFor(context), "add_lower_thirds", { thirds: [{ name: "Ana Lima", speaker: "Ana" }, { name: "Ben Cho", speaker: "Ben" }] });
    expect((sent("add_clips")[0] as { clips: { at: number }[] }).clips.map((c) => c.at)).toEqual([0 + SPEAKER_LEAD, 10 + SPEAKER_LEAD]);
  });

  it("refuses a bad look, a long seconds, and a timeline with a draft open, and is reviewed", async () => {
    const error = async (args: Record<string, unknown>) => String(((await runTool(executorsFor(context), "add_lower_thirds", args)).result as { error?: unknown }).error);
    expect(await error({ thirds: [{ name: "Ana", at: 1 }], look: "neon" })).toContain("look must be bar or clean");
    expect(await error({ thirds: [{ name: "Ana", at: 1 }], seconds: 45 })).toContain("1 to 30");
    expect(await error({ thirds: [{ name: "Ana", at: 1 }], accent: "orange" })).toContain("accent");
    expect(needsReview("add_lower_thirds")).toBe(true);
    expect(describeChange("add_lower_thirds", { thirds: [{}, {}] })).toBe("Add lower thirds (2)");
  });
});
