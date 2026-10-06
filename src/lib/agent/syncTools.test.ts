import { beforeEach, describe, expect, it, vi } from "vitest";

const ipc = vi.hoisted(() => ({ nleCall: vi.fn() }));
vi.mock("../ipc", () => ipc);
const core = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => core);

import { bestMatches, pairsToSync, slipFor, syncExecutors, type SyncReport } from "./syncTools";
import { emptyConnection, useConnectionStore } from "../../store/useConnectionStore";
import { useEditLogStore } from "../../store/useEditLogStore";
import type { HostClip, HostTimeline } from "../../types/timeline";
import type { ToolContext } from "./tools";

const clip = (id: string, extra: Partial<HostClip>): HostClip => ({ id, name: id, start: 2, end: 6, enabled: true, sourceIn: 5, ...extra });

/** VibeCut's hostSync fixture: A.mov on V1 linked to its own sound on A1 and A2 (Premiere's split
 * stereo), 0.12 s late, and C.mov on V2 at 10 s linked to a recorder WAV on A3. */
const SEQUENCE: HostTimeline = {
  project: "Doc",
  timeline: "Main",
  fps: 25,
  startTimecode: "",
  duration: 20,
  isCurrent: true,
  tracks: [
    { type: "video", index: 1, name: "V1", enabled: true, clips: [clip("v1", { filePath: "/m/A.mov", linkedIds: ["l1", "r1"] })] },
    { type: "video", index: 2, name: "V2", enabled: true, clips: [clip("v2", { start: 10, end: 14, sourceIn: 30, filePath: "/m/C.mov", linkedIds: ["w1", "w2"] })] },
    { type: "audio", index: 1, name: "A1", enabled: true, clips: [clip("l1", { sourceIn: 5.12, filePath: "/m/A.mov", linkedIds: ["v1", "r1"] })] },
    { type: "audio", index: 2, name: "A2", enabled: true, clips: [clip("r1", { sourceIn: 5.12, filePath: "/m/A.mov", linkedIds: ["v1", "l1"] })] },
    {
      type: "audio",
      index: 3,
      name: "A3",
      enabled: true,
      clips: [
        clip("w1", { start: 10, end: 14, sourceIn: 100, filePath: "/m/ROLL.wav", linkedIds: ["v2", "w2"] }),
        clip("x1", { start: 15, end: 18, sourceIn: 0, filePath: "/m/X.wav" }),
      ],
    },
    // The other channel of the same recording, slipped together with w1.
    { type: "audio", index: 4, name: "A4", enabled: true, clips: [clip("w2", { start: 10, end: 14, sourceIn: 100, filePath: "/m/ROLL.wav", linkedIds: ["v2", "w1"] })] },
  ],
  markers: [],
};

const MATCH = { camera: "/m/C.mov", recorder: "/m/ROLL.wav", offset: -70.5, score: 0.9, confidence: 0.8, matched: true, refined: true, overlapSeconds: 4 };

let view: HostTimeline;
let report: SyncReport;
let suite: unknown;
const sent = (command: string) => ipc.nleCall.mock.calls.filter((c) => c[1] === command).map((c) => c[2]);
const context: ToolContext = { host: "premiere", timeline: "Main", step: "m1", stepText: "sync" };
const run = (name: string, args: Record<string, unknown>) => syncExecutors({ ...context })[name](args);

beforeEach(() => {
  vi.clearAllMocks();
  view = SEQUENCE;
  report = { matches: [MATCH], errors: [] };
  suite = null;
  useConnectionStore.setState({ connections: { premiere: emptyConnection("Doc"), resolve: emptyConnection("Doc") } });
  useEditLogStore.setState({ entries: [], backups: {}, restoredIds: { premiere: {}, resolve: {} } });
  let added = 0;
  ipc.nleCall.mockImplementation(async (_h: string, command: string, args: Record<string, unknown>) => {
    if (command === "read_timeline") return view;
    if (command === "backup_timeline") return { backup: "Main (before VibeCut 1)" };
    if (command === "add_clips") {
      const clips = args.clips as { path: string; picture?: boolean }[];
      return {
        changes: clips.map((c) => {
          added += 1;
          return { kind: "added", name: c.path.split("/").pop(), at: 0, itemIds: c.picture === false ? [`rec${added}`] : [`cam${added}v`, `cam${added}a`] };
        }),
        refused: [],
      };
    }
    return { changes: [{ kind: "enabled", name: "x", itemId: "x", after: true }], refused: [] };
  });
  core.invoke.mockImplementation(async (command: string, args: Record<string, unknown>) => {
    if (command === "sync_audio") return report;
    // The cameras placed by sync_and_place are 8 s long; A.mov (on the timeline already) is long.
    if (command === "media_durations") return (args.paths as string[]).map((p) => (p.endsWith(".wav") || p === "/m/A.mov" ? 600 : 8));
    if (command === "read_suite_sync") return suite;
    return null;
  });
});

