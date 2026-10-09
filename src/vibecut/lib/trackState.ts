import type { Clip, Track, TrackType } from "../types/timeline";

/** Two times this close together count as the same edit point. */
const EDIT_POINT_EPSILON = 1e-3;

export function isSyncLocked(track: Track | undefined): boolean {
  return track !== undefined && track.syncLocked !== false;
}

export function isTargeted(track: Track | undefined): boolean {
  return track !== undefined && track.targeted !== false;
}

type TrackSwitches = Pick<Track, "type" | "enabled" | "muted" | "soloed">;

/** Whether the track's clips play and export at all: false once a video track is disabled. */
export function isTrackEnabled(track: Pick<Track, "type" | "enabled"> | undefined): boolean {
  return track !== undefined && (track.type !== "video" || track.enabled !== false);
}

/** Whether any audio track is soloed, so only soloed tracks are heard. */
export function soloActive(tracks: Iterable<TrackSwitches | undefined>): boolean {
  for (const track of tracks) if (track?.type === "audio" && track.soloed === true) return true;
  return false;
}

/**
 * Whether the track's sound is heard: it is enabled and not muted, and, while `solo` (some audio
 * track is soloed), it is one of the soloed tracks. A video track's own sound can't be soloed, so a
 * solo silences it too.
 */
export function isTrackAudible(track: TrackSwitches | undefined, solo = false): boolean {
  return isTrackEnabled(track) && track?.muted !== true && (!solo || (track?.type === "audio" && track.soloed === true));
}

/**
 * The timeline as playback should see it once track switches apply: a disabled track keeps its
 * place but has no clips, and every clip on a disabled, muted or soloed-out track has volume 0, so
 * however its sound would be played (its own element, or a linked picture's player sharing it) it is
 * silent. Returns the inputs unchanged when no track is switched off.
 */
export function applyTrackSwitches<C extends Clip>(
  tracks: Track[],
  clipsById: Record<string, C>,
): { tracks: Track[]; clipsById: Record<string, C> } {
  const solo = soloActive(tracks);
  if (tracks.every((t) => isTrackAudible(t, solo))) return { tracks, clipsById };
  const clips = { ...clipsById };
  const next = tracks.map((track) => {
    if (isTrackAudible(track, solo)) return track;
    for (const id of track.clipIds) if (clips[id]) clips[id] = { ...clips[id], volume: 0 };
    return isTrackEnabled(track) ? track : { ...track, clipIds: [] };
  });
  return { tracks: next, clipsById: clips };
}

interface TrackLookup {
  sequence: { trackIds: string[] };
  tracksById: Record<string, Track>;
}

/** Tracks in timeline order (topmost video first, then audio). */
function orderedTracks(state: TrackLookup): Track[] {
  return state.sequence.trackIds.map((id) => state.tracksById[id]).filter((t): t is Track => Boolean(t));
}

/**
 * Where Insert and Overwrite put a clip of `type`: the track marked as patched, or the first track of
 * that type when none is. Null only when the sequence has no track of that type.
 */
export function patchedTrackId(state: TrackLookup, type: TrackType): string | null {
  const ofType = orderedTracks(state).filter((t) => t.type === type);
  return (ofType.find((t) => t.sourcePatched) ?? ofType[0])?.id ?? null;
}

export function targetedTrackIds(state: TrackLookup): string[] {
  return orderedTracks(state)
    .filter(isTargeted)
    .map((t) => t.id);
}

export function syncLockedTrackIds(state: TrackLookup): string[] {
  return orderedTracks(state)
    .filter(isSyncLocked)
    .map((t) => t.id);
}

/** Every clip start and end on the given tracks, sorted and without near-duplicates. */
export function editPoints(clipsById: Record<string, Clip>, trackIds: readonly string[]): number[] {
  const tracks = new Set(trackIds);
  const times = Object.values(clipsById)
    .filter((c) => tracks.has(c.trackId))
    .flatMap((c) => [c.startTime, c.startTime + c.duration])
    .sort((a, b) => a - b);
  const unique: number[] = [];
  for (const t of times) {
    if (unique.length === 0 || t - unique[unique.length - 1] > EDIT_POINT_EPSILON) unique.push(t);
  }
  return unique;
}

/** The first edit point after `time` on the given tracks, or null when there is none. */
export function nextEditPoint(clipsById: Record<string, Clip>, trackIds: readonly string[], time: number): number | null {
  return editPoints(clipsById, trackIds).find((t) => t > time + EDIT_POINT_EPSILON) ?? null;
}

/** The last edit point before `time` on the given tracks, or null when there is none. */
export function prevEditPoint(clipsById: Record<string, Clip>, trackIds: readonly string[], time: number): number | null {
  const before = editPoints(clipsById, trackIds).filter((t) => t < time - EDIT_POINT_EPSILON);
  return before.length > 0 ? before[before.length - 1] : null;
}
