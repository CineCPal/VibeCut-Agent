import { beforeEach, describe, expect, it, vi } from "vitest";

const ipc = vi.hoisted(() => ({ nleCall: vi.fn() }));
vi.mock("../ipc", () => ipc);
const tauri = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => tauri);

import { captionCues } from "./captionTools";
import { clipProgressLine, progressLine, rangeArg, renderExecutors } from "./renderTools";
import { executorsFor, runTool, type ToolContext } from "./tools";
import { useAgentStore } from "../../store/useAgentStore";
import { emptyConnection, useConnectionStore } from "../../store/useConnectionStore";
import { useEditLogStore } from "../../store/useEditLogStore";
import type { HostTimeline } from "../../types/timeline";
import type { LaneLine } from "../../vibecut/lib/transcriptLane";

const line = (start: number, end: number, text: string, words?: { start: number; end: number; text: string }[]): LaneLine =>
  ({ id: `l${start}`, assetId: "a", start, end, text, speaker: "S1", speakerId: "S1", ...(words ? { words } : {}) }) as LaneLine;

const VIEW: HostTimeline = {
  project: "Doc",
  timeline: "Main",
  fps: 25,
  startTimecode: "00:00:00:00",
  duration: 10,
  isCurrent: true,
  tracks: [{ type: "audio", index: 1, name: "", enabled: true, clips: [{ id: "a1", name: "int.wav", start: 0, end: 10, enabled: true, sourceIn: 0, filePath: "/m/int.wav" }] }],
  markers: [],
};

const sent = (command: string) => ipc.nleCall.mock.calls.filter((c) => c[1] === command).map((c) => c[2]);
const errorOf = (outcome: { result: unknown }) => String((outcome.result as { error?: unknown }).error);

beforeEach(() => {
  vi.clearAllMocks();
  useConnectionStore.setState({ connections: { premiere: emptyConnection("Doc"), resolve: emptyConnection("Doc") } });
  useEditLogStore.setState({ entries: [], backups: {}, restoredIds: { premiere: {}, resolve: {} } });
  useAgentStore.setState({ status: "thinking", activity: null });
});

describe("caption cues (VibeCut's, Phase 15a)", () => {
  it("splits a line at whole words, timed by its words", () => {
    const words = ["We", "opened", "the", "shop", "five", "years", "ago."].map((text, i) => ({ start: i, end: i + 0.8, text }));
    expect(captionCues([line(0, 7, "We opened the shop five years ago.", words)], 15)).toEqual([
      { start: 0, end: 2.8, text: "We opened the" },
      { start: 3, end: 5.8, text: "shop five years" },
      { start: 6, end: 6.8, text: "ago." },
    ]);
  });

  it("without word times, shares the line's time out by length", () => {
    expect(captionCues([line(10, 14, "aaaa bbbb cccc dddd")], 9)).toEqual([
      { start: 10, end: 12, text: "aaaa bbbb" },
      { start: 12, end: 14, text: "cccc dddd" },
    ]);
  });
});

