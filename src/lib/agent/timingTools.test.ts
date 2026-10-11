import { beforeEach, describe, expect, it, vi } from "vitest";

const ipc = vi.hoisted(() => ({ nleCall: vi.fn() }));
vi.mock("../ipc", () => ipc);

import { draftIdFor, timingExecutors } from "./timingTools";
import { describeTimelineChange } from "./edits";
import { emptyConnection, useConnectionStore } from "../../store/useConnectionStore";
import { useEditLogStore } from "../../store/useEditLogStore";
import { draftFromSnapshot } from "../../vibecut/lib/connect/hostDraft";
import type { HostTimeline } from "../../types/timeline";
import type { ToolContext } from "./tools";

const VIEW: HostTimeline = {
  project: "Doc",
  timeline: "Main",
  fps: 25,
  startTimecode: "00:00:00:00",
  duration: 9,
  isCurrent: true,
  tracks: [
    {
      type: "video",
      index: 1,
      name: "V1",
      enabled: true,
      clips: [
        { id: "v1", name: "A.mov", start: 0, end: 4, enabled: true, sourceIn: 0, sourceOut: 4, filePath: "/m/A.mov", linkedIds: ["a1"] },
        { id: "v2", name: "B.mov", start: 4, end: 9, enabled: true, sourceIn: 0, sourceOut: 5, filePath: "/m/B.mov" },
      ],
    },
    { type: "audio", index: 1, name: "A1", enabled: true, clips: [{ id: "a1", name: "A.mov", start: 0, end: 4, enabled: true, sourceIn: 0, sourceOut: 4, filePath: "/m/A.mov", linkedIds: ["v1"] }] },
  ],
  markers: [],
};

const sent = (command: string) => ipc.nleCall.mock.calls.filter((c) => c[1] === command).map((c) => c[2]);
const ctx = (host: "premiere" | "resolve"): ToolContext => ({ host, timeline: "Main", step: "m1", stepText: "edit" });

