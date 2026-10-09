/**
 * The project's notes (Phase 13c; ⌘⇧N): what the agent remembers about the editor project open now,
 * in plain Markdown the user can edit. Saved on Save (⌘S) and on close; every chat on the project sees
 * them at the top of its snapshot.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { Modal } from "../common/Modal";
import { loadNotes, MAX_NOTES_BYTES, saveNotes } from "../../lib/projectNotes";
import { selectActiveHost, useNleStateStore } from "../../store/useNleStateStore";
import { NLE_LABELS } from "../../types/nle";

const PLACEHOLDER = `## Brief
- 60 s brand film for the bakery's Instagram, due Friday

## People
- Dana Ruiz is the owner (the woman in the blue apron)

## Style
- Warm and unhurried; no whip pans`;

export function ProjectNotesModal({ onClose }: { onClose: () => void }) {
  const host = useNleStateStore(selectActiveHost);
  const project = useNleStateStore((s) => (host ? s.hosts[host].project : null));
  const [text, setText] = useState<string | null>(null);
  const [saved, setSaved] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const textRef = useRef<string | null>(null);
  textRef.current = text;

  useEffect(() => {
    if (!host || !project) return;
    let live = true;
    loadNotes(host, project)
      .then((t) => {
        if (!live) return;
        setText(t);
        setSaved(t);
      })
      .catch((e: unknown) => live && setProblem(e instanceof Error ? e.message : String(e)));
    return () => {
      live = false;
    };
  }, [host, project]);

  const save = useCallback(async (): Promise<boolean> => {
    const now = textRef.current;
    if (!host || !project || now === null || now === saved) return true;
    try {
      await saveNotes(host, project, now);
      setSaved(now);
      setProblem(null);
      return true;
    } catch (e) {
      setProblem(e instanceof Error ? e.message : String(e));
      return false;
    }
  }, [host, project, saved]);

  const close = useCallback(() => {
    void save().then((ok) => ok && onClose());
  }, [save, onClose]);

  const bytes = text === null ? 0 : new TextEncoder().encode(text).length;
  const over = bytes > MAX_NOTES_BYTES;

  return (
    <Modal title="Project notes" onClose={close}>
      {!host || !project ? (
        <p className="text-sm text-cool-grey">Open a project in Premiere Pro or DaVinci Resolve to see and edit its notes.</p>
      ) : (
        <div className="flex flex-col gap-2">
          <p className="text-xs text-cool-grey">
            {`What the agent remembers about "${project}" in ${NLE_LABELS[host]}, in every chat on this project. It adds lines when you tell it lasting facts; edit them freely.`}
          </p>
          <textarea
            aria-label={`Notes for ${project}`}
            value={text ?? ""}
            disabled={text === null}
            placeholder={PLACEHOLDER}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
                e.preventDefault();
                void save();
              }
            }}
            rows={14}
            className="w-full resize-y rounded border border-border bg-canvas p-2 font-mono text-[12px] text-white placeholder:text-cool-grey/60 focus:outline focus:outline-athletic-blue-light"
          />
          <div className="flex items-center justify-between gap-2 text-[11px]">
            <span role="status" className={problem || over ? "text-loss" : "text-cool-grey"}>
              {problem ?? (over ? `Too long: ${Math.ceil(bytes / 1024)} of ${MAX_NOTES_BYTES / 1024} KB` : text !== null && text !== saved ? "Not saved yet" : "Saved")}
            </span>
            <button
              type="button"
              onClick={() => void save()}
              disabled={text === null || text === saved || over}
              className="rounded bg-athletic-blue px-2.5 py-1 text-white hover:bg-athletic-blue/80 disabled:opacity-40"
              title="Save (⌘S)"
            >
              Save
            </button>
          </div>
        </div>
      )}
    </Modal>
  );
}
