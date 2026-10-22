/**
 * Renders from the connected editor (PLAN.md, "Phase 15b"), ported from VibeCut's hostRender.ts (its
 * "Phase 7c", probed live there): export_video and export_audio. Resolve renders through its Deliver
 * queue (resolve_render.py), Premiere through Adobe Media Encoder (premiere_render.py and the panel's
 * `encode`). The watcher picks the file, always in ~/Movies/VibeCut Renders/<project>/ and never over an
 * existing one; the agent can't choose a path.
 *
 * The tool waits for the render, showing its progress as the chat's activity line, and stopping the chat
 * stops the render. VibeCut's export_stills isn't ported: it needs the editor's own frame export.
 */
import { nleCall } from "../ipc";
import { useAgentStore } from "../../store/useAgentStore";
import type { NleHost } from "../../types/nle";
import { type Args, bool, clock, type Executor, optNum, optStr, strArray, type ToolOutcome } from "./args";
import { draftOf } from "./draft";
import { HOST_SHORT, TIMELINE_NOUN } from "./edits";
import type { ToolContext, ToolDeclaration } from "./tools";

export const VIDEO_PRESETS = ["source", "1080p", "720p", "prores"] as const;
export const AUDIO_FORMATS = ["wav", "aac"] as const;
export const CLIP_FORMATS = ["source", "1080p", "720p", "prores", "copy"] as const;
const POLL_MS = 1000;

interface RenderStart {
  jobId: string;
  path: string;
  seconds: number;
}

export interface RenderState {
  state: "rendering" | "done" | "failed" | "cancelled";
  seconds: number;
  fraction?: number;
  etaSeconds?: number;
  path?: string;
  error?: string;
  note?: string;
}

interface ClipExportStart {
  jobId: string;
  folder: string;
  total: number;
  skipped: { id: string; name: string; reason: string }[];
  notes: string[];
}

export interface ClipExportState {
  state: "rendering" | "done" | "failed" | "cancelled";
  done: number;
  total: number;
  fraction?: number;
  etaSeconds?: number;
  folder: string;
  files: string[];
  failed: { clip: string; error: string }[];
}

const fileName = (path: string) => path.split("/").pop() ?? path;

/** The progress line while clips are cut. */
export function clipProgressLine(folder: string, state: ClipExportState): string {
  const percent = state.fraction ? ` ${Math.round(state.fraction * 100)}%` : "";
  const eta = state.etaSeconds ? `, about ${Math.max(1, Math.round(state.etaSeconds))} s left` : "";
  return `Exporting clips ${Math.min(state.done + 1, state.total)}/${state.total} → ${fileName(folder)}${percent}${eta}`;
}

/** range: "all" (default) or "in_out" (the editor's own marks); start/end (seconds) for a part. */
export function rangeArg(args: Args): unknown {
  const start = optNum(args, "start");
  const end = optNum(args, "end");
  if (start !== undefined || end !== undefined) {
    if (start === undefined || end === undefined) throw new Error("give both start and end, in seconds from the timeline's start");
    if (!(end > start)) throw new Error("end must be after start");
    return { start, end };
  }
  const range = optStr(args, "range") ?? "all";
  if (range !== "all" && range !== "in_out") throw new Error('range must be "all" or "in_out" (or give start and end)');
  return range;
}

/** The progress line while a render runs. */
export function progressLine(what: string, file: string, state: RenderState): string {
  const percent = state.fraction ? ` ${Math.round(state.fraction * 100)}%` : "";
  const eta = state.etaSeconds ? `, about ${Math.max(1, Math.round(state.etaSeconds))} s left` : "";
  return `Rendering ${what} → ${file}${percent}${eta}`;
}

