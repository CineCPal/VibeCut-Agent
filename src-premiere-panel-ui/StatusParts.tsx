import { useEffect, useRef, useState } from "react";
import type { AgentStatus, AiChoiceId } from "../src/types/agent";
import type { HostPanelStateFile, HostPanelUsage } from "../src/types/hostPanel";
import type { NleConnectionStatus } from "../src/types/nle";
import type { PlanWindow, UsageTotals } from "../src/types/usage";
import { formatCost, formatTokens, percent, resetsIn, windowLevel } from "../src/lib/agent/usage";
import { Press } from "./Press";
import type { HostPanelView } from "./useHostPanel";

/**
 * The window's header and footer, in the panel (0.20.0): each editor's light (NleStatusPill), the usage
 * tracker (UsageMeter: the Claude plan's windows, this chat, today and the week), and the status line
 * (StatusBar: the agent's state, its model and how long the last reply took to start). The arithmetic is
 * the window's own (src/lib/agent/usage.ts, which has no Tauri in it).
 */

const SHORT: Record<string, string> = { premiere: "Pr", resolve: "Re" };
const LONG: Record<string, string> = { premiere: "Premiere Pro", resolve: "DaVinci Resolve" };
const CONNECTION_TEXT: Record<NleConnectionStatus, string> = {
  connected: "Connected",
  connecting: "Connecting",
  disconnected: "Not connected",
  error: "Error",
  unavailable: "Not installed",
};
const CONNECTION_DOT: Record<NleConnectionStatus, string> = {
  connected: "vc-dot-on",
  connecting: "vc-dot-wait",
  disconnected: "vc-dot-off",
  error: "vc-dot-error",
  unavailable: "vc-dot-off",
};

export function EditorLights({ state }: { state: HostPanelStateFile }) {
  return (
    <ul className="vc-lights" aria-label="Editor connections">
      {state.editors.map((e) => {
        const description = `${LONG[e.host] ?? e.host}: ${CONNECTION_TEXT[e.status]}${e.detail ? ` (${e.detail})` : ""}`;
        return (
          <li key={e.host} className="vc-pill" title={description}>
            <span className={`vc-dot ${CONNECTION_DOT[e.status]}`} />
            <span aria-hidden="true">{SHORT[e.host] ?? e.host}</span>
            <span className="vc-sr">{description}</span>
          </li>
        );
      })}
    </ul>
  );
}

// ----------------------------------------------------------------------------- usage

const tokensOf = (t: UsageTotals | undefined | null) => (t ? t.promptTokens + t.outputTokens : 0);

function Meter({ window, status, label }: { window: PlanWindow; status?: string; label: string }) {
  const level = windowLevel(window, status);
  return (
    <div role="meter" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(window.used * 100)} className="vc-meter">
      <div className={`vc-meter-fill vc-level-${level}`} style={{ width: `${Math.min(100, window.used * 100)}%` }} />
    </div>
  );
}

function PlanRow({ name, window, status, now }: { name: string; window: PlanWindow; status?: string; now: number }) {
  const resets = resetsIn(window, now);
  return (
    <div className="vc-usage-plan">
      <div className="vc-row">
        <span className="vc-grow">{name}</span>
        <span className={`vc-level-text-${windowLevel(window, status)}`}>{percent(window.used)} used</span>
      </div>
      <Meter window={window} status={status} label={`${name} used`} />
      {resets ? <p className="vc-faint">Resets {resets}</p> : null}
    </div>
  );
}

function Totals({ usage, totals, caption }: { usage: HostPanelUsage; totals: Partial<Record<AiChoiceId, UsageTotals>>; caption: string }) {
  const rows = usage.labels.filter((l) => totals[l.id]);
  return (
    <table className="vc-usage-table">
      <caption>{caption}</caption>
      <tbody>
        {rows.length ? (
          rows.map((l) => {
            const t = totals[l.id] as UsageTotals;
            return (
              <tr key={l.id}>
                <th scope="row">{l.label}</th>
                <td className="vc-mono">{formatTokens(t.promptTokens + t.outputTokens)}</td>
                <td className="vc-mono" title={l.subscription ? "What it would have cost on the API; your plan covers it" : undefined}>
                  {l.subscription && t.costUsd !== null ? `≈${formatCost(t.costUsd)}` : formatCost(t.costUsd)}
                </td>
              </tr>
            );
          })
        ) : (
          <tr>
            <td className="vc-faint">Nothing yet</td>
          </tr>
        )}
      </tbody>
    </table>
  );
}

