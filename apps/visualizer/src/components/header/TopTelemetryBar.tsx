/**
 * The top bar (visualizer-spec.md §4.1): the trace being followed (and a picker), live state, the editors the app sees,
 * who holds the GPU lock, CPU, the event count, the view modes, and About.
 */
import { formatCount } from "../../lib/format/format";
import { nleConnected, selectView, useVisualizerStore, type ViewMode } from "../../store/useVisualizerStore";

const MODES: { mode: ViewMode; key: string; label: string }[] = [
  { mode: "split", key: "1", label: "Split Studio+DAG" },
  { mode: "studio", key: "2", label: "Virtual Studio" },
  { mode: "dag", key: "3", label: "Execution DAG" },
];

const STATUS_DOT: Record<string, string> = {
  open: "#00c853",
  connecting: "#ffb300",
  reconnecting: "#ffb300",
  error: "#ff5252",
  closed: "#72808a",
  idle: "#72808a",
};

export function TopTelemetryBar() {
  const connection = useVisualizerStore((s) => s.connection);
  const followed = useVisualizerStore((s) => s.followedTraceId);
  const known = useVisualizerStore((s) => s.knownTraces);
  const followLatest = useVisualizerStore((s) => s.followLatest);
  const health = useVisualizerStore((s) => s.hostHealth);
  const viewMode = useVisualizerStore((s) => s.viewMode);
  const replay = useVisualizerStore((s) => s.replayCursorSeqId);
  const view = useVisualizerStore(selectView);
  const followTrace = useVisualizerStore((s) => s.followTrace);
  const setFollowLatest = useVisualizerStore((s) => s.setFollowLatest);
  const setViewMode = useVisualizerStore((s) => s.setViewMode);
  const setAboutOpen = useVisualizerStore((s) => s.setAboutOpen);

  const heartbeat = view.heartbeat;
  const metrics = (health?.host_metrics ?? {}) as { host_cpu_percent?: number; gpu_lock_holder?: string | null };
  const cpu = heartbeat?.host_cpu_percent ?? metrics.host_cpu_percent;
  const gpu = heartbeat?.gpu_lock_holder ?? metrics.gpu_lock_holder ?? null;
  const nle = nleConnected(health, heartbeat);
  const editor = nle ? [nle.premiere && "Premiere", nle.resolve && "Resolve"].filter(Boolean).join(" + ") || "none" : "–";
  const traces = Object.values(known).sort((a, b) => b.last_timestamp_ms - a.last_timestamp_ms);
  const live = replay === null && connection.status === "open";

  return (
    <header className="flex flex-wrap items-center gap-x-4 gap-y-1 border-b border-border bg-surface px-3 py-1.5 text-xs">
      <h1 className="font-semibold text-[#e6edf3]">VibeCut Agent Telemetry Studio</h1>
      <label className="flex items-center gap-1 text-cool-grey">
        Trace
        <select
          className="rounded border border-border bg-canvas px-1 py-0.5 font-mono text-[#e6edf3]"
          value={followed ?? ""}
          onChange={(e) => {
            setFollowLatest(false);
            followTrace(e.target.value || null);
          }}
        >
          {!followed && <option value="">(waiting)</option>}
          {followed && !known[followed] && <option value={followed}>{followed}</option>}
          {traces.map((t) => (
            <option key={t.trace_id} value={t.trace_id}>
              {t.trace_id} ({formatCount(t.latest_seq_id)})
            </option>
          ))}
        </select>
      </label>
      <label className="flex items-center gap-1 text-cool-grey">
        <input type="checkbox" checked={followLatest} onChange={(e) => setFollowLatest(e.target.checked)} />
        Follow latest
      </label>
      <span className="flex items-center gap-1" aria-live="polite">
        <span className="inline-block h-2 w-2 rounded-full" style={{ background: replay !== null ? "#ffb300" : STATUS_DOT[connection.status] }} />
        <span className="text-[#e6edf3]">
          {replay !== null ? `Replay @ ${replay}` : live ? "Live" : connection.status}
          {connection.source === "mock" ? " (mock)" : ""}
        </span>
        {connection.latency_ms !== null && <span className="font-mono text-cool-grey">{Math.round(connection.latency_ms)}ms</span>}
      </span>
      <span className="text-cool-grey">
        Editor: <span className="text-[#e6edf3]" data-testid="editor-status">{editor}</span>
      </span>
      <span className="text-cool-grey">
        GPU Lock: <span className={gpu ? "text-warning" : "text-[#e6edf3]"}>{gpu ?? "free"}</span>
      </span>
      <span className="font-mono text-cool-grey">CPU: {cpu === undefined ? "–" : `${cpu.toFixed(1)}%`}</span>
      <span className="font-mono text-cool-grey">Events: {formatCount(view.event_count)}</span>
      <nav className="ml-auto flex items-center gap-1" aria-label="View mode">
        {MODES.map(({ mode, key, label }) => (
          <button
            key={mode}
            type="button"
            aria-pressed={viewMode === mode}
            className={`rounded border px-2 py-0.5 ${viewMode === mode ? "border-athletic-blue-light text-[#e6edf3]" : "border-border text-cool-grey hover:text-[#e6edf3]"}`}
            onClick={() => setViewMode(mode)}
            title={`${label} (${key})`}
          >
            {key}: {label}
          </button>
        ))}
        <button
          type="button"
          className="rounded border border-border px-2 py-0.5 text-cool-grey hover:text-[#e6edf3]"
          onClick={() => setAboutOpen(true)}
          title="About This App (?)"
        >
          About ?
        </button>
      </nav>
    </header>
  );
}
