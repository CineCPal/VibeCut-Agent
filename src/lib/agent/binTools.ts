/**
 * The agent's tools for the project's bins (PLAN.md, "Bin analysis & visual clip selection"): the B-roll
 * Analyzer on a bin (analyze_bin), each analyzed bin's selects built as a NEW timeline with scored markers
 * (build_bin_selects), a bin looked at and indexed by the local vision workers (index_bin_visuals), and a
 * search of that index by what the shots show (find_clips_by_content, direct mode; the orchestrated chat has
 * semantic_asset_search).
 *
 * The Analyze tab's folder and selects aren't touched: bin runs are kept in useBinRunStore.
 */
import { analyzeBin, buildBinSelects, type BinBuild, type BinSelectOptions } from "../binAnalysis";
import { binLeaf, pickBin, resolveBin } from "../binClips";
import { runJob } from "../jobs";
import { runParams, useBrollStore, type RunParams } from "../../store/useBrollStore";
import { runsOf, useBinRunStore, type BinRankedClip, type BinRun } from "../../store/useBinRunStore";
import type { NleHost } from "../../types/nle";
import { bool, optNum, optStr, type Args, type Executor } from "./args";
import { HOST_SHORT, TIMELINE_NOUN } from "./edits";
import { cancelOnStop } from "./storyTools";
import type { ToolContext, ToolDeclaration } from "./tools";

/** How many ranked clips a result lists (the run keeps them all). */
export const LISTED_BIN_CLIPS = 15;
/** The most files one ingest-index run takes (ingest_pipeline.MAX_FILES). */
const INGEST_BATCH = 500;
export const SHOT_SCALES = ["ECU", "CU", "MCU", "MS", "MWS", "WS", "EWS", "INSERT", "OTS", "TWO_SHOT"];
export const CAMERA_MOVES = ["STATIC", "PAN_LEFT", "PAN_RIGHT", "TILT_UP", "TILT_DOWN", "DOLLY_IN", "DOLLY_OUT", "HANDHELD", "GIMBAL_TRACK", "ZOOM"];

const round1 = (n: number) => Math.round(n * 10) / 10;
const clock = (s: number) => `${round1(s)}s`;
const count = (n: number, noun: string) => `${n} ${noun}${n === 1 ? "" : "s"}`;

/** A ranked clip as the agent reads it. */
function clipLine(c: BinRankedClip): Record<string, unknown> {
  const segments = c.segments.length ? c.segments : [{ start: c.bestStart, end: c.bestEnd }];
  return {
    file: c.filename,
    path: c.path,
    score: round1(c.score),
    ...(c.usability !== null ? { analyzerScore: round1(c.analyzerScore), usability: c.usability } : {}),
    segments: segments.map((s) => `${clock(s.start)}–${clock(s.end)}`),
    ...(c.energy !== null ? { energy: Math.round(c.energy) } : {}),
    ...(c.relevance !== null ? { relevance: Math.round(c.relevance) } : {}),
    ...(c.visual ? { shows: c.visual.description, shot: [c.visual.shotScale, c.visual.movement].filter(Boolean).join(" "), tags: c.visual.tags } : {}),
    ...(c.duplicateOf ? { duplicateOf: c.duplicateOf } : {}),
  };
}

/** The run's scoring options: the Analyze tab's, with what the call changes (the tab itself isn't changed). */
export function binParams(args: Args): { params: RunParams; notes: string[] } {
  const s = useBrollStore.getState();
  const contentAware = args.contentAware !== undefined ? bool(args, "contentAware") : s.contentAware;
  const brief = optStr(args, "brief") ?? s.brief;
  const dedupe = args.dedupe !== undefined ? bool(args, "dedupe") : s.dedupe;
  const segments = optNum(args, "segmentsPerClip");
  if (segments !== undefined && (!Number.isInteger(segments) || segments < 1 || segments > 20)) throw new Error("segmentsPerClip must be 1 to 20");
  const seconds = optNum(args, "segmentSeconds");
  if (seconds !== undefined && (seconds < 0.5 || seconds > 120)) throw new Error("segmentSeconds must be 0.5 to 120");
  const params = runParams({ ...s, contentAware, brief, dedupe, maxSegments: segments ?? s.maxSegments, windowSec: seconds ?? s.windowSec });
  const notes = [
    optStr(args, "brief") && !contentAware ? "the brief needs contentAware, so it wasn't used" : "",
    args.dedupe === true && !contentAware ? "dedupe needs contentAware, so it wasn't used" : "",
  ].filter(Boolean);
  return { params, notes };
}

