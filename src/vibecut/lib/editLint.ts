// The edit lint: mechanical problems in the cut that can be found without looking at a picture —
// black holes, flash frames, cuts inside a word, jumps in level across a cut, clipping, and linked
// picture and sound that have drifted apart. Pure: everything it needs is passed in, so it is the
// same check whether the chat agent's `review_edit` tool or the automatic end-of-turn review runs it.
// The vision critic (gemini_critic.py) gets these findings too, so it doesn't have to rediscover them.
import type { ExportVideoSegment } from "../types/export";
import type { MediaAsset } from "../types/media";
import type { Clip, Track } from "../types/timeline";
import type { TranscriptWord } from "../types/transcript";
import type { WaveformPeaks } from "../types/waveform";
import { buildVideoSegments, clipHasOwnAudio } from "./export/flatten";
import { pictureOfGroup, sameTiming, syncErrorSeconds } from "./sync";
import { timelineAt } from "./timeRemap";
import { expandTransitions } from "./transitions";

export type FindingSeverity = "high" | "medium" | "low";
export type LintCategory = "black" | "flash_frame" | "mid_word_cut" | "level_jump" | "clipping" | "out_of_sync";

export interface LintFinding {
  /** Timeline seconds. */
  time: number;
  /** For a stretch (a black hole), where it ends. */
  end?: number;
  severity: FindingSeverity;
  category: LintCategory;
  message: string;
  clipIds: string[];
}

export interface LintInput {
  /** Top track first, as `sequence.trackIds` orders them. */
  tracks: Track[];
  clipsById: Record<string, Clip>;
  assetsById: Record<string, MediaAsset>;
  offline?: ReadonlySet<string>;
  frameRate: number;
  /** Word timings in source-file seconds, by asset, for the transcripts that have them. */
  wordsByAssetId?: Record<string, TranscriptWord[]>;
  /** Waveform peaks by asset, for the level and clipping checks. */
  peaksByAssetId?: Record<string, WaveformPeaks>;
}

export const LINT_LIMITS = {
  /** A visible shot shorter than this many frames reads as a flash. */
  flashFrames: 6,
  /** A cut this far inside a word (seconds, at both ends) clips it audibly. */
  midWordMargin: 0.03,
  /** Seconds either side of a cut inside a word's timing that must be silent for the cut to be fine:
   * transcribers often stretch a word over the pause before or after it. */
  midWordSilenceWindow: 0.05,
  /** A change in level across a cut this large (dB) is a jump. */
  levelJumpDb: 6,
  /** Seconds either side of a cut the level is measured over. */
  levelWindowSeconds: 1.5,
  /** Quieter than this (dBFS) is silence: a jump into or out of silence is not a level jump. */
  silentDb: -45,
  /** At or above this linear peak the sound clips (about -0.1 dBFS). */
  clippingAmplitude: 0.989,
  maxFindings: 40,
} as const;

const EPSILON = 1e-6;
const round2 = (n: number): number => Math.round(n * 100) / 100;
const toDb = (amplitude: number): number => (amplitude > 0 ? 20 * Math.log10(amplitude) : -Infinity);

interface Interval {
  start: number;
  end: number;
}

/** The parts of [from, to] no interval in `covered` reaches. */
function uncovered(from: number, to: number, covered: Interval[]): Interval[] {
  const sorted = [...covered].sort((a, b) => a.start - b.start);
  const gaps: Interval[] = [];
  let at = from;
  for (const c of sorted) {
    if (c.start > at + EPSILON) gaps.push({ start: at, end: Math.min(c.start, to) });
    at = Math.max(at, c.end);
    if (at >= to) break;
  }
  if (at < to - EPSILON) gaps.push({ start: at, end: to });
  return gaps.filter((g) => g.end - g.start > EPSILON);
}

