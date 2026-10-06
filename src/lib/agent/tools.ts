/**
 * The agent's tools for a connected editor (PLAN.md, Phase 4: read + markers). Declarations are in
 * Gemini's OpenAPI dialect, as VibeCut's are; the sidecar converts them for Claude (claude_schema.py).
 * Descriptions and executors are ported from VibeCut's premiereChatTools.ts / resolveChatTools.ts.
 *
 * Every tool acts on the timeline open in the editor right now. Each call goes through that
 * editor's watcher (`nle_call`), which checks it again; the watcher allows these commands only.
 */
import { nleCall } from "../ipc";
import type { NleHost } from "../../types/nle";
import type { HostMarker, HostTimeline } from "../../types/timeline";
import { type Args, bool, clock, type Executor, num, optNum, optStr, strArray, type ToolOutcome } from "./args";
import { editExecutors, editToolDeclarations } from "./editTools";
import { SPYGLASS_EXECUTORS, SPYGLASS_TOOLS } from "./spyglassTools";
import { projectExecutors, projectToolDeclarations } from "./projectTools";
import { transcriptExecutors, transcriptToolDeclarations } from "./transcriptTools";
import { draftExecutors, draftToolDeclarations, refuseWhileDrafting } from "./draft";
import { storyExecutors, storyToolDeclarations } from "./storyTools";
import { syncExecutors, syncToolDeclarations } from "./syncTools";

