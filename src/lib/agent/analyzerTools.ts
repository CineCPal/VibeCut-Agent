/**
 * The agent drives the Analyze tab (PLAN.md, "Phase 16e"): it scores a folder of B-roll, picks the
 * selects and exports them as an XML or builds them into a new timeline, through the tab's own code
 * (lib/broll.ts, lib/brollSelects.ts) and its store, so the Analyze tab shows the same run, options and
 * selects the agent used. After VibeCut's `analyze_broll`, which scored a folder for the chat.
 *
 * Content-aware scoring needs the `energy` extra and downloads the SigLIP 2 model (about 2 GB) on its
 * first run, so the tool turns it on only when asked, and its description says to ask the user first.
 */
import { analysisRequest, buildSelectsTimeline, currentSelects, exportSelectsXml } from "../broll";
import { runJob } from "../jobs";
import { useBrollStore, runParams, type AnalyzerOptions } from "../../store/useBrollStore";
import type { AnalyzeResult, RankedClip } from "../../types/broll";
import type { NleHost } from "../../types/nle";
import { bool, optNum, optStr, type Args, type Executor } from "./args";
import { TIMELINE_NOUN } from "./edits";
import { cancelOnStop } from "./storyTools";
import type { ToolDeclaration } from "./tools";

/** How many ranked clips a result lists for the agent (the tab shows them all). */
export const LISTED_CLIPS = 15;

const round1 = (n: number) => Math.round(n * 10) / 10;
const clock = (s: number) => `${round1(s)}s`;
const folderName = (folder: string) => folder.split("/").filter(Boolean).pop() ?? folder;

/** A ranked clip as the agent reads it: score, segments, and what content-aware scoring added. */
function clipLine(c: RankedClip): Record<string, unknown> {
  return {
    file: c.filename,
    score: round1(c.score),
    segments: (c.segments.length ? c.segments : [{ start: c.bestStart, end: c.bestEnd }]).map((s) => `${clock(s.start)}–${clock(s.end)}`),
    ...(c.energy !== null ? { energy: Math.round(c.energy) } : {}),
    ...(c.relevance !== null ? { relevance: Math.round(c.relevance) } : {}),
    ...(c.duplicateOf ? { duplicateOf: c.duplicateOf } : {}),
  };
}

/** Applies the selection arguments to the tab's options (so the tab shows the same selects). */
function applySelection(args: Args): void {
  const store = useBrollStore.getState();
  const mode = optStr(args, "include");
  if (mode !== undefined) {
    if (mode !== "all" && mode !== "best" && mode !== "minScore") throw new Error('include must be "all", "best" or "minScore"');
    store.setOption("topMode", mode === "best" ? "topn" : mode === "minScore" ? "threshold" : "all");
  }
  const best = optNum(args, "best");
  if (best !== undefined) store.setOption("topN", best);
  const minScore = optNum(args, "minScore");
  if (minScore !== undefined) store.setOption("minScore", minScore);
  const order = optStr(args, "order");
  if (order !== undefined) {
    if (order !== "score" && order !== "name") throw new Error('order must be "score" or "name"');
    store.setOption("sequenceOrder", order);
  }
  const name = optStr(args, "sequenceName");
  if (name !== undefined) store.setOption("sequenceName", name);
}

function chosenOrExplain() {
  const chosen = currentSelects();
  if (!chosen) throw new Error("There's no analysis of the Analyze tab's folder yet; call analyze_broll_folder first");
  if (!chosen.clips.length) throw new Error("The selection keeps no segments; loosen it (include, best, minScore)");
  return chosen;
}

const SELECTION_PROPS = {
  include: { type: "STRING", enum: ["all", "best", "minScore"], description: 'Which clips: every one, the best N, or those scoring at least minScore. Optional; default the tab\'s.' },
  best: { type: "NUMBER", description: 'With include "best": how many. Optional.' },
  minScore: { type: "NUMBER", description: 'With include "minScore": 0 to 100. Optional.' },
  order: { type: "STRING", enum: ["score", "name"], description: "Best first, or by file name. Optional." },
  sequenceName: { type: "STRING", description: "The selects sequence's name. Optional." },
};

export function analyzerToolDeclarations(host: NleHost): ToolDeclaration[] {
  const noun = TIMELINE_NOUN[host];
  return [
    {
      name: "analyze_broll_folder",
      description: `Scores every clip in a folder of footage with the Analyze tab's B-roll Analyzer (sharpness, exposure, stability; with contentAware also energy, a brief match and near-duplicate takes) and picks each clip's best segments. Runs locally; a big folder takes minutes, and results are cached per folder. The Analyze tab shows the run. folder: an absolute path (default: the tab's folder). contentAware needs a 2 GB model download the first time, so turn it on only when the user asked for it or agreed. Lists the best ${LISTED_CLIPS} clips; then export_broll_selects or build_broll_selects_timeline.`,
      parameters: {
        type: "OBJECT",
        properties: {
          folder: { type: "STRING", description: "Absolute path of the footage folder. Optional; default the Analyze tab's." },
          contentAware: { type: "BOOLEAN", description: "Optional; default the tab's setting." },
          brief: { type: "STRING", description: "What the B-roll is for, to rank by (content-aware only). Optional." },
          dedupe: { type: "BOOLEAN", description: "Mark near-duplicate takes and leave them out of the selects (content-aware only). Optional." },
          segmentsPerClip: { type: "NUMBER", description: "1 to 20. Optional; default the tab's." },
          segmentSeconds: { type: "NUMBER", description: "Length of each segment, 0.5 to 120. Optional; default the tab's." },
        },
      },
    },
    {
      name: "export_broll_selects",
      description: `Writes the Analyze tab's selects (its last analysis, with the selection given here, else the tab's) as an XML that Premiere (File → Import) and Resolve (File → Import → Timeline) both import: a bin of the clips and a sequence of the selected segments. outputPath: an absolute .xml path; without it the user picks where in a save dialog. Doesn't touch the open ${noun}.`,
      parameters: { type: "OBJECT", properties: { ...SELECTION_PROPS, outputPath: { type: "STRING", description: "Absolute .xml path. Optional." } } },
    },
    {
      name: "build_broll_selects_timeline",
      description: `Makes a NEW ${noun} in the connected editor with the Analyze tab's selects laid back to back, picture and sound (its last analysis, with the selection given here, else the tab's). The open ${noun} isn't changed; Revert takes the clips back.`,
      parameters: { type: "OBJECT", properties: SELECTION_PROPS },
    },
  ];
}

