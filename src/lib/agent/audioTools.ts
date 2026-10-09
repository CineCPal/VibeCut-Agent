/**
 * The agent hears the sound (PLAN.md, "Phase 13d"): how loud clips are (EBU R128, the `media-loudness`
 * job), levelling them to a loudness target through set_clip_levels (one backup and Revert, like any
 * direct edit), and the beats of a music clip (`media-beats`) to cut or mark to.
 *
 * Measurements are of each clip's own file over the part the clip uses, before the clip's level, fades,
 * effects or the mix: what a clip is, not what the finished timeline is.
 */
import { runJob } from "../jobs";
import type { NleHost } from "../../types/nle";
import type { HostClip, HostTimeline } from "../../types/timeline";
import { type Args, clock, type Executor, optNum, optStr } from "./args";
import { connectedView, refuseWhileDrafting } from "./draft";
import { editExecutors } from "./editTools";
import type { ToolContext, ToolDeclaration } from "./tools";

/** media/loudness.py's MAX_RANGES. */
export const MAX_MEASURED = 32;
/** The most normalize_loudness changes a clip's level by, either way. */
export const MAX_GAIN_DB = 20;
const NOUN: Record<NleHost, string> = { premiere: "sequence", resolve: "timeline" };

export interface Level {
  integratedLufs: number | null;
  loudnessRange: number | null;
  truePeakDb: number | null;
  maxShortTermLufs: number | null;
  error?: string;
}

interface Heard {
  clip: HostClip;
  track: string;
  /** Seconds into the file. */
  from: number;
  to: number;
}

const round1 = (n: number) => Math.round(n * 10) / 10;

/** The part of its file a clip plays between timeline times `start` and `end` (within the clip). */
export function filePart(clip: HostClip, start = clip.start, end = clip.end): { from: number; to: number } {
  const speed = Math.abs(clip.speed ?? 1) || 1;
  const a = Math.max(start, clip.start);
  const b = Math.min(end, clip.end);
  const base = clip.sourceIn ?? 0;
  if ((clip.speed ?? 1) < 0) return { from: Math.max(0, base - (b - clip.start) * speed), to: Math.max(0, base - (a - clip.start) * speed) };
  return { from: base + (a - clip.start) * speed, to: base + (b - clip.start) * speed };
}

/** The sound clips asked for: audio ids as they are, a picture's id as its linked sound. */
export function soundClips(view: HostTimeline, ids: string[]): Heard[] {
  const all = view.tracks.flatMap((t) => t.clips.map((clip) => ({ clip, track: t })));
  const byId = new Map(all.map((e) => [e.clip.id, e]));
  const out: Heard[] = [];
  const seen = new Set<string>();
  for (const id of ids) {
    const found = byId.get(id);
    if (!found) throw new Error(`There's no clip ${id} on the connected timeline`);
    const sounds = found.track.type === "audio" ? [found] : (found.clip.linkedIds ?? []).map((l) => byId.get(l)).filter((e) => e && e.track.type === "audio");
    if (!sounds.length) throw new Error(`${id} has no sound (and no sound linked to it)`);
    for (const s of sounds) {
      if (!s || seen.has(s.clip.id)) continue;
      if (!s.clip.filePath || s.clip.kind === "effect") throw new Error(`${s.clip.id} has no media file to measure`);
      seen.add(s.clip.id);
      out.push({ clip: s.clip, track: `A${s.track.index}`, ...filePart(s.clip) });
    }
  }
  return out;
}

/** The heard sound clips between two timeline times (on tracks and clips that are on), each cut to the range. */
export function soundBetween(view: HostTimeline, start: number, end: number): Heard[] {
  return view.tracks
    .filter((t) => t.type === "audio" && t.enabled !== false)
    .flatMap((t) =>
      t.clips
        .filter((c) => c.enabled && c.filePath && c.kind !== "effect" && c.end > start && c.start < end)
        .map((clip) => ({ clip, track: `A${t.index}`, ...filePart(clip, start, end) })),
    );
}

