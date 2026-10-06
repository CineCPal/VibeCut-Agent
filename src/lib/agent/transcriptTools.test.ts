import { beforeEach, describe, expect, it, vi } from "vitest";

const ipc = vi.hoisted(() => ({ nleCall: vi.fn(), startSidecar: vi.fn(), cancelSidecar: vi.fn() }));
vi.mock("../ipc", () => ipc);
const core = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ ...core, convertFileSrc: (p: string) => p }));
const jobs = vi.hoisted(() => ({ runJob: vi.fn() }));
vi.mock("../jobs", () => jobs);

import { executorsFor, runTool, type ToolContext } from "./tools";
import { fileKey, hostClips } from "./transcriptTools";
import { emptyConnection, useConnectionStore } from "../../store/useConnectionStore";
import { useEditLogStore } from "../../store/useEditLogStore";
import { initialHosts, useNleStateStore } from "../../store/useNleStateStore";
import { useSystemStore } from "../../store/useSystemStore";
import { useAgentStore } from "../../store/useAgentStore";
import { nleState } from "../../test/nleFixtures";
import type { HostTimeline } from "../../types/timeline";
import type { TranscriptData } from "../../vibecut/types/transcript";

const CAM = "/Volumes/Archive/cam.mov";
/** A 20 s interview on V1/A1 (linked), its file transcribed with an interviewer and a subject. */
const TIMELINE: HostTimeline = {
  project: "Doc",
  timeline: "Main",
  fps: 25,
  startTimecode: "00:00:00:00",
  duration: 20,
  isCurrent: true,
  tracks: [
    { type: "video", index: 1, name: "", enabled: true, clips: [{ id: "v1", name: "cam", start: 0, end: 20, enabled: true, sourceIn: 0, filePath: CAM, linkedIds: ["a1"] }] },
    { type: "audio", index: 1, name: "", enabled: true, clips: [{ id: "a1", name: "cam", start: 0, end: 20, enabled: true, sourceIn: 0, filePath: CAM, linkedIds: ["v1"] }] },
  ],
  markers: [],
};

const TRANSCRIPT: TranscriptData = {
  segments: [
    { start: 0, end: 3, text: "So what got you into baking?", speaker: "Speaker 1" },
    { start: 4, end: 12, text: "Um, my grandmother had a bakery in Naples.", speaker: "Speaker 2", words: [{ start: 4, end: 4.4, text: "Um," }, { start: 4.5, end: 4.8, text: "my" }] },
    { start: 13, end: 15, text: "And then?", speaker: "Speaker 1" },
    { start: 16, end: 20, text: "I opened my own.", speaker: "Speaker 2" },
  ],
  speakers: ["Speaker 1", "Speaker 2"],
  speakerLabels: {},
  excludedSpeakers: [],
};

const ctx = (over: Partial<ToolContext> = {}): ToolContext => ({ host: "premiere", timeline: "Main", step: "s1", stepText: "cut the interviewer out", ...over });
const run = (context: ToolContext, name: string, args: Record<string, unknown> = {}) => runTool(executorsFor(context), name, args);
const errorOf = (outcome: { result: unknown }) => String((outcome.result as { error?: unknown }).error);

