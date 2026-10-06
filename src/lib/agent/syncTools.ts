/**
 * Syncing a camera with a separately recorded sound file (PLAN.md, "Phase 6c"), ported from VibeCut's
 * hostSync.ts on its waveform engine (src-tauri/src/audiosync.rs, verbatim) and its pure sync math
 * (src/vibecut/lib/sync.ts):
 * - sync_clips: camera and recorder clips already on the timeline and linked are matched by waveform,
 *   and the sound slipped into sync (VibeCut's sync_clips).
 * - slip_into_sync: puts sound back in sync with offsets already known (VibeCut's slip_into_sync).
 * - sync_and_place (new here): camera files and recorder files, matched by waveform, each camera placed
 *   with the stretch of its recording under it, linked, and the camera's own scratch sound switched off,
 *   as VibeCut lays out a synced clip (V1 camera, A1 recording, A2 camera sound off).
 * Convention throughout (A-Sync's and VibeCut's): camera time = recorder time + offset. Offsets are kept
 * for the connection, and A-Sync's own (`<video>.sync-offsets.json`, read by transcript.rs) are used
 * when there's no fresher one. Every change goes through the edit path: backed up, logged, revertible.
 */
import { invoke } from "@tauri-apps/api/core";
import { nleCall } from "../ipc";
import { jobId } from "../jobs";
import { useConnectionStore } from "../../store/useConnectionStore";
import type { NleHost } from "../../types/nle";
import type { HostClip, HostTimeline } from "../../types/timeline";
import { recorderRange } from "../../vibecut/lib/sync";
import { bool, clock, type Executor, strArray, type ToolOutcome } from "./args";
import { refuseWhileDrafting } from "./draft";
import { count, edit, HOST_SHORT, TIMELINE_NOUN, type EditContext } from "./edits";
import { addClips, editExecutors } from "./editTools";
import { poolClipId } from "./projectTools";
import { linkGroups } from "./snapshot";
import type { ToolContext, ToolDeclaration } from "./tools";

/** One camera file against one recording (audiosync.rs `SyncMatch`). */
export interface SyncMatch {
  camera: string;
  recorder: string;
  offset: number;
  score: number;
  confidence: number;
  matched: boolean;
  refined: boolean;
  driftSeconds?: number;
  overlapSeconds: number;
}

export interface SyncReport {
  matches: SyncMatch[];
  errors: { path: string; message: string }[];
}

interface SuiteSync {
  method: string;
  tracks: { path: string; offsetSeconds: number; enabled: boolean }[];
}

const round3 = (n: number) => Math.round(n * 1000) / 1000;
const fileName = (path: string) => path.split(/[\\/]/).pop() || path;
const pairKey = (camera: string, recorder: string) => `${camera}|${recorder}`;
/** A slip smaller than this is already in sync (half a frame at 25 fps). */
const IN_SYNC_SECONDS = 0.02;

export const syncAudio = (cameras: string[], recorders: string[]) => invoke<SyncReport>("sync_audio", { jobId: jobId(), cameras, recorders });
export const mediaDurations = (paths: string[]) => invoke<(number | null)[]>("media_durations", { paths });

/** The best match for each camera: the recording it matched most surely. */
export function bestMatches(report: SyncReport): Map<string, SyncMatch> {
  const best = new Map<string, SyncMatch>();
  for (const m of report.matches) {
    if (!m.matched) continue;
    const known = best.get(m.camera);
    if (!known || m.confidence > known.confidence) best.set(m.camera, m);
  }
  return best;
}

/**
 * The source in point that puts `sound` in sync with `picture` without moving it (VibeCut's slipIntoSync
 * on host clips): `sound.start - (picture.start - picture.sourceIn) - offset`. An error when either
 * changes speed or the recording doesn't reach that far.
 */
export function slipFor(picture: HostClip, sound: HostClip, offset: number, soundDuration: number): { sourceIn: number } | { error: string } {
  if ((picture.speed ?? 1) !== 1 || (sound.speed ?? 1) !== 1) return { error: "can't slip into sync with a speed change" };
  const sourceIn = sound.start - (picture.start - (picture.sourceIn ?? 0)) - offset;
  if (sourceIn < -1e-3 || sourceIn + (sound.end - sound.start) > soundDuration + 1e-3) return { error: "the recording doesn't cover this stretch in sync; trim the clip first" };
  return { sourceIn: Math.max(0, sourceIn) };
}

