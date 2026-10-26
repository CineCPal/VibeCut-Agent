/**
 * Cutting a multicam by who's talking (PLAN.md, "Phase 18a"): `cut_by_speaker` takes synced camera
 * angles, each on a video track of its own (as sync_and_place lays them), and switches between them in
 * the draft: the angle of whoever is talking is switched on and the others off over each stretch. Who is
 * talking comes from the transcripts' speakers, or from each person's own mic, the loudest one winning.
 *
 * Shots shorter than minShotSeconds are folded into the one before (so a "mm-hm" doesn't flash an angle),
 * cuts land a few frames before the words, two people talking at once go to the wide, and a shot held past
 * maxShotSeconds gets a cutaway (the wide, or the listener's angle). An angle with no clip at a moment is
 * never chosen there. Every clip stays on its track, so the user can re-enable another angle by hand.
 *
 * The planning is pure (`speakerActivity`, `levelActivity`, `planShots`, `applyShots`); the executor reads
 * the draft, the transcripts or the mics' peaks, and saves the draft like the other draft tools.
 */
import { runJob } from "../jobs";
import type { NleHost } from "../../types/nle";
import type { DraftClip, DraftTrack, HostDraft } from "../../vibecut/lib/connect/hostDraft";
import { laneLines } from "../../vibecut/lib/transcriptLane";
import type { WaveformPeaks } from "../../vibecut/types/waveform";
import { type Args, clock, type Executor, optNum, optStr, type ToolOutcome } from "./args";
import { openDraft, saveDraft } from "./draft";
import { TIMELINE_NOUN } from "./edits";
import { filesOf, heardView } from "./transcriptTools";
import type { ToolContext, ToolDeclaration } from "./tools";

/** Samples per second the activity is judged at; shots are snapped to frames afterwards. */
export const RATE = 10;
export const DEFAULTS = {
  minShotSeconds: 2,
  leadFrames: 4,
  maxShotSeconds: 12,
  cutawaySeconds: 2.5,
  thresholdDb: -40,
  overlapDb: 4,
  smoothSeconds: 0.5,
};
export const CUTAWAYS = ["wide", "listener", "none"] as const;
export type Cutaway = (typeof CUTAWAYS)[number];

const round3 = (n: number) => Math.round(n * 1000) / 1000;
const fileName = (path: string) => path.split(/[\\/]/).pop() || path;

export interface Angle {
  /** 1-based video track. */
  track: number;
  /** Speakers' display names, lowercase. */
  speakers: string[];
  /** This person's own mic files (absolute paths). */
  mics: string[];
}

export interface Turn {
  start: number;
  end: number;
  speaker: string;
  file: string;
}

/** Per sample from `from`, the angles (indexes into `angles`) whose person is talking. */
export type Activity = number[][];

/** Who is talking, from transcript lines: a line counts for the angle its speaker or its mic belongs to. */
export function speakerActivity(turns: Turn[], angles: Angle[], from: number, to: number): Activity {
  const samples = Math.max(0, Math.ceil((to - from) * RATE));
  const activity: Activity = Array.from({ length: samples }, () => []);
  for (const turn of turns) {
    const who = turn.speaker.toLowerCase();
    const angle = angles.findIndex((a) => a.speakers.includes(who) || (a.speakers.length === 0 && a.mics.includes(turn.file)));
    if (angle < 0) continue;
    const a = Math.max(0, Math.floor((turn.start - from) * RATE));
    const b = Math.min(samples, Math.ceil((turn.end - from) * RATE));
    for (let i = a; i < b; i++) if (!activity[i].includes(angle)) activity[i].push(angle);
  }
  return activity;
}

/**
 * Who is talking, from each angle's mic level (dBFS per sample, -Infinity for silence): the loudest above
 * the threshold, and any other within overlapDb of it (both talking). Levels are averaged over
 * smoothSeconds first, so a breath or a plosive doesn't count.
 */
