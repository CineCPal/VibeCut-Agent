/**
 * The visualizer's store (visualizer-spec.md §2.3 B, §5.1): Zustand v5 with Immer.
 *
 * The socket never writes here. The reconciler hands a frame's envelopes to `applyBatch` at most once per
 * animation frame, and the reducer (lib/reconciler/reduce.ts) runs on the Immer draft. The DAG layout
 * ranks only when the topology changed (`topology_version`), and is placed again for the DAG pane's size
 * (`setDagBox`), which decides how many columns a tall rank wraps into.
 *
 * The live state follows one trace. Envelopes of other traces only update `knownTraces`, unless
 * `followLatest` is on and a new run starts (a root SPAWN), which then becomes the followed trace.
 *
 * Time travel: `setReplayCursor(seq)` keeps a projection of the trace at that seq; `null` goes back to
 * live. Components read `selectView(state)`, which is the projection when there is one.
 */
import type { TelemetryEnvelope } from "@vibecut/contracts";
import { create } from "zustand";
import { immer } from "zustand/middleware/immer";
import type { ScrubTarget } from "../lib/audio/scrubPlayer";
import { createLayoutMemo } from "../lib/dag/layout";
import { ProjectionCache } from "../lib/reconciler/projection";
import { createTraceState, reduceEnvelopes, type TraceState } from "../lib/reconciler/reduce";
import type { ConnectionStatus } from "../lib/transport/wsClient";

export type ViewMode = "split" | "studio" | "dag";
/** The docks that collapse to their header: the OTIO preview and the terminal & replay log. */
export type DockId = "otio" | "log";

const DOCKS_KEY = "vibecut.visualizer.collapsedDocks";

/** This viewer's collapsed docks, remembered in the browser; none when storage isn't there. */
function loadCollapsed(): Record<DockId, boolean> {
  try {
    const saved = JSON.parse(localStorage.getItem(DOCKS_KEY) ?? "{}") as Partial<Record<DockId, unknown>>;
    return { otio: saved.otio === true, log: saved.log === true };
  } catch {
    return { otio: false, log: false };
  }
}

function saveCollapsed(collapsed: Record<DockId, boolean>): void {
  try {
    localStorage.setItem(DOCKS_KEY, JSON.stringify(collapsed));
  } catch {
    // Private window or blocked storage: the choice lasts until reload.
  }
}

const SCRUB_KEY = "vibecut.visualizer.scrubAudio";

/** Whether dragging the OTIO ruler plays the sound under it: on unless this viewer turned it off. */
function loadScrubAudio(): boolean {
  try {
    return localStorage.getItem(SCRUB_KEY) !== "off";
  } catch {
    return true;
  }
}

function saveScrubAudio(on: boolean): void {
  try {
    localStorage.setItem(SCRUB_KEY, on ? "on" : "off");
  } catch {
    // As above: lasts until reload.
  }
}

/** A waveform's key: the delta's first MUTATION_EMITTED seq and the op's index (V17). */
export function waveformKey(seq: number, channel: number): string {
  return `${seq}:${channel}`;
}

/** The scrub player, as the store sees it (lib/audio/scrubPlayer.ts). */
export interface Scrubber {
  request: (target: ScrubTarget) => void;
}
export type SeverityFilter = "ALL" | "DEBUG" | "INFO" | "MUTATION" | "WARN" | "ERROR";

export interface HostHealth {
  status: string;
  version: string;
  active_trace_id: string | null;
  connected_clients: number;
  host_metrics: Record<string, unknown>;
  workers: Record<string, unknown>;
  telemetry_dir?: string | null;
  paused?: boolean;
  /** The app started this gateway, so Cancel, Reveal and the editor's playhead reach the app. */
  app_control?: boolean;
}

export interface NleConnected {
  premiere: boolean;
  resolve: boolean;
}

/** Which editors the app sees: the gateway's live health first (polled every 2 s), else the trace's last
 * heartbeat (sent only while a run is active, so a finished trace's is old). Null when neither says. */
