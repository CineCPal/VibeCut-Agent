/** Settings → Saved prompts (Phase 8h): the messages typed as `/name` in the chat's composer. */
import { useState } from "react";
import { Pencil, Plus, RotateCcw, Trash2 } from "lucide-react";
import { MAX_BODY_CHARS, usePromptStore, type SavedPrompt } from "../../store/usePromptStore";
import { Section } from "../common/Section";

const fieldClass = "w-full rounded-md border border-border bg-canvas px-2 py-1.5 text-xs text-white";
const smallButton = "flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-cool-grey hover:text-athletic-blue-light focus-visible:text-athletic-blue-light";

function PromptForm({ initial, onSave, onCancel }: { initial: { name: string; body: string }; onSave: (name: string, body: string) => string | null; onCancel: () => void }) {
  const [name, setName] = useState(initial.name);
  const [body, setBody] = useState(initial.body);
  const [problem, setProblem] = useState<string | null>(null);
  const save = () => setProblem(onSave(name.trim().replace(/^\//, "").toLowerCase(), body));
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        save();
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          onCancel();
        }
      }}
      className="flex flex-col gap-1.5 rounded-md border border-border p-2"
    >
      <label className="text-[11px] text-cool-grey">
        Name (typed after /)
        <input value={name} onChange={(e) => setName(e.target.value)} autoFocus className={`${fieldClass} mt-0.5 font-mono`} placeholder="rough-cut" />
      </label>
      <label className="text-[11px] text-cool-grey">
        Message ({"{{…}}"} is selected when it&rsquo;s used, to type over)
        <textarea value={body} onChange={(e) => setBody(e.target.value)} rows={4} maxLength={MAX_BODY_CHARS} className={`${fieldClass} mt-0.5 resize-y`} />
      </label>
      {problem ? (
        <p role="alert" className="text-[11px] text-warning">
          {problem}
        </p>
      ) : null}
      <div className="flex justify-end gap-1">
        <button type="button" onClick={onCancel} className="rounded px-2 py-1 text-xs text-cool-grey hover:text-white">
          Cancel
        </button>
        <button type="submit" className="rounded bg-athletic-blue px-2 py-1 text-xs text-white hover:bg-athletic-blue/80">
          Save
        </button>
      </div>
    </form>
  );
}

function PromptRow({ prompt, onEdit }: { prompt: SavedPrompt; onEdit: () => void }) {
  const remove = usePromptStore((s) => s.remove);
  const [confirming, setConfirming] = useState(false);
  return (
    <li className="flex items-start gap-2 py-1">
      <div className="min-w-0 flex-1">
        <span className="font-mono text-xs text-athletic-blue-light">/{prompt.name}</span>
        <p className="truncate text-[11px] text-cool-grey" title={prompt.body}>
          {prompt.body}
        </p>
      </div>
      <button type="button" onClick={onEdit} aria-label={`Edit /${prompt.name}`} className={smallButton}>
        <Pencil size={11} aria-hidden="true" />
      </button>
      <button
        type="button"
        onClick={() => (confirming ? remove(prompt.id) : setConfirming(true))}
        onBlur={() => setConfirming(false)}
        aria-label={confirming ? `Press again to delete /${prompt.name}` : `Delete /${prompt.name}`}
        className={`${smallButton} ${confirming ? "text-loss hover:text-loss" : ""}`}
      >
        <Trash2 size={11} aria-hidden="true" />
        {confirming ? "Delete?" : null}
      </button>
    </li>
  );
}

export function PromptsSection() {
  const prompts = usePromptStore((s) => s.prompts);
  const add = usePromptStore((s) => s.add);
  const update = usePromptStore((s) => s.update);
  const restoreStarters = usePromptStore((s) => s.restoreStarters);
  // The prompt being edited, "new" for one being added, or null.
  const [editing, setEditing] = useState<string | null>(null);

  const done = (problem: string | null) => {
    if (!problem) setEditing(null);
    return problem;
  };

  return (
    <Section
      title="Saved prompts"
      action={
        <span className="flex items-center gap-1">
          <button type="button" onClick={restoreStarters} title="Put back any of the starter prompts you deleted" className={smallButton}>
            <RotateCcw size={11} aria-hidden="true" />
            Restore starters
          </button>
          <button type="button" onClick={() => setEditing("new")} disabled={editing === "new"} className={`${smallButton} disabled:opacity-40`}>
            <Plus size={11} aria-hidden="true" />
            New
          </button>
        </span>
      }
    >
      <p className="mb-1 text-[11px] text-cool-grey">Type / in the chat&rsquo;s message box to use one. They&rsquo;re kept on this Mac only.</p>
      {editing === "new" ? <PromptForm initial={{ name: "", body: "" }} onSave={(name, body) => done(add(name, body))} onCancel={() => setEditing(null)} /> : null}
      {prompts.length === 0 && editing !== "new" ? <p className="text-xs text-cool-grey">No saved prompts.</p> : null}
      <ul className="divide-y divide-border/60">
        {prompts.map((prompt) =>
          editing === prompt.id ? (
            <li key={prompt.id} className="py-1">
              <PromptForm initial={prompt} onSave={(name, body) => done(update(prompt.id, name, body))} onCancel={() => setEditing(null)} />
            </li>
          ) : (
            <PromptRow key={prompt.id} prompt={prompt} onEdit={() => setEditing(prompt.id)} />
          ),
        )}
      </ul>
    </Section>
  );
}
