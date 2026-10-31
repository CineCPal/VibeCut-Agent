/**
 * Pacing (PLAN.md, "Phase 20a"): `check_pacing` measures how a cut moves: its shots (the picture that
 * plays, so B-roll over an interview counts as a cut), cuts per minute over time, and the stretches
 * where no one speaks. Then it notes long shots, slow stretches, dead air and a slow opening. It only
 * reads; the agent tightens with the edit tools as the user asks.
 *
 * Without a target, an edit is judged against itself (its own median shot and cut rate), and the
 * result says so. A media file (`path`) can be measured too, such as a reference edit: its shots come
 * from the `media-shots` job (19b) and its dead air from its transcript, when it has one.
 */
import { runJob } from "../jobs";
import type { NleHost } from "../../types/nle";
import type { HostTimeline } from "../../types/timeline";
import { visibleVideo } from "../../vibecut/lib/editLint";
import { laneLines } from "../../vibecut/lib/transcriptLane";
import { type Args, bool, clock, type Executor, optNum, optStr, type ToolFinding, type ToolOutcome } from "./args";
import { filePart } from "./audioTools";
import { TIMELINE_NOUN } from "./edits";
import { lintTimeline, type Severity } from "./reviewTools";
import { onTimeline } from "./shotTools";
import { learnedStyle, styleTarget } from "./styles";
import { heardView, readTranscript, transcriptExecutors } from "./transcriptTools";
import type { ToolContext, ToolDeclaration } from "./tools";

export const PACING_LIMITS = {
  /** The cut-rate curve's window (seconds), widened so a long edit has at most `maxWindows`. */
  window: 15,
  maxWindows: 40,
  /** A last window shorter than this is folded out of the curve. */
  minWindow: 5,
  /** A shot over this many times the edit's median is long (and never under `minLongShot`). */
  longShotFactor: 3,
  minLongShot: 8,
  /** A window cutting at under this share of the reference rate is slow, when a stretch of them is at
   * least `minMissingCuts` short of it (so a sparse interview's one-cut windows aren't all slow). */
  slowFactor: 0.5,
  minMissingCuts: 2,
  /** No words for longer than this (seconds) is dead air. */
  deadAir: 1.5,
  /** The opening (seconds), slow when the rest cuts this many times as often. */
  opening: 15,
  openingFactor: 1.5,
  /** Shots this long (seconds) are looked inside for cuts with `splitLongClips`, at most `maxSplit` of them. */
  splitOver: 20,
  maxSplit: 12,
  /** How many of the longest shots and dead-air stretches the profile lists. */
  listed: 5,
} as const;

const EPSILON = 1e-3;
const round2 = (n: number) => Math.round(n * 100) / 100;
const fileName = (path: string) => path.split(/[\\/]/).pop() || path;

export interface Shot {
  start: number;
  end: number;
  clipId?: string;
  name?: string;
}

export interface Span {
  start: number;
  end: number;
}

export interface PacingTarget {
  medianShot?: number;
  maxShot?: number;
  maxDeadAir?: number;
  openingSeconds?: number;
}

export type PacingCategory = "long_shot" | "slow_stretch" | "dead_air" | "slow_opening" | "pace";

export interface PacingFinding {
  time: number;
  end: number;
  severity: Severity;
  category: PacingCategory;
  message: string;
  clipIds: string[];
}

export interface PacingProfile {
  start: number;
  end: number;
  shots: number;
  cutsPerMinute: number;
  medianShot: number;
  meanShot: number;
  p90Shot: number;
  longestShots: (Shot & { seconds: number })[];
  /** Cuts per minute in each window. */
  curve: { start: number; end: number; cutsPerMinute: number }[];
  /** Absent when it couldn't be measured (no transcript, no sound). */
  deadAir?: { seconds: number; share: number; longest: (Span & { seconds: number })[] };
}

// ----------------------------------------------------------------------------- shots

/**
 * The shots of a timeline: the picture that plays at each moment (the topmost switched-on video), so a
 * B-roll clip over an interview is a shot of its own and the interview resumes as another. Pieces of one
 * clip that play on from each other (a split with nothing changed) are one shot; black is no shot.
 */
