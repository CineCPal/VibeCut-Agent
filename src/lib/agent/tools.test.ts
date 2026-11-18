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
      "find_timeline_gaps",
      "list_markers",
      "add_markers",
      "update_marker",
      "remove_markers",
      "get_playhead_time",
      "get_edit_log",
      "set_playhead_time",
      "add_clips",
      "delete_clips",
      "set_clips_enabled",
      "label_timeline_clips",
      "set_clip_levels",
      "set_clip_fade",
      "set_clip_transform",
      "get_clip_transform",
      "split_clip",
      "trim_clip_start",
      "trim_clip_end",
      "slip_clip",
      "move_clip",
      "nest_clips",
      "duck_music",
      "set_clip_color",
      "match_clip_color",
      "balance_clip_color",
      "get_clip_color",
      "revert_timeline_edits",
      "set_clip_speed",
      "set_speed_ramp",
      "clear_clip_speed",
      "set_transition",
      "add_track",
      "remove_track",
      "set_track_options",
      "create_timeline",
      "duplicate_timeline",
      "make_social_version",
      "switch_timeline",
      "rename_timeline",
      "select_clip",
      "select_media_assets",
      "list_media_pool",
      "get_clip_info",
      "search_media_pool",
      "import_media",
      "create_bins",
      "move_clips",
      "set_clip_labels",
      "set_clip_metadata",
      "rename_clips",
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
      "harmonize_takes",
      "run_story_editor",
      "find_broll",
      "list_spyglass_folders",
      "describe_spyglass_folder",
      "analyze_broll_folder",
      "export_broll_selects",
      "build_broll_selects_timeline",
      "analyze_bin",
      "build_bin_selects",
      "index_bin_visuals",
      "find_clips_by_content",
      "look_at_clip",
      "look_at_timeline",
      "look_at_media",
      "remember_note",
      "forget_note",
      "measure_loudness",
      "normalize_loudness",
      "find_beats",
      "review_edit",
      "cut_to_beats",
      "cut_by_speaker",
      "make_split_edit",
      "close_gaps",
      "insert_clip",
      "replace_clip",
      "find_shot_changes",
      "check_pacing",
      "read_client_notes",
      "make_chapters",
      "find_thumbnails",
      "export_thumbnails",
      "learn_style",
      "clean_dialogue",
      "fill_room_tone",
      "add_lower_thirds",
      "create_captions",
      "export_video",
      "export_audio",
      "export_clips",
    ]);
    // The same tools, sending the draft to each one's own editor; Resolve also saves VibeCut's node template.
    expect(names("resolve")).toEqual(names("premiere").flatMap((n) => (n === "send_to_premiere" ? ["send_to_resolve"] : n === "get_clip_color" ? [n, "save_color_template"] : [n])));
    const colors = (host: "premiere" | "resolve") =>
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (toolDeclarations(host).find((t) => t.name === "update_marker")!.parameters as any).properties.color.enum as string[];
    expect(colors("premiere")).toContain("Orange");
    expect(colors("resolve")).toContain("Cocoa");
    expect(toolDeclarations("resolve").find((t) => t.name === "add_markers")?.description).toContain("Resolve requires one");
    expect(toolDeclarations("premiere").find((t) => t.name === "duck_music")?.description).toContain("Level keyframes");
    expect(toolDeclarations("resolve").find((t) => t.name === "duck_music")?.description).toContain("crossfaded");
  });

  it("finds the gaps on the live timeline, latest first, on whole frames", async () => {
    const clip = (id: string, start: number, end: number) => ({ id, name: id, start, end, enabled: true });
    ipc.nleCall.mockResolvedValue({
      fps: 25,
      duration: 30,
      tracks: [
        { type: "video", index: 1, clips: [clip("v1", 0, 2), clip("v2", 5, 6), clip("v3", 9.03, 12)] },
        { type: "audio", index: 1, clips: [clip("a1", 0, 3)] },
        { type: "subtitle", index: 1, clips: [clip("s1", 3, 5)] },
      ],
    });
    const run = executorsFor({ host: "premiere", timeline: "Main", ...STEP });
    const outcome = await run.find_timeline_gaps({});
    expect(ipc.nleCall).toHaveBeenCalledWith("premiere", "read_timeline", { timeline: "Main" });
    // A1 covers 2-3 s; subtitles don't count; nothing after the last clip is a gap.
    expect(outcome.result).toEqual({
      fps: 25,
      gaps: [
        // 9.03 s is snapped to its frame, 9.04 s.
        { start: 6, end: 9.04, seconds: 3.04 },
        { start: 3, end: 5, seconds: 2 },
      ],
      totalSeconds: 5.04,
    });
    expect(outcome.summary).toBe("Found 2 gap(s) on the sequence, 5.0s in all");
    expect((await run.find_timeline_gaps({ minSeconds: 2.5 })).result).toMatchObject({ gaps: [{ start: 6 }] });
  });

  it("declares enums only on strings, as Gemini's parameters require", () => {
    // A NUMBER enum (cut_to_beats' everyBeats once) is an HTTP 400 that fails every Gemini chat turn.
    const bad: string[] = [];
    const walk = (schema: unknown, path: string) => {
      if (!schema || typeof schema !== "object") return;
      const s = schema as Record<string, unknown>;
      if (Array.isArray(s.enum) && (s.type !== "STRING" || s.enum.some((v) => typeof v !== "string"))) bad.push(path);
      for (const [key, value] of Object.entries(s)) walk(value, `${path}.${key}`);
    };
    for (const host of ["premiere", "resolve"] as const) {
      for (const tool of toolDeclarations(host)) walk(tool.parameters, `${host}:${tool.name}`);
    }
    expect(bad).toEqual([]);
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

  it("lists track locks only for the orchestrator's validator", async () => {
    ipc.nleCall.mockResolvedValue({
      fps: 25,
      duration: 3,
      tracks: [{ type: "video", index: 1, name: "V", enabled: true, locked: true, clips: [] }],
    });
    const run = executorsFor({ host: "premiere", timeline: "Main", ...STEP });
    const asToday = (await run.list_timeline_clips({ detail: true })).result as { tracks: object[] };
    expect(asToday.tracks[0]).toEqual({ track: "V1", name: "V", enabled: true, clips: [] });
    const forBus = (await run.list_timeline_clips({ detail: true, includeLocked: true })).result as { tracks: object[] };
    expect(forBus.tracks[0]).toEqual({ track: "V1", name: "V", enabled: true, locked: true, clips: [] });
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
