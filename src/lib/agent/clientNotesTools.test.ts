import { beforeEach, describe, expect, it, vi } from "vitest";

const ipc = vi.hoisted(() => ({ nleCall: vi.fn(), startSidecar: vi.fn(), cancelSidecar: vi.fn() }));
vi.mock("../ipc", () => ipc);
const core = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ ...core, convertFileSrc: (p: string) => p }));

import { DONE_MARK, describeNote, noteSeconds, parseClientNotes } from "./clientNotesTools";
import { executorsFor, runTool, type ToolContext } from "./tools";
import { emptyConnection, useConnectionStore } from "../../store/useConnectionStore";
import { initialHosts, useNleStateStore } from "../../store/useNleStateStore";
import { nleState } from "../../test/nleFixtures";
import type { HostClip, HostTimeline } from "../../types/timeline";
import type { TranscriptData } from "../../vibecut/types/transcript";

const AT_ZERO = { fps: 25, startTimecode: "00:00:00:00" };
const AT_HOUR = { fps: 25, startTimecode: "01:00:00:00" };

describe("parseClientNotes", () => {
  it("reads the ways clients write times", () => {
    expect(noteSeconds("0:42", AT_ZERO)).toBe(42);
    expect(noteSeconds("01:15.5", AT_ZERO)).toBe(75.5);
    expect(noteSeconds("1:02:03", AT_ZERO)).toBe(3723);
    expect(noteSeconds("1m15s", AT_ZERO)).toBe(75);
    expect(noteSeconds("2 min 5 sec", AT_ZERO)).toBe(125);
    expect(noteSeconds("42s", AT_ZERO)).toBe(42);
    expect(noteSeconds("00:00:42:10", AT_ZERO)).toBe(42.4);
    expect(noteSeconds("1:75", AT_ZERO)).toBeNull();
    // Against a timeline that starts at 01:00:00:00: its own timecodes, and times from its start.
    expect(noteSeconds("01:00:42:10", AT_HOUR)).toBe(42.4);
    expect(noteSeconds("00:00:42:10", AT_HOUR)).toBe(42.4);
    expect(noteSeconds("1:00:42", AT_HOUR)).toBe(42);
    expect(noteSeconds("0:42", AT_HOUR)).toBe(42);
  });

  it("splits a pasted list into notes, ranges, continued lines and general notes", () => {
    const text = [
      "Overall feels long, aim for 2 minutes.",
      "",
      "0:42 - logo is too small",
      "1:15-1:20 cut this bit",
      "  the joke doesn't land",
      "[01:00:12:05] Colour looks too warm",
      "#3 At 1m30s, swap the B-roll",
      "2. The music at 0:58 is too loud",
      "@ 75s fade sooner",
      "12-15s the pause drags",
      "1 to 2 min: music too loud",
      "trim 2s off the end",
    ].join("\n");
    const { notes, general } = parseClientNotes(text, AT_HOUR);
    expect(notes.map((n) => [n.time, n.end, n.text])).toEqual([
      [42, undefined, "logo is too small"],
      [75, 80, "cut this bit the joke doesn't land"],
      [12.2, undefined, "Colour looks too warm"],
      [90, undefined, "swap the B-roll"],
      [58, undefined, "The music is too loud"],
      [75, undefined, "fade sooner"],
      [12, 15, "the pause drags"],
      [60, 120, "music too loud"],
    ]);
    // A duration inside a sentence isn't a time.
    expect(general).toEqual(["Overall feels long, aim for 2 minutes.", "trim 2s off the end"]);
  });
});

const CAM = "/m/cam.mov";
const clip = (id: string, start: number, end: number, sourceIn: number, filePath: string, extra: Partial<HostClip> = {}): HostClip => ({
  id,
  name: id,
  start,
  end,
  enabled: true,
  sourceIn,
  sourceOut: sourceIn + end - start,
  filePath,
  ...extra,
});
/** A 60 s interview on V1/A1, B-roll on V2 at 10-14 s, music on A2, and the client's markers. */
const TIMELINE: HostTimeline = {
  project: "Doc",
  timeline: "Main",
  fps: 25,
  startTimecode: "01:00:00:00",
  duration: 60,
  isCurrent: true,
  tracks: [
    { type: "video", index: 1, name: "", enabled: true, clips: [clip("v1", 0, 60, 0, CAM, { linkedIds: ["a1"] })] },
    { type: "video", index: 2, name: "", enabled: true, clips: [clip("b1", 10, 14, 0, "/m/b1.mov")] },
    { type: "audio", index: 1, name: "", enabled: true, clips: [clip("a1", 0, 60, 0, CAM, { linkedIds: ["v1"] })] },
    { type: "audio", index: 2, name: "", enabled: true, clips: [clip("song", 0, 40, 0, "/m/song.wav")] },
  ],
  markers: [
    { id: "m1", time: 12, name: "Swap this shot", color: "Red", note: "something wider", duration: 0.04 },
    { id: "m2", time: 30, name: `${DONE_MARK}Louder`, color: "Red", note: "", duration: 0.04 },
    { id: "m3", time: 50, name: "Trim", color: "Blue", note: "", duration: 3 },
  ],
};
const TRANSCRIPT: TranscriptData = {
  segments: [
    { start: 0.5, end: 20, text: "First answer.", speaker: "Speaker 1" },
    { start: 25, end: 59, text: "Second answer.", speaker: "Speaker 1" },
  ],
  speakers: ["Speaker 1"],
  speakerLabels: {},
  excludedSpeakers: [],
};

