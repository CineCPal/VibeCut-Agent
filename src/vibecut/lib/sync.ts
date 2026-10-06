// Synced audio: a camera clip whose sound was recorded on a separate recorder (see PLAN.md, "Synced
// audio"). Offset convention (A-Sync's): camera time = recorder time + offset.
//
// The rule that keeps the rest of the app simple: downstream code speaks camera time. Placement turns a
// synced camera asset into its picture plus the recorder's sound (and the muted scratch sound), linked;
// the camera asset's transcript is the recorder's, shifted by the offset.
import type { MediaAsset, SyncedAudio } from "../types/media";
import type { Clip, Track } from "../types/timeline";
import type { TranscriptData, TranscriptSegment } from "../types/transcript";
import { MIN_CLIP_DURATION_SECONDS } from "./timeline";

const EPSILON = 1e-6;

/** The recordings synced to a camera asset whose files are in the project, main one first. */
export function syncedSources(
  camera: MediaAsset | undefined,
  assetsById: Record<string, MediaAsset>,
): Array<{ sync: SyncedAudio; asset: MediaAsset }> {
  if (camera?.type !== "video" || !camera.syncedAudio) return [];
  return camera.syncedAudio
    .map((sync) => ({ sync, asset: assetsById[sync.assetId] }))
    .filter((s): s is { sync: SyncedAudio; asset: MediaAsset } => s.asset?.type === "audio");
}

/** The main recording synced to a camera asset, if any. */
export function primarySource(
  camera: MediaAsset | undefined,
  assetsById: Record<string, MediaAsset>,
): { sync: SyncedAudio; asset: MediaAsset } | undefined {
  return syncedSources(camera, assetsById)[0];
}

/**
 * The files to send to the transcriber for these assets: a synced camera clip's main recording instead
 * of the camera file (the better microphone, and the transcript every reader uses for that clip), each
 * file once — a long roll shared by many camera clips is transcribed a single time.
 */
export function transcriptionPaths(assets: MediaAsset[], assetsById: Record<string, MediaAsset>): string[] {
  return [...new Set(assets.map((a) => primarySource(a, assetsById)?.asset.filePath ?? a.filePath))];
}

export interface RecorderRange {
  sourceIn: number;
  sourceOut: number;
  /** How far after the picture's start the recording's clip starts (when the recorder began late). */
  startDelta: number;
}

/**
 * The stretch of a recording that plays under `camIn`–`camOut` of the camera clip, cut to what the
 * recording actually covers, or null when it covers less than a clip's minimum length.
 */
export function recorderRange(camIn: number, camOut: number, offset: number, recorderDuration: number): RecorderRange | null {
  const rawIn = camIn - offset;
  const sourceIn = Math.max(0, rawIn);
  const sourceOut = Math.min(recorderDuration, camOut - offset);
  if (sourceOut - sourceIn < MIN_CLIP_DURATION_SECONDS - 1e-9) return null;
  return { sourceIn, sourceOut, startDelta: sourceIn - rawIn };
}

/**
 * How far a sound clip's source must sit from its picture's for the two to be in sync:
 * `(sound.startTime - sound.sourceIn) - (picture.startTime - picture.sourceIn)`. 0 for the picture's own
 * file, the sync offset for a synced recording, undefined when the two files have no known relation.
 */
export function expectedAlignment(
  picture: MediaAsset | undefined,
  sound: MediaAsset | undefined,
  assetsById: Record<string, MediaAsset>,
): number | undefined {
  if (!picture || !sound) return undefined;
  if (picture.id === sound.id) return 0;
  return syncedSources(picture, assetsById).find((s) => s.asset.id === sound.id)?.sync.offset;
}

/** The picture clip of a clip's link group (the member on a video track), if there is exactly one. */
export function pictureOfGroup(
  clip: Clip,
  clipsById: Record<string, Clip>,
  tracksById: Record<string, Track>,
): Clip | undefined {
  if (!clip.linkId) return undefined;
  const pictures = Object.values(clipsById).filter((c) => c.linkId === clip.linkId && tracksById[c.trackId]?.type === "video");
  return pictures.length === 1 ? pictures[0] : undefined;
}

/**
 * How far out of sync a clip is with the rest of its link group, in seconds (positive: the sound is
 * late), or undefined when there is nothing to compare. A sound clip is measured against its picture;
 * the picture reports the first of its sound clips that is out.
 */
export function syncErrorSeconds(
  clip: Clip,
  clipsById: Record<string, Clip>,
  tracksById: Record<string, Track>,
  assetsById: Record<string, MediaAsset>,
): number | undefined {
  const picture = pictureOfGroup(clip, clipsById, tracksById);
  if (!picture) return undefined;
  const errorOf = (sound: Clip): number | undefined => {
    // Clips that change speed differently drift apart by design; there is no single offset to check.
    if (!sameTiming(sound, picture)) return undefined;
    const expected = expectedAlignment(assetsById[picture.mediaAssetId], assetsById[sound.mediaAssetId], assetsById);
    if (expected === undefined) return undefined;
    return sound.startTime - sound.sourceIn - (picture.startTime - picture.sourceIn) - expected;
  };
  if (clip.id !== picture.id) return errorOf(clip);
  for (const member of Object.values(clipsById)) {
    if (member.linkId !== clip.linkId || member.id === picture.id) continue;
    const error = errorOf(member);
    if (error !== undefined && Math.abs(error) > EPSILON) return -error;
  }
  return 0;
}

