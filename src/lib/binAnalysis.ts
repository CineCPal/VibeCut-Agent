/**
 * Bin analysis (PLAN.md, "Bin analysis & visual clip selection"): the B-roll Analyzer on a bin of the
 * connected editor's project, its scores blended with the local vision model's shot tags where the bin has
 * been indexed, and each analyzed bin's selects built as a NEW timeline with a scored marker per segment.
 *
 * Two vision stacks, layered: the Analyzer (OpenCV quality, plus SigLIP 2 energy and brief match when
 * content-aware) scores and picks segments; the Qwen-VL tags `index_bin_visuals` leaves in each file's
 * `.vlm-tags.json` say what those segments show and how usable the shots are.
 */
import { analysisRequest, buildTimelineFromSegments, type BuiltTimeline } from "./broll";
import { selects, segmentsOf } from "./brollSelects";
import { binLeaf, groupByFolder, resolveBin, type BinFiles } from "./binClips";
import { runJob } from "./jobs";
import { nleCall } from "./ipc";
import { draftOf } from "./agent/draft";
import { HOST_SHORT } from "./agent/edits";
import { useBinRunStore, type BinRankedClip, type BinRun, type ShotTag } from "../store/useBinRunStore";
import type { AnalyzerOptions, RunParams } from "../store/useBrollStore";
import type { AnalyzeResult, RankedClip } from "../types/broll";
import type { NleHost } from "../types/nle";

/** How much the tagged shots' usability counts in a clip's selection score (the rest is the Analyzer's). */
export const USABILITY_WEIGHT = 0.25;
/** The most files one vlm-tags read takes (vector_search_cmd.MAX_TAG_FILES). */
const TAG_BATCH = 2000;
/** The most markers one add_markers call takes (premiere.py / resolve.py MAX_MARKERS_PER_CALL). */
const MARKER_BATCH = 500;

/** Starts a job and says whether the user stopped the turn (storyTools.cancelOnStop's shape). */
export interface StopWatch {
  started: (id: string) => void;
  stopped: () => boolean;
}

const NO_STOP: StopWatch = { started: () => undefined, stopped: () => false };

/** Each file's tagged shots, or null for a file with no (current) tags. Nothing is looked at anew. */
export async function readShotTags(paths: string[], stop: StopWatch = NO_STOP): Promise<Map<string, ShotTag[] | null>> {
  const out = new Map<string, ShotTag[] | null>();
  for (let i = 0; i < paths.length; i += TAG_BATCH) {
    const batch = paths.slice(i, i + TAG_BATCH);
    const job = await runJob("vlm-tags", `Read shot tags of ${batch.length} file(s)`, { paths: batch }, stop.started);
    const files = (job?.result as { files?: { path: string; shots: ShotTag[] | null }[] } | undefined)?.files;
    if (job?.status !== "done" || !Array.isArray(files)) throw new Error(job?.error ?? "The shot tags couldn't be read");
    for (const f of files) out.set(f.path, f.shots);
  }
  return out;
}

const overlap = (a: { start: number; end: number }, b: { start: number; end: number }) => Math.max(0, Math.min(a.end, b.end) - Math.max(a.start, b.start));
const round1 = (n: number) => Math.round(n * 10) / 10;

/** A clip with its selection score: the Analyzer's, blended with the mean usability of the tagged shots its
 * segments cover (weighted by how long each covers them), and what its best segment shows. */