/** One key per recording: Premiere splits a stereo file into a clip per channel, slipped together. */
const recordingKey = (c: HostClip) => `${c.filePath}|${round3(c.start)}|${round3(c.end)}|${round3(c.sourceIn ?? 0)}`;

interface Pair {
  picture: HostClip;
  sounds: HostClip[];
}

/**
 * Each named clip's picture and its linked sound from another file (a separate recording), and with
 * `ownSound` also the picture's own sound (its file's, slipped back to offset 0 as VibeCut's slip_into_sync).
 */
export function pairsToSync(view: HostTimeline, ids: string[], ownSound = false): Pair[] {
  const groups = linkGroups(view);
  const placed = view.tracks.flatMap((t) => t.clips.map((c) => ({ clip: c, type: t.type })));
  const byId = new Map(placed.map((p) => [p.clip.id, p]));
  const pairs = new Map<string, Pair>();
  for (const id of ids) {
    const named = byId.get(id);
    if (!named) throw new Error(`There's no clip ${id} on the connected timeline`);
    const group = groups.get(id);
    const members = group ? placed.filter((p) => groups.get(p.clip.id) === group) : [named];
    const picture = members.find((p) => p.type === "video" && p.clip.filePath)?.clip;
    if (!picture) throw new Error(`"${named.clip.name}" isn't linked to a picture clip with a file; link the camera and its recording first (link_clips)`);
    const sounds = members.filter((p) => p.type === "audio" && p.clip.filePath && (ownSound || p.clip.filePath !== picture.filePath)).map((p) => p.clip);
    if (!sounds.length) {
      const own = members.some((p) => p.type === "audio" && p.clip.filePath === picture.filePath);
      throw new Error(`"${picture.name}" has no linked sound ${ownSound ? "" : "from another file "}to sync${own && !ownSound ? "; its own sound needs only slip_into_sync" : ""}`);
    }
    pairs.set(picture.id, { picture, sounds: [...(pairs.get(picture.id)?.sounds ?? []), ...sounds] });
  }
  return [...pairs.values()];
}

/** The offset known for a camera and a recording: found this connection, else A-Sync's beside the video. */
async function knownOffset(host: NleHost, camera: string, recorder: string): Promise<number | undefined> {
  if (camera === recorder) return 0;
  const found = useConnectionStore.getState().connections[host].syncOffsets[pairKey(camera, recorder)];
  if (found !== undefined) return found;
  const suite = await invoke<SuiteSync | null>("read_suite_sync", { videoPath: camera }).catch(() => null);
  return suite?.tracks.find((t) => t.path === recorder && t.enabled !== false)?.offsetSeconds;
}

