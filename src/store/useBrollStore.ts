import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

/**
 * The B-roll panel: the folder and options (remembered between runs), and which analyzer jobs it
 * started. The jobs themselves, with their progress and results, live in `useSidecarStore`.
 */
export interface BrollState {
  folder: string | null;
  /** Content-aware scoring: energy, brief relevance, dedupe and text search (the `energy` extra). */
  contentAware: boolean;
  brief: string;
  dedupe: boolean;
  query: string;
  analyzeJobId: string | null;
  matchJobId: string | null;
  setFolder: (folder: string | null) => void;
  setContentAware: (on: boolean) => void;
  setBrief: (brief: string) => void;
  setDedupe: (on: boolean) => void;
  setQuery: (query: string) => void;
  setAnalyzeJob: (id: string | null) => void;
  setMatchJob: (id: string | null) => void;
}

export const useBrollStore = create<BrollState>()(
  persist(
    (set) => ({
      folder: null,
      contentAware: false,
      brief: "",
      dedupe: false,
      query: "",
      analyzeJobId: null,
      matchJobId: null,
      setFolder: (folder) => set({ folder, analyzeJobId: null, matchJobId: null }),
      setContentAware: (contentAware) => set(contentAware ? { contentAware } : { contentAware, dedupe: false }),
      setBrief: (brief) => set({ brief: brief.slice(0, 200) }),
      setDedupe: (dedupe) => set({ dedupe }),
      setQuery: (query) => set({ query: query.slice(0, 300) }),
      setAnalyzeJob: (analyzeJobId) => set({ analyzeJobId }),
      setMatchJob: (matchJobId) => set({ matchJobId }),
    }),
    {
      name: "vibecut-agent.broll",
      storage: createJSONStorage(() => localStorage),
      partialize: (s) => ({ folder: s.folder, contentAware: s.contentAware, brief: s.brief, dedupe: s.dedupe }),
    },
  ),
);