/** The selection: all, the best N, or a minimum score, best first or by name (default the Analyze tab's). */
export function binSelection(args: Args): BinSelectOptions {
  const s = useBrollStore.getState();
  const out: BinSelectOptions = { topMode: s.topMode, topN: s.topN, minScore: s.minScore, sequenceOrder: s.sequenceOrder };
  const mode = optStr(args, "include");
  if (mode !== undefined) {
    if (mode !== "all" && mode !== "best" && mode !== "minScore") throw new Error('include must be "all", "best" or "minScore"');
    out.topMode = mode === "best" ? "topn" : mode === "minScore" ? "threshold" : "all";
  }
  const best = optNum(args, "best");
  if (best !== undefined) {
    if (!Number.isInteger(best) || best < 1) throw new Error("best must be a whole number from 1");
    out.topN = best;
  }
  const minScore = optNum(args, "minScore");
  if (minScore !== undefined) {
    if (minScore < 0 || minScore > 100) throw new Error("minScore must be 0 to 100");
    out.minScore = minScore;
  }
  const order = optStr(args, "order");
  if (order !== undefined) {
    if (order !== "score" && order !== "name") throw new Error('order must be "score" or "name"');
    out.sequenceOrder = order;
  }
  return out;
}

/** The analyzed runs `bins` names (default: the latest one), in this editor. */
export function runsFor(host: NleHost, bins: string[] | undefined): BinRun[] {
  const runs = runsOf(host);
  if (!runs.length) throw new Error(`No bin of the ${HOST_SHORT[host]} project has been analyzed yet; call analyze_bin first`);
  if (!bins?.length) return [runs[0]];
  const paths = runs.map((r) => r.binPath);
  return bins.map((text) => {
    try {
      const path = pickBin(paths, text);
      return runs.find((r) => r.binPath === path) as BinRun;
    } catch {
      throw new Error(`"${text}" isn't an analyzed bin; analyzed: ${paths.map((p) => `"${p}"`).join(", ")}. Call analyze_bin for it first`);
    }
  });
}

function binsArg(args: Args): string[] | undefined {
  const raw = args.bins;
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw) || raw.some((b) => typeof b !== "string" || !b.trim())) throw new Error("bins must list bin names or paths");
  return raw as string[];
}

/** One `vibecut.vector.v1` hit, as vector_store.py writes it. */
interface VectorHit {
  rank: number;
  media_path: string;
  filename: string;
  source_range: { start_time: { value: number; rate: number }; duration: { value: number; rate: number } };
  scores: { rrf_combined: number; technical_quality: number | null };
  evidence: {
    matched_modality: string;
    transcript_excerpt: string | null;
    speaker: string | null;
    shot_scale: string | null;
    camera_movement: string | null;
    vlm_description: string | null;
    visual_tags: string[] | null;
  };
}

const seconds = (t: { value: number; rate: number }) => (t.rate ? t.value / t.rate : 0);

function enumList(args: Args, key: string, allowed: string[]): string[] | undefined {
  const raw = args[key];
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw) || !raw.length || raw.some((v) => typeof v !== "string" || !allowed.includes(v.toUpperCase()))) {
    throw new Error(`${key} must list some of ${allowed.join(", ")}`);
  }
  return (raw as string[]).map((v) => v.toUpperCase());
}

