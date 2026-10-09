/**
 * The agent looks at footage (PLAN.md, "Phase 13b"): frames of a timeline clip, of the timeline at given
 * times, or of a media file, read by the `media-frames` job (vibecut_agent/media/frames.py) and returned
 * to the model as one labelled contact sheet.
 *
 * Frames are the source file's own pictures: no effects, grade, titles or transitions from the editor.
 * Each request gets MAX_TURN_IMAGES images (turnImages.ts); a tool refuses once they're used up.
 */
import { runJob } from "../jobs";
import { useConnectionStore } from "../../store/useConnectionStore";
import type { NleHost } from "../../types/nle";
import type { HostClip, HostTimeline } from "../../types/timeline";
import { type Args, clock, type Executor, optNum, optStr, type ToolImage } from "./args";
import { connectedView } from "./draft";
import { factsOf, learnFacts } from "./mediaInfo";
import { poolClipId } from "./projectTools";
import type { ToolContext, ToolDeclaration } from "./tools";
import { imagesLeft, MAX_TURN_IMAGES } from "./turnImages";

/** Frames on one sheet at most (frames.py's MAX_SHOTS), and by default. */
export const MAX_FRAMES = 12;
const DEFAULT_CLIP_FRAMES = 6;
const DEFAULT_TIMELINE_FRAMES = 8;
const NOUN: Record<NleHost, string> = { premiere: "sequence", resolve: "timeline" };
const SOURCE_NOTE = "Frames are the source files' own pictures: effects, grades, titles and transitions applied in the editor aren't in them.";

export interface Shot {
  path: string;
  /** Seconds into the file. */
  time: number;
  label: string;
  /** The timeline clip it's from, for the result (the sheet shows the name: Resolve's ids are long). */
  clipId?: string;
}

const fileName = (path: string) => path.split(/[\\/]/).pop() || path;
const round2 = (n: number) => Math.round(n * 100) / 100;

/** `count` times spread evenly over [start, end): the middle of each equal part. */
export function spread(start: number, end: number, count: number): number[] {
  const n = Math.max(1, Math.min(MAX_FRAMES, Math.round(count)));
  const step = (end - start) / n;
  return Array.from({ length: n }, (_, i) => round2(start + step * (i + 0.5)));
}

/** Where in its file a clip is at timeline time `t`. A reversed clip counts back from its source in. */
export function sourceTime(clip: HostClip, t: number): number {
  const speed = clip.speed ?? 1;
  const into = (t - clip.start) * Math.abs(speed || 1);
  return round2(Math.max(0, speed < 0 ? (clip.sourceIn ?? 0) - into : (clip.sourceIn ?? 0) + into));
}

/** The picture seen at `t`: the clip on the highest video track that's on, whose clip is on and has a file. */
export function pictureAt(view: HostTimeline, t: number): { clip: HostClip; track: string } | null {
  const tracks = view.tracks.filter((tr) => tr.type === "video" && tr.enabled !== false).sort((a, b) => b.index - a.index);
  for (const track of tracks) {
    const clip = track.clips.find((c) => c.kind !== "effect" && c.enabled && c.filePath && c.start <= t && t < c.end);
    if (clip) return { clip, track: `V${track.index}` };
  }
  return null;
}

function times(args: Args, key: string): number[] | undefined {
  const raw = args[key];
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw) || !raw.length || raw.length > MAX_FRAMES || !raw.every((t) => typeof t === "number" && Number.isFinite(t))) {
    throw new Error(`${key} must list 1 to ${MAX_FRAMES} times in seconds`);
  }
  return raw as number[];
}

function frameCount(args: Args, fallback: number): number {
  const count = optNum(args, "count") ?? fallback;
  if (!Number.isInteger(count) || count < 1 || count > MAX_FRAMES) throw new Error(`count must be 1 to ${MAX_FRAMES}`);
  return count;
}

function checkBudget(step: string): void {
  if (imagesLeft(step) <= 0) {
    throw new Error(`This request has already shown you ${MAX_TURN_IMAGES} images, the most one request gets. Work from what you've seen, or ask the user to send a new message.`);
  }
}