export function nleConnected(health: HostHealth | null, heartbeat: { nle_connected: NleConnected } | null): NleConnected | null {
  const live = (health?.host_metrics as { nle_connected?: Partial<NleConnected> } | undefined)?.nle_connected;
  if (live && typeof live.premiere === "boolean" && typeof live.resolve === "boolean") {
    return { premiere: live.premiere, resolve: live.resolve };
  }
  return heartbeat?.nle_connected ?? null;
}

/** The app's actions, through the gateway's control endpoint (lib/control.ts). */
export type AppAction = "CANCEL" | "REVEAL_IN_FINDER" | "SET_NLE_PLAYHEAD";
export type ControlSender = (traceId: string, action: AppAction, params?: Record<string, unknown>) => Promise<void>;

export interface KnownTrace {
  trace_id: string;
  latest_seq_id: number;
  last_timestamp_ms: number;
  source: "live" | "journal";
}

export interface ConnectionState {
  status: ConnectionStatus;
  detail: string | null;
  latency_ms: number | null;
  url: string | null;
  source: "gateway" | "mock";
}

export interface VisualizerState {
  live: TraceState;
  projection: TraceState | null;
  replayCursorSeqId: number | null;
  followedTraceId: string | null;
  followLatest: boolean;
  knownTraces: Record<string, KnownTrace>;
  selectedTaskId: string | null;
  hoveredTaskId: string | null;
  viewMode: ViewMode;
  connection: ConnectionState;
  hostHealth: HostHealth | null;
  /** Posts a control action to the gateway; null with no gateway (the mock source). */
  sendControl: ControlSender | null;
  /** VCTB 0x01 peaks by `waveformKey(seq, channel)`, as numbers in [-1, 1]. */
  waveforms: Record<string, number[]>;
  /** Plays the sound under the OTIO playhead; null with no gateway (the mock source). */
  scrubber: Scrubber | null;
  /** Whether dragging the ruler plays it (remembered in this browser). */
  scrubAudio: boolean;
  /** Why the last scrub had nothing to play; null once one plays. */
  scrubNotice: string | null;
  /** VCTB 0x02 JPEG strips by seq, as object URLs. */
  contactStrips: Record<number, string>;
  aboutOpen: boolean;
  /** The DAG layout's size (for fit-to-view). */
  dagSize: { width: number; height: number };
  /** The DAG pane's size, which the layout is shaped for (0 x 0 until it's measured). */
  dagBox: { width: number; height: number };
  /** Docks collapsed to their header (the wide layout only). */
  collapsedDocks: Record<DockId, boolean>;

  applyBatch: (envelopes: readonly TelemetryEnvelope[], nowMs?: number) => void;
  hydrateSnapshot: (traceId: string, seq: number, events: readonly TelemetryEnvelope[]) => void;
  followTrace: (traceId: string | null) => void;
  setFollowLatest: (on: boolean) => void;
  setReplayCursor: (seq: number | null) => void;
  stepReplay: (delta: number) => void;
  selectTask: (taskId: string | null) => void;
  hoverTask: (taskId: string | null) => void;
  setViewMode: (mode: ViewMode) => void;
  setConnection: (patch: Partial<ConnectionState>) => void;
  setHostHealth: (health: HostHealth | null) => void;
  setControlSender: (sender: ControlSender | null) => void;
  setKnownTraces: (traces: KnownTrace[]) => void;
  addWaveform: (seq: number, channel: number, peaks: number[]) => void;
  setScrubber: (scrubber: Scrubber | null) => void;
  toggleScrubAudio: () => void;
  setScrubNotice: (notice: string | null) => void;
  addContactStrip: (seq: number, url: string) => void;
  setAboutOpen: (open: boolean) => void;
  setDagBox: (width: number, height: number) => void;
  toggleDock: (dock: DockId) => void;
  prunePackets: (nowMs?: number) => void;
  reset: () => void;
}