/** The usage pill, opening to the plan's windows and the tokens used, with Refresh. */
export function UsageMeter({ state, view }: { state: HostPanelStateFile; view: HostPanelView }) {
  const { usage } = state;
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!open) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    const onPointer = (event: MouseEvent) => {
      if (root.current && !root.current.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onPointer);
    return () => {
      clearInterval(timer);
      document.removeEventListener("mousedown", onPointer);
    };
  }, [open]);

  const plan = usage.plan;
  const five = plan?.fiveHour;
  const weekly = plan?.weekly;
  const shown = five ?? weekly;
  const level = windowLevel(five && weekly ? (five.used >= weekly.used ? five : weekly) : shown, plan?.status);
  const todayTokens = Object.values(usage.today).reduce((sum, t) => sum + tokensOf(t), 0);
  const summary = five
    ? `Claude plan: ${percent(five.used)} of the 5-hour limit${weekly ? `, ${percent(weekly.used)} of the week` : ""}`
    : weekly
      ? `Claude plan: ${percent(weekly.used)} of the week`
      : `Today: ${formatTokens(todayTokens)} tokens`;

  return (
    <div
      ref={root}
      className="vc-usage"
      onKeyDown={(event) => {
        if (event.key === "Escape" && open) {
          event.stopPropagation();
          setOpen(false);
        }
      }}
    >
      <Press className="vc-pill vc-pill-button" aria-expanded={open} aria-label="Usage" title={`${summary} (click for details)`} onClick={() => setOpen(!open)}>
        <span className={`vc-level-text-${level}`} aria-hidden="true">
          ◔
        </span>
        {shown ? (
          <>
            <span className="vc-pill-meter" aria-hidden="true">
              <span className={`vc-meter-fill vc-level-${level}`} style={{ width: `${Math.min(100, shown.used * 100)}%` }} />
            </span>
            <span className={`vc-level-text-${level}`} aria-hidden="true">
              {percent(shown.used)}
            </span>
          </>
        ) : (
          <span aria-hidden="true">{formatTokens(todayTokens)}</span>
        )}
      </Press>
      {open && (
        <div className="vc-pop" role="dialog" aria-label="Usage">
          {five || weekly ? (
            <>
              {five && <PlanRow name="5-hour limit" window={five} status={plan?.status} now={now} />}
              {weekly && <PlanRow name="This week" window={weekly} status={plan?.status} now={now} />}
              {plan?.weeklyOverage && <PlanRow name="Extra usage" window={plan.weeklyOverage} now={now} />}
            </>
          ) : (
            <p className="vc-faint">No Claude plan report yet: it comes with a Claude (subscription) turn, or from Refresh.</p>
          )}
          <div className="vc-row">
            <span className="vc-grow vc-faint">{usage.planAt ? `Plan checked ${Math.max(0, Math.round((now - usage.planAt) / 60_000))} min ago` : ""}</span>
            <Press className="vc-btn" onClick={() => view.act({ type: "usage_refresh" })} title="Ask Claude Code for the plan's usage now (no model call)">
              Refresh
            </Press>
          </div>
          <p className="vc-usage-chat">
            This chat: <span className="vc-mono">{formatTokens(tokensOf(usage.chat))}</span> tokens
            {usage.chat ? ` in ${usage.chat.turns} turn${usage.chat.turns === 1 ? "" : "s"}` : ""}
          </p>
          <Totals usage={usage} totals={usage.today} caption="Today" />
          <Totals usage={usage} totals={usage.week} caption="Last 7 days" />
        </div>
      )}
    </div>
  );
}

// ----------------------------------------------------------------------------- footer

const STATUS_TEXT: Record<AgentStatus, string> = { offline: "Offline", idle: "Ready", thinking: "Working", stopping: "Stopping", error: "Error" };
const STATUS_DOT: Record<AgentStatus, string> = { offline: "vc-dot-off", idle: "vc-dot-on", thinking: "vc-dot-wait", stopping: "vc-dot-wait", error: "vc-dot-error" };

/** The window's bottom line: the agent's state and model, with the last reply's timing on hover. */
export function StatusBar({ state }: { state: HostPanelStateFile }) {
  const { agent } = state;
  const model = agent.choices.find((c) => c.id === agent.aiChoice)?.label ?? agent.aiChoice;
  return (
    <footer className="vc-footer" aria-label="Agent status">
      <span className={`vc-dot ${STATUS_DOT[agent.status]}`} />
      <span role="status" title={agent.lastReply ? `Last reply: ${agent.lastReply}` : undefined}>
        {STATUS_TEXT[agent.status]}
      </span>
      <span className="vc-faint">·</span>
      <span className="vc-grow vc-truncate vc-mono vc-muted" title="The agent's model">
        {model}
      </span>
      {agent.lastReply && <span className="vc-faint vc-truncate vc-footer-timing">{agent.lastReply.split(" · ")[0]}</span>}
    </footer>
  );
}