describe("create_captions", () => {
  const answers = (command: string, args: { cues?: unknown[] }) => {
    if (command === "read_timeline") return VIEW;
    if (command === "backup_timeline") return { backup: "Main (before VibeCut 1)" };
    if (command === "create_captions") return { changes: [{ kind: "captions", name: "Subtitles", count: args.cues?.length ?? 12, trackName: args.cues ? "a caption track" : "ST1" }], refused: [] };
    throw new Error(`unexpected ${command}`);
  };

  it("on Resolve asks for Resolve's own subtitles, logged for Revert", async () => {
    ipc.nleCall.mockImplementation(async (_h: string, command: string, args: { cues?: unknown[] }) => answers(command, args));
    const out = await runTool(executorsFor({ host: "resolve", timeline: "Main", step: "s1", stepText: "caption it" }), "create_captions", { language: "english", lines: 2 });
    expect(sent("create_captions")).toEqual([{ timeline: "Main", language: "english", charsPerLine: 42, lines: 2 }]);
    expect(out.summary).toMatch(/^Made 12 subtitles with Resolve's transcription on ST1/);
    expect(useEditLogStore.getState().entries).toHaveLength(1);
    expect(errorOf(await runTool(executorsFor({ host: "resolve", timeline: "Main", step: "s1", stepText: "x" }), "create_captions", { lines: 3 }))).toMatch(/lines must be 1 or 2/);
  });

  it("on Premiere sends cues from the heard transcripts, and refuses without any", async () => {
    ipc.nleCall.mockImplementation(async (_h: string, command: string, args: { cues?: unknown[] }) => answers(command, args));
    tauri.invoke.mockImplementation(async (command: string) =>
      command === "read_transcript" ? { segments: [{ start: 1, end: 3, text: "Hello there.", speaker: "S1" }], speakers: ["S1"], speakerLabels: {}, excludedSpeakers: [] } : null,
    );
    const context: ToolContext = { host: "premiere", timeline: "Main", step: "s1", stepText: "caption it" };
    const out = await runTool(executorsFor(context), "create_captions", {});
    expect(sent("create_captions")).toEqual([{ timeline: "Main", cues: [{ start: 1, end: 3, text: "Hello there." }], name: "Main captions" }]);
    expect(out.summary).toMatch(/Made a caption track of 1 captions from the transcripts \("Main captions"\)/);
    tauri.invoke.mockResolvedValue(null);
    expect(errorOf(await runTool(executorsFor(context), "create_captions", {}))).toMatch(/transcribe the clips first/);
  });

  it("is refused while a draft is open", async () => {
    useConnectionStore.setState((s) => ({ connections: { ...s.connections, resolve: { ...s.connections.resolve, draft: { base: "Main", changes: ["x"] } as never } } }));
    expect(errorOf(await runTool(executorsFor({ host: "resolve", timeline: "Main", step: "s1", stepText: "x" }), "create_captions", {}))).toMatch(/A draft of "Main" is open/);
  });
});

describe("renders (Phase 15b)", () => {
  const context: ToolContext = { host: "resolve", timeline: "Main", step: "s1", stepText: "render it" };

  it("reads the range", () => {
    expect(rangeArg({})).toBe("all");
    expect(rangeArg({ range: "in_out" })).toBe("in_out");
    expect(rangeArg({ start: 2, end: 5 })).toEqual({ start: 2, end: 5 });
    expect(() => rangeArg({ start: 2 })).toThrow(/both start and end/);
    expect(() => rangeArg({ range: "half" })).toThrow(/range must be/);
    expect(progressLine("H.264 (1080p)", "Main.mp4", { state: "rendering", seconds: 10, fraction: 0.42, etaSeconds: 31.4 })).toBe("Rendering H.264 (1080p) → Main.mp4 42%, about 31 s left");
  });

  it("starts the render, shows its progress and answers with the file", async () => {
    const states = [{ state: "rendering", seconds: 10, fraction: 0.5, etaSeconds: 4 }, { state: "done", seconds: 10, path: "/Users/me/Movies/VibeCut Renders/Doc/Main - client.mp4" }];
    const seen: (string | null)[] = [];
    ipc.nleCall.mockImplementation(async (_h: string, command: string) => {
      if (command === "render_video") return { jobId: "j1", path: "/Users/me/Movies/VibeCut Renders/Doc/Main - client.mp4", seconds: 10 };
      if (command === "render_status") {
        seen.push(useAgentStore.getState().activity);
        return states.shift();
      }
      throw new Error(`unexpected ${command}`);
    });
    const out = await runTool(renderExecutors(context, 0), "export_video", { preset: "1080p", name: "client" });
    expect(sent("render_video")).toEqual([{ timeline: "Main", preset: "1080p", range: "all", name: "client" }]);
    expect(seen[1]).toBe("Rendering H.264 (1080p) → Main - client.mp4 50%, about 4 s left");
    expect(out.summary).toBe("Resolve rendered H.264 (1080p) (10.0s) to /Users/me/Movies/VibeCut Renders/Doc/Main - client.mp4");
    expect(out.result).toEqual({ rendered: true, path: "/Users/me/Movies/VibeCut Renders/Doc/Main - client.mp4", seconds: 10 });
  });

  it("stops the render when the chat is stopped, and reports a failure", async () => {
    ipc.nleCall.mockImplementation(async (_h: string, command: string) => {
      if (command === "render_audio") return { jobId: "j2", path: "/r/Main.wav", seconds: 10 };
      if (command === "render_status") {
        useAgentStore.setState({ status: "stopping" });
        return { state: "rendering", seconds: 10, fraction: 0.1 };
      }
      if (command === "cancel_render") return { state: "cancelled", seconds: 10 };
      throw new Error(`unexpected ${command}`);
    });
    const stopped = await runTool(renderExecutors(context, 0), "export_audio", { range: "in_out" });
    expect(sent("render_audio")).toEqual([{ timeline: "Main", format: "wav", range: "in_out" }]);
    expect(sent("cancel_render")).toEqual([{ jobId: "j2" }]);
    expect(stopped.summary).toMatch(/^Stopped the render in Resolve; its partial file was removed/);

    useAgentStore.setState({ status: "thinking" });
    ipc.nleCall.mockImplementation(async (_h: string, command: string) =>
      command === "render_video" ? { jobId: "j3", path: "/r/Main.mov", seconds: 10 } : { state: "failed", seconds: 10, error: "Resolve's render failed" },
    );
    expect(errorOf(await runTool(renderExecutors(context, 0), "export_video", { preset: "prores" }))).toBe("Resolve's render failed");
  });

  it("refuses a bad preset or format, and while a draft is open", async () => {
    expect(errorOf(await runTool(renderExecutors(context, 0), "export_video", { preset: "4k" }))).toMatch(/preset must be one of source, 1080p, 720p, prores/);
    expect(errorOf(await runTool(renderExecutors(context, 0), "export_audio", { format: "mp3" }))).toMatch(/format must be one of wav, aac/);
    useConnectionStore.setState((s) => ({ connections: { ...s.connections, resolve: { ...s.connections.resolve, draft: { base: "Main", changes: ["x"] } as never } } }));
    expect(errorOf(await runTool(renderExecutors(context, 0), "export_video", {}))).toMatch(/A draft is open/);
    expect(ipc.nleCall).not.toHaveBeenCalled();
  });
});

describe("export_clips", () => {
  const context: ToolContext = { host: "resolve", timeline: "Main", step: "s1", stepText: "export each clip" };
  const folder = "/Users/me/Movies/VibeCut Renders/Doc/Main clips";
  const start = { jobId: "c1", folder, total: 2, skipped: [{ id: "adj", name: "Adjustment Layer", reason: "a transition, adjustment layer or generator has no source file" }], notes: ["B plays at 200% on the timeline; its file is the source at normal speed"] };

  it("cuts each clip, shows its progress and answers with the folder, the skips and the notes", async () => {
    const states = [
      { state: "rendering", done: 1, total: 2, fraction: 0.5, etaSeconds: 3, folder, files: [`${folder}/01 A.mp4`], failed: [] },
      { state: "done", done: 2, total: 2, fraction: 1, folder, files: [`${folder}/01 A.mp4`, `${folder}/02 B.mp4`], failed: [] },
    ];
    const seen: (string | null)[] = [];
    ipc.nleCall.mockImplementation(async (_h: string, command: string) => {
      if (command === "export_clips") return start;
      if (command === "clip_export_status") {
        seen.push(useAgentStore.getState().activity);
        return states.shift();
      }
      throw new Error(`unexpected ${command}`);
    });
    const out = await runTool(renderExecutors(context, 0), "export_clips", { track: "V1", handles: 1, format: "prores" });
    expect(sent("export_clips")).toEqual([{ timeline: "Main", format: "prores", track: "V1", handles: 1 }]);
    expect(seen[1]).toBe("Exporting clips 2/2 → Main clips 50%, about 3 s left");
    expect(out.summary).toBe(
      `Exported 2 of 2 clips, each by itself, to ${folder}. Skipped 1: Adjustment Layer (a transition, adjustment layer or generator has no source file). B plays at 200% on the timeline; its file is the source at normal speed.`,
    );
    expect(out.result).toMatchObject({ exported: 2, files: [`${folder}/01 A.mp4`, `${folder}/02 B.mp4`] });
    expect(clipProgressLine(folder, { state: "rendering", done: 0, total: 3, folder, files: [], failed: [] })).toBe("Exporting clips 1/3 → Main clips");
  });

  it("stops when the chat is stopped, keeping the finished files, and fails when no clip was written", async () => {
    ipc.nleCall.mockImplementation(async (_h: string, command: string) => {
      if (command === "export_clips") return start;
      if (command === "clip_export_status") {
        useAgentStore.setState({ status: "stopping" });
        return { state: "rendering", done: 0, total: 2, folder, files: [], failed: [] };
      }
      if (command === "cancel_clip_export") return { state: "cancelled", done: 1, total: 2, folder, files: [`${folder}/01 A.mp4`], failed: [] };
      throw new Error(`unexpected ${command}`);
    });
    const stopped = await runTool(renderExecutors(context, 0), "export_clips", { clipIds: ["v1", "v2"] });
    expect(sent("export_clips")).toEqual([{ timeline: "Main", format: "source", clipIds: ["v1", "v2"] }]);
    expect(sent("cancel_clip_export")).toEqual([{ jobId: "c1" }]);
    expect(stopped.summary).toBe(`Stopped exporting clips after 1 of 2; the finished files are kept in ${folder}.`);

    useAgentStore.setState({ status: "thinking" });
    ipc.nleCall.mockImplementation(async (_h: string, command: string) =>
      command === "export_clips" ? { ...start, skipped: [], notes: [] } : { state: "failed", done: 2, total: 2, folder, files: [], failed: [{ clip: "A", error: "Invalid data found" }] },
    );
    expect(errorOf(await runTool(renderExecutors(context, 0), "export_clips", {}))).toBe("No clip was exported. Failed 1: A (Invalid data found).");
  });

  it("refuses a bad format, and while a draft is open", async () => {
    expect(errorOf(await runTool(renderExecutors(context, 0), "export_clips", { format: "gif" }))).toMatch(/format must be one of source, 1080p, 720p, prores, copy/);
    useConnectionStore.setState((s) => ({ connections: { ...s.connections, resolve: { ...s.connections.resolve, draft: { base: "Main", changes: ["x"] } as never } } }));
    expect(errorOf(await runTool(renderExecutors(context, 0), "export_clips", {}))).toMatch(/A draft is open/);
    expect(ipc.nleCall).not.toHaveBeenCalled();
  });
});