export function levelActivity(levels: number[][], thresholdDb: number, overlapDb: number, smoothSeconds: number): Activity {
  const samples = Math.max(0, ...levels.map((l) => l.length));
  const half = Math.max(0, Math.round((smoothSeconds * RATE) / 2));
  const smooth = levels.map((l) =>
    Array.from({ length: samples }, (_, i) => {
      let sum = 0;
      let n = 0;
      for (let k = Math.max(0, i - half); k <= Math.min(samples - 1, i + half); k++) {
        sum += Number.isFinite(l[k]) ? Math.pow(10, l[k] / 20) : 0;
        n++;
      }
      return n && sum > 0 ? 20 * Math.log10(sum / n) : -Infinity;
    }),
  );
  return Array.from({ length: samples }, (_, i) => {
    const loudest = Math.max(...smooth.map((l) => l[i]));
    if (!(loudest >= thresholdDb)) return [];
    return smooth.flatMap((l, a) => (l[i] >= thresholdDb && l[i] >= loudest - overlapDb ? [a] : []));
  });
}

export interface PlanOptions {
  from: number;
  fps: number;
  /** Video tracks with a switched-on clip, per sample. */
  coverage: Set<number>[];
  wideTrack?: number;
  minShotSeconds: number;
  leadFrames: number;
  cutaway: Cutaway;
  maxShotSeconds: number;
  cutawaySeconds: number;
}

export type ShotReason = "speaker" | "both" | "hold" | "cutaway";

export interface PlannedShot {
  start: number;
  end: number;
  track: number;
  reason: ShotReason;
}

interface Run {
  a: number;
  b: number;
  track: number;
  reason: ShotReason;
}

/** Joins neighbouring runs on the same track. */
function joined(runs: Run[]): Run[] {
  const out: Run[] = [];
  for (const r of runs) {
    const last = out[out.length - 1];
    if (last && last.track === r.track && last.b === r.a) last.b = r.b;
    else out.push({ ...r });
  }
  return out;
}

/** The shots, in timeline seconds snapped to frames: one track at a time from `from` to the activity's end. */
export function planShots(activity: Activity, angles: Angle[], options: PlanOptions): PlannedShot[] {
  const { coverage, wideTrack } = options;
  const samples = activity.length;
  if (!samples) return [];
  // The cut comes leadFrames before the words: each talking stretch starts that much earlier.
  const lead = Math.round((options.leadFrames / options.fps) * RATE);
  const led: Activity = activity.map((s) => [...s]);
  if (lead > 0) {
    for (let i = 0; i < samples; i++) {
      for (const a of activity[i]) {
        if (i > 0 && activity[i - 1].includes(a)) continue;
        for (let k = Math.max(0, i - lead); k < i; k++) if (!led[k].includes(a)) led[k].push(a);
      }
    }
  }
  const covered = (i: number, track: number | undefined) => track !== undefined && coverage[i]?.has(track);
  const runs: Run[] = [];
  let current: number | undefined;
  for (let i = 0; i < samples; i++) {
    const talking = led[i].map((a) => angles[a].track).filter((t) => covered(i, t));
    let track: number | undefined;
    let reason: ShotReason = "speaker";
    if (talking.length === 1) track = talking[0];
    else if (talking.length > 1) {
      reason = "both";
      track = covered(i, wideTrack) ? wideTrack : talking.includes(current ?? -1) ? current : talking[0];
    } else {
      reason = "hold";
      track = covered(i, current) ? current : covered(i, wideTrack) ? wideTrack : angles.map((a) => a.track).find((t) => covered(i, t));
    }
    if (track === undefined) track = current ?? wideTrack ?? angles[0].track;
    current = track;
    runs.push({ a: i, b: i + 1, track, reason });
  }
  // Short shots go into the one before, or the one after when that one's angle has no picture there. A
  // short overlap at a handoff (the mics' smoothing makes one; so does a line that starts before the last
  // ends) goes to the incoming speaker, so the cut keeps its lead instead of landing after the words.
  const min = Math.max(1, Math.round(options.minShotSeconds * RATE));
  const spans = (s: Run, track: number) => Array.from({ length: s.b - s.a }, (_, k) => covered(s.a + k, track)).every(Boolean);
  let shots = joined(runs);
  for (;;) {
    const i = shots.findIndex((s) => shots.length > 1 && s.b - s.a < min);
    if (i < 0) break;
    const [before, after] = [shots[i - 1], shots[i + 1]];
    const handoff = before && after && shots[i].reason === "both" && before.track !== after.track && after.reason === "speaker" && spans(shots[i], after.track);
    if (before && !handoff && (spans(shots[i], before.track) || !after)) before.b = shots[i].b;
    else after.a = shots[i].a;
    shots.splice(i, 1);
    shots = joined(shots);
  }
  shots = withCutaways(shots, options, min);
  // To frames.
  const frame = (sample: number) => round3(Math.round((options.from + sample / RATE) * options.fps) / options.fps);
  return shots.map((s) => ({ start: frame(s.a), end: frame(s.b), track: s.track, reason: s.reason })).filter((s) => s.end > s.start);
}

