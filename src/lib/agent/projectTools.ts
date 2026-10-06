/**
 * The editor's project for the agent (PLAN.md, "Phase 6a"), ported from VibeCut's hostProject.ts,
 * poolRead.ts and poolSpec.ts: its timelines (list, create, duplicate, switch, rename), selection, and
 * the Media Pool / Project panel (list, search, clip info, import), with VibeCut's rules:
 * - the agent works on one timeline at a time, the connected one. create_timeline and duplicate_timeline
 *   open the new one and connect to it, so the edits that follow build it; the original stays as it was;
 * - it switches freely to timelines it made, but to one of the user's only when the user's message names it;
 * - it renames only timelines it made, and never touches the "(before VibeCut n)" backups.
 * The connected timeline is `context.timeline`, which these tools change mid-turn; the edit tools read it
 * at each call (tools.ts). Pool clips are named by short ids ("p3") kept in useConnectionStore.
 */
import { nleCall } from "../ipc";
import { useConnectionStore } from "../../store/useConnectionStore";
import type { NleHost } from "../../types/nle";
import type { HostPool, HostPoolClip } from "../../types/pool";
import type { HostTimeline } from "../../types/timeline";
import { bool, clock, type Executor, optStr, strArray } from "./args";
import type { ToolContext, ToolDeclaration } from "./tools";
import { refuseWhileDrafting } from "./draft";

const BACKUP = /\(before VibeCut \d+\)$/;
/** Pool clips listed in the snapshot before it's abridged. */
const CONTEXT_POOL_LIMIT = 80;
const IMPORT_BIN = "VibeCut";

// ----------------------------------------------------------------------------- words (poolSpec.ts)

interface PoolWords {
  editor: string;
  thing: string;
  pool: string;
  title: string;
  selectedIn: string;
  colorTag: string;
}

export const POOL_WORDS: Record<NleHost, PoolWords> = {
  premiere: { editor: "Premiere", thing: "sequence", pool: "project", title: "Premiere project", selectedIn: "the Project panel", colorTag: "label" },
  resolve: { editor: "Resolve", thing: "timeline", pool: "Media Pool", title: "Resolve Media Pool", selectedIn: "the Media Pool", colorTag: "colour" },
};

// ----------------------------------------------------------------------------- the pool and short ids

const connection = (host: NleHost) => useConnectionStore.getState().connections[host];

/** A pool clip by its short id ("p3") or the editor's own. */
export function poolClipId(host: NleHost, ref: string): string {
  const byAlias = Object.entries(connection(host).aliases).find(([, alias]) => alias === ref);
  return byAlias ? byAlias[0] : ref;
}

export const aliasOf = (host: NleHost, id: string) => connection(host).aliases[id] ?? id;

/** A clip as the agent sees it: its short id instead of the editor's. */
const forAgent = (host: NleHost, clip: HostPoolClip) => {
  const { id, ...rest } = clip;
  return { id: aliasOf(host, id), ...rest };
};

/** Reads the pool afresh (with the connected timeline's selection) and keeps it. Null if it can't be read. */
export async function refreshPool(host: NleHost, timeline: string | null): Promise<HostPool | null> {
  try {
    const pool = await nleCall<HostPool>(host, "read_media_pool", timeline ? { timeline } : {});
    useConnectionStore.getState().setPool(host, pool);
    return pool;
  } catch (error) {
    useConnectionStore.getState().setPoolError(host, error instanceof Error ? error.message : String(error));
    return null;
  }
}