/** The picture as it will actually be seen, one entry per unbroken stretch (see `buildVideoSegments`). */
export function visibleVideo(input: Pick<LintInput, "tracks" | "clipsById" | "assetsById" | "offline">): ExportVideoSegment[] {
  const { tracks, clipsById, assetsById } = input;
  const rendered = expandTransitions(tracks, clipsById, (clip) => assetsById[clip.mediaAssetId]?.durationSeconds ?? clip.sourceOut);
  const tracksById = Object.fromEntries(rendered.tracks.map((t) => [t.id, t]));
  return buildVideoSegments(
    rendered.tracks.map((t) => t.id),
    tracksById,
    rendered.clipsById,
    assetsById,
    input.offline ?? new Set<string>(),
  );
}

function checkPicture(input: LintInput, frame: number): LintFinding[] {
  const { tracks, clipsById, assetsById } = input;
  const segments = visibleVideo(input);
  if (segments.length === 0) return [];

  const findings: LintFinding[] = [];
  const videoClips = tracks.filter((t) => t.type === "video").flatMap((t) => t.clipIds.map((id) => clipsById[id]).filter(Boolean));
  const clipsAt = (time: number, path?: string) =>
    videoClips
      .filter((c) => time >= c.startTime - EPSILON && time <= c.startTime + c.duration + EPSILON && (!path || assetsById[c.mediaAssetId]?.filePath === path))
      .map((c) => c.id);

  const end = Math.max(...Object.values(clipsById).map((c) => c.startTime + c.duration));
  for (const gap of uncovered(0, end, segments.map((s) => ({ start: s.timelineStart, end: s.timelineStart + s.duration })))) {
    const length = gap.end - gap.start;
    if (length < frame - EPSILON) continue;
    findings.push({
      time: round2(gap.start),
      end: round2(gap.end),
      severity: length >= 0.5 ? "high" : "medium",
      category: "black",
      message: `No picture from ${round2(gap.start)}s to ${round2(gap.end)}s — it plays as black.`,
      clipIds: [...clipsAt(gap.start), ...clipsAt(gap.end)],
    });
  }

  const flash = LINT_LIMITS.flashFrames * frame;
  for (const s of segments) {
    if (s.duration >= flash - EPSILON) continue;
    const frames = Math.max(1, Math.round(s.duration / frame));
    findings.push({
      time: round2(s.timelineStart),
      severity: "high",
      category: "flash_frame",
      message: `A shot is only visible for ${frames} frame${frames === 1 ? "" : "s"} at ${round2(s.timelineStart)}s — a flash frame.`,
      clipIds: clipsAt(s.timelineStart + s.duration / 2, s.path),
    });
  }
  return findings;
}

/** The loudest peak of the source over [from, to), linear. */
function peakOver(peaks: WaveformPeaks, from: number, to: number): number {
  const first = Math.max(0, Math.floor(from * peaks.peaksPerSecond));
  const last = Math.min(peaks.maxes.length, Math.ceil(to * peaks.peaksPerSecond));
  let peak = 0;
  for (let i = first; i < last; i++) peak = Math.max(peak, Math.abs(peaks.mins[i] ?? 0), Math.abs(peaks.maxes[i] ?? 0));
  return peak;
}

function checkMidWordCuts(input: LintInput): LintFinding[] {
  const words = input.wordsByAssetId ?? {};
  const peaksByAsset = input.peaksByAssetId ?? {};
  const margin = LINT_LIMITS.midWordMargin;
  const hush = LINT_LIMITS.midWordSilenceWindow;
  const seen = new Map<string, LintFinding>();
  for (const clip of Object.values(input.clipsById)) {
    const asset = input.assetsById[clip.mediaAssetId];
    const list = words[clip.mediaAssetId];
    if (!asset || asset.hasAudio === false || !list?.length) continue;
    const edges = [
      { source: clip.sourceIn, time: clip.startTime },
      { source: clip.sourceOut, time: clip.startTime + clip.duration },
    ];
    for (const edge of edges) {
      const word = list.find((w) => w.start + margin < edge.source && edge.source < w.end - margin);
      if (!word) continue;
      // Inside the word's timing but in silence: the word's timing took in a pause, nothing is clipped.
      const peaks = peaksByAsset[clip.mediaAssetId];
      if (peaks && toDb(peakOver(peaks, edge.source - hush, edge.source + hush)) < LINT_LIMITS.silentDb) continue;
      // A video clip and its linked audio share the same edge: report it once.
      const key = `${clip.mediaAssetId}@${edge.source.toFixed(2)}@${edge.time.toFixed(2)}`;
      const existing = seen.get(key);
      if (existing) {
        existing.clipIds.push(clip.id);
        continue;
      }
      seen.set(key, {
        time: round2(edge.time),
        severity: "medium",
        category: "mid_word_cut",
        message: `The cut at ${round2(edge.time)}s falls inside the word "${word.text.trim()}" in ${asset.fileName}.`,
        clipIds: [clip.id],
      });
    }
  }
  return [...seen.values()];
}

