import { beforeEach, describe, expect, it, vi } from "vitest";

const ipc = vi.hoisted(() => ({ nleCall: vi.fn() }));
vi.mock("../ipc", () => ipc);

import { describeMeasure, describeParade } from "./colorTools";
import { editExecutors } from "./editTools";
import { describeColour, describeCurves, describeTimelineChange, type EditContext } from "./edits";
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

  it("balances clips with match_clip_color's command, and names those left alone", async () => {
    ipc.nleCall.mockImplementation(async (_h: string, command: string) => {
      if (command === "read_timeline") return VIEW;
      if (command === "backup_timeline") return { backup: "Main (before VibeCut 1)" };
      return {
        changes: [{ kind: "color", name: "B.mov", itemId: "v2", before: null, after: { exposure: 0.3, contrast: 0, temperature: -14, tint: 4, saturation: 100 }, was: { brightness: 0.24 }, passes: 2, distance: 0.01 }],
        refused: [],
        balanced: [{ itemId: "v1", name: "A.mov" }],
      };
    });
    const card = { x: 0.6, y: 0.1, width: 0.1, height: 0.2 };
    const out = await run.balance_clip_color({ clips: [{ clipId: "v1", neutral: [card] }, { clipId: "v2", at: 6.5, neutral: [card, { x: 0, y: 0.8, width: 1, height: 0.2 }] }] });
    expect(sent("match_clip_color")).toEqual([
      {
        timeline: "Main",
        balance: true,
        items: [
          { itemId: "v1", areas: [[0.6, 0.1, 0.1, 0.2]] },
          { itemId: "v2", at: 6.5, areas: [[0.6, 0.1, 0.1, 0.2], [0, 0.8, 1, 0.2]] },
        ],
      },
    ]);
    expect(out.summary).toBe('Balanced 1 clip: "B.mov" colour exposure +0.30, temperature -14, tint +4 (balanced in 2 pass(es), close); already balanced, left alone: "A.mov" (backup: "Main (before VibeCut 1)")');
    expect(useEditLogStore.getState().entries[0].tool).toBe("balance_clip_color");
    expect((out.result as { balanced: unknown }).balanced).toEqual([{ itemId: "v1", name: "A.mov" }]);
    await expect(run.balance_clip_color({ clips: [{ clipId: "v1" }] })).rejects.toThrow("neutral must name 1 to 4 areas");
    await expect(run.balance_clip_color({ clips: [{ clipId: "v1", neutral: [{ x: 0.1, y: 0.1, width: 0.2 }] }] })).rejects.toThrow("neutral[0].height must be a number");
    await expect(run.balance_clip_color({ clips: [] })).rejects.toThrow("clips must be");
  });

  it("measures clips in words", async () => {
    const out = await run.get_clip_color({ clipIds: ["v1", "v2"] });
    expect(sent("read_clip_color")).toEqual([{ timeline: "Main", itemIds: ["v1", "v2"] }]);
    expect(out.summary).toBe('"B.mov": brightness 0.38, contrast 0.55, warm, colourfulness 0.20; Lumetri neutral; A.mov is covered all through by clips on tracks above it');
  });

  it("describes curves, the parade and a match by the parade", () => {
    const curves = { r: { black: 0.02, white: 0.95, gamma: 1 }, g: { black: 0, white: 1, gamma: 1 }, b: { black: -0.03, white: 1, gamma: 1.1 }, saturation: 1.2 };
    expect(describeCurves(curves)).toBe("R black +0.02 white 0.95, B black -0.03 gamma 1.10, saturation x1.20");
    expect(describeCurves({ r: { black: 0, white: 1, gamma: 1 }, saturation: 1 })).toBe("neutral");
    const level = (v: number) => [0.02, 0.1, 0.25, 0.5, 0.75, 0.9, 0.98].map((p) => Math.round(p * v * 1000) / 1000);
    expect(describeParade({ r: level(1), g: level(1), b: level(1), luma: level(1) })).toBe("blacks 0.02, mids 0.50, whites 0.98");
    // Blue up in the shadows, red up in the highlights.
    const b = level(1);
    b[1] += 0.05;
    const r = level(1);
    r[5] += 0.04;
    expect(describeParade({ r, g: level(1), b, luma: level(1) })).toBe("blacks 0.02, mids 0.50, whites 0.98, shadows cool, highlights warm");
    expect(describeTimelineChange({ kind: "color", name: "B.mov", method: "parade", before: null, after: curves, passes: 3, distance: 0.006, close: true })).toBe(
      '"B.mov" colour curves R black +0.02 white 0.95, B black -0.03 gamma 1.10, saturation x1.20 (matched by the parade in 3 pass(es), close)',
    );
    expect(describeTimelineChange({ kind: "color", name: "B.mov", method: "parade", before: null, after: curves, passes: 5, distance: 0.018, close: false })).toContain("as near as it got");
  });

  it("saves Resolve's node template and says which nodes new clips get", async () => {
    ipc.nleCall.mockResolvedValueOnce({ saved: "/t.drx", name: "B.mov", nodes: 4, labels: { "VC Balance": 2, "VC Match": 3 }, otherNodes: [{ node: 1, label: "CST", tools: ["Color Space Transform"] }, { node: 4, label: "", tools: [] }] });
    const out = await run.save_color_template({ clipId: "v2" });
    expect(sent("save_node_template")).toEqual([{ timeline: "Main", itemId: "v2" }]);
    expect(out.summary).toBe('Saved "B.mov"\'s 4 nodes as VibeCut\'s node template; with VibeCut\'s nodes, new clips get node 1 "CST" (Color Space Transform), node 4 (empty)');
    await expect(run.save_color_template({})).rejects.toThrow("clipId must be");
    const premiere = editExecutors({ host: "premiere", timeline: "Main", step: "c2", stepText: "" });
    await expect(premiere.save_color_template({ clipId: "v2" })).rejects.toThrow("Node templates are Resolve's");
  });

  it("says which Resolve node a colour change went in", () => {
    const curves = { r: { black: 0.02, white: 0.95, gamma: 1 }, saturation: 1 };
    const node = { index: 2, label: "VC Balance", template: true, ungraded: true };
    expect(describeTimelineChange({ kind: "color", name: "B.mov", method: "parade", before: null, after: curves, passes: 1, close: true, was: {}, node })).toBe(
      '"B.mov" colour curves R black +0.02 white 0.95 (balanced by the parade in 1 pass(es), close) in its "VC Balance" node (VibeCut\'s node template put on first)',
    );
    expect(describeTimelineChange({ kind: "color", name: "B.mov", before: null, after: AFTER, node: { index: 1, label: null } })).not.toContain("node");
  });

  it("describes looks and measures", () => {
    expect(describeColour({ exposure: -0.3, contrast: 0, temperature: 12.4, tint: 0, saturation: 90 })).toBe("exposure -0.30, temperature +12, saturation 90");
    expect(describeColour(null)).toBe("unknown");
    expect(describeMeasure({ brightness: 0.5, contrast: 0.4, warmth: -0.05, tint: 0.2, colour: 0.1 })).toBe("brightness 0.50, contrast 0.40, slightly cool, green, colourfulness 0.10");
    expect(describeTimelineChange({ kind: "color", name: "B.mov", before: null, after: AFTER, passes: 3, distance: 0.08 })).toContain("as near as it got");
  });
});
