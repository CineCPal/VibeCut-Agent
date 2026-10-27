/**
 * Cleaning dialogue (PLAN.md, "Phase 18c"): `clean_dialogue` runs the sound files of the given clips
 * through ffmpeg (the `media-clean` job: high-pass, FFT denoise, de-ess), writing a cleaned copy beside
 * each file, then lays the cleaned sound under each clip at the same place and source points, and switches
 * the original sound off. The original stays on its track, so switching the two is a before/after, and
 * revert_timeline_edits lastStep=true takes the whole thing back (one request, one backup).
 *
 * A direct edit like cut_to_beats: add_clips then set_clips_enabled, both reviewed under Review edits first.
 *
 * Filling room tone (PLAN.md, "Phase 18e"): `fill_room_tone` finds the holes in the dialogue, where none of its
 * tracks has sound, and fills each with room tone from the recording it follows (the `media-roomtone` job: the
 * quietest stretch near the clip, looped to length), laid with add_clips on that clip's own track. One request,
 * one backup, one Revert.
 */
import { runJob } from "../jobs";
import type { NleHost } from "../../types/nle";
import type { HostClip, HostTrack } from "../../types/timeline";
import { type Args, clock, type Executor, optNum, optStr, strArray, type ToolOutcome } from "./args";
import { connectedView, refuseWhileDrafting } from "./draft";
import { addClips, editExecutors } from "./editTools";
import { TIMELINE_NOUN } from "./edits";
import type { ToolContext, ToolDeclaration } from "./tools";

export const STRENGTHS = ["light", "medium", "strong"] as const;
export type Strength = (typeof STRENGTHS)[number];
/** media-clean's MAX_FILES. */
export const MAX_FILES = 16;

/** media-roomtone's MAX_SOURCES. */
export const MAX_TONE_SOURCES = 16;
/** Gaps longer than this are left alone unless maxSeconds says otherwise: likely meant to be quiet, or under music. */
export const DEFAULT_MAX_GAP = 10;
export const MAX_GAP = 60;
/** Room tone is made this much longer than the longest gap it fills, so each gap can start somewhere else in it. */
const TONE_HEADROOM = 3;
/** Each gap's room tone starts this much further into the file than the last's (wrapping), so they don't repeat. */
const TONE_STEP = 1.7;
/** A clip's recording is searched for room tone this far either side of what it plays. */
const SEARCH_MARGIN = 30;

const fileName = (path: string) => path.split(/[\\/]/).pop() || path;
const round3 = (n: number) => Math.round(n * 1000) / 1000;

interface CleanedFile {
  path: string;
  output?: string;
  duration?: number | null;
  reused?: boolean;
  error?: string;
}

/**
 * The sound clips to clean: each id's own clip if it is sound, else the sound linked to it. A file's
 * channels laid out as one clip per channel (same file, same place) are cleaned and laid once.
 */
export function soundClips(tracks: { type: string; clips: HostClip[] }[], ids: string[]): HostClip[] {
  const all = tracks.flatMap((t) => t.clips.map((c) => ({ clip: c, sound: t.type === "audio" })));
  const byId = new Map(all.map((x) => [x.clip.id, x]));
  const out: HostClip[] = [];
  const add = (c: HostClip) => {
    if (out.some((o) => o.filePath === c.filePath && Math.abs(o.start - c.start) < 1e-3 && Math.abs(o.end - c.end) < 1e-3)) return;
    out.push(c);
  };
  for (const id of ids) {
    const found = byId.get(id);
    if (!found) throw new Error(`There's no clip ${id} on the open timeline`);
    const linked = found.sound ? [found] : (found.clip.linkedIds ?? []).map((l) => byId.get(l)).filter((x) => x?.sound);
    if (!linked.length) throw new Error(`"${found.clip.name}" has no sound linked to it`);
    for (const x of linked) {
      const c = x!.clip;
      if (!c.filePath) throw new Error(`"${c.name}" has no media file`);
      if ((c.speed ?? 1) !== 1) throw new Error(`"${c.name}" has a speed change; clear_clip_speed it first`);
      if (c.enabled) add(c);
    }
  }
  if (!out.length) throw new Error("Those clips' sound is already switched off");
  return out;
}

