/**
 * The runtime's paged snapshot (PLAN.md, "Opening a big trace without a freeze"): a fake gateway that pages,
 * a fake socket, and live events that arrive while the pages load.
 */
import type { TelemetryEnvelope } from "@vibecut/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useVisualizerStore } from "../store/useVisualizerStore";
import { env, spawn, tool } from "../test/envelopes";
import type { RuntimeHostAdapter } from "./host/runtimeHostAdapter";
import { SNAPSHOT_PAGE, startTelemetry } from "./runtime";

class FakeSocket {
  static last: FakeSocket | null = null;
  binaryType = "blob";
  readyState = 0;
  sent: unknown[] = [];
  onopen: ((ev: unknown) => void) | null = null;
  onclose: ((ev: unknown) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  constructor(public url: string) {
    FakeSocket.last = this;
    queueMicrotask(() => {
      this.readyState = 1;
      this.onopen?.({});
    });
  }
  send(data: string) {
    this.sent.push(JSON.parse(data));
  }
  close() {
    this.onclose?.({});
  }
  receive(message: unknown) {
    this.onmessage?.({ data: JSON.stringify(message) });
  }
}

const TRACE = "trc_test";
const TOTAL = SNAPSHOT_PAGE * 2 + 500;

function trace(): TelemetryEnvelope[] {
  const rows = [env(1, spawn("task_root"), { parent: null })];
  for (let i = 0; i < 10; i++) rows.push(env(rows.length + 1, spawn(`task_${i}`)));
  while (rows.length < TOTAL) rows.push(env(rows.length + 1, tool(`task_${rows.length % 10}`)));
  return rows;
}

const adapter: RuntimeHostAdapter = {
  mode: "standalone",
  httpBase: "http://gw",
  wsUrl: "ws://gw/ws/v1/telemetry",
  sseUrl: "http://gw/sse/v1/telemetry",
  token: null,
  traceId: TRACE,
  source: "gateway",
  compact: false,
};

describe("the runtime's snapshot", () => {
  const rows = trace();
  let requests: string[] = [];
  let onPage: (() => void) | null = null;

  beforeEach(() => {
    useVisualizerStore.getState().reset();
    requests = [];
    onPage = null;
    vi.stubGlobal("WebSocket", FakeSocket);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string) => {
        const url = new URL(input);
        requests.push(url.pathname + url.search);
        if (!url.pathname.endsWith("/snapshot")) return new Response(JSON.stringify({ traces: [] }));
        const offset = Number(url.searchParams.get("offset"));
        const limit = Number(url.searchParams.get("limit"));
        onPage?.();
        return new Response(
          JSON.stringify({
            trace_id: TRACE,
            snapshot_seq_id: TOTAL,
            replay_total: TOTAL,
            replay_offset: offset,
            replay_events: rows.slice(offset, offset + limit),
          }),
        );
      }),
    );
  });
  afterEach(() => vi.unstubAllGlobals());

  it("loads in pages pinned to one seq, and applies live events that came meanwhile after them, in order", async () => {
    const stop = startTelemetry(adapter);
    await vi.waitFor(() => expect(FakeSocket.last?.sent.length).toBeGreaterThan(0));
    const socket = FakeSocket.last!;
    const progress: number[] = [];
    let sentLive = false;
    onPage = () => {
      const hydration = useVisualizerStore.getState().hydration;
      if (hydration) progress.push(hydration.loaded);
      if (hydration && !sentLive) {
        // Two live events arrive between pages: held until the snapshot is in.
        sentLive = true;
        socket.receive({
          type: "TELEMETRY_BATCH",
          trace_id: TRACE,
          events: [env(TOTAL + 1, tool("task_1")), env(TOTAL + 2, tool("task_2"))],
        });
      }
    };
    socket.receive({
      type: "SERVER_WELCOME",
      protocol_version: "vibecut.ws.v1",
      server_time_ms: 1,
      active_trace_id: TRACE,
      current_seq_id: TOTAL,
      requires_snapshot_fetch: true,
      heartbeat_interval_ms: 5000,
    });
    await vi.waitFor(() => expect(useVisualizerStore.getState().live.logs.length).toBe(TOTAL + 2), { timeout: 5000 });

    const snapshots = requests.filter((r) => r.includes("/snapshot"));
    expect(snapshots).toEqual([
      `/api/v1/traces/${TRACE}/snapshot?offset=0&limit=${SNAPSHOT_PAGE}`,
      `/api/v1/traces/${TRACE}/snapshot?offset=${SNAPSHOT_PAGE}&limit=${SNAPSHOT_PAGE}&at_seq=${TOTAL}`,
      `/api/v1/traces/${TRACE}/snapshot?offset=${SNAPSHOT_PAGE * 2}&limit=${SNAPSHOT_PAGE}&at_seq=${TOTAL}`,
    ]);
    // The store filled in page by page.
    expect(progress).toEqual([SNAPSHOT_PAGE, SNAPSHOT_PAGE * 2]);
    const { live, hydration } = useVisualizerStore.getState();
    expect(hydration).toBeNull();
    expect(live.logs.map((e) => e.seq_id)).toEqual(Array.from({ length: TOTAL + 2 }, (_, i) => i + 1));
    expect(Object.keys(live.nodes)).toHaveLength(11);
    stop();
  });

  it("stops loading when another trace is chosen, and loads that one", async () => {
    const stop = startTelemetry(adapter);
    await vi.waitFor(() => expect(FakeSocket.last?.sent.length).toBeGreaterThan(0));
    let switched = false;
    onPage = () => {
      if (useVisualizerStore.getState().hydration?.trace_id === TRACE && !switched) {
        switched = true;
        useVisualizerStore.getState().followTrace("trc_other");
      }
    };
    FakeSocket.last!.receive({
      type: "SERVER_WELCOME",
      protocol_version: "vibecut.ws.v1",
      server_time_ms: 1,
      active_trace_id: TRACE,
      current_seq_id: TOTAL,
      requires_snapshot_fetch: true,
      heartbeat_interval_ms: 5000,
    });
    await vi.waitFor(() => expect(requests.some((r) => r.startsWith("/api/v1/traces/trc_other/snapshot"))).toBe(true));
    await vi.waitFor(() => expect(useVisualizerStore.getState().hydration).toBeNull(), { timeout: 5000 });
    // trc_test's load gave up after the page in flight: it never asked for its third.
    expect(requests.filter((r) => r.startsWith(`/api/v1/traces/${TRACE}/snapshot`)).length).toBeLessThanOrEqual(2);
    stop();
  });
});
