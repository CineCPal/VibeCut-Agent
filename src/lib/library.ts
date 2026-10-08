/**
 * The B-roll Library (PLAN.md, "Phase 5"), ported from VibeCut's panelBroll.ts without its file
 * transport: Spyglass's folders (ticked ones are the search scope, shared with the agent's find_broll),
 * browse and search, the pool, and the editor actions: Source (the editor's own source viewer, range
 * marked), Import (into its "VibeCut B-roll" bin), Place (at its playhead, revertible) and a native drag
 * of the shot's file. The index is only ever read.
 */
import { nleCall } from "./ipc";
import { runJob } from "./jobs";
import { placeAtPlayhead, placementTarget } from "./broll";
import { HOST_SHORT } from "./agent/edits";
import { browseSpyglass, findSpyglassIndex, prepareShotDrags, resolveSpyglassScope, spyglassFolderChildren, spyglassKeyframes, startShotDrag } from "./spyglassIpc";
import { MAX_POOL, useLibraryStore, type LibraryShot, type LibraryState } from "../store/useLibraryStore";
import { selectActiveHost, useNleStateStore } from "../store/useNleStateStore";
import type { NleHost } from "../types/nle";
import type { SpyglassBrowseShot, SpyglassMatch, SpyglassSearchResult } from "../types/spyglass";

export const PAGE = 60;
export const SEARCH_TOP = 40;
export const BROLL_BIN = "VibeCut B-roll";

/** Bumped by each browse or search, so an older one that finishes late doesn't overwrite a newer one. */
let generation = 0;
let opened = false;

const store = () => useLibraryStore.getState();
const patch = (p: Partial<LibraryState>) => store().set(p);
const describe = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** "the whole archive", one folder's name, or "n folders". */
export function scopeLabel(scopes: string[]): string {
  if (scopes.length === 0) return "the whole archive";
  if (scopes.length === 1) return scopes[0].split("/").filter(Boolean).pop() ?? scopes[0];
  return `${scopes.length} folders`;
}

export function shotKey(s: { shotId: number | null; path: string; start: number; end: number }): string {
  return s.shotId !== null ? `s${s.shotId}` : `${s.path}#${s.start.toFixed(2)}-${s.end.toFixed(2)}`;
}

export function fromBrowse(s: SpyglassBrowseShot): LibraryShot {
  const shot = { shotId: s.shotId, path: s.path, start: s.start, end: s.end };
  return { key: shotKey(shot), ...shot, filename: s.filename, caption: s.caption, tags: s.tags, technical: s.technical, energy: s.energy, status: s.status, keyframe: s.keyframe };
}

export function fromMatch(m: SpyglassMatch): LibraryShot {
  const shot = { shotId: m.shotId ?? null, path: m.path, start: m.start, end: m.end };
  const status = m.status === "offline" || m.status === "changed" ? m.status : "ok";
  return { key: shotKey(shot), ...shot, filename: m.filename, caption: m.caption, tags: m.tags ?? [], technical: m.technical, energy: m.energy, status, keyframe: null };
}

/** Gets the usable shots ready to drag in the background, so a drag starts without a lookup. */
function prepareDrags(shots: LibraryShot[]): void {
  const ids = shots.filter((s) => s.shotId !== null && !unusable(s)).map((s) => s.shotId as number);
  if (ids.length) prepareShotDrags(ids.slice(0, 1000)).catch(() => undefined);
}

/** Asks Rust to allow these shots' keyframes and fills them in on the results and the pool. */
async function ensureKeyframes(shots: LibraryShot[]): Promise<void> {
  const ids = [...new Set(shots.filter((s) => s.shotId !== null && !s.keyframe).map((s) => s.shotId as number))];
  if (!ids.length) return;
  try {
    const found = new Map((await spyglassKeyframes(ids.slice(0, 1000))).map((k) => [k.shotId, k.path]));
    const fill = (s: LibraryShot) => (s.shotId !== null && !s.keyframe && found.has(s.shotId) ? { ...s, keyframe: found.get(s.shotId) ?? null } : s);
    patch({ results: store().results.map(fill), pool: store().pool.map(fill) });
  } catch {
    // Pictures are a nicety: the cards show without them.
  }
}

// ----------------------------------------------------------------------------- the index and folders

