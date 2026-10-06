/**
 * The "VibeCut Agent B-roll" panel in Premiere (PLAN.md, "Phase 5b") and the app: `broll.json` (what the
 * panel shows) and the actions it writes to `inbox/`. From VibeCut's src/types/hostPanel.ts B-roll part,
 * with the editor's state carried in the same file (the panel has no chat). Shared by the app
 * (src/lib/brollPanel.ts) and the panel (src-premiere-panel-ui/), and checked again by Rust
 * (src-tauri/src/broll_panel.rs).
 */

export const BROLL_PANEL_VERSION = 1;

/** A Spyglass folder row, in tree order. */
export interface PanelBrollFolder {
  path: string;
  name: string;
  depth: number;
  shotCount: number;
  online: boolean;
  hasChildren: boolean;
  expanded: boolean;
  /** Part of the search scope, shared with the agent's find_broll. */
  checked: boolean;
}

/** A shot: a browse or search result, or a pooled one. */
export interface PanelShot {
  key: string;
  filename: string;
  start: number;
  end: number;
  caption?: string;
  /** Spyglass's 0-100 quality score. */
  technical?: number;
  status: "ok" | "offline" | "changed";
  /** Its picture's file in `thumbs/` (a `data:` URL as text), when there is one. */
  thumb?: string;
  pooled?: boolean;
}

export interface PanelBrollFile {
  version: typeof BROLL_PANEL_VERSION;
  /** Stamped on every write, so the panel re-renders only on a change. */
  publishedAt: number;
  /** Spyglass has no index on this computer. */
  indexMissing: boolean;
  folders: PanelBrollFolder[];
  scopes: string[];
  scopeLabel: string;
  mode: "browse" | "search" | "agent";
  query: string;
  shots: PanelShot[];
  hasMore: boolean;
  /** Shots in the scope, when known. */
  total: number | null;
  /** What the app is doing for the panel now ("Searching…"), if anything. */
  busy: string | null;
  error: string | null;
  pool: PanelShot[];
  /** Each usable shot's file by key (results and pool), for CEP's drag into Premiere. */
  paths: Record<string, string>;
  /** Premiere as the app sees it: why Source/Import, or Place, can't run now (null when they can). */
  editor: { connected: boolean; timeline: string | null; noEditor: string | null; noPlace: string | null };
  /** The answer to the panel's last Source, Import or Place. */
  notice: { actionId: string | null; text: string; failed: boolean; at: number } | null;
}

/** What the panel writes to `inbox/<id>.json`. */
export type PanelAction =
  | { id: string; type: "hello" | "broll_open" | "broll_more" | "broll_clear_scope" }
  | { id: string; type: "broll_expand"; path: string }
  | { id: string; type: "broll_scope"; path: string; checked: boolean }
  | { id: string; type: "broll_search"; query: string }
  | { id: string; type: "broll_pool"; op: "add" | "remove" | "clear" | "up" | "down"; keys: string[] }
  | { id: string; type: "broll_import"; keys: string[] }
  | { id: string; type: "broll_place" | "broll_source"; key: string };
