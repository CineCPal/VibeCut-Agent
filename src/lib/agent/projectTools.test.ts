import { beforeEach, describe, expect, it, vi } from "vitest";

const ipc = vi.hoisted(() => ({ nleCall: vi.fn() }));
vi.mock("../ipc", () => ipc);

import { aliasOf, poolClipId, poolContext } from "./projectTools";
import { executorsFor, runTool, type ToolContext } from "./tools";
import { emptyConnection, useConnectionStore } from "../../store/useConnectionStore";
import { useEditLogStore } from "../../store/useEditLogStore";
import type { HostPool } from "../../types/pool";
import type { HostTimeline } from "../../types/timeline";

const POOL: HostPool = {
  bins: [{ path: "Interview", clips: 2 }],
  clips: [
    { id: "000f1", name: "CamA.mov", bin: "Interview", type: "Video + Audio", duration: 600, filePath: "/m/CamA.mov", usage: 0 },
    { id: "000f2", name: "Zoom.wav", bin: "Interview", type: "Audio", duration: 610, filePath: "/m/Zoom.wav", usage: 1, metadata: { Description: "lav" } },
  ],
  timelines: ["Main"],
  truncated: false,
  selection: { pool: ["000f2"], timeline: [], underPlayhead: null },
};

const VIEW = (timeline: string): HostTimeline => ({
  project: "Doc",
  timeline,
  fps: 25,
  startTimecode: "00:00:00:00",
  duration: 10,
  isCurrent: true,
  tracks: [{ type: "video", index: 1, name: "", enabled: true, clips: [{ id: "c1", name: "CamA", start: 2, end: 6, enabled: true, linkedIds: ["c2"] }] }],
  markers: [],
});

/** Answers the watcher's commands the way both editors do. */
function editor(over: Record<string, (args: Record<string, unknown>) => unknown> = {}) {
  const answers: Record<string, (args: Record<string, unknown>) => unknown> = {
    status: () => ({ project: "Doc", timelines: ["Main", "Main (before VibeCut 1)", "Selects"], currentTimeline: "Main" }),
    read_media_pool: () => POOL,
    read_timeline: (a) => VIEW(String(a.timeline)),
    create_timeline: (a) => ({ timeline: (a.name as string) ?? "Sequence (VibeCut)", fps: 25 }),
    duplicate_timeline: () => ({ timeline: "Main Copy" }),
    open_timeline: (a) => ({ timeline: a.timeline }),
    rename_timeline: (a) => ({ timeline: a.name, before: a.timeline }),
    select_items: (a) => ({ selected: a.itemIds }),
    set_playhead: (a) => ({ time: a.time }),
    select_pool_clips: (a) => ({ selected: [(a.clipIds as string[])[0]], notSelected: (a.clipIds as string[]).slice(1) }),
    import_media: () => ({ bin: "Interviews", imported: [{ path: "/m/CamA.mov", clipId: "000f1" }], reused: [] }),
    backup_timeline: (a) => ({ backup: `${a.timeline} (before VibeCut 1)` }),
    delete_clips: () => ({ changes: [{ itemId: "c1", field: "deleted", name: "CamA", before: null, after: null }], refused: [] }),
    ...over,
  };
  ipc.nleCall.mockImplementation(async (_host: string, command: string, args: Record<string, unknown> = {}) => {
    const answer = answers[command];
    if (!answer) throw new Error(`unexpected ${command}`);
    return answer(args);
  });
}

const ctx = (over: Partial<ToolContext> = {}): ToolContext => ({ host: "premiere", timeline: "Main", step: "s1", stepText: "cut the interview", ...over });
const errorOf = (outcome: { result: unknown }) => String((outcome.result as { error?: unknown }).error);
const run = (context: ToolContext, name: string, args: Record<string, unknown> = {}) => runTool(executorsFor(context), name, args);