export function renderExecutors(context: ToolContext, pollMs = POLL_MS): Record<string, Executor> {
  const { host } = context;
  const name = HOST_SHORT[host];
  const noun = TIMELINE_NOUN[host];

  /** The connected timeline, refusing while a draft is open: a render is of what the editor has. */
  const timelineToRender = (): string => {
    if (!context.timeline) throw new Error(`No ${name} ${noun} is open`);
    if (draftOf(host)) throw new Error(`A draft is open. A render is of the ${noun} in ${name}, so send the draft (send_to_${host}) or discard it first, then render the ${noun} you want.`);
    return context.timeline;
  };

  const render = async (command: "render_video" | "render_audio", request: Record<string, unknown>, what: string): Promise<ToolOutcome> => {
    const timeline = timelineToRender();
    const started = await nleCall<RenderStart>(host, command, { timeline, ...request });
    const jobId = started.jobId;
    const file = fileName(started.path);
    let final: RenderState;
    for (;;) {
      // Stopping the chat stops the render (its partial file is removed and the editor's settings put back).
      const stopping = useAgentStore.getState().status === "stopping";
      final = await nleCall<RenderState>(host, stopping ? "cancel_render" : "render_status", { jobId });
      if (final.state !== "rendering" || stopping) break;
      useAgentStore.getState().setActivity(progressLine(what, file, final));
      await new Promise((resolve) => setTimeout(resolve, pollMs));
    }
    if (final.state === "done" && final.path) {
      return { summary: `${name} rendered ${what} (${clock(final.seconds)}) to ${final.path}`, result: { rendered: true, path: final.path, seconds: final.seconds } };
    }
    if (final.state === "cancelled") {
      const note = final.note ? ` ${final.note}.` : "";
      return { summary: `Stopped the render in ${name}; its partial file was removed.${note}`, result: { rendered: false, cancelled: true, ...(final.note ? { note: final.note } : {}) } };
    }
    throw new Error(final.error ?? `${name}'s render ${final.state === "rendering" ? "didn't finish" : final.state}`);
  };

  /** export_clips: each clip's source cut by ffmpeg in the watcher (clip_export.py), polled like a render. */
  const exportClips = async (args: Args): Promise<ToolOutcome> => {
    const format = optStr(args, "format") ?? "source";
    if (!(CLIP_FORMATS as readonly string[]).includes(format)) throw new Error(`format must be one of ${CLIP_FORMATS.join(", ")}`);
    const request: Record<string, unknown> = { timeline: timelineToRender(), format };
    if (args.clipIds !== undefined) request.clipIds = strArray(args, "clipIds");
    const track = optStr(args, "track");
    if (track !== undefined) request.track = track;
    const handles = optNum(args, "handles");
    if (handles !== undefined) request.handles = handles;
    if (bool(args, "includeDisabled")) request.includeDisabled = true;
    const label = optStr(args, "name");
    if (label) request.name = label;
    const started = await nleCall<ClipExportStart>(host, "export_clips", request);
    let final: ClipExportState;
    for (;;) {
      const stopping = useAgentStore.getState().status === "stopping";
      final = await nleCall<ClipExportState>(host, stopping ? "cancel_clip_export" : "clip_export_status", { jobId: started.jobId });
      if (final.state !== "rendering" || stopping) break;
      useAgentStore.getState().setActivity(clipProgressLine(started.folder, final));
      await new Promise((resolve) => setTimeout(resolve, pollMs));
    }
    const skipped = started.skipped.map((s) => `${s.name || s.id} (${s.reason})`);
    const failed = final.failed.map((f) => `${f.clip} (${f.error})`);
    const extra = [
      skipped.length ? ` Skipped ${skipped.length}: ${skipped.join("; ")}.` : "",
      failed.length ? ` Failed ${failed.length}: ${failed.join("; ")}.` : "",
      started.notes.length ? ` ${started.notes.join(". ")}.` : "",
    ].join("");
    const result = { folder: final.folder, files: final.files, skipped: started.skipped, failed: final.failed, notes: started.notes };
    if (final.state === "cancelled") {
      return { summary: `Stopped exporting clips after ${final.files.length} of ${final.total}; the finished files are kept in ${final.folder}.`, result: { exported: final.files.length, cancelled: true, ...result } };
    }
    if (final.state === "done") {
      return { summary: `Exported ${final.files.length} of ${final.total} clips, each by itself, to ${final.folder}.${extra}`, result: { exported: final.files.length, ...result } };
    }
    throw new Error(`No clip was exported.${extra}`);
  };

  return {
    export_clips: exportClips,
    export_video: async (args) => {
      const preset = optStr(args, "preset") ?? "source";
      if (!(VIDEO_PRESETS as readonly string[]).includes(preset)) throw new Error(`preset must be one of ${VIDEO_PRESETS.join(", ")}`);
      const label = optStr(args, "name");
      return render("render_video", { preset, range: rangeArg(args), ...(label ? { name: label } : {}) }, preset === "prores" ? "ProRes" : `H.264 (${preset})`);
    },
    export_audio: async (args) => {
      const format = optStr(args, "format") ?? "wav";
      if (!(AUDIO_FORMATS as readonly string[]).includes(format)) throw new Error(`format must be one of ${AUDIO_FORMATS.join(", ")}`);
      const label = optStr(args, "name");
      return render("render_audio", { format, range: rangeArg(args), ...(label ? { name: label } : {}) }, `the sound as ${format.toUpperCase()}`);
    },
  };
}

