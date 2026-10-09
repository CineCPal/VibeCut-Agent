/**
 * Cutting to the beat (PLAN.md, "Phase 14c"): `cut_to_beats` finds a music clip's beats (`beatsOf`, the
 * `media-beats` job), turns every Nth one into a cut, and lays shots into the slots between them as
 * picture only, on one video track: a track with nothing on it over that stretch, else a new one at the
 * top. Each shot is used in turn, moving on through its usable range each time it comes round, so a shot
 * is never repeated frame for frame until it has run out.
 *
 * A direct edit like add_clips: one backup and one Revert for the whole lot (a new track included).
 */
import { useConnectionStore } from "../../store/useConnectionStore";
import type { NleHost } from "../../types/nle";
import type { HostTimeline } from "../../types/timeline";
import { type Args, clock, type Executor, optNum, optStr } from "./args";
import { beatsOf } from "./audioTools";
import { connectedView, refuseWhileDrafting } from "./draft";
import { addClips } from "./editTools";
import { TIMELINE_NOUN } from "./edits";
import { factsOf, learnFacts } from "./mediaInfo";
import { poolClipId } from "./projectTools";
import { timingExecutors } from "./timingTools";
import { filesOf } from "./transcriptTools";
import type { ToolContext, ToolDeclaration } from "./tools";

export const BEAT_STEPS = [1, 2, 4, 8] as const;
/** The most shots one call lays down. */
export const MAX_SLOTS = 150;
/** add_clips' batch size (resolve_edit.py's limit). */
const BATCH = 50;
/** Under this confidence the music has no steady pulse to cut to (find_beats' note). */
export const MIN_CONFIDENCE = 0.3;

const round3 = (n: number) => Math.round(n * 1000) / 1000;
const fileName = (path: string) => path.split(/[\\/]/).pop() || path;

export interface Slot {
  start: number;
  end: number;
}

/**
 * The slots between cuts: every `every`th beat from the first, shifted by `offset` seconds and snapped to
 * frames. The last slot closes `every` beats after the last cut (at the median beat spacing), or at `end`
 * if that comes first. Slots under two frames are dropped.
 */
export function beatSlots(beats: number[], every: number, end: number, fps: number, offset = 0): Slot[] {
  const frame = 1 / (fps > 0 ? fps : 25);
  const snap = (t: number) => round3(Math.round(t / frame) * frame);
  const kept = beats.filter((_, i) => i % every === 0);
  const cuts = kept.map((t) => snap(Math.max(0, t + offset)));
  const gaps = beats.slice(1).map((t, i) => t - beats[i]).sort((a, b) => a - b);
  const beat = gaps.length ? gaps[Math.floor(gaps.length / 2)] : 0;
  cuts.push(snap(Math.min(end, kept[kept.length - 1] + every * beat + offset)));
  const slots: Slot[] = [];
  for (let i = 0; i + 1 < cuts.length; i++) if (cuts[i + 1] - cuts[i] >= 2 * frame - 1e-9) slots.push({ start: cuts[i], end: cuts[i + 1] });
  return slots;
}

export interface Shot {
  path: string;
  name: string;
  /** The part of the file that may be used, in file seconds. */
  from: number;
  to: number;
}

export interface Placement {
  shot: number;
  at: number;
  sourceIn: number;
  sourceOut: number;
}

/**
 * Fills the slots from the shots in turn. Each shot keeps its place: the next time it comes round it
 * goes on from where it stopped, starting again from its beginning once the rest is too short. A shot
 * shorter than a slot is passed over for that slot; a slot no shot is long enough for is left empty.
 */
export function fillSlots(slots: Slot[], shots: Shot[]): { placed: Placement[]; empty: Slot[] } {
  const cursor = shots.map((s) => s.from);
  const placed: Placement[] = [];
  const empty: Slot[] = [];
  let next = 0;
  for (const slot of slots) {
    const length = slot.end - slot.start;
    let done = false;
    for (let tried = 0; tried < shots.length && !done; tried++) {
      const k = (next + tried) % shots.length;
      const shot = shots[k];
      if (shot.to - shot.from < length - 1e-9) continue;
      if (cursor[k] + length > shot.to + 1e-9) cursor[k] = shot.from;
      placed.push({ shot: k, at: slot.start, sourceIn: round3(cursor[k]), sourceOut: round3(cursor[k] + length) });
      cursor[k] += length;
      next = k + 1;
      done = true;
    }
    if (!done) empty.push(slot);
  }
  return { placed, empty };
}

