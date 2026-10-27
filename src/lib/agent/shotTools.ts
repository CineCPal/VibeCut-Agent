/**
 * Shot changes (PLAN.md, "Phase 19b"): `find_shot_changes` finds where the picture cuts from one shot to
 * the next inside a clip on the timeline, or in a media file, with the `media-shots` job. It only reads:
 * the agent marks the cuts (add_markers) or cuts at them (split_clip) as the user asks.
 *
 * For a clip, the job reads the part of its file the clip plays, and the cuts come back in timeline
 * seconds (and file seconds). Hard cuts only: dissolves, fades and wipes aren't found.
 */
import { runJob } from "../jobs";
import type { NleHost } from "../../types/nle";
import type { HostClip } from "../../types/timeline";
import { clock, type Executor, optNum, optStr, type ToolOutcome } from "./args";
import { filePart } from "./audioTools";
import { connectedView } from "./draft";
import { TIMELINE_NOUN } from "./edits";
import type { ToolContext, ToolDeclaration } from "./tools";

export const SENSITIVITIES = ["low", "normal", "high"] as const;

const round3 = (n: number) => Math.round(n * 1000) / 1000;
const fileName = (path: string) => path.split(/[\\/]/).pop() || path;

interface ShotsResult {
  cuts: { time: number; score: number }[];
  start: number;
  end: number;
  fps: number;
  frames: number;
}

export interface ShotChange {
  /** Timeline seconds, for a clip; absent for a file. */
  time?: number;
  /** Seconds into the file: the new shot's first frame. */
  sourceTime: number;
  score: number;
}

/** The picture clip `id` names: itself, or for a sound clip the picture linked to it. */
export function pictureClip(tracks: { type: string; clips: HostClip[] }[], id: string): HostClip {
  const all = tracks.flatMap((t) => t.clips.map((clip) => ({ clip, type: t.type })));
  const found = all.find((e) => e.clip.id === id);
  if (!found) throw new Error(`There is no clip ${id}; the snapshot lists the clips`);
  const picture = found.type === "video" ? found.clip : all.find((e) => e.type === "video" && found.clip.linkedIds?.includes(e.clip.id))?.clip;
  if (!picture) throw new Error(`"${found.clip.name}" is sound only; give a picture clip`);
  if (!picture.filePath || picture.kind === "effect") throw new Error(`"${picture.name}" has no media file to look at (a title, generator or nested timeline)`);
  return picture;
}

/** File times to timeline times on `clip`, keeping only cuts inside it (not at its edges). */
export function onTimeline(clip: HostClip, cuts: { time: number; score: number }[], fps: number): ShotChange[] {
  const speed = clip.speed ?? 1;
  const base = clip.sourceIn ?? 0;
  const edge = 0.5 / (fps > 0 ? fps : 25);
  return cuts
    .map((c) => ({ time: round3(speed < 0 ? clip.start + (base - c.time) / Math.abs(speed) : clip.start + (c.time - base) / (speed || 1)), sourceTime: c.time, score: c.score }))
    .filter((c) => c.time > clip.start + edge && c.time < clip.end - edge)
    .sort((a, b) => a.time - b.time);
}

async function shotsIn(path: string, start: number, end: number | undefined, sensitivity: string, title: string): Promise<ShotsResult> {
  const job = await runJob("media-shots", title, { path, start: Math.max(0, start), ...(end !== undefined ? { end } : {}), sensitivity });
  const result = job?.result as ShotsResult | undefined;
  if (!result) throw new Error(job?.error ?? "The shot changes couldn't be found");
  return result;
}

export function shotToolDeclarations(host: NleHost): ToolDeclaration[] {
  const noun = TIMELINE_NOUN[host];
  return [
    {
      name: "find_shot_changes",
      description: `Finds where the picture cuts from one shot to the next (hard cuts; not dissolves, fades or wipes) inside a clip on the ${noun} (clipId: in ${noun} seconds, within what the clip plays) or in a media file (path: in file seconds). Use it on a flattened export, a reference edit or a long clip before marking or cutting at its shots. It only reads; then add_markers at the times, or split_clip at each (one call per time, latest first, so earlier clip ids stay). sensitivity "high" finds subtler cuts and risks a false one in fast action; "low" only the plainest. start/end narrow it (${noun} seconds for a clip, file seconds for a path).`,
      parameters: {
        type: "OBJECT",
        properties: {
          clipId: { type: "STRING", description: "A picture clip (or its linked sound) on the timeline or draft." },
          path: { type: "STRING", description: "Absolute media file path, instead of clipId." },
          start: { type: "NUMBER", description: "Optional." },
          end: { type: "NUMBER", description: "Optional." },
          sensitivity: { type: "STRING", enum: [...SENSITIVITIES], description: "Optional; default normal." },
        },
      },
    },
  ];
}

export function shotExecutors(context: ToolContext): Record<string, Executor> {
  return {
    find_shot_changes: async (args): Promise<ToolOutcome> => {
      const sensitivity = optStr(args, "sensitivity") ?? "normal";
      if (!(SENSITIVITIES as readonly string[]).includes(sensitivity)) throw new Error('sensitivity must be "low", "normal" or "high"');
      const clipId = optStr(args, "clipId");
      const path = optStr(args, "path");
      const from = optNum(args, "start");
      const to = optNum(args, "end");
      if (clipId) {
        const clip = pictureClip((await connectedView(context)).tracks, clipId);
        const start = Math.max(clip.start, from ?? clip.start);
        const end = Math.min(clip.end, to ?? clip.end);
        if (!(end > start)) throw new Error(`start–end must overlap "${clip.name}" (${clock(clip.start)}–${clock(clip.end)})`);
        const part = filePart(clip, start, end);
        const found = await shotsIn(clip.filePath!, Math.min(part.from, part.to), Math.max(part.from, part.to), sensitivity, `Find the shot changes in "${clip.name}"`);
        const cuts = onTimeline(clip, found.cuts, found.fps).filter((c) => c.time! >= start && c.time! < end);
        return {
          summary: `Found ${cuts.length} shot change(s) in "${clip.name}" between ${clock(start)} and ${clock(end)}${cuts.length ? `: ${cuts.slice(0, 8).map((c) => clock(c.time!)).join(", ")}${cuts.length > 8 ? " ..." : ""}` : ""}`,
          result: { clipId: clip.id, name: clip.name, start, end, cuts },
        };
      }
      if (!path) throw new Error("Give clipId (a clip on the timeline) or path (a media file)");
      if (!path.startsWith("/")) throw new Error("path must be an absolute file path");
      const found = await shotsIn(path, from ?? 0, to, sensitivity, `Find the shot changes in ${fileName(path)}`);
      const cuts: ShotChange[] = found.cuts.map((c) => ({ sourceTime: c.time, score: c.score }));
      return {
        summary: `Found ${cuts.length} shot change(s) in ${fileName(path)} (${clock(found.start)}–${clock(found.end)} of the file)`,
        result: { path, start: found.start, end: found.end, fps: found.fps, cuts },
      };
    },
  };
}

/** The ground rule the system prompt gains (Phase 19b). */
export const SHOT_INSTRUCTION = `- find_shot_changes finds the cuts inside a clip or file (a flattened export, a reference edit, a long
  take with camera stops). Use it before marking shots, cutting a flattened file into its shots, or
  describing a reference edit's pacing; don't guess cut points from looking at a few frames.`;
