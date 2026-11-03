/**
 * Pane D, the terminal and replay log (visualizer-spec.md §4.2 D). The log is virtualized
 * (@tanstack/react-virtual, 24 px Fira Code rows), so it holds 100,000 envelopes at 60 FPS. It filters by
 * severity, subagent and agent, and searches by substring or by `/regex/` (a bad regex says so). It
 * follows the tail while live and at the bottom. A row selects its task; while replaying, rows after
 * the cursor are dimmed.
 */
import type { LogSeverity, TelemetryEnvelope } from "@vibecut/contracts";
import { LOG_SEVERITIES, SUBAGENT_TYPES } from "@vibecut/contracts";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useEffect, useMemo, useRef, useState } from "react";
import { formatClock } from "../../lib/format/format";
import { summarize, taskOf } from "../../lib/format/summarize";
import { SUBAGENT_SHORT } from "../../lib/studio/bays";
import { useVisualizerStore } from "../../store/useVisualizerStore";
import { DockToggle } from "../workspace/DockToggle";
import { TimeTravelScrubber } from "./TimeTravelScrubber";

export const ROW_PX = 24;

const SEVERITY_COLOR: Record<LogSeverity, string> = {
  DEBUG: "#72808a",
  INFO: "#4a90d9",
  MUTATION: "#ffb300",
  WARN: "#ffb300",
  ERROR: "#ff5252",
};

export interface LogFilter {
  severities: ReadonlySet<LogSeverity>;
  subagent: string;
  agent: string;
  search: string;
}

/** A search as a matcher: `/…/flags` is a regex, anything else a case-insensitive substring. */
export function searchMatcher(search: string): { test: (text: string) => boolean; error: string | null } {
  const trimmed = search.trim();
  if (!trimmed) return { test: () => true, error: null };
  const regex = /^\/(.+)\/([gimsuy]*)$/.exec(trimmed);
  if (regex) {
    try {
      const re = new RegExp(regex[1], regex[2].replace("g", ""));
      return { test: (t) => re.test(t), error: null };
    } catch (e) {
      return { test: () => true, error: e instanceof Error ? e.message : String(e) };
    }
  }
  const needle = trimmed.toLowerCase();
  return { test: (t) => t.toLowerCase().includes(needle), error: null };
}

/** The rows the filter keeps; with no filter on, `logs` itself, so a 100k-row log isn't walked each batch. */
export function filterLogs(logs: readonly TelemetryEnvelope[], filter: LogFilter, test: (text: string) => boolean): readonly TelemetryEnvelope[] {
  if (filter.severities.size === LOG_SEVERITIES.length && !filter.subagent && !filter.agent && !filter.search.trim()) {
    return logs;
  }
  return logs.filter(
    (e) =>
      filter.severities.has(e.severity) &&
      (!filter.subagent || e.subagent_type === filter.subagent) &&
      (!filter.agent || e.agent_id === filter.agent) &&
      test(`${e.agent_id} ${e.event_type} ${summarize(e)}`),
  );
}