export function fuse(clip: RankedClip, shots: ShotTag[] | null | undefined): BinRankedClip {
  const base = { ...clip, analyzerScore: clip.score, usability: null, visual: null };
  if (!shots?.length) return base;
  let weighted = 0;
  let covered = 0;
  for (const segment of segmentsOf(clip)) {
    for (const shot of shots) {
      const o = overlap(segment, shot);
      if (o > 0 && typeof shot.editorial_usability_score === "number") {
        weighted += shot.editorial_usability_score * o;
        covered += o;
      }
    }
  }
  const best = { start: clip.bestStart, end: clip.bestEnd };
  const seen = shots.reduce<{ shot: ShotTag; o: number } | null>((top, shot) => {
    const o = overlap(best, shot);
    return o > 0 && (!top || o > top.o) ? { shot, o } : top;
  }, null);
  const usability = covered > 0 ? weighted / covered : null;
  return {
    ...base,
    score: usability === null ? clip.score : round1((1 - USABILITY_WEIGHT) * clip.score + USABILITY_WEIGHT * usability),
    usability: usability === null ? null : Math.round(usability),
    visual: seen
      ? { description: seen.shot.description, tags: seen.shot.visual_tags.slice(0, 8), shotScale: seen.shot.shot_scale, movement: seen.shot.camera_movement }
      : null,
  };
}

export interface BinAnalysisOptions {
  params: RunParams;
  workers: number | null;
  /** Blend in the shot tags (default true). */
  useVisualTags: boolean;
  timeline?: string | null;
  stop?: StopWatch;
}

/** Scores a bin's picture clips folder by folder (the Analyzer's `files`), blends in their shot tags and
 * keeps the run for build_bin_selects. */
export async function analyzeBin(host: NleHost, bin: string, options: BinAnalysisOptions): Promise<{ run: BinRun; bin: BinFiles; cancelled: boolean }> {
  const stop = options.stop ?? NO_STOP;
  const files = await resolveBin(host, bin, options.timeline);
  if (!files.clips.length) {
    const why = files.skipped.length ? ` (${files.skipped.length} clip(s) left out: ${files.skipped[0].name}, ${files.skipped[0].reason})` : "";
    throw new Error(`The bin "${files.binPath}" has no video clips with a local media file${why}`);
  }
  const ranked: RankedClip[] = [];
  const failed: AnalyzeResult["failed"] = [];
  const warnings: string[] = [];
  let analyzed = 0;
  let cached = 0;
  let duplicates = 0;
  let cancelled = false;
  const groups = groupByFolder(files.clips.map((c) => c.filePath));
  for (const [i, group] of groups.entries()) {
    if (stop.stopped()) {
      cancelled = true;
      break;
    }
    const label = `Analyze ${binLeaf(files.binPath)}${groups.length > 1 ? ` (${i + 1}/${groups.length})` : ""}`;
    const job = await runJob("broll-analyze", label, { ...analysisRequest(group.folder, options.params, options.workers), files: group.files }, stop.started);
    const result = job?.result as AnalyzeResult | undefined;
    if (stop.stopped() || result?.cancelled) {
      cancelled = true;
      if (result && Array.isArray(result.ranked)) ranked.push(...result.ranked);
      break;
    }
    if (job?.status !== "done" || !result || !Array.isArray(result.ranked)) {
      // One folder failing (moved, unreadable) leaves the others' scores standing.
      failed.push(...group.files.map((path) => ({ path, message: job?.error ?? "The analysis didn't finish" })));
      continue;
    }
    ranked.push(...result.ranked);
    failed.push(...result.failed);
    warnings.push(...result.warnings);
    analyzed += result.analyzed;
    cached += result.cached;
    duplicates += result.duplicates;
  }
  if (!ranked.length && !cancelled) throw new Error(failed[0]?.message ?? "No clip of the bin could be analyzed");

  const tags = options.useVisualTags && ranked.length && !stop.stopped() ? await readShotTags(ranked.map((c) => c.path), stop).catch(() => new Map<string, ShotTag[] | null>()) : new Map<string, ShotTag[] | null>();
  const fused = ranked.map((c) => fuse(c, tags.get(c.path))).sort((a, b) => b.score - a.score);
  const run: BinRun = {
    host,
    binPath: files.binPath,
    at: Date.now(),
    contentAware: options.params.contentAware,
    brief: options.params.brief,
    ranked: fused,
    analyzed,
    cached,
    failed,
    warnings,
    duplicates,
    skipped: files.skipped,
    tagged: [...tags.values()].filter((s) => s?.length).length,
  };
  if (!cancelled) useBinRunStore.getState().keepRun(run);
  return { run, bin: files, cancelled };
}

