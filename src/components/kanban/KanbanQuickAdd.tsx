import { useState, type FormEvent } from "react";
import { boardHost, playheadSeconds, type ActionResult } from "../../lib/kanban/actions";
import { useKanbanStore } from "../../store/useKanbanStore";
import { KANBAN_CATEGORIES, KANBAN_PRIORITIES, type KanbanCategory, type KanbanPriority } from "../../types/kanban";

const field = "rounded-md border border-border bg-canvas px-2 py-1.5 text-xs text-white placeholder:text-cool-grey";

/** The board's inline "Add card" row: title, category, priority, column, and optionally the playhead. */
export function KanbanQuickAdd({ onDone, onResult }: { onDone: () => void; onResult: (result: ActionResult) => void }) {
  const createCard = useKanbanStore((s) => s.createCard);
  const [title, setTitle] = useState("");
  const [category, setCategory] = useState<KanbanCategory>("cut");
  const [priority, setPriority] = useState<KanbanPriority>("medium");
  const [column, setColumn] = useState<"backlog" | "ready">("ready");
  const [atPlayhead, setAtPlayhead] = useState(false);
  const canUsePlayhead = boardHost() !== null;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!title.trim()) return;
    const start = atPlayhead ? await playheadSeconds() : null;
    try {
      const card = createCard({ title, category, priority, column, startSeconds: start, createdBy: "user" });
      onResult({ ok: true, message: `Added ${card.id} for ${card.assignee.label}` });
      setTitle("");
      onDone();
    } catch (error) {
      onResult({ ok: false, message: error instanceof Error ? error.message : String(error) });
    }
  };

  return (
    <form className="space-y-2 rounded-md border border-border bg-surface p-2" onSubmit={(e) => void submit(e)} aria-label="Add a card">
      <input autoFocus className={`${field} w-full`} placeholder="What needs doing?" aria-label="Card title" value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200} />
      <div className="flex flex-wrap items-center gap-2">
        <select className={field} aria-label="Category" value={category} onChange={(e) => setCategory(e.target.value as KanbanCategory)}>
          {KANBAN_CATEGORIES.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
        <select className={field} aria-label="Priority" value={priority} onChange={(e) => setPriority(e.target.value as KanbanPriority)}>
          {KANBAN_PRIORITIES.map((p) => (
            <option key={p} value={p}>
              {p}
            </option>
          ))}
        </select>
        <select className={field} aria-label="Column" value={column} onChange={(e) => setColumn(e.target.value as "backlog" | "ready")}>
          <option value="ready">Ready</option>
          <option value="backlog">Backlog</option>
        </select>
        <label className={`flex items-center gap-1 text-[11px] ${canUsePlayhead ? "text-warm-grey" : "text-cool-grey opacity-50"}`}>
          <input type="checkbox" disabled={!canUsePlayhead} checked={atPlayhead && canUsePlayhead} onChange={(e) => setAtPlayhead(e.target.checked)} className="accent-athletic-blue-light" />
          At the playhead
        </label>
        <span className="flex-1" />
        <button type="button" className="text-[11px] text-cool-grey hover:text-white" onClick={onDone}>
          Cancel
        </button>
        <button type="submit" disabled={!title.trim()} className="rounded-md bg-athletic-blue px-3 py-1.5 text-xs text-white hover:brightness-125 disabled:cursor-not-allowed disabled:opacity-40">
          Add
        </button>
      </div>
    </form>
  );
}
