/**
 * "About This App" (AGENTS.md §7; visualizer-spec.md §6 Phase 4). It shows:
 * - the app's name, version and purpose;
 * - the gateway it's connected to, and its health;
 * - whether Premiere and Resolve are connected;
 * - the hardware backends in use;
 * - the local sub-agent models;
 * - where traces are stored;
 * - the network status. The visualizer talks only to the local gateway and calls no external API.
 *
 * Escape and the Close button close it, and focus returns to what opened it.
 */
import { useEffect, useRef, type ReactNode } from "react";
import pkg from "../../../package.json";
import { SUBAGENT_SHORT } from "../../lib/studio/bays";
import { nleConnected, selectView, useVisualizerStore } from "../../store/useVisualizerStore";
import type { RuntimeHostAdapter } from "../../lib/host/runtimeHostAdapter";

export const APP_VERSION: string = pkg.version;

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[9rem_1fr] gap-2 border-b border-border py-1.5 last:border-b-0">
      <dt className="text-cool-grey">{label}</dt>
      <dd className="min-w-0 break-words font-mono text-[#e6edf3]">{children}</dd>
    </div>
  );
}

function workerLine(value: unknown): string {
  if (!value || typeof value !== "object") return String(value ?? "–");
  return Object.values(value as Record<string, unknown>).filter(Boolean).join(" · ");
}

export function AboutVisualizerModal({ adapter }: { adapter: RuntimeHostAdapter }) {
  const open = useVisualizerStore((s) => s.aboutOpen);
  const setOpen = useVisualizerStore((s) => s.setAboutOpen);
  const health = useVisualizerStore((s) => s.hostHealth);
  const connection = useVisualizerStore((s) => s.connection);
  const view = useVisualizerStore(selectView);
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const closeRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement as HTMLElement | null;
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
      if (e.key === "Tab" && dialogRef.current) {
        const focusable = dialogRef.current.querySelectorAll<HTMLElement>("button, a[href], [tabindex]:not([tabindex='-1'])");
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last?.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first?.focus();
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      previous?.focus?.();
    };
  }, [open, setOpen]);

  if (!open) return null;
  const heartbeat = view.heartbeat;
  const nle = nleConnected(health, heartbeat);
  const backends = [...new Set(Object.values(view.nodes).map((n) => n.hardware_backend))];
  const workers = health?.workers ?? {};
  const gatewayOk = health?.status === "ok";

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={() => setOpen(false)}>
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="about-title"
        className="max-h-full w-full max-w-xl overflow-y-auto rounded-md border border-border bg-surface p-4 text-xs shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 id="about-title" className="text-sm font-semibold text-[#e6edf3]">
          About VibeCut Agent Telemetry Studio
        </h2>
        <p className="mt-1 text-warm-grey">
          A live window on VibeCut Agent's orchestrator and local sub-agents: the virtual studio, the execution DAG, OTIO
          deltas as they are proposed, validated and committed, and a replayable log. It only watches; it never edits.
        </p>
        <dl className="mt-3">
          <Row label="Version">{APP_VERSION} (vibecut.visualizer.spec.v1, vibecut.telemetry.v1)</Row>
          <Row label="Host mode">{adapter.mode}{adapter.source === "mock" ? " · built-in mock run" : ""}</Row>
          <Row label="Gateway">
            <span className={gatewayOk ? "text-profit" : "text-loss"}>{gatewayOk ? "Connected" : adapter.source === "mock" ? "Not used (mock)" : "Not reachable"}</span>
            {health ? ` · v${health.version} · ${health.connected_clients} viewer${health.connected_clients === 1 ? "" : "s"}` : ""}
            <br />
            WebSocket {connection.status}: {adapter.wsUrl}
          </Row>
          <Row label="NLE">
            Premiere: {nle ? (nle.premiere ? "connected" : "not connected") : "unknown"} · Resolve:{" "}
            {nle ? (nle.resolve ? "connected" : "not connected") : "unknown"}
          </Row>
          <Row label="Hardware">{backends.length ? backends.join(", ") : "No tasks yet"} {heartbeat ? `· ${heartbeat.unified_memory_total_gb} GB unified memory` : ""}</Row>
          <Row label="Local models">
            {Object.keys(workers).length ? (
              <ul>
                {Object.entries(workers).map(([name, value]) => (
                  <li key={name}>
                    {name}: {workerLine(value)}
                  </li>
                ))}
              </ul>
            ) : (
              "Reported by the gateway when connected"
            )}
          </Row>
          <Row label="Trace storage">{health?.telemetry_dir ?? "<appDataDir>/telemetry/<trace_id>.jsonl"}</Row>
          <Row label="Network">Local only: the gateway on {adapter.httpBase}. No external APIs, no keys.</Row>
          <Row label="Agents">{Object.values(SUBAGENT_SHORT).join(" · ")}</Row>
          <Row label="Keys">1/2/3 views · F fit DAG · , . step replay · Esc deselect · ? About</Row>
        </dl>
        <div className="mt-3 flex justify-end">
          <button ref={closeRef} type="button" className="rounded border border-athletic-blue-light px-3 py-1 text-[#e6edf3] hover:bg-athletic-blue" onClick={() => setOpen(false)}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
