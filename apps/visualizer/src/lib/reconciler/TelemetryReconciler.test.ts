import type { TelemetryEnvelope } from "@vibecut/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { completed, env, planning, spawn, tool } from "../../test/envelopes";
import { syntheticTrace } from "./mockTraceGenerator";
import { createTraceState, reduceEnvelopes } from "./reduce";
import { SeqBitmap, SeqHeap, TelemetryReconciler } from "./TelemetryReconciler";

function setup(fetchGap?: (trace: string, from: number, to: number) => Promise<TelemetryEnvelope[]>) {
  const flushed: TelemetryEnvelope[][] = [];
  const frames: (() => void)[] = [];
  const reconciler = new TelemetryReconciler({
    onFlush: (envs) => flushed.push(envs),
    fetchGap,
    scheduleFrame: (cb) => frames.push(cb),
  });
  const frame = () => frames.splice(0).forEach((cb) => cb());
  const seqs = () => flushed.flat().map((e) => e.seq_id);
  return { reconciler, flushed, frame, seqs };
}

const seqEnv = (seq: number, trace = "trc_test") => env(seq, planning(`task_${seq}`), { trace });

describe("SeqHeap and SeqBitmap", () => {
  it("pop in seq order", () => {
    const heap = new SeqHeap();
    for (const s of [9, 3, 7, 1, 5]) heap.push(seqEnv(s));
    expect(heap.has(7)).toBe(true);
    expect([1, 2, 3, 4, 5].map(() => heap.pop()?.seq_id)).toEqual([1, 3, 5, 7, 9]);
    expect(heap.pop()).toBeUndefined();
  });

  it("track a 512-seq window and slide it", () => {
    const bits = new SeqBitmap();
    bits.set(1);
    bits.set(512);
    bits.set(513);
    expect([bits.has(1), bits.has(2), bits.has(512), bits.has(513)]).toEqual([true, false, true, false]);
    bits.advanceTo(100);
    expect(bits.has(1)).toBe(false);
    expect(bits.has(512)).toBe(true);
    bits.advanceTo(10_000);
    expect(bits.has(512)).toBe(false);
  });
});

describe("TelemetryReconciler", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("hands envelopes on in seq order, once per frame", () => {
    const { reconciler, flushed, frame, seqs } = setup();
    reconciler.ingest([seqEnv(1), seqEnv(2), seqEnv(3)]);
    expect(flushed).toEqual([]);
    frame();
    expect(flushed).toHaveLength(1);
    expect(seqs()).toEqual([1, 2, 3]);
  });

  it("reorders what arrives early", () => {
    const { reconciler, frame, seqs } = setup();
    reconciler.ingest([seqEnv(1), seqEnv(4), seqEnv(3)]);
    frame();
    expect(seqs()).toEqual([1]);
    reconciler.ingest(seqEnv(2));
    frame();
    expect(seqs()).toEqual([1, 2, 3, 4]);
    expect(reconciler.contiguous("trc_test")).toBe(4);
    expect(reconciler.stats.reordered).toBe(2);
  });

  it("drops duplicates, below, inside the heap and early-applied", async () => {
    const { reconciler, frame, seqs } = setup(() => Promise.reject(new Error("offline")));
    reconciler.ingest([seqEnv(1), seqEnv(1), seqEnv(3), seqEnv(3)]);
    vi.advanceTimersByTime(151);
    await Promise.resolve();
    reconciler.ingest([seqEnv(3), seqEnv(1)]);
    frame();
    expect(seqs()).toEqual([1, 3]);
    expect(reconciler.stats.duplicates).toBe(4);
  });

  it("asks for a gap after 150 ms, applying what's buffered meanwhile", async () => {
    const asked: [string, number, number][] = [];
    const { reconciler, frame, seqs } = setup(async (trace, from, to) => {
      asked.push([trace, from, to]);
      return [seqEnv(2), seqEnv(3)];
    });
    reconciler.ingest([seqEnv(1), seqEnv(4), seqEnv(5)]);
    vi.advanceTimersByTime(149);
    expect(asked).toEqual([]);
    vi.advanceTimersByTime(2);
    expect(asked).toEqual([["trc_test", 2, 3]]);
    await vi.runAllTimersAsync();
    frame();
    expect(seqs()).toEqual([1, 4, 5, 2, 3]);
    expect(reconciler.contiguous("trc_test")).toBe(5);
    // 4 and 5 were applied early; seeing them again is a duplicate.
    reconciler.ingest([seqEnv(4), seqEnv(6)]);
    frame();
    expect(seqs().slice(-1)).toEqual([6]);
  });

  it("gives up on a gap the server can't fill", async () => {
    const { reconciler, frame, seqs } = setup(async () => []);
    reconciler.ingest([seqEnv(1), seqEnv(3)]);
    vi.advanceTimersByTime(151);
    await vi.runAllTimersAsync();
    reconciler.ingest(seqEnv(4));
    frame();
    expect(seqs()).toEqual([1, 3, 4]);
    expect(reconciler.stats.gapsAbandoned).toBe(1);
  });

  it("keeps traces apart and restarts from a snapshot", () => {
    const { reconciler, frame, seqs } = setup();
    reconciler.ingest([seqEnv(1, "a"), seqEnv(1, "b"), seqEnv(2, "a")]);
    reconciler.resetTrace("c", 40);
    reconciler.ingest([seqEnv(40, "c"), seqEnv(41, "c")]);
    frame();
    expect(seqs()).toEqual([1, 1, 2, 41]);
  });

  it("reduces out-of-order lifecycles without a finished task going back", () => {
    const state = createTraceState();
    const events = [
      env(1, spawn("task_a")),
      env(3, completed("task_a")),
      env(2, tool("task_a")),
    ];
    reduceEnvelopes(state, events);
    expect(state.nodes.task_a.status).toBe("COMPLETED");
    expect(state.nodes.task_a.last_status_seq_id).toBe(3);
  });

  it("reconciles and reduces 10,000 events in under 25 ms", () => {
    const trace = syntheticTrace(10_000);
    const shuffled = [...trace];
    // Swap neighbours throughout, as concurrent workers would deliver them.
    for (let i = 0; i + 1 < shuffled.length; i += 7) [shuffled[i], shuffled[i + 1]] = [shuffled[i + 1], shuffled[i]];
    let best = Infinity;
    for (let run = 0; run < 5; run++) {
      const state = createTraceState();
      const reconciler = new TelemetryReconciler({
        onFlush: (envs) => reduceEnvelopes(state, envs),
        scheduleFrame: () => undefined,
      });
      const began = performance.now();
      reconciler.ingest(shuffled);
      reconciler.flush();
      best = Math.min(best, performance.now() - began);
      expect(state.event_count).toBe(10_000);
    }
    expect(best).toBeLessThan(25);
  });
});