const layoutMemo = createLayoutMemo();
const projections = new ProjectionCache();

function layOut(live: TraceState, box: { width: number; height: number }): { width: number; height: number } {
  const nodes = Object.values(live.nodes);
  const result = layoutMemo(nodes, Object.values(live.edges), box.width, box.height);
  for (const node of nodes) {
    const position = result.positions[node.task_id];
    if (position) node.layout = position;
  }
  return { width: result.width, height: result.height };
}

function isRunStart(env: TelemetryEnvelope): boolean {
  return env.event_type === "SPAWN" && env.parent_task_id === null;
}

const initial = () => ({
  live: createTraceState(),
  projection: null,
  replayCursorSeqId: null,
  followedTraceId: null,
  followLatest: true,
  knownTraces: {},
  selectedTaskId: null,
  hoveredTaskId: null,
  viewMode: "split" as ViewMode,
  connection: { status: "idle" as ConnectionStatus, detail: null, latency_ms: null, url: null, source: "gateway" as const },
  hostHealth: null,
  sendControl: null as ControlSender | null,
  waveforms: {},
  scrubber: null as Scrubber | null,
  scrubAudio: loadScrubAudio(),
  scrubNotice: null as string | null,
  contactStrips: {},
  aboutOpen: false,
  dagSize: { width: 0, height: 0 },
  dagBox: { width: 0, height: 0 },
  collapsedDocks: loadCollapsed(),
});