describe("read_client_notes", () => {
  const ctx: ToolContext = { host: "resolve", timeline: "Main", step: "s1", stepText: "here are the notes" };
  const tool = (args: Record<string, unknown>) => runTool(executorsFor(ctx), "read_client_notes", args);
  const errorOf = (outcome: { result: unknown }) => String((outcome.result as { error?: unknown }).error);

  beforeEach(() => {
    vi.clearAllMocks();
    useConnectionStore.setState({ connections: { premiere: emptyConnection("Doc"), resolve: emptyConnection("Doc") } });
    useNleStateStore.setState({ hosts: { ...initialHosts(), resolve: nleState("resolve") } });
    ipc.nleCall.mockResolvedValue(TIMELINE);
    core.invoke.mockImplementation(async (command: string, args: { mediaPath: string }) => (command === "read_transcript" && args.mediaPath === CAM ? TRANSCRIPT : null));
  });

  it("places pasted notes: the picture, the clips and the words there, and the nearest cut", async () => {
    const out = await tool({ text: "0:12 swap this shot\n01:00:22:00 pause too long\n1:30 end card\nShorter overall" });
    const result = out.result as { notes: { n: number; picture?: { clipId?: string }; under: { clipId: string; track: string }[]; said?: { text: string; where: string }; nearestCut?: { time: number; offset: number }; problem?: string }[]; general: string[] };
    const [swap, pause, end] = result.notes;
    expect(swap.picture?.clipId).toBe("b1");
    expect(swap.under.map((u) => `${u.track} ${u.clipId}`)).toEqual(["V1 v1", "V2 b1", "A1 a1", "A2 song"]);
    expect(swap.said).toMatchObject({ text: "First answer.", where: "at" });
    expect(swap.nearestCut).toEqual({ time: 10, offset: -2 });
    // In the pause between answers: the line just before.
    expect(pause.said).toMatchObject({ text: "First answer.", where: "before" });
    expect(end.problem).toContain("past the end of the timeline (60.0s)");
    expect(result.general).toEqual(["Shorter overall"]);
    expect(out.summary.split("\n")[0]).toBe('3 client note(s) on "Main" and 1 general (1 can\'t be placed)');
    expect(out.summary).toContain('1. 12.0s "swap this shot", on "b1", Speaker 1: "First answer.", nearest cut 10.0s (2.0s before)');
    // Chips for the notes that are on the timeline, as the client's.
    expect(out.findings?.map((f) => [f.time, f.source])).toEqual([[12, "client"], [22, "client"]]);
  });

  it("reads the markers as notes, skipping the ones marked done", async () => {
    const out = await tool({ fromMarkers: true });
    const result = out.result as { from: string; notes: { markerId?: string; text: string; end?: number }[]; remarks?: string[] };
    expect(result.from).toBe("markers");
    expect(result.notes.map((n) => [n.markerId, n.text, n.end])).toEqual([
      ["m1", "Swap this shot — something wider", undefined],
      ["m3", "Trim", 53],
    ]);
    // The music isn't transcribed, so what's said comes from the interview only.
    expect(result.remarks).toEqual(["what's said is from the transcribed files only; not transcribed: song.wav", "1 marker(s) already marked done were skipped"]);
    const red = await tool({ fromMarkers: true, colors: ["red"], includeDone: true });
    expect((red.result as { notes: { markerId?: string }[] }).notes.map((n) => n.markerId)).toEqual(["m1", "m2"]);
  });

  it("refuses with nothing to read", async () => {
    expect(errorOf(await tool({}))).toContain("Give text");
    expect(errorOf(await tool({ text: "\n  \n" }))).toBe("No notes found in the text: each note needs a time such as 0:42, 1:15-1:20 or 01:00:42:10");
    // Notes with no time are general ones.
    expect((await tool({ text: "just make it better" })).summary).toBe('0 client note(s) on "Main" and 1 general\ngeneral: "just make it better"');
    expect(errorOf(await tool({ fromMarkers: true, colors: ["green"] }))).toContain("There are no markers on the timeline in green");
  });

  it("describes a note over black with no words near", () => {
    expect(describeNote({ n: 2, time: 5, text: "black here", source: "", under: [] })).toBe('2. 5.0s "black here", over black');
  });
});