/** The vision model and the index must be on the model server before a long ingest starts. */
async function checkVisionModels(): Promise<void> {
  const job = await runJob("vlm-tags", "Check the local vision models", { paths: [], health: true });
  const health = (job?.result as { health?: Record<string, { model: string | null; available: boolean; detail: string }> } | undefined)?.health;
  if (job?.status !== "done" || !health) throw new Error(job?.error ?? "The local vision models couldn't be checked");
  const missing = (["vlm", "vector"] as const).filter((name) => !health[name]?.available);
  if (!missing.length) return;
  const said = missing.map((name) => {
    const h = health[name];
    const what = name === "vlm" ? "vision model" : "embedding model";
    return `the ${what}${h?.model ? ` ${h.model}` : ""} isn't ready (${h?.detail || "unavailable"})`;
  });
  throw new Error(`Can't index yet: ${said.join("; ")}. Start Ollama and pull the model (e.g. "ollama pull ${health.vlm?.model ?? "qwen3-vl:8b-instruct"}"), or set VIBECUT_VLM_MODEL / VIBECUT_EMBED_MODEL, then try again.`);
}

export function binToolDeclarations(host: NleHost): ToolDeclaration[] {
  const noun = TIMELINE_NOUN[host];
  const bins = host === "premiere" ? "the Premiere project's bins" : "Resolve's Media Pool folders (bins)";
  const binProp = { type: "STRING", description: 'A bin\'s name or path ("Drone", "Footage/Drone"); its sub-bins count too.' };
  return [
    {
      name: "analyze_bin",
      description: `Scores the video clips in one of ${bins} with the B-roll Analyzer (sharpness, exposure, stability; with contentAware also energy, a brief match and near-duplicate takes) and picks each clip's best segments. Where index_bin_visuals has tagged the bin's shots, each clip's score blends in the shots' usability and the result says what its best segment shows. Runs locally, folder by folder; results are cached. contentAware needs a 2 GB model download the first time, so turn it on only when the user asked for it or agreed. Lists the best ${LISTED_BIN_CLIPS}; then build_bin_selects. Doesn't change the Analyze tab or the ${noun}.`,
      parameters: {
        type: "OBJECT",
        properties: {
          bin: binProp,
          contentAware: { type: "BOOLEAN", description: "Optional; default the Analyze tab's setting." },
          brief: { type: "STRING", description: "What the B-roll is for, to rank by (content-aware only). Optional." },
          dedupe: { type: "BOOLEAN", description: "Mark near-duplicate takes and leave them out of the selects (content-aware only). Optional." },
          segmentsPerClip: { type: "NUMBER", description: "1 to 20. Optional; default the tab's." },
          segmentSeconds: { type: "NUMBER", description: "Length of each segment, 0.5 to 120. Optional; default the tab's." },
          useVisualTags: { type: "BOOLEAN", description: "Blend in the shot tags where there are any. Optional; default true." },
        },
        required: ["bin"],
      },
    },
    {
      name: "build_bin_selects",
      description: `Builds each analyzed bin's selects as a NEW ${noun} in ${HOST_SHORT[host]}, named "<bin> — B-roll selects": the chosen segments back to back, picture and sound, best first (or by name), with a marker on each segment giving its score and, where tagged, what it shows. The open ${noun} isn't changed; Revert takes the clips back. bins: names or paths of bins analyze_bin scored (default: the latest one).`,
      parameters: {
        type: "OBJECT",
        properties: {
          bins: { type: "ARRAY", items: { type: "STRING" }, description: "Optional; default the latest analyzed bin." },
          include: { type: "STRING", enum: ["all", "best", "minScore"], description: "Which clips: every one, the best N, or those scoring at least minScore. Optional; default the Analyze tab's." },
          best: { type: "NUMBER", description: 'With include "best": how many per bin. Optional.' },
          minScore: { type: "NUMBER", description: 'With include "minScore": 0 to 100. Optional.' },
          order: { type: "STRING", enum: ["score", "name"], description: "Best first, or by file name. Optional." },
          markers: { type: "BOOLEAN", description: "A marker per segment. Optional; default true." },
        },
      },
    },
    {
      name: "index_bin_visuals",
      description: `Has the local vision model look at every shot of the video clips in one of ${bins} (shot scale, camera movement, light, a description, tags and a usability score, saved next to each file) and adds them to the local search index, so semantic_asset_search / find_clips_by_content find shots by what they show and analyze_bin blends the tags in. Needs Ollama with the vision and embedding models. It takes a while (seconds a shot) and uses most of the machine's memory, so ask the user first. Files already looked at are reused unless force. transcribe also indexes what's said.`,
      parameters: {
        type: "OBJECT",
        properties: {
          bin: binProp,
          transcribe: { type: "BOOLEAN", description: "Also transcribe and index the dialogue. Optional; default false." },
          force: { type: "BOOLEAN", description: "Look again even where tags exist. Optional; default false." },
        },
        required: ["bin"],
      },
    },
    {
      name: "find_clips_by_content",
      description: `Searches the local index of shots (and lines, with modality "dialogue" or "hybrid") by what they show: e.g. "wide static shot of the harbor at dusk". Covers files index_bin_visuals (or an ingest) indexed; bin limits it to one of ${bins}. Each hit is a stretch of a file (path, start, end in its seconds) with its shot scale, movement, description and quality, ready for look_at_media to check and add_clips to place.`,
      parameters: {
        type: "OBJECT",
        properties: {
          query: { type: "STRING", description: "What the shot shows (or what's said)." },
          bin: { type: "STRING", description: "Only this bin's clips. Optional." },
          modality: { type: "STRING", enum: ["visual", "dialogue", "hybrid"], description: 'Optional; default "visual".' },
          shotScales: { type: "ARRAY", items: { type: "STRING", enum: SHOT_SCALES }, description: "Only these shot sizes. Optional." },
          cameraMoves: { type: "ARRAY", items: { type: "STRING", enum: CAMERA_MOVES }, description: "Only these camera movements. Optional." },
          minQuality: { type: "NUMBER", description: "Least usability/technical score, 0 to 100. Optional." },
          topK: { type: "NUMBER", description: "1 to 25. Optional; default 8." },
        },
        required: ["query"],
      },
    },
  ];
}

