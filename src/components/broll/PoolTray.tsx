import { useState } from "react";
import { ArrowDown, ArrowUp, ChevronDown, ChevronRight, X } from "lucide-react";
import { changePool, importShots, placeShot, previewShot, unusable } from "../../lib/library";
import { useLibraryStore } from "../../store/useLibraryStore";
import { Keyframe, span } from "./ShotCard";

const link = "rounded p-0.5 text-cool-grey hover:text-white disabled:opacity-30";
const small = "rounded border border-border px-1.5 py-0.5 text-[11px] text-white hover:border-athletic-blue-light disabled:opacity-40";

/** Shots set aside to review or use later (VibeCut's B-roll pool), remembered between runs. */
export function PoolTray({ noEditor, noPlace }: { noEditor: string | null; noPlace: string | null }) {
  const pool = useLibraryStore((s) => s.pool);
  const pending = useLibraryStore((s) => s.pending);
  const [open, setOpen] = useState(true);
  if (!pool.length) return null;
  const usable = pool.filter((s) => !unusable(s)).map((s) => s.key);
  return (
    <section aria-label="B-roll pool" className="shrink-0 border-t border-border bg-surface px-3 py-2">
      <div className="flex items-center gap-2">
        <button type="button" className="flex flex-1 items-center gap-1 text-left text-xs text-white" aria-expanded={open} onClick={() => setOpen(!open)}>
          {open ? <ChevronDown size={12} aria-hidden="true" /> : <ChevronRight size={12} aria-hidden="true" />}
          B-roll pool: {pool.length}
        </button>
        <button type="button" className={small} disabled={!!noEditor || !usable.length || pending.length > 0} title={noEditor ?? undefined} onClick={() => void importShots(usable)}>
          Import all
        </button>
        <button type="button" className={small} onClick={() => changePool("clear", [])}>
          Clear
        </button>
      </div>
      {open ? (
        <ul className="mt-1.5 max-h-40 space-y-1 overflow-y-auto">
          {pool.map((s, i) => {
            const why = unusable(s);
            return (
              <li key={s.key} className="flex items-center gap-2">
                <Keyframe shot={s} className="h-6 w-11" />
                <span className="min-w-0 flex-1 truncate text-[11px] text-white" title={s.caption ?? s.path}>
                  {s.filename} <span className="font-mono text-cool-grey">{span(s.start)}–{span(s.end)}</span>
                </span>
                <button type="button" className={link} disabled={i === 0} aria-label={`Move ${s.filename} up`} onClick={() => changePool("up", [s.key])}>
                  <ArrowUp size={12} aria-hidden="true" />
                </button>
                <button type="button" className={link} disabled={i === pool.length - 1} aria-label={`Move ${s.filename} down`} onClick={() => changePool("down", [s.key])}>
                  <ArrowDown size={12} aria-hidden="true" />
                </button>
                <button
                  type="button"
                  className={small}
                  disabled={!!why || !!noEditor || pending.includes(s.key)}
                  title={why ?? noEditor ?? "Open in the Source monitor"}
                  aria-label={`Preview ${s.filename} in the Source monitor`}
                  onClick={() => void previewShot(s.key)}
                >
                  Source
                </button>
                <button
                  type="button"
                  className={small}
                  disabled={!!why || !!noPlace || pending.includes(s.key)}
                  title={why ?? noPlace ?? undefined}
                  aria-label={`Place ${s.filename}`}
                  onClick={() => void placeShot(s.key)}
                >
                  Place
                </button>
                <button type="button" className={link} aria-label={`Remove ${s.filename} from the pool`} onClick={() => changePool("remove", [s.key])}>
                  <X size={12} aria-hidden="true" />
                </button>
              </li>
            );
          })}
        </ul>
      ) : null}
    </section>
  );
}
