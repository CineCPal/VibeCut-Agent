import type { WsScrubRequest } from "@vibecut/contracts";
import { describe, expect, it } from "vitest";
import { ANSWER_TIMEOUT_MS, SCRUB_SAMPLE_RATE, ScrubPlayer, type AudioContextLike, type ScrubTarget } from "./scrubPlayer";

class FakeContext implements AudioContextLike {
  currentTime = 2;
  destination = "speakers";
  state = "suspended";
  resumed = 0;
  played: { samples: Float32Array<ArrayBufferLike>; at: number; stopped: boolean }[] = [];
  ramps: [string, number, number][] = [];
  async resume() {
    this.resumed += 1;
    this.state = "running";
  }
  async close() {
    this.state = "closed";
  }
  createBuffer(_channels: number, length: number, rate: number) {
    expect(rate).toBe(SCRUB_SAMPLE_RATE);
    const data = new Float32Array(length);
    return { data, getChannelData: () => data };
  }
  createBufferSource() {
    const entry: { samples: Float32Array<ArrayBufferLike>; at: number; stopped: boolean } = { samples: new Float32Array(0), at: -1, stopped: false };
    const source = {
      buffer: null as unknown,
      connect: () => undefined,
      start: (when?: number) => {
        entry.samples = (source.buffer as { data: Float32Array }).data;
        entry.at = when ?? 0;
        this.played.push(entry);
      },
      stop: () => void (entry.stopped = true),
    };
    return source;
  }
  createGain() {
    return {
      gain: {
        setValueAtTime: (v: number, at: number) => void this.ramps.push(["set", v, at]),
        linearRampToValueAtTime: (v: number, at: number) => void this.ramps.push(["ramp", v, at]),
      },
      connect: () => undefined,
    };
  }
}

function setup(open = true) {
  const sent: WsScrubRequest[] = [];
  const context = new FakeContext();
  const timers: (() => void)[] = [];
  const player = new ScrubPlayer({
    send: (message) => {
      if (open) sent.push(message);
      return open;
    },
    createContext: () => context,
    setTimer: (cb, ms) => {
      expect(ms).toBe(ANSWER_TIMEOUT_MS);
      timers.push(cb);
      return timers.length;
    },
    clearTimer: (handle) => void (timers[(handle as number) - 1] = () => undefined),
  });
  return { player, sent, context, timers };
}

const target = (seconds: number, extra: Partial<ScrubTarget> = {}): ScrubTarget => ({
  traceId: "trc_a",
  deltaId: "delta_1",
  opId: "op_a",
  timelineSeconds: seconds,
  seq: 5,
  channel: 1,
  ...extra,
});

describe("ScrubPlayer", () => {
  it("asks for the sound under the playhead and plays the answer with fades", () => {
    const { player, sent, context } = setup();
    player.request(target(10.5));
    expect(context.resumed).toBe(1);
    expect(sent).toEqual([
      { type: "SCRUB_REQUEST", request_id: 1, trace_id: "trc_a", delta_id: "delta_1", op_id: "op_a", timeline_seconds: 10.5 },
    ]);
    const samples = new Float32Array(12000).fill(0.25);
    player.receive(5, 1, samples);
    expect(context.played).toHaveLength(1);
    expect(context.played[0].samples[0]).toBe(0.25);
    expect(context.played[0].at).toBe(2);
    expect(context.ramps[0]).toEqual(["set", 0, 2]);
    expect(context.ramps.at(-1)).toEqual(["ramp", 0, 2.25]);
  });

  it("keeps one request in flight, sends only the newest position after it, and ignores other frames", () => {
    const { player, sent, context } = setup();
    player.request(target(10));
    player.request(target(10.1));
    player.request(target(10.2));
    expect(sent).toHaveLength(1);
    player.receive(5, 0, new Float32Array(10));
    player.receive(9, 1, new Float32Array(10));
    expect(context.played).toHaveLength(0);
    player.receive(5, 1, new Float32Array(10));
    expect(sent.map((m) => m.timeline_seconds)).toEqual([10, 10.2]);
    player.receive(5, 1, new Float32Array(10));
    expect(context.played).toHaveLength(2);
    expect(context.played[0].stopped).toBe(true);
  });

  it("moves on after a refusal or a lost answer, and sends nothing while the socket is shut", () => {
    const { player, sent, timers } = setup();
    player.request(target(1));
    player.request(target(2));
    expect(player.unavailable(99)).toBe(false);
    expect(player.unavailable(1)).toBe(true);
    expect(sent.map((m) => m.request_id)).toEqual([1, 2]);
    player.request(target(3));
    timers[1]();
    expect(sent.map((m) => m.timeline_seconds)).toEqual([1, 2, 3]);

    const shut = setup(false);
    shut.player.request(target(1));
    shut.player.request(target(2));
    expect(shut.sent).toHaveLength(0);
    expect(shut.timers).toHaveLength(0);
  });
});
