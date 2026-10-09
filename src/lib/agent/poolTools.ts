/**
 * The agent organizing the connected project (PLAN.md, "Phase 12e"), ported from VibeCut's
 * poolChanges.ts and poolSpec.ts: bins, moving clips into them, clip colour (Premiere's label) and
 * Resolve's flags, logged fields and keywords, and clip names, in Resolve's Media Pool or Premiere's
 * project. Neither editor has an undo that follows a script's changes, so each call is logged with what
 * it replaced. Unlike VibeCut, which kept a separate pool log, it goes in the same edit log as the
 * timeline edits, so the chat's Revert and revert_timeline_edits undo it too (through the editor's
 * `revert_pool_changes`). The editors' watchers do the work (premiere_organize / resolve_organize).
 */
import { nleCall } from "../ipc";
import { useEditLogStore } from "../../store/useEditLogStore";
import type { NleHost } from "../../types/nle";
import type { PoolChange, PoolChangeResult } from "../../types/edits";
import { bool, optStr, strArray, type Args, type Executor, type ToolOutcome } from "./args";
import { aliasOf, poolClipId, refreshPool } from "./projectTools";
import type { ToolContext, ToolDeclaration } from "./tools";

const RESOLVE_CLIP_COLORS = [
  "Orange", "Apricot", "Yellow", "Lime", "Olive", "Green", "Teal", "Navy",
  "Blue", "Purple", "Violet", "Pink", "Tan", "Beige", "Brown", "Chocolate",
] as const; // prettier-ignore

/** Resolve's flags take its marker colours. */
const RESOLVE_FLAG_COLORS = [
  "Blue", "Cyan", "Green", "Yellow", "Red", "Pink", "Purple", "Fuchsia",
  "Rose", "Lavender", "Sky", "Mint", "Lemon", "Sand", "Cocoa", "Cream",
] as const; // prettier-ignore

/** Premiere's label colours by index, as its preferences name them by default (premiere_pool.py). */
const PREMIERE_LABEL_COLORS = [
  "Violet", "Iris", "Caribbean", "Lavender", "Cerulean", "Forest", "Rose", "Mango",
  "Purple", "Blue", "Teal", "Magenta", "Tan", "Green", "Brown", "Yellow",
] as const; // prettier-ignore

/** What differs between Resolve's Media Pool and Premiere's project (VibeCut's poolSpec.ts). */
interface PoolSpec {
  host: string;
  pool: string;
  colorWord: string;
  clipColors: readonly string[];
  flagColors: readonly string[] | null;
  keywords: boolean;
  /** The logged fields a script may set, by the argument names the agent uses -> the editor's own. */
  metadataArgs: Record<string, string>;
  booleanArgs: readonly string[];
}

const SPECS: Record<NleHost, PoolSpec> = {
  resolve: {
    host: "Resolve",
    pool: "Media Pool",
    colorWord: "clip colour",
    clipColors: RESOLVE_CLIP_COLORS,
    flagColors: RESOLVE_FLAG_COLORS,
    keywords: true,
    metadataArgs: { comments: "Comments", description: "Description", scene: "Scene", shot: "Shot", take: "Take", angle: "Angle", camera: "Camera #", reelName: "Reel Name" },
    booleanArgs: [],
  },
  premiere: {
    host: "Premiere",
    pool: "project",
    colorWord: "label",
    clipColors: PREMIERE_LABEL_COLORS,
    flagColors: null,
    keywords: false,
    metadataArgs: { description: "Description", logNote: "Log Note", scene: "Scene", shot: "Shot", good: "Good" },
    booleanArgs: ["good"],
  },
};

const FIELD_LABELS: Record<string, string> = { bin: "bin", flags: "flags", name: "name" };
const count = (n: number, what: string) => `${n} ${what}${n === 1 ? "" : "s"}`;
const optStrArray = (args: Args, key: string): string[] | undefined => (args[key] === undefined ? undefined : strArray(args, key));