describe("the sync math", () => {
  it("keeps the most confident match per camera, and only matches", () => {
    const best = bestMatches({
      matches: [
        { ...MATCH, recorder: "/m/A.wav", confidence: 0.4 },
        { ...MATCH, recorder: "/m/B.wav", confidence: 0.9 },
        { ...MATCH, camera: "/m/D.mov", matched: false, confidence: 0.95 },
      ],
      errors: [],
    });
    expect([...best.keys()]).toEqual(["/m/C.mov"]);
    expect(best.get("/m/C.mov")?.recorder).toBe("/m/B.wav");
  });

  it("slips the sound to the source in point that matches its picture", () => {
    const picture = SEQUENCE.tracks[1].clips[0];
    const sound = SEQUENCE.tracks[4].clips[0];
    // camera 30 s = recording 100.5 s.
    expect(slipFor(picture, sound, -70.5, 600)).toEqual({ sourceIn: 100.5 });
    expect(slipFor({ ...picture, speed: 2 }, sound, -70.5, 600)).toEqual({ error: expect.stringMatching(/speed change/) });
    expect(slipFor(picture, sound, -70.5, 102)).toEqual({ error: expect.stringMatching(/doesn't cover/) });
    expect(slipFor(picture, sound, 40, 600)).toEqual({ error: expect.stringMatching(/doesn't cover/) });
  });

  it("pairs a picture with its linked sound from another file, and its own only when asked", () => {
    expect(pairsToSync(SEQUENCE, ["w1"]).map((p) => [p.picture.id, p.sounds.map((s) => s.id)])).toEqual([["v2", ["w1", "w2"]]]);
    expect(pairsToSync(SEQUENCE, ["v1"], true).map((p) => p.sounds.map((s) => s.id))).toEqual([["l1", "r1"]]);
    expect(() => pairsToSync(SEQUENCE, ["v1"])).toThrow("its own sound needs only slip_into_sync");
    expect(() => pairsToSync(SEQUENCE, ["x1"])).toThrow("isn't linked to a picture clip");
    expect(() => pairsToSync(SEQUENCE, ["nope"])).toThrow("no clip nope");
  });
});

describe("slip_into_sync", () => {
  it("slips the picture's own sound once per recording, leaving the picture", async () => {
    const outcome = await run("slip_into_sync", { clipIds: ["v1"] });
    expect(sent("reshape_clip")).toEqual([{ timeline: "Main", itemId: "l1", slip: -0.12, withLinked: false }]);
    expect(outcome.result).toMatchObject({ slipped: [{ clipId: "l1", seconds: -0.12 }] });
    expect(outcome.summary).toBe("Slipped 1 sound clip into sync");
  });

  it("needs an offset for a separate recording: the session's first, then A-Sync's", async () => {
    const before = await run("slip_into_sync", { clipIds: ["w1"] });
    expect(sent("reshape_clip")).toEqual([]);
    expect(before.result).toMatchObject({ problems: ['"w1": no sync offset known with "v2"'], note: expect.stringMatching(/sync_clips/) });

    suite = { method: "waveform", tracks: [{ path: "/m/ROLL.wav", offsetSeconds: -70, enabled: true }] };
    await run("slip_into_sync", { clipIds: ["w1"] });
    // A-Sync's -70 puts the recording 100 s in, where it already is: nothing to slip.
    expect(sent("reshape_clip")).toEqual([]);

    useConnectionStore.getState().addSyncOffsets("premiere", { "/m/C.mov|/m/ROLL.wav": -70.5 });
    await run("slip_into_sync", { clipIds: ["w1"] });
    expect(sent("reshape_clip")).toEqual([{ timeline: "Main", itemId: "w1", slip: 0.5, withLinked: false }]);
  });

  it("leaves sound already in sync, and reports a speed change", async () => {
    view = {
      ...SEQUENCE,
      tracks: SEQUENCE.tracks.map((t) => ({ ...t, clips: t.clips.map((c) => (c.id === "l1" || c.id === "r1" ? { ...c, sourceIn: 5.01 } : c.id === "v2" ? { ...c, speed: 2 } : c)) })),
    };
    useConnectionStore.getState().addSyncOffsets("premiere", { "/m/C.mov|/m/ROLL.wav": -70.5 });
    expect((await run("slip_into_sync", { clipIds: ["v1"] })).summary).toBe("Nothing needed slipping");
    expect((await run("slip_into_sync", { clipIds: ["w1"] })).result).toMatchObject({ problems: [expect.stringMatching(/"w1": .*speed change/)] });
    expect(sent("reshape_clip")).toEqual([]);
  });

  it("reports a slip the editor refused", async () => {
    ipc.nleCall.mockImplementation(async (_h: string, command: string) => {
      if (command === "read_timeline") return view;
      if (command === "backup_timeline") return { backup: "Main (before VibeCut 1)" };
      return { changes: [], refused: [{ itemId: "l1", reason: "the clip is too short to slip" }] };
    });
    const outcome = await run("slip_into_sync", { clipIds: ["v1"] });
    expect(outcome.result).toMatchObject({ slipped: [], problems: ['"l1": the clip is too short to slip'] });
  });

  it("is refused while a draft is open", async () => {
    useConnectionStore.getState().setDraft("premiere", { base: "Main", changes: ["cut"] } as never);
    await expect(run("slip_into_sync", { clipIds: ["v1"] })).rejects.toThrow(/draft/i);
  });
});

describe("sync_clips", () => {
  it("matches by waveform, keeps the offset for the connection and slips the recording once", async () => {
    const outcome = await run("sync_clips", { clipIds: ["v2"] });
    expect(core.invoke).toHaveBeenCalledWith("sync_audio", { jobId: expect.any(String), cameras: ["/m/C.mov"], recorders: ["/m/ROLL.wav"] });
    expect(useConnectionStore.getState().connections.premiere.syncOffsets).toEqual({ "/m/C.mov|/m/ROLL.wav": -70.5 });
    expect(sent("reshape_clip")).toEqual([{ timeline: "Main", itemId: "w1", slip: 0.5, withLinked: false }]);
    expect(outcome.summary).toBe("Matched 1 picture/sound pair(s) by waveform; slipped 1 sound clip(s) into sync");
    expect(outcome.result).toMatchObject({ offsets: [{ picture: "C.mov", sound: "ROLL.wav", offsetSeconds: -70.5, confidence: 0.8 }], unmatched: [] });
  });

  it("only finds the offset when slip is false", async () => {
    await run("sync_clips", { clipIds: ["w1"], slip: false });
    expect(sent("reshape_clip")).toEqual([]);
    expect(useConnectionStore.getState().connections.premiere.syncOffsets).toEqual({ "/m/C.mov|/m/ROLL.wav": -70.5 });
  });

  it("reports no match and slips nothing", async () => {
    report = { matches: [{ ...MATCH, matched: false, confidence: 0.1 }], errors: [] };
    const outcome = await run("sync_clips", { clipIds: ["w1"] });
    expect(outcome.summary).toBe("Matched 0 picture/sound pair(s) by waveform; 1 didn't match");
    expect(outcome.result).toMatchObject({ offsets: [], unmatched: ["C.mov + ROLL.wav"] });
    expect(sent("reshape_clip")).toEqual([]);
  });
});

describe("sync_and_place", () => {
  const CAM2 = { ...MATCH, camera: "/m/D.mov", recorder: "/m/ROLL.wav", offset: -200, driftSeconds: 0.05 };

  it("places each camera with the stretch of its recording, camera sound off, all linked", async () => {
    report = { matches: [MATCH, CAM2], errors: [] };
    const outcome = await run("sync_and_place", { cameras: ["/m/C.mov", "/m/D.mov"], recorders: ["/m/ROLL.wav"], at: 30 });
    // Cameras are 8 s long: C.mov from 30 s, D.mov from 38 s; ROLL.wav under each at its offset.
    expect(sent("add_clips")).toEqual([
      { timeline: "Main", clips: [{ path: "/m/C.mov", sourceIn: 0, sourceOut: 8, at: 30 }, { path: "/m/ROLL.wav", sourceIn: 70.5, sourceOut: 78.5, at: 30, picture: false }] },
      { timeline: "Main", clips: [{ path: "/m/D.mov", sourceIn: 0, sourceOut: 8, at: 38 }, { path: "/m/ROLL.wav", sourceIn: 200, sourceOut: 208, at: 38, picture: false }] },
    ]);
    expect(sent("set_links")).toEqual([
      { timeline: "Main", itemIds: ["cam1v", "cam1a", "rec2"], action: "link" },
      { timeline: "Main", itemIds: ["cam3v", "cam3a", "rec4"], action: "link" },
    ]);
    expect(useConnectionStore.getState().connections.premiere.syncOffsets).toEqual({ "/m/C.mov|/m/ROLL.wav": -70.5, "/m/D.mov|/m/ROLL.wav": -200 });
    expect(outcome.result).toMatchObject({
      placed: [
        { camera: "C.mov", recorder: "ROLL.wav", at: 30, end: 38 },
        { camera: "D.mov", at: 38, end: 46 },
      ],
      drift: [{ camera: "D.mov", seconds: 0.05 }],
    });
    // One backup for the whole request.
    expect(sent("backup_timeline")).toHaveLength(1);
  });

  it("switches off only the camera's own sound clips", async () => {
    let added = 0;
    const withSound = (v: HostTimeline): HostTimeline => ({
      ...v,
      tracks: [...v.tracks, { type: "audio", index: 9, name: "A9", enabled: true, clips: [clip("cam1a", { filePath: "/m/C.mov" })] }],
    });
    ipc.nleCall.mockImplementation(async (_h: string, command: string, args: Record<string, unknown>) => {
      if (command === "read_timeline") return added ? withSound(view) : view;
      if (command === "backup_timeline") return { backup: "b" };
      if (command === "add_clips") {
        added += 1;
        return { changes: (args.clips as { picture?: boolean }[]).map((c, i) => ({ kind: "added", name: "x", itemIds: c.picture === false ? [`rec${i}`] : ["cam1v", "cam1a"] })), refused: [] };
      }
      return { changes: [{ kind: "enabled", name: "x", after: false }], refused: [] };
    });
    await run("sync_and_place", { cameras: ["/m/C.mov"], recorders: ["/m/ROLL.wav"] });
    expect(sent("set_clips_enabled")).toEqual([{ timeline: "Main", itemIds: ["cam1a"], enabled: false }]);
    // Placed at the timeline's end by default.
    expect((sent("add_clips")[0] as { clips: { at: number }[] }).clips[0].at).toBe(20);
  });

  it("skips and names a camera that matched nothing, and refuses when nothing could be placed", async () => {
    report = { matches: [MATCH, { ...CAM2, matched: false }], errors: [] };
    const outcome = await run("sync_and_place", { cameras: ["/m/C.mov", "/m/D.mov"], recorders: ["/m/ROLL.wav"] });
    expect(outcome.result).toMatchObject({ skipped: ["D.mov: its sound matched none of the recordings"] });
    expect(outcome.summary).toMatch(/skipped 1$/);

    report = { matches: [], errors: [{ path: "/m/C.mov", message: "no audio stream" }] };
    await expect(run("sync_and_place", { cameras: ["/m/C.mov"], recorders: ["/m/ROLL.wav"] })).rejects.toThrow("Nothing was placed: C.mov: no audio stream");
  });

  it("takes project clips and timeline clips as well as paths", async () => {
    useConnectionStore.setState({
      connections: {
        premiere: { ...emptyConnection("Doc"), pool: { clips: [{ id: "n:7", name: "D.mov", filePath: "/m/D.mov" }] } as never, aliases: { "n:7": "p1" } },
        resolve: emptyConnection("Doc"),
      },
    });
    await run("sync_and_place", { cameras: ["v2", "p1", "/m/E.mov"], recorders: ["w1"] });
    expect(core.invoke).toHaveBeenCalledWith("sync_audio", { jobId: expect.any(String), cameras: ["/m/C.mov", "/m/D.mov", "/m/E.mov"], recorders: ["/m/ROLL.wav"] });
    await expect(run("sync_and_place", { cameras: ["nothing"], recorders: ["w1"] })).rejects.toThrow("isn't a clip");
  });
});

describe("link_clips and unlink_clips", () => {
  it("link and unlink through the edit path", async () => {
    await run("link_clips", { clipIds: ["v1", "x1", "v1"] });
    await run("unlink_clips", { clipIds: ["x1"] });
    expect(sent("set_links")).toEqual([
      { timeline: "Main", itemIds: ["v1", "x1"], action: "link" },
      { timeline: "Main", itemIds: ["x1"], action: "unlink" },
    ]);
    expect(useEditLogStore.getState().entries.map((e) => e.tool)).toEqual(["link_clips", "unlink_clips"]);
    await expect(run("link_clips", { clipIds: ["v1"] })).rejects.toThrow("at least two");
  });
});
