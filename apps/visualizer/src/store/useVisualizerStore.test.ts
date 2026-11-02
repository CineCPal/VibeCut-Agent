import { beforeEach, describe, expect, it } from "vitest";
import { completed, env, failed, handoff, planning, spawn, tool, waiting } from "../test/envelopes";
import { mockTrace } from "../lib/reconciler/mockTraceGenerator";
import { selectView, useVisualizerStore } from "./useVisualizerStore";

const store = () => useVisualizerStore.getState();

describe("useVisualizerStore", () => {
  beforeEach(() => store().reset());

  it("builds the DAG with placeholders, edges and a layout", () => {
    store().applyBatch([
      env(1, spawn("task_root"), { subagent: "MASTER_ORCHESTRATOR", parent: null }),
      env(2, tool("task_b")),
      env(3, spawn("task_b", ["task_root"])),
    ]);
    const { live } = store();
    expect(live.nodes.task_b.status).toBe("TOOL_EXECUTION");
    expect(live.nodes.task_b.task_label).toBe("Task task_b");
    expect(Object.keys(live.edges)).toEqual(["DATA_DEPENDENCY:task_root->task_b"]);
    expect(live.nodes.task_root.dependents).toEqual(["task_b"]);
    expect(live.nodes.task_b.layout.rank).toBe(1);
    expect(store().dagSize.width).toBeGreaterThan(0);
  });

  it("keeps statuses on the lattice and lets a recoverable failure retry", () => {
    store().applyBatch([env(1, spawn("t")), env(2, failed("t")), env(3, planning("t"))]);
    expect(store().live.nodes.t.status).toBe("FAILED");
    store().applyBatch([env(4, spawn("t"))]);
    expect(store().live.nodes.t.status).toBe("SPAWNED");
    expect(store().live.nodes.t.error).toBeNull();
    store().applyBatch([env(5, completed("t")), env(6, failed("t", false)), env(7, spawn("t"))]);
    expect(store().live.nodes.t.status).toBe("COMPLETED");
  });

  it("drives the bays' avatars and spawns packets", () => {
    const now = 1_000_000;
    store().applyBatch(
      [
        env(1, spawn("t"), { t: now }),
        env(2, waiting("t"), { t: now }),
        env(3, handoff("t", "u", "VISION_TAGGER", "BROLL_RETRIEVER"), { t: now }),
      ],
      now,
    );
    const { live } = store();
    expect(live.studioBays.VISION_TAGGER.avatar).toBe("LISTENING");
    expect(live.studioBays.VISION_TAGGER.hud).toBe("GPU LOCK");
    expect(live.studioBays.BROLL_RETRIEVER.avatar).toBe("LISTENING");
    expect(live.activePackets).toHaveLength(1);
    expect(live.activePackets[0]).toMatchObject({ from: "VISION_TAGGER", to: "BROLL_RETRIEVER", label: "×8" });
    store().prunePackets(now + 5000);
    expect(store().live.activePackets).toHaveLength(0);
  });

  it("follows the first trace and switches to a new run when following the latest", () => {
    store().applyBatch([env(1, spawn("a"), { trace: "trc_one", parent: null })]);
    store().applyBatch([env(1, planning("x"), { trace: "trc_two" })]);
    expect(store().followedTraceId).toBe("trc_one");
    expect(Object.keys(store().knownTraces).sort()).toEqual(["trc_one", "trc_two"]);
    store().applyBatch([env(2, spawn("b"), { trace: "trc_two", parent: null })]);
    expect(store().followedTraceId).toBe("trc_two");
    expect(Object.keys(store().live.nodes)).toEqual(["b"]);
    store().setFollowLatest(false);
    store().applyBatch([env(1, spawn("c"), { trace: "trc_three", parent: null })]);
    expect(store().followedTraceId).toBe("trc_two");
  });

  it("hydrates from a snapshot and projects any seq for time travel", () => {
    const run = mockTrace();
    store().hydrateSnapshot("trc_mock_0001", run.length, run);
    const { live } = store();
    expect(Object.keys(live.nodes)).toHaveLength(7);
    expect(live.mutations.delta_004.mutation_stage).toBe("COMMITTED");
    const proposed = run.find((e) => e.payload.kind === "MUTATION_EMITTED")!.seq_id;
    store().setReplayCursor(proposed);
    const view = selectView(store());
    expect(view.mutations.delta_004.mutation_stage).toBe("PROPOSED");
    expect(view.nodes.task_nle_007).toBeUndefined();
    expect(view.nodes.task_cut_006.layout).toEqual(live.nodes.task_cut_006.layout);
    store().stepReplay(-1);
    expect(store().replayCursorSeqId).toBe(proposed - 1);
    store().setReplayCursor(null);
    expect(selectView(store())).toBe(store().live);
  });

  it("keeps waveforms and contact strips by seq", () => {
    store().addWaveform(12, [-1, 1]);
    store().addContactStrip(5, "blob:a");
    expect(store().waveforms[12]).toEqual([-1, 1]);
    expect(store().contactStrips[5]).toBe("blob:a");
  });
});
