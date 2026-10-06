import { beforeEach, describe, expect, it, vi } from "vitest";

const ipc = vi.hoisted(() => ({ nleCall: vi.fn() }));
vi.mock("../ipc", () => ipc);

import { describeTimelineChange, edit, editLogContext, followed, revertLastRequest, revertTimelineEdits, type EditContext } from "./edits";
import { lastEditStep, useEditLogStore } from "../../store/useEditLogStore";
import type { TimelineChange } from "../../types/edits";
import type { HostTimeline } from "../../types/timeline";

const CTX: EditContext = { host: "resolve", timeline: "Main", step: "m1", stepText: "tidy it" };

const view = (locked = false): HostTimeline => ({
  project: "Doc",
  timeline: "Main",
  fps: 25,
  startTimecode: "01:00:00:00",
  duration: 10,
  isCurrent: true,
  tracks: [
    { type: "video", index: 1, name: "V1", enabled: true, locked, clips: [{ id: "v1", name: "A.mov", start: 0, end: 3, enabled: true, linkedIds: ["a1"] }] },
    { type: "audio", index: 1, name: "A1", enabled: true, locked: false, clips: [{ id: "a1", name: "A.mov", start: 0, end: 3, enabled: true, linkedIds: ["v1"] }] },
  ],
  markers: [],
});

/** Answers the watcher's commands like an editor would. */
function editor(answers: Record<string, unknown>) {
  ipc.nleCall.mockImplementation(async (_host: string, command: string, args: Record<string, unknown>) => {
    const answer = answers[command];
    if (answer === undefined) throw new Error(`unexpected ${command}`);
    return typeof answer === "function" ? (answer as (a: unknown) => unknown)(args) : answer;
  });
}

const deleted: TimelineChange = { kind: "deleted", name: "A.mov", itemId: "v1", deletedWith: ["a1"] };

