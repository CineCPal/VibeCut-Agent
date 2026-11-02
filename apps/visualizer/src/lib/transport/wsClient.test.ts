import type { TelemetryEnvelope } from "@vibecut/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { env, planning } from "../../test/envelopes";
import { packVctbFrame } from "./binaryFrameParser";
import { TelemetryWsClient, type WebSocketLike } from "./wsClient";

class FakeSocket implements WebSocketLike {
  binaryType = "blob";
  readyState = 0;
  sent: unknown[] = [];
  closed = false;
  onopen: ((ev: unknown) => void) | null = null;
  onclose: ((ev: unknown) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  constructor(public url: string) {}
  send(data: string) {
    this.sent.push(JSON.parse(data));
  }
  close() {
    this.closed = true;
    this.onclose?.({});
  }
  open() {
    this.readyState = 1;
    this.onopen?.({});
  }
  receive(message: unknown) {
    this.onmessage?.({ data: typeof message === "string" || message instanceof ArrayBuffer ? message : JSON.stringify(message) });
  }
}

const welcome = (seq: number, snapshot: boolean, trace = "trc_test") => ({
  type: "SERVER_WELCOME",
  protocol_version: "vibecut.ws.v1",
  server_time_ms: 1,
  active_trace_id: trace,
  current_seq_id: seq,
  requires_snapshot_fetch: snapshot,
  heartbeat_interval_ms: 5000,
});

function setup(fetchImpl?: typeof fetch) {
  const sockets: FakeSocket[] = [];
  const envelopes: TelemetryEnvelope[] = [];
  const statuses: string[] = [];
  const snapshots: unknown[] = [];
  const frames: unknown[] = [];
  let clock = 1000;
  const client = new TelemetryWsClient({
    url: "ws://127.0.0.1:18765/ws/v1/telemetry",
    httpBase: "http://127.0.0.1:18765",
    hostMode: "standalone",
    traceId: null,
    authToken: "tok",
    lastSeenSeq: () => 7,
    onEnvelopes: (envs) => envelopes.push(...envs),
    onSnapshot: (s) => snapshots.push(s),
    onBinary: (f) => frames.push(f),
    onStatus: (s) => statuses.push(s),
    createSocket: (url) => {
      const socket = new FakeSocket(url);
      sockets.push(socket);
      return socket;
    },
    fetchImpl: fetchImpl ?? (async () => new Response("[]")),
    now: () => clock,
    random: () => 0.5,
  });
  return { client, sockets, envelopes, statuses, snapshots, frames, tick: (ms: number) => (clock += ms) };
}

describe("TelemetryWsClient", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("says hello with what it has seen, and pings every 5 s", () => {
    const { client, sockets, statuses } = setup();
    client.connect();
    sockets[0].open();
    expect(sockets[0].binaryType).toBe("arraybuffer");
    expect(sockets[0].sent[0]).toMatchObject({
      type: "CLIENT_HELLO",
      protocol_version: "vibecut.ws.v1",
      host_mode: "standalone",
      subscribe_trace_id: null,
      last_seen_seq_id: 7,
      auth_token: "tok",
    });
    sockets[0].receive(welcome(7, false));
    expect(statuses).toContain("open");
    vi.advanceTimersByTime(5000);
    expect(sockets[0].sent[1]).toMatchObject({ type: "PING", last_applied_seq_id: 7 });
  });

  it("passes on valid envelopes and drops ones that don't fit the contract", () => {
    const { client, sockets, envelopes } = setup();
    client.connect();
    sockets[0].open();
    const good = env(1, planning("task_a"));
    sockets[0].receive({ type: "TELEMETRY_BATCH", trace_id: "trc_test", events: [good, { ...good, seq_id: -1 }] });
    expect(envelopes).toEqual([good]);
    expect(client.invalidEnvelopes).toBe(1);
  });

  it("fetches the snapshot when the server says so", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ trace_id: "trc_test", snapshot_seq_id: 3, replay_events: [env(1, planning("t"))] })),
    );
    const { client, sockets, snapshots } = setup(fetchImpl as unknown as typeof fetch);
    client.connect();
    sockets[0].open();
    sockets[0].receive(welcome(3, true));
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchImpl).toHaveBeenCalledWith("http://127.0.0.1:18765/api/v1/traces/trc_test/snapshot", {
      headers: { Authorization: "Bearer tok" },
    });
    expect(snapshots).toHaveLength(1);
    expect((snapshots[0] as { snapshot_seq_id: number }).snapshot_seq_id).toBe(3);
  });

  it("reconnects with backoff, and takes the snapshot after more than 5 s away", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ trace_id: "trc_test", snapshot_seq_id: 9, replay_events: [] })));
    const { client, sockets, snapshots, statuses, tick } = setup(fetchImpl as unknown as typeof fetch);
    expect([0, 1, 2, 3, 4, 5].map((n) => client.backoffMs(n))).toEqual([250, 500, 1000, 2000, 4000, 5000]);
    client.connect();
    sockets[0].open();
    sockets[0].receive(welcome(5, false));
    sockets[0].onclose?.({});
    expect(statuses.at(-1)).toBe("reconnecting");
    vi.advanceTimersByTime(250);
    expect(sockets).toHaveLength(2);
    sockets[1].onclose?.({});
    vi.advanceTimersByTime(500);
    expect(sockets).toHaveLength(3);
    tick(6000);
    sockets[2].open();
    sockets[2].receive(welcome(9, false));
    await vi.advanceTimersByTimeAsync(1);
    expect(snapshots).toHaveLength(1);
  });

  it("asks for gaps and hands binary frames on", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify([env(2, planning("t")), { bad: true }])));
    const { client, sockets, frames } = setup(fetchImpl as unknown as typeof fetch);
    const missing = await client.fetchGap("trc_test", 2, 2);
    expect(fetchImpl).toHaveBeenCalledWith(
      "http://127.0.0.1:18765/api/v1/traces/trc_test/events?from_seq=2&to_seq=2",
      expect.anything(),
    );
    expect(missing.map((e) => e.seq_id)).toEqual([2]);
    client.connect();
    sockets[0].open();
    sockets[0].receive(packVctbFrame(1, 2, 42, new Uint8Array(4)));
    expect(frames).toHaveLength(1);
  });

  it("stops on a server error and when closed", () => {
    const { client, sockets, statuses } = setup();
    client.connect();
    sockets[0].open();
    sockets[0].receive({ type: "ERROR", message: "A telemetry token is needed" });
    expect(statuses.at(-1)).toBe("error");
    client.close();
    expect(sockets[0].closed).toBe(true);
    vi.advanceTimersByTime(10_000);
    expect(sockets).toHaveLength(1);
  });
});