export function syncExecutors(context: ToolContext): Record<string, Executor> {
  const { host } = context;
  const noun = TIMELINE_NOUN[host];
  const editor = HOST_SHORT[host];

  const editContext = (): EditContext => {
    refuseWhileDrafting(host, "change the timeline");
    if (!context.timeline) throw new Error(`No ${noun} is open in ${editor}. Ask the user to open one, or create_timeline.`);
    return { host, timeline: context.timeline, step: context.step, stepText: context.stepText };
  };
  const view = () => nleCall<HostTimeline>(host, "read_timeline", { timeline: editContext().timeline });

  /** A file named by a clip on the timeline, a project clip ("p3") or its own path. */
  const pathOf = async (ref: string, timeline: HostTimeline | null): Promise<string> => {
    if (ref.startsWith("/")) return ref;
    const onTimeline = timeline?.tracks.flatMap((t) => t.clips).find((c) => c.id === ref)?.filePath;
    if (onTimeline) return onTimeline;
    const pool = useConnectionStore.getState().connections[host].pool;
    const clip = pool?.clips.find((c) => c.id === poolClipId(host, ref));
    if (clip?.filePath) return clip.filePath;
    throw new Error(`"${ref}" isn't a clip on the ${noun}, a project clip or a file path`);
  };

  /** Slips each pair's sound into sync with the offsets given; returns what happened. */
  const slipPairs = async (pairs: Pair[], offsets: Map<string, number>) => {
    const ctx = editContext();
    const slip = editExecutors(ctx).slip_clip;
    const durations = new Map<string, number>();
    const files = [...new Set(pairs.flatMap((p) => p.sounds.map((s) => s.filePath!)))];
    (await mediaDurations(files)).forEach((d, i) => d && durations.set(files[i], d));
    const slipped: { clipId: string; name: string; seconds: number }[] = [];
    const problems: string[] = [];
    const done = new Set<string>();
    for (const { picture, sounds } of pairs) {
      for (const sound of sounds) {
        if (done.has(recordingKey(sound))) continue;
        done.add(recordingKey(sound));
        const offset = offsets.get(pairKey(picture.filePath!, sound.filePath!));
        if (offset === undefined) {
          problems.push(`"${sound.name}": no sync offset known with "${picture.name}"`);
          continue;
        }
        const target = slipFor(picture, sound, offset, durations.get(sound.filePath!) ?? Infinity);
        if ("error" in target) {
          problems.push(`"${sound.name}": ${target.error}`);
          continue;
        }
        const delta = target.sourceIn - (sound.sourceIn ?? 0);
        if (Math.abs(delta) < IN_SYNC_SECONDS) continue;
        const outcome = await slip({ clipId: sound.id, delta: round3(delta), withLinked: false });
        const refused = (outcome.result as { refused?: { reason: string }[] } | undefined)?.refused;
        if (refused?.length) problems.push(`"${sound.name}": ${refused.map((r) => r.reason).join("; ")}`);
        else slipped.push({ clipId: sound.id, name: sound.name, seconds: round3(delta) });
      }
    }
    return { slipped, problems };
  };

  return {
    sync_clips: async (args) => {
      const timeline = await view();
      const pairs = pairsToSync(timeline, strArray(args, "clipIds"));
      const cameras = [...new Set(pairs.map((p) => p.picture.filePath!))];
      const recorders = [...new Set(pairs.flatMap((p) => p.sounds.map((s) => s.filePath!)))];
      const report = await syncAudio(cameras, recorders);
      const found: Record<string, number> = {};
      const offsets: { picture: string; sound: string; offsetSeconds: number; confidence: number }[] = [];
      const unmatched: string[] = [];
      for (const { picture, sounds } of pairs) {
        for (const recorder of new Set(sounds.map((s) => s.filePath!))) {
          const m = report.matches.find((x) => x.camera === picture.filePath && x.recorder === recorder);
          if (m?.matched) {
            found[pairKey(m.camera, m.recorder)] = m.offset;
            offsets.push({ picture: fileName(m.camera), sound: fileName(m.recorder), offsetSeconds: round3(m.offset), confidence: round3(m.confidence) });
          } else unmatched.push(`${fileName(picture.filePath!)} + ${fileName(recorder)}`);
        }
      }
      useConnectionStore.getState().addSyncOffsets(host, found);
      const slipRun = bool(args, "slip", true) && offsets.length ? await slipPairs(pairs, new Map(Object.entries(found))) : null;
      return {
        summary: `Matched ${offsets.length} picture/sound pair(s) by waveform${unmatched.length ? `; ${unmatched.length} didn't match` : ""}${slipRun ? `; slipped ${slipRun.slipped.length} sound clip(s) into sync` : ""}`,
        result: { offsets, unmatched, errors: report.errors, ...(slipRun ? { slipped: slipRun.slipped, problems: slipRun.problems } : {}) },
      };
    },

    slip_into_sync: async (args) => {
      const timeline = await view();
      const pairs = pairsToSync(timeline, strArray(args, "clipIds"), true);
      const offsets = new Map<string, number>();
      for (const { picture, sounds } of pairs) {
        for (const sound of sounds) {
          const offset = await knownOffset(host, picture.filePath!, sound.filePath!);
          if (offset !== undefined) offsets.set(pairKey(picture.filePath!, sound.filePath!), offset);
        }
      }
      const { slipped, problems } = await slipPairs(pairs, offsets);
      return {
        summary: slipped.length ? `Slipped ${count(slipped.length, "sound clip")} into sync` : "Nothing needed slipping",
        result: { slipped, ...(problems.length ? { problems, note: "sync_clips finds offsets that aren't known yet" } : {}) },
      };
    },

    sync_and_place: async (args) => {
      const ctx = editContext();
      const timeline = await view();
      const cameras = [...new Set(await Promise.all(strArray(args, "cameras").map((r) => pathOf(r, timeline))))];
      const recorders = [...new Set(await Promise.all(strArray(args, "recorders").map((r) => pathOf(r, timeline))))];
      if (!cameras.length || !recorders.length) throw new Error("Give at least one camera and one recording");
      const report = await syncAudio(cameras, recorders);
      const best = bestMatches(report);
      const files = [...cameras, ...recorders];
      const lengths = new Map<string, number>();
      (await mediaDurations(files)).forEach((d, i) => d && lengths.set(files[i], d));
      let at = typeof args.at === "number" && args.at >= 0 ? args.at : timeline.duration;
      const placed: { camera: string; recorder: string; offsetSeconds: number; at: number; end: number; clipIds: string[] }[] = [];
      const skipped: string[] = [];
      for (const camera of cameras) {
        const match = best.get(camera);
        const cameraLength = lengths.get(camera);
        if (!match) {
          const why = report.errors.find((e) => e.path === camera)?.message ?? "its sound matched none of the recordings";
          skipped.push(`${fileName(camera)}: ${why}`);
          continue;
        }
        const recorderLength = lengths.get(match.recorder);
        if (!cameraLength || !recorderLength) {
          skipped.push(`${fileName(camera)}: couldn't read the length of ${fileName(cameraLength ? match.recorder : camera)}`);
          continue;
        }
        const range = recorderRange(0, cameraLength, match.offset, recorderLength);
        if (!range) {
          skipped.push(`${fileName(camera)}: ${fileName(match.recorder)} doesn't cover it`);
          continue;
        }
        // The camera (picture and its own sound), then the stretch of the recording under it.
        const added = await addClips(ctx, "sync_and_place", [
          { path: camera, sourceIn: 0, sourceOut: round3(cameraLength), at: round3(at) },
          { path: match.recorder, sourceIn: round3(range.sourceIn), sourceOut: round3(range.sourceOut), at: round3(at + range.startDelta), picture: false },
        ]);
        const changes = (added.result as { changes?: { itemIds?: string[] }[] }).changes ?? [];
        const [cameraIds = [], recorderIds = []] = changes.map((c) => c.itemIds ?? []);
        const now = await view();
        const audio = new Set(now.tracks.filter((t) => t.type === "audio").flatMap((t) => t.clips.map((c) => c.id)));
        const scratch = cameraIds.filter((id) => audio.has(id));
        // The camera's own sound stays, switched off, under the recording (VibeCut's layout).
        if (scratch.length) await edit(ctx, "sync_and_place", "set_clips_enabled", { itemIds: scratch, enabled: false }, () => "Switched the camera's own sound off");
        const all = [...cameraIds, ...recorderIds];
        if (all.length > 1) await edit(ctx, "sync_and_place", "set_links", { itemIds: all, action: "link" }, () => "Linked the camera and its recording");
        useConnectionStore.getState().addSyncOffsets(host, { [pairKey(camera, match.recorder)]: match.offset });
        placed.push({ camera: fileName(camera), recorder: fileName(match.recorder), offsetSeconds: round3(match.offset), at: round3(at), end: round3(at + cameraLength), clipIds: all });
        at += cameraLength;
      }
      if (!placed.length) throw new Error(`Nothing was placed: ${skipped.join("; ")}`);
      const drift = report.matches.filter((m) => m.matched && Math.abs(m.driftSeconds ?? 0) > 0.02);
      return {
        summary: `Placed ${count(placed.length, "camera clip")} on "${ctx.timeline}" in sync with their recordings (${placed.map((p) => `${p.camera} + ${p.recorder} at ${clock(p.at)}`).join(", ")})${skipped.length ? `; skipped ${skipped.length}` : ""}`,
        result: {
          placed,
          ...(skipped.length ? { skipped } : {}),
          ...(drift.length ? { drift: drift.map((m) => ({ camera: fileName(m.camera), recorder: fileName(m.recorder), seconds: m.driftSeconds })), driftNote: "These drift apart over the clip (different clocks); sync holds at the start, not exactly at the end." } : {}),
        },
      } satisfies ToolOutcome;
    },

    link_clips: async (args) => {
      const ids = [...new Set(strArray(args, "clipIds"))];
      if (ids.length < 2) throw new Error("clipIds must list at least two clips");
      return edit(editContext(), "link_clips", "set_links", { itemIds: ids, action: "link" }, () => `Linked ${count(ids.length, "clip")}: they now move, trim and split together`);
    },

    unlink_clips: async (args) => {
      const ids = [...new Set(strArray(args, "clipIds"))];
      if (!ids.length) throw new Error("clipIds must list at least one clip");
      return edit(editContext(), "unlink_clips", "set_links", { itemIds: ids, action: "unlink" }, () => `Unlinked ${count(ids.length, "clip")} from their groups`);
    },
  };
}