/** One pool clip on a line: 'p3 "City.mov" Video + Audio · 30.0s · 1920x1080 · in 1.0s–4.0s · label Orange · ...' */
function poolLine(clip: HostPoolClip, alias: string, selected: boolean, words: PoolWords): string {
  const meta = clip.metadata ?? {};
  const parts = [
    clip.type,
    clip.duration !== undefined ? clock(clip.duration) : null,
    clip.resolution ?? null,
    clip.markIn !== undefined && clip.markOut !== undefined ? `in ${clock(clip.markIn)}–${clock(clip.markOut)}` : null,
    clip.clipColor ? `${words.colorTag} ${clip.clipColor}` : null,
    clip.flags?.length ? `flags ${clip.flags.join("/")}` : null,
    ...Object.entries(meta).map(([key, value]) => `${key.toLowerCase()}: ${value}`),
    clip.usage === 0 ? "unused" : `used ${clip.usage}×`,
    clip.offline ? "OFFLINE" : null,
  ].filter(Boolean);
  return `  ${alias} "${clip.name}" ${parts.join(" · ")}${selected ? " [selected]" : ""}`;
}

/** The pool and selection block of the snapshot (VibeCut's poolContext). */
export function poolContext(host: NleHost, timeline: HostTimeline | null = null): string {
  const { pool, poolError, aliases } = connection(host);
  const words = POOL_WORDS[host];
  if (!pool) return `[${words.title} — not readable right now${poolError ? `: ${poolError}` : ""}]`;
  const selected = new Set(pool.selection.pool);
  const lines = [`[${words.title} — ${pool.clips.length}${pool.truncated ? "+" : ""} clip(s) in ${pool.bins.length} bin(s)]`];
  let shown = 0;
  for (const bin of pool.bins) {
    const clips = pool.clips.filter((c) => c.bin === bin.path);
    if (clips.length === 0) continue;
    lines.push(`${bin.path}:`);
    for (const clip of clips) {
      if (shown >= CONTEXT_POOL_LIMIT && !selected.has(clip.id)) continue;
      shown++;
      lines.push(poolLine(clip, aliases[clip.id] ?? clip.id, selected.has(clip.id), words));
    }
  }
  if (shown < pool.clips.length || pool.truncated) lines.push(`(abridged: use search_media_pool or list_media_pool to see the rest)`);
  const names = new Map(timeline?.tracks.flatMap((t) => t.clips.map((c) => [c.id, `"${c.name}" ${clock(c.start)}–${clock(c.end)}`] as const)) ?? []);
  const poolSelected = pool.clips.filter((c) => selected.has(c.id)).map((c) => `${aliases[c.id] ?? c.id} "${c.name}"`);
  lines.push(`Selected in ${words.selectedIn}: ${poolSelected.length ? poolSelected.join(", ") : "nothing"}`);
  if (pool.selection.timeline.length) {
    lines.push(`Selected on the ${words.thing}: ${pool.selection.timeline.map((id) => `${id} ${names.get(id) ?? ""}`.trim()).join(", ")}`);
  }
  if (pool.selection.underPlayhead) {
    lines.push(`Under the playhead: ${pool.selection.underPlayhead} ${names.get(pool.selection.underPlayhead) ?? ""}`.trim());
  }
  return lines.join("\n");
}

// ----------------------------------------------------------------------------- the executors

interface EditorStatus {
  project: string | null;
  timelines: string[];
  currentTimeline: string | null;
}