/** Reads the frames and returns them as one contact sheet. */
async function look(shots: Shot[], summary: string, extra: Record<string, unknown>): Promise<{ summary: string; result: unknown; images: ToolImage[] }> {
  const job = await runJob("media-frames", `Read ${shots.length} frame(s)`, { shots: shots.map(({ path, time, label }) => ({ path, time, label })), sheet: true });
  const result = (job?.result ?? {}) as { images?: ToolImage[]; frames?: { index: number; label: string; ok: boolean; message?: string }[] };
  const images = result.images ?? [];
  if (!images.length) {
    const why = result.frames?.find((f) => f.message)?.message ?? job?.error ?? "no frame could be read";
    throw new Error(`Couldn't read the frames: ${why}`);
  }
  const problems = (result.frames ?? []).filter((f) => f.message).map((f) => `${f.index}. ${f.label}: ${f.message}`);
  return {
    summary,
    images,
    result: {
      shown: `A contact sheet of ${shots.length} frame(s), numbered in reading order with their labels, is attached to this result.`,
      frames: shots.map((s, i) => ({ n: i + 1, label: s.label, ...(s.clipId ? { clipId: s.clipId } : {}), file: fileName(s.path), fileTime: s.time })),
      ...(problems.length ? { problems } : {}),
      note: SOURCE_NOTE,
      ...extra,
    },
  };
}

export function visionToolDeclarations(host: NleHost): ToolDeclaration[] {
  const noun = NOUN[host];
  const budget = `Each request can show you ${MAX_TURN_IMAGES} images in all; prefer one sheet with more frames to several calls.`;
  return [
    {
      name: "look_at_clip",
      description: `Shows you a clip on the connected ${noun} (or the draft): a contact sheet of frames from it, each labelled with its ${noun} time. Give times (seconds on the ${noun}, inside the clip) or count (frames spread evenly over the clip; default ${DEFAULT_CLIP_FRAMES}). Use it to judge a shot (framing, subject, faces, light, movement, focus) before choosing, describing or cutting it. ${SOURCE_NOTE} ${budget}`,
      parameters: {
        type: "OBJECT",
        properties: {
          clipId: { type: "STRING", description: `A video clip id from the snapshot.` },
          times: { type: "ARRAY", items: { type: "NUMBER" }, description: `Seconds on the ${noun}, within the clip. Up to ${MAX_FRAMES}.` },
          count: { type: "NUMBER", description: `Frames spread over the clip when times is omitted, 1 to ${MAX_FRAMES}.` },
        },
        required: ["clipId"],
      },
    },
    {
      name: "look_at_timeline",
      description: `Shows you what the connected ${noun} (or the draft) shows at given moments: at each time, the frame of the clip on the highest video track that's on, as one contact sheet. Give times (seconds; e.g. the playhead from the snapshot), or start and end with count (spread evenly; without any, the In–Out marks or the whole ${noun}, ${DEFAULT_TIMELINE_FRAMES} frames). Moments with no picture are listed as gaps. ${SOURCE_NOTE} ${budget}`,
      parameters: {
        type: "OBJECT",
        properties: {
          times: { type: "ARRAY", items: { type: "NUMBER" }, description: `Seconds on the ${noun}. Up to ${MAX_FRAMES}.` },
          start: { type: "NUMBER" },
          end: { type: "NUMBER" },
          count: { type: "NUMBER", description: `1 to ${MAX_FRAMES}.` },
        },
      },
    },
    {
      name: "look_at_media",
      description: `Shows you a media file that may not be on the ${noun}: a project clip ("p3" from the snapshot), a file path (a find_broll match, an @-mentioned file), as a contact sheet. Give times (seconds into the file) or count (spread over the file, or over start–end seconds of it; default ${DEFAULT_CLIP_FRAMES}). Use it to check B-roll or footage before placing it. ${budget}`,
      parameters: {
        type: "OBJECT",
        properties: {
          clipId: { type: "STRING", description: "A project clip id from the snapshot's pool." },
          filePath: { type: "STRING", description: "An absolute media file path." },
          times: { type: "ARRAY", items: { type: "NUMBER" }, description: `Seconds into the file. Up to ${MAX_FRAMES}.` },
          start: { type: "NUMBER", description: "Seconds into the file to start spreading frames from." },
          end: { type: "NUMBER", description: "Seconds into the file to spread frames up to." },
          count: { type: "NUMBER", description: `1 to ${MAX_FRAMES}.` },
        },
      },
    },
  ];
}

