/**
 * The agent's B-roll tools over Spyglass's index (PLAN.md, "Phase 5"), ported from VibeCut's
 * chatSpyglassTools.ts and find_broll. Read only. find_broll searches the B-roll Library's ticked
 * folders unless the agent names others, and its matches show in the Library too, where the user can
 * pool, preview, import, place or drag them.
 */
import { browseSpyglass, spyglassFolderChildren } from "../spyglassIpc";
import { scopeLabel, searchSpyglass, showAgentResults } from "../library";
import { useLibraryStore } from "../../store/useLibraryStore";
import type { SpyglassBrowseShot, SpyglassFolder, SpyglassMatch } from "../../types/spyglass";
import { type Args, type Executor, optNum, optStr } from "./args";
import type { ToolDeclaration } from "./tools";

const DEFAULT_DESCRIBE_LIMIT = 80;
const MAX_DESCRIBE_LIMIT = 200;
const round2 = (n: number) => Math.round(n * 100) / 100;

/** `key` as an array of strings, or undefined when it is absent. */
export function optStrArray(args: Args, key: string): string[] | undefined {
  const value = args[key];
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value) || !value.every((v) => typeof v === "string")) throw new Error(`${key} must be an array of strings`);
  return value as string[];
}

const folderForModel = (f: SpyglassFolder) => ({
  name: f.name,
  path: f.path,
  shotCount: f.shotCount,
  hasSubfolders: f.hasChildren,
  online: f.online,
  ...(f.topTags.length ? { topTags: f.topTags.map((t) => t.label) } : {}),
  ...(f.dateRange ? { recorded: f.dateRange } : {}),
});

const shotForModel = (s: SpyglassBrowseShot) => ({
  path: s.path,
  filename: s.filename,
  start: round2(s.start),
  end: round2(s.end),
  caption: s.caption,
  ...(s.tags.length ? { tags: s.tags } : {}),
  ...(s.technical !== null ? { technical: s.technical } : {}),
  ...(s.energy !== null ? { energy: s.energy } : {}),
  ...(s.recordedAt ? { recorded: s.recordedAt.slice(0, 10) } : {}),
  ...(s.transcript ? { transcript: s.transcript } : {}),
  ...(s.status !== "ok" ? { status: s.status } : {}),
});

const matchForModel = (m: SpyglassMatch) => ({
  path: m.path,
  filename: m.filename,
  start: round2(m.start),
  end: round2(m.end),
  score: round2(m.score),
  caption: m.caption,
  ...(m.tags?.length ? { tags: m.tags } : {}),
  ...(m.technical !== null ? { technical: m.technical } : {}),
  ...(m.energy !== null ? { energy: m.energy } : {}),
  ...(m.recordedAt ? { recorded: m.recordedAt.slice(0, 10) } : {}),
  status: m.status,
});

const listSpyglassFolders: Executor = async (args) => {
  const parentPath = optStr(args, "parentPath");
  const folders = await spyglassFolderChildren(parentPath);
  const offline = folders.filter((f) => !f.online).length;
  return {
    summary: `Listed ${folders.length} Spyglass folder(s) ${parentPath ? `in ${parentPath}` : "(the watched roots)"}${offline ? `, ${offline} offline` : ""}.`,
    result: { folders: folders.map(folderForModel) },
  };
};

const describeSpyglassFolder: Executor = async (args) => {
  const folders = optStrArray(args, "folders") ?? [];
  const offset = Math.max(0, Math.round(optNum(args, "offset") ?? 0));
  const limit = Math.min(MAX_DESCRIBE_LIMIT, Math.max(1, Math.round(optNum(args, "limit") ?? DEFAULT_DESCRIBE_LIMIT)));
  const page = await browseSpyglass(folders, offset, limit);
  const { summary } = page;
  const next = offset + page.shots.length;
  return {
    summary: `Read ${page.shots.length} of ${summary.shotCount} shot(s) in ${scopeLabel(folders)} from Spyglass.`,
    result: {
      summary: {
        clips: summary.clipCount,
        shots: summary.shotCount,
        shotsWithQualityScore: summary.technicalCount,
        shotsWithEnergyScore: summary.energyCount,
        ...(summary.dateRange ? { recorded: summary.dateRange } : {}),
        topTags: summary.topTags.slice(0, 20),
      },
      shots: page.shots.map(shotForModel),
      ...(next < summary.shotCount ? { nextOffset: next } : {}),
    },
  };
};