/**
 * Whether two clips play their media at the same pace, so one offset keeps them in sync throughout:
 * both at normal speed, or both with the same speed changes at the same moments (a picture and its
 * sound retimed together).
 */
export function sameTiming(a: Clip, b: Clip): boolean {
  if (!a.timeRemap && !b.timeRemap) return true;
  if (!a.timeRemap || !b.timeRemap || a.timeRemap.length !== b.timeRemap.length) return false;
  return a.timeRemap.every((p, i) => {
    const q = b.timeRemap![i];
    return Math.abs(p.t - q.t) < 1e-6 && Math.abs(p.s - a.sourceIn - (q.s - b.sourceIn)) < 1e-6;
  });
}

/** Seconds as whole frames (rounded), for the out-of-sync badge. */
export function syncErrorFrames(errorSeconds: number, frameRate: number): number {
  return Math.round(errorSeconds * frameRate);
}

let syncFramesMemo: {
  clipsById: Record<string, Clip>;
  tracksById: Record<string, Track>;
  assetsById: Record<string, MediaAsset>;
  frameRate: number;
  byClip: Record<string, number>;
} | null = null;

/**
 * Every linked clip's out-of-sync frames (`syncErrorFrames` of `syncErrorSeconds`), keyed by clip
 * id; clips in sync, or not linked, are left out. Clips are grouped by `linkId` in one pass, so the
 * whole timeline costs O(clips) rather than every clip scanning every other one. Remembers its last
 * answer, so the timeline's clips, which all ask during one store update, share one computation.
 */
export function syncFramesByClip(
  clipsById: Record<string, Clip>,
  tracksById: Record<string, Track>,
  assetsById: Record<string, MediaAsset>,
  frameRate: number,
): Record<string, number> {
  const memo = syncFramesMemo;
  if (memo && memo.clipsById === clipsById && memo.tracksById === tracksById && memo.assetsById === assetsById && memo.frameRate === frameRate) {
    return memo.byClip;
  }
  const groups = new Map<string, Record<string, Clip>>();
  for (const clip of Object.values(clipsById)) {
    if (!clip.linkId) continue;
    const group = groups.get(clip.linkId) ?? {};
    group[clip.id] = clip;
    groups.set(clip.linkId, group);
  }
  const byClip: Record<string, number> = {};
  for (const group of groups.values()) {
    for (const clip of Object.values(group)) {
      const error = syncErrorSeconds(clip, group, tracksById, assetsById);
      const frames = error === undefined ? 0 : syncErrorFrames(error, frameRate);
      if (frames !== 0) byClip[clip.id] = frames;
    }
  }
  syncFramesMemo = { clipsById, tracksById, assetsById, frameRate, byClip };
  return byClip;
}

/**
 * The source in point that puts a sound clip back in sync with its picture without moving it on the
 * timeline (Premiere's "Slip into Sync"), or an error when the file doesn't reach that far.
 */
export function slipIntoSync(
  sound: Clip,
  clipsById: Record<string, Clip>,
  tracksById: Record<string, Track>,
  assetsById: Record<string, MediaAsset>,
): { sourceIn: number } | { error: string } {
  const picture = pictureOfGroup(sound, clipsById, tracksById);
  if (!picture || picture.id === sound.id) return { error: "The clip is not a sound clip linked to a picture" };
  if (sound.timeRemap || picture.timeRemap) return { error: "Slip into Sync does not work on clips with speed changes" };
  const expected = expectedAlignment(assetsById[picture.mediaAssetId], assetsById[sound.mediaAssetId], assetsById);
  if (expected === undefined) return { error: "The sound and picture are from files that are not synced" };
  const sourceIn = sound.startTime - (picture.startTime - picture.sourceIn) - expected;
  const duration = assetsById[sound.mediaAssetId]?.durationSeconds ?? 0;
  if (sourceIn < -EPSILON || sourceIn + sound.duration > duration + EPSILON) {
    return { error: "The sound file does not cover this stretch in sync; trim the clip first" };
  }
  return { sourceIn: Math.max(0, sourceIn) };
}

function shiftSegment(segment: TranscriptSegment, offset: number, duration: number): TranscriptSegment | null {
  const start = segment.start + offset;
  const end = segment.end + offset;
  if (end <= 0 || start >= duration) return null;
  const shifted: TranscriptSegment = { ...segment, start: Math.max(0, start), end: Math.min(duration, end) };
  if (segment.words) {
    const words = segment.words
      .map((w) => ({ ...w, start: w.start + offset, end: w.end + offset }))
      .filter((w) => w.start >= 0 && w.end <= duration);
    if (words.length > 0) shifted.words = words;
    else delete shifted.words;
  }
  return shifted;
}

/**
 * A recording's transcript in the camera's time: every line moved by `offset`, cut to the camera
 * clip's length (a long roll's transcript becomes just the part this clip saw). Lines that only partly
 * overlap are kept with their times clamped, and words outside the clip are dropped.
 */
export function shiftTranscript(data: TranscriptData, offset: number, cameraDuration: number): TranscriptData {
  const segments = data.segments
    .map((s) => shiftSegment(s, offset, cameraDuration))
    .filter((s): s is TranscriptSegment => s !== null);
  return { ...data, segments };
}