describe("direct edits", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useEditLogStore.setState({ entries: [], backups: {}, restoredIds: { premiere: {}, resolve: {} } });
  });

  it("backs up once per request, runs the edit, and logs what changed", async () => {
    editor({
      read_timeline: view(),
      backup_timeline: { backup: "Main (before VibeCut 1)" },
      delete_clips: { changes: [deleted], refused: [] },
    });
    const first = await edit(CTX, "delete_clips", "delete_clips", { itemIds: ["v1"] }, () => "Removed 1 clip");
    await edit(CTX, "delete_clips", "delete_clips", { itemIds: ["v1"] }, () => "Removed 1 clip");
    expect(ipc.nleCall.mock.calls.filter((c) => c[1] === "backup_timeline")).toHaveLength(1);
    expect(ipc.nleCall).toHaveBeenCalledWith("resolve", "delete_clips", { timeline: "Main", itemIds: ["v1"] });
    expect(first.summary).toBe('Removed 1 clip (backup: "Main (before VibeCut 1)")');
    expect(first.result).toMatchObject({ editId: "e1", backup: "Main (before VibeCut 1)" });
    expect(useEditLogStore.getState().entries.map((e) => [e.id, e.step, e.tool])).toEqual([
      ["e1", "m1", "delete_clips"],
      ["e2", "m1", "delete_clips"],
    ]);
    expect(editLogContext()).toBe("Your direct timeline edits this session: 2 (2 not reverted); latest: e1 Removed 1 clip | e2 Removed 1 clip");
  });

  it("refuses an edit on a locked track, linked clips included, before any backup", async () => {
    editor({ read_timeline: view(true) });
    await expect(edit(CTX, "set_clip_levels", "set_clip_levels", { levels: [{ itemId: "a1", volumeDb: -3 }] }, () => "")).rejects.toThrow(
      "V1 is locked in Resolve; unlock it first, or ask the user",
    );
    expect(ipc.nleCall).toHaveBeenCalledTimes(1);
  });

  it("reports refusals, logs nothing when nothing changed, and remembers replaced ids", async () => {
    editor({
      read_timeline: view(),
      backup_timeline: { backup: "B" },
      split_clips: { changes: [], refused: [{ itemId: "v1", reason: "it has a speed change" }], renamed: { v1: "v9" } },
    });
    const outcome = await edit(CTX, "split_clip", "split_clips", { itemIds: ["v1"], time: 1 }, () => "");
    expect(outcome.summary).toBe('Nothing needed changing; Resolve refused 1: it has a speed change (backup: "B")');
    expect(useEditLogStore.getState().entries).toEqual([]);
    expect(useEditLogStore.getState().restoredIds.resolve).toEqual({ v1: "v9" });
  });

  it("follows replaced ids through chains, in every field a change names", () => {
    const changes = followed(
      [
        { ...deleted, itemIds: ["v1"] },
        { kind: "split", items: [{ before: { id: "x", track: ["video", 1], start: 0, end: 1 }, after: { id: "v1", track: ["video", 1], start: 0, end: 1 }, right: { id: "a1" } }] },
      ],
      { v1: "v2", v2: "v3", a1: "a5" },
    );
    expect(changes[0]).toMatchObject({ itemId: "v3", deletedWith: ["a5"], itemIds: ["v3"] });
    expect(changes[1].items?.[0]).toMatchObject({ after: { id: "v3" }, right: { id: "a5" } });
    const [link] = followed([{ kind: "link", itemIds: ["a1"], groupsBefore: [["v1"], ["a1"]], groupsAfter: [["v1", "a1"]] }], { v1: "v2", a1: "a5" });
    expect(link).toMatchObject({ itemIds: ["a5"], groupsBefore: [["v2"], ["a5"]], groupsAfter: [["v2", "a5"]] });
  });

  it("reverts newest first with followed ids, marks entries, and says what was lost", async () => {
    useEditLogStore.setState({
      entries: [
        { id: "e1", step: "m1", stepText: "", at: 1, host: "resolve", timeline: "Main", tool: "delete_clips", summary: "", backup: "B1", changes: [deleted as never] },
        { id: "e2", step: "m2", stepText: "", at: 2, host: "resolve", timeline: "Main", tool: "set_clip_levels", summary: "", backup: "B2", changes: [{ kind: "level", itemId: "a1" } as never] },
      ],
      restoredIds: { premiere: {}, resolve: { v1: "v7" } },
    });
    const sent: string[] = [];
    editor({
      revert_timeline_changes: (a: { backup: string; changes: { itemId: string }[] }) => {
        sent.push(`${a.backup}:${a.changes[0].itemId}`);
        return a.backup === "B1"
          ? { reverted: [{ kind: "deleted", name: "A.mov" }], changedSince: [], failed: [], lost: ["A.mov"], gradedFromBackup: [], restoredIds: { v7: "v8" } }
          : { reverted: [], changedSince: [{ name: "A.mov", reason: "it was changed since" }], failed: [], lost: [], restoredIds: {} };
      },
    });
    expect(lastEditStep()).toEqual(["e2"]);
    const outcome = await revertTimelineEdits(["e1", "e2"]);
    expect(sent).toEqual(["B2:a1", "B1:v7"]);
    expect(outcome.summary).toBe(
      'Reverted 1 timeline change; left 1 that changed since (A.mov: it was changed since); A.mov put back from the source without its grade or effects; "B2", "B1" still has them',
    );
    expect(useEditLogStore.getState().entries.every((e) => e.reverted)).toBe(true);
    expect(useEditLogStore.getState().restoredIds.resolve).toEqual({ v1: "v7", v7: "v8" });
    await expect(revertLastRequest()).rejects.toThrow("already reverted, or there are none");
  });

  it("describes each kind of change", () => {
    expect(describeTimelineChange({ kind: "added", name: "B.mov", at: 1, end: 3, tracks: ["V2", "A2"] })).toBe('"B.mov" added at 1.0s–3.0s on V2+A2');
    expect(describeTimelineChange({ kind: "deleted", name: "A.mov", track: ["audio", 1], start: 2 })).toBe('"A.mov" removed from A1 at 2.0s');
    expect(describeTimelineChange({ kind: "level", name: "M.wav", before: 0, after: -6 })).toBe('"M.wav" level 0 → -6 dB');
    expect(describeTimelineChange({ kind: "fade", name: "A.mov", which: "fadeOut", before: 0, after: 1, clamped: true })).toBe('"A.mov" fade out 0.0s → 1.0s (cut to fit)');
    expect(describeTimelineChange({ kind: "duck", name: "M.wav", duckDb: -12, spans: 2 })).toBe('"M.wav" ducked -12 dB in 2 places (Level keyframes)');
    expect(
      describeTimelineChange({ kind: "reshaped", name: "A.mov", how: "moved", items: [{ before: { id: "a", track: ["video", 1], start: 0, end: 2 }, after: { id: "a", track: ["video", 2], start: 4, end: 6 } }] }),
    ).toBe('"A.mov" moved: 0.0s–2.0s on V1 → 4.0s–6.0s on V2');
    expect(describeTimelineChange({ kind: "transition", name: "M.wav", cut: 4, after: { type: "Cross Fade", seconds: 0.3 } })).toBe('Cross Fade 0.3s on the cut at 4.0s, "M.wav"');
  });
});