describe("the agent's transcript and draft tools", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useConnectionStore.setState({ connections: { premiere: emptyConnection("Doc"), resolve: emptyConnection("Doc") } });
    useEditLogStore.setState({ entries: [], backups: {}, restoredIds: { premiere: {}, resolve: {} } });
    useNleStateStore.setState({ hosts: { ...initialHosts(), premiere: nleState("premiere") } });
    useSystemStore.setState({ keys: { gemini: true, anthropic: false, geminiSource: "keychain", anthropicSource: null, huggingface: false, huggingfaceSource: null } });
    useAgentStore.setState({ messages: [] });
    ipc.nleCall.mockImplementation(async (_host: string, command: string, args: Record<string, unknown>) => {
      if (command === "read_timeline") return TIMELINE;
      if (command === "rebuild") return { timeline: "Main (VibeCut 1)", clips: 4, markersAdded: 0, warnings: [], bin: "VibeCut", got: args };
      throw new Error(`unexpected ${command}`);
    });
    core.invoke.mockImplementation(async (command: string, args: { mediaPath: string }) => (command === "read_transcript" && args.mediaPath === CAM ? TRANSCRIPT : null));
  });

  it("hears only audio clips with a file, as VibeCut's lint does", () => {
    const clips = hostClips(TIMELINE);
    expect(Object.keys(clips.heard)).toEqual(["a1"]);
    expect(clips.clipsById.v1.volume).toBe(0);
    expect(clips.assetsById[fileKey(CAM)].filePath).toBe(CAM);
    expect(fileKey(CAM)).toMatch(/^f[0-9a-f]{8}$/);
  });

  it("reads the timeline's lines from the transcripts of the files it plays", async () => {
    const { result } = await run(ctx(), "get_transcript", {});
    const lines = (result as { lines: { text: string; start: number }[] }).lines;
    expect(lines.map((l) => [l.start, l.text])).toEqual([
      [0, "So what got you into baking?"],
      [4, "Um, my grandmother had a bakery in Naples."],
      [13, "And then?"],
      [16, "I opened my own."],
    ]);
    const file = await run(ctx(), "get_transcript", { filePath: CAM });
    expect((file.result as { segments: unknown[] }).segments).toHaveLength(4);
  });

  it("cuts an interviewer's lines in a draft, then sends it as a new timeline", async () => {
    const context = ctx();
    const roles = await run(context, "set_speaker_roles", { speakers: [{ file: CAM, speakerId: "Speaker 1", role: "interviewer" }] });
    expect(roles.summary).toContain("Speaker 1 = interviewer");
    const cut = await run(context, "remove_speaker_lines", { role: "interviewer" });
    expect(cut.summary).toMatch(/^Cut 2 interviewer line\(s\)/);
    const draft = useConnectionStore.getState().connections.premiere.draft!;
    expect(draft.base).toBe("Main");
    expect(draft.duration).toBeLessThan(20);
    // The user's timeline can't be edited directly while the draft is open, nor left.
    expect(errorOf(await run(context, "delete_clips", { itemIds: ["v1"] }))).toContain("A draft of \"Main\" is open");
    expect(errorOf(await run(context, "create_timeline", {}))).toContain("before you make a new sequence");

    const sent = await run(context, "send_to_premiere", {});
    expect(sent.summary).toContain('Made the new sequence "Main (VibeCut 1)" in Premiere');
    const request = ipc.nleCall.mock.calls.find((c) => c[1] === "rebuild")![2] as { timeline: string; tracks: unknown[]; grades?: unknown };
    expect(request.timeline).toBe("Main");
    expect(request.tracks.length).toBeGreaterThan(0);
    expect(request.grades).toBeUndefined();
    expect(context.timeline).toBe("Main (VibeCut 1)");
    expect(useConnectionStore.getState().connections.premiere).toMatchObject({ draft: null, madeTimelines: ["Main (VibeCut 1)"] });
  });

  it("removes ranges and rearranges sections in the draft, and discards it", async () => {
    const context = ctx();
    expect((await run(context, "remove_time_ranges", { ranges: [{ start: 0, end: 4 }] })).summary).toContain("now 16.0s");
    expect((await run(context, "rearrange_sections", { sections: [{ start: 12, end: 16 }, { start: 0, end: 4 }] })).summary).toContain("now 8.0s");
    expect(errorOf(await run(context, "remove_time_ranges", { ranges: [{ start: 5, end: 2 }] }))).toContain("start < end");
    expect((await run(context, "discard_draft")).summary).toContain("Discarded the draft");
    expect(useConnectionStore.getState().connections.premiere.draft).toBeNull();
  });

  it("transcribes without speakers unless a Hugging Face token is set", async () => {
    jobs.runJob.mockResolvedValue({ status: "done", result: { files: [{ path: CAM, fromCache: false, speakers: ["Speaker 1"], segmentCount: 4 }] } });
    const outcome = await run(ctx(), "transcribe_clips", { clipIds: ["a1"] });
    expect(jobs.runJob).toHaveBeenCalledWith("transcribe", "Transcribe 1 file(s)", { videos: [CAM], model: "mlx-community/whisper-small-mlx", diarize: false, format: "txt", force: false });
    expect(outcome.summary).toBe("Transcribed 1 file(s)");
    expect(errorOf(await run(ctx(), "transcribe_clips", { clipIds: ["a1"], speakers: true }))).toContain("needs a Hugging Face token");
  });

  it("finds silences from the files' measured peaks", async () => {
    // 20 s at 10 peaks a second: loud, except 6 s to 10 s.
    const maxes = Array.from({ length: 200 }, (_, i) => (i >= 60 && i < 100 ? 0.0001 : 0.5));
    jobs.runJob.mockResolvedValue({ status: "done", result: { peaks: { [CAM]: { peaksPerSecond: 10, mins: maxes.map((m) => -m), maxes } }, failed: [] } });
    const { result } = await run(ctx(), "find_silences", {});
    expect(jobs.runJob.mock.calls[0][0]).toBe("audio-peaks");
    const silences = (result as { silences: { start: number; end: number }[] }).silences;
    expect(silences).toHaveLength(1);
    expect(silences[0].start).toBeCloseTo(6.1, 1);
    expect(silences[0].end).toBeCloseTo(9.9, 1);
  });
});
