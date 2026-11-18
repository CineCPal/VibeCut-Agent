/**
 * A bin of the connected editor's project as files on disk (PLAN.md, "Bin analysis & visual clip
 * selection"): Premiere's Project panel bins and Resolve's Media Pool folders, read with `read_media_pool`
 * (up to 2,000 clips; `search_media_pool` stops at 200). The B-roll Analyzer and the local vision workers
 * work on files, so a clip with no file (a sequence, generated media, an offline clip) is left out and named.
 */
import { nleCall } from "./ipc";
import type { NleHost } from "../types/nle";
import type { HostPoolClip } from "../types/pool";

/** What a bin read returns (premiere_pool / resolve_pool `read_media_pool`). */
interface PoolRead {
  bins: { path: string; clips: number }[];
  clips: HostPoolClip[];
  truncated?: boolean;
}

export interface BinClip {
  id: string;
  name: string;
  filePath: string;
  duration?: number;
}

export interface BinFiles {
  /** The bin's full path, "Project/Footage/Drone". */
  binPath: string;
  clips: BinClip[];
  /** Clips left out, with why. */
  skipped: { name: string; reason: string }[];
  /** The project had more clips than one read lists, so the bin may be missing some. */
  truncated: boolean;
}

/** Picture clips: what the Analyzer and the vision model can look at. */
const PICTURE = new Set(["video+audio", "video", "movie"]);
const normal = (s: string) => s.toLowerCase().replace(/\s+/g, "");
/** Premiere leaves a clip's type blank when the Project panel hasn't read its media yet: judge it by name. */
const VIDEO_FILE = /\.(mov|mp4|m4v|mxf|avi|mkv|mts|m2ts|r3d|braw|crm|webm|mpg|mpeg|3gp)$/i;
const isPicture = (clip: HostPoolClip) => PICTURE.has(normal(clip.type)) || (!clip.type && VIDEO_FILE.test(clip.filePath ?? ""));

export const binLeaf = (binPath: string) => binPath.split("/").filter(Boolean).pop() ?? binPath;

/** The one bin `text` names: an exact path, else a bin whose name (last part) is it, else one whose path
 * ends with it, else one whose path contains it. Several at the same level is an error naming them. */
export function pickBin(paths: string[], text: string): string {
  const wanted = text.trim().replace(/^\/+|\/+$/g, "").toLowerCase();
  if (!wanted) throw new Error("bin must name a bin, e.g. \"Drone\" or \"Footage/Drone\"");
  const lower = paths.map((p) => p.toLowerCase());
  const tiers = [
    (p: string) => p === wanted,
    (p: string) => binLeaf(p) === wanted,
    (p: string) => p.endsWith(`/${wanted}`),
    (p: string) => p.includes(wanted),
  ];
  for (const test of tiers) {
    const found = paths.filter((_, i) => test(lower[i]));
    if (found.length === 1) return found[0];
    if (found.length > 1) {
      const shown = found.slice(0, 8).map((p) => `"${p}"`).join(", ");
      throw new Error(`"${text}" matches ${found.length} bins: ${shown}${found.length > 8 ? ", …" : ""}. Give more of the path.`);
    }
  }
  throw new Error(`There's no bin "${text}" in the project; list_media_pool lists them`);
}

/** The files of a bin's picture clips, its sub-bins' included (the order the editor lists them). */
export async function resolveBin(host: NleHost, bin: string, timeline?: string | null): Promise<BinFiles> {
  const read = await nleCall<PoolRead>(host, "read_media_pool", timeline ? { timeline } : {});
  const binPath = pickBin(
    read.bins.map((b) => b.path),
    bin,
  );
  const inside = (clip: HostPoolClip) => clip.bin === binPath || clip.bin.startsWith(`${binPath}/`);
  const clips: BinClip[] = [];
  const skipped: BinFiles["skipped"] = [];
  const seen = new Set<string>();
  for (const clip of read.clips.filter(inside)) {
    if (!isPicture(clip)) continue;
    if (!clip.filePath) skipped.push({ name: clip.name, reason: "no media file" });
    else if (clip.offline) skipped.push({ name: clip.name, reason: "offline" });
    else if (!clip.filePath.startsWith("/")) skipped.push({ name: clip.name, reason: "not a local file" });
    else if (!seen.has(clip.filePath)) {
      seen.add(clip.filePath);
      clips.push({ id: clip.id, name: clip.name, filePath: clip.filePath, ...(clip.duration ? { duration: clip.duration } : {}) });
    }
  }
  return { binPath, clips, skipped, truncated: Boolean(read.truncated) };
}

const dirOf = (path: string) => path.slice(0, Math.max(1, path.lastIndexOf("/")));

/** The files grouped by their folder, in first-seen order: the Analyzer scores one folder a run, with
 * `files` naming the bin's clips in it (broll/commands.py). */
export function groupByFolder(paths: string[]): { folder: string; files: string[] }[] {
  const groups = new Map<string, string[]>();
  for (const path of paths) {
    const folder = dirOf(path);
    const list = groups.get(folder);
    if (list) list.push(path);
    else groups.set(folder, [path]);
  }
  return [...groups].map(([folder, files]) => ({ folder, files }));
}