export interface ToneFill {
  /** The audio track (1-based) the room tone goes on: the track of `clip`. */
  track: number;
  /** The clip whose recording the room tone comes from: the one the gap follows on that track, else the one after it. */
  clip: HostClip;
}

export interface ToneGap {
  start: number;
  end: number;
  fills: ToneFill[];
}

export interface TonePlan {
  tracks: number[];
  gaps: ToneGap[];
  /** Gaps over maxSeconds, left alone. */
  long: { start: number; end: number }[];
  /** Gaps with no recording beside them to take room tone from (a nested or offline clip). */
  bare: { start: number; end: number }[];
}

/**
 * The holes in the dialogue: stretches between its first and last sound (within `start`–`end`) where none of
 * the dialogue tracks has a switched-on clip, snapped to frames. The dialogue tracks are `tracks`, else every
 * audio track with sound linked to a picture. Each hole is filled on each track whose clip ends where it
 * starts (a split stereo recording's two channel clips both do), from that clip's recording; a hole opened
 * by `start` is filled from the clips that end it.
 */
export function roomToneGaps(
  all: HostTrack[],
  fps: number,
  options: { tracks?: number[]; start?: number; end?: number; minSeconds: number; maxSeconds: number },
): TonePlan {
  const audio = all.filter((t) => t.type === "audio");
  let numbers = options.tracks;
  if (!numbers?.length) {
    const pictures = new Set(all.filter((t) => t.type === "video").flatMap((t) => t.clips.map((c) => c.id)));
    numbers = audio.filter((t) => t.clips.some((c) => c.enabled && (c.linkedIds ?? []).some((id) => pictures.has(id)))).map((t) => t.index);
    if (!numbers.length) throw new Error("None of the sound is linked to a picture, so the dialogue tracks aren't known: give tracks (e.g. [1, 2])");
  }
  for (const n of numbers) if (!audio.some((t) => t.index === n)) throw new Error(`There's no audio track A${n}`);
  const chosen = audio.filter((t) => numbers.includes(t.index));
  const clips = chosen.flatMap((t) => t.clips.filter((c) => c.enabled && c.kind !== "effect").map((c) => ({ track: t.index, clip: c })));
  const plan: TonePlan = { tracks: chosen.map((t) => t.index), gaps: [], long: [], bare: [] };
  if (!clips.length) return plan;

  const half = 0.5 / fps;
  // Snapped inward, so a hole never reaches into a clip whose edge is off a frame.
  const up = (t: number) => round3(Math.ceil(t * fps - 1e-6) / fps);
  const down = (t: number) => round3(Math.floor(t * fps + 1e-6) / fps);
  const spans = clips.map((x) => [x.clip.start, x.clip.end]).sort((a, b) => a[0] - b[0]);
  const merged: number[][] = [];
  for (const [a, b] of spans) {
    const last = merged[merged.length - 1];
    if (last && a <= last[1] + half) last[1] = Math.max(last[1], b);
    else merged.push([a, b]);
  }
  const lo = Math.max(options.start ?? -Infinity, merged[0][0]);
  const hi = Math.min(options.end ?? Infinity, merged[merged.length - 1][1]);
  const usable = (x: { clip: HostClip }) => !!x.clip.filePath && !x.clip.nested && !x.clip.offline;
  for (let i = 1; i < merged.length; i++) {
    const [holeStart, holeEnd] = [merged[i - 1][1], merged[i][0]];
    const start = up(Math.max(holeStart, lo));
    const end = down(Math.min(holeEnd, hi));
    if (end - start < options.minSeconds - 1e-6 || end - start < 1 / fps - 1e-6) continue;
    if (end - start > options.maxSeconds + 1e-6) {
      plan.long.push({ start, end });
      continue;
    }
    const pick = (edge: (c: HostClip) => number, at: number) =>
      chosen.flatMap((t) => {
        const touching = clips.filter((x) => x.track === t.index && Math.abs(edge(x.clip) - at) < half && usable(x));
        return touching.length ? [touching[0]] : [];
      });
    const before = holeStart >= lo - 1e-6 ? pick((c) => c.end, holeStart) : [];
    const fills = before.length ? before : pick((c) => c.start, holeEnd);
    if (fills.length) plan.gaps.push({ start, end, fills });
    else plan.bare.push({ start, end });
  }
  return plan;
}

