import { useState } from "react";
import { ArrowLeft, ArrowRight, AtSign, Check, ChevronDown, ChevronRight, Play, RotateCcw, X } from "lucide-react";
import { answerCardReview, chatAboutCard, jumpToCard, moveCard, revertableEdits, revertCard, type ActionResult } from "../../lib/kanban/actions";
import { unresolvedBlockers } from "../../lib/kanban/dag";
import { runKanbanCard } from "../../lib/kanban/runner";
import { formatDuration } from "../../store/useSidecarStore";
import { useKanbanStore } from "../../store/useKanbanStore";
import { KANBAN_COLUMNS, type KanbanCard, type KanbanColumnId, type KanbanPriority } from "../../types/kanban";

/** The card's left edge, by column (AGENTS.md §3 tokens). */
export const COLUMN_ACCENT: Record<KanbanColumnId, string> = {
  backlog: "border-l-cool-grey",
  ready: "border-l-athletic-blue-light",
  in_progress: "border-l-warning",
  review: "border-l-warning",
  done: "border-l-profit",
  blocked: "border-l-loss",
};

const PRIORITY_STYLE: Record<KanbanPriority, string> = {
  critical: "bg-loss/20 text-loss",
  high: "bg-warning/20 text-warning",
  medium: "bg-border text-warm-grey",
  low: "bg-border text-cool-grey",
};

/** "0:42", "1:15.5", "1:02:03": a timeline position as editors read it. */
export function timeLabel(seconds: number): string {
  const whole = Math.floor(seconds);
  const tenths = Math.round((seconds - whole) * 10);
  const h = Math.floor(whole / 3600);
  const m = Math.floor((whole % 3600) / 60);
  const s = String(whole % 60).padStart(2, "0");
  const base = h ? `${h}:${String(m).padStart(2, "0")}:${s}` : `${m}:${s}`;
  return tenths && tenths < 10 ? `${base}.${tenths}` : base;
}

const iconButton = "rounded p-1 text-cool-grey hover:bg-border hover:text-white disabled:cursor-not-allowed disabled:opacity-30";
const RUNNABLE: ReadonlySet<KanbanColumnId> = new Set(["backlog", "ready", "blocked"]);

