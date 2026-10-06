/**
 * The app's side of the "VibeCut Agent B-roll" panel docked in Premiere (PLAN.md, "Phase 5b"), after
 * VibeCut's panelBroll.ts: it publishes the B-roll Library as `broll.json` whenever the Library or
 * Premiere's state changes, writes the shots' thumbnails, and answers the panel's actions with the
 * Library's own functions (lib/library.ts). The panel names shots by key and folders only from the list
 * it was given; paths stay here, except each usable shot's file for CEP's drag (`paths`).
 */
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
  browseMore,
  changePool,
  clearScope,
  connectedHost,
  importShots,
  openLibrary,
  placeBlocked,
  placeShot,
  previewShot,
  scopeLabel,
  searchLibrary,
  setScope,
  toggleFolder,
  unusable,
  type PoolOp,
} from "./library";
import { useLibraryStore, type LibraryShot, type LibraryState } from "../store/useLibraryStore";
import { useNleStateStore } from "../store/useNleStateStore";
import { BROLL_PANEL_VERSION, type PanelAction, type PanelBrollFile, type PanelBrollFolder, type PanelShot } from "../types/brollPanel";

const HOST = "premiere" as const;
/** Coalesces bursts of store changes into one write. */
const PUBLISH_DELAY_MS = 80;

const KEY = /^[\w-]{1,64}$/;
const thumbName = (shotId: number) => `s${shotId}.txt`;

/** Shots whose thumbnail is in the panel's folder. */
const thumbs = new Set<number>();
/** The panel's last action that the Library answers with a notice (Source, Import, Place). */
let answering: string | null = null;

// ----------------------------------------------------------------------------- what the panel gets

function folderRows(s: LibraryState): PanelBrollFolder[] {
  const rows: PanelBrollFolder[] = [];
  const walk = (parent: string, depth: number) => {
    for (const f of s.children[parent] ?? []) {
      const expanded = s.expanded.includes(f.path);
      rows.push({ path: f.path, name: f.name, depth, shotCount: f.shotCount, online: f.online, hasChildren: f.hasChildren, expanded, checked: s.scopes.includes(f.path) });
      if (expanded) walk(f.path, depth + 1);
    }
  };
  walk("", 0);
  return rows;
}

/** Only shots with a key the panel's protocol allows (every Spyglass shot has one). */
const listable = (shot: LibraryShot) => KEY.test(shot.key);

function panelShot(shot: LibraryShot, pooled: boolean): PanelShot {
  return {
    key: shot.key,
    filename: shot.filename,
    start: shot.start,
    end: shot.end,
    ...(shot.caption ? { caption: shot.caption } : {}),
    ...(shot.technical !== null ? { technical: Math.round(shot.technical) } : {}),
    status: shot.status,
    ...(shot.shotId !== null && thumbs.has(shot.shotId) ? { thumb: thumbName(shot.shotId) } : {}),
    ...(pooled ? { pooled: true } : {}),
  };
}

/** `broll.json` for the Library and Premiere as they are now. */
export function buildBrollFile(now = Date.now()): PanelBrollFile {
  const s = useLibraryStore.getState();
  const premiere = useNleStateStore.getState().hosts[HOST];
  const pooled = new Set(s.pool.map((p) => p.key));
  const results = s.results.filter(listable);
  const pool = s.pool.filter(listable);
  const paths: Record<string, string> = {};
  for (const shot of [...results, ...pool]) if (!unusable(shot)) paths[shot.key] = shot.path;
  const connected = connectedHost(HOST) !== null;
  return {
    version: BROLL_PANEL_VERSION,
    publishedAt: now,
    indexMissing: s.index === null,
    folders: folderRows(s),
    scopes: s.scopes,
    scopeLabel: scopeLabel(s.scopes),
    mode: s.mode,
    query: s.query,
    shots: results.map((r) => panelShot(r, pooled.has(r.key))),
    hasMore: s.hasMore,
    total: s.total,
    busy: s.busy,
    error: s.error,
    pool: pool.map((p) => panelShot(p, true)),
    paths,
    editor: {
      connected,
      timeline: premiere.timeline,
      noEditor: connected ? null : "Open VibeCut Agent's connection to Premiere first (the app shows Pr in green)",
      noPlace: placeBlocked(HOST),
    },
    notice: s.notice ? { actionId: answering, text: s.notice.text, failed: s.notice.failed, at: now } : null,
  };
}

// ----------------------------------------------------------------------------- the panel's actions

/** A folder the panel may name: one the app listed. */
const listed = (path: string) => Object.values(useLibraryStore.getState().children).some((kids) => kids.some((f) => f.path === path));

export async function handleAction(action: PanelAction): Promise<void> {
  switch (action.type) {
    case "hello":
    case "broll_open":
      return openLibrary();
    case "broll_expand":
      if (listed(action.path)) await toggleFolder(action.path);
      return;
    case "broll_scope":
      if (listed(action.path)) await setScope(action.path, action.checked);
      return;
    case "broll_clear_scope":
      return clearScope();
    case "broll_search":
      return searchLibrary(action.query);
    case "broll_more":
      return browseMore();
    case "broll_pool":
      return changePool(action.op as PoolOp, action.keys);
    case "broll_import":
      answering = action.id;
      return importShots(action.keys, HOST);
    case "broll_source":
      answering = action.id;
      return previewShot(action.key, HOST);
    case "broll_place":
      answering = action.id;
      return placeShot(action.key, HOST);
  }
}

// ----------------------------------------------------------------------------- publishing

/** Writes the thumbnails of the shots the panel shows that don't have one yet. */
async function ensureThumbs(): Promise<boolean> {
  const s = useLibraryStore.getState();
  const wanted = [...new Set([...s.results, ...s.pool].flatMap((shot) => (shot.shotId !== null && !thumbs.has(shot.shotId) ? [shot.shotId] : [])))].slice(0, 200);
  if (!wanted.length) return false;
  try {
    const ready = await invoke<number[]>("broll_panel_thumbs", { shotIds: wanted });
    ready.forEach((id) => thumbs.add(id));
    return ready.length > 0;
  } catch {
    // Pictures are a nicety: the cards show without them.
    return false;
  }
}

/** Keeps `broll.json` up to date and answers the panel. Call once for the app's lifetime. */
export function startBrollPanelBridge(): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;
  const publish = () => {
    if (timer) return;
    timer = setTimeout(() => {
      timer = null;
      if (stopped) return;
      void invoke<boolean>("broll_panel_publish", { file: buildBrollFile() })
        .then((written) => {
          // The panel's folder exists: get its pictures, and publish again once they're there.
          if (written) void ensureThumbs().then((more) => more && publish());
        })
        .catch(() => undefined);
    }, PUBLISH_DELAY_MS);
  };
  const unsubscribe = [useLibraryStore.subscribe(publish), useNleStateStore.subscribe(publish)];
  const unlisten = listen<{ action: PanelAction | null; error: string | null }>("broll-panel-action", ({ payload }) => {
    if (!payload.action) return;
    void handleAction(payload.action).finally(publish);
  });
  publish();
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
    unsubscribe.forEach((fn) => fn());
    void unlisten.then((fn) => fn());
  };
}