const fieldLabel = (field: string, spec: PoolSpec) =>
  field === "color" ? spec.colorWord : (FIELD_LABELS[field] ?? (field.startsWith("metadata:") ? field.slice("metadata:".length).toLowerCase() : field));

const shown = (value: PoolChange["before"]) => {
  const text = Array.isArray(value) ? value.join(", ") : value;
  return text === null || text === "" ? "none" : `"${String(text)}"`;
};

/** '"A.mov" (p3) label: "Violet" → "Mango"' */
export function describePoolChange(host: NleHost, change: PoolChange): string {
  return `${aliasOf(host, change.clipId)} ${fieldLabel(change.field, SPECS[host])}: ${shown(change.before)} → ${shown(change.after)}`;
}

export function poolExecutors(context: ToolContext): Record<string, Executor> {
  const { host } = context;
  const spec = SPECS[host];
  const call = <T>(command: string, args: Record<string, unknown>) => nleCall<T>(host, command, args);

  const clipIds = (args: Args) => {
    const ids = strArray(args, "clipIds");
    if (ids.length === 0) throw new Error(`clipIds must list at least one ${spec.pool} clip`);
    return ids.map((id) => poolClipId(host, id));
  };

  /** Logs a command's changes in the edit log, reads the pool again and reports to the agent. */
  const logged = async (tool: string, result: PoolChangeResult, done: string, extra: Record<string, unknown> = {}): Promise<ToolOutcome> => {
    const changed = result.changes.length > 0 || result.createdBins.length > 0;
    const parts = [changed ? done : "Nothing needed changing"];
    if (result.refused.length) parts.push(`${spec.host} refused ${result.refused.length}: ${result.refused.map((r) => `${aliasOf(host, r.clipId)} (${r.reason})`).join(", ")}`);
    const summary = parts.join("; ");
    let editId: string | undefined;
    if (changed) {
      editId = useEditLogStore.getState().log({
        step: context.step,
        stepText: context.stepText,
        host,
        timeline: context.timeline ?? "",
        tool,
        summary,
        backup: "",
        changes: [],
        pool: { changes: result.changes, createdBins: result.createdBins },
      }).id;
    }
    await refreshPool(host, context.timeline);
    return {
      summary: `${summary}${editId ? ` (it can be reverted: ${editId})` : ""}`,
      result: {
        ...(editId ? { editId } : {}),
        changed: result.changes.map((c) => ({ clipId: aliasOf(host, c.clipId), field: c.field, before: c.before, after: c.after })),
        ...(result.createdBins.length ? { createdBins: result.createdBins } : {}),
        ...(result.refused.length ? { refused: result.refused.map((r) => ({ clipId: aliasOf(host, r.clipId), reason: r.reason })) } : {}),
        ...extra,
      },
    };
  };

  return {
    create_bins: async (args) => {
      const result = await call<PoolChangeResult & { existing: string[] }>("create_bins", { paths: strArray(args, "paths") });
      const done = `Created ${count(result.createdBins.length, "bin")} in ${spec.host}${result.createdBins.length ? `: ${result.createdBins.join(", ")}` : ""}`;
      return logged("create_bins", result, result.existing.length ? `${done}; already there: ${result.existing.join(", ")}` : done, { existing: result.existing });
    },

    move_clips: async (args) => {
      const bin = optStr(args, "bin");
      if (!bin) throw new Error('bin must be a bin path, e.g. "B-roll/Bakery"');
      const result = await call<PoolChangeResult & { alreadyThere: string[] }>("move_clips", { clipIds: clipIds(args), bin, create: bool(args, "create") });
      const target = result.changes[0]?.after ?? bin;
      const done = [
        `Moved ${count(result.changes.length, "clip")} to "${String(target)}"`,
        result.createdBins.length ? `created ${result.createdBins.join(", ")}` : "",
        result.alreadyThere.length ? `${result.alreadyThere.length} already there` : "",
      ].filter(Boolean);
      return logged("move_clips", result, done.join("; "), { alreadyThere: result.alreadyThere.map((id) => aliasOf(host, id)) });
    },

    set_clip_labels: async (args) => {
      const request: Record<string, unknown> = { clipIds: clipIds(args) };
      const color = optStr(args, "color");
      if (color !== undefined) request.color = color.toLowerCase() === "none" ? null : color;
      const addFlags = optStrArray(args, "addFlags");
      const clearFlags = optStrArray(args, "clearFlags");
      if (addFlags) request.addFlags = addFlags;
      if (clearFlags) request.clearFlags = clearFlags;
      const result = await call<PoolChangeResult>("set_clip_labels", request);
      const clips = new Set(result.changes.map((c) => c.clipId)).size;
      const what = spec.flagColors ? "the colour or flags" : `the ${spec.colorWord}`;
      return logged("set_clip_labels", result, `Changed ${what} of ${count(clips, "clip")} in ${spec.host}`);
    },

    set_clip_metadata: async (args) => {
      const fields: Record<string, string | boolean> = {};
      for (const [arg, key] of Object.entries(spec.metadataArgs)) {
        if (typeof args[arg] === "string" || (spec.booleanArgs.includes(arg) && typeof args[arg] === "boolean")) fields[key] = args[arg] as string | boolean;
      }
      const keywords: Record<string, string[]> = {};
      for (const [arg, key] of [["addKeywords", "add"], ["removeKeywords", "remove"], ["replaceKeywords", "replace"]] as const) {
        const words = optStrArray(args, arg);
        if (words) keywords[key] = words;
      }
      const request: Record<string, unknown> = { clipIds: clipIds(args), fields };
      if (spec.keywords || Object.keys(keywords).length) request.keywords = keywords;
      const result = await call<PoolChangeResult>("set_clip_metadata", request);
      const clips = new Set(result.changes.map((c) => c.clipId)).size;
      return logged("set_clip_metadata", result, `Changed the logging of ${count(clips, "clip")} in ${spec.host}`);
    },

    rename_clips: async (args) => {
      const renames = args.renames;
      if (!Array.isArray(renames) || renames.length === 0) throw new Error("renames must be a non-empty array of {clipId, name}");
      const request = renames.map((r, i) => {
        if (typeof r !== "object" || r === null) throw new Error(`renames[${i}] must be an object`);
        const clipId = optStr(r as Args, "clipId");
        const name = optStr(r as Args, "name");
        if (!clipId || !name) throw new Error(`renames[${i}] needs a clipId and a name`);
        return { clipId: poolClipId(host, clipId), name };
      });
      const result = await call<PoolChangeResult>("rename_clips", { renames: request });
      const done = `Renamed ${count(result.changes.length, "clip")} in ${spec.host}${
        result.changes.length ? `: ${result.changes.map((c) => `"${String(c.before)}" → "${String(c.after)}"`).join(", ")}` : ""
      }`;
      return logged("rename_clips", result, done);
    },
  };
}