/** Looks for Spyglass's index and remembers what it found. */
export async function refreshIndex(): Promise<void> {
  try {
    patch({ index: await findSpyglassIndex() });
  } catch {
    patch({ index: null });
  }
}

async function loadFolders(parent: string): Promise<void> {
  try {
    const kids = await spyglassFolderChildren(parent || undefined);
    patch({ children: { ...store().children, [parent]: kids } });
  } catch (error) {
    const text = describe(error);
    if (/no index/i.test(text)) patch({ index: null });
    else patch({ error: text });
  }
}

/** The tab was opened: the index, the watched roots and the scope's first page, once per run. */
export async function openLibrary(): Promise<void> {
  if (opened) return;
  opened = true;
  await refreshIndex();
  if (!store().index) return;
  await loadFolders("");
  for (const path of store().expanded) await loadFolders(path);
  void ensureKeyframes(store().pool);
  prepareDrags(store().pool);
  await browse(0);
}

/** Reads everything again (another index was chosen, or Spyglass re-indexed). */
export async function reloadLibrary(): Promise<void> {
  opened = false;
  patch({ children: {}, results: [], total: null, hasMore: false, error: null, warnings: [] });
  await openLibrary();
}

export async function toggleFolder(path: string): Promise<void> {
  const { expanded, children } = store();
  if (expanded.includes(path)) return patch({ expanded: expanded.filter((p) => p !== path) });
  patch({ expanded: [...expanded, path] });
  if (!children[path]) await loadFolders(path);
}

async function rescope(): Promise<void> {
  const { mode, query } = store();
  if (mode === "search" && query) await searchLibrary(query);
  else await browse(0);
}

/** Ticks or unticks a folder as part of the scope, and shows the new scope. */
export async function setScope(path: string, checked: boolean): Promise<void> {
  const scopes = store().scopes.filter((p) => p !== path);
  patch({ scopes: checked ? [...scopes, path] : scopes });
  await rescope();
}

export async function clearScope(): Promise<void> {
  patch({ scopes: [] });
  await rescope();
}

// ----------------------------------------------------------------------------- browse and search

async function browse(offset: number): Promise<void> {
  const mine = ++generation;
  patch({ busy: offset ? "Loading more…" : `Loading the shots in ${scopeLabel(store().scopes)}…`, error: null, ...(offset ? {} : { warnings: [] }) });
  try {
    const page = await browseSpyglass(store().scopes, offset, PAGE);
    if (mine !== generation) return;
    const shots = page.shots.map(fromBrowse);
    const results = offset ? [...store().results, ...shots] : shots;
    patch({ mode: "browse", query: "", results, total: page.summary.shotCount, hasMore: results.length < page.summary.shotCount && shots.length > 0, busy: null });
    prepareDrags(shots);
  } catch (error) {
    if (mine !== generation) return;
    patch({ busy: null, error: describe(error) });
  }
}

export async function browseMore(): Promise<void> {
  const { mode, results, hasMore, busy } = store();
  if (mode === "browse" && hasMore && !busy) await browse(results.length);
}

/**
 * Searches Spyglass's index in these folders (the whole archive when empty) with its own ranking
 * (`broll-spyglass`). The first search installs the `energy` extra and loads SigLIP 2 / CLIP.
 */
export async function searchSpyglass(text: string, scopes: string[], topK: number, onJob?: (id: string) => void): Promise<{ matches: SpyglassMatch[]; warnings: string[] }> {
  const { clipIds } = await resolveSpyglassScope(scopes);
  if (clipIds.length === 0) throw new Error(`Spyglass has no clips in ${scopeLabel(scopes)}`);
  const job = await runJob("broll-spyglass", `Search ${scopeLabel(scopes)} for "${text.slice(0, 40)}"`, { clipIds, queries: [{ id: "q", text }], topK }, onJob);
  if (!job || job.status !== "done") throw new Error(job?.error ?? (job?.status === "cancelled" ? "The search was cancelled" : "The search didn't finish"));
  const result = job.result as unknown as SpyglassSearchResult | null;
  return { matches: result?.matches[0]?.results ?? [], warnings: result?.warnings ?? [] };
}