/** A loud-but-typical level of the clip's source over [from, to): the 90th percentile of its peaks. */
function levelOver(peaks: WaveformPeaks, from: number, to: number, volume: number): number {
  const first = Math.max(0, Math.floor(from * peaks.peaksPerSecond));
  const last = Math.min(peaks.maxes.length, Math.ceil(to * peaks.peaksPerSecond));
  const levels: number[] = [];
  for (let i = first; i < last; i++) levels.push(Math.max(Math.abs(peaks.mins[i] ?? 0), Math.abs(peaks.maxes[i] ?? 0)));
  if (levels.length === 0) return 0;
  levels.sort((a, b) => a - b);
  return levels[Math.min(levels.length - 1, Math.floor(levels.length * 0.9))] * volume;
}

function checkLevels(input: LintInput, frame: number): LintFinding[] {
  const peaksByAsset = input.peaksByAssetId ?? {};
  const offline = input.offline ?? new Set<string>();
  const findings: LintFinding[] = [];
  const window = LINT_LIMITS.levelWindowSeconds;

  for (const track of input.tracks) {
    const audible = track.clipIds
      .map((id) => input.clipsById[id])
      .filter((c): c is Clip => Boolean(c) && clipHasOwnAudio(c, track, input.assetsById, offline))
      .sort((a, b) => a.startTime - b.startTime);

    for (const clip of audible) {
      const peaks = peaksByAsset[clip.mediaAssetId];
      if (!peaks) continue;
      const volume = clip.volume ?? 1;
      const first = Math.max(0, Math.floor(clip.sourceIn * peaks.peaksPerSecond));
      const last = Math.min(peaks.maxes.length, Math.ceil(clip.sourceOut * peaks.peaksPerSecond));
      for (let i = first; i < last; i++) {
        const level = Math.max(Math.abs(peaks.mins[i] ?? 0), Math.abs(peaks.maxes[i] ?? 0)) * volume;
        if (level < LINT_LIMITS.clippingAmplitude) continue;
        const time = Math.max(clip.startTime, timelineAt(clip, i / peaks.peaksPerSecond));
        findings.push({
          time: round2(time),
          severity: "medium",
          category: "clipping",
          message: `${clip.name}'s sound clips (reaches 0 dBFS) from ${round2(time)}s${volume > 1 ? ` — its volume is raised to ${Math.round(volume * 100)}%` : ""}.`,
          clipIds: [clip.id],
        });
        break;
      }
    }

    for (let i = 1; i < audible.length; i++) {
      const [a, b] = [audible[i - 1], audible[i]];
      if (Math.abs(a.startTime + a.duration - b.startTime) > frame) continue;
      // Two parts of the same recording share its gain: a difference there is speech against a pause,
      // not a mismatch to fix.
      if (a.mediaAssetId === b.mediaAssetId) continue;
      const [pa, pb] = [peaksByAsset[a.mediaAssetId], peaksByAsset[b.mediaAssetId]];
      if (!pa || !pb) continue;
      const before = toDb(levelOver(pa, Math.max(a.sourceIn, a.sourceOut - window), a.sourceOut, a.volume ?? 1));
      const after = toDb(levelOver(pb, b.sourceIn, Math.min(b.sourceOut, b.sourceIn + window), b.volume ?? 1));
      if (before < LINT_LIMITS.silentDb || after < LINT_LIMITS.silentDb) continue;
      const jump = after - before;
      if (Math.abs(jump) < LINT_LIMITS.levelJumpDb) continue;
      findings.push({
        time: round2(b.startTime),
        severity: Math.abs(jump) >= 10 ? "medium" : "low",
        category: "level_jump",
        message: `The sound gets ${Math.round(Math.abs(jump))} dB ${jump > 0 ? "louder" : "quieter"} across the cut at ${round2(b.startTime)}s (${a.name} → ${b.name}).`,
        clipIds: [a.id, b.id],
      });
    }
  }
  return findings;
}

