import { beforeEach, describe, expect, it, vi } from "vitest";

const ipc = vi.hoisted(() => ({ nleCall: vi.fn(), startSidecar: vi.fn(), cancelSidecar: vi.fn() }));
vi.mock("../ipc", () => ipc);
const jobs = vi.hoisted(() => ({ runJob: vi.fn() }));
vi.mock("../jobs", () => jobs);

import { splitEdit } from "./splitEditTools";
import { forgetMediaFacts } from "./mediaInfo";
import { executorsFor, runTool, type ToolContext } from "./tools";
import { emptyConnection, useConnectionStore } from "../../store/useConnectionStore";
import { initialHosts, useNleStateStore } from "../../store/useNleStateStore";
import { nleState } from "../../test/nleFixtures";
import type { HostDraft } from "../../vibecut/lib/connect/hostDraft";
import type { HostClip, HostTimeline } from "../../types/timeline";

const clip = (sourcePath: string, start: number, end: number, sourceIn: number) => ({
  sourcePath,
  sourceName: sourcePath.slice(3),
  start,
  end,
  sourceIn,
  sourceOut: sourceIn + end - start,
  speed: 1,
  enabled: true,
  volumeDb: null,
});

/** Two shots cut at 10 s, picture and sound, each with 5 s of media either side; music on A2. */
const DRAFT: HostDraft = {
  base: "Interview",
  fps: 25,
  duration: 20,
  video: [{ type: "video", clips: [clip("/m/a.mov", 0, 10, 5), clip("/m/b.mov", 10, 20, 5)] }],
  audio: [
    { type: "audio", clips: [clip("/m/a.mov", 0, 10, 5), clip("/m/b.mov", 10, 20, 5)] },
    { type: "audio", clips: [clip("/m/song.wav", 0, 20, 0)] },
  ],
  markers: [],
  notCarried: [],
  changes: [],
};
const sound = (d: HostDraft) => d.audio[0].clips.map((c) => [c.start, c.end, c.sourceIn, c.sourceOut]);

describe("split edits", () => {
  it("J: the next shot's sound comes in early, the picture stays", () => {
    const next = splitEdit(DRAFT, { at: 10, kind: "J", seconds: 1 });
    expect(sound(next)).toEqual([
      [0, 9, 5, 14],
      [9, 20, 4, 15],
    ]);
    expect(next.video).toBe(DRAFT.video);
    expect(next.audio[1]).toBe(DRAFT.audio[1]);
    expect(next.changes[0]).toContain("J cut at 10s");
  });

  it("L: the shot's sound runs on under the next one", () => {
    // At 10.01 s and 0.4 s: both snapped to frames (25 fps).
    expect(sound(splitEdit(DRAFT, { at: 10.01, kind: "L", seconds: 0.4 }))).toEqual([
      [0, 10.4, 5, 15.4],
      [10.4, 20, 5.4, 15],
    ]);
  });

  it("refuses without media beyond the edge, off a picture cut, or under a frame", () => {
    expect(() => splitEdit(DRAFT, { at: 10, kind: "J", seconds: 6 })).toThrow("only 5s of sound before its start");
    expect(() => splitEdit(DRAFT, { at: 10, kind: "L", seconds: 2 }, () => 16)).toThrow("only 1s of sound after its end");
    expect(() => splitEdit(DRAFT, { at: 5, kind: "J", seconds: 1 })).toThrow("no picture cut at 5.0s");
    expect(() => splitEdit(DRAFT, { at: 10, kind: "J", seconds: 0.01 })).toThrow("at least a frame");
  });

  it("refuses sound that would run into another clip", () => {
    const gap: HostDraft = { ...DRAFT, audio: [{ type: "audio", clips: [clip("/m/x.wav", 8, 9.5, 0), clip("/m/b.mov", 10, 20, 5)] }] };
    expect(() => splitEdit(gap, { at: 10, kind: "J", seconds: 1 })).toThrow('"x.wav" and "b.mov" would overlap');
  });
});

const hclip = (id: string, start: number, end: number, filePath: string, sourceIn: number): HostClip => ({ id, name: id, start, end, enabled: true, sourceIn, sourceOut: sourceIn + end - start, filePath });
const TIMELINE: HostTimeline = {
  project: "Doc",
  timeline: "Main",
  fps: 25,
  startTimecode: "00:00:00:00",
  duration: 20,
  isCurrent: true,
  tracks: [
    { type: "video", index: 1, name: "", enabled: true, clips: [hclip("va", 0, 10, "/m/a.mov", 5), hclip("vb", 10, 20, "/m/b.mov", 5)] },
    { type: "audio", index: 1, name: "", enabled: true, clips: [hclip("aa", 0, 10, "/m/a.mov", 5), hclip("ab", 10, 20, "/m/b.mov", 5)] },
  ],
  markers: [],
};
const ctx: ToolContext = { host: "premiere", timeline: "Main", step: "s1", stepText: "J cut into the answer" };

describe("make_split_edit", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    forgetMediaFacts();
    useConnectionStore.setState({ connections: { premiere: emptyConnection("Doc"), resolve: emptyConnection("Doc") } });
    useNleStateStore.setState({ hosts: { ...initialHosts(), premiere: nleState("premiere") } });
    ipc.nleCall.mockResolvedValue(TIMELINE);
    jobs.runJob.mockResolvedValue({ result: { info: { "/m/a.mov": { duration: 30, video: null, audio: null }, "/m/b.mov": { duration: 30, video: null, audio: null } } } });
  });

  it("makes the edits it can in the draft and names the ones it can't", async () => {
    const out = await runTool(executorsFor(ctx), "make_split_edit", { edits: [{ at: 10, type: "j", seconds: 1 }, { at: 3, type: "L" }] });
    expect(out.summary).toBe("Made 1 split edit(s) in the draft; refused 1");
    expect((out.result as { refused: string[] }).refused[0]).toContain("L at 3.0s: There's no picture cut");
    const draft = useConnectionStore.getState().connections.premiere.draft!;
    expect(draft.audio[0].clips.map((c) => [c.start, c.end])).toEqual([
      [0, 9],
      [9, 20],
    ]);
  });

  it("fails when none can be made, leaving no draft", async () => {
    const out = await runTool(executorsFor(ctx), "make_split_edit", { edits: [{ at: 3, type: "J" }] });
    expect(String((out.result as { error?: unknown }).error)).toContain("no picture cut");
    expect(useConnectionStore.getState().connections.premiere.draft).toBeNull();
  });
});