export function binExecutors(context: ToolContext): Record<string, Executor> {
  const { host } = context;
  const timeline = () => context.timeline;

  return {
    analyze_bin: async (args) => {
      const bin = optStr(args, "bin")?.trim();
      if (!bin) throw new Error('bin must name a bin, e.g. "Drone"');
      const { params, notes } = binParams(args);
      const stop = cancelOnStop();
      let outcome;
      try {
        outcome = await analyzeBin(host, bin, {
          params,
          workers: useBrollStore.getState().workers,
          useVisualTags: args.useVisualTags === undefined ? true : bool(args, "useVisualTags"),
          timeline: timeline(),
          stop,
        });
      } finally {
        stop.done();
      }
      if (outcome.cancelled) throw new Error("Stopped by the user");
      const { run } = outcome;
      const leaf = binLeaf(run.binPath);
      const parts = [`Analyzed "${leaf}": ${count(run.ranked.length, "clip")} ranked (${run.cached} from the cache)`];
      if (run.tagged) parts.push(`${run.tagged} with shot tags blended in`);
      if (run.failed.length) parts.push(`${run.failed.length} failed`);
      if (run.duplicates) parts.push(`${run.duplicates} near-duplicate(s)`);
      if (run.skipped.length) parts.push(`${run.skipped.length} left out (no local file)`);
      if (outcome.bin.truncated) parts.push("the project is bigger than one read lists, so some clips may be missing");
      parts.push(...notes);
      return {
        summary: parts.join(", "),
        result: {
          bin: run.binPath,
          contentAware: run.contentAware,
          ...(run.brief ? { brief: run.brief } : {}),
          ranked: run.ranked.length,
          tagged: run.tagged,
          ...(run.tagged ? {} : { note: "No clip of the bin has shot tags; index_bin_visuals adds them (ask the user first)." }),
          best: run.ranked.slice(0, LISTED_BIN_CLIPS).map(clipLine),
          ...(run.failed.length ? { failed: run.failed.slice(0, 10).map((f) => ({ file: f.path.split("/").pop(), message: f.message })) } : {}),
          ...(run.skipped.length ? { skipped: run.skipped.slice(0, 10) } : {}),
          ...(run.warnings.length ? { warnings: run.warnings.slice(0, 5) } : {}),
        },
      };
    },

    build_bin_selects: async (args) => {
      const runs = runsFor(host, binsArg(args));
      const selection = binSelection(args);
      const markers = args.markers === undefined ? true : bool(args, "markers");
      const built: BinBuild[] = [];
      const problems: string[] = [];
      for (const run of runs) {
        try {
          built.push(await buildBinSelects(run, selection, { markers }));
        } catch (error) {
          problems.push(`"${binLeaf(run.binPath)}": ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      if (!built.length) throw new Error(problems.join("; "));
      const lines = built.map((b) => {
        const extra = [b.markers ? `${count(b.markers, "marker")}` : "", b.markerProblem ? `markers failed: ${b.markerProblem}` : ""].filter(Boolean).join("; ");
        return `${b.text}${extra ? ` (${extra})` : ""}`;
      });
      return {
        summary: [...lines, ...problems.map((p) => `Couldn't build ${p}`)].join(" "),
        result: {
          timelines: built.map((b) => ({
            bin: b.binPath,
            timeline: b.timeline,
            segments: b.layout.length,
            seconds: round1(b.seconds),
            markers: b.markers,
            ...(b.refused.length ? { refused: b.refused.slice(0, 5) } : {}),
            ...(b.markerProblem ? { markerProblem: b.markerProblem } : {}),
          })),
          ...(problems.length ? { problems } : {}),
        },
      };
    },

    index_bin_visuals: async (args) => {
      const bin = optStr(args, "bin")?.trim();
      if (!bin) throw new Error('bin must name a bin, e.g. "Drone"');
      const files = await resolveBin(host, bin, timeline());
      if (!files.clips.length) throw new Error(`The bin "${files.binPath}" has no video clips with a local media file`);
      await checkVisionModels();
      const stages = args.transcribe === true ? ["transcribe", "vision", "index"] : ["vision", "index"];
      const paths = files.clips.map((c) => c.filePath);
      const stop = cancelOnStop();
      const done: { path: string; shots?: number; indexed?: number; errors?: string[] }[] = [];
      try {
        for (let i = 0; i < paths.length; i += INGEST_BATCH) {
          if (stop.stopped()) break;
          const batch = paths.slice(i, i + INGEST_BATCH);
          const job = await runJob(
            "ingest-index",
            `Index ${binLeaf(files.binPath)}'s shots${paths.length > INGEST_BATCH ? ` (${i + 1}–${i + batch.length})` : ""}`,
            { paths: batch, stages, sampleStrategy: "scene_cuts", ...(args.force === true ? { force: true } : {}) },
            stop.started,
          );
          const result = job?.result as { files?: typeof done } | undefined;
          if (Array.isArray(result?.files)) done.push(...result.files);
          else if (!stop.stopped()) throw new Error(job?.error ?? "The indexing didn't finish");
        }
      } finally {
        stop.done();
      }
      const shots = done.reduce((sum, f) => sum + (f.shots ?? 0), 0);
      const failed = done.filter((f) => f.errors?.length);
      useBinRunStore.getState().keepIndex({ host, binPath: files.binPath, at: Date.now(), files: done.length, shots, failed: failed.length });
      if (stop.stopped()) {
        return { summary: `Stopped indexing "${binLeaf(files.binPath)}" after ${count(done.length, "file")}`, result: { bin: files.binPath, files: done.length, shots, stopped: true } };
      }
      return {
        summary: `Indexed "${binLeaf(files.binPath)}": ${count(done.length, "file")}, ${count(shots, "shot")} tagged${failed.length ? `, ${failed.length} with problems` : ""}`,
        result: {
          bin: files.binPath,
          files: done.length,
          shots,
          ...(failed.length ? { problems: failed.slice(0, 10).map((f) => ({ file: f.path.split("/").pop(), errors: f.errors?.slice(0, 2) })) } : {}),
          ...(files.skipped.length ? { skipped: files.skipped.slice(0, 10) } : {}),
          next: "find_clips_by_content or semantic_asset_search find its shots by content; analyze_bin blends the tags into its scores.",
        },
      };
    },

    find_clips_by_content: async (args) => {
      const query = optStr(args, "query")?.trim();
      if (!query || query.length < 2) throw new Error("query must say what the shot shows");
      const modality = optStr(args, "modality") ?? "visual";
      if (!["visual", "dialogue", "hybrid"].includes(modality)) throw new Error('modality must be "visual", "dialogue" or "hybrid"');
      const topK = optNum(args, "topK") ?? 8;
      if (!Number.isInteger(topK) || topK < 1 || topK > 25) throw new Error("topK must be 1 to 25");
      const filters: Record<string, unknown> = {};
      const scales = enumList(args, "shotScales", SHOT_SCALES);
      if (scales) filters.shot_scales = scales;
      const moves = enumList(args, "cameraMoves", CAMERA_MOVES);
      if (moves) filters.camera_motions = moves;
      const minQuality = optNum(args, "minQuality");
      if (minQuality !== undefined) {
        if (minQuality < 0 || minQuality > 100) throw new Error("minQuality must be 0 to 100");
        filters.min_technical_score = minQuality;
      }
      const binText = optStr(args, "bin")?.trim();
      const scope = binText ? await resolveBin(host, binText, timeline()) : null;
      if (scope && !scope.clips.length) throw new Error(`The bin "${scope.binPath}" has no video clips with a local media file`);
      const job = await runJob("vector-search", `Find "${query.slice(0, 40)}"`, {
        query,
        modality,
        top_k: topK,
        ...(scope ? { scope_paths: scope.clips.map((c) => c.filePath) } : {}),
        ...(Object.keys(filters).length ? { filters } : {}),
      });
      const result = job?.result as { hits?: VectorHit[] } | undefined;
      if (job?.status !== "done" || !Array.isArray(result?.hits)) throw new Error(job?.error ?? "The search didn't finish");
      const hits = result.hits.map((h) => {
        const start = seconds(h.source_range.start_time);
        const end = start + seconds(h.source_range.duration);
        return {
          rank: h.rank,
          file: h.filename,
          path: h.media_path,
          start: round1(start),
          end: round1(end),
          score: Math.round(h.scores.rrf_combined),
          ...(h.scores.technical_quality !== null ? { quality: Math.round(h.scores.technical_quality) } : {}),
          ...(h.evidence.shot_scale ? { shot: [h.evidence.shot_scale, h.evidence.camera_movement].filter(Boolean).join(" ") } : {}),
          ...(h.evidence.vlm_description ? { shows: h.evidence.vlm_description } : {}),
          ...(h.evidence.visual_tags?.length ? { tags: h.evidence.visual_tags.slice(0, 8) } : {}),
          ...(h.evidence.transcript_excerpt ? { says: h.evidence.transcript_excerpt, speaker: h.evidence.speaker } : {}),
        };
      });
      const where = scope ? ` in "${binLeaf(scope.binPath)}"` : "";
      if (!hits.length) {
        return {
          summary: `No indexed shot${where} fits "${query}"`,
          result: { hits: [], note: `Nothing indexed matches${where}. index_bin_visuals looks at a bin's clips and indexes them (ask the user first).` },
        };
      }
      return { summary: `Found ${count(hits.length, "match")}${where} for "${query}"`, result: { query, modality, hits } };
    },
  };
}

export const BIN_INSTRUCTION = `- Bins: analyze_bin scores the video clips in a bin of the project with the B-roll Analyzer, and
  build_bin_selects builds each analyzed bin's best segments as a NEW timeline ("<bin> — B-roll selects")
  with a scored marker per segment. index_bin_visuals has the local vision model tag every shot of a bin and
  index it (slow: ask the user first); after it, analyze_bin blends the tags into its scores and
  find_clips_by_content finds shots by what they show. To choose a clip for an edit by content:
  find_clips_by_content, check the best hits with look_at_media, then place one with add_clips.`;