export interface ToolDeclaration {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export const PREMIERE_MARKER_COLORS = ["Green", "Red", "Purple", "Orange", "Yellow", "White", "Blue", "Cyan"];
export const RESOLVE_MARKER_COLORS = [
  "Blue", "Cyan", "Green", "Yellow", "Red", "Pink", "Purple", "Fuchsia",
  "Rose", "Lavender", "Sky", "Mint", "Lemon", "Sand", "Cocoa", "Cream",
]; // prettier-ignore

const WORDS: Record<NleHost, { editor: string; timeline: string; colors: string[] }> = {
  premiere: { editor: "Premiere", timeline: "sequence", colors: PREMIERE_MARKER_COLORS },
  resolve: { editor: "Resolve", timeline: "timeline", colors: RESOLVE_MARKER_COLORS },
};

export function toolDeclarations(host: NleHost): ToolDeclaration[] {
  return [
    ...readToolDeclarations(host),
    ...editToolDeclarations(host),
    ...projectToolDeclarations(host),
    ...transcriptToolDeclarations(host),
    ...draftToolDeclarations(host),
    ...syncToolDeclarations(host),
    ...storyToolDeclarations(host),
    ...SPYGLASS_TOOLS,
  ];
}

function readToolDeclarations(host: NleHost): ToolDeclaration[] {
  const { editor, timeline, colors } = WORDS[host];
  const colorEnum = { type: "STRING", enum: colors };
  const moveNote =
    host === "premiere" ? "moving it keeps its length and id" : "moving it changes its id (Resolve ids are the marker's frame)";
  return [
    {
      name: "list_timelines",
      description: `Lists the ${editor} project's ${timeline}s, marking the connected one (the one every other tool works on), the one open in ${editor}, the ones you made, and VibeCut's backups.`,
      parameters: { type: "OBJECT", properties: {} },
    },
    {
      name: "list_timeline_clips",
      description: `Reads the open ${editor} ${timeline}'s tracks and clips: id, name, start/end in seconds. Each message already starts with a snapshot, so only call this when it was abridged or to check a change. detail=true adds each clip's source in/out, speed, file path, level and linked clip ids.`,
      parameters: { type: "OBJECT", properties: { detail: { type: "BOOLEAN", description: "Optional." } } },
    },
    {
      name: "list_markers",
      description: `Lists the open ${editor} ${timeline}'s markers (id, time in seconds, name, color, note), sorted by time.`,
      parameters: { type: "OBJECT", properties: {} },
    },
    {
      name: "add_markers",
      description: `Adds markers to the open ${editor} ${timeline}. Times are rounded to the nearest frame; a frame that already has a marker keeps it. Give every marker a short name${host === "resolve" ? " (Resolve requires one)" : ""}. Add many in one call.`,
      parameters: {
        type: "OBJECT",
        properties: {
          markers: {
            type: "ARRAY",
            items: {
              type: "OBJECT",
              properties: {
                time: { type: "NUMBER", description: `Seconds from the start of the ${timeline}.` },
                name: { type: "STRING", description: "Short label." },
                color: { ...colorEnum, description: "Default Green." },
                note: { type: "STRING", description: "Longer comment. Optional." },
                duration: { type: "NUMBER", description: "Seconds the marker spans. Optional; default one frame." },
              },
              required: ["time", "name"],
            },
          },
        },
        required: ["markers"],
      },
    },
    {
      name: "update_marker",
      description: `Renames, recolors, re-notes or moves one ${editor} marker. Only the fields you pass change; ${moveNote}.`,
      parameters: {
        type: "OBJECT",
        properties: {
          markerId: { type: "STRING" },
          name: { type: "STRING" },
          color: colorEnum,
          note: { type: "STRING" },
          time: { type: "NUMBER" },
        },
        required: ["markerId"],
      },
    },
    {
      name: "remove_markers",
      description: `Removes ${editor} markers by id, or every marker on the ${timeline} with all=true. Can't be undone from VibeCut Agent.`,
      parameters: { type: "OBJECT", properties: { markerIds: { type: "ARRAY", items: { type: "STRING" } }, all: { type: "BOOLEAN" } } },
    },
    {
      name: "get_playhead_time",
      description: `Returns ${editor}'s playhead position in seconds on the open ${timeline}.`,
      parameters: { type: "OBJECT", properties: {} },
    },
    {
      name: "set_playhead_time",
      description: `Moves ${editor}'s playhead to a time in seconds on the open ${timeline}.`,
      parameters: { type: "OBJECT", properties: { time: { type: "NUMBER" } }, required: ["time"] },
    },
  ];
}

/** The markers of an add_markers call, checked; the editor's side checks colours and times. */
export function markerArgs(args: Args): Record<string, unknown>[] {
  const markers = args.markers;
  if (!Array.isArray(markers) || markers.length === 0) throw new Error("markers must be a non-empty array");
  return markers.map((m, i) => {
    if (typeof m !== "object" || m === null) throw new Error(`markers[${i}] must be an object`);
    const marker = m as Args;
    const out: Record<string, unknown> = { time: num(marker, "time") };
    for (const key of ["name", "color", "note"] as const) {
      const value = optStr(marker, key);
      if (value !== undefined) out[key] = value;
    }
    const duration = optNum(marker, "duration");
    if (duration !== undefined) out.duration = duration;
    return out;
  });
}

interface EditorStatus {
  project: string | null;
  timelines: string[];
  currentTimeline: string | null;
}

/** What the executors act on: the editor, the timeline open in it when the turn started, and the
 * request (the user message) the turn is for, which groups its edits under one backup and Revert. */
export interface ToolContext {
  host: NleHost;
  timeline: string | null;
  step: string;
  stepText: string;
}

export function executorsFor(context: ToolContext): Record<string, Executor> {
  const { host } = context;
  const { editor, timeline: noun } = WORDS[host];

  const timelineName = (): string => {
    if (!context.timeline) throw new Error(`No ${noun} is open in ${editor}. Ask the user to open one, or create_timeline.`);
    return context.timeline;
  };
  const call = <T>(command: string, args: Record<string, unknown> = {}): Promise<T> =>
    nleCall<T>(host, command, { timeline: timelineName(), ...args });

  // The connected timeline can change mid-turn (create_timeline, switch_timeline): each edit is built
  // for the one connected when it runs.
  const editNames = Object.keys(editExecutors({ host, timeline: "", step: context.step, stepText: context.stepText }));
  const edits: Record<string, Executor> = Object.fromEntries(
    editNames.map((name) => [
      name,
      (args: Args) => {
        // A draft was copied from the timeline as it was; editing the timeline now would split them (VibeCut's rule).
        refuseWhileDrafting(host, "edit the timeline directly");
        return editExecutors({ host, timeline: timelineName(), step: context.step, stepText: context.stepText })[name](args);
      },
    ]),
  );

  return {
    ...edits,
    ...SPYGLASS_EXECUTORS,
    list_timelines: async () => {
      const status = await nleCall<EditorStatus>(host, "status");
      return {
        summary: `Read ${status.timelines.length} ${noun}(s) in ${editor}`,
        result: { project: status.project, timelines: status.timelines, open: status.currentTimeline },
      };
    },

    list_timeline_clips: async (args) => {
      const timeline = await call<HostTimeline>("read_timeline");
      const detail = bool(args, "detail");
      const tracks = timeline.tracks.map((t) => ({
        track: `${t.type === "video" ? "V" : t.type === "audio" ? "A" : "S"}${t.index}`,
        name: t.name,
        enabled: t.enabled,
        clips: t.clips.map((c) =>
          detail
            ? c
            : { id: c.id, name: c.name, start: c.start, end: c.end, ...(c.enabled ? {} : { enabled: false }), ...(c.kind ? { kind: c.kind } : {}) },
        ),
      }));
      const count = timeline.tracks.reduce((n, t) => n + t.clips.length, 0);
      return {
        summary: `Read ${count} clip(s) on ${timeline.tracks.length} track(s) in ${editor}`,
        result: { fps: timeline.fps, duration: timeline.duration, tracks },
      };
    },

    list_markers: async () => {
      const { markers } = await call<{ markers: HostMarker[] }>("list_markers");
      return { summary: `Read ${markers.length} marker(s) in ${editor}`, result: { markers } };
    },

    add_markers: async (args) => {
      const markers = markerArgs(args);
      const result = await call<{ added: { id: string; time: number; name: string }[]; alreadyThere: string[]; refusedAt: number[] }>(
        "add_markers",
        { markers },
      );
      const parts = [`Added ${result.added.length} marker(s) in ${editor}`];
      if (result.added.length) parts[0] += `: ${result.added.map((m) => `"${m.name}" at ${clock(m.time)}`).join(", ")}`;
      if (result.alreadyThere.length) parts.push(`${result.alreadyThere.length} already had a marker on that frame`);
      if (result.refusedAt.length) parts.push(`${editor} refused ${result.refusedAt.length} at ${result.refusedAt.map(clock).join(", ")}`);
      return { summary: parts.join("; "), result };
    },

    update_marker: async (args) => {
      const markerId = optStr(args, "markerId");
      if (!markerId) throw new Error("markerId must be a non-empty string");
      const fields: Record<string, unknown> = { markerId };
      for (const key of ["name", "color", "note"] as const) {
        if (typeof args[key] === "string") fields[key] = args[key];
      }
      const time = optNum(args, "time");
      if (time !== undefined) fields.time = time;
      const marker = await call<{ id: string; time: number; name: string }>("update_marker", fields);
      return { summary: `Changed ${editor} marker "${marker.name}" at ${clock(marker.time)}`, result: marker };
    },

    remove_markers: async (args) => {
      const all = bool(args, "all");
      const result = await call<{ removed: string[]; notFound: string[] }>(
        "remove_markers",
        all ? { all: true } : { markerIds: strArray(args, "markerIds") },
      );
      const missing = result.notFound.length ? `; ${result.notFound.length} weren't there` : "";
      return { summary: `Removed ${result.removed.length} marker(s) in ${editor}${missing}`, result };
    },

    get_playhead_time: async () => {
      const { time } = await call<{ time: number }>("get_playhead");
      return { summary: `${editor}'s playhead is at ${clock(time)}`, result: { time } };
    },

    set_playhead_time: async (args) => {
      const { time } = await call<{ time: number }>("set_playhead", { time: num(args, "time") });
      return { summary: `Moved ${editor}'s playhead to ${clock(time)}`, result: { time } };
    },
    ...projectExecutors(context),
    ...transcriptExecutors(context),
    ...draftExecutors(context),
    ...syncExecutors(context),
    ...storyExecutors(context),
  };
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Runs one call; a failure becomes an `{error}` result the model can read and recover from. */
export async function runTool(executors: Record<string, Executor>, name: string, args: unknown): Promise<ToolOutcome> {
  const executor = executors[name];
  if (!executor) return { summary: `Unknown tool ${name}`, result: { error: `Unknown tool: ${name}` } };
  try {
    return await executor(typeof args === "object" && args !== null ? (args as Args) : {});
  } catch (error) {
    const message = describeError(error);
    return { summary: `${name} failed: ${message}`, result: { error: message } };
  }
}