export function TerminalReplayDock({ collapsible = true }: { collapsible?: boolean } = {}) {
  const collapsed = useVisualizerStore((s) => collapsible && s.collapsedDocks.log);
  const logs = useVisualizerStore((s) => s.live.logs);
  const cursor = useVisualizerStore((s) => s.replayCursorSeqId);
  const selected = useVisualizerStore((s) => s.selectedTaskId);
  const selectTask = useVisualizerStore((s) => s.selectTask);
  const [severities, setSeverities] = useState<Set<LogSeverity>>(() => new Set(LOG_SEVERITIES));
  const [subagent, setSubagent] = useState("");
  const [agent, setAgent] = useState("");
  const [search, setSearch] = useState("");
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [atBottom, setAtBottom] = useState(true);

  const matcher = useMemo(() => searchMatcher(search), [search]);
  const agents = useMemo(() => [...new Set(logs.map((e) => e.agent_id))].sort(), [logs]);
  const rows = useMemo(
    () => filterLogs(logs, { severities, subagent, agent, search }, matcher.test),
    [logs, severities, subagent, agent, search, matcher],
  );

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_PX,
    overscan: 20,
    initialRect: { width: 800, height: 240 },
  });

  useEffect(() => {
    if (atBottom && cursor === null && rows.length) virtualizer.scrollToIndex(rows.length - 1, { align: "end" });
  }, [rows.length, atBottom, cursor, virtualizer]);

  const toggle = (s: LogSeverity) =>
    setSeverities((prev) => {
      const next = new Set(prev);
      if (next.has(s)) next.delete(s);
      else next.add(s);
      return next;
    });
  const all = severities.size === LOG_SEVERITIES.length;

  return (
    <section className="flex h-full min-h-0 flex-col bg-canvas" aria-label="Terminal and replay log">
      <div className={`flex flex-wrap items-center gap-2 bg-surface px-3 py-1 text-[11px] ${collapsed ? "" : "border-b border-border"}`}>
        <DockToggle dock="log" title="Terminal & Replay Log" controls="telemetry-log" hotkey="L" collapsible={collapsible} />
        <div className="flex gap-0.5" role="group" aria-label="Severity filter">
          <button type="button" aria-pressed={all} className={`rounded border px-1.5 font-mono ${all ? "border-athletic-blue-light text-[#e6edf3]" : "border-border text-cool-grey"}`} onClick={() => setSeverities(new Set(all ? [] : LOG_SEVERITIES))}>
            ALL
          </button>
          {LOG_SEVERITIES.map((s) => (
            <button key={s} type="button" aria-pressed={severities.has(s)} className="rounded border px-1.5 font-mono" style={{ borderColor: severities.has(s) ? SEVERITY_COLOR[s] : "#30363d", color: severities.has(s) ? SEVERITY_COLOR[s] : "#72808a" }} onClick={() => toggle(s)}>
              {s}
            </button>
          ))}
        </div>
        <select aria-label="Filter by subagent" className="rounded border border-border bg-canvas px-1 font-mono text-[#e6edf3]" value={subagent} onChange={(e) => setSubagent(e.target.value)}>
          <option value="">All agents</option>
          {SUBAGENT_TYPES.map((s) => (
            <option key={s} value={s}>
              {SUBAGENT_SHORT[s]}
            </option>
          ))}
        </select>
        <select aria-label="Filter by agent id" className="rounded border border-border bg-canvas px-1 font-mono text-[#e6edf3]" value={agent} onChange={(e) => setAgent(e.target.value)}>
          <option value="">All agent ids</option>
          {agents.map((a) => (
            <option key={a} value={a}>
              {a}
            </option>
          ))}
        </select>
        <label className="flex items-center gap-1">
          <span className="text-cool-grey">Search</span>
          <input
            type="search"
            className={`w-40 rounded border bg-canvas px-1 font-mono text-[#e6edf3] ${matcher.error ? "border-loss" : "border-border"}`}
            placeholder="op_003 or /regex/i"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            aria-invalid={matcher.error !== null}
            aria-describedby={matcher.error ? "search-error" : undefined}
          />
        </label>
        {matcher.error && (
          <span id="search-error" role="alert" className="text-loss">
            Bad regex: {matcher.error}
          </span>
        )}
        <span className="font-mono text-cool-grey">
          {rows.length.toLocaleString("en-US")}/{logs.length.toLocaleString("en-US")}
        </span>
        <div className="ml-auto">
          <TimeTravelScrubber />
        </div>
      </div>
      <div
        ref={scrollRef}
        id="telemetry-log"
        hidden={collapsed}
        className="min-h-0 flex-1 overflow-y-auto font-mono text-[12px]"
        onScroll={(e) => {
          const el = e.currentTarget;
          setAtBottom(el.scrollHeight - el.scrollTop - el.clientHeight < ROW_PX * 2);
        }}
        role="log"
        aria-label="Telemetry log"
      >
        <div style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
          {virtualizer.getVirtualItems().map((item) => {
            const env = rows[item.index];
            const task = taskOf(env);
            const future = cursor !== null && env.seq_id > cursor;
            return (
              <button
                key={env.event_id}
                type="button"
                className={`absolute left-0 flex w-full items-center gap-2 whitespace-nowrap px-3 text-left hover:bg-surface ${task !== null && task === selected ? "bg-surface" : ""}`}
                style={{ top: item.start, height: ROW_PX, opacity: future ? 0.3 : 1 }}
                onClick={() => task && selectTask(task)}
                data-seq={env.seq_id}
              >
                <span className="text-cool-grey">{formatClock(env.timestamp_ms)}</span>
                <span className="w-[76px] shrink-0" style={{ color: SEVERITY_COLOR[env.severity] }}>
                  [{env.severity}]
                </span>
                <span className="w-44 shrink-0 truncate text-warm-grey">[{env.agent_id}]</span>
                <span className="truncate text-[#e6edf3]">{summarize(env)}</span>
              </button>
            );
          })}
        </div>
      </div>
    </section>
  );
}
