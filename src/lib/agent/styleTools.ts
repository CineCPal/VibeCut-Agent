/**
 * Learning a style from a reference edit (PLAN.md, "Phase 20b"): `learn_style` measures a finished video
 * the user points at and keeps what it finds in the project notes (styles.ts), so later chats can cut and
 * grade toward it:
 *  - its pace: `check_pacing`'s profile of the file (shots from `media-shots`);
 *  - its look: a frame from the middle of each shot measured as `get_clip_color` measures the editor's
 *    (`media-style`), the median over the shots;
 *  - its cutting to the beat: the share of cuts within two frames of a beat of its own sound
 *    (`media-beats`), beside the share chance alone would give.
 *
 * It doesn't touch the editor. `check_pacing` takes the style as its target, `match_clip_color` as its
 * reference.
 */
import { runJob } from "../jobs";
import type { NleHost } from "../../types/nle";
import { bool, clock, type Executor, optNum, optStr, type ToolOutcome } from "./args";
import { describeMeasure } from "./colorTools";
import { fileProfile, type PacingProfile } from "./pacingTools";
import { type LearnedStyle, LOOK_KEYS, type Look, saveStyle, styleName } from "./styles";
import type { ToolContext, ToolDeclaration } from "./tools";

/** media-style's MAX_SAMPLES. */
export const MAX_LOOK_SAMPLES = 48;
/** Beats under this confidence have no steady pulse to cut to. */
const MIN_BEAT_CONFIDENCE = 0.3;

const round2 = (n: number) => Math.round(n * 100) / 100;
const fileName = (path: string) => path.split(/[\\/]/).pop() || path;
const percent = (share: number) => `${Math.round(share * 100)}%`;

/** A moment from the middle of each shot, evenly thinned to at most `limit`. */
export function lookTimes(shots: { start: number; end: number }[], limit = MAX_LOOK_SAMPLES): number[] {
  const middles = shots.map((s) => round2((s.start + s.end) / 2));
  if (middles.length <= limit) return middles;
  return Array.from({ length: limit }, (_, i) => middles[Math.round((i * (middles.length - 1)) / (limit - 1))]);
}

export interface BeatCutting {
  bpm: number;
  /** Cuts within `tolerance` seconds of a beat, as a share of the cuts. */
  onBeat: number;
  /** The share of cuts that would land that near a beat by chance. */
  chance: number;
  tolerance: number;
}

/** How many of `cuts` land within `tolerance` of a beat, and how many would by chance at this tempo. */
export function beatCutting(cuts: number[], beats: number[], bpm: number, tolerance: number): BeatCutting {
  const sorted = [...beats].sort((a, b) => a - b);
  const near = (t: number) => {
    let lo = 0;
    let hi = sorted.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (sorted[mid] < t) lo = mid + 1;
      else hi = mid;
    }
    return [sorted[lo - 1], sorted[lo]].some((b) => b !== undefined && Math.abs(b - t) <= tolerance + 1e-6);
  };
  const on = cuts.filter(near).length;
  return { bpm: round2(bpm), onBeat: cuts.length ? round2(on / cuts.length) : 0, chance: round2(Math.min(1, (2 * tolerance * bpm) / 60)), tolerance: round2(tolerance) };
}

/** The style as one sentence for the notes (before its tag). */
export function styleSentence(name: string, file: string, profile: PacingProfile, look: Look | null, beats: BeatCutting | null): string {
  const parts = [
    `"${name}" style, learned from ${file}: median shot ${profile.medianShot}s (90% under ${profile.p90Shot}s), ${profile.cutsPerMinute} cuts a minute`,
    look ? `look: ${describeMeasure(look)}` : null,
    beats ? `${percent(beats.onBeat)} of cuts on the beat at ${beats.bpm} BPM (chance ${percent(beats.chance)})` : null,
  ];
  return `${parts.filter(Boolean).join("; ")}.`;
}

interface StyleJob {
  look: Look;
  spread: Record<string, [number, number]>;
  measured: number;
  dark: number;
}