/** The project executors, acting on `context`, whose `timeline` they move when they create or switch. */
export function projectExecutors(context: ToolContext): Record<string, Executor> {
  const { host } = context;
  const words = POOL_WORDS[host];
  const { editor, thing } = words;
  const store = () => useConnectionStore.getState();
  const made = () => connection(host).madeTimelines;

  const connectedName = (): string => {
    if (!context.timeline) throw new Error(`No ${thing} is connected. Open one in ${editor}, or create_timeline.`);
    return context.timeline;
  };

  /** Connects to `name` (already open in the editor). */
  const connectTo = async (name: string, isNew: boolean): Promise<void> => {
    if (isNew) store().addMadeTimeline(host, name);
    context.timeline = name;
    await refreshPool(host, name);
  };

  /** Whether the user's message being answered names this timeline. */
  const userNamed = (name: string) => context.stepText.toLowerCase().includes(name.toLowerCase());

  const status = () => nleCall<EditorStatus>(host, "status");

  /** A clip and the clips linked to it, from a fresh read of the connected timeline. */
  const withLinked = async (id: string): Promise<{ ids: string[]; start: number; name: string }> => {
    const view = await nleCall<HostTimeline>(host, "read_timeline", { timeline: connectedName() });
    const clip = view.tracks.flatMap((t) => t.clips).find((c) => c.id === id);
    if (!clip) throw new Error(`There's no clip ${id} on the connected ${thing}; the snapshot lists them`);
    return { ids: [id, ...(clip.linkedIds ?? [])], start: clip.start, name: clip.name };
  };

  return {
    list_timelines: async () => {
      const info = await status();
      const timelines = info.timelines.map((name) => ({
        name,
        ...(name === context.timeline ? { connected: true } : {}),
        ...(name === info.currentTimeline ? { openInEditor: true } : {}),
        ...(made().includes(name) ? { madeByVibeCut: true } : {}),
        ...(BACKUP.test(name) ? { backup: true } : {}),
      }));
      return { summary: `${timelines.length} ${thing}(s) in the ${editor} project`, result: { project: info.project, timelines } };
    },

    create_timeline: async (args) => {
      refuseWhileDrafting(host, `make a new ${thing}`);
      const before = context.timeline;
      const { timeline, fps } = await nleCall<{ timeline: string; fps?: number | string }>(host, "create_timeline", {
        ...(before ? { timeline: before } : {}),
        ...(optStr(args, "name") ? { name: optStr(args, "name") } : {}),
      });
      await connectTo(timeline, true);
      return {
        summary: `Made the empty ${thing} "${timeline}"${fps ? ` (${fps} fps)` : ""} in ${editor}, opened it and connected to it${before ? `; "${before}" is unchanged` : ""}`,
        result: { timeline, ...(fps ? { fps } : {}), previous: before },
      };
    },

    duplicate_timeline: async (args) => {
      refuseWhileDrafting(host, `copy the ${thing}`);
      const source = connectedName();
      const asked = optStr(args, "timeline");
      if (asked && asked !== source) throw new Error(`Only the connected ${thing} ("${source}") can be copied from here; switch_timeline to another first`);
      const { timeline } = await nleCall<{ timeline: string }>(host, "duplicate_timeline", { timeline: source, ...(optStr(args, "name") ? { name: optStr(args, "name") } : {}) });
      await connectTo(timeline, true);
      return { summary: `Copied "${source}" to "${timeline}" in ${editor}, opened the copy and connected to it; "${source}" is unchanged`, result: { timeline, original: source } };
    },

    switch_timeline: async (args) => {
      const name = optStr(args, "timeline");
      if (!name) throw new Error("timeline must name the one to switch to");
      if (name === context.timeline) return { summary: `Already connected to "${name}"`, result: { timeline: name } };
      const info = await status();
      if (!info.timelines.includes(name)) throw new Error(`There's no ${thing} called "${name}" in the ${editor} project; list_timelines lists them`);
      if (BACKUP.test(name)) throw new Error(`"${name}" is a backup VibeCut made; it's there for Revert and isn't worked on`);
      if (!made().includes(name) && !userNamed(name)) {
        throw new Error(`"${name}" is the user's own ${thing}. Ask the user whether to work on it; once they name it in their message, you can switch`);
      }
      refuseWhileDrafting(host, `switch ${thing}s`);
      const previous = context.timeline;
      await nleCall(host, "open_timeline", { timeline: name });
      await connectTo(name, false);
      return { summary: `Opened "${name}" in ${editor} and connected to it (was "${previous ?? "none"}"); its clip ids are new, so read it before editing`, result: { timeline: name, previous } };
    },

    rename_timeline: async (args) => {
      const name = optStr(args, "timeline") ?? connectedName();
      const to = optStr(args, "name");
      if (!to) throw new Error("name must be the new name");
      if (!made().includes(name)) {
        throw new Error(`Only ${thing}s VibeCut made this session can be renamed from here; "${name}" is the user's (ask them to rename it in ${editor})`);
      }
      const result = await nleCall<{ timeline: string; before: string }>(host, "rename_timeline", { timeline: name, name: to });
      store().renameMadeTimeline(host, name, result.timeline);
      if (context.timeline === name) context.timeline = result.timeline;
      return { summary: `Renamed "${name}" to "${result.timeline}" in ${editor}`, result };
    },

    select_clip: async (args) => {
      const id = optStr(args, "clipId");
      if (!id) throw new Error("clipId must name a clip from the snapshot");
      const clip = await withLinked(id);
      if (host === "premiere") {
        const ids = bool(args, "ungrouped") ? [id] : clip.ids;
        const { selected } = await nleCall<{ selected: string[] }>(host, "select_items", { timeline: connectedName(), itemIds: ids, additive: bool(args, "additive") });
        return { summary: `Selected ${ids.length} clip(s) in Premiere (${selected.length} selected now)`, result: { selected } };
      }
      // Resolve's scripting can't select a timeline clip: the playhead goes to it.
      await nleCall(host, "set_playhead", { timeline: connectedName(), time: clip.start });
      return {
        summary: `Resolve can't select a timeline clip from a script, so its playhead is now at the start of "${clip.name}" instead`,
        result: { selected: [], playhead: clip.start },
      };
    },

    select_media_assets: async (args) => {
      const ids = strArray(args, "assetIds").map((ref) => poolClipId(host, ref));
      if (ids.length === 0) throw new Error("assetIds must list pool clips");
      const result = await nleCall<{ selected: string[]; notSelected: string[] }>(host, "select_pool_clips", { clipIds: ids });
      const missed = result.notSelected.length ? `; ${editor} keeps one clip selected from a script, so ${result.notSelected.map((i) => aliasOf(host, i)).join(", ")} isn't` : "";
      return {
        summary: `Selected ${result.selected.map((i) => aliasOf(host, i)).join(", ") || "nothing"} in ${words.selectedIn}${missed}`,
        result: { selected: result.selected.map((i) => aliasOf(host, i)), notSelected: result.notSelected.map((i) => aliasOf(host, i)) },
      };
    },

    list_media_pool: async (args) => {
      const pool = (await refreshPool(host, context.timeline)) ?? connection(host).pool;
      if (!pool) throw new Error(`Couldn't read the ${words.pool}${connection(host).poolError ? `: ${connection(host).poolError}` : ""}`);
      const bin = optStr(args, "bin")?.toLowerCase();
      const clips = pool.clips.filter((c) => !bin || c.bin.toLowerCase().includes(bin)).map((c) => forAgent(host, c));
      return {
        summary: `Read ${clips.length} ${words.pool} clip(s)${bin ? ` in bins matching "${args.bin}"` : ""}`,
        result: { bins: pool.bins, clips, timelines: pool.timelines, ...(pool.truncated ? { truncated: true } : {}) },
      };
    },

    get_clip_info: async (args) => {
      const ref = optStr(args, "clipId");
      if (!ref) throw new Error("clipId must be a short pool id from the snapshot");
      const info = await nleCall<HostPoolClip>(host, "get_clip_info", { clipId: poolClipId(host, ref) });
      return { summary: `Read "${info.name}" from the ${words.pool}`, result: forAgent(host, info) };
    },

    search_media_pool: async (args) => {
      const query: Record<string, unknown> = {};
      for (const key of ["text", "keyword", "clipColor", "flag", "type", "bin"] as const) {
        const value = optStr(args, key);
        if (value) query[key] = value;
      }
      for (const key of ["unused", "marked"] as const) if (args[key] === true) query[key] = true;
      const { clips, total } = await nleCall<{ clips: HostPoolClip[]; total: number }>(host, "search_media_pool", query);
      // Clips first seen here get their short ids too.
      const known = connection(host);
      if (known.pool) store().setPool(host, { ...known.pool, clips: [...known.pool.clips, ...clips.filter((c) => !known.aliases[c.id])] });
      return {
        summary: `Found ${total} ${words.pool} clip(s)${total > clips.length ? ` (showing ${clips.length})` : ""}`,
        result: { clips: clips.map((c) => forAgent(host, c)), total },
      };
    },

    import_media: async (args) => {
      const paths = strArray(args, "filePaths");
      if (paths.length === 0) throw new Error("filePaths must list absolute media file paths");
      const bin = optStr(args, "bin") ?? IMPORT_BIN;
      const r = await nleCall<{ bin: string; imported: { path: string; clipId: string }[]; reused: { path: string; clipId: string }[]; refused?: { path: string; reason: string }[] }>(
        host,
        "import_media",
        { paths, bin },
      );
      await refreshPool(host, context.timeline);
      const imported = r.imported.map((i) => ({ path: i.path, clipId: aliasOf(host, i.clipId) }));
      const reused = r.reused.map((i) => ({ path: i.path, clipId: aliasOf(host, i.clipId) }));
      return {
        summary: `Imported ${imported.length} file(s) into "${r.bin}" in ${editor}${reused.length ? `; ${reused.length} already there` : ""}${r.refused?.length ? `; ${r.refused.length} refused` : ""}`,
        result: { imported, reused, ...(r.refused?.length ? { refused: r.refused } : {}) },
      };
    },
  };
}