describe("the agent's project tools", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useConnectionStore.setState({ connections: { premiere: emptyConnection("Doc"), resolve: emptyConnection("Doc") } });
    useEditLogStore.setState({ entries: [], backups: {}, restoredIds: { premiere: {}, resolve: {} } });
    editor();
  });

  it("lists timelines with the connected one, the editor's, made ones and backups", async () => {
    useConnectionStore.getState().addMadeTimeline("premiere", "Selects");
    const { result } = await run(ctx(), "list_timelines");
    expect(result).toEqual({
      project: "Doc",
      timelines: [
        { name: "Main", connected: true, openInEditor: true },
        { name: "Main (before VibeCut 1)", backup: true },
        { name: "Selects", madeByVibeCut: true },
      ],
    });
  });

  it("creates a timeline, connects to it, and the edits that follow build it", async () => {
    const context = ctx();
    const made = await run(context, "create_timeline", { name: "Interview Cut" });
    expect(made.summary).toBe('Made the empty sequence "Interview Cut" (25 fps) in Premiere, opened it and connected to it; "Main" is unchanged');
    expect(ipc.nleCall).toHaveBeenCalledWith("premiere", "create_timeline", { timeline: "Main", name: "Interview Cut" });
    expect(context.timeline).toBe("Interview Cut");
    expect(useConnectionStore.getState().connections.premiere.madeTimelines).toEqual(["Interview Cut"]);
    // The same turn's next edit goes to the new sequence, backed up first.
    await run(context, "delete_clips", { itemIds: ["c1"] });
    expect(ipc.nleCall).toHaveBeenCalledWith("premiere", "backup_timeline", { timeline: "Interview Cut" });
    expect(ipc.nleCall).toHaveBeenCalledWith("premiere", "delete_clips", expect.objectContaining({ timeline: "Interview Cut" }));
  });

  it("creates the first timeline of an empty project", async () => {
    const context = ctx({ timeline: null });
    await run(context, "create_timeline", {});
    expect(ipc.nleCall).toHaveBeenCalledWith("premiere", "create_timeline", {});
    expect(context.timeline).toBe("Sequence (VibeCut)");
  });

  it("duplicates only the connected timeline", async () => {
    const context = ctx();
    expect((await run(context, "duplicate_timeline", { timeline: "Selects" })).result).toEqual({
      error: 'Only the connected sequence ("Main") can be copied from here; switch_timeline to another first',
    });
    await run(context, "duplicate_timeline", {});
    expect(context.timeline).toBe("Main Copy");
  });

  it("switches to made timelines, and to the user's only when the message names them", async () => {
    const context = ctx();
    expect(errorOf(await run(context, "switch_timeline", { timeline: "Nope" }))).toContain("There's no sequence called \"Nope\"");
    expect(errorOf(await run(context, "switch_timeline", { timeline: "Main (before VibeCut 1)" }))).toContain("is a backup VibeCut made");
    expect(errorOf(await run(context, "switch_timeline", { timeline: "Selects" }))).toContain("is the user's own sequence");
    expect(context.timeline).toBe("Main");

    const named = ctx({ stepText: "work on the selects sequence" });
    await run(named, "switch_timeline", { timeline: "Selects" });
    expect(ipc.nleCall).toHaveBeenCalledWith("premiere", "open_timeline", { timeline: "Selects" });
    expect(named.timeline).toBe("Selects");

    useConnectionStore.getState().addMadeTimeline("premiere", "Selects");
    const madeOne = ctx();
    await run(madeOne, "switch_timeline", { timeline: "Selects" });
    expect(madeOne.timeline).toBe("Selects");
  });

  it("renames only timelines it made, and follows the new name", async () => {
    const context = ctx();
    expect(errorOf(await run(context, "rename_timeline", { name: "X" }))).toContain('"Main" is the user\'s');
    await run(context, "create_timeline", { name: "Draft" });
    await run(context, "rename_timeline", { name: "Final" });
    expect(context.timeline).toBe("Final");
    expect(useConnectionStore.getState().connections.premiere.madeTimelines).toEqual(["Final"]);
  });

  it("selects a clip with its linked clips in Premiere, and moves the playhead in Resolve", async () => {
    await run(ctx(), "select_clip", { clipId: "c1" });
    expect(ipc.nleCall).toHaveBeenCalledWith("premiere", "select_items", { timeline: "Main", itemIds: ["c1", "c2"], additive: false });
    const resolve = await run(ctx({ host: "resolve" }), "select_clip", { clipId: "c1" });
    expect(ipc.nleCall).toHaveBeenCalledWith("resolve", "set_playhead", { timeline: "Main", time: 2 });
    expect(resolve.summary).toContain("can't select a timeline clip");
  });

  it("names pool clips by short ids, both ways", async () => {
    const listed = await run(ctx(), "list_media_pool", { bin: "inter" });
    expect((listed.result as { clips: { id: string }[] }).clips.map((c) => c.id)).toEqual(["p1", "p2"]);
    expect(poolClipId("premiere", "p2")).toBe("000f2");
    expect(aliasOf("premiere", "000f1")).toBe("p1");
    await run(ctx(), "select_media_assets", { assetIds: ["p2", "p1"] });
    expect(ipc.nleCall).toHaveBeenCalledWith("premiere", "select_pool_clips", { clipIds: ["000f2", "000f1"] });
    const imported = await run(ctx(), "import_media", { filePaths: ["/m/CamA.mov"], bin: "Interviews" });
    expect(ipc.nleCall).toHaveBeenCalledWith("premiere", "import_media", { paths: ["/m/CamA.mov"], bin: "Interviews" });
    expect(imported.result).toEqual({ imported: [{ path: "/m/CamA.mov", clipId: "p1" }], reused: [] });
  });

  it("puts the pool in the snapshot, with the selection", async () => {
    await run(ctx(), "list_media_pool");
    expect(poolContext("premiere")).toBe(
      [
        "[Premiere project — 2 clip(s) in 1 bin(s)]",
        "Interview:",
        '  p1 "CamA.mov" Video + Audio · 600.0s · unused',
        '  p2 "Zoom.wav" Audio · 610.0s · description: lav · used 1× [selected]',
        'Selected in the Project panel: p2 "Zoom.wav"',
      ].join("\n"),
    );
    useConnectionStore.setState({ connections: { premiere: emptyConnection(), resolve: emptyConnection() } });
    expect(poolContext("resolve")).toBe("[Resolve Media Pool — not readable right now]");
  });

  it("starts the connection over in another project", () => {
    const store = useConnectionStore.getState();
    store.addMadeTimeline("premiere", "Cut");
    store.forProject("premiere", "Doc");
    expect(useConnectionStore.getState().connections.premiere.madeTimelines).toEqual(["Cut"]);
    store.forProject("premiere", "Other");
    expect(useConnectionStore.getState().connections.premiere).toEqual(emptyConnection("Other"));
  });
});