export function styleToolDeclarations(_host: NleHost): ToolDeclaration[] {
  return [
    {
      name: "learn_style",
      description: `Learns a style from a reference edit (a finished video the user points at, by path) and saves it to the project notes' Style section under name: its pace (median and 90th-percentile shot, cuts a minute; hard cuts only), its look (brightness, contrast, warmth, tint and colourfulness, the median over a frame from each shot, as get_clip_color measures), and how much it cuts on the beat of its own sound (against chance). Then check_pacing with style judges a cut against it, and match_clip_color with style brings clips toward its look. Learning a name again replaces it. It doesn't touch the editor. save false only measures.`,
      parameters: {
        type: "OBJECT",
        properties: {
          path: { type: "STRING", description: "The reference video's absolute path." },
          name: { type: "STRING", description: 'What to call the style, e.g. "client promo" (1-40 characters).' },
          start: { type: "NUMBER", description: "Optional; seconds into the file." },
          end: { type: "NUMBER", description: "Optional; seconds into the file." },
          save: { type: "BOOLEAN", description: "Optional; default true." },
        },
        required: ["path", "name"],
      },
    },
  ];
}

export function styleExecutors(context: ToolContext): Record<string, Executor> {
  return {
    learn_style: async (args): Promise<ToolOutcome> => {
      const name = styleName(optStr(args, "name"));
      const path = optStr(args, "path");
      if (!path) throw new Error("path must be the reference video's absolute path");
      const from = optNum(args, "start");
      const to = optNum(args, "end");
      if (from !== undefined && to !== undefined && !(to > from)) throw new Error("end must be after start");
      const file = fileName(path);
      const { profile, shots, fps, notes } = await fileProfile(path, from, to);

      let look: Look | null = null;
      let lookFacts: Omit<StyleJob, "look"> | null = null;
      const styleJob = await runJob("media-style", `Measure the look of ${file}`, { path, times: lookTimes(shots) });
      const measured = styleJob?.result as StyleJob | undefined;
      if (measured?.look) {
        look = measured.look;
        lookFacts = { spread: measured.spread, measured: measured.measured, dark: measured.dark };
        if (shots.length > MAX_LOOK_SAMPLES) notes.push(`the look is from ${MAX_LOOK_SAMPLES} of the ${shots.length} shots, evenly spread`);
      } else notes.push(`its look wasn't measured: ${styleJob?.error ?? "no result"}`);

      let beats: BeatCutting | null = null;
      const beatJob = await runJob("media-beats", `Find the beats of ${file}`, { path, start: profile.start, end: profile.end });
      const found = beatJob?.result as { bpm: number | null; confidence: number; beats: number[] } | undefined;
      const cuts = shots.slice(1).map((s) => s.start);
      if (!found) notes.push(`cutting to the beat wasn't measured: ${beatJob?.error ?? "no result"}`);
      else if (found.bpm === null || found.confidence < MIN_BEAT_CONFIDENCE) notes.push("its sound has no steady beat, so cutting to the beat wasn't measured");
      else if (cuts.length < 4) notes.push("too few cuts to say whether it cuts to the beat");
      else beats = beatCutting(cuts, found.beats, found.bpm, 2 / (fps > 0 ? fps : 25));

      const style: LearnedStyle = {
        name,
        medianShot: profile.medianShot,
        p90Shot: profile.p90Shot,
        cutsPerMinute: profile.cutsPerMinute,
        ...(look ? Object.fromEntries(LOOK_KEYS.map((k) => [k, look[k]])) : {}),
        ...(beats ? { onBeat: beats.onBeat, bpm: beats.bpm } : {}),
      };
      const sentence = styleSentence(name, file, profile, look, beats);
      const save = bool(args, "save", true);
      const project = save ? await saveStyle(context.host, style, sentence) : null;
      return {
        summary: `${save ? `Learned and saved to "${project}"'s notes` : "Measured"}: ${sentence}`,
        result: {
          style,
          saved: save,
          pace: { shots: profile.shots, medianShot: profile.medianShot, p90Shot: profile.p90Shot, cutsPerMinute: profile.cutsPerMinute, longestShots: profile.longestShots, curve: profile.curve, ...(profile.deadAir ? { deadAir: profile.deadAir } : {}) },
          ...(look ? { look: { ...look, ...lookFacts } } : {}),
          ...(beats ? { beats } : {}),
          measured: `${clock(profile.start)}–${clock(profile.end)} of ${file}`,
          notes,
        },
      };
    },
  };
}

/** The ground rule the system prompt gains (Phase 20b). */
export const STYLE_INSTRUCTION = `- learn_style measures a reference edit the user points at (pace, look, cutting to the beat) and keeps it
  in the notes. Then check_pacing with style, and match_clip_color with style, work toward it. A look is
  an average over the reference's shots: say that matching it brings the overall feel closer, not a
  shot-for-shot grade, and measure before and after.`;