export function analyzerExecutors(): Record<string, Executor> {
  return {
    analyze_broll_folder: async (args) => {
      const store = useBrollStore.getState();
      const folder = optStr(args, "folder")?.trim() || store.folder;
      if (!folder) throw new Error("Which folder? Give folder (an absolute path), or ask the user to choose one in the Analyze tab");
      if (!folder.startsWith("/")) throw new Error("folder must be an absolute path");
      if (folder !== store.folder) store.setFolder(folder);
      if (args.contentAware !== undefined) store.setContentAware(bool(args, "contentAware"));
      const brief = optStr(args, "brief");
      if (brief !== undefined) store.setBrief(brief);
      if (args.dedupe !== undefined) store.setDedupe(bool(args, "dedupe"));
      const segments = optNum(args, "segmentsPerClip");
      if (segments !== undefined) store.setOption("maxSegments", segments as AnalyzerOptions["maxSegments"]);
      const seconds = optNum(args, "segmentSeconds");
      if (seconds !== undefined) store.setOption("windowSec", seconds);

      const now = useBrollStore.getState();
      const params = runParams(now);
      const notes = [brief && !params.contentAware ? "the brief needs contentAware, so it wasn't used" : "", args.dedupe === true && !params.contentAware ? "dedupe needs contentAware, so it wasn't used" : ""].filter(Boolean);
      const stop = cancelOnStop();
      let job;
      try {
        job = await runJob("broll-analyze", `Analyze ${folderName(folder)}`, analysisRequest(folder, params, now.workers), (id) => {
          useBrollStore.getState().setAnalyzeJob(id);
          stop.started(id);
        });
      } finally {
        stop.done();
      }
      if (stop.stopped()) throw new Error("Stopped by the user");
      const result = job?.result as AnalyzeResult | undefined;
      if (job?.status !== "done" || !result || !Array.isArray(result.ranked)) throw new Error(job?.error ?? "The analysis didn't finish");
      if (useBrollStore.getState().folder === folder) useBrollStore.getState().keepResult(folder, params, result);
      const chosen = currentSelects();
      const top = result.ranked.slice(0, LISTED_CLIPS);
      return {
        summary: `Analyzed ${folderName(folder)}: ${result.ranked.length} clip(s) ranked (${result.cached} from the cache)${result.failed.length ? `, ${result.failed.length} failed` : ""}${result.duplicates ? `, ${result.duplicates} near-duplicate(s)` : ""}${chosen ? `; the selects keep ${chosen.segments} segment(s), ${clock(chosen.seconds)}` : ""}${notes.length ? `; ${notes.join("; ")}` : ""}`,
        result: {
          folder,
          contentAware: params.contentAware,
          ...(params.brief ? { brief: params.brief } : {}),
          ranked: result.ranked.length,
          best: top.map(clipLine),
          ...(result.failed.length ? { failed: result.failed.slice(0, 10).map((f) => ({ file: f.path.split("/").pop(), message: f.message })) } : {}),
          ...(result.warnings.length ? { warnings: result.warnings.slice(0, 5) } : {}),
          ...(chosen ? { selects: { clips: chosen.clips.length, segments: chosen.segments, seconds: round1(chosen.seconds) } } : {}),
        },
      };
    },

    export_broll_selects: async (args) => {
      const outputPath = optStr(args, "outputPath")?.trim();
      if (outputPath !== undefined && (!outputPath.startsWith("/") || !outputPath.toLowerCase().endsWith(".xml"))) throw new Error("outputPath must be an absolute path ending in .xml");
      applySelection(args);
      const chosen = chosenOrExplain();
      const done = await exportSelectsXml(chosen, undefined, outputPath);
      if (!done) return { summary: "The user cancelled the save dialog; nothing was written", result: { cancelled: true } };
      return { summary: done.text, result: { path: done.path, clips: chosen.clips.length, segments: chosen.segments, seconds: round1(chosen.seconds) } };
    },

    build_broll_selects_timeline: async (args) => {
      applySelection(args);
      const chosen = chosenOrExplain();
      const text = await buildSelectsTimeline(chosen);
      return { summary: text, result: { clips: chosen.clips.length, segments: chosen.segments, seconds: round1(chosen.seconds) } };
    },
  };
}

export const ANALYZER_INSTRUCTION = `- B-roll Analyzer: analyze_broll_folder scores a folder of footage (the Analyze tab's, or one the
  user names) and picks each clip's best segments; then export_broll_selects writes them as an XML for
  Premiere or Resolve, or build_broll_selects_timeline makes them a new timeline. The Analyze tab shows
  the same run and selects, so the user can untick segments there before you export or build.`;
