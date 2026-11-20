import { useState } from "react";
import { KANBAN_CATEGORIES, KANBAN_COLUMNS, KANBAN_COLUMN_META, KANBAN_PRIORITIES, type KanbanCard, type KanbanCategory, type KanbanColumnId, type KanbanPriority } from "../src/types/kanban";
import type { HostKanbanFile, HostKanbanSeed } from "../src/types/hostPanel";
import { Check, Press } from "./Press";
import type { HostPanelView } from "./useHostPanel";

/**
 * The Board tab of the "VibeCut Agent" panel (0.20.8, PLAN.md "Phase 23"): the editor project's Kanban
 * board, as the window's Board tab (components/kanban/). Filter by column, run a card or the wave of
 * cards that can run now, seed cards from a QC check, mirror the board on the timeline's markers, and
 * add a card. The app owns the board; this shows `kanban.json` and sends actions.
 */

type Filter = "all" | Exclude<KanbanColumnId, "backlog">;

const FILTERS: { id: Filter; label: string }[] = [
  { id: "all", label: "All" },
  { id: "ready", label: "Ready" },
  { id: "in_progress", label: "Active" },
  { id: "review", label: "Review" },
  { id: "blocked", label: "Blocked" },
  { id: "done", label: "Done" },
];

const SEEDS: { id: HostKanbanSeed; label: string }[] = [
  { id: "review", label: "Edit review" },
  { id: "pacing", label: "Pacing check" },
  { id: "markers", label: "Timeline markers" },
];

const clock = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
const RUNNABLE: ReadonlySet<KanbanColumnId> = new Set(["backlog", "ready", "blocked"]);