/** Each part's EBU R128 loudness (the `media-loudness` job), in the order given. */
export async function measure(parts: Heard[]): Promise<Level[]> {
  if (parts.length > MAX_MEASURED) throw new Error(`At most ${MAX_MEASURED} clips can be measured at once; give fewer clipIds or a shorter range`);
  const ranges = parts.map((p) => ({ path: p.clip.filePath!, start: Math.max(0, p.from), end: p.to > p.from ? p.to : undefined }));
  const job = await runJob("media-loudness", `Measure the loudness of ${parts.length} clip(s)`, { ranges });
  const levels = ((job?.result ?? {}) as { levels?: (Level & { index: number })[] }).levels;
  if (!levels) throw new Error(job?.error ?? "The loudness couldn't be measured");
  return parts.map((_, i) => levels.find((l) => l.index === i) ?? { integratedLufs: null, loudnessRange: null, truePeakDb: null, maxShortTermLufs: null, error: "not measured" });
}

/** The level that brings a clip to `target`, kept within ±MAX_GAIN_DB of the file and, when `ceiling`
 * is given, low enough that its true peak stays under it. */
export function levelFor(level: Level, target: number, ceiling: number | null): { volumeDb: number; reachedLufs: number; peakLimited: boolean; capped: boolean } | null {
  if (level.integratedLufs === null) return null;
  const wanted = target - level.integratedLufs;
  let gain = Math.max(-MAX_GAIN_DB, Math.min(MAX_GAIN_DB, wanted));
  const capped = gain !== wanted;
  let peakLimited = false;
  if (ceiling !== null && level.truePeakDb !== null && level.truePeakDb + gain > ceiling) {
    gain = ceiling - level.truePeakDb;
    peakLimited = true;
  }
  const volumeDb = round1(gain);
  return { volumeDb, reachedLufs: round1(level.integratedLufs + volumeDb), peakLimited, capped };
}

export function audioToolDeclarations(host: NleHost): ToolDeclaration[] {
  const noun = NOUN[host];
  const what = "Each clip's own file is measured over the part the clip plays, before its level, fades and effects: what the clip is, not the finished mix.";
  return [
    {
      name: "measure_loudness",
      description: `Measures how loud sound clips on the connected ${noun} are, by EBU R128: integrated loudness (LUFS), loudness range (LU), true peak (dBTP) and the loudest 3 s (LUFS), with each clip's level now (dB). Give clipIds (a picture's id measures its linked sound), or start and end (seconds) for every heard sound clip in that range; with neither, the In–Out marks or the whole ${noun}. ${what} At most ${MAX_MEASURED} clips.`,
      parameters: {
        type: "OBJECT",
        properties: {
          clipIds: { type: "ARRAY", items: { type: "STRING" } },
          start: { type: "NUMBER" },
          end: { type: "NUMBER" },
        },
      },
    },
    {
      name: "normalize_loudness",
      description: `Sets sound clips' levels so each one measures targetLufs: -14 for YouTube, Instagram and most web video (the default), -16 for podcasts and Apple, -23 for EBU broadcast, -24 for US broadcast (ATSC A/85). Each clip changes by at most ${MAX_GAIN_DB} dB, and by default is kept low enough that its true peak stays under maxTruePeak (-1 dBTP), which may leave it below the target (the result says). Applied with set_clip_levels: one backup, undone with Revert. Dialogue, music and effects usually want different targets: level the dialogue, then set music lower by ear or with duck_music. ${what}`,
      parameters: {
        type: "OBJECT",
        properties: {
          clipIds: { type: "ARRAY", items: { type: "STRING" } },
          targetLufs: { type: "NUMBER" },
          maxTruePeak: { type: "NUMBER", description: "dBTP. Default -1. null lets peaks go over." },
        },
        required: ["clipIds"],
      },
    },
    {
      name: "find_beats",
      description: `Finds the tempo (BPM) and beats of a music clip on the connected ${noun}, as ${noun} times within the clip, to cut to the beat or mark it. To mark them, add_markers the beats you want (e.g. every 4th for bars). Confidence under 0.3 means the music has no steady pulse; say so rather than cutting to it. maybeDoubleTime means the music may be felt twice as fast (every beat, plus the one halfway between).`,
      parameters: {
        type: "OBJECT",
        properties: {
          clipId: { type: "STRING", description: "A music clip (or its picture) on the timeline." },
          start: { type: "NUMBER", description: `Only from this ${noun} time.` },
          end: { type: "NUMBER", description: `Only up to this ${noun} time.` },
        },
        required: ["clipId"],
      },
    },
  ];
}

