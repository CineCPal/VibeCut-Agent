import { create } from "zustand";
import type { RankedClip } from "../types/broll";
import type { NleHost } from "../types/nle";

/** One shot the local vision model tagged (vlm-tags, trimmed from `vibecut.vlm.v1`), in the file's seconds. */
export interface ShotTag {
  start: number;
  end: number;
  shot_scale: string | null;
  camera_movement: string | null;
  description: string;
  visual_tags: string[];
  editorial_usability_score: number | null;
}

/** A ranked clip of a bin run: `score` is the selection score (the Analyzer's, blended with the tagged
 * shots' usability when there are any), `analyzerScore` the Analyzer's own. */
export interface BinRankedClip extends RankedClip {
  analyzerScore: number;
  /** The mean usability (0 to 100) of the tagged shots its segments cover, or null untagged. */
  usability: number | null;
  /** What the best segment shows, from the tagged shot it overlaps most; null untagged. */
  visual: { description: string; tags: string[]; shotScale: string | null; movement: string | null } | null;
}

/** One analyzed bin (PLAN.md, "Bin analysis & visual clip selection"). In memory only: a bin's clips change
 * in the editor, so a run is redone rather than restored after a restart. */
export interface BinRun {
  host: NleHost;
  binPath: string;
  at: number;
  contentAware: boolean;
  brief: string;
  ranked: BinRankedClip[];
  analyzed: number;
  cached: number;
  failed: { path: string; message: string }[];
  warnings: string[];
  duplicates: number;
  skipped: { name: string; reason: string }[];
  /** How many of the bin's clips had shot tags when it was analyzed. */
  tagged: number;
}

/** A bin the local workers looked at and indexed (index_bin_visuals). */
export interface BinIndex {
  host: NleHost;
  binPath: string;
  at: number;
  files: number;
  shots: number;
  failed: number;
}

interface BinRunState {
  runs: Record<string, BinRun>;
  indexed: Record<string, BinIndex>;
  /** Run keys, the latest last. */
  order: string[];
  keepRun: (run: BinRun) => void;
  keepIndex: (index: BinIndex) => void;
  clear: () => void;
}

export const binKey = (host: NleHost, binPath: string) => `${host}:${binPath}`;

export const useBinRunStore = create<BinRunState>()((set) => ({
  runs: {},
  indexed: {},
  order: [],
  keepRun: (run) =>
    set((s) => {
      const key = binKey(run.host, run.binPath);
      return { runs: { ...s.runs, [key]: run }, order: [...s.order.filter((k) => k !== key), key] };
    }),
  keepIndex: (index) => set((s) => ({ indexed: { ...s.indexed, [binKey(index.host, index.binPath)]: index } })),
  clear: () => set({ runs: {}, indexed: {}, order: [] }),
}));

/** The latest runs of one editor, latest first. */
export function runsOf(host: NleHost): BinRun[] {
  const { runs, order } = useBinRunStore.getState();
  return order
    .map((k) => runs[k])
    .filter((r): r is BinRun => Boolean(r) && r.host === host)
    .reverse();
}
