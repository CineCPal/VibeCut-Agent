import { beforeEach, describe, expect, it, vi } from "vitest";

const ipc = vi.hoisted(() => ({ nleCall: vi.fn() }));
vi.mock("../ipc", () => ipc);

import { describeMeasure } from "./colorTools";
import { editExecutors } from "./editTools";
import { describeColour, describeTimelineChange, type EditContext } from "./edits";
import { useEditLogStore } from "../../store/useEditLogStore";
import type { HostTimeline } from "../../types/timeline";

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
        { id: "v1", name: "A.mov", start: 0, end: 4, enabled: true },
        { id: "v2", name: "B.mov", start: 4, end: 9, enabled: true },
      ],
    },
  ],
  markers: [],
};
const AFTER = { exposure: 0.42, contrast: -5, temperature: -18, tint: 3, saturation: 112 };
const sent = (command: string) => ipc.nleCall.mock.calls.filter((c) => c[1] === command).map((c) => c[2]);

describe("colour tools", () => {
  let run: ReturnType<typeof editExecutors>;

  beforeEach(() => {
    vi.clearAllMocks();
    useEditLogStore.setState({ entries: [], backups: {}, restoredIds: { premiere: {}, resolve: {} } });
    ipc.nleCall.mockImplementation(async (_h: string, command: string) => {
      if (command === "read_timeline") return VIEW;
      if (command === "backup_timeline") return { backup: "Main (before VibeCut 1)" };
      if (command === "read_clip_color") {
        return {
          clips: [{ itemId: "v2", name: "B.mov", at: 6.5, brightness: 0.38, contrast: 0.55, warmth: 0.12, tint: -0.01, colour: 0.2, look: { exposure: 0, contrast: 0, temperature: 0, tint: 0, saturation: 100 } }],
          refused: [{ reason: "A.mov is covered all through by clips on tracks above it" }],
        };
      }
      if (command === "match_clip_color") return { changes: [{ kind: "color", name: "B.mov", itemId: "v2", before: null, after: AFTER, passes: 2, distance: 0.012 }], refused: [] };
      return { changes: [{ kind: "color", name: "A.mov", itemId: "v1", before: { exposure: 0, contrast: 0, temperature: 0, tint: 0, saturation: 100 }, after: { exposure: 0.5, contrast: 0, temperature: 0, tint: 0, saturation: 100 } }], refused: [] };
    });
    const ctx: EditContext = { host: "resolve", timeline: "Main", step: "c1", stepText: "warm it up" };
    run = editExecutors(ctx);
  });

  it("sends looks with only the fields given, and logs the change", async () => {
    const out = await run.set_clip_color({ looks: [{ itemId: "v1", exposure: 0.5, tint: undefined }] });
    expect(sent("set_clip_color")).toEqual([{ timeline: "Main", looks: [{ itemId: "v1", exposure: 0.5 }] }]);
    expect(out.summary).toBe('Set the colour of 1 clip: "A.mov" colour neutral → exposure +0.50 (backup: "Main (before VibeCut 1)")');
    expect(useEditLogStore.getState().entries[0].tool).toBe("set_clip_color");
    await expect(run.set_clip_color({ looks: [{ itemId: "v1" }] })).rejects.toThrow("must give exposure");
    await expect(run.set_clip_color({ looks: [] })).rejects.toThrow("looks must be");
  });

  it("matches to a reference and says how close it got", async () => {
    const out = await run.match_clip_color({ referenceId: "v1", clipIds: ["v2"] });
    expect(sent("match_clip_color")).toEqual([{ timeline: "Main", referenceId: "v1", itemIds: ["v2"] }]);
    expect(out.summary).toContain('Matched 1 clip to the reference: "B.mov" colour exposure +0.42, contrast -5, temperature -18, tint +3, saturation 112 (matched in 2 pass(es), close)');
    await expect(run.match_clip_color({ clipIds: ["v2"] })).rejects.toThrow("referenceId");
  });

  it("measures clips in words", async () => {
    const out = await run.get_clip_color({ clipIds: ["v1", "v2"] });
    expect(sent("read_clip_color")).toEqual([{ timeline: "Main", itemIds: ["v1", "v2"] }]);
    expect(out.summary).toBe('"B.mov": brightness 0.38, contrast 0.55, warm, colourfulness 0.20; Lumetri neutral; A.mov is covered all through by clips on tracks above it');
  });

  it("describes looks and measures", () => {
    expect(describeColour({ exposure: -0.3, contrast: 0, temperature: 12.4, tint: 0, saturation: 90 })).toBe("exposure -0.30, temperature +12, saturation 90");
    expect(describeColour(null)).toBe("unknown");
    expect(describeMeasure({ itemId: "v", name: "v", at: 0, brightness: 0.5, contrast: 0.4, warmth: -0.05, tint: 0.2, colour: 0.1 })).toBe("brightness 0.50, contrast 0.40, slightly cool, green, colourfulness 0.10");
    expect(describeTimelineChange({ kind: "color", name: "B.mov", before: null, after: AFTER, passes: 3, distance: 0.08 })).toContain("as near as it got");
  });
});
