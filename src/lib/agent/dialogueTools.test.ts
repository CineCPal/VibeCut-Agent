import { beforeEach, describe, expect, it, vi } from "vitest";

const ipc = vi.hoisted(() => ({ nleCall: vi.fn() }));
vi.mock("../ipc", () => ipc);
const jobs = vi.hoisted(() => ({ runJob: vi.fn() }));
vi.mock("../jobs", () => jobs);

import { soundClips } from "./dialogueTools";
import { executorsFor, runTool, type ToolContext } from "./tools";
import { emptyConnection, useConnectionStore } from "../../store/useConnectionStore";
import { useEditLogStore } from "../../store/useEditLogStore";
import type { HostClip, HostTimeline } from "../../types/timeline";

const clip = (id: string, start: number, end: number, over: Partial<HostClip> = {}): HostClip => ({ id, name: id, start, end, enabled: true, sourceIn: 10, sourceOut: 10 + end - start, filePath: "/m/int.mov", ...over });

/** An interview with its sound split into two channel clips (A1, A2), then a second shot. */
const VIEW: HostTimeline = {
  project: "Doc",
  timeline: "Main",
  fps: 25,
  startTimecode: "00:00:00:00",
  duration: 20,
  isCurrent: true,
  tracks: [
    { type: "video", index: 1, name: "", enabled: true, clips: [clip("v1", 0, 8, { linkedIds: ["a1", "a2"] }), clip("v2", 8, 20, { filePath: "/m/b.mov", sourceIn: 0, sourceOut: 12, linkedIds: ["a3"] })] },
    { type: "audio", index: 1, name: "", enabled: true, clips: [clip("a1", 0, 8, { channel: 1, volumeDb: -3, linkedIds: ["v1"] }), clip("a3", 8, 20, { filePath: "/m/b.mov", sourceIn: 0, sourceOut: 12, linkedIds: ["v2"] })] },
    { type: "audio", index: 2, name: "", enabled: true, clips: [clip("a2", 0, 8, { channel: 2, volumeDb: -3, linkedIds: ["v1"] })] },
  ],
  markers: [],
};

describe("which sound is cleaned", () => {
  it("takes a picture's linked sound, once per recording at a place", () => {
    expect(soundClips(VIEW.tracks, ["v1"]).map((c) => c.id)).toEqual(["a1"]);
    expect(soundClips(VIEW.tracks, ["a3", "v2"]).map((c) => c.id)).toEqual(["a3"]);
  });

  it("refuses unknown clips, sped-up sound, and sound already off", () => {
    expect(() => soundClips(VIEW.tracks, ["zz"])).toThrow("no clip zz");
    const fast = [{ type: "audio", clips: [clip("s", 0, 4, { speed: 2 })] }];
    expect(() => soundClips(fast, ["s"])).toThrow("speed change");
    const off = [{ type: "audio", clips: [clip("s", 0, 4, { enabled: false })] }];
    expect(() => soundClips(off, ["s"])).toThrow("already switched off");
  });
});

describe("clean_dialogue", () => {
  const context: ToolContext = { host: "resolve", timeline: "Main", step: "s1", stepText: "clean up the interview" };
  const sent = (command: string) => ipc.nleCall.mock.calls.filter((c) => c[1] === command).map((c) => c[2]);

  beforeEach(() => {
    vi.clearAllMocks();
    useEditLogStore.setState({ entries: [], backups: {}, restoredIds: { premiere: {}, resolve: {} } });
    useConnectionStore.setState({ connections: { premiere: emptyConnection("Doc"), resolve: emptyConnection("Doc") } });
    jobs.runJob.mockResolvedValue({
      status: "done",
      result: {
        files: [
          { path: "/m/int.mov", output: "/m/int.vca-clean-light.wav", duration: 60, reused: false },
          { path: "/m/b.mov", error: "the file has no sound" },
        ],
      },
    });
    ipc.nleCall.mockImplementation(async (_h: string, command: string, args: { clips?: { path: string; at: number }[]; itemIds?: string[] }) => {
      if (command === "read_timeline") return VIEW;
      if (command === "backup_timeline") return { backup: "Main (before VibeCut 1)" };
      if (command === "add_clips") return { changes: (args.clips ?? []).map((c, i) => ({ kind: "added", itemIds: [`n${i}`], name: c.path, at: c.at, tracks: ["A3"] })), refused: [], addedTracks: ["A3"] };
      if (command === "set_clips_enabled") return { changes: (args.itemIds ?? []).map((id) => ({ kind: "enabled", itemId: id })), refused: [] };
      return {};
    });
  });

  it("lays the cleaned sound under the clip and switches the original channels off, under one step", async () => {
    const out = await runTool(executorsFor(context), "clean_dialogue", { clipIds: ["v1", "v2"], strength: "light" });
    expect(jobs.runJob.mock.calls[0][0]).toBe("media-clean");
    expect(jobs.runJob.mock.calls[0][2]).toEqual({ paths: ["/m/int.mov", "/m/b.mov"], strength: "light" });
    expect((sent("add_clips")[0] as { clips: unknown[] }).clips).toEqual([
      { path: "/m/int.vca-clean-light.wav", at: 0, sourceIn: 10, sourceOut: 18, picture: false, sound: true, volumeDb: -3 },
    ]);
    expect(sent("set_clips_enabled")).toEqual([{ timeline: "Main", itemIds: ["a1", "a2"], enabled: false }]);
    expect(sent("backup_timeline")).toHaveLength(1);
    expect(new Set(useEditLogStore.getState().entries.map((e) => e.step))).toEqual(new Set(["s1"]));
    expect(out.summary).toBe("Cleaned the dialogue (light) of 1 clip(s): the cleaned sound is on A3 and the original switched off; 1 file(s) failed");
    expect(out.result).toMatchObject({ failed: ["b.mov: the file has no sound"], originalsSwitchedOff: ["a1", "a2"] });
  });

  it("switches nothing off when the cleaned sound couldn't be placed", async () => {
    ipc.nleCall.mockImplementation(async (_h: string, command: string) => {
      if (command === "read_timeline") return VIEW;
      if (command === "backup_timeline") return { backup: "b" };
      if (command === "add_clips") return { changes: [], refused: [{ clip: 0, reason: "Resolve didn't place it on A3" }] };
      return {};
    });
    const out = await runTool(executorsFor(context), "clean_dialogue", { clipIds: ["a1"] });
    expect(String((out.result as { error?: string }).error)).toContain("couldn't be placed: Resolve didn't place it on A3");
    expect(sent("set_clips_enabled")).toEqual([]);
  });

  it("is refused while a draft is open", async () => {
    useConnectionStore.getState().setDraft("resolve", { base: "Main", fps: 25, duration: 20, video: [], audio: [], markers: [], notCarried: [], changes: ["x"] });
    const out = await runTool(executorsFor(context), "clean_dialogue", { clipIds: ["a1"] });
    expect(String((out.result as { error?: string }).error)).toContain("A draft of");
    expect(jobs.runJob).not.toHaveBeenCalled();
  });
});
