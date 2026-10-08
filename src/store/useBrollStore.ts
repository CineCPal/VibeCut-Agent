import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import type { AnalyzeResult } from "../types/broll";

/** Which clips the selects keep: all, the best N, or those scoring at least a minimum. */
export type TopMode = "all" | "topn" | "threshold";
/** The selects' order on the timeline: best first, or by file name. */
export type SequenceOrder = "score" | "name";

/** The analyzer's options, remembered between runs (PLAN.md, "Phase 10"). Ranges match commands.py. */
export interface AnalyzerOptions {
  /** Seconds in each picked segment. */
  windowSec: number;
  /** How many segments each clip may give (1 to 20). */
  maxSegments: number;
  /** The least space between two segments of one clip, in seconds. */
  minGapSec: number;
  /** 0 to 100: how much energy counts (content-aware only). */
  energyWeight: number;
  /** 0 to 100: how much the brief match counts (content-aware with a brief only). */
  relevanceWeight: number;
  /** Parallel workers, or null to let the analyzer choose. */
  workers: number | null;
  topMode: TopMode;
  topN: number;
  minScore: number;
  sequenceOrder: SequenceOrder;
  sequenceName: string;
}

export const DEFAULT_OPTIONS: AnalyzerOptions = {
  windowSec: 4,
  maxSegments: 1,
  minGapSec: 1,
  energyWeight: 35,
  relevanceWeight: 35,
  workers: null,
  topMode: "all",
  topN: 10,
  minScore: 0,
  sequenceOrder: "score",
  sequenceName: "B-Roll Selects",
};

const LIMITS: Partial<Record<keyof AnalyzerOptions, [number, number, number]>> = {
  // [low, high, decimals]
  windowSec: [0.5, 120, 1],
  maxSegments: [1, 20, 0],
  minGapSec: [0, 30, 1],
  energyWeight: [0, 100, 0],
  relevanceWeight: [0, 100, 0],
  workers: [1, 32, 0],
  topN: [1, 1000, 0],
  minScore: [0, 100, 0],
};

const clamp = (key: keyof AnalyzerOptions, value: number): number => {
  const limit = LIMITS[key];
  if (!limit || !Number.isFinite(value)) return DEFAULT_OPTIONS[key] as number;
  const [low, high, decimals] = limit;
  const factor = 10 ** decimals;
  return Math.min(high, Math.max(low, Math.round(value * factor) / factor));
};

/** An option set made safe: numbers clamped, choices checked, missing ones defaulted. */
export function cleanOptions(raw: Partial<Record<keyof AnalyzerOptions, unknown>>): AnalyzerOptions {
  const out = { ...DEFAULT_OPTIONS };
  for (const key of Object.keys(LIMITS) as (keyof AnalyzerOptions)[]) {
    const value = raw[key];
    if (key === "workers" && (value === null || value === undefined)) continue;
    if (typeof value === "number") (out as Record<string, unknown>)[key] = clamp(key, value);
  }
  if (raw.topMode === "all" || raw.topMode === "topn" || raw.topMode === "threshold") out.topMode = raw.topMode;
  if (raw.sequenceOrder === "score" || raw.sequenceOrder === "name") out.sequenceOrder = raw.sequenceOrder;
  if (typeof raw.sequenceName === "string") out.sequenceName = raw.sequenceName.slice(0, 120);
  return out;
}

/** What a run was asked for, to tell when its results no longer match the options. */
export interface RunParams {
  contentAware: boolean;
  brief: string;
  dedupe: boolean;
  windowSec: number;
  maxSegments: number;
  minGapSec: number;
  energyWeight: number;
  relevanceWeight: number;
}

/** The last finished analysis, kept so a restart still shows it. */
export interface LastResult {
  folder: string;
  params: RunParams;
  result: AnalyzeResult;
  at: number;
}

/** The most clips a kept result holds (the best ones), so saved state stays small. */
export const MAX_KEPT_CLIPS = 500;

/** Which segment the preview plays. */
export interface PreviewTarget {
  path: string;
  index: number;
}

/**
 * The B-roll panel: the folder and options (remembered between runs), the last result and which
 * segments the selects leave out, and which analyzer jobs it started. The jobs themselves, with their
 * progress and results, live in `useSidecarStore`.
 */
export interface BrollState extends AnalyzerOptions {
  folder: string | null;
  /** Content-aware scoring: energy, brief relevance, dedupe and text search (the `energy` extra). */
  contentAware: boolean;
  brief: string;
  dedupe: boolean;
  query: string;
  analyzeJobId: string | null;
  matchJobId: string | null;
  lastResult: LastResult | null;
  /** Per clip path, the segment indices left out of the selects. */
  excluded: Record<string, number[]>;
  preview: PreviewTarget | null;
  setFolder: (folder: string | null) => void;
  setContentAware: (on: boolean) => void;
  setBrief: (brief: string) => void;
  setDedupe: (on: boolean) => void;
  setQuery: (query: string) => void;
  setAnalyzeJob: (id: string | null) => void;
  setMatchJob: (id: string | null) => void;
  setOption: <K extends keyof AnalyzerOptions>(key: K, value: AnalyzerOptions[K]) => void;
  resetOptions: () => void;
  /** Keeps a finished analysis; its segments all start ticked. */
  keepResult: (folder: string, params: RunParams, result: AnalyzeResult) => void;
  toggleSegment: (path: string, index: number) => void;
  setPreview: (preview: PreviewTarget | null) => void;
}