export function visionExecutors(context: ToolContext): Record<string, Executor> {
  const { host } = context;
  const noun = NOUN[host];

  return {
    look_at_clip: async (args) => {
      checkBudget(context.step);
      const id = optStr(args, "clipId");
      if (!id) throw new Error("clipId must be a clip id from the snapshot");
      const view = await connectedView(context);
      const track = view.tracks.find((tr) => tr.clips.some((c) => c.id === id));
      const clip = track?.clips.find((c) => c.id === id);
      if (!clip || !track) throw new Error(`There's no clip ${id} on the connected ${noun}`);
      if (track.type !== "video") throw new Error(`${id} is sound only; look at its picture's clip (the one linked to it on a video track)`);
      if (!clip.filePath || clip.kind === "effect") throw new Error(`${id} has no media file to look at (a title, transition, generator or nested ${noun})`);
      const given = times(args, "times");
      const at = given ?? spread(clip.start, clip.end, frameCount(args, DEFAULT_CLIP_FRAMES));
      const outside = at.filter((t) => t < clip.start || t >= clip.end);
      if (outside.length) throw new Error(`${outside.map(clock).join(", ")} ${outside.length === 1 ? "is" : "are"} outside ${id} (${clock(clip.start)}–${clock(clip.end)})`);
      const shots = at.map((t) => ({ path: clip.filePath!, time: sourceTime(clip, t), label: `${clock(t)} on the ${noun}` }));
      const retimed = (clip.speed ?? 1) !== 1 ? { speed: `${Math.round((clip.speed ?? 1) * 100)}%: file times follow the clip's speed` } : {};
      return look(shots, `Looked at ${id} "${clip.name}" (${shots.length} frame${shots.length === 1 ? "" : "s"})`, { clip: { id, name: clip.name, start: clip.start, end: clip.end }, ...retimed });
    },

    look_at_timeline: async (args) => {
      checkBudget(context.step);
      const view = await connectedView(context);
      let at = times(args, "times");
      if (!at) {
        const start = optNum(args, "start") ?? view.inOut?.in ?? 0;
        const end = optNum(args, "end") ?? view.inOut?.out ?? view.duration;
        if (!(end > start)) throw new Error("end must be after start");
        at = spread(start, Math.min(end, view.duration), frameCount(args, DEFAULT_TIMELINE_FRAMES));
      }
      const shots: Shot[] = [];
      const gaps: number[] = [];
      for (const t of at) {
        const seen = pictureAt(view, t);
        if (!seen) gaps.push(t);
        else shots.push({ path: seen.clip.filePath!, time: sourceTime(seen.clip, t), label: `${clock(t)} · ${seen.track} "${seen.clip.name}"`, clipId: seen.clip.id });
      }
      if (!shots.length) throw new Error(`There's no picture on the ${noun} at ${at.map(clock).join(", ")} (gaps, sound only, or tracks that are off)`);
      return look(shots, `Looked at the ${noun} at ${shots.length} moment${shots.length === 1 ? "" : "s"}`, gaps.length ? { gaps: gaps.map((t) => `${clock(t)}: no picture (black)`) } : {});
    },

    look_at_media: async (args) => {
      checkBudget(context.step);
      const ref = optStr(args, "clipId");
      let path = optStr(args, "filePath");
      let duration: number | undefined;
      if (ref) {
        const clip = useConnectionStore.getState().connections[host].pool?.clips.find((c) => c.id === poolClipId(host, ref));
        if (!clip?.filePath) throw new Error(`There's no project clip ${ref} with a media file (the snapshot's pool lists them)`);
        path = clip.filePath;
        duration = clip.duration;
      }
      if (!path || !path.startsWith("/")) throw new Error("Give clipId (a project clip) or filePath (an absolute path)");
      const given = times(args, "times");
      let at = given;
      if (!at) {
        if (duration === undefined) {
          await learnFacts([path], 10_000);
          duration = factsOf(path)?.duration ?? undefined;
        }
        const start = Math.max(0, optNum(args, "start") ?? 0);
        const end = optNum(args, "end") ?? duration;
        if (end === undefined) throw new Error(`Couldn't tell how long ${fileName(path)} is; give times instead`);
        if (!(end > start)) throw new Error("end must be after start");
        at = spread(start, end, frameCount(args, DEFAULT_CLIP_FRAMES));
      }
      const shots = at.map((t) => ({ path: path!, time: round2(Math.max(0, t)), label: `${clock(t)} into the file` }));
      return look(shots, `Looked at "${fileName(path)}" (${shots.length} frame${shots.length === 1 ? "" : "s"})`, { file: path });
    },
  };
}

/** The ground rule the system prompt gains (Phase 13b). */
export const VISION_INSTRUCTION = `- You can see footage: look_at_clip (a clip on the timeline), look_at_timeline (what plays at given
  times) and look_at_media (a project clip or file, e.g. a find_broll match) each show you a contact sheet.
  Look before judging shots, choosing B-roll that fits, finding "the wide shot" or "where she smiles", or
  describing what's on screen; don't guess from names. One sheet with more frames beats several calls.
  Say briefly what you saw. The frames are the source pictures, without the editor's effects or grade.`;