export type BinSelectOptions = Pick<AnalyzerOptions, "topMode" | "topN" | "minScore" | "sequenceOrder">;

/** The selects sequence's name for a bin. */
export const selectsName = (binPath: string) => `${binLeaf(binPath)} — B-roll selects`;

/** Green from 75, yellow from 50, red below; all three are marker colours in both editors. */
export function scoreColor(score: number): "Green" | "Yellow" | "Red" {
  return score >= 75 ? "Green" : score >= 50 ? "Yellow" : "Red";
}

/** What a segment's marker says: the clip and its score, then what the shot shows (tagged), else its energy
 * and brief match. Names stay short; the note carries the rest. */
export function markerFor(clip: BinRankedClip, at: number, length: number): { time: number; name: string; color: string; note: string; duration: number } {
  const facts: string[] = [`Score ${Math.round(clip.score)}`];
  if (clip.usability !== null) facts.push(`analyzer ${Math.round(clip.analyzerScore)}, usability ${clip.usability}`);
  if (clip.energy !== null) facts.push(`energy ${Math.round(clip.energy)}`);
  if (clip.relevance !== null) facts.push(`brief ${Math.round(clip.relevance)}`);
  const lines = [facts.join(" · ")];
  if (clip.visual) {
    const kind = [clip.visual.shotScale, clip.visual.movement].filter(Boolean).join(", ");
    lines.push(`${kind ? `${kind}: ` : ""}${clip.visual.description}`.trim());
    if (clip.visual.tags.length) lines.push(`Tags: ${clip.visual.tags.join(", ")}`);
  }
  return {
    time: at,
    name: `${clip.filename} · ${Math.round(clip.score)}`.slice(0, 120),
    color: scoreColor(clip.score),
    note: lines.join("\n").slice(0, 1000),
    duration: Math.max(0, Math.round(length * 1000) / 1000),
  };
}

export interface BinBuild extends BuiltTimeline {
  binPath: string;
  markers: number;
  markerProblem?: string;
}

/** Builds one analyzed bin's selects as a NEW timeline in its editor, with a marker per segment. The user's
 * timeline isn't changed; Revert takes the clips back (the timeline itself stays, as for create_timeline). */
export async function buildBinSelects(run: BinRun, selection: BinSelectOptions, options: { markers: boolean; onProgress?: (text: string) => void }): Promise<BinBuild> {
  if (draftOf(run.host)) throw new Error(`A Story Editor draft is open in ${HOST_SHORT[run.host]}; send or discard it first`);
  const chosen = selects(run.ranked, selection, {}, true);
  if (!chosen.clips.length) throw new Error(`The selection keeps no segments of "${run.binPath}"; loosen it (include, best, minScore)`);
  const built = await buildTimelineFromSegments(run.host, selectsName(run.binPath), chosen.clips, `the "${binLeaf(run.binPath)}" bin`, options.onProgress);
  const out: BinBuild = { ...built, binPath: run.binPath, markers: 0 };
  if (!options.markers || !built.layout.length) return out;
  const byPath = new Map(run.ranked.map((c) => [c.path, c]));
  const markers = built.layout.flatMap((s) => {
    const clip = byPath.get(s.path);
    return clip ? [markerFor(clip, s.at, s.sourceOut - s.sourceIn)] : [];
  });
  try {
    for (let i = 0; i < markers.length; i += MARKER_BATCH) {
      const result = await nleCall<{ added?: unknown[] }>(run.host, "add_markers", { timeline: built.timeline, markers: markers.slice(i, i + MARKER_BATCH) });
      out.markers += result.added?.length ?? 0;
    }
  } catch (error) {
    // The clips are in; a marker the editor refuses shouldn't undo the build.
    out.markerProblem = error instanceof Error ? error.message : String(error);
  }
  return out;
}