const keywordList = (description: string) => ({ type: "ARRAY", items: { type: "STRING" }, description });

/** The organizing tools as one editor offers them (VibeCut's poolTools). */
export function poolToolDeclarations(host: NleHost): ToolDeclaration[] {
  const spec = SPECS[host];
  const { pool } = spec;
  const editor = spec.host;
  const REVERT = "Changes the project at once; it can be reverted with revert_timeline_edits (its editId) or the chat's Revert.";
  const ids = { type: "ARRAY", items: { type: "STRING" }, description: `Short ${pool} ids ("p3").` };
  const flags = spec.flagColors;
  const labels: ToolDeclaration = flags
    ? {
        name: "set_clip_labels",
        description: `Sets Media Pool clips' clip colour and flags. color "None" clears it; leave color out to keep it. addFlags adds flags, clearFlags removes them (["All"] removes every flag). Clip colours and flag colours are different lists. ${REVERT}`,
        parameters: {
          type: "OBJECT",
          properties: {
            clipIds: ids,
            color: { type: "STRING", enum: [...spec.clipColors, "None"], description: "Optional." },
            addFlags: { type: "ARRAY", items: { type: "STRING", enum: [...flags] }, description: "Optional." },
            clearFlags: { type: "ARRAY", items: { type: "STRING", enum: [...flags, "All"] }, description: "Optional." },
          },
          required: ["clipIds"],
        },
      }
    : {
        name: "set_clip_labels",
        description: `Sets ${pool} clips' label colour in ${editor}. Every clip has a label, so it can be changed but not cleared; there are no flags. ${REVERT}`,
        parameters: { type: "OBJECT", properties: { clipIds: ids, color: { type: "STRING", enum: [...spec.clipColors] } }, required: ["clipIds", "color"] },
      };
  // A field whose name the argument can't spell ("Camera #"), or a yes/no one, says which it is.
  const fields: Record<string, unknown> = Object.fromEntries(
    Object.entries(spec.metadataArgs).map(([arg, name]) => {
      const type = spec.booleanArgs.includes(arg) ? "BOOLEAN" : "STRING";
      return [arg, type === "BOOLEAN" || /[^A-Za-z ]/.test(name) ? { type, description: `${editor}'s "${name}".` } : { type }];
    }),
  );
  const metadata: ToolDeclaration = {
    name: "set_clip_metadata",
    description: spec.keywords
      ? `Sets Media Pool clips' logged fields ("" clears one) and keywords: addKeywords and removeKeywords edit the keyword list, replaceKeywords sets it outright. Only set what the user asked for or clearly implied. ${REVERT}`
      : `Sets ${pool} clips' logged fields in ${editor} ("" clears one; good ticks or unticks Good). They're kept in the project; the media files aren't touched. There are no keywords here: put words to search by in description or logNote. Only set what the user asked for or clearly implied. ${REVERT}`,
    parameters: {
      type: "OBJECT",
      properties: {
        clipIds: ids,
        ...fields,
        ...(spec.keywords ? { addKeywords: keywordList("Optional."), removeKeywords: keywordList("Optional."), replaceKeywords: keywordList("Optional; replaces all keywords.") } : {}),
      },
      required: ["clipIds"],
    },
  };
  return [
    {
      name: "create_bins",
      description: `Creates ${pool} bins in ${editor}, with any missing parents ("B-roll/Bakery" makes both). A bin that already exists is left as it is. move_clips can also create its bin. ${REVERT}`,
      parameters: { type: "OBJECT", properties: { paths: { type: "ARRAY", items: { type: "STRING" }, description: 'Bin paths, e.g. "B-roll/Day 1".' } }, required: ["paths"] },
    },
    {
      name: "move_clips",
      description: `Moves ${pool} clips into a bin. create=true makes the bin (and parents) if it's missing. ${REVERT}`,
      parameters: {
        type: "OBJECT",
        properties: { clipIds: ids, bin: { type: "STRING", description: 'Bin path, e.g. "B-roll/Bakery".' }, create: { type: "BOOLEAN", description: "Optional." } },
        required: ["clipIds", "bin"],
      },
    },
    labels,
    metadata,
    {
      name: "rename_clips",
      description: `Renames ${pool} clips (the clip's name in ${editor}; the file on disk keeps its name). ${REVERT}`,
      parameters: {
        type: "OBJECT",
        properties: {
          renames: { type: "ARRAY", items: { type: "OBJECT", properties: { clipId: { type: "STRING" }, name: { type: "STRING" } }, required: ["clipId", "name"] } },
        },
        required: ["renames"],
      },
    },
  ];
}

export function poolInstruction(host: NleHost): string {
  const { pool, colorWord, flagColors } = SPECS[host];
  return `- Organizing the ${pool}: create_bins, move_clips (into a bin, create=true makes it), set_clip_labels (${colorWord}${flagColors ? " and flags" : ""}),
  set_clip_metadata (logged fields${host === "resolve" ? " and keywords" : ""}) and rename_clips, by short ids ("p3"). They change the project at once,
  are logged with the timeline edits, and Revert / revert_timeline_edits undoes them; a bin you made is removed
  only once it's empty. Only change what the user asked for.`;
}
