import { beforeEach, describe, expect, it, vi } from "vitest";

const ipc = vi.hoisted(() => ({ nleCall: vi.fn() }));
vi.mock("../ipc", () => ipc);

import { editExecutors, nestRange } from "./editTools";
import { useEditLogStore } from "../../store/useEditLogStore";
import type { EditContext } from "./edits";
import type { HostTimeline } from "../../types/timeline";

const VIEW: HostTimeline = {
  project: "Doc",
  timeline: "Main",
  fps: 25,
  startTimecode: "00:00:00:00",
  duration: 20,
  isCurrent: true,
  tracks: [
    {
      type: "video",
      index: 1,
      name: "V1",
      enabled: true,
      clips: [
        { id: "v1", name: "A.mov", start: 0, end: 4, enabled: true, linkedIds: ["a1"] },
        { id: "v2", name: "B.mov", start: 4, end: 9, enabled: true },
      ],
    },
    { type: "audio", index: 1, name: "A1", enabled: true, clips: [{ id: "a1", name: "A.mov", start: 0, end: 4, enabled: true, linkedIds: ["v1"] }] },
  ],
  markers: [],
};

const sent = (command: string) => ipc.nleCall.mock.calls.filter((c) => c[1] === command).map((c) => c[2]);

describe("edit tools", () => {
  let run: ReturnType<typeof editExecutors>;

  beforeEach(() => {
    vi.clearAllMocks();
    useEditLogStore.setState({ entries: [], backups: {}, restoredIds: { premiere: {}, resolve: {} } });
    ipc.nleCall.mockImplementation(async (_h: string, command: string) => {
      if (command === "read_timeline") return VIEW;
      if (command === "backup_timeline") return { backup: "Main (before VibeCut 1)" };
      if (command === "get_playhead") return { time: 2 };
      return { changes: [{ kind: "enabled", name: "A.mov", itemId: "v1", after: false }], refused: [] };
    });
    const ctx: EditContext = { host: "premiere", timeline: "Main", step: "m1", stepText: "edit" };
    run = editExecutors(ctx);
  });

  it("adds clips by path, with source range defaults", async () => {
    await run.add_clips({ clips: [{ path: "/m/b.mov", sourceOut: 3, at: 10, volumeDb: -6, sound: false }] });
    expect(sent("add_clips")).toEqual([{ timeline: "Main", clips: [{ path: "/m/b.mov", at: 10, sourceIn: 0, sourceOut: 3, volumeDb: -6, sound: false }] }]);
    await expect(run.add_clips({ clips: [{ clipId: "p3", at: 1, sourceOut: 2 }] })).rejects.toThrow("give path");
  });

  it("maps delete, switches and levels", async () => {
    await run.delete_clips({ itemIds: ["v1"], withLinked: false });
    await run.set_clips_enabled({ itemIds: ["v1"], enabled: false });
    await run.set_clip_levels({ levels: [{ itemId: "a1", volumeDb: -3 }] });
    expect(sent("delete_clips")).toEqual([{ timeline: "Main", itemIds: ["v1"], withLinked: false }]);
    expect(sent("set_clips_enabled")).toEqual([{ timeline: "Main", itemIds: ["v1"], enabled: false }]);
    expect(sent("set_clip_levels")).toEqual([{ timeline: "Main", levels: [{ itemId: "a1", volumeDb: -3 }] }]);
    await expect(run.set_clip_levels({ levels: [{ volumeDb: 1 }] })).rejects.toThrow("levels[0].itemId");
  });

  it("fades named clips", async () => {
    await run.set_clip_fade({ clipIds: ["v1", "a1"], which: "fadeOut", seconds: 1.5 });
    expect(sent("set_clip_fades")).toEqual([{ timeline: "Main", itemIds: ["v1", "a1"], which: "fadeOut", seconds: 1.5 }]);
    await expect(run.set_clip_fade({ clipIds: ["v1"], which: "both", seconds: 1 })).rejects.toThrow("fadeIn");
  });

  it("splits at the playhead, under it, unless told otherwise", async () => {
    await run.split_clip({});
    await run.split_clip({ clipIds: ["v2"], time: 6 });
    expect(sent("split_clips")).toEqual([
      { timeline: "Main", itemIds: ["v1", "a1"], time: 2 },
      { timeline: "Main", itemIds: ["v2"], time: 6 },
    ]);
    await expect(run.split_clip({ time: 15 })).rejects.toThrow("No clip runs across 15.0s");
  });

  it("trims, slips and moves through reshape_clip, and refuses ripple", async () => {
    await run.trim_clip_start({ clipId: "v1", rawSourceIn: 1 });
    await run.slip_clip({ clipId: "a1", delta: -0.5, withLinked: false });
    await run.move_clip({ clipId: "v2", startTime: 12, track: 2 });
    expect(sent("reshape_clip")).toEqual([
      { timeline: "Main", itemId: "v1", sourceIn: 1 },
      { timeline: "Main", itemId: "a1", slip: -0.5, withLinked: false },
      { timeline: "Main", itemId: "v2", start: 12, videoTrack: 2 },
    ]);
    await expect(run.trim_clip_end({ clipId: "v1", rawSourceOut: 2, ripple: true })).rejects.toThrow("Ripple edits aren't available");
  });

  it("nests a range, or the stretch clips and their links cover", async () => {
    expect(nestRange({ clipIds: ["a1"] }, VIEW)).toEqual({ start: 0, end: 4 });
    expect(nestRange({ start: 1, end: 2 }, VIEW)).toEqual({ start: 1, end: 2 });
    expect(() => nestRange({ clipIds: ["zz"] }, VIEW)).toThrow("There's no clip zz");
    await run.nest_clips({ clipIds: ["v1", "v2"], name: "Montage" });
    expect(sent("nest_clips")).toEqual([{ timeline: "Main", start: 0, end: 9, name: "Montage" }]);
  });

  it("reverts by id or the last request", async () => {
    await run.set_clips_enabled({ itemIds: ["v1"], enabled: false });
    ipc.nleCall.mockResolvedValueOnce({ reverted: [{ kind: "enabled", name: "A.mov" }], changedSince: [], failed: [], lost: [], restoredIds: {} });
    const outcome = await run.revert_timeline_edits({ lastStep: true });
    expect(outcome.summary).toBe("Reverted 1 timeline change");
    expect(sent("revert_timeline_changes")[0]).toMatchObject({ timeline: "Main", backup: "Main (before VibeCut 1)" });
    await expect(run.revert_timeline_edits({})).rejects.toThrow("Give editIds");
  });
});
