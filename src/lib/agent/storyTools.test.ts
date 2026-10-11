import { beforeEach, describe, expect, it, vi } from "vitest";

const ipc = vi.hoisted(() => ({ nleCall: vi.fn(), startSidecar: vi.fn(), cancelSidecar: vi.fn(async () => undefined) }));
vi.mock("../ipc", () => ipc);
const core = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ ...core, convertFileSrc: (p: string) => p }));
const jobs = vi.hoisted(() => ({ runJob: vi.fn() }));
vi.mock("../jobs", () => jobs);

import { libraryBroll, poolBroll, storyExecutors, storyModel, withBrollOffsets } from "./storyTools";
import { AI_CHOICES } from "../../types/agent";
import { emptyConnection, useConnectionStore } from "../../store/useConnectionStore";
import { useAgentStore } from "../../store/useAgentStore";
import { useLibraryStore } from "../../store/useLibraryStore";
import type { HostTimeline } from "../../types/timeline";
import type { ToolContext } from "./tools";

const VIEW: HostTimeline = {
  project: "Doc",
  timeline: "Interviews",
  fps: 25,
  startTimecode: "",
  duration: 60,
  isCurrent: true,
  tracks: [
    { type: "video", index: 1, name: "V1", enabled: true, clips: [{ id: "v1", name: "ana.mov", start: 0, end: 30, enabled: true, filePath: "/m/ana.mov" }] },
    {
      type: "audio",
      index: 1,
      name: "A1",
      enabled: true,
      clips: [
        { id: "a1", name: "ana.mov", start: 0, end: 30, enabled: true, filePath: "/m/ana.mov" },
        { id: "a2", name: "ben.mov", start: 30, end: 60, enabled: true, filePath: "/m/ben.mov" },
      ],
    },
  ],
  markers: [],
};

const transcript = (lines: [number, number, string, string][]) => ({
  segments: lines.map(([start, end, speaker, text]) => ({ start, end, speaker, text })),
  speakers: [],
  speakerLabels: { "Speaker 2": "Ana" },
  excludedSpeakers: [],
  speakerInfo: { "Speaker 1": { role: "interviewer" } },
});

const RESULT = {
  sequenceName: "The Bakery",
  narrativeSummary: "How it began.",
  resolvedSegments: [
    { track: "main", source_id: "s1", source_name: "ana.mov", in_seconds: 2, out_seconds: 9 },
    { track: "broll", source_id: "b1", source_name: "oven.mov", in_seconds: 0, out_seconds: 3, timeline_start_seconds: 1, audio_mode: "silent" },
  ],
  media: { s1: "/m/ana.mov", b1: "/lib/oven.mov" },
  duration: { main_runtime_label: "7s" },
  warnings: ["The cut runs 7s, under the 2m 0s target."],
};

const context: ToolContext = { host: "resolve", timeline: "Interviews", step: "m1", stepText: "make a story" };
const run = (args: Record<string, unknown>) => storyExecutors({ ...context }).run_story_editor(args);
const sentRequest = () => jobs.runJob.mock.calls[0][2] as Record<string, unknown>;

beforeEach(() => {
  vi.clearAllMocks();
  useConnectionStore.setState({ connections: { premiere: emptyConnection("Doc"), resolve: emptyConnection("Doc") } });
  useAgentStore.setState({ aiChoice: "claude-opus-5-5", status: "thinking" });
  useLibraryStore.setState({ scopes: ["/lib"] });
  ipc.nleCall.mockImplementation(async (_h: string, command: string) => (command === "read_timeline" ? VIEW : null));
  core.invoke.mockImplementation(async (command: string, args: Record<string, unknown>) => {
    if (command === "read_transcript") {
      if (args.mediaPath === "/m/ana.mov") return transcript([[0, 2, "Speaker 1", "How did it start?"], [2, 9, "Speaker 2", "We opened in 1999."]]);
      return null;
    }
    if (command === "spyglass_browse")
      return {
        summary: {},
        shots: [
          { shotId: 1, path: "/lib/oven.mov", start: 12, end: 18, caption: "bread in an oven", tags: ["bread"], technical: 70, status: "ok" },
          { shotId: 2, path: "/lib/gone.mov", start: 0, end: 5, caption: "x", tags: [], technical: null, status: "offline" },
        ],
      };
    return null;
  });
  jobs.runJob.mockImplementation(async (_command: string, _label: string, _request: unknown, onStart?: (id: string) => void) => {
    onStart?.("job1");
    return { id: "job1", status: "done", result: RESULT, error: null };
  });
});