interface ToneFile {
  path: string;
  channel?: number;
  output?: string;
  duration?: number;
  sample?: { start: number; seconds: number };
  levelDb?: number;
  contrastDb?: number;
  quiet?: boolean;
  reused?: boolean;
  error?: string;
}

const numbers = (args: Args, key: string): number[] | undefined => {
  const raw = args[key];
  if (raw === undefined || raw === null) return undefined;
  if (!Array.isArray(raw) || raw.some((v) => typeof v !== "number" || !Number.isInteger(v) || v < 1)) throw new Error(`${key} must list audio track numbers, e.g. [1, 2]`);
  return raw as number[];
};

export function dialogueToolDeclarations(host: NleHost): ToolDeclaration[] {
  const noun = TIMELINE_NOUN[host];
  return [
    {
      name: "clean_dialogue",
      description: `Cleans the dialogue of clips on the open ${noun}: their sound files go through ffmpeg (a high-pass for rumble, a denoiser that follows the room's noise floor, and a de-esser above light), and a cleaned copy is written next to each file (name.vca-clean-<strength>.wav; reused when it exists). The cleaned sound is laid under each clip at the same place, on a free audio track, and the original sound is switched off, not removed: switching the two is a before/after. One Revert takes it all back. strength: light (gentle, safest), medium (default), strong (noisy locations; can sound watery). Give picture or sound clip ids; a picture's linked sound is used. Takes a while on long files (the whole file is cleaned). Clips with a speed change are refused. Can't run on a read-only card: copy the media first.`,
      parameters: {
        type: "OBJECT",
        properties: {
          clipIds: { type: "ARRAY", items: { type: "STRING" }, description: `Clips on the ${noun}.` },
          strength: { type: "STRING", enum: [...STRENGTHS], description: "Default medium." },
        },
        required: ["clipIds"],
      },
    },
    {
      name: "fill_room_tone",
      description: `Fills the holes in the dialogue on the open ${noun} with room tone, so the background doesn't drop to dead silence between cuts. A hole is a stretch between dialogue clips where none of the dialogue tracks has sound (tracks: audio track numbers; default every audio track with sound linked to a picture). Each is filled on the track of the clip it follows, with room tone from that clip's own recording: the quietest stretch near what the clip plays (no words in it), looped to length with crossfades, as a WAV in ~/Movies/VibeCut Renders/<project>/Room tone/. Or give path, a room tone recording, to use for every hole. Holes longer than maxSeconds (default ${DEFAULT_MAX_GAP}) are left alone, as likely meant to be quiet or under music. Nothing is overwritten or moved. One Revert takes it all off. Run it after the cut is settled, and after clean_dialogue when that was used (the room tone then comes from the cleaned sound).`,
      parameters: {
        type: "OBJECT",
        properties: {
          tracks: { type: "ARRAY", items: { type: "NUMBER" }, description: "The dialogue's audio tracks, 1-based. Optional." },
          start: { type: "NUMBER", description: `Only holes after this (${noun} seconds). Optional.` },
          end: { type: "NUMBER", description: `Only holes before this (${noun} seconds). Optional.` },
          minSeconds: { type: "NUMBER", description: "Leave holes shorter than this. Default a frame." },
          maxSeconds: { type: "NUMBER", description: `Leave holes longer than this, up to ${MAX_GAP}. Default ${DEFAULT_MAX_GAP}.` },
          path: { type: "STRING", description: "A recording of the room's tone to use instead (absolute path). Optional." },
        },
      },
    },
  ];
}

