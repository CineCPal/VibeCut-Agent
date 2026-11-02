/**
 * Pane C, the agent deep inspector (visualizer-spec.md §4.2 C). For the selected task it shows:
 * - gauges: latency and TTFB, tokens in, out and cached, tok/s, memory, and the hardware backend;
 * - the thought trace, which stays pinned to the bottom unless the user scrolls up;
 * - the active tool call as a JSON tree;
 * - its artifacts (contact strips for the vision tagger);
 * - its OTIO deltas and its error.
 */
import type { ArtifactRef } from "@vibecut/contracts";
import { useLayoutEffect, useMemo, useRef } from "react";
import { useNow } from "../../hooks/useTicker";
import { SUBAGENT_SHORT } from "../../lib/studio/bays";
import { avatarForStatus, formatCount, formatMs, isRunning, STATUS_COLOR } from "../../lib/format/format";
import { selectView, useVisualizerStore } from "../../store/useVisualizerStore";
import { AvatarBadge } from "../studio/AvatarBadge";
import { ContactStripViewer } from "./ContactStripViewer";
import { JsonTree } from "./JsonTree";

function Gauge({ label, value, sub, fraction, color = "#4a90d9" }: { label: string; value: string; sub?: string; fraction?: number; color?: string }) {
  return (
    <div className="rounded border border-border bg-canvas p-1.5">
      <div className="text-[10px] uppercase tracking-wide text-cool-grey">{label}</div>
      <div className="font-mono text-sm text-[#e6edf3]">{value}</div>
      {sub && <div className="font-mono text-[10px] text-cool-grey">{sub}</div>}
      {fraction !== undefined && (
        <div className="mt-1 h-1 rounded bg-border" role="meter" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(fraction * 100)}>
          <div className="h-full rounded" style={{ width: `${Math.min(100, Math.round(fraction * 100))}%`, background: color }} />
        </div>
      )}
    </div>
  );
}

function ArtifactCard({ artifact, strip }: { artifact: ArtifactRef; strip: string | null }) {
  switch (artifact.artifact_type) {
    case "VLM_SHOT_TAGS":
      return <ContactStripViewer src={strip} mediaPath={artifact.media_path} shotCount={artifact.shot_count} scales={artifact.dominant_scales} />;
    case "CLIP_RANGES":
      return (
        <div className="rounded border border-border bg-canvas p-2 text-[11px]">
          <div className="mb-1 font-semibold text-profit">Clip ranges ({artifact.count})</div>
          <ul className="space-y-0.5 font-mono">
            {artifact.clips.map((c) => (
              <li key={c.hit_id} className="flex gap-2">
                <span className="truncate text-[#e6edf3]">{c.filename}</span>
                <span className="text-cool-grey">{c.start_tc}→{c.end_tc}</span>
                <span className="ml-auto text-athletic-blue-light">{c.score.toFixed(1)}</span>
              </li>
            ))}
          </ul>
        </div>
      );
    case "TRANSCRIPT_SUMMARY":
      return (
        <div className="rounded border border-border bg-canvas p-2 font-mono text-[11px]">
          <div className="mb-1 font-sans font-semibold text-[#38bdf8]">Transcript</div>
          {artifact.segment_count} segments · {formatCount(artifact.word_count)} words · {artifact.speakers.join(", ") || "no speakers"}
        </div>
      );
    case "AUDIO_SYNC_MAP":
      return (
        <div className="rounded border border-border bg-canvas p-2 font-mono text-[11px]">
          <div className="mb-1 font-sans font-semibold text-[#14b8a6]">Audio sync</div>
          {artifact.matched_pairs} pairs · max drift {artifact.max_drift_ms} ms
          {artifact.loudness_lufs !== null ? ` · ${artifact.loudness_lufs} LUFS` : ""}
        </div>
      );
    case "VALIDATION_REPORT":
      return (
        <div className="rounded border border-border bg-canvas p-2 font-mono text-[11px]">
          <div className={`mb-1 font-sans font-semibold ${artifact.valid ? "text-profit" : "text-loss"}`}>
            Validation: {artifact.valid ? "valid" : "invalid"} ({artifact.validator_mode})
          </div>
          {artifact.delta_id} · {artifact.diagnostic_count} diagnostics
          {artifact.validation_token ? ` · ${artifact.validation_token.slice(0, 13)}…` : ""}
        </div>
      );
  }
}

