import { beforeEach, describe, expect, it, vi } from "vitest";

const ipc = vi.hoisted(() => ({ nleCall: vi.fn() }));
vi.mock("../ipc", () => ipc);

import { executorsFor, markerArgs, runTool, toolDeclarations } from "./tools";

const STEP = { step: "m1", stepText: "mark it" };

describe("agent tools", () => {
  beforeEach(() => vi.clearAllMocks());

  it("declares the same read + marker tools for both editors, in each one's words", () => {
    const names = (host: "premiere" | "resolve") => toolDeclarations(host).map((t) => t.name);
    expect(names("premiere")).toEqual([
      "list_timelines",
      "list_timeline_clips",
      "list_markers",
      "add_markers",
      "update_marker",
      "remove_markers",
      "get_playhead_time",
      "set_playhead_time",
      "add_clips",
      "delete_clips",
      "set_clips_enabled",
      "set_clip_levels",
      "set_clip_fade",
      "split_clip",
      "trim_clip_start",
      "trim_clip_end",
      "slip_clip",
      "move_clip",
      "nest_clips",
      "duck_music",
      "revert_timeline_edits",
      "create_timeline",
      "duplicate_timeline",
      "switch_timeline",
      "rename_timeline",
      "select_clip",
      "select_media_assets",
      "list_media_pool",
      "get_clip_info",
      "search_media_pool",
      "import_media",
      "get_transcript",
      "transcribe_clips",
      "search_transcript",
      "remove_transcript_lines",
      "remove_speaker_lines",
      "find_filler_words",
      "find_silences",
      "list_speakers",
      "set_speaker_roles",
      "remove_time_ranges",
      "rearrange_sections",
      "send_to_premiere",
      "discard_draft",
      "sync_and_place",
      "sync_clips",
      "slip_into_sync",
      "link_clips",
      "unlink_clips",
      "run_story_editor",
      "find_broll",
      "list_spyglass_folders",
      "describe_spyglass_folder",
    ]);
    // The same tools, sending the draft to each one's own editor.
    expect(names("resolve")).toEqual(names("premiere").map((n) => (n === "send_to_premiere" ? "send_to_resolve" : n)));
    const colors = (host: "premiere" | "resolve") =>
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (toolDeclarations(host)[4].parameters as any).properties.color.enum as string[];
    expect(colors("premiere")).toContain("Orange");
    expect(colors("resolve")).toContain("Cocoa");
    expect(toolDeclarations("resolve")[3].description).toContain("Resolve requires one");
    expect(toolDeclarations("premiere").find((t) => t.name === "duck_music")?.description).toContain("Level keyframes");
    expect(toolDeclarations("resolve").find((t) => t.name === "duck_music")?.description).toContain("crossfaded");
  });

  it("sends every call with the open timeline", async () => {
    ipc.nleCall.mockResolvedValue({ time: 4.2 });
    const run = executorsFor({ host: "resolve", timeline: "Main", ...STEP });
    const outcome = await run.set_playhead_time({ time: 4.2 });
    expect(ipc.nleCall).toHaveBeenCalledWith("resolve", "set_playhead", { timeline: "Main", time: 4.2 });
    expect(outcome).toEqual({ summary: "Moved Resolve's playhead to 4.2s", result: { time: 4.2 } });
  });

  it("summarizes added markers, including the ones kept or refused", async () => {
    ipc.nleCall.mockResolvedValue({ added: [{ id: "g1", time: 1, name: "Hook" }], alreadyThere: ["g0"], refusedAt: [9] });
    const outcome = await executorsFor({ host: "premiere", timeline: "Main", ...STEP }).add_markers({
      markers: [{ time: 1, name: "Hook", color: "Red", extra: "ignored" }, { time: 0, name: "Start" }, { time: 9, name: "End" }],
    });
    expect(ipc.nleCall).toHaveBeenCalledWith("premiere", "add_markers", {
      timeline: "Main",
      markers: [{ time: 1, name: "Hook", color: "Red" }, { time: 0, name: "Start" }, { time: 9, name: "End" }],
    });
    expect(outcome.summary).toBe('Added 1 marker(s) in Premiere: "Hook" at 1.0s; 1 already had a marker on that frame; Premiere refused 1 at 9.0s');
  });

  it("keeps clip lists short unless detail is asked for", async () => {
    ipc.nleCall.mockResolvedValue({
      fps: 25,
      duration: 3,
      tracks: [{ type: "video", index: 1, name: "V", enabled: true, clips: [{ id: "c", name: "A", start: 0, end: 3, enabled: true, filePath: "/a.mov" }] }],
    });
    const run = executorsFor({ host: "premiere", timeline: "Main", ...STEP });
    const brief = (await run.list_timeline_clips({})).result as { tracks: { clips: object[] }[] };
    expect(brief.tracks[0].clips[0]).toEqual({ id: "c", name: "A", start: 0, end: 3 });
    const full = (await run.list_timeline_clips({ detail: true })).result as { tracks: { clips: object[] }[] };
    expect(full.tracks[0].clips[0]).toMatchObject({ filePath: "/a.mov" });
  });

  it("lists timelines without needing one open", async () => {
    ipc.nleCall.mockResolvedValue({ project: "Doc", timelines: ["A", "B"], currentTimeline: null });
    const outcome = await executorsFor({ host: "premiere", timeline: null, ...STEP }).list_timelines({});
    expect(ipc.nleCall).toHaveBeenCalledWith("premiere", "status");
    expect(outcome.result).toEqual({ project: "Doc", timelines: [{ name: "A" }, { name: "B" }] });
  });

  it("turns failures into error results the model can read", async () => {
    const run = executorsFor({ host: "premiere", timeline: null, ...STEP });
    expect(await runTool(run, "get_playhead_time", {})).toEqual({
      summary: "get_playhead_time failed: No sequence is open in Premiere. Ask the user to open one, or create_timeline.",
      result: { error: "No sequence is open in Premiere. Ask the user to open one, or create_timeline." },
    });
    expect((await runTool(run, "delete_everything", {})).result).toEqual({ error: "Unknown tool: delete_everything" });
    // Edits need a connected timeline; without one they say how to get one.
    expect((await runTool(run, "delete_clips", { itemIds: ["a"] })).result).toEqual({ error: "No sequence is open in Premiere. Ask the user to open one, or create_timeline." });
    expect(() => markerArgs({ markers: [] })).toThrow("non-empty");
    expect(() => markerArgs({ markers: [{ name: "x" }] })).toThrow("time must be a number");
  });
});