function ids(args: Args): string[] | undefined {
  const raw = args.clipIds;
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw) || !raw.length || !raw.every((x) => typeof x === "string")) throw new Error("clipIds must list clip ids");
  return raw as string[];
}

export function audioExecutors(context: ToolContext): Record<string, Executor> {
  const { host } = context;
  const noun = NOUN[host];

  const rows = (parts: Heard[], levels: Level[]) =>
    parts.map((p, i) => ({
      clipId: p.clip.id,
      name: p.clip.name,
      track: p.track,
      measured: `${clock(p.from)}–${clock(p.to)} of the file`,
      levelDb: p.clip.volumeDb ?? 0,
      ...(levels[i].error ? { error: levels[i].error } : {
        integratedLufs: levels[i].integratedLufs,
        loudnessRange: levels[i].loudnessRange,
        truePeakDb: levels[i].truePeakDb,
        maxShortTermLufs: levels[i].maxShortTermLufs,
        ...(levels[i].integratedLufs === null ? { note: "silent (below R128's gate)" } : {}),
      }),
    }));

  return {
    measure_loudness: async (args) => {
      const view = await connectedView(context);
      const given = ids(args);
      let parts: Heard[];
      if (given) parts = soundClips(view, given);
      else {
        const start = optNum(args, "start") ?? view.inOut?.in ?? 0;
        const end = optNum(args, "end") ?? view.inOut?.out ?? view.duration;
        if (!(end > start)) throw new Error("end must be after start");
        parts = soundBetween(view, start, end);
        if (!parts.length) throw new Error(`No sound is heard on the ${noun} between ${clock(start)} and ${clock(end)}`);
      }
      const levels = await measure(parts);
      const loudest = levels.reduce<number | null>((m, l) => (l.integratedLufs !== null && (m === null || l.integratedLufs > m) ? l.integratedLufs : m), null);
      return {
        summary: `Measured ${parts.length} sound clip(s)${loudest !== null ? `; loudest ${loudest} LUFS` : ""}`,
        result: { clips: rows(parts, levels), note: "Per clip, before its level and the mix. Add a clip's levelDb to its integratedLufs for roughly how loud it plays." },
      };
    },

    normalize_loudness: async (args) => {
      refuseWhileDrafting(host, "change clip levels");
      const given = ids(args);
      if (!given) throw new Error("clipIds must list the sound clips to level");
      const target = optNum(args, "targetLufs") ?? -14;
      if (target < -40 || target > -5) throw new Error("targetLufs must be between -40 and -5");
      const ceiling = args.maxTruePeak === null ? null : (optNum(args, "maxTruePeak") ?? -1);
      const view = await connectedView(context);
      const parts = soundClips(view, given);
      const levels = await measure(parts);
      const plan = parts.map((p, i) => ({ part: p, level: levels[i], set: levelFor(levels[i], target, ceiling) }));
      const changes = plan.filter((p) => p.set && Math.abs(p.set.volumeDb - (p.part.clip.volumeDb ?? 0)) >= 0.1);
      const skipped = plan.filter((p) => !p.set).map((p) => `${p.part.clip.id}: ${p.level.error ?? "silent, so nothing to level"}`);
      const report = plan.filter((p) => p.set).map((p) => ({
        clipId: p.part.clip.id,
        name: p.part.clip.name,
        measuredLufs: p.level.integratedLufs,
        levelDb: p.set!.volumeDb,
        reachesLufs: p.set!.reachedLufs,
        ...(p.set!.peakLimited ? { peakLimited: `kept under ${ceiling} dBTP` } : {}),
        ...(p.set!.capped ? { capped: `held to ±${MAX_GAIN_DB} dB` } : {}),
      }));
      if (!changes.length) {
        return { summary: `Nothing to change: the clips already sit at ${target} LUFS or can't be levelled`, result: { target, clips: report, ...(skipped.length ? { skipped } : {}) } };
      }
      const edits = editExecutors({ host, timeline: context.timeline ?? "", step: context.step, stepText: context.stepText });
      const applied = await edits.set_clip_levels({ levels: changes.map((c) => ({ itemId: c.part.clip.id, volumeDb: c.set!.volumeDb })) });
      const limited = report.filter((r) => "peakLimited" in r || "capped" in r).length;
      return {
        summary: `Levelled ${changes.length} clip(s) to ${target} LUFS${limited ? ` (${limited} held short by peak or the ${MAX_GAIN_DB} dB limit)` : ""}. ${applied.summary}`,
        result: { target, clips: report, applied: applied.result, ...(skipped.length ? { skipped } : {}) },
      };
    },

    find_beats: async (args) => {
      const id = optStr(args, "clipId");
      if (!id) throw new Error("clipId must be a music clip on the timeline");
      const view = await connectedView(context);
      const [sound] = soundClips(view, [id]);
      const clip = sound.clip;
      const start = Math.max(clip.start, optNum(args, "start") ?? clip.start);
      const end = Math.min(clip.end, optNum(args, "end") ?? clip.end);
      if (!(end > start)) throw new Error(`start–end must overlap ${clip.id} (${clock(clip.start)}–${clock(clip.end)})`);
      const part = filePart(clip, start, end);
      const job = await runJob("media-beats", `Find the beats of "${clip.name}"`, { path: clip.filePath, start: Math.max(0, Math.min(part.from, part.to)), end: Math.max(part.from, part.to) });
      const found = job?.result as { bpm: number | null; confidence: number; beats: number[]; maybeDoubleTime?: number } | undefined;
      if (!found) throw new Error(job?.error ?? "The beats couldn't be found");
      const speed = clip.speed ?? 1;
      const toTimeline = (s: number) => round1000(speed < 0 ? clip.start + ((clip.sourceIn ?? 0) - s) / Math.abs(speed) : clip.start + (s - (clip.sourceIn ?? 0)) / (speed || 1));
      const beats = found.beats.map(toTimeline).filter((t) => t >= start && t < end).sort((a, b) => a - b);
      const bpm = found.bpm === null ? null : round1(found.bpm * Math.abs(speed || 1));
      return {
        summary: bpm ? `Found ${beats.length} beats in "${clip.name}" at ${bpm} BPM (confidence ${found.confidence})` : `No steady beat in "${clip.name}"`,
        result: {
          clipId: clip.id,
          bpm,
          confidence: found.confidence,
          ...(found.maybeDoubleTime ? { maybeDoubleTime: round1(found.maybeDoubleTime * Math.abs(speed || 1)) } : {}),
          beats,
          ...(found.confidence < 0.3 ? { note: "Low confidence: the music may have no steady pulse." } : {}),
        },
      };
    },
  };
}

const round1000 = (n: number) => Math.round(n * 1000) / 1000;

/** The ground rule the system prompt gains (Phase 13d). */
export const AUDIO_INSTRUCTION = `- You can hear levels and rhythm: measure_loudness (EBU R128 per clip) before judging or setting
  levels, normalize_loudness to bring dialogue to a delivery target (-14 LUFS web unless the notes or the
  user say otherwise), and find_beats on a music clip to cut or mark to the beat. Say the numbers briefly.`;
