import { beforeEach, describe, expect, it, vi } from "vitest";

const ipc = vi.hoisted(() => ({ nleCall: vi.fn(), startSidecar: vi.fn(), cancelSidecar: vi.fn() }));
vi.mock("../ipc", () => ipc);
const core = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ ...core, convertFileSrc: (p: string) => p }));
const jobs = vi.hoisted(() => ({ runJob: vi.fn() }));
vi.mock("../jobs", () => jobs);

import { editExecutors } from "./editTools";
import { beatCutting, lookTimes, MAX_LOOK_SAMPLES } from "./styleTools";
import { parseStyles } from "./styles";
import { executorsFor, runTool, type ToolContext } from "./tools";
import { emptyConnection, useConnectionStore } from "../../store/useConnectionStore";
import { useEditLogStore } from "../../store/useEditLogStore";
import { initialHosts, useNleStateStore } from "../../store/useNleStateStore";
import { nleState } from "../../test/nleFixtures";
import type { HostTimeline } from "../../types/timeline";

const REF = "/m/promo.mp4";
const LOOK = { brightness: 0.41, contrast: 0.62, warmth: 0.08, tint: -0.01, colour: 0.19 };
/** A 24 s reference: cuts every 2 s on a 120 BPM beat (every 4th beat), except one a frame off it. */
const CUTS = [2, 4, 6, 8, 10.4, 12, 14, 16, 18, 20, 22];
const ctx: ToolContext = { host: "premiere", timeline: "Main", step: "s1", stepText: "learn this style" };
const tool = (name: string, args: Record<string, unknown>) => runTool(executorsFor(ctx), name, args);
const errorOf = (outcome: { result: unknown }) => String((outcome.result as { error?: unknown }).error);

let notes = "";
function answer(name: string) {
  if (name === "media-shots") return { result: { cuts: CUTS.map((time) => ({ time, score: 0.5 })), start: 0, end: 24, fps: 25, frames: 600 } };
  if (name === "media-style") return { result: { look: LOOK, spread: { warmth: [0.02, 0.15] }, measured: 12, dark: 0 } };
  if (name === "media-beats") return { result: { bpm: 120, confidence: 0.8, beats: Array.from({ length: 48 }, (_, i) => i * 0.5), start: 0, end: 24 } };
  return { error: `no ${name}` };
}

