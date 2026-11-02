/**
 * The sequence reconciler (visualizer-spec.md §2.3). Envelopes from the socket arrive here, never in the
 * store; this hands them on in seq order, once each, a frame's worth at a time.
 *
 * Per trace:
 * - `contiguous`: the highest seq such that every seq up to it has been handed on (or given up on).
 * - A min-heap (at most 128) of envelopes that arrived ahead of a gap. The next seq goes straight to
 *   staging, and so does anything in the heap that it makes contiguous.
 * - A gap that's still open after 150 ms asks `fetchGap` for the missing range. Meanwhile what's buffered
 *   is applied out of order: the reducer's lattice keeps a late event from undoing a later one. A gap the
 *   fetch can't fill is given up on.
 * - A 512-bit bitmap of the seqs above `contiguous` that were applied early, so each seq is applied at
 *   most once. A seq at or below `contiguous`, or already in the bitmap or the heap, is a duplicate and is
 *   dropped in O(1).
 *
 * Staged envelopes go to `onFlush` from one requestAnimationFrame callback per frame, so the store
 * updates at most once per frame however fast frames arrive.
 */
import type { TelemetryEnvelope } from "@vibecut/contracts";

export const REORDER_WAIT_MS = 150;
export const MAX_HEAP = 128;
export const WINDOW_BITS = 512;

export type FetchGap = (traceId: string, fromSeq: number, toSeq: number) => Promise<TelemetryEnvelope[]>;

export interface ReconcilerOptions {
  onFlush: (envelopes: TelemetryEnvelope[]) => void;
  fetchGap?: FetchGap;
  maxWaitMs?: number;
  maxHeap?: number;
  scheduleFrame?: (callback: () => void) => unknown;
  setTimer?: (callback: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

export interface ReconcilerStats {
  received: number;
  applied: number;
  duplicates: number;
  reordered: number;
  gapFetches: number;
  gapsAbandoned: number;
}

/** A min-heap of envelopes by seq id. */
export class SeqHeap {
  private items: TelemetryEnvelope[] = [];
  private seqs = new Set<number>();

  get size(): number {
    return this.items.length;
  }

  has(seq: number): boolean {
    return this.seqs.has(seq);
  }

  peek(): TelemetryEnvelope | undefined {
    return this.items[0];
  }

  push(env: TelemetryEnvelope): void {
    this.items.push(env);
    this.seqs.add(env.seq_id);
    let i = this.items.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (this.items[parent].seq_id <= this.items[i].seq_id) break;
      [this.items[parent], this.items[i]] = [this.items[i], this.items[parent]];
      i = parent;
    }
  }

  pop(): TelemetryEnvelope | undefined {
    const top = this.items[0];
    if (top === undefined) return undefined;
    const last = this.items.pop() as TelemetryEnvelope;
    this.seqs.delete(top.seq_id);
    if (this.items.length > 0) {
      this.items[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let smallest = i;
        if (l < this.items.length && this.items[l].seq_id < this.items[smallest].seq_id) smallest = l;
        if (r < this.items.length && this.items[r].seq_id < this.items[smallest].seq_id) smallest = r;
        if (smallest === i) break;
        [this.items[smallest], this.items[i]] = [this.items[i], this.items[smallest]];
        i = smallest;
      }
    }
    return top;
  }
}

/** A sliding 512-bit set of seqs in (base, base + 512]. */
export class SeqBitmap {
  private words = new Uint32Array(WINDOW_BITS / 32);
  base = 0;

  inWindow(seq: number): boolean {
    return seq > this.base && seq <= this.base + WINDOW_BITS;
  }

  has(seq: number): boolean {
    if (!this.inWindow(seq)) return false;
    const bit = seq - this.base - 1;
    return (this.words[bit >> 5] & (1 << (bit & 31))) !== 0;
  }

  set(seq: number): void {
    if (!this.inWindow(seq)) return;
    const bit = seq - this.base - 1;
    this.words[bit >> 5] |= 1 << (bit & 31);
  }