/**
 * Linked picture and sound that have slipped apart. Sound from the picture's own file must sit at the
 * same source position; a synced recording must sit at its sync offset (see `lib/sync.ts`). A group
 * with no picture (two sound clips) is checked the old way, clip against clip of the same file.
 */
function checkSync(input: LintInput, frame: number): LintFinding[] {
  const groups = new Map<string, Clip[]>();
  for (const clip of Object.values(input.clipsById)) {
    if (!clip.linkId) continue;
    groups.set(clip.linkId, [...(groups.get(clip.linkId) ?? []), clip]);
  }
  const tracksById = Object.fromEntries(input.tracks.map((t) => [t.id, t]));
  const findings: LintFinding[] = [];
  for (const clips of groups.values()) {
    const [first, ...rest] = clips;
    const picture = pictureOfGroup(first, input.clipsById, tracksById);
    let pair: { a: Clip; b: Clip; offset: number } | undefined;
    if (picture) {
      for (const sound of clips) {
        if (sound.id === picture.id) continue;
        const error = syncErrorSeconds(sound, input.clipsById, tracksById, input.assetsById);
        if (error !== undefined && Math.abs(error) > frame / 2) {
          pair = { a: picture, b: sound, offset: error };
          break;
        }
      }
    } else {
      const drifted = rest.find(
        (c) =>
          c.mediaAssetId === first.mediaAssetId &&
          sameTiming(c, first) &&
          Math.abs(c.startTime - c.sourceIn - (first.startTime - first.sourceIn)) > frame / 2,
      );
      if (drifted) pair = { a: first, b: drifted, offset: drifted.startTime - drifted.sourceIn - (first.startTime - first.sourceIn) };
    }
    if (!pair) continue;
    const frames = Math.round(Math.abs(pair.offset) / frame);
    findings.push({
      time: round2(Math.min(pair.a.startTime, pair.b.startTime)),
      severity: "high",
      category: "out_of_sync",
      message: `The linked picture and sound of ${pair.a.name} are ${frames} frame${frames === 1 ? "" : "s"} out of sync${
        pair.a.mediaAssetId !== pair.b.mediaAssetId ? ` (${pair.b.name}; Slip into Sync puts it back)` : ""
      }.`,
      clipIds: [pair.a.id, pair.b.id],
    });
  }
  return findings;
}

const SEVERITY_ORDER: Record<FindingSeverity, number> = { high: 0, medium: 1, low: 2 };

/** Every mechanical problem in the cut, in timeline order (the most severe kept when there are too many). */
export function lintEdit(input: LintInput): LintFinding[] {
  if (Object.keys(input.clipsById).length === 0) return [];
  const frame = 1 / (input.frameRate > 0 ? input.frameRate : 25);
  const all = [...checkPicture(input, frame), ...checkMidWordCuts(input), ...checkLevels(input, frame), ...checkSync(input, frame)];
  const kept =
    all.length > LINT_LIMITS.maxFindings
      ? [...all].sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] || a.time - b.time).slice(0, LINT_LIMITS.maxFindings)
      : all;
  return kept.sort((a, b) => a.time - b.time);
}