export function timelineShots(view: HostTimeline): Shot[] {
  const input = lintTimeline(view);
  const frame = 1 / input.frameRate;
  const segments = visibleVideo(input);
  const clipAt = (time: number, path: string) => {
    for (const track of input.tracks) {
      if (track.type !== "video") continue;
      for (const id of track.clipIds) {
        const c = input.clipsById[id];
        if (c && time >= c.startTime - EPSILON && time <= c.startTime + c.duration + EPSILON && input.assetsById[c.mediaAssetId]?.filePath === path) return c;
      }
    }
    return undefined;
  };

  const shots: (Shot & { path: string; sourceEnd?: number })[] = [];
  for (const s of segments) {
    const start = s.timelineStart;
    const end = s.timelineStart + s.duration;
    const prev = shots[shots.length - 1];
    const plain = !s.timeMap && !s.transitionIn;
    if (prev && plain && prev.path === s.path && prev.sourceEnd !== undefined && Math.abs(prev.end - start) < frame / 2 && Math.abs(prev.sourceEnd - s.sourceIn) < frame / 2) {
      prev.end = end;
      prev.sourceEnd = s.sourceIn + s.duration;
      continue;
    }
    const clip = clipAt((start + end) / 2, s.path);
    shots.push({ start, end, path: s.path, ...(plain ? { sourceEnd: s.sourceIn + s.duration } : {}), ...(clip ? { clipId: clip.id, name: clip.name } : {}) });
  }
  return shots.map(({ start, end, clipId, name }) => ({ start: round2(start), end: round2(end), ...(clipId ? { clipId } : {}), ...(name ? { name } : {}) }));
}

/** `shot` cut at `times` (inside it), its clip kept on every piece. */
export function splitShot(shot: Shot, times: number[]): Shot[] {
  const inside = [...new Set(times.map(round2))].filter((t) => t > shot.start + EPSILON && t < shot.end - EPSILON).sort((a, b) => a - b);
  const edges = [shot.start, ...inside, shot.end];
  return edges.slice(1).map((end, i) => ({ ...shot, start: edges[i], end }));
}

/** Shots between file cuts: from `start` to `end` of the file, cut at each time. */
export function fileShots(start: number, end: number, cuts: number[]): Shot[] {
  return splitShot({ start: round2(start), end: round2(end) }, cuts);
}

// ----------------------------------------------------------------------------- dead air

/** The stretches with no words between the first line and the last (within `range`). */
export function speechGaps(lines: Span[], range: Span): Span[] {
  const sorted = lines.filter((l) => l.end > l.start).sort((a, b) => a.start - b.start);
  if (!sorted.length) return [];
  const merged: Span[] = [];
  for (const l of sorted) {
    const last = merged[merged.length - 1];
    if (last && l.start <= last.end + EPSILON) last.end = Math.max(last.end, l.end);
    else merged.push({ start: l.start, end: l.end });
  }
  const gaps: Span[] = [];
  for (let i = 1; i < merged.length; i++) {
    const start = Math.max(merged[i - 1].end, range.start);
    const end = Math.min(merged[i].start, range.end);
    if (end > start + EPSILON) gaps.push({ start: round2(start), end: round2(end) });
  }
  return gaps;
}

// ----------------------------------------------------------------------------- the profile

function percentile(sorted: number[], q: number): number {
  if (!sorted.length) return 0;
  const at = (sorted.length - 1) * q;
  const lo = Math.floor(at);
  const hi = Math.ceil(at);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (at - lo);
}

/** The shots inside `range`, cut to it. */
export function shotsIn(shots: Shot[], range: Span): Shot[] {
  return shots.filter((s) => s.end > range.start + EPSILON && s.start < range.end - EPSILON).map((s) => ({ ...s, start: Math.max(s.start, range.start), end: Math.min(s.end, range.end) }));
}

/** Cut times: each shot's start but the first moment of the range. */
const cutTimes = (shots: Shot[], range: Span) => shots.map((s) => s.start).filter((t) => t > range.start + EPSILON);

const rate = (cuts: number[], from: number, to: number) => (to - from > EPSILON ? round2((cuts.filter((t) => t >= from && t < to).length * 60) / (to - from)) : 0);