// ----------------------------------------------------------------------------- declarations

export function projectToolDeclarations(host: NleHost): ToolDeclaration[] {
  const { editor, thing, pool } = POOL_WORDS[host];
  const premiere = host === "premiere";
  return [
    {
      name: "create_timeline",
      description: `Makes an empty ${thing} in ${editor} (${premiere ? "a 1080p sequence at the connected one's frame rate" : "at the project's frame rate"}), opens it and connects to it, so the edits that follow build it. The original stays as it was.`,
      parameters: { type: "OBJECT", properties: { name: { type: "STRING", description: "Optional; made unique." } } },
    },
    {
      name: "duplicate_timeline",
      description: `Copies the connected ${thing} (clips${premiere ? "" : ", grades"}, markers), opens the copy and connects to it, so the edits that follow change the copy and leave the original alone: the way to make a variation.`,
      parameters: { type: "OBJECT", properties: { name: { type: "STRING", description: 'Optional; defaults to "<name> Copy", made unique.' } } },
    },
    {
      name: "switch_timeline",
      description: `Opens another ${thing} in ${editor} and connects to it. Allowed for ${thing}s you made this session; for the user's own only when the user names it in their message (otherwise ask them). Backups are refused. Clip ids change: read it before editing.`,
      parameters: { type: "OBJECT", properties: { timeline: { type: "STRING", description: "Its exact name." } }, required: ["timeline"] },
    },
    {
      name: "rename_timeline",
      description: `Renames a ${thing} you made this session (default: the connected one, if you made it). The user's own aren't renamed from here.`,
      parameters: { type: "OBJECT", properties: { timeline: { type: "STRING" }, name: { type: "STRING" } }, required: ["name"] },
    },
    {
      name: "select_clip",
      description: `Selects a clip of the connected ${thing} in ${editor} (with its linked clips unless ungrouped), e.g. to show the user which one you mean.${premiere ? "" : " Resolve can't select from a script, so its playhead moves to the clip instead."}`,
      parameters: { type: "OBJECT", properties: { clipId: { type: "STRING" }, additive: { type: "BOOLEAN" }, ungrouped: { type: "BOOLEAN" } }, required: ["clipId"] },
    },
    {
      name: "select_media_assets",
      description: `Selects clips in ${editor}'s ${pool} (short ids like "p3"). ${editor} keeps one selected from a script; the reply says which.`,
      parameters: { type: "OBJECT", properties: { assetIds: { type: "ARRAY", items: { type: "STRING" } } }, required: ["assetIds"] },
    },
    {
      name: "list_media_pool",
      description: premiere
        ? "Reads the Premiere project's bins afresh (the Project panel): bins, and each clip's short id, type, length, resolution, label colour, logged notes (description, log note, scene, shot, good), marked In/Out, file path and usage. The snapshot already lists it (abridged for a big project); bin narrows to bins whose path contains that text."
        : "Reads the Resolve project's Media Pool afresh: bins, and each clip's short id, type, length, resolution, clip colour, flags, logged notes (keywords, comments, scene/shot/take), marked In/Out, file path and usage. The snapshot already lists it (abridged for a big pool); bin narrows to bins whose path contains that text.",
      parameters: { type: "OBJECT", properties: { bin: { type: "STRING", description: 'Optional, e.g. "Interviews".' } } },
    },
    {
      name: "get_clip_info",
      description: `One ${pool} clip in full: everything list_media_pool says, plus its own clip markers (seconds from the clip's start) and every ${premiere ? "Project panel column" : "logged property"} that's set.`,
      parameters: { type: "OBJECT", properties: { clipId: { type: "STRING", description: 'Short id ("p3") from the snapshot.' } }, required: ["clipId"] },
    },
    {
      name: "search_media_pool",
      description: premiere
        ? 'Searches every clip in the Premiere project\'s bins (not just the snapshot\'s). All given filters must match: text (words in the name, bin, path or logged notes), clipColor (a label colour), type ("Video + Audio", "Video", "Audio", "Still"), bin (part of the bin path), unused (on no sequence), marked (has a marked In/Out). Premiere has no keywords or flags.'
        : 'Searches every Media Pool clip (not just the snapshot\'s). All given filters must match: text (words in the name, bin, path or logged notes), keyword (one logged keyword), clipColor, flag, type ("Video + Audio", "Video", "Audio", "Still"), bin (part of the bin path), unused (on no timeline), marked (has a marked In/Out).',
      parameters: {
        type: "OBJECT",
        properties: {
          text: { type: "STRING" },
          ...(premiere ? {} : { keyword: { type: "STRING" }, flag: { type: "STRING" } }),
          clipColor: { type: "STRING" },
          type: { type: "STRING" },
          bin: { type: "STRING" },
          unused: { type: "BOOLEAN" },
          marked: { type: "BOOLEAN" },
        },
      },
    },
    {
      name: "import_media",
      description: `Imports media files (absolute paths) into ${editor}'s ${pool}, into a top-level bin (default "VibeCut"; made if missing), and returns each one's short pool id. Files already in the ${pool} are reused. add_clips places files by path, so importing first is only needed to organise or select them. Imports aren't undone by Revert.`,
      parameters: {
        type: "OBJECT",
        properties: { filePaths: { type: "ARRAY", items: { type: "STRING" } }, bin: { type: "STRING", description: 'One bin name, e.g. "Interviews". Optional.' } },
        required: ["filePaths"],
      },
    },
  ];
}

/** The ground rules the prompt gains (VibeCut's PROJECT_INSTRUCTION, adapted). */
export function projectInstruction(host: NleHost): string {
  const { thing, pool } = POOL_WORDS[host];
  return `- The project: you work on one ${thing} at a time, the connected one (the one open when the user wrote,
  until you create or switch). create_timeline (empty) and duplicate_timeline (a copy of the connected one)
  make a new one, open it and connect to it; the original stays as it was. switch_timeline moves to another:
  freely to ones you made, but to one of the user's only when the user names it in their message, so ask
  first. rename_timeline renames only ones you made. "(before VibeCut n)" ${thing}s are Revert's backups:
  leave them alone. After a create or switch, clip ids are the new ${thing}'s.
- The snapshot lists the ${pool} with short clip ids ("p3"), each clip's file path, length and logged notes.
  Use search_media_pool for a big project. To build from the user's footage: create_timeline, then add_clips
  with the clips' file paths (sourceIn/sourceOut in seconds of the file).`;
}
