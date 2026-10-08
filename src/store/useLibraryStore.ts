import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import type { SpyglassFileStatus, SpyglassFolder, SpyglassIndexInfo } from "../types/spyglass";

/**
 * The B-roll Library (PLAN.md, "Phase 5"): VibeCut's B-roll browser over Spyglass's index, ported from
 * VibeCut's panelBroll.ts. The ticked folders (`scopes`) and the pool are remembered between runs; the
 * folder tree, the results and the busy/error line are not. The actions are in `lib/library.ts`.
 */

/** A shot the Library shows: a browse row, a search match, an agent match or a pooled shot. */
export interface LibraryShot {
  /** `s<shotId>`, or the file and range for a shot Spyglass gave no id. */
  key: string;
  shotId: number | null;
  path: string;
  filename: string;
  start: number;
  end: number;
  caption: string | null;
  tags: string[];
  /** 0–100, when Spyglass measured it. */
  technical: number | null;
  energy: number | null;
  status: SpyglassFileStatus;
  /** The keyframe image (allowed for display), when it exists. */
  keyframe: string | null;
}

export type LibraryMode = "browse" | "search" | "agent";

export interface LibraryNotice {
  text: string;
  failed: boolean;
}

/** Shots set aside at most. */
export const MAX_POOL = 200;

export interface LibraryState {
  /** Undefined until looked for; null when this computer has no index. */
  index: SpyglassIndexInfo | null | undefined;
  /** Folders ticked as the search scope (the whole archive when none), shared with the agent's find_broll. */
  scopes: string[];
  expanded: string[];
  /** Each folder's subfolders, by its path ("" for the watched roots). */
  children: Record<string, SpyglassFolder[]>;
  mode: LibraryMode;
  query: string;
  results: LibraryShot[];
  /** Shots in the scope (browse only). */
  total: number | null;
  hasMore: boolean;
  /** What the Library is doing, while it is. */
  busy: string | null;
  error: string | null;
  warnings: string[];
  /** The running or last search job (its progress shows under the search box). */
  searchJobId: string | null;
  pool: LibraryShot[];
  notice: LibraryNotice | null;
  /** Shots with an editor action in flight, by key. */
  pending: string[];

  set: (patch: Partial<Omit<LibraryState, "set">>) => void;
}

export const useLibraryStore = create<LibraryState>()(
  persist(
    (set) => ({
      index: undefined,
      scopes: [],
      expanded: [],
      children: {},
      mode: "browse",
      query: "",
      results: [],
      total: null,
      hasMore: false,
      busy: null,
      error: null,
      warnings: [],
      searchJobId: null,
      pool: [],
      notice: null,
      pending: [],
      set: (patch) => set(patch),
    }),
    {
      name: "vibecut-agent.library",
      storage: createJSONStorage(() => localStorage),
      // Keyframe paths are allowed per run (spyglass.rs), so a remembered pool asks for them again.
      partialize: (s) => ({ scopes: s.scopes, pool: s.pool.map((p) => ({ ...p, keyframe: null })) }),
    },
  ),
);