/** Searches the scope for a description; an empty one browses it. */
export async function searchLibrary(query: string): Promise<void> {
  const text = query.trim();
  if (!text) return browse(0);
  const mine = ++generation;
  const { scopes } = store();
  patch({ busy: `Searching ${scopeLabel(scopes)} for "${text}"…`, error: null, warnings: [] });
  try {
    const { matches, warnings } = await searchSpyglass(text, scopes, SEARCH_TOP, (id) => patch({ searchJobId: id }));
    if (mine !== generation) return;
    const results = matches.map(fromMatch);
    patch({ mode: "search", query: text, results, total: null, hasMore: false, busy: null, warnings });
    void ensureKeyframes(results);
    prepareDrags(results);
  } catch (error) {
    if (mine !== generation) return;
    patch({ busy: null, error: describe(error) });
  }
}

/** The agent's find_broll: its matches show in the Library too. */
export function showAgentResults(query: string, matches: SpyglassMatch[]): void {
  generation++;
  const results = matches.map(fromMatch);
  patch({ mode: "agent", query, results, total: null, hasMore: false, busy: null, error: null, warnings: [] });
  void ensureKeyframes(results);
  prepareDrags(results);
}

// ----------------------------------------------------------------------------- the pool

export type PoolOp = "add" | "remove" | "clear" | "up" | "down";

/** Changes the pool. `add` takes shots from the results (skipping ones already pooled). */
export function changePool(op: PoolOp, keys: string[]): void {
  const pool = store().pool;
  if (op === "clear") return patch({ pool: [] });
  if (op === "remove") return patch({ pool: pool.filter((p) => !keys.includes(p.key)) });
  if (op === "add") {
    const have = new Set(pool.map((p) => p.key));
    const adding = store().results.filter((s) => keys.includes(s.key) && !have.has(s.key));
    return patch({ pool: [...pool, ...adding].slice(0, MAX_POOL) });
  }
  const at = pool.findIndex((p) => p.key === keys[0]);
  const to = op === "up" ? at - 1 : at + 1;
  if (at < 0 || to < 0 || to >= pool.length) return;
  const next = [...pool];
  [next[at], next[to]] = [next[to], next[at]];
  patch({ pool: next });
}

// ----------------------------------------------------------------------------- the editor actions

/** A result or a pooled shot, by its key. */
export function shotOf(key: string): LibraryShot | undefined {
  return store().results.find((s) => s.key === key) ?? store().pool.find((s) => s.key === key);
}

/** Why a shot can't go to an editor now, or null. */
export function unusable(shot: LibraryShot): string | null {
  if (shot.status === "offline") {
    const drive = driveOf(shot.path);
    return drive ? `Its drive "${drive}" isn't attached` : "Its file isn't reachable";
  }
  if (shot.status === "changed") return "The file changed since Spyglass indexed it";
  return null;
}

/** The volume a path is on ("2026 Main Drive - Blair" for /Volumes/2026 Main Drive - Blair/…), or null. */
export function driveOf(path: string): string | null {
  const m = /^\/Volumes\/([^/]+)\//.exec(path);
  return m ? m[1] : null;
}