describe("speed, transitions and tracks (Phase 12b–12d)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useConnectionStore.setState({ connections: { premiere: emptyConnection("Doc"), resolve: emptyConnection("Doc") } });
    useEditLogStore.setState({ entries: [], backups: {}, restoredIds: { premiere: {}, resolve: {} } });
    ipc.nleCall.mockImplementation(async (_h: string, command: string) => {
      if (command === "read_timeline") return VIEW;
      if (command === "backup_timeline") return { backup: "Main (before VibeCut 1)" };
      if (command === "set_clip_speed") return { changes: [{ kind: "speed", name: "A.mov", itemId: "v1", before: 1, after: 2, ripple: false, end: 4, endBefore: 4 }], refused: [] };
      if (command === "set_track_options") return { changes: [{ kind: "trackOptions", name: "A1", type: "audio", index: 1, options: { muted: [false, true], locked: [false, true] } }], refused: [] };
      return { changes: [], refused: [] };
    });
  });

  it("sets a constant speed on the timeline, with a backup and a log entry", async () => {
    const outcome = await timingExecutors(ctx("resolve")).set_clip_speed({ clipId: "v1", speed: 2 });
    expect(sent("set_clip_speed")).toEqual([{ timeline: "Main", itemId: "v1", speed: 2, ripple: false }]);
    expect(outcome.summary).toContain('"A.mov" speed 1x → 2x, same length (its linked sound follows)');
    expect(outcome.summary).toContain('backup: "Main (before VibeCut 1)"');
    expect(useEditLogStore.getState().entries.map((e) => e.tool)).toEqual(["set_clip_speed"]);
    await expect(timingExecutors(ctx("resolve")).set_clip_speed({ clipId: "v1", speed: 40 })).rejects.toThrow("0.05 to 20");
  });

  it("makes a rippled speed change in a draft on Premiere, which can't ripple from a script", async () => {
    const outcome = await timingExecutors(ctx("premiere")).set_clip_speed({ clipId: "v1", speed: 2, ripple: true });
    expect(sent("set_clip_speed")).toEqual([]);
    const draft = useConnectionStore.getState().connections.premiere.draft!;
    expect(draft.video[0].clips.map((c) => [c.sourceName, c.start, c.end, c.speed])).toEqual([
      ["A.mov", 0, 2, 2],
      ["B.mov", 2, 7, 1],
    ]);
    expect(outcome.summary).toMatch(/^Draft: /);
  });

  it("ramps a clip in a draft (Phase 16c): half speed from 2 s of source, rippling what follows", async () => {
    const run = timingExecutors(ctx("resolve"));
    const outcome = await run.set_speed_ramp({ clipId: "v1", changes: [{ sourceTime: 2, speed: 0.5 }] });
    expect(sent("set_clip_speed")).toEqual([]);
    const draft = useConnectionStore.getState().connections.resolve.draft!;
    const [a, b] = draft.video[0].clips;
    // 2 s at 1x, then 2 s of source at 0.5x = 4 s: the clip is 6 s long and B moves 2 s later.
    expect([a.start, a.end, b.start, b.end]).toEqual([0, 6, 6, 11]);
    expect(a.timeRemap?.map((p) => [p.t, p.s])).toEqual([
      [0, 0],
      [2, 2],
      [6, 4],
    ]);
    // Its linked sound ramps with it.
    expect(draft.audio[0].clips[0].timeRemap?.length).toBe(3);
    expect(outcome.summary).toContain("send_to_resolve builds it as a new timeline, the ramp as pieces at constant speeds");
    await expect(run.set_speed_ramp({ clipId: "v1", changes: [] })).rejects.toThrow("non-empty");
    await expect(run.set_speed_ramp({ clipId: "v1", changes: [{ speed: 30 }] })).rejects.toThrow("0.05 to 20");
    await expect(run.set_speed_ramp({ clipId: "v1", changes: [{ speed: 2 }], easeSeconds: -1 })).rejects.toThrow("easeSeconds");
  });

  it("clears a ramp in the draft, and without a draft sets 1x on the timeline", async () => {
    const run = timingExecutors(ctx("resolve"));
    await run.clear_clip_speed({ clipId: "v1" });
    expect(sent("set_clip_speed")).toEqual([{ timeline: "Main", itemId: "v1", speed: 1, ripple: true }]);
    await run.set_speed_ramp({ clipId: "v1", changes: [{ sourceTime: 2, speed: 0.5 }] });
    await run.clear_clip_speed({ clipId: "v1" });
    const [a, b] = useConnectionStore.getState().connections.resolve.draft!.video[0].clips;
    expect([a.end, a.timeRemap, a.speed, b.start]).toEqual([4, undefined, 1, 4]);
  });

  it("names a draft's clip by the timeline clip it was cut from", () => {
    const draft = draftFromSnapshot(VIEW);
    expect([draftIdFor(draft, "v2"), draftIdFor(draft, "a1"), draftIdFor(draft, "draft-1")]).toEqual(["draft-1", "draft-2", "draft-1"]);
    expect(() => draftIdFor(draft, "zz")).toThrow("no clip zz in the draft");
  });

  it("refuses transitions and tracks while a draft is open, and solo always", async () => {
    useConnectionStore.getState().setDraft("resolve", draftFromSnapshot(VIEW));
    const run = timingExecutors(ctx("resolve"));
    await expect(run.set_transition({ clipId: "v1", kind: "dissolve" })).rejects.toThrow("A draft of \"Main\" is open");
    await expect(run.add_track({ type: "video" })).rejects.toThrow("A draft of");
    useConnectionStore.getState().setDraft("resolve", null);
    await expect(run.set_track_options({ type: "audio", index: 1, soloed: true })).rejects.toThrow("can't solo");
    await expect(run.set_track_options({ type: "audio", index: 1 })).rejects.toThrow("Give at least one of");
    await expect(run.set_transition({ clipId: "v1", kind: "wipe" })).rejects.toThrow('kind must be "dissolve"');
  });

  it("sends transitions, tracks and switches as the watchers take them", async () => {
    const run = timingExecutors(ctx("premiere"));
    await run.set_transition({ clipId: "v1", kind: "dipToBlack", seconds: 0.5 });
    await run.add_track({ type: "audio", count: 2 });
    await run.remove_track({ type: "video" });
    const switched = await run.set_track_options({ type: "audio", index: 1, muted: true, locked: true });
    expect(sent("set_transition")).toEqual([{ timeline: "Main", itemId: "v1", kind: "dipToBlack", seconds: 0.5 }]);
    expect(sent("add_track")).toEqual([{ timeline: "Main", type: "audio", count: 2 }]);
    expect(sent("remove_track")).toEqual([{ timeline: "Main", type: "video" }]);
    expect(sent("set_track_options")).toEqual([{ timeline: "Main", type: "audio", index: 1, options: { muted: true, locked: true } }]);
    expect(switched.summary).toContain("A1 muted, locked");
  });

  it("words speed and track changes as VibeCut does", () => {
    expect(describeTimelineChange({ kind: "speed", name: "A.mov", before: 1, after: 0.5, ripple: true, end: 8, endBefore: 4 })).toBe('"A.mov" speed 1x → 0.5x, now ending at 8.0s (later clips moved with it)');
    expect(describeTimelineChange({ kind: "track", action: "added", name: "V3" })).toBe("Added track V3");
    expect(describeTimelineChange({ kind: "trackOptions", name: "V2", options: { enabled: [true, false] } })).toBe("V2 switched off");
  });
});