export function dialogueExecutors(context: ToolContext): Record<string, Executor> {
  const { host } = context;
  const noun = TIMELINE_NOUN[host];
  return {
    clean_dialogue: async (args): Promise<ToolOutcome> => {
      refuseWhileDrafting(host, "clean dialogue");
      const strength = (optStr(args, "strength") ?? "medium") as Strength;
      if (!STRENGTHS.includes(strength)) throw new Error("strength must be light, medium or strong");
      const view = await connectedView(context);
      const clips = soundClips(view.tracks, strArray(args, "clipIds"));
      const paths = [...new Set(clips.map((c) => c.filePath!))];
      if (paths.length > MAX_FILES) throw new Error(`That's ${paths.length} files; at most ${MAX_FILES} per call`);

      const job = await runJob("media-clean", `Clean the dialogue of ${paths.length} file(s)`, { paths, strength });
      const files = ((job?.result ?? {}) as { files?: CleanedFile[] }).files ?? [];
      const cleaned = new Map(files.flatMap((f) => (f.output ? [[f.path, f] as const] : [])));
      const failed = files.filter((f) => f.error).map((f) => `${fileName(f.path)}: ${f.error}`);
      const usable = clips.filter((c) => {
        const out = cleaned.get(c.filePath!);
        const sourceOut = c.sourceOut ?? (c.sourceIn ?? 0) + c.end - c.start;
        // A cleaned file shorter than the clip's out point (it shouldn't be) is left out rather than cut short.
        return out && (out.duration == null || out.duration + 0.05 >= sourceOut);
      });
      if (!usable.length) throw new Error(failed[0] ?? job?.error ?? "No file could be cleaned");

      const ctx = { host, timeline: context.timeline ?? "", step: context.step, stepText: context.stepText };
      const specs = usable.map((c) => ({
        path: cleaned.get(c.filePath!)!.output!,
        at: c.start,
        sourceIn: c.sourceIn ?? 0,
        sourceOut: c.sourceOut ?? (c.sourceIn ?? 0) + c.end - c.start,
        picture: false,
        sound: true,
        ...(c.volumeDb !== undefined && c.volumeDb !== 0 ? { volumeDb: c.volumeDb } : {}),
      }));
      const added = await addClips(ctx, "clean_dialogue", specs);
      const r = added.result as { changes?: { tracks?: string[] }[]; refused?: { clip?: number; reason: string }[]; error?: string };
      const refusedIdx = new Set((r.refused ?? []).map((x) => x.clip));
      const placed = usable.filter((_, i) => !refusedIdx.has(i));
      if (!placed.length) throw new Error(`The cleaned sound couldn't be placed: ${(r.refused ?? []).map((x) => x.reason).join("; ") || "nothing was added"}`);
      // The original sound of each placed clip goes off, with the other channels of its recording.
      const off = view.tracks
        .filter((t) => t.type === "audio")
        .flatMap((t) => t.clips)
        .filter((c) => c.enabled && placed.some((p) => p.filePath === c.filePath && Math.abs(p.start - c.start) < 1e-3 && Math.abs(p.end - c.end) < 1e-3))
        .map((c) => c.id);
      await editExecutors(ctx).set_clips_enabled({ itemIds: off, enabled: false });

      const tracks = [...new Set((r.changes ?? []).flatMap((c) => c.tracks ?? []))];
      const reused = files.filter((f) => f.reused).length;
      return {
        summary: `Cleaned the dialogue (${strength}) of ${placed.length} clip(s): the cleaned sound is on ${tracks.join(", ") || "a free track"} and the original switched off${failed.length ? `; ${failed.length} file(s) failed` : ""}`,
        result: {
          strength,
          cleanedClips: placed.length,
          tracks,
          originalsSwitchedOff: off,
          files: [...cleaned.values()].map((f) => ({ source: f.path, cleaned: f.output, ...(f.reused ? { reused: true } : {}) })),
          ...(reused ? { note: `${reused} cleaned file(s) were already there and reused` } : {}),
          ...(failed.length ? { failed } : {}),
          ...(r.refused?.length ? { refused: r.refused.map((x) => x.reason) } : {}),
          compare: `To hear the original, switch its sound back on and the cleaned clip off (set_clips_enabled); revert_timeline_edits lastStep=true puts the ${noun} back as it was`,
        },
      };
    },

    fill_room_tone: async (args): Promise<ToolOutcome> => {
      refuseWhileDrafting(host, "fill room tone");
      const maxSeconds = optNum(args, "maxSeconds") ?? DEFAULT_MAX_GAP;
      if (!(maxSeconds > 0 && maxSeconds <= MAX_GAP)) throw new Error(`maxSeconds must be more than 0 and at most ${MAX_GAP}`);
      const recording = optStr(args, "path");
      if (recording !== undefined && !recording.startsWith("/")) throw new Error("path must be an absolute path to a room tone recording");
      const view = await connectedView(context);
      const plan = roomToneGaps(view.tracks, view.fps, {
        tracks: numbers(args, "tracks"),
        start: optNum(args, "start"),
        end: optNum(args, "end"),
        minSeconds: optNum(args, "minSeconds") ?? 0,
        maxSeconds,
      });
      const left = [
        ...(plan.long.length ? [`${plan.long.length} hole(s) longer than ${maxSeconds} s left alone (${plan.long.map((g) => clock(g.start)).join(", ")})`] : []),
        ...(plan.bare.length ? [`${plan.bare.length} hole(s) beside a clip with no media file left alone (${plan.bare.map((g) => clock(g.start)).join(", ")})`] : []),
      ];
      const trackNames = plan.tracks.map((n) => `A${n}`).join(", ");
      if (!plan.gaps.length) {
        return { summary: `There are no holes to fill in the dialogue on ${trackNames || "the audio tracks"}${left.length ? `; ${left.join("; ")}` : ""}`, result: { tracks: plan.tracks.map((n) => `A${n}`), filled: 0, ...(left.length ? { left } : {}) } };
      }

      // One room tone file per recording (and channel, for a clip that plays one channel of it), searched near
      // everything its clips play and long enough for the longest hole it fills.
      const keyOf = (c: HostClip) => (recording ? recording : `${c.filePath}|${c.channel ?? ""}`);
      const sources = new Map<string, { path: string; channel?: number; start?: number; end?: number; longest: number }>();
      for (const gap of plan.gaps) {
        for (const { clip } of gap.fills) {
          const key = keyOf(clip);
          const sourceIn = clip.sourceIn ?? 0;
          const sourceOut = clip.sourceOut ?? sourceIn + (clip.end - clip.start) * (clip.speed ?? 1);
          const known = sources.get(key);
          if (recording) sources.set(key, { path: recording, longest: Math.max(known?.longest ?? 0, gap.end - gap.start) });
          else
            sources.set(key, {
              path: clip.filePath!,
              ...(clip.channel ? { channel: clip.channel } : {}),
              start: Math.min(known?.start ?? Infinity, Math.max(0, sourceIn - SEARCH_MARGIN)),
              end: Math.max(known?.end ?? 0, sourceOut + SEARCH_MARGIN),
              longest: Math.max(known?.longest ?? 0, gap.end - gap.start),
            });
        }
      }
      if (sources.size > MAX_TONE_SOURCES) throw new Error(`The holes follow ${sources.size} different recordings; at most ${MAX_TONE_SOURCES} per call, so give start and end to do part of the ${noun}`);
      const keys = [...sources.keys()];
      const job = await runJob("media-roomtone", `Make room tone from ${keys.length} recording(s)`, {
        sources: keys.map((k) => {
          const { longest, start, end, ...rest } = sources.get(k)!;
          return { ...rest, ...(start !== undefined ? { start: round3(start), end: round3(end!) } : {}), seconds: Math.ceil(longest + TONE_HEADROOM) };
        }),
        project: view.project,
      });
      const files = ((job?.result ?? {}) as { files?: ToneFile[] }).files ?? [];
      const made = new Map(keys.flatMap((k, i) => (files[i]?.output && files[i].duration ? [[k, files[i]] as const] : [])));
      const failed = files.flatMap((f) => (f.error ? [`${fileName(f.path)}${f.channel ? ` (channel ${f.channel})` : ""}: ${f.error}`] : []));
      if (!made.size) throw new Error(failed[0] ?? job?.error ?? "No room tone could be made");

      const used = new Map<string, number>();
      const floorFrame = (t: number) => round3(Math.floor(t * view.fps + 1e-6) / view.fps);
      const specs: Record<string, unknown>[] = [];
      const filled: { at: number; seconds: number; track: string; from: string }[] = [];
      for (const gap of plan.gaps) {
        for (const { track, clip } of gap.fills) {
          const key = keyOf(clip);
          const tone = made.get(key);
          if (!tone) continue;
          const length = round3(gap.end - gap.start);
          const room = tone.duration! - length;
          const k = used.get(key) ?? 0;
          used.set(key, k + 1);
          const sourceIn = room > 0 ? floorFrame((k * TONE_STEP) % room) : 0;
          specs.push({
            path: tone.output!,
            at: gap.start,
            sourceIn,
            sourceOut: round3(sourceIn + length),
            audioTrack: track,
            picture: false,
            sound: true,
            ...(clip.volumeDb !== undefined && clip.volumeDb !== 0 ? { volumeDb: clip.volumeDb } : {}),
          });
          filled.push({ at: gap.start, seconds: length, track: `A${track}`, from: fileName(recording ?? clip.filePath!) });
        }
      }
      if (!specs.length) throw new Error(failed[0] ?? "No room tone could be made");

      const ctx = { host, timeline: context.timeline ?? "", step: context.step, stepText: context.stepText };
      const added = await addClips(ctx, "fill_room_tone", specs);
      const r = added.result as { changes?: { tracks?: string[] }[]; refused?: { clip?: number; reason: string }[]; error?: string };
      if (r.error) throw new Error(r.error);
      const refusedIdx = new Set((r.refused ?? []).map((x) => x.clip));
      const placed = filled.filter((_, i) => !refusedIdx.has(i));
      if (!placed.length) throw new Error(`The room tone couldn't be placed: ${(r.refused ?? []).map((x) => x.reason).join("; ") || "nothing was added"}`);

      const unsure = [...made.values()].filter((f) => f.quiet === false).map((f) => fileName(f.path));
      const total = round3(placed.reduce((sum, f) => sum + f.seconds, 0));
      const holes = new Set(placed.map((f) => f.at)).size;
      return {
        summary: `Filled ${holes} hole(s) in the dialogue with room tone (${total} s on ${[...new Set(placed.map((f) => f.track))].join(", ")})${failed.length ? `; ${failed.length} recording(s) failed` : ""}${unsure.length ? `; ${unsure.join(", ")} had no clear pause, so check by ear` : ""}`,
        result: {
          tracks: plan.tracks.map((n) => `A${n}`),
          filled: placed,
          roomTone: [...made.values()].map((f) => ({
            from: f.path,
            ...(f.channel ? { channel: f.channel } : {}),
            file: f.output,
            sample: f.sample,
            levelDb: f.levelDb,
            underSpeechDb: f.contrastDb,
            ...(f.reused ? { reused: true } : {}),
          })),
          ...(unsure.length ? { noClearPause: unsure, note: "The quietest stretch in these is close to the speech level, so the room tone may have words in it: listen, or give path (a room tone recording)" } : {}),
          ...(left.length ? { left } : {}),
          ...(failed.length ? { failed } : {}),
          ...(r.refused?.length ? { refused: r.refused.map((x) => x.reason) } : {}),
          next: `Play across a filled hole to check it; revert_timeline_edits lastStep=true takes it all off`,
        },
      };
    },
  };
}

/** The ground rule the system prompt gains (Phases 18c and 18e). */
export const DIALOGUE_INSTRUCTION = `- Noisy dialogue (hiss, room tone, air conditioning, rumble): clean_dialogue, light or medium first,
  strong only for bad locations. Ask before running it on many long files (it cleans whole files).
- Dead silence between dialogue cuts (the background drops out): fill_room_tone, once the cut is settled.`;
