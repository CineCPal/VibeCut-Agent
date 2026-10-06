/**
 * The Story Editor's plan types from VibeCut's src/lib/sidecarResults.ts, which hostDraft.ts's
 * `draftFromPlan` takes (PLAN.md, "Phase 6b"), and (6d) the parser of the Story Editor's result.
 */

export interface RoughCutSegment {
  track: "main" | "broll";
  /** Path of the source's video, or null when the transcript was not linked to one. */
  mediaPath: string | null;
  /** Name shown for the cut (the video's file name). */
  name: string;
  /** The stretch of the source video, in seconds. */
  sourceIn: number;
  sourceOut: number;
  /** Where the cut starts within the rough cut, in seconds from its start. */
  start: number;
  /** For B-roll: the sound the tool asked for ("silent", "full" or "duck_main"). */
  audioMode: string;
  /** For "duck_main" B-roll: how much to lower the main cuts it overlaps, in dB (negative). Unused otherwise. */
  duckDb: number;
}

export interface RoughCutPlan {
  sequenceName: string;
  /** Main cuts in order, then B-roll cuts. */
  segments: RoughCutSegment[];
  /** How many cuts the tool returned that this could not read at all. */
  unreadable: number;
}

// Phase 6d: VibeCut's `roughCutPlan` / `roughCutSummary`, reading an `assemble` job's `result` (the
// shape vibecut_agent/story/assemble.py emits, as rough-cut-studio's headless.py `_finish` does).

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
const str = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined);

export interface RoughCutSummary {
  sequenceName: string;
  narrativeSummary: string;
  segmentCount: number;
  runtimeLabel: string | null;
  warnings: string[];
}

export function roughCutSummary(r: Record<string, unknown> | null): RoughCutSummary | null {
  if (!r) return null;
  const duration = isRecord(r.duration) ? r.duration : {};
  return {
    sequenceName: str(r.sequenceName) ?? "Rough cut",
    narrativeSummary: str(r.narrativeSummary) ?? "",
    segmentCount: Array.isArray(r.resolvedSegments) ? r.resolvedSegments.length : 0,
    runtimeLabel: str(duration.main_runtime_label) ?? null,
    warnings: Array.isArray(r.warnings) ? r.warnings.filter((w): w is string => typeof w === "string") : [],
  };
}

/** The cuts of a finished Story Editor job, checked field by field. Null for a job with no result. */
export function roughCutPlan(r: Record<string, unknown> | null): RoughCutPlan | null {
  if (!r) return null;
  const media = isRecord(r.media) ? r.media : {};
  const raw = Array.isArray(r.resolvedSegments) ? r.resolvedSegments : [];
  let unreadable = 0;
  const main: RoughCutSegment[] = [];
  const broll: RoughCutSegment[] = [];
  let running = 0;
  for (const item of raw) {
    const seg = isRecord(item) ? item : null;
    const sourceIn = seg ? num(seg.in_seconds) : undefined;
    const sourceOut = seg ? num(seg.out_seconds) : undefined;
    if (!seg || sourceIn === undefined || sourceOut === undefined || sourceIn < 0 || sourceOut <= sourceIn) {
      unreadable++;
      continue;
    }
    const isBroll = seg.track === "broll";
    const sourceId = str(seg.source_id);
    const mediaPath = sourceId ? (str(media[sourceId]) ?? null) : null;
    // Main cuts play one after another; a B-roll cut has its own start.
    const given = num(seg.timeline_start_seconds);
    const start = isBroll ? Math.max(0, given ?? 0) : running;
    if (!isBroll) running += sourceOut - sourceIn;
    (isBroll ? broll : main).push({
      track: isBroll ? "broll" : "main",
      mediaPath,
      name: str(seg.source_name) ?? (mediaPath ? (mediaPath.split("/").pop() ?? mediaPath) : (sourceId ?? "Clip")),
      sourceIn,
      sourceOut,
      start,
      audioMode: str(seg.audio_mode) ?? "silent",
      duckDb: num(seg.duck_db) ?? -12,
    });
  }
  return { sequenceName: str(r.sequenceName) ?? "Rough cut", segments: [...main, ...broll], unreadable };
}
