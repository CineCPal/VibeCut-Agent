/**
 * Cleaning dialogue (PLAN.md, "Phase 18c"): `clean_dialogue` runs the sound files of the given clips
 * through ffmpeg (the `media-clean` job: high-pass, FFT denoise, de-ess), writing a cleaned copy beside
 * each file, then lays the cleaned sound under each clip at the same place and source points, and switches
 * the original sound off. The original stays on its track, so switching the two is a before/after, and
 * revert_timeline_edits lastStep=true takes the whole thing back (one request, one backup).
 *
 * A direct edit like cut_to_beats: add_clips then set_clips_enabled, both reviewed under Review edits first.
 */
import { runJob } from "../jobs";
import type { NleHost } from "../../types/nle";
import type { HostClip } from "../../types/timeline";
import { type Executor, optStr, strArray, type ToolOutcome } from "./args";
import { connectedView, refuseWhileDrafting } from "./draft";
import { addClips, editExecutors } from "./editTools";
import { TIMELINE_NOUN } from "./edits";
import type { ToolContext, ToolDeclaration } from "./tools";

export const STRENGTHS = ["light", "medium", "strong"] as const;
export type Strength = (typeof STRENGTHS)[number];
/** media-clean's MAX_FILES. */
export const MAX_FILES = 16;

const fileName = (path: string) => path.split(/[\\/]/).pop() || path;

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
  };
}

/** The ground rule the system prompt gains (Phase 18c). */
export const DIALOGUE_INSTRUCTION = `- Noisy dialogue (hiss, room tone, air conditioning, rumble): clean_dialogue, light or medium first,
  strong only for bad locations. Ask before running it on many long files (it cleans whole files).`;