/** How the shots in `range` move, and the dead air (`null`: not measured). Shots must already be inside it. */
export function pacingProfile(shots: Shot[], deadAir: Span[] | null, range: Span): PacingProfile {
  const lengths = shots.map((s) => s.end - s.start).sort((a, b) => a - b);
  const span = range.end - range.start;
  const cuts = cutTimes(shots, range);
  const window = Math.max(PACING_LIMITS.window, Math.ceil(span / PACING_LIMITS.maxWindows / PACING_LIMITS.window) * PACING_LIMITS.window);
  const curve: PacingProfile["curve"] = [];
  for (let t = range.start; t < range.end - EPSILON; t += window) {
    const end = Math.min(t + window, range.end);
    if (end - t < PACING_LIMITS.minWindow && curve.length) {
      const last = curve[curve.length - 1];
      last.end = round2(end);
      last.cutsPerMinute = rate(cuts, last.start, end + EPSILON);
      break;
    }
    curve.push({ start: round2(t), end: round2(end), cutsPerMinute: rate(cuts, t, end) });
  }
  const air = deadAir?.filter((g) => g.end > range.start && g.start < range.end);
  const airSeconds = air?.reduce((sum, g) => sum + g.end - g.start, 0) ?? 0;
  return {
    start: round2(range.start),
    end: round2(range.end),
    shots: shots.length,
    cutsPerMinute: span > 0 ? round2((cuts.length * 60) / span) : 0,
    medianShot: round2(percentile(lengths, 0.5)),
    meanShot: lengths.length ? round2(lengths.reduce((a, b) => a + b, 0) / lengths.length) : 0,
    p90Shot: round2(percentile(lengths, 0.9)),
    longestShots: [...shots]
      .sort((a, b) => b.end - b.start - (a.end - a.start))
      .slice(0, PACING_LIMITS.listed)
      .map((s) => ({ ...s, start: round2(s.start), end: round2(s.end), seconds: round2(s.end - s.start) })),
    curve,
    ...(air
      ? {
          deadAir: {
            seconds: round2(airSeconds),
            share: span > 0 ? round2(airSeconds / span) : 0,
            longest: [...air]
              .sort((a, b) => b.end - b.start - (a.end - a.start))
              .slice(0, PACING_LIMITS.listed)
              .map((g) => ({ ...g, seconds: round2(g.end - g.start) })),
          },
        }
      : {}),
  };
}

// ----------------------------------------------------------------------------- the findings

const s2 = (n: number) => `${round2(n)}s`;

/** What's worth a look in the profile: long shots, slow stretches, dead air, a slow opening, and the
 * pace against a target's median shot. Judged against the edit itself unless `target` says otherwise. */
