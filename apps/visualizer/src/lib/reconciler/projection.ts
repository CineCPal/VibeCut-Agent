/**
 * Time travel (visualizer-spec.md §4.2, Pane D): the state as it was at a seq, worked out by reducing the
 * log up to it. A checkpoint every 1,000 seqs keeps a scrub to any point under 1,000 reductions.
 * Projections never spawn packets and keep no log of their own.
 */
import type { TelemetryEnvelope } from "@vibecut/contracts";
import { createTraceState, reduceEnvelopes, type TraceState } from "./reduce";

export const CHECKPOINT_EVERY = 1000;

function clone(state: TraceState): TraceState {
  return structuredClone(state);
}

export class ProjectionCache {
  private checkpoints = new Map<number, TraceState>();
  private traceId: string | null = null;
  private source: readonly TelemetryEnvelope[] = [];

  /** Forget the checkpoints (another trace, a snapshot). */
  reset(traceId: string | null = null): void {
    this.checkpoints.clear();
    this.traceId = traceId;
    this.source = [];
  }

  /** The state at `cursor` from `logs` (the live log, in apply order). */
  project(logs: readonly TelemetryEnvelope[], cursor: number, traceId: string | null): TraceState {
    if (traceId !== this.traceId) this.reset(traceId);
    // A log that was cut from the front (over MAX_LOGS) invalidates the checkpoints.
    if (this.source.length && logs[0] !== this.source[0]) this.checkpoints.clear();
    this.source = logs;
    const sorted = [...logs].filter((e) => e.seq_id <= cursor).sort((a, b) => a.seq_id - b.seq_id);
    const floor = Math.floor(cursor / CHECKPOINT_EVERY) * CHECKPOINT_EVERY;
    let start = 0;
    for (let mark = floor; mark >= CHECKPOINT_EVERY; mark -= CHECKPOINT_EVERY) {
      if (this.checkpoints.has(mark)) {
        start = mark;
        break;
      }
    }
    const state = start ? clone(this.checkpoints.get(start) as TraceState) : createTraceState(traceId);
    let next = start + CHECKPOINT_EVERY;
    for (const env of sorted) {
      if (env.seq_id <= start) continue;
      while (env.seq_id > next && next <= floor) {
        if (!this.checkpoints.has(next)) this.checkpoints.set(next, clone(state));
        next += CHECKPOINT_EVERY;
      }
      reduceEnvelopes(state, [env], { packets: false, keepLogs: false });
    }
    state.max_seq_id = Math.min(state.max_seq_id, cursor);
    return state;
  }

  get checkpointCount(): number {
    return this.checkpoints.size;
  }
}