describe("run_story_editor", () => {
  it("sends the interviews' answers with the chat's model and opens the cut as a draft", async () => {
    const outcome = await run({ prompt: "How the bakery began", targetDuration: "2 minutes", sequenceName: "Bakery story" });
    expect(jobs.runJob).toHaveBeenCalledWith("assemble", 'Story Editor: "Bakery story" from 1 file(s)', expect.any(Object), expect.any(Function));
    expect(jobs.runJob.mock.calls[0][2]).toMatchObject({ provider: "claude", model: "claude-opus-5-5", extraction: "same" });
    expect(sentRequest()).toMatchObject({
      provider: "claude",
      model: "claude-opus-5-5",
      // The interviewer's question is left out; the answer goes with its speaker's name.
      sources: [{ sourceId: "s1", segments: [{ start: 2, end: 9, text: "We opened in 1999.", speaker: "Ana" }] }],
      media: { s1: "/m/ana.mov" },
      brollCatalog: [],
      prompt: "How the bakery began",
      targetDuration: "2 minutes",
      fps: 25,
    });
    const draft = useConnectionStore.getState().connections.resolve.draft!;
    expect(draft.base).toBe("Interviews");
    expect(draft.name).toBe("Bakery story");
    expect(outcome.summary).toMatch(/^Draft: .*, 7s; left out 1 file\(s\) with no transcript \(ben\.mov\)\. Send it to make the timeline in Resolve\.$/);
    expect(outcome.result).toMatchObject({ narrativeSummary: "How it began.", warnings: RESULT.warnings });
  });

  it("lays a music bed under the cut and moves its edit points onto the beats (Phase 16d)", async () => {
    const twoCuts = {
      ...RESULT,
      resolvedSegments: [
        { track: "main", source_id: "s1", source_name: "ana.mov", in_seconds: 2, out_seconds: 9 },
        { track: "main", source_id: "s1", source_name: "ana.mov", in_seconds: 20, out_seconds: 26 },
      ],
    };
    jobs.runJob.mockImplementation(async (command: string) =>
      command === "media-beats"
        ? { id: "b", status: "done", result: { bpm: 120, confidence: 0.8, beats: [0.04, 7.1, 7.6, 8.1], start: 0, end: 60 }, error: null }
        : { id: "a", status: "done", result: twoCuts, error: null },
    );
    const outcome = await run({ prompt: "How the bakery began", music: "/m/song.wav" });
    // The music is read first, so a bad file never costs a Story Editor run.
    expect(jobs.runJob.mock.calls.map((c) => c[0])).toEqual(["media-beats", "assemble"]);
    expect(jobs.runJob.mock.calls[0][2]).toEqual({ path: "/m/song.wav", start: 0, end: 1200 });
    const draft = useConnectionStore.getState().connections.resolve.draft!;
    // The second cut (at 7 s) moved onto the beat at 7.1 s; the first stays at the head, off the 0.04 s beat.
    expect(draft.audio[0].clips.map((c) => c.start)).toEqual([0, 7.12]);
    const bed = draft.audio[draft.audio.length - 1].clips;
    expect(bed.map((c) => [c.sourcePath, c.start, c.end, c.sourceIn, c.volumeDb])).toEqual([["/m/song.wav", 0, 13.12, 0, -18]]);
    expect(outcome.summary).toContain('music bed "song.wav" on A2 at -18 dB (120 BPM); 1 cut(s) moved onto a beat. After sending, fade its end with set_clip_fade');
    expect(outcome.result).toMatchObject({ music: { file: "song.wav", track: "A2", levelDb: -18, bpm: 120, cutsOnBeat: 1 } });
  });

  it("leaves the cuts alone on music with no steady beat, and stops before the Story Editor on unreadable music", async () => {
    jobs.runJob.mockImplementation(async (command: string) =>
      command === "media-beats"
        ? { id: "b", status: "done", result: { bpm: null, confidence: 0.1, beats: [], start: 0, end: 4 }, error: null }
        : { id: "a", status: "done", result: RESULT, error: null },
    );
    const outcome = await run({ prompt: "x", music: "/m/pad.wav", musicLevelDb: -24 });
    expect(outcome.summary).toContain("ending at 4.0s before the cut does; the music has no steady beat (confidence 0.10), so the cuts weren't moved");
    const draft = useConnectionStore.getState().connections.resolve.draft!;
    expect(draft.audio[draft.audio.length - 1].clips[0]).toMatchObject({ end: 4, volumeDb: -24 });

    useConnectionStore.setState({ connections: { premiere: emptyConnection("Doc"), resolve: emptyConnection("Doc") } });
    jobs.runJob.mockReset();
    jobs.runJob.mockResolvedValue({ id: "b", status: "failed", result: null, error: "The file isn't there (is its drive attached?)" });
    await expect(run({ prompt: "x", music: "/m/gone.wav" })).rejects.toThrow("The music couldn't be read: The file isn't there");
    expect(jobs.runJob.mock.calls.map((c) => c[0])).toEqual(["media-beats"]);
  });

  it("keeps the questions when the brief asks for them", async () => {
    await run({ prompt: "Keep the questions, Q&A style" });
    expect((sentRequest().sources as { segments: unknown[] }[])[0].segments).toHaveLength(2);
  });

  it("uses the files of the clips named", async () => {
    await expect(run({ prompt: "x", clipIds: ["a2"] })).rejects.toThrow("ben.mov");
    expect(core.invoke).toHaveBeenCalledWith("read_transcript", { mediaPath: "/m/ben.mov" });
    expect(core.invoke).not.toHaveBeenCalledWith("read_transcript", { mediaPath: "/m/ana.mov" });
  });

  it("refuses when nothing has a transcript, when a draft is open, and without a brief", async () => {
    await expect(run({ prompt: "x", clipIds: ["a2"] })).rejects.toThrow("None of these files has a transcript yet: ben.mov");
    await expect(run({ prompt: " " })).rejects.toThrow("prompt must be the brief");
    useConnectionStore.getState().setDraft("resolve", { base: "Interviews", changes: [] } as never);
    await expect(run({ prompt: "x" })).rejects.toThrow('A draft of "Interviews" is already open');
    expect(jobs.runJob).not.toHaveBeenCalled();
  });

  it("offers the Library's shots on line, and places a shot from its own start in the file", async () => {
    await run({ prompt: "x", brollFromLibrary: true });
    expect(core.invoke).toHaveBeenCalledWith("spyglass_browse", { scopes: ["/lib"], offset: 0, limit: 500 });
    expect(sentRequest().brollCatalog).toEqual([{ brollId: "b1", path: "/lib/oven.mov", durationSeconds: 6, caption: "bread in an oven", tags: ["bread"], technicalScore: 70 }]);
    const draft = useConnectionStore.getState().connections.resolve.draft!;
    const broll = draft.video.flatMap((t) => t.clips).find((c) => c.sourcePath === "/lib/oven.mov")!;
    // The model's 0-3 s of the shot is 12-15 s of the file.
    expect([broll.sourceIn, broll.sourceOut, broll.start]).toEqual([12, 15, 1]);
  });

  it("reports a Story Editor that failed or was stopped", async () => {
    jobs.runJob.mockResolvedValueOnce({ id: "job1", status: "error", result: null, error: "Gemini rate-limited this request" });
    await expect(run({ prompt: "x" })).rejects.toThrow("rate-limited");

    jobs.runJob.mockImplementationOnce(async (_c: string, _l: string, _r: unknown, onStart?: (id: string) => void) => {
      onStart?.("job2");
      useAgentStore.setState({ status: "stopping" });
      return { id: "job2", status: "cancelled", result: null, error: null };
    });
    await expect(run({ prompt: "x" })).rejects.toThrow("Stopped by the user");
    expect(ipc.cancelSidecar).toHaveBeenCalledWith("job2");
    expect(useConnectionStore.getState().connections.resolve.draft).toBeNull();
  });

  it("says so when the cut came back empty", async () => {
    jobs.runJob.mockResolvedValueOnce({ id: "job1", status: "done", result: { ...RESULT, resolvedSegments: [] }, error: null });
    expect((await run({ prompt: "x" })).summary).toBe("The Story Editor returned no usable cuts");
  });
});

