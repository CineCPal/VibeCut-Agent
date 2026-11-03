/**
 * Scrub audio for the OTIO dock (PLAN.md, "Real audio in the OTIO dock", V18). Dragging the ruler asks the
 * gateway for the sound under the playhead (`SCRUB_REQUEST`). The gateway answers with a VCTB 0x03 frame
 * (0.25 s of 48 kHz mono s16le, addressed by the delta's first seq and the op's index), or with
 * `SCRUB_UNAVAILABLE`.
 *
 * One request is in flight at a time. A drag's newer positions wait, and only the latest is sent when the
 * answer comes, so a fast drag never queues up stale snippets. A frame plays only when it matches the
 * last request. Each snippet fades in and out over 4 ms (no clicks) and stops the one before.
 *
 * The AudioContext is made on the first request, which comes from a gesture (the ruler's mousedown), as
 * browsers require.
 */
import type { WsScrubRequest } from "@vibecut/contracts";

export const SCRUB_SAMPLE_RATE = 48000;
export const FADE_SECONDS = 0.004;
/** An answer that hasn't come by then is given up on, so the next position can go. */
export const ANSWER_TIMEOUT_MS = 1000;

/** What's under the playhead: the op, and where the playhead is on the timeline. */
export interface ScrubTarget {
  traceId: string;
  deltaId: string;
  opId: string;
  timelineSeconds: number;
  /** The delta's first MUTATION_EMITTED seq and the op's index: the 0x03 frame's address. */
  seq: number;
  channel: number;
}

/** The parts of a Web Audio context the player uses (stubbed in tests). */
export interface AudioContextLike {
  readonly currentTime: number;
  readonly destination: unknown;
  state: string;
  resume(): Promise<void>;
  close(): Promise<void>;
  createBuffer(channels: number, length: number, sampleRate: number): { getChannelData(channel: number): Float32Array };
  createBufferSource(): {
    buffer: unknown;
    connect(node: unknown): unknown;
    start(when?: number): void;
    stop(when?: number): void;
  };
  createGain(): {
    gain: { setValueAtTime(value: number, at: number): void; linearRampToValueAtTime(value: number, at: number): void };
    connect(node: unknown): unknown;
  };
}

export interface ScrubPlayerOptions {
  /** Sends a request on the socket; false when it isn't open. */
  send: (message: WsScrubRequest) => boolean;
  createContext?: () => AudioContextLike | null;
  setTimer?: (callback: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

function browserContext(): AudioContextLike | null {
  const Context = (globalThis as { AudioContext?: new () => AudioContextLike }).AudioContext;
  return Context ? new Context() : null;
}

export class ScrubPlayer {
  private context: AudioContextLike | null = null;
  private source: ReturnType<AudioContextLike["createBufferSource"]> | null = null;
  private waiting: (ScrubTarget & { requestId: number }) | null = null;
  private queued: ScrubTarget | null = null;
  private nextId = 1;
  private timer: unknown = null;
  private readonly options: ScrubPlayerOptions;
  private readonly setTimer: (callback: () => void, ms: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;

  constructor(options: ScrubPlayerOptions) {
    this.options = options;
    this.setTimer = options.setTimer ?? ((cb, ms) => setTimeout(cb, ms));
    this.clearTimer = options.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
  }

  /** Asks for the sound under the playhead (or queues it behind the request in flight). */
  request(target: ScrubTarget): void {
    if (!this.context) this.context = (this.options.createContext ?? browserContext)();
    if (this.context?.state === "suspended") void this.context.resume().catch(() => undefined);
    if (this.waiting) {
      this.queued = target;
      return;
    }
    this.dispatch(target);
  }

  /** A 0x03 frame: played when it's the answer to the last request. */
  receive(seq: number, channel: number, samples: Float32Array): void {
    const answered = this.waiting;
    if (!answered || answered.seq !== seq || answered.channel !== channel) return;
    this.play(samples);
    this.next();
  }

  /** A SCRUB_UNAVAILABLE: true when it answers the request in flight. */
  unavailable(requestId: number | string | null): boolean {
    if (!this.waiting || requestId !== this.waiting.requestId) return false;
    this.next();
    return true;
  }

  close(): void {
    this.stopTimer();
    this.waiting = null;
    this.queued = null;
    this.stopSource();
    void this.context?.close().catch(() => undefined);
    this.context = null;
  }

  private dispatch(target: ScrubTarget): void {
    const requestId = this.nextId++;
    const sent = this.options.send({
      type: "SCRUB_REQUEST",
      request_id: requestId,
      trace_id: target.traceId,
      delta_id: target.deltaId,
      op_id: target.opId,
      timeline_seconds: Math.max(0, target.timelineSeconds),
    });
    if (!sent) return;
    this.waiting = { ...target, requestId };
    this.timer = this.setTimer(() => {
      this.timer = null;
      this.next();
    }, ANSWER_TIMEOUT_MS);
  }

  private next(): void {
    this.stopTimer();
    this.waiting = null;
    const queued = this.queued;
    this.queued = null;
    if (queued) this.dispatch(queued);
  }

  private stopTimer(): void {
    if (this.timer !== null) this.clearTimer(this.timer);
    this.timer = null;
  }

  private stopSource(): void {
    try {
      this.source?.stop();
    } catch {
      // Already ended.
    }
    this.source = null;
  }

  private play(samples: Float32Array): void {
    const context = this.context;
    if (!context || samples.length === 0) return;
    const buffer = context.createBuffer(1, samples.length, SCRUB_SAMPLE_RATE);
    buffer.getChannelData(0).set(samples);
    const gain = context.createGain();
    const now = context.currentTime;
    const end = now + samples.length / SCRUB_SAMPLE_RATE;
    gain.gain.setValueAtTime(0, now);
    gain.gain.linearRampToValueAtTime(1, now + FADE_SECONDS);
    gain.gain.setValueAtTime(1, Math.max(now + FADE_SECONDS, end - FADE_SECONDS));
    gain.gain.linearRampToValueAtTime(0, end);
    gain.connect(context.destination);
    this.stopSource();
    const source = context.createBufferSource();
    source.buffer = buffer;
    source.connect(gain);
    source.start(now);
    this.source = source;
  }
}
