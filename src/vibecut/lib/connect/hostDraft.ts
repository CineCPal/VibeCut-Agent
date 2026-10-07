import type { HostTimeline, HostTrack } from "../../types/connect";
import type { RemapPoint } from "../../types/timeline";
import type { RoughCutPlan } from "../sidecarResults";
import { MIN_CLIP_DURATION_SECONDS } from "../timeline";
import { buildRemap, planFromChanges, sliceClip, speedRange, type Timed } from "../timeRemap";

/**
 * VibeCut's editable copy of a connected Resolve timeline or Premiere sequence (PLAN.md, "Connect
 * page", phases 2 and 4b). The agent's cuts, rearrangements and B-roll change this draft, and
 * `send_to_resolve` / `send_to_premiere` build a new timeline from it (`rebuild` in
 * src-python/host-resolve and host-premiere). The connected timeline is never changed.
 *
 * Everything here is pure: a draft in, a new draft out. Times are seconds from the timeline's start,
 * snapped to its frames so repeated edits don't drift.
 */

export interface DraftClip {
  /** The Resolve clip it was cut from, so its grade can be copied onto the new one. */
  originId?: string;
  sourcePath: string;
  sourceName: string;
  start: number;
  end: number;
  sourceIn: number;
  sourceOut: number;
  /** Constant speed; 1 is normal. */
  speed: number;
  enabled: boolean;
  /** Level in dB (sound only); null for unity. */
  volumeDb: number | null;
  /** Picture and sound that move together share one. */
  linkGroup?: string;
  /** Sound only: the channels of its file it plays (Premiere's split stereo); all when absent. */
  channels?: number[];
  /** A speed ramp (PLAN.md, "Phase 8b"), as VibeCut's own clips have it: points from (0, sourceIn) to
   * (end - start, sourceOut), `t` in seconds from the clip's start. `speed` is then the average. The
   * rebuild sends it as the clip's time map. */
  timeRemap?: RemapPoint[];
}

/** A draft clip in the shape timeRemap.ts works on. */
const timed = (c: DraftClip): Timed => ({ sourceIn: c.sourceIn, sourceOut: c.sourceOut, duration: c.end - c.start, ...(c.timeRemap ? { timeRemap: c.timeRemap } : {}) });

export interface DraftTrack {
  type: "video" | "audio";
  clips: DraftClip[];
}

export interface DraftMarker {
  time: number;
  name: string;
  color: string;
  note: string;
  duration: number;
}

export interface HostDraft {
  /** The Resolve timeline it started from. */
  base: string;
  /** The name to give the new timeline (a Story Editor cut's own); otherwise "<base> (VibeCut n)". */
  name?: string;
  fps: number;
  duration: number;
  /** V1, V2 ... */
  video: DraftTrack[];
  /** A1, A2 ... */
  audio: DraftTrack[];
  markers: DraftMarker[];
  /** What the draft couldn't take from the original (transitions, titles, Fusion effects). */
  notCarried: string[];
  /** One line per change, for the agent, the page and the summary. */
  changes: string[];
}

export interface TimeRange {
  start: number;
  end: number;
}

const snap = (seconds: number, fps: number) => Math.round(seconds * fps) / fps;
const round3 = (seconds: number) => Math.round(seconds * 1000) / 1000;