/** One card on the board (docs/specs/kanban-spec.md §6.1). `onResult` shows what a button did. */
export function KanbanCardItem({ card, all, onResult }: { card: KanbanCard; all: readonly KanbanCard[]; onResult: (result: ActionResult) => void }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const toggleCheck = useKanbanStore((s) => s.toggleChecklistItem);
  const deleteCards = useKanbanStore((s) => s.deleteCards);
  const ctx = card.timelineContext;
  const exec = card.execution;
  const waiting = unresolvedBlockers(card, all);
  const doneChecks = card.checklist.filter((i) => i.done).length;
  const column = KANBAN_COLUMNS.indexOf(card.column);
  const revertable = card.column === "done" ? revertableEdits(card) : [];
  const run = async (action: () => Promise<ActionResult> | ActionResult) => {
    setBusy(true);
    try {
      onResult(await action());
    } finally {
      setBusy(false);
    }
  };

  return (
    <article
      aria-label={`${card.id} ${card.title}`}
      className={`space-y-1.5 rounded-md border border-l-2 border-border bg-surface p-2.5 text-xs ${COLUMN_ACCENT[card.column]}`}
    >
      <header className="flex flex-wrap items-center gap-1.5">
        <span className="font-mono text-[11px] text-warm-grey">{card.id}</span>
        {card.priority === "critical" || card.priority === "high" ? (
          <span className={`rounded px-1.5 py-px text-[10px] font-medium uppercase ${PRIORITY_STYLE[card.priority]}`}>{card.priority}</span>
        ) : null}
        <span className="rounded bg-athletic-blue px-1.5 py-px text-[10px] text-white" title={`${card.assignee.role} · ${card.assignee.stationKey}`}>
          {card.assignee.label}
        </span>
        <span className="text-[10px] text-cool-grey">{card.category}</span>
      </header>

      <button type="button" className="flex w-full items-start gap-1 text-left font-medium text-white" aria-expanded={open} onClick={() => setOpen(!open)}>
        {card.description || card.checklist.length ? (
          open ? <ChevronDown size={12} className="mt-0.5 shrink-0" aria-hidden="true" /> : <ChevronRight size={12} className="mt-0.5 shrink-0" aria-hidden="true" />
        ) : null}
        <span>{card.title}</span>
      </button>

      {open && card.description ? <p className="whitespace-pre-wrap text-warm-grey">{card.description}</p> : null}

      {card.checklist.length ? (
        open ? (
          <ul className="space-y-0.5">
            {card.checklist.map((item) => (
              <li key={item.id}>
                <label className="flex items-start gap-1.5 text-warm-grey">
                  <input type="checkbox" checked={item.done} onChange={() => toggleCheck(card.id, item.id)} className="mt-0.5 accent-athletic-blue-light" />
                  <span className={item.done ? "line-through opacity-60" : ""}>{item.text}</span>
                </label>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-[11px] text-cool-grey">
            Checklist {doneChecks}/{card.checklist.length}
          </p>
        )
      ) : null}

      <div className="flex flex-wrap items-center gap-1.5">
        {ctx.startSeconds !== null ? (
          <button
            type="button"
            className="font-mono text-[11px] text-athletic-blue-light hover:underline"
            title={`Move the playhead here${ctx.timeline ? ` on "${ctx.timeline}"` : ""}`}
            onClick={() => void run(() => jumpToCard(card.id))}
          >
            {timeLabel(ctx.startSeconds)}
            {ctx.endSeconds !== null ? `–${timeLabel(ctx.endSeconds)}` : ""}
          </button>
        ) : null}
        {card.blockedBy.map((id) => {
          const pending = waiting.some((w) => w.id === id);
          return (
            <span key={id} className={`rounded px-1 text-[10px] ${pending ? "bg-warning/15 text-warning" : "bg-profit/15 text-profit"}`}>
              {pending ? `Waiting on ${id}` : `✓ ${id}`}
            </span>
          );
        })}
      </div>

      {exec.progress ? (
        <div className="space-y-0.5" aria-label={`${card.id} progress`}>
          <div className="h-1 overflow-hidden rounded bg-border" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={exec.progress.fraction === null ? undefined : Math.round(exec.progress.fraction * 100)}>
            <div className={`h-full bg-warning ${exec.progress.fraction === null ? "w-1/3 animate-pulse" : ""}`} style={exec.progress.fraction === null ? undefined : { width: `${Math.round(exec.progress.fraction * 100)}%` }} />
          </div>
          <p className="flex justify-between gap-2 font-mono text-[10px] text-cool-grey">
            <span className="truncate">{exec.progress.phase ?? "Working…"}</span>
            <span>
              {exec.progress.fraction !== null ? `${Math.round(exec.progress.fraction * 100)}%` : ""}
              {exec.progress.etaSeconds !== null ? ` · ${formatDuration(exec.progress.etaSeconds)} left` : ""}
            </span>
          </p>
        </div>
      ) : null}

      {card.column === "blocked" && exec.blockedReason ? <p className="text-[11px] text-loss">{exec.blockedReason}</p> : null}
      {exec.editLogIds.length ? <p className="font-mono text-[10px] text-cool-grey">Edits {exec.editLogIds.join(", ")}</p> : null}

      <footer className="flex flex-wrap items-center gap-1 pt-0.5">
        {card.column === "review" && exec.reviewCardId ? (
          <>
            <button type="button" disabled={busy} className="rounded bg-profit/20 px-2 py-0.5 text-profit hover:bg-profit/30" onClick={() => void run(() => answerCardReview(card.id, "apply"))}>
              <Check size={12} className="mr-0.5 inline" aria-hidden="true" />
              Apply
            </button>
            <button type="button" disabled={busy} className="rounded bg-loss/20 px-2 py-0.5 text-loss hover:bg-loss/30" onClick={() => void run(() => answerCardReview(card.id, "skip"))}>
              Skip
            </button>
          </>
        ) : null}
        {RUNNABLE.has(card.column) ? (
          <button
            type="button"
            disabled={busy || waiting.length > 0}
            className="flex items-center gap-1 rounded bg-athletic-blue px-2 py-0.5 text-white hover:brightness-125 disabled:cursor-not-allowed disabled:opacity-40"
            title={waiting.length ? `Waiting on ${waiting.map((w) => w.id).join(", ")}` : `Send ${card.id} to the agent`}
            onClick={() => void run(() => runKanbanCard(card.id))}
          >
            <Play size={11} aria-hidden="true" />
            Run
          </button>
        ) : null}
        {revertable.length ? (
          <button type="button" disabled={busy} className="flex items-center gap-1 rounded px-2 py-0.5 text-warm-grey hover:bg-border" title={`Revert ${revertable.join(", ")}`} onClick={() => void run(() => revertCard(card.id))}>
            <RotateCcw size={11} aria-hidden="true" />
            Revert
          </button>
        ) : null}
        <span className="flex-1" />
        <button type="button" className={iconButton} aria-label={`Chat about ${card.id}`} title={`Mention @${card.id} in the chat`} onClick={() => onResult(chatAboutCard(card.id))}>
          <AtSign size={12} aria-hidden="true" />
        </button>
        <button type="button" className={iconButton} aria-label={`Move ${card.id} left`} disabled={column === 0} onClick={() => onResult(moveCard(card.id, -1))}>
          <ArrowLeft size={12} aria-hidden="true" />
        </button>
        <button type="button" className={iconButton} aria-label={`Move ${card.id} right`} disabled={column === KANBAN_COLUMNS.length - 1} onClick={() => onResult(moveCard(card.id, 1))}>
          <ArrowRight size={12} aria-hidden="true" />
        </button>
        <button
          type="button"
          className={`${iconButton} hover:text-loss`}
          aria-label={`Delete ${card.id}`}
          onClick={() => {
            deleteCards([card.id]);
            onResult({ ok: true, message: `Deleted ${card.id}` });
          }}
        >
          <X size={12} aria-hidden="true" />
        </button>
      </footer>
    </article>
  );
}