export function pacingFindings(profile: PacingProfile, shots: Shot[], deadAir: Span[] | null, target: PacingTarget = {}): PacingFinding[] {
  const findings: PacingFinding[] = [];
  const range = { start: profile.start, end: profile.end };
  const span = range.end - range.start;
  const cuts = cutTimes(shots, range);

  const maxShot = target.maxShot ?? Math.max(PACING_LIMITS.minLongShot, PACING_LIMITS.longShotFactor * profile.medianShot);
  const why = target.maxShot !== undefined ? `the target's ${s2(maxShot)}` : `${s2(maxShot)} (${PACING_LIMITS.longShotFactor}× this edit's median shot of ${s2(profile.medianShot)}, at least ${PACING_LIMITS.minLongShot}s)`;
  const long = shots.filter((s) => s.end - s.start > maxShot + EPSILON);
  for (const s of long) {
    const seconds = s.end - s.start;
    findings.push({
      time: round2(s.start),
      end: round2(s.end),
      severity: seconds >= 2 * maxShot ? "medium" : "low",
      category: "long_shot",
      message: `A ${s2(seconds)} shot${s.name ? ` ("${s.name}")` : ""}, over ${why}. Cut away (B-roll, another angle) or trim it if nothing new happens in it.`,
      clipIds: s.clipId ? [s.clipId] : [],
    });
  }

  const opening = target.openingSeconds ?? PACING_LIMITS.opening;
  if (shots.length >= 4 && span >= 3 * opening) {
    const open = rate(cuts, range.start, range.start + opening);
    const rest = rate(cuts, range.start + opening, range.end + EPSILON);
    if (rest > 0 && open * PACING_LIMITS.openingFactor < rest) {
      findings.push({
        time: range.start,
        end: round2(range.start + opening),
        severity: "medium",
        category: "slow_opening",
        message: `The first ${s2(opening)} cut ${open} times a minute, the rest ${rest}. A slow start loses viewers; consider opening on a stronger moment or tightening it.`,
        clipIds: [...new Set(shotsIn(shots, { start: range.start, end: range.start + opening }).flatMap((s) => (s.clipId ? [s.clipId] : [])))].slice(0, 8),
      });
    }
  }

  const reference = target.medianShot ? 60 / target.medianShot : profile.cutsPerMinute;
  const against = target.medianShot ? `the target's ${round2(reference)} (a ${s2(target.medianShot)} median shot)` : `this edit's ${round2(reference)} overall`;
  if (shots.length >= 4 && profile.curve.length >= 3 && reference > 0) {
    let run: { start: number; end: number } | null = null;
    const close = () => {
      if (!run) return;
      const r = run;
      run = null;
      const explained = [...long, ...findings.filter((f) => f.category === "slow_opening").map((f) => ({ start: f.time, end: f.end }))];
      if (explained.some((s) => Math.min(s.end, r.end) - Math.max(s.start, r.start) >= 0.8 * (r.end - r.start))) return;
      const here = rate(cuts, r.start, r.end);
      if ((reference * (r.end - r.start)) / 60 - cuts.filter((t) => t >= r.start && t < r.end).length < PACING_LIMITS.minMissingCuts) return;
      findings.push({
        time: r.start,
        end: r.end,
        severity: "low",
        category: "slow_stretch",
        message: `${clock(r.start)}–${clock(r.end)} cuts ${here} times a minute against ${against}. Tighten it or add cutaways if it drags.`,
        clipIds: [...new Set(shotsIn(shots, r).flatMap((s) => (s.clipId ? [s.clipId] : [])))].slice(0, 8),
      });
    };
    for (const w of profile.curve) {
      // `close` clears it, which narrowing in this loop can't see.
      const open = run as Span | null;
      if (w.cutsPerMinute < PACING_LIMITS.slowFactor * reference) run = { start: open?.start ?? w.start, end: w.end };
      else close();
    }
    close();
  }

  const maxAir = target.maxDeadAir ?? PACING_LIMITS.deadAir;
  for (const g of deadAir ?? []) {
    const seconds = g.end - g.start;
    if (seconds <= maxAir + EPSILON) continue;
    findings.push({
      time: g.start,
      end: g.end,
      severity: seconds >= 2 * maxAir ? "medium" : "low",
      category: "dead_air",
      message: `No one speaks for ${s2(seconds)} (over ${s2(maxAir)}). Fine under music or a montage; otherwise tighten it (remove_time_ranges).`,
      clipIds: [],
    });
  }

  if (target.medianShot && profile.shots >= 4) {
    const ratio = profile.medianShot / target.medianShot;
    if (ratio > 1.25 || ratio < 0.75) {
      findings.push({
        time: range.start,
        end: range.end,
        severity: "low",
        category: "pace",
        message: `The median shot is ${s2(profile.medianShot)} against the target's ${s2(target.medianShot)}: ${ratio > 1 ? "slower" : "faster"} than asked.`,
        clipIds: [],
      });
    }
  }

  return findings.sort((a, b) => a.time - b.time || a.end - b.end);
}

// ----------------------------------------------------------------------------- the tool

function targetOf(args: Args): PacingTarget {
  const raw = args.target;
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== "object" || Array.isArray(raw)) throw new Error("target must be an object (medianShot, maxShot, maxDeadAir, openingSeconds)");
  const t = raw as Args;
  const target: PacingTarget = {};
  for (const key of ["medianShot", "maxShot", "maxDeadAir", "openingSeconds"] as const) {
    const value = optNum(t, key);
    if (value === undefined) continue;
    if (!(value > 0)) throw new Error(`target.${key} must be more than 0 seconds`);
    target[key] = value;
  }
  return target;
}

interface ShotsJob {
  cuts: { time: number; score: number }[];
  start: number;
  end: number;
  fps: number;
}

async function findCuts(path: string, start: number, end: number | undefined, title: string): Promise<ShotsJob> {
  const job = await runJob("media-shots", title, { path, start: Math.max(0, start), ...(end !== undefined ? { end } : {}), sensitivity: "normal" });
  const result = job?.result as ShotsJob | undefined;
  if (!result) throw new Error(job?.error ?? "The shot changes couldn't be found");
  return result;
}

/** A media file's shots (`media-shots`), profile and dead air (from its transcript, when it has one),
 * between `from` and `to` seconds of it: `check_pacing` with a path, and `learn_style`. */