/** Breaks shots held past maxShotSeconds with cutaways, evenly spaced, each leaving at least a minimum
 * shot either side, on the wide or the listener's angle (the shot before's, else the one after's). */
function withCutaways(shots: Run[], options: PlanOptions, min: number): Run[] {
  if (options.cutaway === "none" || !(options.maxShotSeconds > 0)) return shots;
  const max = Math.round(options.maxShotSeconds * RATE);
  const length = Math.max(1, Math.round(options.cutawaySeconds * RATE));
  const out: Run[] = [];
  for (const [k, shot] of shots.entries()) {
    const away = options.cutaway === "wide" ? options.wideTrack : (shots[k - 1]?.track ?? shots[k + 1]?.track);
    const span = shot.b - shot.a;
    const n = Math.floor(span / max);
    if (away === undefined || away === shot.track || n < 1 || span < n * length + (n + 1) * min) {
      out.push(shot);
      continue;
    }
    let cursor = shot.a;
    for (let j = 1; j <= n; j++) {
      const at = Math.round(shot.a + (j * span) / (n + 1) - length / 2);
      const free = Array.from({ length }, (_, m) => options.coverage[at + m]?.has(away)).every(Boolean);
      if (!free || at - cursor < min) continue;
      out.push({ ...shot, a: cursor, b: at }, { a: at, b: at + length, track: away, reason: "cutaway" });
      cursor = at + length;
    }
    out.push({ ...shot, a: cursor });
  }
  return out;
}

/** The part of a constant-speed clip between `a` and `b` (timeline seconds). */
function cut(clip: DraftClip, a: number, b: number, enabled: boolean): DraftClip {
  return {
    ...clip,
    start: a,
    end: b,
    sourceIn: round3(clip.sourceIn + (a - clip.start) * clip.speed),
    sourceOut: round3(clip.sourceIn + (b - clip.start) * clip.speed),
    enabled,
  };
}

/**
 * The draft with the shots applied between `from` and `to`: on each angle's track, its clips are cut at
 * the edges of that track's shots and switched off outside them. Clips outside the range, other tracks
 * and the sound are left as they are.
 */
export function applyShots(draft: HostDraft, shots: PlannedShot[], tracks: number[], from: number, to: number, change: string): HostDraft {
  const half = 0.5 / draft.fps;
  const video = draft.video.map((track: DraftTrack, i): DraftTrack => {
    const number = i + 1;
    if (!tracks.includes(number)) return track;
    const on = shots.filter((s) => s.track === number);
    const clips = track.clips.flatMap((clip) => {
      if (clip.end <= from + half || clip.start >= to - half) return [clip];
      if (clip.timeRemap) throw new Error(`"${clip.sourceName}" on V${number} has a speed ramp; clear_clip_speed it first, or leave that stretch out with start/end`);
      const edges = [clip.start, clip.end, from, to, ...on.flatMap((s) => [s.start, s.end])].filter((t) => t >= clip.start && t <= clip.end);
      const points = [...new Set(edges.map(round3))].sort((x, y) => x - y);
      const pieces: DraftClip[] = [];
      for (let p = 0; p + 1 < points.length; p++) {
        const [a, b] = [points[p], points[p + 1]];
        if (b - a < half) continue;
        const mid = (a + b) / 2;
        const inside = mid >= from && mid < to;
        const enabled = inside ? clip.enabled && on.some((s) => s.start <= mid && mid < s.end) : clip.enabled;
        const last = pieces[pieces.length - 1];
        // Neighbouring pieces in the same state stay one clip.
        if (last && last.enabled === enabled && Math.abs(last.end - a) < 1e-6) pieces[pieces.length - 1] = cut(clip, last.start, b, enabled);
        else pieces.push(cut(clip, a, b, enabled));
      }
      return pieces;
    });
    return { ...track, clips };
  });
  return { ...draft, video, changes: [...draft.changes, change] };
}