/** The drives the offline shots are on, most shots first (for the Library's "attach this drive" line). */
export function missingDrives(shots: LibraryShot[]): string[] {
  const counts = new Map<string, number>();
  for (const s of shots) {
    const drive = s.status === "offline" ? driveOf(s.path) : null;
    if (drive) counts.set(drive, (counts.get(drive) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([d]) => d);
}

export const NO_EDITOR = "Connect Premiere Pro or DaVinci Resolve first";

/** The connected editor (for Source and Import, which need no timeline), or null. `only` asks for that
 * editor alone (the Premiere B-roll panel's actions). */
export function connectedHost(only?: NleHost): NleHost | null {
  const nle = useNleStateStore.getState();
  if (only) return nle.hosts[only].status === "connected" ? only : null;
  return selectActiveHost(nle);
}

async function act(keys: string[], work: () => Promise<string>, working?: string): Promise<void> {
  patch({ pending: [...store().pending, ...keys], notice: working ? { text: working, failed: false } : null });
  try {
    patch({ notice: { text: await work(), failed: false } });
  } catch (error) {
    patch({ notice: { text: describe(error), failed: true } });
  } finally {
    patch({ pending: store().pending.filter((k) => !keys.includes(k)) });
  }
}

function usableShots(keys: string[]): LibraryShot[] {
  const shots = keys.map(shotOf).filter((s): s is LibraryShot => !!s);
  const usable = shots.filter((s) => !unusable(s));
  if (!usable.length) {
    if (!shots.length) throw new Error("Those shots aren't in the Library any more.");
    throw new Error(`${shots[0].filename}: ${unusable(shots[0])}. Attach it to preview, import, place or drag it.`);
  }
  return usable;
}

/** Imports the shots' files into the editor's "VibeCut B-roll" bin. Not revertible: imports aren't timeline edits. */
export function importShots(keys: string[], only?: NleHost): Promise<void> {
  return act(keys, async () => {
    const host = connectedHost(only);
    if (!host) throw new Error(only ? `Connect ${HOST_SHORT[only]} first` : NO_EDITOR);
    const paths = [...new Set(usableShots(keys).map((s) => s.path))];
    const r = await nleCall<{ bin: string; imported: unknown[]; reused: unknown[]; refused?: { path: string }[] }>(host, "import_media", { paths, bin: BROLL_BIN });
    const parts = [`Imported ${r.imported.length} file(s) into "${r.bin}" in ${HOST_SHORT[host]}`];
    if (r.reused.length) parts.push(`${r.reused.length} already in the project`);
    if (r.refused?.length) parts.push(`${r.refused.length} refused`);
    return `${parts.join("; ")}.`;
  });
}

/** Opens a stretch of a file in the editor's source viewer with it marked: Premiere's Source monitor (no
 * import), or Resolve's (which shows only Media Pool clips, so it imports into the bin first). Returns what
 * happened. Shared by the Library and the Analyze tab's preview. */
export async function openInSourceMonitor(host: NleHost, clip: { path: string; filename: string; start: number; end: number }): Promise<string> {
  const r = await nleCall<{ marked: boolean; atIn: boolean; imported: boolean; page?: string }>(host, "source_preview", {
    path: clip.path,
    inSeconds: clip.start,
    outSeconds: clip.end,
    ...(host === "resolve" ? { bin: BROLL_BIN } : {}),
  });
  if (host === "premiere") return `${clip.filename} is in the Source monitor${r.marked ? ", In and Out marked" : ""}${r.atIn ? "" : " (its playhead stayed put)"}.`;
  const page = r.page === "edit" || r.page === "cut" ? "" : " Open the Edit page to see it.";
  return `${clip.filename} is in the source viewer${r.imported ? ` (imported into ${BROLL_BIN})` : ""}${r.marked ? ", In and Out marked" : ""}; press Shift+I to go to its In.${page}`;
}

/** Opens a shot in the editor's source viewer with its range marked (openInSourceMonitor). */
export function previewShot(key: string, only?: NleHost): Promise<void> {
  const shot = shotOf(key);
  const host = connectedHost(only);
  const working = shot && host && !unusable(shot) ? `Opening ${shot.filename} in ${host === "premiere" ? "the Source monitor" : "Resolve's source viewer"}…` : undefined;
  return act([key], async () => {
    if (!host) throw new Error(only ? `Connect ${HOST_SHORT[only]} first` : NO_EDITOR);
    const [shot] = usableShots([key]);
    return openInSourceMonitor(host, shot);
  }, working);
}

/** Places a shot's picture at the playhead of the open timeline, as its own revertible request. */
export function placeShot(key: string, only?: NleHost): Promise<void> {
  return act([key], async () => {
    const [shot] = usableShots([key]);
    return placeAtPlayhead({ path: shot.path, filename: shot.filename, start: shot.start, end: shot.end }, { sound: false, ...(only ? { host: only } : {}) });
  });
}

/** Why Place is off now (no editor or no open timeline), or null. */
export function placeBlocked(only?: NleHost): string | null {
  const target = placementTarget(only);
  return typeof target === "string" ? target : null;
}

/** Starts the native drag of a shot's file; a failure (offline file, no index) shows as the notice. */
export async function dragShot(shot: LibraryShot): Promise<void> {
  const why = unusable(shot);
  if (why) return patch({ notice: { text: `${shot.filename}: ${why}. Attach it to drag it into the editor.`, failed: true } });
  if (shot.shotId === null) return patch({ notice: { text: "This shot can't be dragged: Spyglass gave it no id.", failed: true } });
  try {
    await startShotDrag(shot.shotId);
  } catch (error) {
    patch({ notice: { text: describe(error), failed: true } });
  }
}

/** For tests: forget that the Library was opened. */
export function resetLibraryForTests(): void {
  opened = false;
  generation = 0;
}
