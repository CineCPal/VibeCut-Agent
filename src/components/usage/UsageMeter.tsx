import { useEffect, useId, useRef, useState } from "react";
import { Gauge, RefreshCw } from "lucide-react";
import { useNow } from "../../hooks/useNow";
import { refreshPlan } from "../../lib/agent/planRefresh";
import { formatCost, formatTokens, percent, resetsIn, windowLevel } from "../../lib/agent/usage";
import { useAgentStore } from "../../store/useAgentStore";
import { recentTotals, useUsageStore } from "../../store/useUsageStore";
import { useSystemStore } from "../../store/useSystemStore";
import { AI_CHOICES, claudeCodeUsable } from "../../types/agent";
import type { DayTotals, PlanWindow, UsageTotals } from "../../types/usage";

const LEVEL_BAR = { ok: "bg-athletic-blue-light", warn: "bg-warning", full: "bg-loss" } as const;
const LEVEL_TEXT = { ok: "text-white", warn: "text-warning", full: "text-loss" } as const;

function Bar({ window, status, label }: { window: PlanWindow; status?: string; label: string }) {
  const level = windowLevel(window, status);
  return (
    <div
      role="meter"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(window.used * 100)}
      className="h-1.5 w-full overflow-hidden rounded-full bg-border"
    >
      <div className={`h-full ${LEVEL_BAR[level]}`} style={{ width: `${Math.min(100, window.used * 100)}%` }} />
    </div>
  );
}

function PlanRow({ name, window, status, now }: { name: string; window: PlanWindow; status?: string; now: number }) {
  const resets = resetsIn(window, now);
  return (
    <div className="space-y-1">
      <div className="flex items-baseline justify-between text-xs">
        <span className="text-white">{name}</span>
        <span className={LEVEL_TEXT[windowLevel(window, status)]}>{percent(window.used)} used</span>
      </div>
      <Bar window={window} status={status} label={`${name} used`} />
      {resets ? <p className="text-[11px] text-cool-grey">Resets {resets}</p> : null}
    </div>
  );
}

function TotalsTable({ totals, caption }: { totals: DayTotals; caption: string }) {
  const rows = AI_CHOICES.filter((c) => totals[c.id]).map((c) => ({ choice: c, t: totals[c.id] as UsageTotals }));
  return (
    <table className="w-full text-[11px]">
      <caption className="pb-1 text-left text-[11px] font-semibold uppercase tracking-wide text-cool-grey">{caption}</caption>
      <tbody>
        {rows.length === 0 ? (
          <tr>
            <td className="text-cool-grey">Nothing yet</td>
          </tr>
        ) : (
          rows.map(({ choice, t }) => (
            <tr key={choice.id}>
              <th scope="row" className="py-0.5 pr-2 text-left font-normal text-white">
                {choice.label}
              </th>
              <td className="py-0.5 text-right font-mono text-warm-grey" title={`${t.promptTokens.toLocaleString()} in (${t.cachedTokens.toLocaleString()} cached), ${t.outputTokens.toLocaleString()} out`}>
                {formatTokens(t.promptTokens + t.outputTokens)}
              </td>
              <td className="py-0.5 pl-2 text-right font-mono text-warm-grey" title={choice.provider === "claude-code" ? "What it would have cost on the API; your plan covers it" : undefined}>
                {choice.provider === "claude-code" && t.costUsd !== null ? `≈${formatCost(t.costUsd)}` : formatCost(t.costUsd)}
              </td>
            </tr>
          ))
        )}
      </tbody>
    </table>
  );
}

/**
 * The usage tracker (Phase 9b): a pill with the Claude plan's 5-hour window (or today's tokens when
 * there's no plan report), and, unless `compact`, a popover with both plan windows, this chat, today
 * and the last 7 days.
 */