export const runParams = (s: Pick<BrollState, keyof RunParams>): RunParams => ({
  contentAware: s.contentAware,
  brief: s.contentAware ? s.brief.trim() : "",
  dedupe: s.contentAware && s.dedupe,
  windowSec: s.windowSec,
  maxSegments: s.maxSegments,
  minGapSec: s.minGapSec,
  energyWeight: s.energyWeight,
  relevanceWeight: s.relevanceWeight,
});

/** The scoring options that differ from the ones the kept result was made with (empty: it's current). */
export function staleOptions(s: BrollState): string[] {
  if (!s.lastResult || s.lastResult.folder !== s.folder) return [];
  const now = runParams(s);
  const then = s.lastResult.params;
  const labels: Record<keyof RunParams, string> = {
    contentAware: "content-aware scoring",
    brief: "brief",
    dedupe: "near-duplicates",
    windowSec: "segment length",
    maxSegments: "segments per clip",
    minGapSec: "gap",
    energyWeight: "energy weight",
    relevanceWeight: "brief weight",
  };
  return (Object.keys(labels) as (keyof RunParams)[])
    .filter((key) => {
      // Weights don't matter when the scoring they weigh was off both times.
      if (key === "energyWeight" && !now.contentAware && !then.contentAware) return false;
      if (key === "relevanceWeight" && !now.brief && !then.brief) return false;
      return now[key] !== then[key];
    })
    .map((key) => labels[key]);
}

const STORE_VERSION = 2;

export const useBrollStore = create<BrollState>()(
  persist(
    (set) => ({
      ...DEFAULT_OPTIONS,
      folder: null,
      contentAware: false,
      brief: "",
      dedupe: false,
      query: "",
      analyzeJobId: null,
      matchJobId: null,
      lastResult: null,
      excluded: {},
      preview: null,
      setFolder: (folder) => set({ folder, analyzeJobId: null, matchJobId: null, preview: null }),
      setContentAware: (contentAware) => set(contentAware ? { contentAware } : { contentAware, dedupe: false }),
      setBrief: (brief) => set({ brief: brief.slice(0, 200) }),
      setDedupe: (dedupe) => set({ dedupe }),
      setQuery: (query) => set({ query: query.slice(0, 300) }),
      setAnalyzeJob: (analyzeJobId) => set({ analyzeJobId }),
      setMatchJob: (matchJobId) => set({ matchJobId }),
      setOption: (key, value) => set((s) => cleanOptions({ ...pickOptions(s), [key]: value })),
      resetOptions: () => set({ ...DEFAULT_OPTIONS }),
      keepResult: (folder, params, result) =>
        set({
          lastResult: { folder, params, result: { ...result, ranked: result.ranked.slice(0, MAX_KEPT_CLIPS) }, at: Date.now() },
          excluded: {},
          preview: null,
        }),
      toggleSegment: (path, index) =>
        set((s) => {
          const now = s.excluded[path] ?? [];
          const next = now.includes(index) ? now.filter((i) => i !== index) : [...now, index].sort((a, b) => a - b);
          const excluded = { ...s.excluded };
          if (next.length) excluded[path] = next;
          else delete excluded[path];
          return { excluded };
        }),
      setPreview: (preview) => set({ preview }),
    }),
    {
      name: "vibecut-agent.broll",
      version: STORE_VERSION,
      storage: createJSONStorage(() => localStorage),
      partialize: (s) => ({
        folder: s.folder,
        contentAware: s.contentAware,
        brief: s.brief,
        dedupe: s.dedupe,
        ...pickOptions(s),
        lastResult: s.lastResult,
        excluded: s.excluded,
      }),
      // Version 1 (Phase 4) kept only the folder and the content-aware choices; every option starts at
      // its default. Anything saved is cleaned, so a hand-edited or older file can't break the panel.
      migrate: (saved) => {
        const s = (saved ?? {}) as Record<string, unknown>;
        return { ...s, ...cleanOptions(s as Partial<Record<keyof AnalyzerOptions, unknown>>) };
      },
      merge: (saved, current) => {
        const s = (saved ?? {}) as Partial<BrollState>;
        return { ...current, ...s, ...cleanOptions(s as Partial<Record<keyof AnalyzerOptions, unknown>>) };
      },
    },
  ),
);

function pickOptions(s: AnalyzerOptions): AnalyzerOptions {
  return {
    windowSec: s.windowSec,
    maxSegments: s.maxSegments,
    minGapSec: s.minGapSec,
    energyWeight: s.energyWeight,
    relevanceWeight: s.relevanceWeight,
    workers: s.workers,
    topMode: s.topMode,
    topN: s.topN,
    minScore: s.minScore,
    sequenceOrder: s.sequenceOrder,
    sequenceName: s.sequenceName,
  };
}
