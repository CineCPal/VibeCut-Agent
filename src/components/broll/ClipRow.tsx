import { useState } from "react";
import { FolderSearch, ListPlus } from "lucide-react";
import { placeAtPlayhead } from "../../lib/broll";
import { revealInFinder } from "../../lib/ipc";
import { clock } from "../../lib/agent/args";

interface ClipRowProps {
  path: string;
  filename: string;
  /** 0–100. */
  score: number;
  start: number;
  end: number;
  duration: number;
  chips?: (string | null)[];
  note?: string | null;
  /** Why clips can't be placed right now, or null when they can. */
  placeBlocked?: string | null;
}

export function ClipRow({ path, filename, score, start, end, duration, chips = [], note, placeBlocked = null }: ClipRowProps) {
  const shown = chips.filter((c): c is string => Boolean(c));
  const [placing, setPlacing] = useState(false);
  const [placed, setPlaced] = useState<{ text: string; failed: boolean } | null>(null);

  const place = async () => {
    setPlacing(true);
    setPlaced(null);
    try {
      setPlaced({ text: await placeAtPlayhead({ path, filename, start, end }), failed: false });
    } catch (error) {
      setPlaced({ text: error instanceof Error ? error.message : String(error), failed: true });
    } finally {
      setPlacing(false);
    }
  };
  return (
    <li className="flex items-start gap-2.5 py-2">
      <span
        className="mt-0.5 w-9 shrink-0 rounded bg-athletic-blue px-1 py-0.5 text-center font-mono text-[11px] text-white"
        title="Score out of 100"
      >
        {Math.round(score)}
      </span>
      <div className="min-w-0 flex-1">
        <p className="truncate text-xs text-white" title={path}>
          {filename}
        </p>
        <p className="font-mono text-[11px] text-cool-grey">
          best {clock(start)}–{clock(end)} of {clock(duration)}
          {shown.length ? ` · ${shown.join(" · ")}` : ""}
        </p>
        {note ? <p className="text-[11px] text-warning">{note}</p> : null}
        {placed ? (
          <p role={placed.failed ? "alert" : "status"} className={`text-[11px] ${placed.failed ? "text-loss" : "text-profit"}`}>
            {placed.text}
          </p>
        ) : null}
      </div>
      <button
        type="button"
        onClick={() => void place()}
        disabled={placing || placeBlocked !== null}
        aria-label={`Place ${filename} at the playhead`}
        title={placeBlocked ?? "Place its best stretch at the playhead (revertible)"}
        className="rounded p-1 text-cool-grey hover:text-athletic-blue-light disabled:opacity-40"
      >
        <ListPlus size={14} aria-hidden="true" />
      </button>
      <button
        type="button"
        onClick={() => void revealInFinder(path)}
        aria-label={`Show ${filename} in Finder`}
        title="Show in Finder"
        className="rounded p-1 text-cool-grey hover:text-athletic-blue-light"
      >
        <FolderSearch size={14} aria-hidden="true" />
      </button>
    </li>
  );
}