export function UsageMeter({ compact = false }: { compact?: boolean }) {
  const plan = useUsageStore((s) => s.plan);
  const planAt = useUsageStore((s) => s.planAt);
  const days = useUsageStore((s) => s.days);
  const chatId = useAgentStore((s) => s.chatId);
  const chatTotals = useUsageStore((s) => s.chats[chatId]);
  const claudeCode = useSystemStore((s) => s.claudeCode);
  const [open, setOpen] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const panelId = useId();
  const now = useNow(open, 30_000);

  useEffect(() => {
    if (!open) return;
    const onPointer = (event: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onPointer);
    return () => document.removeEventListener("mousedown", onPointer);
  }, [open]);

  const today = recentTotals(days, 1);
  const todayTokens = Object.values(today).reduce((sum, t) => sum + (t ? t.promptTokens + t.outputTokens : 0), 0);
  const five = plan?.fiveHour;
  const weekly = plan?.weekly;
  const level = windowLevel(five && weekly ? (five.used >= weekly.used ? five : weekly) : (five ?? weekly), plan?.status);
  const summary = five
    ? `Claude plan: ${percent(five.used)} of the 5-hour limit${weekly ? `, ${percent(weekly.used)} of the week` : ""}`
    : weekly
      ? `Claude plan: ${percent(weekly.used)} of the week`
      : `Today: ${formatTokens(todayTokens)} tokens`;

  const refresh = () => {
    setRefreshing(true);
    setError(null);
    void refreshPlan().then((problem) => {
      setRefreshing(false);
      setError(problem);
    });
  };

  const pill = (
    <>
      <Gauge size={13} aria-hidden="true" className={LEVEL_TEXT[level]} />
      {five || weekly ? (
        <>
          <span className="relative h-1.5 w-8 overflow-hidden rounded-full bg-border" aria-hidden="true">
            <span className={`absolute inset-y-0 left-0 ${LEVEL_BAR[level]}`} style={{ width: `${Math.min(100, (five ?? weekly)!.used * 100)}%` }} />
          </span>
          <span aria-hidden="true" className={LEVEL_TEXT[level]}>
            {percent((five ?? weekly)!.used)}
          </span>
        </>
      ) : (
        <span aria-hidden="true">{formatTokens(todayTokens)}</span>
      )}
      <span className="sr-only">{summary}</span>
    </>
  );
  const pillClass = "flex items-center gap-1 rounded-full border border-border px-2 py-0.5 font-mono text-[11px] text-warm-grey";

  if (compact) {
    return (
      <span className={pillClass} title={summary}>
        {pill}
      </span>
    );
  }

  return (
    <div
      ref={rootRef}
      className="relative"
      onKeyDown={(event) => {
        if (event.key !== "Escape" || !open) return;
        event.stopPropagation();
        setOpen(false);
      }}
    >
      <button
        type="button"
        className={`${pillClass} hover:border-athletic-blue-light`}
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-controls={panelId}
        title={`${summary} (click for details)`}
      >
        {pill}
      </button>
      {open ? (
        // Placed against the window, not the pill: the pill sits partway along the header, and a 380 px
        // window has no room for the popover on either side of it.
        <div
          id={panelId}
          role="dialog"
          aria-label="Usage"
          className="fixed inset-x-3 top-12 z-20 mx-auto max-w-sm space-y-3 rounded-md border border-border bg-surface p-3 shadow-lg"
        >
          <section className="space-y-2" aria-label="Claude plan">
            <div className="flex items-center justify-between">
              <h2 className="text-[11px] font-semibold uppercase tracking-wide text-cool-grey">Claude plan</h2>
              {claudeCodeUsable(claudeCode) ? (
                <button type="button" onClick={refresh} disabled={refreshing} className="flex items-center gap-1 rounded px-1 text-[11px] text-cool-grey hover:text-athletic-blue-light disabled:opacity-50">
                  <RefreshCw size={11} aria-hidden="true" className={refreshing ? "animate-spin" : ""} />
                  Refresh
                </button>
              ) : null}
            </div>
            {five ? <PlanRow name="5-hour limit" window={five} status={plan?.status} now={now} /> : null}
            {weekly ? <PlanRow name="Weekly limit" window={weekly} status={plan?.status} now={now} /> : null}
            {!five && !weekly ? (
              <p className="text-[11px] text-cool-grey">
                {claudeCodeUsable(claudeCode) ? "No report yet. Refresh, or chat on a (subscription) model." : "Set up Claude Code (Settings → Claude subscription) to see your plan's limits."}
              </p>
            ) : null}
            {plan?.status === "rejected" ? <p className="text-[11px] text-loss">At a limit: subscription turns wait until it resets.</p> : null}
            {error ? <p className="text-[11px] text-loss">{error}</p> : null}
            {planAt ? <p className="text-[11px] text-cool-grey">As of {new Date(planAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}</p> : null}
          </section>
          <section className="space-y-1 border-t border-border pt-2" aria-label="This chat">
            <h2 className="text-[11px] font-semibold uppercase tracking-wide text-cool-grey">This chat</h2>
            <p className="font-mono text-[11px] text-warm-grey">
              {chatTotals ? `${formatTokens(chatTotals.promptTokens + chatTotals.outputTokens)} tokens · ${chatTotals.turns} turn${chatTotals.turns === 1 ? "" : "s"} · ${formatCost(chatTotals.costUsd)}` : "Nothing yet"}
            </p>
          </section>
          <div className="space-y-2 border-t border-border pt-2">
            <TotalsTable totals={today} caption="Today" />
            <TotalsTable totals={recentTotals(days, 7)} caption="Last 7 days" />
            <p className="text-[11px] text-cool-grey">Costs are estimates at API rates. Subscription turns (≈) are covered by your plan; Gemini&rsquo;s isn&rsquo;t estimated.</p>
          </div>
        </div>
      ) : null}
    </div>
  );
}