/** Picture and sound Resolve links share a group: the lowest id among them. */
export function linkGroups(snapshot: HostTimeline): Map<string, string> {
  const parent = new Map<string, string>();
  const find = (id: string): string => {
    const p = parent.get(id) ?? id;
    if (p === id) return id;
    const root = find(p);
    parent.set(id, root);
    return root;
  };
  for (const track of snapshot.tracks) {
    for (const clip of track.clips) {
      for (const other of clip.linkedIds ?? []) {
        const [a, b] = [find(clip.id), find(other)];
        if (a !== b) parent.set(a > b ? a : b, a > b ? b : a);
      }
    }
  }
  const groups = new Map<string, string>();
  for (const track of snapshot.tracks) for (const clip of track.clips) if (clip.linkedIds?.length) groups.set(clip.id, find(clip.id));
  return groups;
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** A draft of the connected timeline as Resolve reported it. */
export function draftFromSnapshot(snapshot: HostTimeline): HostDraft {
  const groups = linkGroups(snapshot);
  let effects = 0;
  let noFile = 0;
  let fusion = 0;
  const convert = (track: HostTrack): DraftTrack => ({
    type: track.type === "audio" ? "audio" : "video",
    clips: track.clips.flatMap((c): DraftClip[] => {
      if (c.kind === "effect") {
        effects++;
        return [];
      }
      if (!c.filePath || c.sourceIn === undefined) {
        noFile++;
        return [];
      }
      if (c.fusion) fusion++;
      const speed = c.speed ?? 1;
      return [
        {
          originId: c.id,
          sourcePath: c.filePath,
          sourceName: c.name,
          start: c.start,
          end: c.end,
          sourceIn: c.sourceIn,
          sourceOut: c.sourceOut ?? c.sourceIn + (c.end - c.start) * speed,
          speed,
          enabled: c.enabled,
          volumeDb: track.type === "audio" && c.volumeDb !== undefined && c.volumeDb !== 0 ? c.volumeDb : null,
          ...(groups.has(c.id) ? { linkGroup: groups.get(c.id)! } : {}),
          ...(track.type === "audio" && c.channel ? { channels: [c.channel] } : {}),
        },
      ];
    }),
  });
  // Converted first: converting counts what can't be carried.
  const video = snapshot.tracks.filter((t) => t.type === "video").map(convert);
  const audio = snapshot.tracks.filter((t) => t.type === "audio").map(convert);
  const notCarried = [
    effects ? `${plural(effects, "transition")} or generator${effects === 1 ? "" : "s"}` : "",
    noFile ? `${plural(noFile, "clip")} with no source file (titles, compound clips)` : "",
    fusion ? `Fusion effects on ${plural(fusion, "clip")}` : "",
  ].filter(Boolean);
  return {
    base: snapshot.timeline,
    fps: snapshot.fps,
    duration: snapshot.duration,
    video,
    audio,
    markers: snapshot.markers.map(({ time, name, color, note, duration }) => ({ time, name, color, note, duration })),
    notCarried,
    changes: [],
  };
}

/** The part of `clip` between `from` and `to` (timeline seconds), its source points moved to match. */
function piece(clip: DraftClip, from: number, to: number): DraftClip {
  const a = Math.max(from, clip.start);
  const b = Math.min(to, clip.end);
  if (clip.timeRemap) {
    const cut = sliceClip(timed(clip), a - clip.start, b - clip.start);
    const { timeRemap: _old, ...rest } = clip;
    return {
      ...rest,
      start: a,
      end: b,
      sourceIn: round3(cut.sourceIn),
      sourceOut: round3(cut.sourceOut),
      speed: round3((cut.sourceOut - cut.sourceIn) / (b - a)),
      ...(cut.timeRemap ? { timeRemap: cut.timeRemap } : {}),
    };
  }
  return {
    ...clip,
    start: a,
    end: b,
    sourceIn: round3(clip.sourceIn + (a - clip.start) * clip.speed),
    sourceOut: round3(clip.sourceIn + (b - clip.start) * clip.speed),
  };
}

function checkRanges(ranges: TimeRange[], duration: number, what: string): TimeRange[] {
  if (ranges.length === 0) throw new Error(`${what} must not be empty`);
  return ranges.map((r, i) => {
    if (!(Number.isFinite(r.start) && Number.isFinite(r.end)) || r.end <= r.start) throw new Error(`${what}[${i}] must end after it starts`);
    if (r.start < 0 || r.start >= duration) throw new Error(`${what}[${i}] starts outside the timeline (0 to ${round3(duration)}s)`);
    return { start: r.start, end: Math.min(r.end, duration) };
  });
}

/**
 * The timeline made of `sections`, in that order, one after another: every track is cut at each
 * section's edges and moved along with it, and markers inside a section move with it. Anything not
 * in a section is left out.
 */
export function arrangeSections(draft: HostDraft, sections: TimeRange[], change?: string): HostDraft {
  const fps = draft.fps;
  const checked = checkRanges(sections, draft.duration, "sections").map((r) => ({ start: snap(r.start, fps), end: snap(r.end, fps) }));
  const rearrange = (track: DraftTrack): DraftTrack => {
    const clips: DraftClip[] = [];
    let cursor = 0;
    for (const section of checked) {
      for (const clip of track.clips) {
        if (clip.end <= section.start || clip.start >= section.end) continue;
        const cut = piece(clip, section.start, section.end);
        const shift = cursor - section.start;
        clips.push({ ...cut, start: snap(cut.start + shift, fps), end: snap(cut.end + shift, fps) });
      }
      cursor = snap(cursor + section.end - section.start, fps);
    }
    return { ...track, clips: clips.sort((a, b) => a.start - b.start) };
  };
  const markers: DraftMarker[] = [];
  let cursor = 0;
  for (const section of checked) {
    for (const m of draft.markers) if (m.time >= section.start && m.time < section.end) markers.push({ ...m, time: snap(m.time - section.start + cursor, fps) });
    cursor = snap(cursor + section.end - section.start, fps);
  }
  return {
    ...draft,
    duration: cursor,
    video: draft.video.map(rearrange),
    audio: draft.audio.map(rearrange),
    markers: markers.sort((a, b) => a.time - b.time),
    changes: [...draft.changes, change ?? `Rearranged into ${plural(checked.length, "section")} (${round3(cursor)}s)`],
  };
}

/** Merges overlapping ranges and returns what's left of the timeline between them. A piece shorter
 * than the shortest clip an edit can make goes too (as `cutRanges` does in VibeCut), so a range that
 * stops a few hundredths short of the end, or of the next range, leaves no flash frame. */
export function keptBetween(ranges: TimeRange[], duration: number): TimeRange[] {
  const sorted = checkRanges(ranges, duration, "ranges").sort((a, b) => a.start - b.start);
  const kept: TimeRange[] = [];
  const keep = (start: number, end: number) => {
    if (end - start >= MIN_CLIP_DURATION_SECONDS - 1e-9) kept.push({ start, end });
  };
  let cursor = 0;
  for (const r of sorted) {
    if (r.start > cursor) keep(cursor, r.start);
    cursor = Math.max(cursor, r.end);
  }
  if (cursor < duration) keep(cursor, duration);
  return kept;
}

/** Ripple-deletes `ranges` from every track, closing the gaps. */
export function removeRanges(draft: HostDraft, ranges: TimeRange[]): HostDraft {
  const kept = keptBetween(ranges, draft.duration);
  if (kept.length === 0) throw new Error("That would remove the whole timeline");
  const removed = round3(draft.duration - kept.reduce((s, r) => s + r.end - r.start, 0));
  return arrangeSections(draft, kept, `Removed ${plural(ranges.length, "range")} (${removed}s)`);
}

export interface PlaceOptions {
  sourcePath: string;
  sourceIn: number;
  sourceOut: number;
  /** Timeline seconds. */
  at: number;
  /** 1-based video track; default the lowest one above V1 that's free there, or a new one. */
  videoTrack?: number;
  /** Also place its sound, on a free audio track, at this level. */
  withSound?: boolean;
  volumeDb?: number;
}

const free = (track: DraftTrack, start: number, end: number) => track.clips.every((c) => c.end <= start || c.start >= end);
const fileName = (path: string) => path.split(/[\\/]/).pop() || path;

/** Places a clip from a file over the timeline (B-roll), without moving anything else. */
export function placeClip(draft: HostDraft, options: PlaceOptions): HostDraft {
  const fps = draft.fps;
  if (!options.sourcePath.startsWith("/")) throw new Error("The file must be an absolute path");
  if (!(options.sourceOut > options.sourceIn) || options.sourceIn < 0) throw new Error("sourceOut must be after sourceIn, and sourceIn at least 0");
  if (!(options.at >= 0)) throw new Error("at must be 0 or later");
  const start = snap(options.at, fps);
  const end = snap(options.at + options.sourceOut - options.sourceIn, fps);
  const video = draft.video.map((t) => ({ ...t, clips: [...t.clips] }));
  let index: number;
  if (options.videoTrack !== undefined) {
    index = options.videoTrack - 1;
    if (!Number.isInteger(options.videoTrack) || index < 0 || index > video.length) throw new Error(`There is no V${options.videoTrack}; use V1 to V${video.length + 1}`);
    if (index < video.length && !free(video[index], start, end)) throw new Error(`V${options.videoTrack} already has a clip between ${round3(start)}s and ${round3(end)}s`);
  } else {
    index = video.findIndex((t, i) => i > 0 && free(t, start, end));
    // Above V1 where possible, so the main picture stays underneath; V1 itself only on an empty timeline.
    if (index < 0) index = video.length;
  }
  if (index === video.length) video.push({ type: "video", clips: [] });
  const group = options.withSound ? `placed-${draft.changes.length}-${Math.round(start * fps)}` : undefined;
  const clip: DraftClip = {
    sourcePath: options.sourcePath,
    sourceName: fileName(options.sourcePath),
    start,
    end,
    sourceIn: round3(options.sourceIn),
    sourceOut: round3(options.sourceIn + (end - start)),
    speed: 1,
    enabled: true,
    volumeDb: null,
    ...(group ? { linkGroup: group } : {}),
  };
  video[index].clips = [...video[index].clips, clip].sort((a, b) => a.start - b.start);
  let audio = draft.audio;
  if (options.withSound) {
    audio = draft.audio.map((t) => ({ ...t, clips: [...t.clips] }));
    let a = audio.findIndex((t) => free(t, start, end));
    if (a < 0) {
      audio.push({ type: "audio", clips: [] });
      a = audio.length - 1;
    }
    audio[a].clips = [...audio[a].clips, { ...clip, volumeDb: options.volumeDb ?? null }].sort((x, y) => x.start - y.start);
  }
  return {
    ...draft,
    duration: Math.max(draft.duration, end),
    video,
    audio,
    changes: [...draft.changes, `Placed ${clip.sourceName} on V${index + 1} at ${round3(start)}s (${round3(end - start)}s${options.withSound ? ", with sound" : ""})`],
  };
}

/** Adds markers to the draft; they go onto the new timeline with it. */
export function addDraftMarkers(draft: HostDraft, markers: DraftMarker[]): HostDraft {
  const fps = draft.fps;
  const placed = markers.map((m) => ({ ...m, time: snap(m.time, fps) })).filter((m) => m.time >= 0 && m.time <= draft.duration);
  return {
    ...draft,
    markers: [...draft.markers, ...placed].sort((a, b) => a.time - b.time),
    changes: [...draft.changes, `Added ${plural(placed.length, "marker")}`],
  };
}

/** The `rebuild` request: tracks in rough-cut-studio's export shape, with each picture clip's
 * grade source. */
export function rebuildRequest(draft: HostDraft, nameArg?: string): Record<string, unknown> {
  const name = nameArg ?? draft.name;
  const frame = (seconds: number) => Math.round(seconds * draft.fps);
  const toClip = (c: DraftClip, video: boolean) => ({
    sourcePath: c.sourcePath,
    sourceName: c.sourceName,
    startTimeSeconds: c.start,
    sourceInSeconds: c.sourceIn,
    sourceOutSeconds: c.sourceOut,
    hasAudio: false,
    volume: !video && c.volumeDb !== null ? Math.pow(10, c.volumeDb / 20) : 1,
    ...(c.enabled ? {} : { enabled: false }),
    ...(!video && c.channels ? { audioChannels: c.channels } : {}),
    // Pieces of one linked group stay linked only to the pieces cut at the same moment.
    ...(c.linkGroup ? { linkGroup: `${c.linkGroup}@${frame(c.start)}` } : {}),
    ...(c.timeRemap
      ? { timeMap: c.timeRemap.map((p) => ({ t: p.t, s: p.s })) }
      : c.speed !== 1
        ? {
            timeMap: [
              { t: 0, s: c.sourceIn },
              { t: round3(c.end - c.start), s: c.sourceOut },
            ],
          }
        : {}),
  });
  // Bottom to top, as the builders take them: An ... A1 (they number audio top-down), then V1 ... Vn.
  const tracks = [
    ...[...draft.audio].reverse().map((t) => ({ type: "audio", clips: t.clips.map((c) => toClip(c, false)) })),
    ...draft.video.map((t) => ({ type: "video", clips: t.clips.map((c) => toClip(c, true)) })),
  ];
  // A ramped clip is built as several pieces, so its grade goes to every piece in its range.
  const grades = draft.video.flatMap((t, i) => t.clips.flatMap((c) => (c.originId ? [{ originId: c.originId, trackIndex: i + 1, start: c.start, end: c.end }] : [])));
  return { timeline: draft.base, ...(name ? { name } : {}), tracks, markers: draft.markers, grades };
}

/** The draft in the shape the Connect page draws (`HostTimelineView`). */
export function draftAsTimeline(draft: HostDraft, project: string): HostTimeline {
  const all = [...draft.video, ...draft.audio].flatMap((t) => t.clips);
  const ids = new Map(all.map((c, n) => [c, `draft-${n}`]));
  // Linked: the same group at the same place (a cut's pieces keep their group).
  const half = 0.5 / (draft.fps > 0 ? draft.fps : 25);
  const partners = (c: DraftClip) =>
    c.linkGroup
      ? all.filter((o) => o !== c && o.linkGroup === c.linkGroup && Math.abs(o.start - c.start) < half && Math.abs(o.end - c.end) < half).map((o) => ids.get(o)!)
      : [];
  const track = (t: DraftTrack, index: number): HostTrack => ({
    type: t.type,
    index: index + 1,
    name: "",
    enabled: null,
    clips: t.clips.map((c) => {
      const linked = partners(c);
      return {
        id: ids.get(c)!,
        name: c.sourceName,
        start: c.start,
        end: c.end,
        enabled: c.enabled,
        sourceIn: c.sourceIn,
        sourceOut: c.sourceOut,
        filePath: c.sourcePath,
        ...(c.timeRemap ? { ramp: speedRange(timed(c)) } : c.speed !== 1 ? { speed: c.speed } : {}),
        ...(c.volumeDb !== null ? { volumeDb: c.volumeDb } : {}),
        ...(linked.length ? { linkedIds: linked } : {}),
      };
    }),
  });
  return {
    project,
    timeline: `${draft.base} — draft`,
    fps: draft.fps,
    startTimecode: "",
    duration: draft.duration,
    isCurrent: false,
    tracks: [...draft.video.map(track), ...draft.audio.map(track)],
    markers: draft.markers.map((m, i) => ({ ...m, id: `draft-marker-${i}` })),
  };
}

/**
 * A draft holding a Story Editor cut (rough-cut-studio's `assemble`): the main cuts one after another
 * on V1 with their sound on A1, linked, and B-roll on V2, with its sound on A2 unless the plan made it
 * silent. `base` is the connected timeline, for its frame rate; nothing of it is kept.
 */
/** Where a sound-only recording's picture comes from: the camera file synced to it, and how far the
 * camera's source time runs ahead of the recording's (camera time = recording time + offset), with the
 * camera's source range in the synced timeline. */
export interface SyncedPicture {
  cameraPath: string;
  offset: number;
  cameraIn: number;
  cameraOut: number;
}

/** Files that are sound only, by extension: a cut from one has no picture of its own. */
const SOUND_ONLY = /\.(wav|wave|bwf|aif|aiff|aifc|mp3|m4a|aac|flac|caf|ogg|opus)$/i;
export const isSoundOnly = (path: string): boolean => SOUND_ONLY.test(path);

/**
 * Each separately recorded sound file in `view` that's linked to a camera clip (as sync_and_place and
 * a hand sync leave them), mapped to that camera's picture (PLAN.md, Phase 7e fix). Transcripts are
 * often made from the recorder, so the Story Editor's cuts name the WAV; the draft takes the picture
 * from the camera instead. Only speed-1 pairs count, and the first pair found for a file wins.
 */
export function syncedPictures(view: { tracks: { type: string; clips: { id: string; start: number; sourceIn?: number; sourceOut?: number; speed?: number; filePath?: string; linkedIds?: string[] }[] }[] }): Map<string, SyncedPicture> {
  const pictures = new Map<string, SyncedPicture>();
  const videoById = new Map(view.tracks.filter((t) => t.type === "video").flatMap((t) => t.clips.map((c) => [c.id, c] as const)));
  for (const track of view.tracks.filter((t) => t.type === "audio")) {
    for (const sound of track.clips) {
      const path = sound.filePath;
      if (!path || !isSoundOnly(path) || pictures.has(path) || sound.sourceIn === undefined || (sound.speed ?? 1) !== 1) continue;
      for (const id of sound.linkedIds ?? []) {
        const camera = videoById.get(id);
        if (!camera?.filePath || camera.filePath === path || camera.sourceIn === undefined || camera.sourceOut === undefined || (camera.speed ?? 1) !== 1) continue;
        const offset = camera.sourceIn - camera.start - (sound.sourceIn - sound.start);
        pictures.set(path, { cameraPath: camera.filePath, offset: round3(offset), cameraIn: camera.sourceIn, cameraOut: camera.sourceOut });
        break;
      }
    }
  }
  return pictures;
}

export function draftFromPlan(base: string, fps: number, plan: RoughCutPlan, pictures: Map<string, SyncedPicture> = new Map()): HostDraft {
  const main: DraftClip[] = [];
  const mainSound: DraftClip[] = [];
  const broll: DraftClip[] = [];
  const brollSound: DraftClip[] = [];
  const notes: string[] = [];
  let ducked = 0;
  let missing = 0;
  let soundOnly = 0;
  let fromCamera = 0;
  plan.segments.forEach((segment, i) => {
    if (!segment.mediaPath) {
      missing++;
      return;
    }
    const start = snap(segment.start, fps);
    const end = snap(segment.start + segment.sourceOut - segment.sourceIn, fps);
    const clip: DraftClip = {
      sourcePath: segment.mediaPath,
      sourceName: segment.name,
      start,
      end,
      sourceIn: round3(segment.sourceIn),
      sourceOut: round3(segment.sourceIn + (end - start)),
      speed: 1,
      enabled: true,
      volumeDb: null,
    };
    if (segment.track === "main") {
      const group = `story-${i}`;
      mainSound.push({ ...clip, linkGroup: group });
      if (!isSoundOnly(clip.sourcePath)) {
        main.push({ ...clip, linkGroup: group });
        return;
      }
      // A cut from a separately recorded sound file: the picture is the camera synced to it.
      const picture = pictures.get(clip.sourcePath);
      const cameraIn = picture ? round3(clip.sourceIn + picture.offset) : -1;
      const cameraOut = picture ? round3(clip.sourceOut + picture.offset) : -1;
      if (picture && cameraIn >= Math.max(0, picture.cameraIn - 0.05) && cameraOut <= picture.cameraOut + 0.05) {
        main.push({ ...clip, sourcePath: picture.cameraPath, sourceName: fileName(picture.cameraPath), sourceIn: cameraIn, sourceOut: cameraOut, linkGroup: group });
        fromCamera++;
      } else {
        soundOnly++;
      }
    } else {
      broll.push(clip);
      if (segment.audioMode !== "silent") brollSound.push(clip);
      if (segment.audioMode === "duck_main") ducked++;
    }
  });
  if (missing) notes.push(`${plural(missing, "cut")} had no source file and ${missing === 1 ? "was" : "were"} left out`);
  if (soundOnly) notes.push(`${plural(soundOnly, "cut")} from a sound recording with no synced camera ${soundOnly === 1 ? "has" : "have"} sound only (sync the camera first to get picture)`);
  if (ducked) notes.push(`the interview isn't lowered under ${plural(ducked, "B-roll clip")} the plan wanted ducked`);
  // B-roll that overlaps other B-roll goes up a track rather than over it.
  const brollTracks: DraftTrack[] = [];
  for (const clip of broll.sort((a, b) => a.start - b.start)) {
    let track = brollTracks.find((t) => free(t, clip.start, clip.end));
    if (!track) brollTracks.push((track = { type: "video", clips: [] }));
    track.clips.push(clip);
  }
  const duration = Math.max(0, ...[...main, ...mainSound, ...broll].map((c) => c.end));
  return {
    base,
    name: plan.sequenceName,
    fps,
    duration,
    video: [{ type: "video", clips: main }, ...brollTracks],
    audio: [{ type: "audio", clips: mainSound }, ...(brollSound.length ? [{ type: "audio" as const, clips: brollSound }] : [])],
    markers: [],
    notCarried: notes,
    changes: [
      `Story Editor: "${plan.sequenceName}", ${plural(mainSound.length, "cut")}${broll.length ? ` and ${plural(broll.length, "B-roll clip")}` : ""} (${round3(duration)}s)${fromCamera ? `, picture from the synced camera for ${plural(fromCamera, "cut")}` : ""}`,
    ],
  };
}

export interface ReshapeOptions {
  /** New source in point (seconds into the source): trims the start. */
  sourceIn?: number;
  /** New source out point: trims the end. */
  sourceOut?: number;
  /** Seconds to move the source range by; the clip stays where it is. */
  slip?: number;
  /** New start on the timeline: moves the clip. */
  start?: number;
  /** With `start`: the 1-based track to move to (its own kind). */
  track?: number;
  /** A trim that moves everything after the clip, on every track, to close or open the gap. */
  ripple?: boolean;
  /** False (with `slip` only): the sound alone, with the other channels of its recording, leaving its
   * linked picture where it is — slipping it back into sync. */
  withLinked?: boolean;
}

/** The track and position of a draft clip by the id the page and the agent see ("draft-3"; the same
 * numbering as `draftAsTimeline`). */
export function draftClipAt(draft: HostDraft, id: string): { kind: "video" | "audio"; track: number; index: number } {
  let n = 0;
  for (const kind of ["video", "audio"] as const) {
    for (const [t, track] of draft[kind].entries()) {
      for (const index of track.clips.keys()) if (`draft-${n++}` === id) return { kind, track: t, index };
    }
  }
  throw new Error(`There is no draft clip ${id}; the draft's clips are listed in the snapshot`);
}

/**
 * Trims, slips or moves one clip of the draft, with the clips linked to it (same link group and the
 * same place). A ripple trim moves every clip that starts at or after the trimmed edge, on every
 * track, by the same amount, and the markers with them; a clip on another track that spans the edge
 * stays, so a ripple that would make it overlap is refused. Without ripple, nothing else moves, and
 * the new range must be free.
 */
export function reshapeDraftClip(draft: HostDraft, id: string, options: ReshapeOptions): HostDraft {
  const fps = draft.fps;
  const kinds = (["sourceIn", "sourceOut", "slip", "start"] as const).filter((k) => options[k] !== undefined);
  if (kinds.length === 0 || (kinds.length > 1 && !(kinds.length === 2 && kinds.includes("sourceIn") && kinds.includes("sourceOut")))) {
    throw new Error("Give sourceIn and/or sourceOut (trim), slip, or start (move): one kind of change at a time");
  }
  if (options.ripple && !(options.sourceIn !== undefined || options.sourceOut !== undefined)) throw new Error("ripple goes with a trim");
  if (options.track !== undefined && options.start === undefined) throw new Error("track goes with start (a move)");
  const alone = options.withLinked === false;
  if (alone && (kinds.length !== 1 || kinds[0] !== "slip")) throw new Error("withLinked false goes with slip only; a trim or move keeps linked clips together");
  const at = draftClipAt(draft, id);
  const main = draft[at.kind][at.track].clips[at.index];
  if (main.timeRemap && options.start === undefined) throw new Error(`"${main.sourceName}" has a speed ramp; trim or slip it after clear_clip_speed, or cut it with remove_time_ranges`);
  const tracks = { video: draft.video.map((t) => ({ ...t, clips: [...t.clips] })), audio: draft.audio.map((t) => ({ ...t, clips: [...t.clips] })) };
  // The clip and its partners: same link group, same place. Alone, only the other channels of its
  // recording (same file, place and source point) go with it.
  const samePlace = (c: DraftClip) => Math.abs(c.start - main.start) < 0.5 / fps && Math.abs(c.end - main.end) < 0.5 / fps;
  const partner = (c: DraftClip, kind: "video" | "audio") =>
    alone
      ? kind === "audio" && at.kind === "audio" && c.sourcePath === main.sourcePath && samePlace(c) && Math.abs(c.sourceIn - main.sourceIn) < 1e-3
      : !!main.linkGroup && c.linkGroup === main.linkGroup && samePlace(c);
  const group: { kind: "video" | "audio"; track: number; clip: DraftClip }[] = [];
  for (const kind of ["video", "audio"] as const) {
    tracks[kind].forEach((t, i) =>
      t.clips.forEach((c) => {
        if (c === main || partner(c, kind)) group.push({ kind, track: i, clip: c });
      }),
    );
  }
  const inGroup = new Set(group.map((g) => g.clip));
  // Timeline seconds the in and out edges move by, and the source shift for a slip.
  const dIn = options.sourceIn !== undefined ? snap((options.sourceIn - main.sourceIn) / main.speed, fps) : 0;
  const dOut = options.sourceOut !== undefined ? snap((options.sourceOut - main.sourceOut) / main.speed, fps) : 0;
  const slip = options.slip ?? 0;
  const shift = options.start !== undefined ? snap(options.start, fps) - main.start : 0;
  const oldEnd = main.end;
  const reshaped = new Map<DraftClip, { clip: DraftClip; track: number }>();
  for (const g of group) {
    const c = g.clip;
    const start = options.ripple ? c.start : snap(c.start + dIn + shift, fps);
    const end = options.ripple ? snap(c.end - dIn + dOut, fps) : snap(c.end + dOut + shift, fps);
    const sourceIn = round3(c.sourceIn + (dIn + slip / c.speed) * c.speed);
    const sourceOut = round3(sourceIn + (end - start) * c.speed);
    if (end - start < 1 / fps) throw new Error("That would leave nothing of the clip");
    if (sourceIn < 0) throw new Error(`"${c.sourceName}" has only ${round3(c.sourceIn)}s of source before its start`);
    if (start < 0) throw new Error("That would start before the timeline does");
    const track = options.track !== undefined && g.kind === at.kind ? options.track - 1 : g.track;
    if (track < 0 || track >= tracks[g.kind].length) throw new Error(`There is no ${g.kind === "video" ? "V" : "A"}${track + 1} in the draft`);
    reshaped.set(c, { clip: { ...c, start, end, sourceIn, sourceOut }, track });
  }
  const ripple = options.ripple ? snap(dOut - dIn, fps) : 0;
  const markers = draft.markers.map((m) => (ripple && m.time >= oldEnd - 1e-6 ? { ...m, time: snap(m.time + ripple, fps) } : m));
  for (const kind of ["video", "audio"] as const) {
    tracks[kind] = tracks[kind].map((t) => ({
      ...t,
      clips: t.clips
        .filter((c) => !inGroup.has(c))
        .map((c) => (ripple && c.start >= oldEnd - 1e-6 ? { ...c, start: snap(c.start + ripple, fps), end: snap(c.end + ripple, fps) } : c)),
    }));
  }
  for (const g of group) {
    const { clip, track } = reshaped.get(g.clip)!;
    const target = tracks[g.kind][track];
    const clash = target.clips.find((c) => c.end > clip.start + 1e-6 && c.start < clip.end - 1e-6);
    if (clash) {
      throw new Error(
        `${g.kind === "video" ? "V" : "A"}${track + 1} has "${clash.sourceName}" at ${round3(clash.start)}–${round3(clash.end)}s in the way${options.ripple ? " (it spans the edit, so a ripple would overlap it)" : ""}`,
      );
    }
    target.clips = [...target.clips, clip].sort((a, b) => a.start - b.start);
  }
  for (const kind of ["video", "audio"] as const) {
    for (const t of tracks[kind]) {
      const sorted = [...t.clips].sort((a, b) => a.start - b.start);
      for (let i = 1; i < sorted.length; i++) {
        if (sorted[i].start < sorted[i - 1].end - 1e-6) {
          throw new Error(`The ripple would make "${sorted[i - 1].sourceName}" and "${sorted[i].sourceName}" overlap; use rearrange_sections or remove_time_ranges instead`);
        }
      }
    }
  }
  const duration = Math.max(0, ...[...tracks.video, ...tracks.audio].flatMap((t) => t.clips.map((c) => c.end)), draft.duration + ripple);
  const name = main.sourceName;
  const change =
    options.start !== undefined
      ? `Moved "${name}" to ${round3(snap(options.start, fps))}s${options.track !== undefined ? ` on ${at.kind === "video" ? "V" : "A"}${options.track}` : ""}`
      : options.slip !== undefined
        ? `Slipped "${name}" by ${round3(slip)}s`
        : `Trimmed "${name}"${options.sourceIn !== undefined ? ` in to ${round3(options.sourceIn)}s` : ""}${options.sourceOut !== undefined ? ` out to ${round3(options.sourceOut)}s` : ""}${options.ripple ? `, rippling later clips ${ripple > 0 ? "+" : ""}${round3(ripple)}s` : ""}`;
  return { ...draft, video: tracks.video, audio: tracks.audio, markers, duration: round3(duration), changes: [...draft.changes, change] };
}

/** The clip `id` and the clips linked to it at the same place (its picture or sound), with where each is. */
function draftGroup(draft: HostDraft, id: string): { main: DraftClip; group: Set<DraftClip> } {
  const fps = draft.fps;
  const at = draftClipAt(draft, id);
  const main = draft[at.kind][at.track].clips[at.index];
  const samePlace = (c: DraftClip) => Math.abs(c.start - main.start) < 0.5 / fps && Math.abs(c.end - main.end) < 0.5 / fps;
  const group = new Set<DraftClip>([main]);
  if (main.linkGroup) for (const t of [...draft.video, ...draft.audio]) for (const c of t.clips) if (c.linkGroup === main.linkGroup && samePlace(c)) group.add(c);
  return { main, group };
}

/** Throws if two clips on a track overlap after an edit. */
function checkOverlaps(tracks: DraftTrack[], hint: string): void {
  for (const t of tracks) {
    const sorted = [...t.clips].sort((a, b) => a.start - b.start);
    for (let i = 1; i < sorted.length; i++) {
      if (sorted[i].start < sorted[i - 1].end - 1e-6) throw new Error(`That would make "${sorted[i - 1].sourceName}" and "${sorted[i].sourceName}" overlap; ${hint}`);
    }
  }
}

/**
 * Plays a draft clip, with its linked picture or sound, at a constant speed (PLAN.md, "Phase 7b").
 * Without ripple it keeps its place and length and shows more or less of its source; with ripple it
 * keeps its source range and changes length, and every later clip on every track (and the markers)
 * moves with its end.
 */
export function setDraftSpeed(draft: HostDraft, id: string, speed: number, ripple: boolean): HostDraft {
  if (!(speed >= 0.05 && speed <= 20)) throw new Error("speed must be from 0.05 to 20 (1 is normal)");
  const fps = draft.fps;
  const { main, group } = draftGroup(draft, id);
  const oldEnd = main.end;
  const newEnd = ripple ? snap(main.start + (main.sourceOut - main.sourceIn) / speed, fps) : main.end;
  if (newEnd - main.start < 1 / fps) throw new Error("That would leave less than a frame of the clip");
  const delta = round3(newEnd - oldEnd);
  const change = (track: DraftTrack): DraftTrack => ({
    ...track,
    clips: track.clips
      .map((c) => {
        if (group.has(c)) {
          // A constant speed replaces a ramp (clear_clip_speed sets 1).
          const { timeRemap: _ramp, ...plain } = c;
          const end = snap(c.start + (newEnd - main.start), fps);
          return { ...plain, end, speed, sourceOut: ripple ? c.sourceOut : round3(c.sourceIn + (end - c.start) * speed) };
        }
        return delta && c.start >= oldEnd - 1e-6 ? { ...c, start: snap(c.start + delta, fps), end: snap(c.end + delta, fps) } : c;
      })
      .sort((a, b) => a.start - b.start),
  });
  const video = draft.video.map(change);
  const audio = draft.audio.map(change);
  checkOverlaps([...video, ...audio], "a clip on another track runs across its end, so ripple can't move it; use rearrange_sections instead");
  const markers = delta ? draft.markers.map((m) => (m.time >= oldEnd - 1e-6 ? { ...m, time: snap(m.time + delta, fps) } : m)) : draft.markers;
  const ends = [...video, ...audio].flatMap((t) => t.clips.map((c) => c.end));
  return {
    ...draft,
    video,
    audio,
    markers,
    duration: round3(Math.max(draft.duration + delta, ...ends)),
    changes: [...draft.changes, `Set "${main.sourceName}" to ${round3(speed)}x${ripple ? `, rippling later clips ${delta > 0 ? "+" : ""}${delta}s` : ""}`],
  };
}

export interface EditOptions {
  sourcePath: string;
  sourceIn: number;
  sourceOut: number;
  /** Timeline seconds. */
  at: number;
  /** 1-based; default 1. A track one past the last is added. */
  videoTrack?: number;
  audioTrack?: number;
  /** Place the file's sound too (linked); default true. */
  withSound?: boolean;
}

function checkEdit(draft: HostDraft, options: EditOptions): { start: number; end: number; v: number; a: number } {
  const fps = draft.fps;
  if (!options.sourcePath.startsWith("/")) throw new Error("The file must be an absolute path");
  if (!(options.sourceOut > options.sourceIn) || options.sourceIn < 0) throw new Error("sourceOut must be after sourceIn, and sourceIn at least 0");
  const start = snap(options.at, fps);
  if (!(start >= 0) || start > draft.duration + 1e-6) throw new Error(`at must be on the timeline (0 to ${round3(draft.duration)}s)`);
  const v = (options.videoTrack ?? 1) - 1;
  const a = (options.audioTrack ?? 1) - 1;
  if (!Number.isInteger(v) || v < 0 || v > draft.video.length) throw new Error(`There is no V${v + 1}; use V1 to V${draft.video.length + 1}`);
  if (!Number.isInteger(a) || a < 0 || a > draft.audio.length) throw new Error(`There is no A${a + 1}; use A1 to A${draft.audio.length + 1}`);
  return { start, end: snap(start + options.sourceOut - options.sourceIn, fps), v, a };
}

/** The picture (and sound) of an edit, placed into tracks that are free there. */
function placeEdit(tracks: { video: DraftTrack[]; audio: DraftTrack[] }, options: EditOptions, at: { start: number; end: number; v: number; a: number }, group: string): void {
  const clip: DraftClip = {
    sourcePath: options.sourcePath,
    sourceName: fileName(options.sourcePath),
    start: at.start,
    end: at.end,
    sourceIn: round3(options.sourceIn),
    sourceOut: round3(options.sourceIn + (at.end - at.start)),
    speed: 1,
    enabled: true,
    volumeDb: null,
    ...(options.withSound !== false ? { linkGroup: group } : {}),
  };
  const put = (list: DraftTrack[], index: number, type: "video" | "audio") => {
    if (index === list.length) list.push({ type, clips: [] });
    list[index] = { ...list[index], clips: [...list[index].clips, clip].sort((x, y) => x.start - y.start) };
  };
  put(tracks.video, at.v, "video");
  if (options.withSound !== false) put(tracks.audio, at.a, "audio");
}

/**
 * An insert edit: everything at or after `at`, on every track, moves later by the clip's length (a clip
 * running across `at` is cut there and its second part moves), and the clip goes into the gap on the
 * chosen tracks. Every track moves together, so sync holds (Premiere's own insert moves only its
 * target tracks; PLAN.md, "7b.0 probe").
 */
export function insertDraftClip(draft: HostDraft, options: EditOptions): HostDraft {
  const fps = draft.fps;
  const at = checkEdit(draft, options);
  const length = round3(at.end - at.start);
  const open = (track: DraftTrack): DraftTrack => ({
    ...track,
    clips: track.clips
      .flatMap((c) => {
        if (c.start >= at.start - 1e-6) return [{ ...c, start: snap(c.start + length, fps), end: snap(c.end + length, fps) }];
        if (c.end <= at.start + 1e-6) return [c];
        const right = piece(c, at.start, c.end);
        return [piece(c, c.start, at.start), { ...right, start: snap(right.start + length, fps), end: snap(right.end + length, fps) }];
      })
      .sort((a, b) => a.start - b.start),
  });
  const tracks = { video: draft.video.map(open), audio: draft.audio.map(open) };
  placeEdit(tracks, options, at, `inserted-${draft.changes.length}-${Math.round(at.start * fps)}`);
  return {
    ...draft,
    ...tracks,
    markers: draft.markers.map((m) => (m.time >= at.start - 1e-6 ? { ...m, time: snap(m.time + length, fps) } : m)),
    duration: round3(draft.duration + length),
    changes: [...draft.changes, `Inserted ${fileName(options.sourcePath)} at ${at.start}s (${length}s), moving everything after it later`],
  };
}

/** An overwrite edit: the clip replaces whatever is on its tracks between `at` and its end (clips there
 * are cut back to what lies outside); nothing else moves. */
export function overwriteDraftClip(draft: HostDraft, options: EditOptions): HostDraft {
  const at = checkEdit(draft, options);
  const clear = (track: DraftTrack): DraftTrack => ({
    ...track,
    clips: track.clips.flatMap((c) => {
      if (c.end <= at.start + 1e-6 || c.start >= at.end - 1e-6) return [c];
      return [...(c.start < at.start ? [piece(c, c.start, at.start)] : []), ...(c.end > at.end ? [piece(c, at.end, c.end)] : [])];
    }),
  });
  const video = draft.video.map((t, i) => (i === at.v ? clear(t) : t));
  const audio = draft.audio.map((t, i) => (i === at.a && options.withSound !== false ? clear(t) : t));
  const tracks = { video, audio };
  placeEdit(tracks, options, at, `overwrote-${draft.changes.length}-${Math.round(at.start * draft.fps)}`);
  return {
    ...draft,
    ...tracks,
    duration: round3(Math.max(draft.duration, at.end)),
    changes: [...draft.changes, `Overwrote ${round3(at.end - at.start)}s at ${at.start}s on V${at.v + 1}${options.withSound !== false ? `+A${at.a + 1}` : ""} with ${fileName(options.sourcePath)}`],
  };
}

/** One group of draft clips to move: the clip `id` and its linked partners at the same place, by
 * `shift` seconds, the named clip to `track` (0-based, its own kind) when given. */
interface DraftMove {
  id: string;
  shift: number;
  track?: number;
}

/** Moves groups of draft clips at once (PLAN.md, "Phase 8a"): every group is lifted, then placed again;
 * a place that isn't free (or before the start) refuses the whole move. */
function moveDraftGroups(draft: HostDraft, moves: DraftMove[], change: string): HostDraft {
  const fps = draft.fps;
  const tracks = { video: draft.video.map((t) => ({ ...t, clips: [...t.clips] })), audio: draft.audio.map((t) => ({ ...t, clips: [...t.clips] })) };
  const placed: { kind: "video" | "audio"; track: number; clip: DraftClip }[] = [];
  const lifted = new Set<DraftClip>();
  for (const move of moves) {
    const { main, group } = draftGroup(draft, move.id);
    for (const c of group) if (lifted.has(c)) throw new Error("Two of the clips are linked (or the same); give one clip of each group");
    for (const kind of ["video", "audio"] as const) {
      draft[kind].forEach((t, i) =>
        t.clips.forEach((c) => {
          if (!group.has(c)) return;
          lifted.add(c);
          const track = c === main && move.track !== undefined ? move.track : i;
          if (track < 0 || track >= tracks[kind].length) throw new Error(`There is no ${kind === "video" ? "V" : "A"}${track + 1} in the draft`);
          const start = snap(c.start + move.shift, fps);
          if (start < -1e-6) throw new Error("That would start before the timeline does");
          placed.push({ kind, track, clip: { ...c, start, end: snap(c.end + move.shift, fps) } });
        }),
      );
    }
  }
  for (const kind of ["video", "audio"] as const) tracks[kind] = tracks[kind].map((t) => ({ ...t, clips: t.clips.filter((c) => !lifted.has(c)) }));
  for (const p of placed) {
    const target = tracks[p.kind][p.track];
    const clash = target.clips.find((c) => c.end > p.clip.start + 1e-6 && c.start < p.clip.end - 1e-6);
    if (clash) throw new Error(`${p.kind === "video" ? "V" : "A"}${p.track + 1} has "${clash.sourceName}" at ${round3(clash.start)}–${round3(clash.end)}s in the way`);
    target.clips = [...target.clips, p.clip].sort((a, b) => a.start - b.start);
  }
  const duration = Math.max(draft.duration, ...[...tracks.video, ...tracks.audio].flatMap((t) => t.clips.map((c) => c.end)));
  return { ...draft, video: tracks.video, audio: tracks.audio, duration: round3(duration), changes: [...draft.changes, change] };
}

/** Swaps two draft clips' places, as VibeCut's swap_clips: each takes the other's track and start, and
 * its linked clips move by the same time on their own tracks. */
export function swapDraftClips(draft: HostDraft, idA: string, idB: string): HostDraft {
  const a = draftClipAt(draft, idA);
  const b = draftClipAt(draft, idB);
  if (a.kind !== b.kind) throw new Error("A picture and a sound can't swap places; swap two pictures or two sounds");
  const clipA = draft[a.kind][a.track].clips[a.index];
  const clipB = draft[b.kind][b.track].clips[b.index];
  if (draftGroup(draft, idA).group.has(clipB)) throw new Error("Those two clips are linked; they move together");
  return moveDraftGroups(
    draft,
    [
      { id: idA, shift: clipB.start - clipA.start, track: b.track },
      { id: idB, shift: clipA.start - clipB.start, track: a.track },
    ],
    `Swapped "${clipA.sourceName}" and "${clipB.sourceName}"`,
  );
}

/** Moves draft clips (each with its linked clips) by `delta` seconds on their tracks, cut short to the
 * room there is. Returns the draft and how far they went. */
export function moveDraftClipsBy(draft: HostDraft, ids: string[], delta: number): { draft: HostDraft; actualDelta: number } {
  const fps = draft.fps;
  const groups: Set<DraftClip>[] = [];
  const firsts: string[] = [];
  for (const id of ids) {
    const { main, group } = draftGroup(draft, id);
    if (groups.some((g) => g.has(main))) continue;
    groups.push(group);
    firsts.push(id);
  }
  const moving = new Set(groups.flatMap((g) => [...g]));
  let room = Infinity;
  for (const t of [...draft.video, ...draft.audio]) {
    for (const c of t.clips) {
      if (!moving.has(c)) continue;
      const others = t.clips.filter((o) => !moving.has(o));
      const gaps = delta > 0 ? others.filter((o) => o.start >= c.end - 1e-6).map((o) => o.start - c.end) : [c.start, ...others.filter((o) => o.end <= c.start + 1e-6).map((o) => c.start - o.end)];
      room = Math.min(room, ...gaps);
    }
  }
  const actual = snap(Math.sign(delta) * Math.min(Math.abs(delta), room), fps);
  if (Math.abs(actual) < 0.5 / fps) throw new Error("There's no room to move them that way; something is right next to them");
  const moved = moveDraftGroups(
    draft,
    firsts.map((id) => ({ id, shift: actual })),
    `Moved ${plural(firsts.length, "clip")} by ${actual > 0 ? "+" : ""}${round3(actual)}s${Math.abs(actual - delta) > 0.5 / fps ? ` (asked ${round3(delta)}s; cut to the room there is)` : ""}`,
  );
  return { draft: moved, actualDelta: round3(actual) };
}

/**
 * A speed ramp on a draft clip and its linked clips at the same place (PLAN.md, "Phase 8b"): VibeCut's
 * set_speed_ramp form, "from each source time on, play at this speed", eased over `ease` seconds. The
 * clip keeps its source range, so its length follows from the speeds. With ripple, everything after
 * its end on every track (and the markers) moves with it; without, a longer clip must have room.
 * Neither editor can script a ramp (PLAN.md, "8b.0 probe"), so ramps live in drafts.
 */
export function setDraftSpeedRamp(draft: HostDraft, id: string, changes: { sourceTime: number; speed: number }[], ease: number, ripple: boolean): HostDraft {
  const fps = draft.fps;
  const { main, group } = draftGroup(draft, id);
  if (changes.length === 0) throw new Error("changes must list at least one {sourceTime, speed}");
  for (const c of changes) {
    if (!(c.speed >= 0.05 && c.speed <= 20)) throw new Error("Each speed must be from 0.05 to 20 (1 is normal)");
    if (c.sourceTime > main.sourceOut) throw new Error(`sourceTime ${c.sourceTime} is past the clip's out point (${round3(main.sourceOut)}s)`);
  }
  const points = buildRemap(main.sourceIn, main.sourceOut, planFromChanges(main, changes, ease));
  const length = points[points.length - 1].t;
  const oldEnd = main.end;
  const newEnd = snap(main.start + length, fps);
  if (newEnd - main.start < 1 / fps) throw new Error("That would leave less than a frame of the clip");
  const delta = ripple ? round3(newEnd - oldEnd) : 0;
  const single = points.length === 2;
  const change = (track: DraftTrack): DraftTrack => ({
    ...track,
    clips: track.clips
      .map((c) => {
        if (group.has(c)) {
          // A partner from another recording keeps its own source offset, so sync holds.
          const offset = c.sourceIn - main.sourceIn;
          // The clip ends on a frame, so the map's last point does too (its last stretch takes the difference).
          const map = points.map((p, i) => ({ ...p, s: round3(p.s + offset), ...(i === points.length - 1 ? { t: round3(newEnd - main.start) } : {}) }));
          const { timeRemap: _old, ...plain } = c;
          return {
            ...plain,
            end: newEnd,
            sourceOut: round3(c.sourceIn + (main.sourceOut - main.sourceIn)),
            speed: round3((main.sourceOut - main.sourceIn) / (newEnd - main.start)),
            ...(single ? {} : { timeRemap: map }),
          };
        }
        return delta && c.start >= oldEnd - 1e-6 ? { ...c, start: snap(c.start + delta, fps), end: snap(c.end + delta, fps) } : c;
      })
      .sort((a, b) => a.start - b.start),
  });
  const video = draft.video.map(change);
  const audio = draft.audio.map(change);
  checkOverlaps([...video, ...audio], ripple ? "a clip on another track runs across its end, so ripple can't move it" : "use ripple to move what follows, or trim the clip first");
  const markers = delta ? draft.markers.map((m) => (m.time >= oldEnd - 1e-6 ? { ...m, time: snap(m.time + delta, fps) } : m)) : draft.markers;
  const range = speedRange({ sourceIn: main.sourceIn, sourceOut: main.sourceOut, duration: length, timeRemap: points });
  const pct = (v: number) => `${Math.round(v * 100)}%`;
  return {
    ...draft,
    video,
    audio,
    markers,
    duration: round3(Math.max(draft.duration + delta, ...[...video, ...audio].flatMap((t) => t.clips.map((c) => c.end)))),
    changes: [
      ...draft.changes,
      `Ramped "${main.sourceName}" (${range.min === range.max ? pct(range.min) : `${pct(range.min)}–${pct(range.max)}`}), now ${round3(newEnd - main.start)}s${delta ? `, rippling later clips ${delta > 0 ? "+" : ""}${delta}s` : ""}`,
    ],
  };
}

/** One take placed by Harmonizer, for `placeHarmonizedDraft`: its file, its timing (harmonize.ts's
 * PlacedTake) and whether the file has sound. */
export interface DraftTake {
  sourcePath: string;
  startTime: number;
  sourceIn: number;
  sourceOut: number;
  duration: number;
  timeRemap?: RemapPoint[];
  flagged: { start: number; end: number; speed: number }[];
  hasSound: boolean;
}

/**
 * Harmonizer's result in a draft (PLAN.md, "Phase 8b"), as VibeCut's placeHarmonized lays it out:
 * the reference recording on an audio track of its own from `referenceZero`, each take on a video track
 * of its own (the first take on top; empty tracks are used before new ones are added) with its time map, its own sound linked beneath and switched off, and a red
 * marker at each stretch Harmonizer flagged. Nothing already in the draft moves.
 */
export function placeHarmonizedDraft(draft: HostDraft, reference: { sourcePath: string; duration: number }, referenceZero: number, takes: DraftTake[]): HostDraft {
  const fps = draft.fps;
  const zero = snap(referenceZero, fps);
  const video = draft.video.map((t) => ({ ...t, clips: [...t.clips] }));
  const audio = draft.audio.map((t) => ({ ...t, clips: [...t.clips] }));
  // Empty tracks are used first (a new sequence's preset has a few), then new ones are added.
  const unused = (tracks: DraftTrack[]) => tracks.map((t, i) => (t.clips.length ? -1 : i)).filter((i) => i >= 0);
  const freeVideo = unused(video);
  const freeAudio = unused(audio);
  const put = (tracks: DraftTrack[], free: number[], type: "video" | "audio", clip: DraftClip) => {
    const index = free.shift();
    if (index === undefined) tracks.push({ type, clips: [clip] });
    else tracks[index] = { ...tracks[index], clips: [clip] };
  };
  const base = (path: string): Omit<DraftClip, "start" | "end" | "sourceIn" | "sourceOut"> => ({ sourcePath: path, sourceName: fileName(path), speed: 1, enabled: true, volumeDb: null });
  put(audio, freeAudio, "audio", { ...base(reference.sourcePath), start: zero, end: snap(zero + reference.duration, fps), sourceIn: 0, sourceOut: round3(reference.duration) });
  const markers = [...draft.markers];
  // The last take first, so the first ends up on the top track.
  for (const [n, take] of [...takes].reverse().entries()) {
    const start = snap(take.startTime, fps);
    const end = snap(take.startTime + take.duration, fps);
    const group = `harmonized-${draft.changes.length}-${n}`;
    const clip: DraftClip = {
      ...base(take.sourcePath),
      start,
      end,
      sourceIn: round3(take.sourceIn),
      sourceOut: round3(take.sourceOut),
      speed: round3((take.sourceOut - take.sourceIn) / take.duration),
      ...(take.timeRemap ? { timeRemap: take.timeRemap } : {}),
      ...(take.hasSound ? { linkGroup: group } : {}),
    };
    put(video, freeVideo, "video", clip);
    if (take.hasSound) put(audio, freeAudio, "audio", { ...clip, enabled: false });
    for (const f of take.flagged) {
      markers.push({ time: snap(start + f.start, fps), name: `Check sync: ${fileName(take.sourcePath)} at ${Math.round(f.speed * 100)}%`, color: "Red", note: "Harmonizer flagged this stretch", duration: round3(f.end - f.start) });
    }
  }
  const ends = [...video, ...audio].flatMap((t) => t.clips.map((c) => c.end));
  return {
    ...draft,
    video,
    audio,
    markers: markers.sort((a, b) => a.time - b.time),
    duration: round3(Math.max(draft.duration, ...ends)),
    changes: [...draft.changes, `Lined up ${plural(takes.length, "take")} with ${fileName(reference.sourcePath)} from ${round3(zero)}s`],
  };
}