/** The lowest video track with nothing on it (on or off) between `start` and `end`, or null. */
export function freeVideoTrack(view: HostTimeline, start: number, end: number): number | null {
  const video = view.tracks.filter((t) => t.type === "video").sort((a, b) => a.index - b.index);
  const free = video.find((t) => t.clips.every((c) => c.end <= start + 1e-6 || c.start >= end - 1e-6));
  return free ? free.index : null;
}

export function beatToolDeclarations(host: NleHost): ToolDeclaration[] {
  const noun = TIMELINE_NOUN[host];
  return [
    {
      name: "cut_to_beats",
      description: `Cuts shots to the beat of a music clip on the open ${noun}: finds its beats, makes a cut every everyBeats beats (2 by default: 1 is every beat, 4 a bar of 4/4), and lays the shots into the slots between, as picture only, in the order given and round again, each one moving on through its range so nothing repeats frame for frame until it has run out. They go on a video track that's empty over that stretch, else a new track at the top, so nothing is overwritten. One backup and one Revert for all of it. Shots are pool clips ("p3") or media files, with an optional sourceIn/sourceOut (file seconds; default a pool clip's marked In/Out, else the whole file). Refused when the music has no steady beat (confidence under ${MIN_CONFIDENCE}); try a range where it's steady, or another track. At most ${MAX_SLOTS} shots per call.`,
      parameters: {
        type: "OBJECT",
        properties: {
          musicClipId: { type: "STRING", description: `The music clip on the ${noun} (or its picture).` },
          shots: {
            type: "ARRAY",
            items: {
              type: "OBJECT",
              properties: {
                clipId: { type: "STRING", description: `A pool clip ("p3") or a clip on the ${noun}.` },
                filePath: { type: "STRING", description: "An absolute media file path, instead of clipId." },
                sourceIn: { type: "NUMBER", description: "File seconds. Optional." },
                sourceOut: { type: "NUMBER", description: "File seconds. Optional." },
              },
            },
          },
          start: { type: "NUMBER", description: `Only cut from this ${noun} time. Default the music's start.` },
          end: { type: "NUMBER", description: `Only cut up to this ${noun} time. Default the music's end.` },
          everyBeats: { type: "NUMBER", enum: [...BEAT_STEPS], description: "1, 2 (default), 4 or 8." },
          offsetFrames: { type: "NUMBER", description: "Move every cut this many frames (negative: before the beat, which can feel tighter). Default 0." },
          videoTrack: { type: "NUMBER", description: "1-based; must be empty over the stretch. Optional." },
        },
        required: ["musicClipId", "shots"],
      },
    },
  ];
}

