import { useEffect, useState } from "react";
import { ChevronDown, ChevronRight, Search } from "lucide-react";
import { browseMore, clearScope, connectedHost, missingDrives, NO_EDITOR, openLibrary, placeBlocked, scopeLabel, searchLibrary } from "../../lib/library";
import { useLibraryStore } from "../../store/useLibraryStore";
import { useNleStateStore } from "../../store/useNleStateStore";
import { useSidecarStore } from "../../store/useSidecarStore";
import { useUiStore } from "../../store/useUiStore";
import { FolderTree } from "./FolderTree";
import { JobProgress } from "./JobProgress";
import { PoolTray } from "./PoolTray";
import { ShotCard } from "./ShotCard";

const button =
  "flex items-center justify-center gap-1.5 rounded-md bg-athletic-blue px-3 py-1.5 text-xs text-white hover:brightness-125 disabled:cursor-not-allowed disabled:opacity-40";
const field = "w-full rounded-md border border-border bg-canvas px-2 py-1.5 text-xs text-white placeholder:text-cool-grey";

/**
 * The B-roll Library (PLAN.md, "Phase 5"): VibeCut's B-roll browser over Spyglass's index of the
 * archive (Rough Cut Studio Suite - Blair Themed). Tick folders as the scope (shared with the agent's
 * find_broll), browse or search them, then Source, Import, Place or drag a shot into the editor.
 */
export function LibraryPanel() {
  const { index, scopes, mode, query, results, total, hasMore, busy, error, warnings, searchJobId, pool, notice, pending } = useLibraryStore();
  const searchJob = useSidecarStore((s) => s.jobs.find((j) => j.id === searchJobId) ?? null);
  const [text, setText] = useState("");
  const [showFolders, setShowFolders] = useState(false);
  // Re-render when the editors change, so Source, Import and Place follow them.
  useNleStateStore((s) => s.hosts);
  const noEditor = connectedHost() ? null : NO_EDITOR;
  const noPlace = placeBlocked();

  useEffect(() => {
    void openLibrary();
  }, []);

  if (index === undefined) return <p className="px-4 pt-6 text-center text-xs text-cool-grey">Looking for Spyglass's index…</p>;
  if (index === null) {
    return (
      <div className="space-y-3 px-4 pt-6 text-center text-xs text-cool-grey">
        <p>Spyglass has no index on this computer, so there's no library to browse. Index your footage in Spyglass first, or choose its spyglass_index.sqlite.</p>
        <button type="button" className={`${button} mx-auto`} onClick={() => useUiStore.getState().openOverlay("settings")}>
          Choose index in Settings…
        </button>
      </div>
    );
  }

  const pooled = new Set(pool.map((p) => p.key));
  const offline = results.filter((r) => r.status === "offline").length;
  const drives = missingDrives(results);
  const heading =
    mode === "agent"
      ? `The agent's search: “${query}”`
      : mode === "search"
        ? `${results.length} match(es) for “${query}” in ${scopeLabel(scopes)}`
        : `${total ?? results.length} shot(s) in ${scopeLabel(scopes)}`;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="min-h-0 flex-1 space-y-2 overflow-y-auto px-3 py-3">
        <div className="flex items-center gap-2">
          <button type="button" className="flex items-center gap-1 text-xs text-white" aria-expanded={showFolders} onClick={() => setShowFolders(!showFolders)}>
            {showFolders ? <ChevronDown size={12} aria-hidden="true" /> : <ChevronRight size={12} aria-hidden="true" />}
            Folders
          </button>
          <span className="min-w-0 flex-1 truncate text-[11px] text-cool-grey" title={scopes.join("\n") || "Every watched folder"}>
            Scope: {scopeLabel(scopes)}
          </span>
          {scopes.length ? (
            <button type="button" className="text-[11px] text-athletic-blue-light hover:underline" disabled={!!busy} onClick={() => void clearScope()}>
              Whole archive
            </button>
          ) : null}
        </div>
        {showFolders ? <FolderTree /> : null}

        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            void searchLibrary(text);
          }}
        >
          <label className="sr-only" htmlFor="library-query">
            Search B-roll
          </label>
          <input
            id="library-query"
            type="search"
            className={field}
            value={text}
            maxLength={300}
            onChange={(e) => setText(e.target.value)}
            placeholder="Describe a shot, e.g. “hands on a keyboard”"
          />
          <button type="submit" className={button} disabled={!!busy} aria-label={text.trim() ? "Search" : "Browse"}>
            <Search size={14} aria-hidden="true" />
            {text.trim() ? "Search" : "Browse"}
          </button>
        </form>

        {busy && searchJob && mode !== "agent" ? <JobProgress job={searchJob} /> : null}
        <p role="status" className="text-[11px] text-cool-grey">
          {busy ?? heading}
          {noPlace && !noEditor ? ` · Place: ${noPlace}` : noEditor ? ` · Source, Import and Place: ${noEditor.toLowerCase()}` : ""}
        </p>
        {error ? (
          <p role="alert" className="rounded-md border border-loss/50 bg-loss/10 px-2.5 py-1.5 text-xs text-white">
            {error}
          </p>
        ) : null}
        {offline ? (
          <p role="note" className="rounded-md border border-warning/50 bg-warning/10 px-2.5 py-1.5 text-[11px] text-white">
            {offline === results.length ? "All" : `${offline} of`} {results.length} shot(s) here are on {drives.length === 1 ? "a drive" : "drives"} that{" "}
            {drives.length === 1 ? "isn't" : "aren't"} attached: {drives.join(", ")}. Attach {drives.length === 1 ? "it" : "them"} to preview, import, place or
            drag those shots.
          </p>
        ) : null}
        {warnings.map((w) => (
          <p key={w} className="text-[11px] text-warning">
            {w}
          </p>
        ))}
        {notice ? (
          <p role={notice.failed ? "alert" : "status"} className={`text-[11px] ${notice.failed ? "text-loss" : "text-profit"}`}>
            {notice.text}
          </p>
        ) : null}

        <ul aria-label="Shots" className="divide-y divide-border">
          {results.map((shot) => (
            <ShotCard key={shot.key} shot={shot} pooled={pooled.has(shot.key)} pending={pending.includes(shot.key)} noEditor={noEditor} noPlace={noPlace} />
          ))}
        </ul>
        {!busy && results.length === 0 ? (
          <p className="px-4 pt-4 text-center text-xs text-cool-grey">{mode === "browse" ? "No shots in this scope." : "No matches. Try other words, or a wider scope."}</p>
        ) : null}
        {hasMore ? (
          <button type="button" className={`${button} w-full bg-surface`} disabled={!!busy} onClick={() => void browseMore()}>
            More
          </button>
        ) : null}
      </div>
      <PoolTray noEditor={noEditor} noPlace={noPlace} />
    </div>
  );
}
