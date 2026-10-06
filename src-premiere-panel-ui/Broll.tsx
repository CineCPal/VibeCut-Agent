import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import type { PanelBrollFile, PanelBrollFolder, PanelShot } from "../src/types/brollPanel";
import { Check, Press } from "./Press";
import type { Transport } from "./transport";
import type { PanelView } from "./usePanel";

/**
 * The B-roll Library inside Premiere (PLAN.md, "Phase 5b"), ported from VibeCut's B-roll tab
 * (src-host-panel/src/Broll.tsx, its "Phase 9d/9e"): Spyglass's folders (ticked ones are the search
 * scope, shared with the agent's find_broll), search or browse, shot cards with Pool, Source (Premiere's
 * Source monitor, the shot's range marked; also a double-click on the card), Import (into the "VibeCut
 * B-roll" bin) and Place (at the playhead), and the pool. A card drags into the Project panel or the
 * timeline as the shot's whole file, through CEP's file drag. VibeCut Agent does the reading and the
 * editing; this names shots by key and folders from the app's own list.
 */

/** Pictures read so far, by file name: they never change once written. */
const thumbs = new Map<string, string>();

function Thumb({ transport, name, label }: { transport: Transport; name?: string; label: string }) {
  const [src, setSrc] = useState(() => (name ? (thumbs.get(name) ?? null) : null));
  useEffect(() => {
    if (!name) return setSrc(null);
    const known = thumbs.get(name);
    if (known) return setSrc(known);
    let cancelled = false;
    transport
      .readThumb(name)
      .then((data) => {
        if (!data || cancelled) return;
        thumbs.set(name, data);
        setSrc(data);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [transport, name]);
  return src ? <img className="vc-thumb" src={src} alt={label} draggable={false} /> : <div className="vc-thumb vc-thumb-empty" aria-hidden="true" />;
}

export const seconds = (s: number) => `${Math.floor(s / 60)}:${(s % 60).toFixed(1).padStart(4, "0")}`;

function FolderRow({ folder, view, busy }: { folder: PanelBrollFolder; view: PanelView; busy: boolean }) {
  return (
    <div className="vc-row vc-folder" style={{ paddingLeft: `${4 + folder.depth * 14}px` }}>
      {folder.hasChildren ? (
        <Press className="vc-link vc-twisty" aria-expanded={folder.expanded} aria-label={`${folder.expanded ? "Close" : "Open"} ${folder.name}`} onClick={() => view.act({ type: "broll_expand", path: folder.path })}>
          {folder.expanded ? "▾" : "▸"}
        </Press>
      ) : (
        <span className="vc-twisty" />
      )}
      <Check className="vc-row vc-grow vc-truncate" title={folder.path} checked={folder.checked} disabled={busy} onChange={(checked) => view.act({ type: "broll_scope", path: folder.path, checked })}>
        <span className={folder.online ? "vc-truncate" : "vc-truncate vc-faint"}>
          {folder.name}
          {folder.online ? "" : " (offline)"}
        </span>
      </Check>
      <span className="vc-faint vc-mono">{folder.shotCount}</span>
    </div>
  );
}

interface CardProps {
  shot: PanelShot;
  /** Its file, for the drag (only while it's usable). */
  path?: string;
  transport: Transport;
  view: PanelView;
  /** Why Source and Import are off, or null. */
  canEdit: string | null;
  /** Why Place is off, or null. */
  canPlace: string | null;
  onKeyDown: (e: KeyboardEvent<HTMLDivElement>) => void;
}

function Card({ shot, path, transport, view, canEdit, canPlace, onKeyDown }: CardProps) {
  const usable = shot.status === "ok";
  const why = !usable ? (shot.status === "offline" ? "Its drive isn't attached" : "The file changed since Spyglass indexed it") : canEdit;
  // Dragged out as the shot's whole file, as from Finder's: Premiere takes it into its Project panel or
  // timeline. CEP fills an HTML drag with the file (`com.adobe.cep.dnd.file.0`).
  const draggable = usable && !!path && !!transport.fillDrag;
  return (
    <div
      className={usable ? "vc-card" : "vc-card vc-card-off"}
      tabIndex={0}
      role="group"
      aria-label={`${shot.filename}, ${seconds(shot.start)} to ${seconds(shot.end)}`}
      data-key={shot.key}
      onKeyDown={onKeyDown}
      onDoubleClick={() => usable && !canEdit && !view.pending && view.act({ type: "broll_source", key: shot.key })}
      draggable={draggable}
      title={draggable ? "Drag into the Project panel or the timeline (the whole file). Double-click: Source monitor." : (why ?? undefined)}
      onDragStart={(e) => {
        if (!draggable || !path || !transport.fillDrag || !transport.fillDrag(path, e.dataTransfer)) e.preventDefault();
      }}
    >
      <Thumb transport={transport} name={shot.thumb} label={shot.caption ?? shot.filename} />
      <div className="vc-card-body">
        <p className="vc-truncate" title={shot.filename}>
          {shot.filename}
        </p>
        <p className="vc-faint vc-mono">
          {seconds(shot.start)}–{seconds(shot.end)}
          {shot.technical !== undefined ? ` · Q${shot.technical}` : ""}
          {usable ? "" : ` · ${shot.status}`}
        </p>
        {shot.caption && <p className="vc-card-caption">{shot.caption}</p>}
      </div>
      <div className="vc-row vc-card-actions">
        <Press className="vc-btn" disabled={shot.pooled} aria-label={`Pool ${shot.filename}`} onClick={() => view.act({ type: "broll_pool", op: "add", keys: [shot.key] })}>
          {shot.pooled ? "Pooled" : "Pool"}
        </Press>
        <Press
          className="vc-btn"
          disabled={!!why || !!view.pending}
          title={why ?? "Open it in the Source monitor, its range marked (Space, or double-click the card)"}
          aria-label={`Preview ${shot.filename} in the Source monitor`}
          onClick={() => view.act({ type: "broll_source", key: shot.key })}
        >
          Source
        </Press>
        <Press className="vc-btn" disabled={!!why || !!view.pending} title={why ?? 'Into the "VibeCut B-roll" bin'} aria-label={`Import ${shot.filename}`} onClick={() => view.act({ type: "broll_import", keys: [shot.key] })}>
          Import
        </Press>
        <Press
          className="vc-btn vc-btn-primary"
          disabled={!!why || !!canPlace || !!view.pending}
          title={why ?? canPlace ?? "At the playhead, on a free track, picture only. Revert in VibeCut Agent's chat."}
          aria-label={`Place ${shot.filename}`}
          onClick={() => view.act({ type: "broll_place", key: shot.key })}
        >
          Place
        </Press>
      </div>
    </div>
  );
}

function Pool({ file, transport, view, canEdit, canPlace }: { file: PanelBrollFile; transport: Transport; view: PanelView; canEdit: string | null; canPlace: string | null }) {
  const [open, setOpen] = useState(true);
  if (!file.pool.length) return null;
  const usable = file.pool.filter((s) => s.status === "ok").map((s) => s.key);
  return (
    <div className="vc-pool">
      <div className="vc-row vc-wrap">
        <Press className="vc-log-toggle vc-grow" aria-expanded={open} onClick={() => setOpen(!open)}>
          {open ? "▾" : "▸"} B-roll pool: {file.pool.length}
        </Press>
        <Press className="vc-btn" disabled={!!canEdit || !usable.length || !!view.pending} title={canEdit ?? undefined} onClick={() => view.act({ type: "broll_import", keys: usable })}>
          Import all
        </Press>
        <Press className="vc-btn" onClick={() => view.act({ type: "broll_pool", op: "clear", keys: [] })}>
          Clear
        </Press>
      </div>
      {open && (
        <ul className="vc-pool-list">
          {file.pool.map((s, i) => {
            const path = s.status === "ok" ? file.paths[s.key] : undefined;
            return (
              <li
                key={s.key}
                className="vc-row vc-wrap"
                draggable={!!path && !!transport.fillDrag}
                onDragStart={(e) => {
                  if (!path || !transport.fillDrag || !transport.fillDrag(path, e.dataTransfer)) e.preventDefault();
                }}
              >
                <Thumb transport={transport} name={s.thumb} label={s.caption ?? s.filename} />
                <span className="vc-pool-name vc-truncate" title={s.caption ?? s.filename}>
                  {s.filename} <span className="vc-faint vc-mono">{seconds(s.start)}–{seconds(s.end)}</span>
                </span>
                <Press className="vc-link" disabled={i === 0} aria-label={`Move ${s.filename} up`} onClick={() => view.act({ type: "broll_pool", op: "up", keys: [s.key] })}>
                  ↑
                </Press>
                <Press className="vc-link" disabled={i === file.pool.length - 1} aria-label={`Move ${s.filename} down`} onClick={() => view.act({ type: "broll_pool", op: "down", keys: [s.key] })}>
                  ↓
                </Press>
                <Press className="vc-link" disabled={!!canEdit || !!view.pending} title={canEdit ?? "Open in the Source monitor"} aria-label={`Preview ${s.filename} in the Source monitor`} onClick={() => view.act({ type: "broll_source", key: s.key })}>
                  Source
                </Press>
                <Press className="vc-btn" disabled={!!canPlace || !!view.pending} title={canPlace ?? undefined} aria-label={`Place ${s.filename}`} onClick={() => view.act({ type: "broll_place", key: s.key })}>
                  Place
                </Press>
                <Press className="vc-link" aria-label={`Remove ${s.filename} from the pool`} onClick={() => view.act({ type: "broll_pool", op: "remove", keys: [s.key] })}>
                  ✕
                </Press>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

export function Broll({ file, view, transport }: { file: PanelBrollFile; view: PanelView; transport: Transport }) {
  const [query, setQuery] = useState("");
  const [showFolders, setShowFolders] = useState(false);
  const grid = useRef<HTMLDivElement>(null);
  const canEdit = file.editor.noEditor;
  const canPlace = canEdit ?? file.editor.noPlace;

  if (file.indexMissing) {
    return <p className="vc-muted vc-empty vc-pad">Spyglass has no index on this computer, so there's no B-roll to browse. Choose its index in VibeCut Agent's Settings → B-roll Library.</p>;
  }

  const search = () => view.act({ type: "broll_search", query: query.trim() });
  const onCardKey = (shot: PanelShot) => (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.target !== e.currentTarget) return;
    const usable = shot.status === "ok" && !canEdit && !view.pending;
    if ((e.key === " " || e.key === "Enter") && usable) view.act({ type: "broll_source", key: shot.key });
    else if (e.key === "p" && usable && !canPlace) view.act({ type: "broll_place", key: shot.key });
    else if (e.key === "i" && usable) view.act({ type: "broll_import", keys: [shot.key] });
    else if (e.key === "a" && !shot.pooled) view.act({ type: "broll_pool", op: "add", keys: [shot.key] });
    else if (e.key === "ArrowRight" || e.key === "ArrowLeft" || e.key === "ArrowDown" || e.key === "ArrowUp") {
      const cards = Array.from(grid.current?.querySelectorAll<HTMLElement>(".vc-card") ?? []);
      const at = cards.indexOf(e.currentTarget);
      cards[at + (e.key === "ArrowRight" || e.key === "ArrowDown" ? 1 : -1)]?.focus();
    } else return;
    e.preventDefault();
  };

  const heading =
    file.mode === "agent"
      ? `The agent's search: “${file.query}”`
      : file.mode === "search"
        ? `${file.shots.length} match(es) for “${file.query}” in ${file.scopeLabel}`
        : `${file.total ?? file.shots.length} shot(s) in ${file.scopeLabel}`;

  return (
    <div className="vc-broll">
      <div className="vc-broll-bar">
        <div className="vc-row vc-wrap">
          <Press className="vc-btn" aria-expanded={showFolders} onClick={() => setShowFolders(!showFolders)}>
            {showFolders ? "▾" : "▸"} Folders
          </Press>
          <span className="vc-grow vc-truncate vc-muted" title={file.scopes.join("\n") || "Every watched folder"}>
            Scope: {file.scopeLabel}
          </span>
          {file.scopes.length > 0 && (
            <Press className="vc-link" onClick={() => view.act({ type: "broll_clear_scope" })}>
              Whole archive
            </Press>
          )}
        </div>
        {showFolders && (
          <div className="vc-folders" aria-label="Spyglass folders">
            {file.folders.map((f) => (
              <FolderRow key={f.path} folder={f} view={view} busy={!!file.busy} />
            ))}
          </div>
        )}
        <div className="vc-row vc-broll-search">
          <input
            className="vc-input vc-grow"
            type="search"
            placeholder="Describe a shot, e.g. “hands on a keyboard”"
            aria-label="Search B-roll"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                search();
              }
            }}
          />
          <Press className="vc-btn vc-btn-primary" disabled={!!file.busy} onClick={search}>
            {query.trim() ? "Search" : "Browse"}
          </Press>
        </div>
        <p className="vc-faint" role="status">
          {file.busy ?? heading}
          {canEdit ? ` · Source, Import and Place: ${canEdit}` : canPlace ? ` · Place: ${canPlace}` : ""}
        </p>
        {file.error && <p className="vc-error">{file.error}</p>}
      </div>
      <div className="vc-grid" ref={grid}>
        {file.shots.map((shot) => (
          <Card key={shot.key} shot={shot} path={file.paths[shot.key]} transport={transport} view={view} canEdit={canEdit} canPlace={canPlace} onKeyDown={onCardKey(shot)} />
        ))}
        {!file.busy && file.shots.length === 0 && <p className="vc-muted vc-empty">{file.mode === "browse" ? "No shots in this scope." : "No matches. Try other words, or a wider scope."}</p>}
        {file.hasMore && (
          <Press className="vc-btn vc-more" disabled={!!file.busy} onClick={() => view.act({ type: "broll_more" })}>
            More
          </Press>
        )}
      </div>
      <Pool file={file} transport={transport} view={view} canEdit={canEdit} canPlace={canPlace} />
    </div>
  );
}