export function syncToolDeclarations(host: NleHost): ToolDeclaration[] {
  const noun = TIMELINE_NOUN[host];
  return [
    {
      name: "sync_and_place",
      description: `For a camera filmed with a separate sound recorder (lav, Zoom, mixer): matches each camera file to a recording by waveform, then places each camera on the connected ${noun} with the stretch of its recording under it, linked, and the camera's own scratch sound kept but switched off. Cameras go one after another from \`at\` (default: the ${noun}'s end). Give cameras and recorders as project clips ("p3"), clips on the ${noun}, or file paths. Each step is a direct edit (backed up, revertible). A camera whose sound matches no recording is skipped and named. For a new sequence of synced interviews, create_timeline first.`,
      parameters: {
        type: "OBJECT",
        properties: {
          cameras: { type: "ARRAY", items: { type: "STRING" }, description: "Camera clips or files, in the order to place them." },
          recorders: { type: "ARRAY", items: { type: "STRING" }, description: "The separate sound recordings (one long roll can serve several cameras)." },
          at: { type: "NUMBER", description: `Seconds on the ${noun} to place the first camera. Optional.` },
        },
        required: ["cameras", "recorders"],
      },
    },
    {
      name: "sync_clips",
      description: `For picture and sound clips already on the ${noun} and linked, where the sound is a separate recording: finds the sync offset by matching waveforms, then (unless slip is false) slips the sound into sync with its picture, leaving the picture where it is. Give the picture or sound clip ids. Link them first (link_clips) if they aren't.`,
      parameters: { type: "OBJECT", properties: { clipIds: { type: "ARRAY", items: { type: "STRING" } }, slip: { type: "BOOLEAN", description: "Optional, default true." } }, required: ["clipIds"] },
    },
    {
      name: "slip_into_sync",
      description: `Slips linked sound clips back into sync with their picture (${host === "premiere" ? "Premiere's Slip into Sync" : "as Premiere's Slip into Sync does"}): the picture's own sound to where it was recorded, and a separate recording by the offset already known (found by sync_clips or sync_and_place this session, or saved by A-Sync next to the video). The picture stays where it is.`,
      parameters: { type: "OBJECT", properties: { clipIds: { type: "ARRAY", items: { type: "STRING" } } }, required: ["clipIds"] },
    },
    {
      name: "link_clips",
      description: `Links clips of the connected ${noun} (and the groups they're in) so they move, trim and split together. Revertible.`,
      parameters: { type: "OBJECT", properties: { clipIds: { type: "ARRAY", items: { type: "STRING" } } }, required: ["clipIds"] },
    },
    {
      name: "unlink_clips",
      description: "Takes clips out of their link groups (the rest of each group stays linked). Revertible.",
      parameters: { type: "OBJECT", properties: { clipIds: { type: "ARRAY", items: { type: "STRING" } } }, required: ["clipIds"] },
    },
  ];
}

export function syncInstruction(host: NleHost): string {
  const noun = TIMELINE_NOUN[host];
  return `- Sound recorded separately (a lav, Zoom or mixer with the camera's own scratch sound): sync_and_place
  matches each camera file to its recording by waveform and places them linked and in sync on the
  ${noun} (create_timeline first for a new one). For clips already on the ${noun}, link_clips then
  sync_clips. Use the recording's sound for the edit: the camera's own sound is switched off under it.
  If a camera matches no recording, say so; don't guess an offset.`;
}
