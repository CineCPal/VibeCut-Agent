import { useState } from "react";
import { FolderSearch, ListPlus, Play } from "lucide-react";
import { placeAtPlayhead } from "../../lib/broll";
import { revealInFinder } from "../../lib/ipc";
import { clock } from "../../lib/agent/args";

export interface RowSegment {
  start: number;
  end: number;
  /** 0–100, when the analyzer scored it. */
  score?: number;
}

interface ClipRowProps {
  path: string;
  filename: string;
  /** 0–100. */
  score: number;
  /** The clip's best stretch (what Place puts in when no segment is being previewed). */
  start: number;
  end: number;
  duration: number;
  /** Every segment the analyzer picked; shown as chips when there's more than the best one, or ticks are on. */
  segments?: RowSegment[];
  /** The segment indices left out of the selects, or undefined when this list has no selects (search hits). */
  excluded?: number[];
  onToggleSegment?: (index: number) => void;
  /** Plays a segment in the preview. */
  onPreview?: (index: number) => void;
  /** The segment being previewed, when it's one of this clip's. */
  previewing?: number | null;
  /** False dims the row: the selection (top N, minimum score) leaves it out. */
  inSelection?: boolean;
  chips?: (string | null)[];
  note?: string | null;
  /** Why clips can't be placed right now, or null when they can. */
  placeBlocked?: string | null;
}

export function ClipRow({
  path,
  filename,
  score,
  start,
  end,
  duration,
  segments,
  excluded,
  onToggleSegment,
  onPreview,
  previewing = null,
  inSelection = true,
  chips = [],
  note,
  placeBlocked = null,
}: ClipRowProps) {
  const shown = chips.filter((c): c is string => Boolean(c));
  const [placing, setPlacing] = useState(false);
  const [placed, setPlaced] = useState<{ text: string; failed: boolean } | null>(null);
  const segs = segments?.length ? segments : [{ start, end }];
  const showChips = excluded !== undefined || segs.length > 1;
  // Place puts in the segment being previewed, else the best one.
  const target = previewing !== null && segs[previewing] ? segs[previewing] : { start, end };

  const place = async () => {
    setPlacing(true);
    setPlaced(null);
    try {
      setPlaced({ text: await placeAtPlayhead({ path, filename, start: target.start, end: target.end }), failed: false });
    } catch (error) {
      setPlaced({ text: error instanceof Error ? error.message : String(error), failed: true });
    } finally {
      setPlacing(false);
    }
  };
  return (
    <li className={`flex items-start gap-2.5 py-2 ${inSelection ? "" : "opacity-50"}`}>
      <span
        className="mt-0.5 w-9 shrink-0 rounded bg-athletic-blue px-1 py-0.5 text-center font-mono text-[11px] text-white"
        title={inSelection ? "Score out of 100" : "Score out of 100. Left out of the selects by the Include setting."}
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
        {showChips ? (
          <ul aria-label={`Segments of ${filename}`} className="mt-1 flex flex-wrap gap-1">
            {segs.map((s, i) => {
              const ticked = !(excluded ?? []).includes(i);
              const label = `${clock(s.start)}–${clock(s.end)}`;
              return (
                <li
                  key={`${s.start}-${s.end}`}
                  className={`flex items-center rounded border font-mono text-[11px] ${
                    previewing === i ? "border-athletic-blue-light bg-athletic-blue/30 text-white" : "border-border text-cool-grey"
                  } ${ticked ? "" : "opacity-60"}`}
                >
                  {excluded !== undefined && onToggleSegment ? (
                    <input
                      type="checkbox"
                      className="ml-1 accent-athletic-blue-light"
                      checked={ticked}
                      onChange={() => onToggleSegment(i)}
                      aria-label={`Include ${filename} ${label} in the selects`}
                    />
                  ) : null}
                  <button
                    type="button"
                    onClick={() => onPreview?.(i)}
                    disabled={!onPreview}
                    aria-label={`Preview ${filename} ${label}`}
                    title="Preview this segment"
                    className="flex items-center gap-1 px-1.5 py-0.5 hover:text-athletic-blue-light"
                  >
                    <Play size={10} aria-hidden="true" />
                    {label}
                    {s.score !== undefined && segs.length > 1 ? <span className="text-cool-grey">· {Math.round(s.score)}</span> : null}
                  </button>
                </li>
              );
            })}
          </ul>
        ) : null}
        {note ? <p className="text-[11px] text-warning">{note}</p> : null}
        {placed ? (
          <p role={placed.failed ? "alert" : "status"} className={`text-[11px] ${placed.failed ? "text-loss" : "text-profit"}`}>
            {placed.text}
          </p>
        ) : null}
      </div>
      {onPreview && !showChips ? (
        <button
          type="button"
          onClick={() => onPreview(0)}
          aria-label={`Preview ${filename}`}
          title="Preview its best stretch"
          className="rounded p-1 text-cool-grey hover:text-athletic-blue-light"
        >
          <Play size={14} aria-hidden="true" />
        </button>
      ) : null}
      <button
        type="button"
        onClick={() => void place()}
        disabled={placing || placeBlocked !== null}
        aria-label={`Place ${filename} at the playhead`}
        title={placeBlocked ?? (previewing !== null ? "Place the segment being previewed at the playhead (revertible)" : "Place its best stretch at the playhead (revertible)")}
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