describe("the B-roll catalog", () => {
  it("reads project B-roll from a bin or named clips, with their logging", () => {
    useConnectionStore.setState({
      connections: {
        premiere: emptyConnection("Doc"),
        resolve: {
          ...emptyConnection("Doc"),
          aliases: { "n:1": "p1", "n:2": "p2" },
          pool: {
            clips: [
              { id: "n:1", name: "Oven", bin: "Master/B-roll", type: "Video", duration: 8, filePath: "/m/oven.mov", usage: 0, metadata: { Description: "Bread", Keywords: "bread, oven" } },
              { id: "n:2", name: "Ana", bin: "Master/Interviews", type: "Video + Audio", duration: 90, filePath: "/m/ana.mov", usage: 1 },
              { id: "n:3", name: "Gone", bin: "Master/B-roll", type: "Video", duration: 4, filePath: "/m/gone.mov", usage: 0, offline: true },
            ],
          } as never,
        },
      },
    });
    expect(poolBroll("resolve", { brollBin: "b-roll" }).map((b) => b.entry)).toEqual([
      { brollId: "p1", path: "/m/oven.mov", durationSeconds: 8, caption: "Bread", tags: ["bread", "oven"], technicalScore: null },
    ]);
    expect(poolBroll("resolve", { brollClipIds: ["p2"] }).map((b) => b.entry.caption)).toEqual(["Ana"]);
    expect(poolBroll("resolve", {})).toEqual([]);
  });

  it("skips offline Library shots", async () => {
    expect((await libraryBroll()).map((b) => [b.entry.path, b.offset])).toEqual([["/lib/oven.mov", 12]]);
  });

  it("moves only B-roll cuts by their entry's offset", () => {
    const shifted = withBrollOffsets(RESULT, [{ entry: { brollId: "b1", path: "/lib/oven.mov", durationSeconds: 6, caption: null, tags: [], technicalScore: null }, offset: 12 }]);
    expect((shifted.resolvedSegments as { in_seconds: number }[]).map((s) => s.in_seconds)).toEqual([2, 12]);
  });
});

describe("the Story Editor's model", () => {
  const choice = (id: string) => AI_CHOICES.find((c) => c.id === id)!;

  it("is the chat's own, including Claude (subscription), with the first-pass setting", () => {
    useAgentStore.setState({ storyFirstPass: "same" });
    expect(storyModel(choice("claude-opus-5-5"))).toEqual({ provider: "claude", model: "claude-opus-5-5", extraction: "same" });
    expect(storyModel(choice("gemini"))).toEqual({ provider: "gemini", model: undefined, extraction: "same" });
    expect(storyModel(choice("claude-code-sonnet-5-5"))).toEqual({ provider: "claude-code", model: "claude-sonnet-5-5", extraction: "same" });
    useAgentStore.setState({ storyFirstPass: "gemini" });
    expect(storyModel(choice("claude-code-opus-5-5")).extraction).toBe("gemini");
  });
});
