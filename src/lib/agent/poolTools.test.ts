import { beforeEach, describe, expect, it, vi } from "vitest";

const ipc = vi.hoisted(() => ({ nleCall: vi.fn() }));
vi.mock("../ipc", () => ipc);

import { poolExecutors, poolToolDeclarations } from "./poolTools";
import { revertLastRequest, revertTimelineEdits } from "./edits";
import { needsReview } from "./toolKinds";
import { emptyConnection, useConnectionStore } from "../../store/useConnectionStore";
import { useEditLogStore } from "../../store/useEditLogStore";
import type { HostPool } from "../../types/pool";
import type { ToolContext } from "./tools";

const POOL: HostPool = {
  bins: [{ path: "Master", clips: 2 }],
  clips: [
    { id: "uid-a", name: "A.mov", bin: "Master", type: "Video + Audio" },
    { id: "uid-b", name: "B.mov", bin: "Master", type: "Video + Audio" },
  ],
  timelines: ["Main"],
  truncated: false,
  selection: { pool: [], timeline: [] },
} as unknown as HostPool;

const sent = (command: string) => ipc.nleCall.mock.calls.filter((c) => c[1] === command).map((c) => c[2]);
const ctx = (host: "premiere" | "resolve" = "resolve"): ToolContext => ({ host, timeline: "Main", step: "m1", stepText: "tidy the bins" });

describe("organizing the project (Phase 12e)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    const connection = { ...emptyConnection("Doc"), pool: POOL, aliases: { "uid-a": "p1", "uid-b": "p2" } };
    useConnectionStore.setState({ connections: { premiere: connection, resolve: connection } });
    useEditLogStore.setState({ entries: [], backups: {}, restoredIds: { premiere: {}, resolve: {} } });
    ipc.nleCall.mockImplementation(async (_h: string, command: string, args: Record<string, unknown>) => {
      if (command === "read_media_pool") return POOL;
      if (command === "set_clip_labels") return { changes: [{ clipId: "uid-a", field: "color", before: "", after: "Orange" }], createdBins: [], refused: [] };
      if (command === "move_clips") return { changes: [{ clipId: "uid-b", field: "bin", before: "Master", after: "Master/B-roll" }], createdBins: ["Master/B-roll"], refused: [], alreadyThere: [] };
      if (command === "rename_clips") return { changes: [], createdBins: [], refused: [{ clipId: "uid-a", reason: "Resolve kept the old name" }] };
      if (command === "revert_pool_changes") return { reverted: (args.changes as unknown[]).map(() => ({ clipId: "x", field: "y" })), changedSince: [], failed: [], binsRemoved: args.createdBins, binsKept: [] };
      if (command === "revert_timeline_changes") return { reverted: [{ kind: "enabled", name: "A.mov" }], changedSince: [], failed: [], lost: [], restoredIds: {} };
      throw new Error(`unexpected ${command}`);
    });
  });

  it("sends the editor's own ids, logs the change with what it replaced and reads the pool again", async () => {
    const outcome = await poolExecutors(ctx()).set_clip_labels({ clipIds: ["p1"], color: "Orange" });
    expect(sent("set_clip_labels")).toEqual([{ clipIds: ["uid-a"], color: "Orange" }]);
    expect(outcome.summary).toBe("Changed the colour or flags of 1 clip in Resolve (it can be reverted: e1)");
    expect(outcome.result).toMatchObject({ editId: "e1", changed: [{ clipId: "p1", field: "color", before: "", after: "Orange" }] });
    const [entry] = useEditLogStore.getState().entries;
    expect(entry).toMatchObject({ tool: "set_clip_labels", step: "m1", backup: "", changes: [], pool: { createdBins: [] } });
    expect(sent("read_media_pool")).toHaveLength(1);
  });

  it("logs nothing when nothing changed, and says what the editor refused", async () => {
    const outcome = await poolExecutors(ctx()).rename_clips({ renames: [{ clipId: "p1", name: "Opening" }] });
    expect(outcome.summary).toBe("Nothing needed changing; Resolve refused 1: p1 (Resolve kept the old name)");
    expect(useEditLogStore.getState().entries).toEqual([]);
    await expect(poolExecutors(ctx()).rename_clips({ renames: [{ clipId: "p1" }] })).rejects.toThrow("needs a clipId and a name");
  });

  it("is undone with the request's timeline edits by Revert, a made bin with it", async () => {
    useEditLogStore.getState().log({ step: "m1", stepText: "tidy", host: "resolve", timeline: "Main", tool: "set_clips_enabled", summary: "off", backup: "Main (before VibeCut 1)", changes: [{ kind: "enabled", name: "A.mov", itemId: "v1", after: false }] });
    await poolExecutors(ctx()).move_clips({ clipIds: ["p2"], bin: "Master/B-roll", create: true });
    const outcome = await revertLastRequest();
    expect(sent("revert_pool_changes")).toEqual([{ changes: [{ clipId: "uid-b", field: "bin", before: "Master", after: "Master/B-roll" }], createdBins: ["Master/B-roll"] }]);
    expect(sent("revert_timeline_changes")).toHaveLength(1);
    expect(outcome.summary).toBe("Reverted 1 timeline change and 1 Media Pool change; removed the bin(s) Master/B-roll");
    expect(useEditLogStore.getState().entries.every((e) => e.reverted)).toBe(true);
    await expect(revertTimelineEdits(["e2"])).rejects.toThrow("already reverted");
  });

  it("offers flags and keywords on Resolve only, and goes through review", () => {
    const props = (host: "premiere" | "resolve", name: string) =>
      Object.keys((poolToolDeclarations(host).find((d) => d.name === name)!.parameters as { properties: Record<string, unknown> }).properties);
    expect(props("resolve", "set_clip_labels")).toEqual(["clipIds", "color", "addFlags", "clearFlags"]);
    expect(props("premiere", "set_clip_labels")).toEqual(["clipIds", "color"]);
    expect(props("premiere", "set_clip_metadata")).toEqual(["clipIds", "description", "logNote", "scene", "shot", "good"]);
    expect(props("resolve", "set_clip_metadata")).toContain("replaceKeywords");
    for (const name of ["create_bins", "move_clips", "set_clip_labels", "set_clip_metadata", "rename_clips"]) expect(needsReview(name)).toBe(true);
  });
});