/** Per sample from `from`, the video tracks with a switched-on clip in the draft. */
export function coverageOf(draft: HostDraft, from: number, samples: number): Set<number>[] {
  return Array.from({ length: samples }, (_, i) => {
    const t = from + (i + 0.5) / RATE;
    return new Set(draft.video.flatMap((track, k) => (track.clips.some((c) => c.enabled && c.start <= t && t < c.end) ? [k + 1] : [])));
  });
}

/** A mic's level in dBFS per sample from `from`, through every switched-on clip of its file in the draft. */
export function micLevels(draft: HostDraft, path: string, peaks: WaveformPeaks, from: number, samples: number): number[] {
  const clips = draft.audio.flatMap((t) => t.clips).filter((c) => c.sourcePath === path && c.enabled);
  return Array.from({ length: samples }, (_, i) => {
    const t = from + (i + 0.5) / RATE;
    const clip = clips.find((c) => c.start <= t && t < c.end);
    if (!clip) return -Infinity;
    const index = Math.floor((clip.sourceIn + (t - clip.start) * clip.speed) * peaks.peaksPerSecond);
    const level = Math.max(Math.abs(peaks.mins[index] ?? 0), Math.abs(peaks.maxes[index] ?? 0));
    return level > 0 ? 20 * Math.log10(level) : -Infinity;
  });
}

// ----------------------------------------------------------------------------- the tool

export function multicamToolDeclarations(host: NleHost): ToolDeclaration[] {
  const noun = TIMELINE_NOUN[host];
  return [
    {
      name: "cut_by_speaker",
      description: `Cuts a multicam by who's talking, in the draft (opened from the connected ${noun} if there isn't one). Each angle is a synced camera on a video track of its own (sync_and_place lays them so); give each one the speakers it shows (names from list_speakers) and/or that person's own mic (an audio clip id or file path). by "loudness" (the default when every angle has a mic) picks the loudest mic, which suits a podcast with a mic each; by "transcript" uses the transcripts' speakers, which suits one recorder or a diarized mix. Over each stretch the talking person's angle is switched on and the other angles off; shots under minShotSeconds fold into the shot before, cuts land leadFrames before the words, two people talking at once go to wideTrack, and a shot held past maxShotSeconds gets a cutaway (the wide, or the listener's angle). Clips stay on their tracks (switched off), the sound isn't touched, and other video tracks (B-roll, titles) are left alone. Send the draft to make the new ${noun}.`,
      parameters: {
        type: "OBJECT",
        properties: {
          angles: {
            type: "ARRAY",
            items: {
              type: "OBJECT",
              properties: {
                track: { type: "NUMBER", description: "The angle's video track, 1-based." },
                speakers: { type: "ARRAY", items: { type: "STRING" }, description: "Display names of who this angle shows. Optional." },
                mic: { type: "STRING", description: `That person's own mic: an audio clip id on the ${noun}, or a file path. Optional.` },
              },
              required: ["track"],
            },
          },
          wideTrack: { type: "NUMBER", description: "The wide shot's video track, for overlaps and cutaways. Optional." },
          by: { type: "STRING", enum: ["loudness", "transcript"], description: "Optional; see above." },
          start: { type: "NUMBER", description: `Only cut from this ${noun} time. Optional.` },
          end: { type: "NUMBER", description: `Only cut up to this ${noun} time. Optional.` },
          minShotSeconds: { type: "NUMBER", description: `Default ${DEFAULTS.minShotSeconds}.` },
          leadFrames: { type: "NUMBER", description: `Cut this many frames before the words. Default ${DEFAULTS.leadFrames}.` },
          cutaway: { type: "STRING", enum: [...CUTAWAYS], description: "Default wide when wideTrack is given, else listener." },
          maxShotSeconds: { type: "NUMBER", description: `Longest shot before a cutaway. Default ${DEFAULTS.maxShotSeconds}.` },
          cutawaySeconds: { type: "NUMBER", description: `Default ${DEFAULTS.cutawaySeconds}.` },
          thresholdDb: { type: "NUMBER", description: `by loudness: quieter than this (dBFS) is nobody talking. Default ${DEFAULTS.thresholdDb}.` },
        },
        required: ["angles"],
      },
    },
  ];
}