function CardRow({ card, all, view }: { card: KanbanCard; all: readonly KanbanCard[]; view: HostPanelView }) {
  const [open, setOpen] = useState(false);
  const ctx = card.timelineContext;
  const waiting = card.blockedBy.filter((id) => all.some((c) => c.id === id && c.column !== "done"));
  const progress = card.execution.progress;
  const pct = progress?.fraction === null || progress?.fraction === undefined ? null : Math.round(progress.fraction * 100);
  const at = KANBAN_COLUMNS.indexOf(card.column);
  const move = (step: -1 | 1) => view.act({ type: "kanban_move", cardId: card.id, column: KANBAN_COLUMNS[at + step] });
  return (
    <li className={`vc-kanban-card vc-kanban-${card.column}`} aria-label={`${card.id} ${card.title}`}>
      <div className="vc-row">
        <span className="vc-mono vc-faint">{card.id}</span>
        {card.priority === "critical" || card.priority === "high" ? <span className={card.priority === "critical" ? "vc-kanban-tag vc-error" : "vc-kanban-tag vc-warn"}>{card.priority}</span> : null}
        <span className="vc-chip" title={`${card.assignee.role} · ${card.assignee.stationKey}`}>
          {card.assignee.label}
        </span>
        <span className="vc-grow" />
        <span className="vc-faint">{KANBAN_COLUMN_META[card.column].shortLabel}</span>
      </div>
      <Press className="vc-kanban-title" aria-expanded={open} onClick={() => setOpen(!open)}>
        {card.title}
      </Press>
      {open && card.description ? <p className="vc-muted vc-wrap">{card.description}</p> : null}
      {open && card.checklist.length ? (
        <ul className="vc-list">
          {card.checklist.map((item) => (
            <li key={item.id}>
              <Check checked={item.done} className="vc-check" onChange={() => view.act({ type: "kanban_toggle_check", cardId: card.id, checkId: item.id })}>
                <span className={item.done ? "vc-struck" : ""}>{item.text}</span>
              </Check>
            </li>
          ))}
        </ul>
      ) : null}
      <div className="vc-row vc-wrap">
        {ctx.startSeconds !== null ? (
          <Press className="vc-link vc-mono" title="Move the playhead here" onClick={() => view.act({ type: "set_playhead", seconds: ctx.startSeconds ?? 0 })}>
            {clock(ctx.startSeconds)}
            {ctx.endSeconds !== null ? `–${clock(ctx.endSeconds)}` : ""}
          </Press>
        ) : null}
        {waiting.length ? <span className="vc-warn">Waiting on {waiting.join(", ")}</span> : null}
        {card.column === "blocked" && card.execution.blockedReason ? <span className="vc-error">{card.execution.blockedReason}</span> : null}
      </div>
      {progress ? (
        <div className="vc-job">
          <div role="progressbar" aria-label={`${card.id} progress`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct ?? undefined} className="vc-meter">
            <div className={pct === null ? "vc-meter-fill vc-level-warn vc-meter-busy" : "vc-meter-fill vc-level-warn"} style={pct === null ? undefined : { width: `${pct}%` }} />
          </div>
          <div className="vc-row vc-mono vc-faint">
            <span className="vc-grow vc-truncate">{progress.phase ?? "Working…"}</span>
            <span>{pct === null ? "" : `${pct}%`}</span>
          </div>
        </div>
      ) : null}
      <div className="vc-row">
        {card.column === "review" && card.execution.reviewCardId ? (
          <>
            <Press className="vc-btn vc-kanban-apply" onClick={() => view.act({ type: "kanban_review", cardId: card.id, decision: "apply" })}>
              Apply
            </Press>
            <Press className="vc-btn vc-kanban-skip" onClick={() => view.act({ type: "kanban_review", cardId: card.id, decision: "skip" })}>
              Skip
            </Press>
          </>
        ) : null}
        {RUNNABLE.has(card.column) ? (
          <Press className="vc-btn vc-btn-primary" disabled={waiting.length > 0 || !!view.pending} title={waiting.length ? `Waiting on ${waiting.join(", ")}` : `Send ${card.id} to the agent`} onClick={() => view.act({ type: "kanban_run", cardId: card.id })}>
            ▶ Run
          </Press>
        ) : null}
        <span className="vc-grow" />
        <Press className="vc-link" aria-label={`Move ${card.id} left`} disabled={at === 0} onClick={() => move(-1)}>
          ←
        </Press>
        <Press className="vc-link" aria-label={`Move ${card.id} right`} disabled={at === KANBAN_COLUMNS.length - 1} onClick={() => move(1)}>
          →
        </Press>
        <Press className="vc-link" aria-label={`Delete ${card.id}`} onClick={() => view.act({ type: "kanban_delete", cardId: card.id })}>
          ✕
        </Press>
      </div>
    </li>
  );
}

