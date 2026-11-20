import { useMemo, useState } from "react";
import { FastForward, Plus, RefreshCw } from "lucide-react";
import { boardHost, boardLabel, seedFromFindings, syncBoardMarkers, type ActionResult, type SeedSource } from "../../lib/kanban/actions";
import { readyWaveFrontier } from "../../lib/kanban/dag";
import { runReadyWave } from "../../lib/kanban/runner";
import { useKanbanStore } from "../../store/useKanbanStore";
import { useNleStateStore } from "../../store/useNleStateStore";
import { KANBAN_COLUMNS, KANBAN_COLUMN_META, type KanbanAssigneeRole, type KanbanCard } from "../../types/kanban";
import { KanbanCardItem } from "./KanbanCardItem";
import { KanbanQuickAdd } from "./KanbanQuickAdd";

const button =
  "flex items-center justify-center gap-1.5 rounded-md bg-athletic-blue px-2.5 py-1.5 text-xs text-white hover:brightness-125 disabled:cursor-not-allowed disabled:opacity-40";
const quiet = "flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1.5 text-xs text-warm-grey hover:text-white disabled:cursor-not-allowed disabled:opacity-40";

/** The filter pills: everyone, or one sub-agent. */
export const ROLE_FILTERS: { role: KanbanAssigneeRole | null; label: string }[] = [
  { role: null, label: "All" },
  { role: "MASTER_ORCHESTRATOR", label: "Supervisor" },
  { role: "INGEST_TRANSCRIBE", label: "Whisper" },
  { role: "VISION_TAGGER", label: "Vision" },
  { role: "BROLL_RETRIEVER", label: "B-Roll" },
  { role: "PACING_CUTTER", label: "Cutter" },
  { role: "AUDIO_ENGINEER", label: "Audio" },
  { role: "COLOR_GRADER", label: "Colour" },
  { role: "HUMAN_EDITOR", label: "You" },
];

const SEEDS: { source: SeedSource; label: string }[] = [
  { source: "review_edit", label: "Edit review" },
  { source: "check_pacing", label: "Pacing check" },
  { source: "client_notes", label: "Timeline markers" },
];

const matches = (card: KanbanCard, role: KanbanAssigneeRole | null, text: string) =>
  (!role || card.assignee.role === role) &&
  (!text || `${card.id} ${card.title} ${card.description} ${card.assignee.label}`.toLowerCase().includes(text.toLowerCase()));

/**
 * The project's Kanban board (PLAN.md "Phase 23", docs/specs/kanban-spec.md §6.1; the Board tab, ⌘4): the
 * cards the agent, the supervising editor, the background bots and the user share, in six columns.
 */