describe("learning a style", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    notes = "## Style\n- No whip pans\n";
    useConnectionStore.setState({ connections: { premiere: emptyConnection("Doc"), resolve: emptyConnection("Doc") } });
    useNleStateStore.setState({ hosts: { ...initialHosts(), premiere: nleState("premiere") } });
    useEditLogStore.setState({ entries: [], backups: {}, restoredIds: { premiere: {}, resolve: {} } });
    jobs.runJob.mockImplementation(async (name: string) => answer(name));
    core.invoke.mockImplementation(async (command: string, args: { text?: string }) => {
      if (command === "project_notes_get") return notes;
      if (command === "project_notes_set") notes = args.text ?? "";
      return null;
    });
  });

  it("takes a frame from the middle of each shot, thinned evenly", () => {
    expect(lookTimes([{ start: 0, end: 2 }, { start: 2, end: 5 }])).toEqual([1, 3.5]);
    const many = Array.from({ length: 100 }, (_, i) => ({ start: i, end: i + 1 }));
    const times = lookTimes(many);
    expect(times).toHaveLength(MAX_LOOK_SAMPLES);
    expect([times[0], times[times.length - 1]]).toEqual([0.5, 99.5]);
  });

  it("counts cuts on the beat against chance", () => {
    expect(beatCutting(CUTS, [0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5, 4, 4.5, 5, 5.5, 6, 6.5, 7, 7.5, 8, 8.5, 9, 9.5, 10, 10.5, 11, 11.5, 12, 12.5, 13, 13.5, 14, 14.5, 15, 15.5, 16, 16.5, 17, 17.5, 18, 18.5, 19, 19.5, 20, 20.5, 21, 21.5, 22], 120, 0.08)).toEqual({ bpm: 120, onBeat: 0.91, chance: 0.32, tolerance: 0.08 });
  });

  it("measures a reference's pace, look and beat, and saves it to the notes", async () => {
    const out = await tool("learn_style", { path: REF, name: "Client promo" });
    expect(jobs.runJob).toHaveBeenCalledWith("media-shots", "Find the shots in promo.mp4", { path: REF, start: 0, sensitivity: "normal" });
    expect(jobs.runJob).toHaveBeenCalledWith("media-style", "Measure the look of promo.mp4", { path: REF, times: [1, 3, 5, 7, 9.2, 11.2, 13, 15, 17, 19, 21, 23] });
    expect(jobs.runJob).toHaveBeenCalledWith("media-beats", "Find the beats of promo.mp4", { path: REF, start: 0, end: 24 });
    expect(out.summary).toBe(
      'Learned and saved to "Doc"\'s notes: "Client promo" style, learned from promo.mp4: median shot 2s (90% under 2s), 27.5 cuts a minute; look: brightness 0.41, contrast 0.62, slightly warm, colourfulness 0.19; 91% of cuts on the beat at 120 BPM (chance 32%).',
    );
    expect(parseStyles(notes)).toEqual([{ name: "Client promo", medianShot: 2, p90Shot: 2, cutsPerMinute: 27.5, ...LOOK, onBeat: 0.91, bpm: 120 }]);
    expect(notes.startsWith("## Style\n- No whip pans\n- \"Client promo\" style")).toBe(true);
  });

  it("only measures with save false, and says what it couldn't measure", async () => {
    jobs.runJob.mockImplementation(async (name: string) => (name === "media-beats" ? { error: "There's no sound in promo.mp4" } : name === "media-style" ? { error: "ffmpeg failed" } : answer(name)));
    const out = await tool("learn_style", { path: REF, name: "promo", save: false });
    expect(out.summary.startsWith("Measured: ")).toBe(true);
    expect(notes).toBe("## Style\n- No whip pans\n");
    const result = out.result as { style: Record<string, unknown>; notes: string[] };
    expect(result.style).toEqual({ name: "promo", medianShot: 2, p90Shot: 2, cutsPerMinute: 27.5 });
    expect(result.notes).toEqual(expect.arrayContaining(["its look wasn't measured: ffmpeg failed", "cutting to the beat wasn't measured: There's no sound in promo.mp4"]));
  });

  it("refuses bad requests", async () => {
    expect(errorOf(await tool("learn_style", { path: REF, name: 'the "best"' }))).toContain("name must be");
    expect(errorOf(await tool("learn_style", { name: "promo" }))).toContain("path must be");
    expect(errorOf(await tool("learn_style", { path: "promo.mp4", name: "promo" }))).toContain("absolute");
    expect(errorOf(await tool("learn_style", { path: REF, name: "promo", start: 5, end: 2 }))).toContain("end must be after start");
  });

  it("is a target for check_pacing", async () => {
    await tool("learn_style", { path: REF, name: "promo" });
    const out = await tool("check_pacing", { path: REF, style: "promo", target: { maxShot: 30 } });
    expect((out.result as { target: unknown; style: string }).target).toEqual({ medianShot: 2, maxShot: 30 });
    expect((out.result as { style: string }).style).toBe("promo");
    expect(errorOf(await tool("check_pacing", { style: "wedding" }))).toContain('no learned style "wedding"');
  });

  it("is a reference look for match_clip_color", async () => {
    await tool("learn_style", { path: REF, name: "promo" });
    const view: HostTimeline = {
      project: "Doc",
      timeline: "Main",
      fps: 25,
      startTimecode: "00:00:00:00",
      duration: 4,
      isCurrent: true,
      tracks: [{ type: "video", index: 1, name: "V1", enabled: true, clips: [{ id: "v1", name: "A.mov", start: 0, end: 4, enabled: true }] }],
      markers: [],
    };
    ipc.nleCall.mockImplementation(async (_h: string, command: string) => {
      if (command === "read_timeline") return view;
      if (command === "backup_timeline") return { backup: "Main (before VibeCut 1)" };
      return { changes: [{ kind: "color", name: "A.mov", itemId: "v1", before: null, after: { exposure: 0.2, contrast: 0, temperature: 10, tint: 0, saturation: 100 }, passes: 2, distance: 0.02 }], refused: [] };
    });
    const run = editExecutors({ host: "premiere", timeline: "Main", step: "s1", stepText: "match the promo" });
    const out = await run.match_clip_color({ style: "promo", clipIds: ["v1"] });
    expect(ipc.nleCall.mock.calls.filter((c) => c[1] === "match_clip_color").map((c) => c[2])).toEqual([{ timeline: "Main", referenceLook: LOOK, itemIds: ["v1"] }]);
    expect(out.summary).toContain('Matched 1 clip to the "promo" style');
    await expect(run.match_clip_color({ style: "promo", referenceId: "v1", clipIds: ["v1"] })).rejects.toThrow("not both");
    await expect(run.match_clip_color({ clipIds: ["v1"] })).rejects.toThrow("referenceId must be");
  });
});