export function AgentInspectorDrawer() {
  const view = useVisualizerStore(selectView);
  const selected = useVisualizerStore((s) => s.selectedTaskId);
  const strips = useVisualizerStore((s) => s.contactStrips);
  const logs = useVisualizerStore((s) => s.live.logs);
  const node = selected ? view.nodes[selected] : undefined;
  const running = node ? isRunning(node.status) : false;
  const now = useNow(250, running);
  const traceRef = useRef<HTMLPreElement | null>(null);
  const pinned = useRef(true);

  // The strip streamed for this task: a VCTB 0x02 frame tied to one of its envelopes' seqs.
  const strip = useMemo(() => {
    if (!node) return null;
    const seqs = Object.keys(strips).map(Number).sort((a, b) => b - a);
    const bySeq = new Map(logs.map((e) => [e.seq_id, e]));
    for (const seq of seqs) {
      const owner = bySeq.get(seq)?.payload;
      if (owner && "task_id" in owner && owner.task_id === node.task_id) return strips[seq];
    }
    return null;
  }, [node, strips, logs]);

  useLayoutEffect(() => {
    const el = traceRef.current;
    if (el && pinned.current) el.scrollTop = el.scrollHeight;
  }, [node?.thought_stream]);

  if (!node) {
    return (
      <aside className="flex h-full flex-col items-center justify-center gap-2 bg-surface p-4 text-center text-xs text-cool-grey" aria-label="Agent inspector">
        <p className="font-semibold text-[#e6edf3]">Agent Deep Inspector</p>
        <p>Select a bay in the studio, a task in the DAG, or a line in the log.</p>
      </aside>
    );
  }

  const m = node.metrics;
  const started = m.started_at_ms ?? m.spawned_at_ms;
  const latency = running ? Math.max(0, now - started) : m.latency_ms;
  const color = STATUS_COLOR[node.status];
  const tokensTotal = m.input_tokens + m.output_tokens;
  const lastMutation = node.emitted_mutations.at(-1);

  return (
    <aside className="flex h-full min-h-0 flex-col gap-2 overflow-y-auto bg-surface p-3 text-xs" aria-label="Agent inspector">
      <header className="flex items-center gap-2">
        <AvatarBadge subagent={node.subagent_type} state={avatarForStatus(node.status)} size={40} animate={running} />
        <div className="min-w-0">
          <h2 className="truncate font-semibold text-[#e6edf3]">
            {SUBAGENT_SHORT[node.subagent_type]}: {node.task_label}
          </h2>
          <p className="font-mono text-[10px] text-cool-grey">
            {node.task_id} · {node.agent_id} · {node.model_id || "–"}
          </p>
          <p className="font-mono text-[11px]" style={{ color }}>
            {node.status.replaceAll("_", " ")}
            {lastMutation?.validation_token ? ` (${lastMutation.validation_token.slice(0, 13)})` : ""}
          </p>
        </div>
      </header>

      <div className="grid grid-cols-2 gap-1.5">
        <Gauge label="Latency" value={formatMs(latency)} sub={`TTFB ${formatMs(m.ttfb_ms)}`} fraction={Math.min(1, latency / 60000)} color={color} />
        <Gauge label="Tokens" value={`${formatCount(m.input_tokens)} → ${formatCount(m.output_tokens)}`} sub={`cached ${formatCount(m.cached_tokens)} · ${m.token_rate_tps.toFixed(1)} tok/s`} fraction={Math.min(1, tokensTotal / 20000)} />
        <Gauge label="Memory" value={m.rss_memory_mb ? `${formatCount(Math.round(m.rss_memory_mb))} MB` : "–"} fraction={Math.min(1, m.rss_memory_mb / 16384)} color="#14b8a6" />
        <div className="rounded border border-border bg-canvas p-1.5">
          <div className="text-[10px] uppercase tracking-wide text-cool-grey">Backend</div>
          <span className="mt-1 inline-block rounded border border-athletic-blue-light px-1 font-mono text-[11px] text-athletic-blue-light">{node.hardware_backend}</span>
          {m.gpu_lock_held && <span className="ml-1 inline-block rounded border border-warning px-1 font-mono text-[11px] text-warning">GPU LOCK</span>}
        </div>
      </div>

      {node.progress && (
        <Gauge
          label={`Progress: ${node.progress.phase}`}
          value={`${node.progress.completed_items}/${node.progress.total_items} (${Math.round(node.progress.fraction * 100)}%)`}
          sub={node.progress.eta_seconds !== null ? `ETA ${node.progress.eta_seconds.toFixed(1)} s · ${node.progress.current_item_label ?? ""}` : (node.progress.current_item_label ?? undefined)}
          fraction={node.progress.fraction}
          color="#38bdf8"
        />
      )}

      {node.error && (
        <div className="rounded border border-loss bg-[#2a1214] p-2" role="alert">
          <div className="font-mono font-semibold text-loss">
            [!] {node.error.error_code} {node.error.recoverable ? "(recoverable)" : ""}
          </div>
          <div className="text-[#e6edf3]">{node.error.error_message}</div>
          {node.error.remediation_hint && <div className="mt-1 text-warm-grey">{node.error.remediation_hint}</div>}
        </div>
      )}

      <section>
        <h3 className="mb-1 text-[10px] uppercase tracking-wide text-cool-grey">Live thought trace</h3>
        <pre
          ref={traceRef}
          className="h-28 overflow-y-auto whitespace-pre-wrap rounded border border-border bg-canvas p-2 font-mono text-[11px] text-[#e6edf3]"
          onScroll={(e) => {
            const el = e.currentTarget;
            pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
          }}
          aria-live="off"
          data-testid="thought-stream"
        >
          {node.thought_stream || "—"}
        </pre>
      </section>

      {node.active_tool_call && (
        <section>
          <h3 className="mb-1 text-[10px] uppercase tracking-wide text-cool-grey">Active tool call: <span className="font-mono normal-case text-[#e6edf3]">{node.active_tool_call.tool_name}</span></h3>
          <div className="max-h-40 overflow-auto rounded border border-border bg-canvas py-1 font-mono text-[11px]">
            <JsonTree value={node.active_tool_call.arguments} label="arguments" />
          </div>
        </section>
      )}

      {node.artifacts.length > 0 && (
        <section className="space-y-1.5">
          <h3 className="text-[10px] uppercase tracking-wide text-cool-grey">Intermediate artifacts ({node.artifacts.length})</h3>
          {node.artifacts.map((a, i) => (
            <ArtifactCard key={`${a.artifact_type}-${i}`} artifact={a} strip={strip} />
          ))}
        </section>
      )}

      {node.emitted_mutations.length > 0 && (
        <section>
          <h3 className="mb-1 text-[10px] uppercase tracking-wide text-cool-grey">OTIO deltas</h3>
          <ul className="space-y-0.5 font-mono text-[11px]">
            {node.emitted_mutations.map((mu) => (
              <li key={`${mu.delta_id}-${mu.mutation_stage}`} className="flex gap-2">
                <span className="text-[#e6edf3]">{mu.delta_id}</span>
                <span className="text-warning">{mu.mutation_stage}</span>
                <span className="text-cool-grey">{mu.operations.length} ops</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section>
        <h3 className="mb-1 text-[10px] uppercase tracking-wide text-cool-grey">Dependencies</h3>
        <p className="font-mono text-[11px] text-warm-grey">
          ← {node.dependencies.join(", ") || "none"}
          <br />→ {node.dependents.join(", ") || "none"}
        </p>
      </section>
    </aside>
  );
}