export function beatExecutors(context: ToolContext): Record<string, Executor> {
  const { host } = context;
  const noun = TIMELINE_NOUN[host];

  /** Each shot's file and the part of it to use. */
  const shotsOf = async (raw: unknown): Promise<Shot[]> => {
    if (!Array.isArray(raw) || !raw.length) throw new Error("shots must list at least one shot");
    const pool = useConnectionStore.getState().connections[host].pool;
    const shots: Shot[] = [];
    for (const [i, value] of raw.entries()) {
      if (typeof value !== "object" || value === null) throw new Error(`shots[${i}] must be an object`);
      const s = value as Args;
      const ref = optStr(s, "clipId");
      const given = optStr(s, "filePath");
      if (!ref && !given) throw new Error(`shots[${i}]: give clipId or filePath`);
      if (given && !given.startsWith("/")) throw new Error(`shots[${i}].filePath must be an absolute path`);
      const path = given ?? (await filesOf(context, [ref!]))[0];
      const poolClip = ref ? pool?.clips.find((c) => c.id === poolClipId(host, ref)) : undefined;
      let length = poolClip?.duration;
      if (length === undefined) {
        await learnFacts([path], 10_000);
        length = factsOf(path)?.duration ?? undefined;
      }
      const from = Math.max(0, optNum(s, "sourceIn") ?? poolClip?.markIn ?? 0);
      const to = optNum(s, "sourceOut") ?? poolClip?.markOut ?? length;
      if (to === undefined) throw new Error(`shots[${i}]: ${fileName(path)}'s length couldn't be read; give sourceOut`);
      if (!(to > from)) throw new Error(`shots[${i}]: sourceOut must be after sourceIn`);
      shots.push({ path, name: poolClip?.name ?? fileName(path), from, to: length !== undefined ? Math.min(to, length) : to });
    }
    return shots;
  };

  return {
    cut_to_beats: async (args) => {
      refuseWhileDrafting(host, "cut to the beat");
      const musicId = optStr(args, "musicClipId");
      if (!musicId) throw new Error(`musicClipId must be a music clip on the ${noun}`);
      const every = optNum(args, "everyBeats") ?? 2;
      if (!(BEAT_STEPS as readonly number[]).includes(every)) throw new Error("everyBeats must be 1, 2, 4 or 8");
      const view = await connectedView(context);
      const shots = await shotsOf(args.shots);
      const found = await beatsOf(view, musicId, optNum(args, "start"), optNum(args, "end"));
      if (found.confidence < MIN_CONFIDENCE || found.beats.length < 2) {
        throw new Error(`"${found.clip.name}" has no steady beat to cut to there (confidence ${found.confidence}). Try a range where the beat is clear, or cut by hand at markers`);
      }
      const fps = view.fps > 0 ? view.fps : 25;
      const slots = beatSlots(found.beats, every, found.end, fps, (optNum(args, "offsetFrames") ?? 0) / fps);
      if (slots.length > MAX_SLOTS) throw new Error(`That's ${slots.length} shots; at most ${MAX_SLOTS} per call. Give a shorter start–end, or a larger everyBeats`);
      const { placed, empty } = fillSlots(slots, shots);
      if (!placed.length) throw new Error(`None of the shots is long enough for a slot (${clock(slots[0]?.end - slots[0]?.start || 0)}); give longer shots or a smaller everyBeats`);

      const first = placed[0].at;
      const last = placed[placed.length - 1].at + (placed[placed.length - 1].sourceOut - placed[placed.length - 1].sourceIn);
      const ctx = { host, timeline: context.timeline ?? "", step: context.step, stepText: context.stepText };
      let track = optNum(args, "videoTrack") ?? freeVideoTrack(view, first, last);
      let newTrack: string | null = null;
      if (track === null) {
        await timingExecutors(context).add_track({ type: "video" });
        track = Math.max(0, ...view.tracks.filter((t) => t.type === "video").map((t) => t.index)) + 1;
        newTrack = `V${track}`;
      }

      const clips = placed.map((p) => ({ path: shots[p.shot].path, at: p.at, sourceIn: p.sourceIn, sourceOut: p.sourceOut, videoTrack: track, picture: true, sound: false }));
      let added = 0;
      const refused: string[] = [];
      for (let i = 0; i < clips.length; i += BATCH) {
        const out = await addClips(ctx, "cut_to_beats", clips.slice(i, i + BATCH));
        const r = out.result as { changes?: unknown[]; refused?: { reason: string }[] };
        added += r.changes?.length ?? 0;
        refused.push(...(r.refused ?? []).map((x) => x.reason));
      }
      const uses = shots.map((s, k) => ({ shot: s.name, times: placed.filter((p) => p.shot === k).length }));
      return {
        summary: `Cut ${added} shot(s) to the beat of "${found.clip.name}" (${found.bpm} BPM, a cut every ${every === 1 ? "beat" : `${every} beats`}) on V${track}${newTrack ? " (a new track)" : ""}, ${clock(first)}–${clock(last)}`,
        result: {
          bpm: found.bpm,
          confidence: found.confidence,
          everyBeats: every,
          videoTrack: track,
          ...(newTrack ? { newTrack } : {}),
          cuts: placed.map((p) => p.at),
          shots: uses,
          ...(refused.length ? { refused } : {}),
          ...(empty.length ? { emptySlots: empty.map((s) => `${clock(s.start)}–${clock(s.end)}`), note: "No shot was long enough for these slots; they're left empty" } : {}),
          revert: "revert_timeline_edits lastStep=true removes all of it",
        },
      };
    },
  };
}

/** The ground rule the system prompt gains (Phase 14c). */
export const BEAT_INSTRUCTION = `- To cut B-roll or a montage to music, use cut_to_beats (it finds the beats itself) rather than placing
  clips one by one; pick shots from the pool or find_broll, every 2 beats by default, 4 for a calmer feel.`;