export function KanbanPanel() {
  const { board, loaded, error, scope } = useKanbanStore();
  const setAutoAdvanceWave = useKanbanStore((s) => s.setAutoAdvanceWave);
  // Re-render when the editors change, so the editor buttons follow them.
  const hosts = useNleStateStore((s) => s.hosts);
  const [role, setRole] = useState<KanbanAssigneeRole | null>(null);
  const [text, setText] = useState("");
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<ActionResult | null>(null);

  const frontier = useMemo(() => readyWaveFrontier(board.cards), [board.cards]);
  const host = loaded ? boardHost() : null;
  const timeline = host ? hosts[host].timeline : null;
  const shown = board.cards.filter((c) => matches(c, role, text.trim()));

  const act = async (label: string, action: () => Promise<ActionResult | { started: string[]; message: string }>) => {
    setBusy(label);
    try {
      const result = await action();
      setNotice("ok" in result ? result : { ok: result.started.length > 0, message: result.message });
    } finally {
      setBusy(null);
    }
  };

  if (!loaded) return <p className="px-4 pt-6 text-center text-xs text-cool-grey">Opening the board…</p>;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="space-y-2 border-b border-border px-3 py-2">
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <span className="rounded-full bg-surface px-2 py-0.5 font-medium text-white" title={scope.host === "global" ? "No editor project is open: this board is for planning" : "This editor project's board"}>
            {boardLabel()}
          </span>
          <span className="text-cool-grey">
            {board.cards.length} card{board.cards.length === 1 ? "" : "s"} · {frontier.length} ready to run
          </span>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <button type="button" className={button} disabled={!frontier.length || busy !== null} title="Send every Ready card with nothing to wait on to the agent, most urgent first" onClick={() => void act("wave", runReadyWave)}>
            <FastForward size={13} aria-hidden="true" />
            Run wave ({frontier.length})
          </button>
          <label className="flex items-center gap-1 text-[11px] text-warm-grey" title="When a card finishes, start the next runnable one">
            <input type="checkbox" checked={board.autoAdvanceWave} onChange={(e) => setAutoAdvanceWave(e.target.checked)} className="accent-athletic-blue-light" />
            Auto-wave
          </label>
          <select
            className="rounded-md border border-border bg-canvas px-2 py-1.5 text-xs text-warm-grey disabled:opacity-40"
            aria-label="Seed from QC"
            disabled={!host || !timeline || busy !== null}
            value=""
            onChange={(e) => {
              const source = e.target.value as SeedSource;
              if (source) void act("seed", () => seedFromFindings(source));
            }}
          >
            <option value="">Seed from QC…</option>
            {SEEDS.map((s) => (
              <option key={s.source} value={s.source}>
                {s.label}
              </option>
            ))}
          </select>
          <button type="button" className={quiet} disabled={!host || !timeline || busy !== null} title="Mirror the board on the open timeline's markers, both ways" onClick={() => void act("sync", syncBoardMarkers)}>
            <RefreshCw size={13} aria-hidden="true" className={busy === "sync" ? "animate-spin" : ""} />
            Sync markers
          </button>
          <span className="flex-1" />
          <button type="button" className={quiet} aria-expanded={adding} onClick={() => setAdding(!adding)}>
            <Plus size={13} aria-hidden="true" />
            Add card
          </button>
        </div>

        {adding ? <KanbanQuickAdd onDone={() => setAdding(false)} onResult={setNotice} /> : null}

        <div className="flex flex-wrap items-center gap-1" role="group" aria-label="Filter by sub-agent">
          {ROLE_FILTERS.map((f) => (
            <button
              key={f.label}
              type="button"
              aria-pressed={role === f.role}
              className={`rounded-full px-2 py-0.5 text-[11px] ${role === f.role ? "bg-athletic-blue text-white" : "text-cool-grey hover:text-white"}`}
              onClick={() => setRole(f.role)}
            >
              {f.label}
            </button>
          ))}
          <input
            className="ml-auto w-32 rounded-md border border-border bg-canvas px-2 py-0.5 text-[11px] text-white placeholder:text-cool-grey"
            placeholder="Search cards"
            aria-label="Search cards"
            value={text}
            onChange={(e) => setText(e.target.value)}
          />
        </div>

        {notice ? (
          <p role="status" className={`text-[11px] ${notice.ok ? "text-warm-grey" : "text-loss"}`}>
            {notice.message}
          </p>
        ) : null}
        {error ? (
          <p role="alert" className="text-[11px] text-loss">
            {error}
          </p>
        ) : null}
      </div>

      {board.cards.length === 0 ? (
        <div className="space-y-1 px-4 pt-6 text-center text-xs text-cool-grey">
          <p>This board is empty.</p>
          <p>Ask the agent to plan a multi-step edit ("put this on the board"), seed cards from a QC check, or add one yourself.</p>
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 gap-2 overflow-x-auto px-3 py-3">
          {KANBAN_COLUMNS.map((column) => {
            const cards = shown.filter((c) => c.column === column);
            const meta = KANBAN_COLUMN_META[column];
            return (
              <section key={column} aria-label={meta.label} className="flex w-56 shrink-0 flex-col">
                <h2 className="mb-1.5 flex items-center justify-between text-[11px] font-medium uppercase tracking-wide text-cool-grey" title={meta.hint}>
                  {meta.label}
                  <span className="font-mono">{cards.length}</span>
                </h2>
                <div className="min-h-0 flex-1 space-y-2 overflow-y-auto pb-2">
                  {cards.map((card) => (
                    <KanbanCardItem key={card.id} card={card} all={board.cards} onResult={setNotice} />
                  ))}
                </div>
              </section>
            );
          })}
        </div>
      )}
    </div>
  );
}