const findBroll: Executor = async (args) => {
  const query = optStr(args, "query")?.trim();
  if (!query) throw new Error("query must describe the shot to find");
  // Clamped rather than refused: an out-of-range topK is easy to fix here.
  const topK = Math.min(50, Math.max(1, Math.round(optNum(args, "topK") ?? 8)));
  const named = optStrArray(args, "spyglassFolders");
  const ticked = useLibraryStore.getState().scopes;
  const scopes = named ?? ticked;
  const { matches, warnings } = await searchSpyglass(query, scopes, topK);
  showAgentResults(query, matches);
  const unusable = matches.filter((m) => m.status !== "ok").length;
  const where = named ? scopeLabel(scopes) : `${scopeLabel(scopes)} (the B-roll Library's ${ticked.length ? "ticked folders" : "scope"})`;
  return {
    summary: `Found ${matches.length} B-roll match(es) for "${query}" in ${where}${unusable ? ` (${unusable} offline or changed, so not usable now)` : ""}.`,
    result: { matches: matches.map(matchForModel), ...(warnings.length ? { warnings } : {}) },
  };
};

export const SPYGLASS_EXECUTORS: Record<string, Executor> = {
  find_broll: findBroll,
  list_spyglass_folders: listSpyglassFolders,
  describe_spyglass_folder: describeSpyglassFolder,
};

export const SPYGLASS_TOOLS: ToolDeclaration[] = [
  {
    name: "find_broll",
    description:
      'Searches the user\'s B-roll archive (Spyglass\'s index, read only) for shots matching a description, ranked by Spyglass\'s own hybrid of visual similarity, caption, tags and transcript. Without spyglassFolders it searches the folders the user ticked in the B-roll Library (the whole archive when none are ticked); give spyglassFolders (paths from list_spyglass_folders; an empty array for the whole archive) to search elsewhere. Each match has its file path, the shot\'s start/end seconds in the file, a caption (Spyglass\'s vision model describing the shot), tags, technical quality and energy (0-100, when measured) and a status: only use status "ok"; "offline" means its drive isn\'t attached, "changed" that the file changed since indexing. The matches also appear in the user\'s B-roll Library. To use one, add_clips its path with sourceIn/sourceOut = the match\'s start/end. If nothing fits, try other words or a wider scope once, then tell the user rather than retrying.',
    parameters: {
      type: "OBJECT",
      properties: {
        query: { type: "STRING", description: "What the shot shows, in plain words." },
        spyglassFolders: { type: "ARRAY", items: { type: "STRING" }, description: "Optional. Spyglass folder paths from list_spyglass_folders; omit to use the Library's ticked folders." },
        topK: { type: "NUMBER", description: "1 to 50. Default 8." },
      },
      required: ["query"],
    },
  },
  {
    name: "list_spyglass_folders",
    description:
      "Lists folders of the footage archive Spyglass has indexed (read only). Without parentPath it returns Spyglass's watched roots (e.g. school years); with parentPath, the folders directly inside it. Each has its shot count, whether it has subfolders, whether its drive is attached (online), its most common tags and its recording date range. Use this to find where footage is instead of guessing folder names; pass the paths to find_broll's spyglassFolders or to describe_spyglass_folder.",
    parameters: { type: "OBJECT", properties: { parentPath: { type: "STRING", description: "A path list_spyglass_folders returned. Omit for the watched roots." } } },
  },
  {
    name: "describe_spyglass_folder",
    description:
      "Shows what is in Spyglass folders (read only), without a search: a summary (clip and shot counts, recording dates, top tags) and a page of shots in file order, each with its file path, in/out seconds, caption, tags, technical quality and energy scores when measured, recording date, and what is said during the shot when Spyglass transcribed the clip. Use it to answer what footage exists; use find_broll to rank shots against a description. Page with offset/nextOffset. No folders means the whole archive.",
    parameters: {
      type: "OBJECT",
      properties: {
        folders: { type: "ARRAY", items: { type: "STRING" }, description: "Paths from list_spyglass_folders. Omit or empty for the whole archive." },
        offset: { type: "NUMBER", description: "Shots to skip. Default 0." },
        limit: { type: "NUMBER", description: "Shots to return, 1 to 200. Default 80." },
      },
    },
  },
];

/** The ground rule the system prompt gains (VibeCut's BROLL_SCOPE_INSTRUCTION, adapted). */
export const BROLL_SCOPE_INSTRUCTION = `- B-roll: find_broll searches the user's footage archive (Spyglass's index). With no spyglassFolders it
  searches the folders the user ticked in the B-roll Library (the whole archive when none are ticked);
  list_spyglass_folders and describe_spyglass_folder show what's there. Its matches also show in the
  Library, where the user can pool, preview, import, place or drag them. Place one yourself with
  add_clips (path, sourceIn/sourceOut = the match's start/end); B-roll usually goes on a free video track
  with picture only (sound false). Only use matches whose status is "ok".`;