export function renderToolDeclarations(host: NleHost): ToolDeclaration[] {
  const noun = TIMELINE_NOUN[host];
  const range = {
    range: { type: "STRING", enum: ["all", "in_out"], description: `all (default) or in_out (the ${noun}'s own In and Out marks). Ignored with start/end.` },
    start: { type: "NUMBER", description: `Seconds from the ${noun}'s start, with end, to render part of it.` },
    end: { type: "NUMBER", description: `Seconds from the ${noun}'s start.` },
    name: { type: "STRING", description: 'Optional words added to the file name, e.g. "client v2".' },
  };
  const how = host === "resolve" ? "through Resolve's Deliver page (the timeline must be the one open in Resolve; your Deliver settings and marks are put back after)" : "through Adobe Media Encoder (it starts if needed)";
  return [
    {
      name: "export_video",
      description: `Renders the open ${noun} to a movie file as the editor plays it (grades, effects, titles), ${how}. preset: source (H.264 .mp4 at the ${noun}'s size, the default), 1080p or 720p (H.264, the short side), or prores (ProRes 422 HQ .mov). Waits for the render, showing its progress, and answers with the file's path in ~/Movies/VibeCut Renders/<project>/. Only when the user asks for a render.`,
      parameters: { type: "OBJECT", properties: { preset: { type: "STRING", enum: [...VIDEO_PRESETS] }, ...range } },
    },
    {
      name: "export_audio",
      description: `Renders the open ${noun}'s sound only, mixed as the editor plays it: wav (uncompressed, the default) or aac (${host === "resolve" ? ".m4a" : ".aac"}). Answers with the file's path in ~/Movies/VibeCut Renders/<project>/. Only when the user asks.`,
      parameters: { type: "OBJECT", properties: { format: { type: "STRING", enum: [...AUDIO_FORMATS] }, ...range } },
    },
    {
      name: "export_clips",
      description: `Exports clips of the open ${noun} each to its own file, cut from the clip's own source media between its In and Out (plus handles): the clip by itself, with no effects, grades, titles or other tracks, at normal speed (a speed change isn't applied). A video clip includes its linked sound from the same file; an audio-only clip becomes a .wav. Choose clipIds (ids from list_timeline_clips), or track (e.g. "V1", "A2"), or neither for every clip. Transitions, adjustment layers, titles, nested sequences, stills, offline media and disabled clips are skipped, each with its reason. format: source (H.264 .mp4 at the clip's own size, the default), 1080p or 720p (H.264, the short side, never enlarged), prores (ProRes 422 HQ .mov), or copy (fast, no re-encode, but each cut lands on the keyframe before its In). Waits for every clip, showing progress, and answers with a new folder in ~/Movies/VibeCut Renders/<project>/. For the ${noun} as the editor plays it, use export_video instead. Only when the user asks.`,
      parameters: {
        type: "OBJECT",
        properties: {
          clipIds: { type: "ARRAY", items: { type: "STRING" }, description: "Ids of the clips to export." },
          track: { type: "STRING", description: 'Every clip on one track, e.g. "V1" or "A2". Ignored with clipIds.' },
          handles: { type: "NUMBER", description: "Extra seconds of source before and after each clip (0 to 60, default 0)." },
          format: { type: "STRING", enum: [...CLIP_FORMATS] },
          includeDisabled: { type: "BOOLEAN", description: "Also export clips that are disabled on the timeline." },
          name: { type: "STRING", description: 'Optional words added to the folder name, e.g. "for colour".' },
        },
      },
    },
  ];
}

/** The ground rule the system prompt gains (VibeCut's RENDER_INSTRUCTION, without stills). */
export const RENDER_INSTRUCTION = `- Renders: export_video (H.264 at source size, 1080p or 720p, or ProRes) and export_audio (WAV or AAC)
  render what the editor has: the whole timeline, its own In to Out (range "in_out") or start/end. To
  export clips individually (each clip, the selects, every shot on V1 as its own file, at any of its
  formats including 1080p), use export_clips once, never a series of export_video calls: it cuts each
  clip from its source file by itself. Only when the user wants each clip as the editor plays it
  (effects, grades, titles, other tracks) use one export_video per clip with its start/end. Files
  always go to ~/Movies/VibeCut Renders/<project>/ under a new name; you can't choose the folder. Tell the
  user the file's path when it's done. A render is of the editor's timeline, not a draft: send the draft
  first if that's what they want rendered. Only render when the user asks. Before a delivery render,
  suggest review_edit with the delivery loudness target if it hasn't been run.`;