function QuickAdd({ view, onDone }: { view: HostPanelView; onDone: () => void }) {
  const [title, setTitle] = useState("");
  const [category, setCategory] = useState<KanbanCategory>("cut");
  const [priority, setPriority] = useState<KanbanPriority>("medium");
  const [column, setColumn] = useState<"backlog" | "ready">("ready");
  const add = () => {
    if (!title.trim()) return;
    view.act({ type: "kanban_create", title: title.trim(), category, priority, column });
    setTitle("");
    onDone();
  };
  return (
    <div className="vc-box-section" aria-label="Add a card">
      <input className="vc-input vc-full" value={title} maxLength={200} placeholder="What needs doing?" aria-label="Card title" onChange={(e) => setTitle(e.target.value)} onKeyDown={(e) => e.key === "Enter" && add()} />
      <div className="vc-row">
        <select className="vc-select" aria-label="Category" value={category} onChange={(e) => setCategory(e.target.value as KanbanCategory)}>
          {KANBAN_CATEGORIES.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
        <select className="vc-select" aria-label="Priority" value={priority} onChange={(e) => setPriority(e.target.value as KanbanPriority)}>
          {KANBAN_PRIORITIES.map((p) => (
            <option key={p} value={p}>
              {p}
            </option>
          ))}
        </select>
        <select className="vc-select" aria-label="Column" value={column} onChange={(e) => setColumn(e.target.value as "backlog" | "ready")}>
          <option value="ready">Ready</option>
          <option value="backlog">Backlog</option>
        </select>
        <span className="vc-grow" />
        <Press className="vc-btn vc-btn-primary" disabled={!title.trim()} onClick={add}>
          Add
        </Press>
      </div>
    </div>
  );
}

export function BoardTab({ file, view }: { file: HostKanbanFile | null; view: HostPanelView }) {
  const [filter, setFilter] = useState<Filter>("all");
  const [adding, setAdding] = useState(false);
  if (!file) return <p className="vc-muted vc-empty vc-pad">Loading the board…</p>;
  if (file.unavailable) return <p className="vc-muted vc-empty vc-pad">{file.unavailable}</p>;
  const shown = filter === "all" ? file.cards : file.cards.filter((c) => c.column === filter);
  const busy = !!view.pending;
  return (
    <div className="vc-kanban">
      <div className="vc-box-section">
        <div className="vc-row vc-wrap">
          <Press className="vc-btn vc-btn-primary" disabled={!file.executableIds.length || busy} title="Send every Ready card with nothing to wait on to the agent" onClick={() => view.act({ type: "kanban_run_wave" })}>
            ▶▶ Run wave ({file.executableIds.length})
          </Press>
          <Check className="vc-check" checked={file.autoAdvanceWave} title="When a card finishes, start the next runnable one" onChange={() => view.act({ type: "kanban_toggle_auto_wave" })}>
            Auto-wave
          </Check>
          <span className="vc-grow" />
          <Press className="vc-btn" aria-expanded={adding} onClick={() => setAdding(!adding)}>
            + Add
          </Press>
        </div>
        <div className="vc-row vc-wrap">
          <select
            className="vc-select"
            aria-label="Seed from QC"
            disabled={!!file.editorBlocked || busy}
            title={file.editorBlocked ?? "Add cards for what a check finds"}
            value=""
            onChange={(e) => e.target.value && view.act({ type: "kanban_seed_qc", source: e.target.value as HostKanbanSeed })}
          >
            <option value="">Seed from QC…</option>
            {SEEDS.map((s) => (
              <option key={s.id} value={s.id}>
                {s.label}
              </option>
            ))}
          </select>
          <Press className="vc-btn" disabled={!!file.editorBlocked || busy} title={file.editorBlocked ?? "Mirror the board on the timeline's markers, both ways"} onClick={() => view.act({ type: "kanban_sync_markers" })}>
            Sync markers
          </Press>
          {file.cards.some((c) => c.column === "done") ? (
            <Press className="vc-link" onClick={() => view.act({ type: "kanban_clear_done" })}>
              Clear done
            </Press>
          ) : null}
        </div>
        {adding ? <QuickAdd view={view} onDone={() => setAdding(false)} /> : null}
      </div>
      <div className="vc-tabs" role="group" aria-label="Filter by column">
        {FILTERS.map((f) => {
          const n = f.id === "all" ? file.cards.length : file.cards.filter((c) => c.column === f.id).length;
          return (
            <Press key={f.id} aria-pressed={filter === f.id} className={filter === f.id ? "vc-tab vc-tab-on" : "vc-tab"} onClick={() => setFilter(f.id)}>
              {f.label} {n}
            </Press>
          );
        })}
      </div>
      {shown.length ? (
        <ul className="vc-kanban-list">
          {shown.map((card) => (
            <CardRow key={card.id} card={card} all={file.cards} view={view} />
          ))}
        </ul>
      ) : (
        <p className="vc-muted vc-empty vc-pad">{file.cards.length ? "No cards here." : "This project's board is empty. Ask the agent to plan an edit, or seed cards from a QC check."}</p>
      )}
    </div>
  );
}