export const useVisualizerStore = create<VisualizerState>()(
  immer((set, get) => ({
    ...initial(),

    applyBatch: (envelopes, nowMs = Date.now()) =>
      set((s) => {
        let followed = s.followedTraceId ?? s.live.trace_id;
        const mine: TelemetryEnvelope[] = [];
        for (const env of envelopes) {
          const known = s.knownTraces[env.trace_id];
          if (!known || env.seq_id > known.latest_seq_id) {
            s.knownTraces[env.trace_id] = {
              trace_id: env.trace_id,
              latest_seq_id: env.seq_id,
              last_timestamp_ms: env.timestamp_ms,
              source: known?.source ?? "live",
            };
          }
          if (followed === null) followed = env.trace_id;
          if (env.trace_id !== followed && s.followLatest && isRunStart(env)) {
            // A new run started: follow it from here.
            followed = env.trace_id;
            mine.length = 0;
            s.live = createTraceState(followed);
            s.selectedTaskId = null;
            s.replayCursorSeqId = null;
            s.projection = null;
            projections.reset(followed);
          }
          if (env.trace_id === followed) mine.push(env);
        }
        s.followedTraceId = followed;
        if (!mine.length) return;
        const before = s.live.topology_version;
        reduceEnvelopes(s.live, mine, { packets: s.replayCursorSeqId === null, nowMs });
        if (s.live.topology_version !== before) s.dagSize = layOut(s.live, s.dagBox);
      }),

    hydrateSnapshot: (traceId, seq, events) =>
      set((s) => {
        s.live = createTraceState(traceId);
        s.followedTraceId = traceId;
        s.projection = null;
        s.replayCursorSeqId = null;
        projections.reset(traceId);
        reduceEnvelopes(s.live, events, { packets: false });
        s.live.max_seq_id = Math.max(s.live.max_seq_id, seq);
        s.dagSize = layOut(s.live, s.dagBox);
        s.knownTraces[traceId] = {
          trace_id: traceId,
          latest_seq_id: seq,
          last_timestamp_ms: events.at(-1)?.timestamp_ms ?? 0,
          source: s.knownTraces[traceId]?.source ?? "journal",
        };
      }),

    followTrace: (traceId) =>
      set((s) => {
        s.followedTraceId = traceId;
        s.live = createTraceState(traceId);
        s.projection = null;
        s.replayCursorSeqId = null;
        s.selectedTaskId = null;
        s.dagSize = { width: 0, height: 0 };
        projections.reset(traceId);
      }),

    setFollowLatest: (on) => set((s) => void (s.followLatest = on)),

    setReplayCursor: (seq) => {
      if (seq === null || seq >= get().live.max_seq_id) {
        set((s) => {
          s.replayCursorSeqId = null;
          s.projection = null;
        });
        return;
      }
      const { live } = get();
      const cursor = Math.max(0, Math.round(seq));
      const projection = projections.project(live.logs, cursor, live.trace_id);
      // Layout positions come from the live DAG, so nodes don't jump while scrubbing.
      for (const node of Object.values(projection.nodes)) {
        const placed = live.nodes[node.task_id];
        if (placed) node.layout = { ...placed.layout };
      }
      set((s) => {
        s.replayCursorSeqId = cursor;
        s.projection = projection;
      });
    },

    stepReplay: (delta) => {
      const { replayCursorSeqId, live } = get();
      const from = replayCursorSeqId ?? live.max_seq_id;
      get().setReplayCursor(Math.max(0, Math.min(live.max_seq_id, from + delta)));
    },

    selectTask: (taskId) => set((s) => void (s.selectedTaskId = taskId)),
    hoverTask: (taskId) => set((s) => void (s.hoveredTaskId = taskId)),
    setViewMode: (mode) => set((s) => void (s.viewMode = mode)),
    setConnection: (patch) => set((s) => void Object.assign(s.connection, patch)),
    setHostHealth: (health) => set((s) => void (s.hostHealth = health)),
    setControlSender: (sender) => set((s) => void (s.sendControl = sender)),
    setKnownTraces: (traces) =>
      set((s) => {
        for (const t of traces) {
          const known = s.knownTraces[t.trace_id];
          if (!known || t.latest_seq_id >= known.latest_seq_id) s.knownTraces[t.trace_id] = t;
        }
      }),
    addWaveform: (seq, channel, peaks) => set((s) => void (s.waveforms[waveformKey(seq, channel)] = peaks)),
    setScrubber: (scrubber) => set((s) => void (s.scrubber = scrubber)),
    toggleScrubAudio: () =>
      set((s) => {
        s.scrubAudio = !s.scrubAudio;
        s.scrubNotice = null;
        saveScrubAudio(s.scrubAudio);
      }),
    setScrubNotice: (notice) => set((s) => void (s.scrubNotice = notice)),
    addContactStrip: (seq, url) =>
      set((s) => {
        const old = s.contactStrips[seq];
        if (old && old !== url && typeof URL.revokeObjectURL === "function") URL.revokeObjectURL(old);
        s.contactStrips[seq] = url;
      }),
    setAboutOpen: (open) => set((s) => void (s.aboutOpen = open)),
    setDagBox: (width, height) =>
      set((s) => {
        if (s.dagBox.width === width && s.dagBox.height === height) return;
        s.dagBox = { width, height };
        if (!Object.keys(s.live.nodes).length) return;
        s.dagSize = layOut(s.live, s.dagBox);
        // A replay's projection takes its places from the live DAG.
        if (s.projection) {
          for (const node of Object.values(s.projection.nodes)) {
            const placed = s.live.nodes[node.task_id];
            if (placed) node.layout = { ...placed.layout };
          }
        }
      }),
    toggleDock: (dock) =>
      set((s) => {
        s.collapsedDocks[dock] = !s.collapsedDocks[dock];
        saveCollapsed({ ...s.collapsedDocks });
      }),
    prunePackets: (nowMs = Date.now()) =>
      set((s) => {
        const alive = s.live.activePackets.filter((p) => p.born_ms + p.duration_ms > nowMs);
        if (alive.length !== s.live.activePackets.length) s.live.activePackets = alive;
      }),
    reset: () => {
      projections.reset();
      set(() => initial());
    },
  })),
);

/** What the panes draw: the replay projection when scrubbing, else the live state. */
export function selectView(state: VisualizerState): TraceState {
  return state.projection ?? state.live;
}