export async function fileProfile(path: string, from?: number, to?: number): Promise<{ profile: PacingProfile; shots: Shot[]; deadAir: Span[] | null; fps: number; notes: string[] }> {
  if (!path.startsWith("/")) throw new Error("path must be an absolute file path");
  const found = await findCuts(path, from ?? 0, to, `Find the shots in ${fileName(path)}`);
  const range = { start: found.start, end: found.end };
  if (!(range.end > range.start)) throw new Error(`${fileName(path)} has no picture to measure there`);
  const shots = fileShots(range.start, range.end, found.cuts.map((c) => c.time));
  const transcript = await readTranscript(path).catch(() => null);
  const notes: string[] = [];
  let deadAir: Span[] | null = null;
  if (transcript?.segments.length) deadAir = speechGaps(transcript.segments, range);
  else notes.push(`${fileName(path)} has no transcript, so dead air wasn't measured (transcribe_clips with its path first, if it has speech)`);
  notes.push("Hard cuts only: dissolves, fades and wipes count as one shot.");
  return { profile: pacingProfile(shots, deadAir, range), shots, deadAir, fps: found.fps, notes };
}

function outcome(where: string, profile: PacingProfile, findings: PacingFinding[], target: PacingTarget, notes: string[], extra: Record<string, unknown> = {}): ToolOutcome {
  const counts = new Map<PacingCategory, number>();
  for (const f of findings) counts.set(f.category, (counts.get(f.category) ?? 0) + 1);
  const words: Record<PacingCategory, string> = { long_shot: "long shot(s)", slow_stretch: "slow stretch(es)", dead_air: "dead air", slow_opening: "slow opening", pace: "off the target pace" };
  const listed = [...counts].map(([c, n]) => (c === "slow_opening" || c === "pace" ? words[c] : `${n} ${words[c]}`)).join(", ");
  const targeted = Object.keys(target).length > 0;
  const cards: ToolFinding[] = findings.map((f) => ({ time: f.time, end: f.end, severity: f.severity, text: f.message, source: "check" }));
  return {
    summary: `Pacing of ${where} (${clock(profile.start)}–${clock(profile.end)}): ${profile.shots} shot(s), ${profile.cutsPerMinute} cuts a minute, median shot ${s2(profile.medianShot)}${findings.length ? `; ${listed}` : "; nothing stands out"}`,
    result: {
      ...extra,
      judgedAgainst: targeted ? "the target given, and this edit itself where the target says nothing" : "this edit itself (no target): these are observations, not rules",
      ...(targeted ? { target } : {}),
      profile,
      findings,
      ...(notes.length ? { notes } : {}),
    },
    findings: cards,
  };
}

export function pacingToolDeclarations(host: NleHost): ToolDeclaration[] {
  const noun = TIMELINE_NOUN[host];
  return [
    {
      name: "check_pacing",
      description: `Measures the pacing of the connected ${noun} (or the draft), or of a media file (path, e.g. a reference edit): its shots (the picture that plays, so B-roll over an interview counts as a cut), cuts per minute overall and over time, median and 90th-percentile shot length, the longest shots, and dead air (no words, from the transcripts; from the sound level when nothing is transcribed). Then it notes long shots, slow stretches, dead air and a slow opening. Without a target it judges the edit against itself; give style (learned with learn_style) or target (from the user) to judge against that. It only reads. splitLongClips looks inside shots over ${PACING_LIMITS.splitOver}s for cuts (a flattened export), which takes longer.`,
      parameters: {
        type: "OBJECT",
        properties: {
          path: { type: "STRING", description: `Absolute media file path, instead of the ${noun}; start/end are then file seconds.` },
          style: { type: "STRING", description: "A style learned with learn_style: its median shot, and twice the length 90% of its shots stay under as the longest. target's fields override it." },
          start: { type: "NUMBER", description: "Optional." },
          end: { type: "NUMBER", description: "Optional." },
          splitLongClips: { type: "BOOLEAN", description: `Optional; default false. ${noun} only.` },
          target: {
            type: "OBJECT",
            description: "Optional; seconds.",
            properties: {
              medianShot: { type: "NUMBER", description: "The median shot length wanted." },
              maxShot: { type: "NUMBER", description: `A shot longer than this is noted. Default ${PACING_LIMITS.longShotFactor}× the edit's own median, at least ${PACING_LIMITS.minLongShot}s.` },
              maxDeadAir: { type: "NUMBER", description: `No words for longer than this is noted. Default ${PACING_LIMITS.deadAir}.` },
              openingSeconds: { type: "NUMBER", description: `How long the opening is. Default ${PACING_LIMITS.opening}.` },
            },
          },
        },
      },
    },
  ];
}

