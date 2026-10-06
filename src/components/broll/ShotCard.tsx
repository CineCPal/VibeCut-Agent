import type { KeyboardEvent } from "react";
import { changePool, dragShot, importShots, placeShot, previewShot, unusable } from "../../lib/library";
import { keyframeUrl } from "../../lib/spyglassIpc";
import type { LibraryShot } from "../../store/useLibraryStore";

export const span = (s: number): string => `${Math.floor(s / 60)}:${(s % 60).toFixed(1).padStart(4, "0")}`;

const action =
  "rounded border border-border px-1.5 py-0.5 text-[11px] text-white hover:border-athletic-blue-light disabled:cursor-not-allowed disabled:opacity-40";

export function Keyframe({ shot, className = "h-[54px] w-24" }: { shot: LibraryShot; className?: string }) {
  return shot.keyframe ? (
    <img src={keyframeUrl(shot.keyframe)} alt={shot.caption ?? shot.filename} loading="lazy" draggable={false} className={`${className} shrink-0 rounded bg-canvas object-cover`} />
  ) : (
    <div aria-hidden="true" className={`${className} shrink-0 rounded bg-canvas`} />
  );
}

export interface ShotCardProps {
  shot: LibraryShot;
  pooled: boolean;
  pending: boolean;
  /** Why Source and Import are off (no editor connected), or null. */
  noEditor: string | null;
  /** Why Place is off (no editor or no open timeline), or null. */
  noPlace: string | null;
}

/**
 * One shot, ported from VibeCut's B-roll panel card: its keyframe (double-click to preview it in the
 * editor's source viewer), what Spyglass saw, and Pool / Source / Import / Place. The card drags out as
 * the shot's whole file, into the editor's project or timeline. Keys: Space/Enter Source, P Place,
 * I Import, A Pool, arrows move between cards.
 */
export function ShotCard({ shot, pooled, pending, noEditor, noPlace }: ShotCardProps) {
  const why = unusable(shot);
  const canSource = !why && !noEditor && !pending;
  const canPlace = !why && !noPlace && !pending;

  const onKeyDown = (e: KeyboardEvent<HTMLLIElement>) => {
    if (e.target !== e.currentTarget) return;
    const key = e.key.toLowerCase();
    if ((key === " " || key === "enter") && canSource) void previewShot(shot.key);
    else if (key === "p" && canPlace) void placeShot(shot.key);
    else if (key === "i" && canSource) void importShots([shot.key]);
    else if (key === "a" && !pooled) changePool("add", [shot.key]);
    else if (["arrowdown", "arrowup", "arrowright", "arrowleft"].includes(key)) {
      const cards = Array.from(e.currentTarget.parentElement?.querySelectorAll<HTMLElement>("[data-shot]") ?? []);
      const at = cards.indexOf(e.currentTarget);
      cards[at + (key === "arrowdown" || key === "arrowright" ? 1 : -1)]?.focus();
    } else return;
    e.preventDefault();
  };

  return (
    <li
      data-shot={shot.key}
      tabIndex={0}
      aria-label={`${shot.filename}, ${span(shot.start)} to ${span(shot.end)}`}
      // Offline shots stay draggable so a drag says which drive to attach instead of doing nothing.
      draggable={shot.shotId !== null}
      title={why ?? "Drag into the Project panel, Media Pool or timeline (the whole file)"}
      onDragStart={(e) => {
        // The webview's own drag can't leave the window; Rust starts a real file drag instead.
        e.preventDefault();
        void dragShot(shot);
      }}
      onKeyDown={onKeyDown}
      className={`flex gap-2.5 rounded-md py-2 pl-1 pr-1 ${why ? "opacity-60" : "cursor-grab active:cursor-grabbing"}`}
    >
      {/* Not a <button>: WebKit won't start the card's drag from a form control, and the thumbnail is
          where a shot gets grabbed. Space/Enter on the card is the keyboard way to preview. */}
      <div
        className="shrink-0 rounded"
        data-preview={shot.key}
        title={why ?? noEditor ?? "Double-click to preview in the Source monitor, In and Out marked. Drag into the editor."}
        onDoubleClick={() => !pending && void previewShot(shot.key)}
      >
        <Keyframe shot={shot} />
      </div>
      <div className="min-w-0 flex-1">
        <p className="truncate text-xs text-white" title={shot.path}>
          {shot.filename}
        </p>
        <p className="font-mono text-[11px] text-cool-grey">
          {span(shot.start)}–{span(shot.end)}
          {shot.technical !== null ? ` · Q${Math.round(shot.technical)}` : ""}
          {shot.energy !== null ? ` · E${Math.round(shot.energy)}` : ""}
          {why ? ` · ${shot.status}` : ""}
        </p>
        {shot.caption ? <p className="line-clamp-2 text-[11px] text-warm-grey">{shot.caption}</p> : null}
        <div className="mt-1 flex flex-wrap gap-1">
          <button type="button" className={action} disabled={pooled} aria-label={`Pool ${shot.filename}`} onClick={() => changePool("add", [shot.key])}>
            {pooled ? "Pooled" : "Pool"}
          </button>
          <button
            type="button"
            className={action}
            disabled={!canSource}
            title={why ?? noEditor ?? "Open it in the Source monitor, its range marked (Space)"}
            aria-label={`Preview ${shot.filename} in the Source monitor`}
            onClick={() => void previewShot(shot.key)}
          >
            Source
          </button>
          <button
            type="button"
            className={action}
            disabled={!canSource}
            title={why ?? noEditor ?? 'Into the "VibeCut B-roll" bin (I). Not undone by Revert.'}
            aria-label={`Import ${shot.filename}`}
            onClick={() => void importShots([shot.key])}
          >
            Import
          </button>
          <button
            type="button"
            className={`${action} bg-athletic-blue`}
            disabled={!canPlace}
            title={why ?? noPlace ?? "At the playhead, on a free track, picture only (P). Revertible."}
            aria-label={`Place ${shot.filename}`}
            onClick={() => void placeShot(shot.key)}
          >
            Place
          </button>
        </div>
      </div>
    </li>
  );
}