export function multicamExecutors(context: ToolContext): Record<string, Executor> {
  const { host } = context;
  const noun = TIMELINE_NOUN[host];
  return {
    cut_by_speaker: async (args): Promise<ToolOutcome> => {
      const draft = await openDraft(context);
      const raw = args.angles;
      if (!Array.isArray(raw) || raw.length < 2) throw new Error("angles must list at least two angles");
      const angles: Angle[] = [];
      for (const [i, value] of raw.entries()) {
        const e = (typeof value === "object" && value !== null ? value : {}) as Args;
        const track = optNum(e, "track");
        if (track === undefined || !Number.isInteger(track) || track < 1 || track > draft.video.length) throw new Error(`angles[${i}].track must be a video track from 1 to ${draft.video.length}`);
        if (angles.some((a) => a.track === track)) throw new Error(`V${track} is given twice`);
        const speakers = Array.isArray(e.speakers) ? e.speakers.filter((s): s is string => typeof s === "string").map((s) => s.toLowerCase()) : [];
        const mic = optStr(e, "mic");
        const mics = mic ? (mic.startsWith("/") ? [mic] : await filesOf(context, [mic])) : [];
        if (!speakers.length && !mics.length) throw new Error(`angles[${i}]: give its speakers or its mic`);
        angles.push({ track, speakers, mics });
      }
      const wideTrack = optNum(args, "wideTrack");
      if (wideTrack !== undefined && (!Number.isInteger(wideTrack) || wideTrack < 1 || wideTrack > draft.video.length)) throw new Error(`wideTrack must be a video track from 1 to ${draft.video.length}`);
      if (wideTrack !== undefined && angles.some((a) => a.track === wideTrack)) throw new Error(`V${wideTrack} is both an angle and the wide`);
      const by = optStr(args, "by") ?? (angles.every((a) => a.mics.length) ? "loudness" : "transcript");
      if (by !== "loudness" && by !== "transcript") throw new Error('by must be "loudness" or "transcript"');
      if (by === "loudness" && !angles.every((a) => a.mics.length)) throw new Error("by loudness needs every angle's mic");
      const cutaway = (optStr(args, "cutaway") ?? (wideTrack !== undefined ? "wide" : "listener")) as Cutaway;
      if (!CUTAWAYS.includes(cutaway)) throw new Error("cutaway must be wide, listener or none");
      if (cutaway === "wide" && wideTrack === undefined) throw new Error("cutaway wide needs wideTrack");

      const tracks = [...angles.map((a) => a.track), ...(wideTrack !== undefined ? [wideTrack] : [])];
      const used = draft.video.flatMap((t, i) => (tracks.includes(i + 1) ? t.clips : []));
      const from = Math.max(0, optNum(args, "start") ?? Math.min(...used.map((c) => c.start)));
      const to = Math.min(draft.duration, optNum(args, "end") ?? Math.max(...used.map((c) => c.end)));
      if (!(to > from)) throw new Error(`Nothing on the angles' tracks${optNum(args, "start") !== undefined ? " in that range" : ""}`);
      const samples = Math.ceil((to - from) * RATE);

      let activity: Activity;
      const notes: string[] = [];
      if (by === "loudness") {
        const paths = [...new Set(angles.flatMap((a) => a.mics))];
        const job = await runJob("audio-peaks", `Measure ${paths.length} mic(s)`, { paths });
        const peaks = ((job?.result ?? {}) as { peaks?: Record<string, WaveformPeaks> }).peaks ?? {};
        const missing = paths.filter((p) => !peaks[p]);
        if (missing.length) throw new Error(`Couldn't read the sound of ${missing.map(fileName).join(", ")}${job?.error ? ` (${job.error})` : ""}`);
        const levels = angles.map((a) => micLevels(draft, a.mics[0], peaks[a.mics[0]], from, samples));
        const silent = angles.filter((_, i) => levels[i].every((l) => !Number.isFinite(l)));
        if (silent.length) throw new Error(`No switched-on clip of ${silent.map((a) => fileName(a.mics[0])).join(", ")} is in the draft over that stretch`);
        activity = levelActivity(levels, optNum(args, "thresholdDb") ?? DEFAULTS.thresholdDb, DEFAULTS.overlapDb, DEFAULTS.smoothSeconds);
      } else {
        const { clips, transcripts, untranscribed } = await heardView(context);
        const lines = laneLines(clips.heard, transcripts, clips.assetsById);
        if (!lines.length) throw new Error(`Nothing heard on the ${noun} has a transcript${untranscribed.length ? ` (${untranscribed.join(", ")}); transcribe_clips with speakers: true makes them` : ""}`);
        const turns = lines.map((l) => ({ start: l.start, end: l.end, speaker: l.speaker, file: clips.assetsById[l.assetId]?.filePath ?? "" }));
        const known = new Set(turns.map((t) => t.speaker.toLowerCase()));
        const unknown = angles.flatMap((a) => a.speakers).filter((s) => !known.has(s));
        if (unknown.length) throw new Error(`No line is spoken by ${unknown.join(", ")} (the speakers are: ${[...known].join(", ")}); list_speakers gives the names`);
        activity = speakerActivity(turns, angles, from, to);
        if (untranscribed.length) notes.push(`not transcribed: ${untranscribed.join(", ")}`);
      }
      if (activity.every((s) => s.length === 0)) throw new Error(by === "loudness" ? "No mic is louder than the threshold over that stretch; try a lower thresholdDb" : "None of the angles' speakers talks over that stretch");

      const shots = planShots(activity, angles, {
        from,
        fps: draft.fps,
        coverage: coverageOf(draft, from, samples),
        wideTrack,
        minShotSeconds: optNum(args, "minShotSeconds") ?? DEFAULTS.minShotSeconds,
        leadFrames: optNum(args, "leadFrames") ?? DEFAULTS.leadFrames,
        cutaway,
        maxShotSeconds: optNum(args, "maxShotSeconds") ?? DEFAULTS.maxShotSeconds,
        cutawaySeconds: optNum(args, "cutawaySeconds") ?? DEFAULTS.cutawaySeconds,
      });
      const change = `Cut ${angles.length} angles by ${by === "loudness" ? "who's loudest" : "who's talking"} into ${shots.length} shot(s), ${clock(from)}–${clock(to)}`;
      const saved = saveDraft(host, applyShots(draft, shots, tracks, from, to, change));
      const seconds = (track: number) => round3(shots.filter((s) => s.track === track).reduce((n, s) => n + s.end - s.start, 0));
      return {
        summary: `${saved.summary}${notes.length ? `; ${notes.join("; ")}` : ""}`,
        result: {
          ...(saved.result as object),
          by,
          shots: shots.length,
          cutaways: shots.filter((s) => s.reason === "cutaway").length,
          screenTime: Object.fromEntries(tracks.map((t) => [`V${t}`, seconds(t)])),
          cuts: shots.slice(0, 200).map((s) => ({ at: s.start, track: `V${s.track}`, why: s.reason })),
          ...(notes.length ? { notes } : {}),
          next: `look_at_timeline to check a few cuts, then send_to_${host}`,
        },
      };
    },
  };
}

/** The ground rule the system prompt gains (Phase 18a). */
export const MULTICAM_INSTRUCTION = `- A multicam (two or more synced cameras on their own video tracks, e.g. a podcast or a two-camera
  interview): cut_by_speaker switches angles by who's talking, in the draft. Find which track shows whom
  (look_at_clip) and each person's mic or speaker name (list_speakers) first; ask when it's unclear.`;
