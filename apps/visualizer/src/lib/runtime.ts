/**
 * Wires the pieces together: the host adapter says where the gateway is, the socket hands envelopes to
 * the reconciler, and the reconciler hands a frame's worth to the store. Binary frames go to the store
 * as waveforms, contact strips and scrub audio (lib/audio/scrubPlayer.ts, which sends its requests on the
 * same socket). The health and trace list are polled every 2 s and 5 s for the top bar and the About modal.
 *
 * With `?source=mock` there is no gateway: the built-in mock run plays through the same reconciler.
 */
import { VctbFrameType } from "@vibecut/contracts";
import { useVisualizerStore, type HostHealth, type KnownTrace } from "../store/useVisualizerStore";
import { ScrubPlayer } from "./audio/scrubPlayer";
import type { RuntimeHostAdapter } from "./host/runtimeHostAdapter";
import { replayTimed } from "./reconciler/mockTraceGenerator";
import { TelemetryReconciler } from "./reconciler/TelemetryReconciler";
import { scrubSamples, waveformPeaks, type VctbFrame } from "./transport/binaryFrameParser";
import { TelemetryWsClient } from "./transport/wsClient";

export const HEALTH_POLL_MS = 2000;
export const TRACES_POLL_MS = 5000;

type Store = typeof useVisualizerStore;

export function handleBinaryFrame(store: Store, frame: VctbFrame, player?: ScrubPlayer | null): void {
  if (frame.frameType === VctbFrameType.AUDIO_WAVEFORM_PEAKS) {
    store.getState().addWaveform(frame.seqId, frame.channel, waveformPeaks(frame));
  } else if (frame.frameType === VctbFrameType.TIMELINE_SCRUB_AUDIO) {
    player?.receive(frame.seqId, frame.channel, scrubSamples(frame));
  } else if (frame.frameType === VctbFrameType.VLM_CONTACT_STRIP_JPEG && typeof URL.createObjectURL === "function") {
    const blob = new Blob([frame.payload.slice()], { type: "image/jpeg" });
    store.getState().addContactStrip(frame.seqId, URL.createObjectURL(blob));
  }
}

export function startTelemetry(adapter: RuntimeHostAdapter, store: Store = useVisualizerStore): () => void {
  const state = () => store.getState();
  if (adapter.source === "mock") {
    const reconciler = new TelemetryReconciler({ onFlush: (envs) => state().applyBatch(envs) });
    state().setConnection({ status: "open", source: "mock", url: null, detail: "Built-in mock run" });
    let stopPlay = replayTimed((envs) => reconciler.ingest(envs), { speed: 1 });
    const loop = setInterval(() => {
      stopPlay();
      reconciler.clear();
      state().followTrace(null);
      stopPlay = replayTimed((envs) => reconciler.ingest(envs), { speed: 1 });
    }, 8000);
    return () => {
      clearInterval(loop);
      stopPlay();
      reconciler.clear();
    };
  }

  const headers: Record<string, string> = adapter.token ? { Authorization: `Bearer ${adapter.token}` } : {};
  // Created below; the reconciler's gap fill and the scrub player go through it.
  let client: TelemetryWsClient | null = null;
  const player = new ScrubPlayer({ send: (message) => client?.sendMessage(message) ?? false });
  const reconciler = new TelemetryReconciler({
    onFlush: (envs) => state().applyBatch(envs),
    fetchGap: (traceId, from, to) =>
      client ? client.fetchGap(traceId, from, to) : Promise.reject(new Error("Not connected")),
  });
  client = new TelemetryWsClient({
    url: adapter.wsUrl,
    httpBase: adapter.httpBase,
    hostMode: adapter.mode,
    traceId: adapter.traceId,
    authToken: adapter.token,
    clientId: `visualizer-${Math.random().toString(36).slice(2, 8)}`,
    lastSeenSeq: () => {
      const s = state();
      const traceId = s.followedTraceId ?? s.live.trace_id;
      return traceId ? reconciler.contiguous(traceId) : 0;
    },
    onEnvelopes: (envs) => reconciler.ingest(envs),
    onSnapshot: (snapshot) => {
      reconciler.resetTrace(snapshot.trace_id, snapshot.snapshot_seq_id);
      state().hydrateSnapshot(snapshot.trace_id, snapshot.snapshot_seq_id, snapshot.replay_events);
    },
    onBinary: (frame) => {
      if (frame.frameType === VctbFrameType.TIMELINE_SCRUB_AUDIO) state().setScrubNotice(null);
      handleBinaryFrame(store, frame, player);
    },
    onScrubUnavailable: (requestId, reason) => {
      if (player.unavailable(requestId)) state().setScrubNotice(reason);
    },
    onStatus: (status, detail) => state().setConnection({ status, detail: detail ?? null }),
    onLatency: (rtt) => state().setConnection({ latency_ms: rtt }),
  });
  state().setConnection({ url: adapter.wsUrl, source: "gateway" });
  client.connect();
  state().setScrubber(player);

  state().setControlSender(async (traceId, action, params) => {
    const response = await fetch(`${adapter.httpBase}/api/v1/control/${encodeURIComponent(traceId)}`, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ action, params: params ?? {} }),
    });
    if (!response.ok) {
      const body = (await response.json().catch(() => ({}))) as { error?: string };
      throw new Error(body.error ?? `HTTP ${response.status}`);
    }
  });

  const poll = async (path: string) => {
    const response = await fetch(`${adapter.httpBase}${path}`, { headers });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.json() as Promise<unknown>;
  };
  const healthTimer = setInterval(() => {
    poll("/api/v1/health")
      .then((health) => state().setHostHealth(health as HostHealth))
      .catch(() => state().setHostHealth(null));
  }, HEALTH_POLL_MS);
  const tracesTimer = setInterval(() => {
    poll("/api/v1/traces")
      .then((body) => state().setKnownTraces(((body as { traces?: KnownTrace[] }).traces ?? []).map((t) => ({
        trace_id: t.trace_id,
        latest_seq_id: t.latest_seq_id,
        last_timestamp_ms: (t as unknown as { last_timestamp_ms?: number }).last_timestamp_ms ?? 0,
        source: t.source,
      }))))
      .catch(() => undefined);
  }, TRACES_POLL_MS);
  const pruneTimer = setInterval(() => state().prunePackets(), 1000);

  // Choosing another trace in the top bar: a fresh reconciler cursor and the server's snapshot.
  const unsubscribe = store.subscribe((s, prev) => {
    if (s.followedTraceId !== prev.followedTraceId && s.followedTraceId && s.live.event_count === 0) {
      const traceId = s.followedTraceId;
      client
        ?.fetchSnapshot(traceId)
        .then((snapshot) => {
          reconciler.resetTrace(traceId, snapshot.snapshot_seq_id);
          if (state().followedTraceId === traceId) {
            state().hydrateSnapshot(traceId, snapshot.snapshot_seq_id, snapshot.replay_events);
          }
        })
        .catch(() => undefined);
    }
  });

  return () => {
    unsubscribe();
    clearInterval(healthTimer);
    clearInterval(tracesTimer);
    clearInterval(pruneTimer);
    state().setControlSender(null);
    state().setScrubber(null);
    player.close();
    client?.close();
    reconciler.clear();
  };
}
