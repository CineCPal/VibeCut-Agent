import { beforeEach, describe, expect, it, vi } from "vitest";

const ipc = vi.hoisted(() => ({ nleCall: vi.fn() }));
vi.mock("../ipc", () => ipc);

import { commitArgs, orchestratorExecutors } from "./orchestratorTools";
import { describeChange, needsReview } from "./toolKinds";
import type { EditContext } from "./edits";
import { useEditLogStore } from "../../store/useEditLogStore";
import type { TimelineChange } from "../../types/edits";
import type { NleBatchCommand } from "../../types/orchestrator";
import type { HostTimeline } from "../../types/timeline";

const CTX: EditContext = { host: "resolve", timeline: "Cut", step: "m1", stepText: "drop the second shot" };

const view = (locked = false): HostTimeline => ({
  project: "Doc",
  timeline: "Cut",
  fps: 25,
  startTimecode: "01:00:00:00",
  duration: 8,
  isCurrent: true,
  tracks: [
    {
      type: "video",
      index: 1,
      name: "V1",
      enabled: true,
      locked,
      clips: [
        { id: "c1", name: "a.mov", start: 0, end: 4, enabled: true, linkedIds: [] },
        { id: "c2", name: "b.mov", start: 4, end: 8, enabled: true, linkedIds: [] },
      ],
    },
  ],
  markers: [],
});

const BATCH: NleBatchCommand[] = [
  { seq: 1, source_op_id: "backup", host: "resolve", command: "backup_timeline", args: { timeline: "Cut" } },
  { seq: 2, source_op_id: "op_001", host: "resolve", command: "delete_clips", args: { timeline: "Cut", itemIds: ["c2"], withLinked: false } },
];

const commit = (overrides: Record<string, unknown> = {}) => ({
  validationToken: `vtok_${"a".repeat(32)}`,
  deltaId: "delta_0001",
  commitSummary: "Drop the second shot",
  host: "resolve",
  timeline: "Cut",
  batch: BATCH,
  otioPath: "/data/otio_deltas/delta_0001.otio",
  ...overrides,
});

const deleted: TimelineChange = { kind: "deleted", name: "b.mov", itemId: "c2" };

function editor(answers: Record<string, unknown>) {
  ipc.nleCall.mockImplementation(async (_host: string, command: string, args: Record<string, unknown>) => {
    const answer = answers[command];
    if (answer === undefined) throw new Error(`unexpected ${command}`);
    if (answer instanceof Error) throw answer;
    return typeof answer === "function" ? (answer as (a: unknown) => unknown)(args) : answer;
  });
}

const run = (args: Record<string, unknown>, ctx: EditContext = CTX) => orchestratorExecutors(ctx).commit_otio_delta(args);

describe("commit_otio_delta", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useEditLogStore.setState({ entries: [], backups: {}, restoredIds: { premiere: {}, resolve: {} } });
  });

  it("runs the validated calls after the request's backup and logs them as one edit", async () => {
    editor({
      read_timeline: view(),
      backup_timeline: { backup: "Cut (before VibeCut 1)" },
      execute_otio_batch: {
        backup: "Cut (before VibeCut 1)",
        changes: [deleted],
        refused: [],
        renamed: { c9: "c10" },
        executed: [{ seq: 2, sourceOpId: "op_001", command: "delete_clips", changes: 1 }],
      },
    });
    const outcome = await run(commit());
    expect(ipc.nleCall).toHaveBeenCalledWith("resolve", "execute_otio_batch", { timeline: "Cut", backup: "Cut (before VibeCut 1)", batch: BATCH });
    expect(outcome.summary).toBe('Drop the second shot (1 change in Resolve, 1 call) (backup: "Cut (before VibeCut 1)")');
    expect(outcome.result).toEqual({
      committed: true,
      editId: "e1",
      deltaId: "delta_0001",
      backup: "Cut (before VibeCut 1)",
      changes: [deleted],
      executed: [{ seq: 2, sourceOpId: "op_001", command: "delete_clips", changes: 1 }],
      otioPath: "/data/otio_deltas/delta_0001.otio",
    });
    const [entry] = useEditLogStore.getState().entries;
    expect(entry).toMatchObject({ id: "e1", step: "m1", tool: "commit_otio_delta", backup: "Cut (before VibeCut 1)", changes: [deleted] });
    expect(useEditLogStore.getState().restoredIds.resolve).toEqual({ c9: "c10" });
  });

  it("reuses the request's backup when an earlier edit made one", async () => {
    useEditLogStore.setState({ backups: { "m1|resolve|Cut": "Cut (before VibeCut 4)" } });
    editor({
      read_timeline: view(),
      execute_otio_batch: { backup: "Cut (before VibeCut 4)", changes: [], refused: [], executed: [] },
    });
    const outcome = await run(commit());
    expect(ipc.nleCall.mock.calls.map((c) => c[1])).toEqual(["read_timeline", "execute_otio_batch"]);
    expect(outcome.summary).toBe('Drop the second shot: nothing needed changing (backup: "Cut (before VibeCut 4)")');
    expect(useEditLogStore.getState().entries).toEqual([]);
  });

  it("refuses an edit planned for another editor or timeline, or touching a locked track", async () => {
    editor({ read_timeline: view(true), backup_timeline: { backup: "x" } });
    await expect(run(commit({ host: "premiere" }))).rejects.toThrow("planned for Premiere Pro, but DaVinci Resolve is the connected editor");
    await expect(run(commit({ timeline: "Other" }))).rejects.toThrow('planned on the timeline "Other", but "Cut" is open');
    await expect(run(commit())).rejects.toThrow("V1 is locked in Resolve");
    expect(ipc.nleCall.mock.calls.map((c) => c[1])).toEqual(["read_timeline"]);
  });

  it("passes on the editor's failure, which says what was undone", async () => {
    const failure = new Error('Call 2 of 2 (delete_clips, for op_001) failed: no clip c2. Nothing had changed yet; the backup "Cut (before VibeCut 1)" has the timeline as it was.');
    editor({ read_timeline: view(), backup_timeline: { backup: "Cut (before VibeCut 1)" }, execute_otio_batch: failure });
    await expect(run(commit())).rejects.toThrow("Nothing had changed yet");
    expect(useEditLogStore.getState().entries).toEqual([]);
  });

  it("checks its arguments", () => {
    expect(() => commitArgs(commit({ batch: [] }))).toThrow("batch must be the validated calls");
    expect(() => commitArgs(commit({ batch: [{ seq: 1 }] }))).toThrow("batch[0] must be a call with a command and args");
    expect(() => commitArgs(commit({ host: "avid" }))).toThrow("host must be one of premiere, resolve");
    expect(() => commitArgs(commit({ commitSummary: " " }))).toThrow("commitSummary must be non-empty text");
    expect(commitArgs(commit({ otioPath: undefined }))).not.toHaveProperty("otioPath");
  });

  it("waits for Apply when edits are reviewed, and says what it will do", () => {
    expect(needsReview("commit_otio_delta")).toBe(true);
    expect(describeChange("commit_otio_delta", commit())).toBe("Apply the planned edit: Drop the second shot (1 change on Cut)");
  });
});