  /** Moves the window so it starts after `base`. */
  advanceTo(base: number): void {
    const shift = base - this.base;
    if (shift <= 0) return;
    if (shift >= WINDOW_BITS) {
      this.words.fill(0);
    } else {
      const next = new Uint32Array(this.words.length);
      for (let bit = shift; bit < WINDOW_BITS; bit++) {
        if (this.words[bit >> 5] & (1 << (bit & 31))) {
          const moved = bit - shift;
          next[moved >> 5] |= 1 << (moved & 31);
        }
      }
      this.words = next;
    }
    this.base = base;
  }
}

interface TraceCursor {
  contiguous: number;
  heap: SeqHeap;
  early: SeqBitmap;
  /** The highest seq applied early (0 when none is pending above `contiguous`). */
  earlyMax: number;
  timer: unknown;
  fetching: boolean;
}

function newCursor(contiguous: number): TraceCursor {
  const cursor = { contiguous, heap: new SeqHeap(), early: new SeqBitmap(), earlyMax: 0, timer: null, fetching: false };
  cursor.early.advanceTo(contiguous);
  return cursor;
}

export class TelemetryReconciler {
  readonly stats: ReconcilerStats = {
    received: 0,
    applied: 0,
    duplicates: 0,
    reordered: 0,
    gapFetches: 0,
    gapsAbandoned: 0,
  };
  private traces = new Map<string, TraceCursor>();
  private staging: TelemetryEnvelope[] = [];
  private frameScheduled = false;
  private readonly onFlush: (envelopes: TelemetryEnvelope[]) => void;
  private readonly fetchGap?: FetchGap;
  private readonly maxWaitMs: number;
  private readonly maxHeap: number;
  private readonly scheduleFrame: (callback: () => void) => unknown;
  private readonly setTimer: (callback: () => void, ms: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;

  constructor(options: ReconcilerOptions) {
    this.onFlush = options.onFlush;
    this.fetchGap = options.fetchGap;
    this.maxWaitMs = options.maxWaitMs ?? REORDER_WAIT_MS;
    this.maxHeap = options.maxHeap ?? MAX_HEAP;
    this.scheduleFrame =
      options.scheduleFrame ??
      ((cb) => (typeof requestAnimationFrame === "function" ? requestAnimationFrame(cb) : setTimeout(cb, 16)));
    this.setTimer = options.setTimer ?? ((cb, ms) => setTimeout(cb, ms));
    this.clearTimer = options.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
  }

  private cursor(traceId: string): TraceCursor {
    let cursor = this.traces.get(traceId);
    if (!cursor) {
      cursor = newCursor(0);
      this.traces.set(traceId, cursor);
    }
    return cursor;
  }

  /** The highest seq handed on without a gap for `traceId`. */
  contiguous(traceId: string): number {
    return this.traces.get(traceId)?.contiguous ?? 0;
  }

  /** After a snapshot: everything up to `seq` is already applied. */
  resetTrace(traceId: string, seq: number): void {
    const old = this.traces.get(traceId);
    if (old?.timer) this.clearTimer(old.timer);
    this.traces.set(traceId, newCursor(seq));
    this.staging = this.staging.filter((e) => e.trace_id !== traceId || e.seq_id > seq);
  }

  ingest(envelopes: TelemetryEnvelope | readonly TelemetryEnvelope[]): void {
    const list = Array.isArray(envelopes) ? envelopes : [envelopes as TelemetryEnvelope];
    for (const env of list) this.ingestOne(env);
  }

  private ingestOne(env: TelemetryEnvelope): void {
    this.stats.received += 1;
    const cursor = this.cursor(env.trace_id);
    const seq = env.seq_id;
    if (seq <= cursor.contiguous || cursor.early.has(seq) || cursor.heap.has(seq)) {
      this.stats.duplicates += 1;
      return;
    }
    if (seq - cursor.contiguous > WINDOW_BITS) {
      // Too far ahead to track: give up on the gap, so this one is next.
      this.abandonGap(cursor, seq - 1);
    }
    if (seq === cursor.contiguous + 1) {
      this.stage(env);
      cursor.contiguous = seq;
      this.drainContiguous(cursor);
      return;
    }
    this.stats.reordered += 1;
    cursor.heap.push(env);
    if (cursor.heap.size > this.maxHeap) {
      this.releaseBuffered(cursor);
    }
    if (cursor.timer === null && cursor.heap.size > 0) {
      cursor.timer = this.setTimer(() => this.onGapTimeout(env.trace_id), this.maxWaitMs);
    }
  }

  /** Moves `contiguous` over what the heap and the bitmap now make contiguous. */
  private drainContiguous(cursor: TraceCursor): void {
    for (;;) {
      const next = cursor.contiguous + 1;
      const top = cursor.heap.peek();
      if (top && top.seq_id === next) {
        this.stage(cursor.heap.pop() as TelemetryEnvelope);
        cursor.contiguous = next;
      } else if (cursor.early.has(next)) {
        cursor.contiguous = next;
      } else {
        break;
      }
    }
    cursor.early.advanceTo(cursor.contiguous);
    if (cursor.earlyMax <= cursor.contiguous) cursor.earlyMax = 0;
    if (cursor.heap.size === 0 && cursor.earlyMax === 0 && cursor.timer !== null) {
      this.clearTimer(cursor.timer);
      cursor.timer = null;
    }
  }

  /** Applies what's buffered now, out of order, marking each seq as applied. */
  private releaseBuffered(cursor: TraceCursor): void {
    while (cursor.heap.size > 0) {
      const env = cursor.heap.pop() as TelemetryEnvelope;
      cursor.early.set(env.seq_id);
      cursor.earlyMax = Math.max(cursor.earlyMax, env.seq_id);
      this.stage(env);
    }
  }

  private onGapTimeout(traceId: string): void {
    const cursor = this.cursor(traceId);
    cursor.timer = null;
    const top = cursor.heap.peek();
    const firstEarly = top?.seq_id ?? this.firstEarly(cursor);
    if (firstEarly === null) return;
    const from = cursor.contiguous + 1;
    const to = firstEarly - 1;
    this.releaseBuffered(cursor);
    if (to < from) return;
    if (!this.fetchGap || cursor.fetching) {
      if (!this.fetchGap) this.abandonGap(cursor, to);
      return;
    }
    cursor.fetching = true;
    this.stats.gapFetches += 1;
    this.fetchGap(traceId, from, to)
      .then((missing) => {
        cursor.fetching = false;
        this.ingest(missing.filter((e) => e.trace_id === traceId));
        // What the fetch didn't have is lost: move on.
        if (cursor.contiguous < to) this.abandonGap(cursor, to);
      })
      .catch(() => {
        cursor.fetching = false;
        this.abandonGap(cursor, to);
      });
  }

  private firstEarly(cursor: TraceCursor): number | null {
    if (cursor.earlyMax === 0) return null;
    for (let s = cursor.contiguous + 1; s <= cursor.contiguous + WINDOW_BITS; s++) {
      if (cursor.early.has(s)) return s;
    }
    return null;
  }

  private abandonGap(cursor: TraceCursor, through: number): void {
    if (through <= cursor.contiguous) return;
    this.stats.gapsAbandoned += 1;
    cursor.contiguous = through;
    // Anything in the heap at or below the new floor goes now, in order.
    while (cursor.heap.size > 0 && (cursor.heap.peek() as TelemetryEnvelope).seq_id <= through) {
      const env = cursor.heap.pop() as TelemetryEnvelope;
      this.stage(env);
    }
    this.drainContiguous(cursor);
  }

  private stage(env: TelemetryEnvelope): void {
    this.staging.push(env);
    this.stats.applied += 1;
    if (!this.frameScheduled) {
      this.frameScheduled = true;
      this.scheduleFrame(() => this.flush());
    }
  }

  /** Hands what's staged to `onFlush` now (the frame callback; also for tests and replays). */
  flush(): void {
    this.frameScheduled = false;
    if (this.staging.length === 0) return;
    const batch = this.staging;
    this.staging = [];
    this.onFlush(batch);
  }

  /** Forgets every trace (a new connection to another gateway). */
  clear(): void {
    for (const cursor of this.traces.values()) {
      if (cursor.timer !== null) this.clearTimer(cursor.timer);
    }
    this.traces.clear();
    this.staging = [];
  }
}