export function pacingExecutors(context: ToolContext): Record<string, Executor> {
  const { host } = context;
  return {
    check_pacing: async (args): Promise<ToolOutcome> => {
      const styleName = optStr(args, "style");
      const target = { ...(styleName ? styleTarget(await learnedStyle(host, styleName)) : {}), ...targetOf(args) };
      const from = optNum(args, "start");
      const to = optNum(args, "end");
      if (from !== undefined && to !== undefined && !(to > from)) throw new Error("end must be after start");
      const path = optStr(args, "path");
      const notes: string[] = [];

      if (path) {
        const measured = await fileProfile(path, from, to);
        return outcome(fileName(path), measured.profile, pacingFindings(measured.profile, measured.shots, measured.deadAir, target), target, measured.notes, { path, ...(styleName ? { style: styleName } : {}) });
      }

      const heard = await heardView(context);
      const view = heard.view;
      const range = { start: Math.max(0, from ?? 0), end: Math.min(view.duration, to ?? view.duration) };
      if (!(range.end > range.start)) throw new Error(`start–end must be inside the ${TIMELINE_NOUN[host]} (0–${clock(view.duration)})`);
      let shots = shotsIn(timelineShots(view), range);
      if (!shots.length) throw new Error(`There's no picture on the ${TIMELINE_NOUN[host]} between ${clock(range.start)} and ${clock(range.end)}`);

      if (bool(args, "splitLongClips")) {
        const clips = new Map(view.tracks.filter((t) => t.type === "video").flatMap((t) => t.clips.map((c) => [c.id, c] as const)));
        const long = shots.filter((s) => s.end - s.start > PACING_LIMITS.splitOver && s.clipId && clips.get(s.clipId)?.filePath && clips.get(s.clipId)?.kind !== "effect");
        const looked = [...long].sort((a, b) => b.end - b.start - (a.end - a.start)).slice(0, PACING_LIMITS.maxSplit);
        if (long.length > looked.length) notes.push(`looked inside the ${looked.length} longest of ${long.length} long shots`);
        const cutsBy = new Map<Shot, number[]>();
        for (const shot of looked) {
          const clip = clips.get(shot.clipId!)!;
          const part = filePart(clip, shot.start, shot.end);
          try {
            const found = await findCuts(clip.filePath!, Math.min(part.from, part.to), Math.max(part.from, part.to), `Find the shots in "${clip.name}"`);
            cutsBy.set(shot, onTimeline(clip, found.cuts, found.fps).map((c) => c.time!));
          } catch (error) {
            notes.push(`couldn't look inside "${clip.name}": ${error instanceof Error ? error.message : String(error)}`);
          }
        }
        shots = shots.flatMap((s) => (cutsBy.has(s) ? splitShot(s, cutsBy.get(s)!) : [s]));
      }

      const lines = laneLines(heard.clips.heard, heard.transcripts, heard.clips.assetsById);
      let deadAir: Span[] | null = null;
      if (lines.length) {
        deadAir = speechGaps(lines, range);
        if (heard.untranscribed.length) notes.push(`dead air is from the transcribed files only; not transcribed: ${heard.untranscribed.join(", ")}`);
      } else if (Object.keys(heard.clips.heard).length) {
        try {
          const maxAir = target.maxDeadAir ?? PACING_LIMITS.deadAir;
          const silences = await transcriptExecutors(context).find_silences({ minDurationSeconds: maxAir, handleSeconds: 0, startTime: range.start, endTime: range.end });
          deadAir = ((silences.result as { silences?: Span[] }).silences ?? []).map((g) => ({ start: round2(g.start), end: round2(g.end) }));
          notes.push(`nothing heard is transcribed, so dead air is from the sound level (quieter than -40 dB for over ${s2(maxAir)}); transcribe_clips for dead air by words`);
        } catch (error) {
          notes.push(`dead air wasn't measured: ${error instanceof Error ? error.message : String(error)}`);
        }
      } else {
        notes.push(`nothing is heard on the ${TIMELINE_NOUN[host]}, so dead air wasn't measured`);
      }

      const profile = pacingProfile(shots, deadAir, range);
      return outcome(`"${view.timeline}"`, profile, pacingFindings(profile, shots, deadAir, target), target, notes, styleName ? { style: styleName } : {});
    },
  };
}

/** The ground rule the system prompt gains (Phase 20a). */
export const PACING_INSTRUCTION = `- check_pacing measures shots, cut rate and dead air. Use it when the user asks whether a cut drags, is
  too slow or fast, or how a reference edit is paced (with path). Without a target its notes compare the
  edit with itself: present them as observations, not rules. A style learned with learn_style goes in
  style, a pace the user gives in target. It only reads; tighten with the edit tools as the user asks.`;
