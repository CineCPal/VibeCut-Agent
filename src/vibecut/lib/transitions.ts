import type { Clip, Track, Transition, TransitionKind } from "../types/timeline";
import { headroomAfter, headroomBefore, retrimClip, sliceClip } from "./timeRemap";

/** A clip's end and the next clip's start this close together count as a cut between them. */
const CUT_EPSILON = 1e-3;
/** Shorter transitions than this are not worth drawing (about a frame at 25 fps). */
export const MIN_TRANSITION_SECONDS = 0.04;
/** What Cmd+D and friends put on a cut, before clamping to the room there is. */
export const DEFAULT_TRANSITION_SECONDS = 1;

export const TRANSITION_LABELS: Record<TransitionKind, string> = {
  dissolve: "Cross Dissolve",
  dipToBlack: "Dip to Black",
};

/** Premiere's names for an audio track's transitions. */
export const AUDIO_TRANSITION_LABELS: Record<TransitionKind, string> = {
  dissolve: "Constant Power",
  dipToBlack: "Dip to Silence",
};

export function transitionLabel(kind: TransitionKind, trackType: Track["type"]): string {
  return (trackType === "audio" ? AUDIO_TRANSITION_LABELS : TRANSITION_LABELS)[kind];
}

/** The clip on the same track that starts where `clip` ends, if any: the other side of its out-going cut. */
export function incomingClip(clipsById: Record<string, Clip>, clip: Clip): Clip | null {
  const end = clip.startTime + clip.duration;
  for (const other of Object.values(clipsById)) {
    if (other.id !== clip.id && other.trackId === clip.trackId && Math.abs(other.startTime - end) < CUT_EPSILON) return other;
  }
  return null;
}

/** The clip on the same track that ends where `clip` starts, if any. */
export function outgoingClip(clipsById: Record<string, Clip>, clip: Clip): Clip | null {
  for (const other of Object.values(clipsById)) {
    if (other.id !== clip.id && other.trackId === clip.trackId && Math.abs(other.startTime + other.duration - clip.startTime) < CUT_EPSILON) {
      return other;
    }
  }
  return null;
}

/**
 * The longest transition of `kind` that fits the cut after `outgoing` (0 when none does). A transition
 * sits centred on the cut and never takes more than half of either clip, so the transitions at a
 * clip's two ends can never overlap. A dissolve also plays half its length of media past the cut on
 * both sides, so it is limited by what each file has beyond the clip's out point (outgoing) and before
 * its in point (incoming). A dip to black needs no extra media.
 */
export function maxTransitionSeconds(
  outgoing: Clip,
  incoming: Clip,
  kind: TransitionKind,
  mediaDurationOf: (clip: Clip) => number,
): number {
  let half = Math.min(outgoing.duration, incoming.duration) / 2;
  if (kind === "dissolve") {
    half = Math.min(half, Math.max(0, headroomAfter(outgoing, mediaDurationOf(outgoing))), Math.max(0, headroomBefore(incoming)));
  }
  // Floor to a hundredth so the stored value is never a hair past what fits.
  return Math.floor(Math.max(0, half * 2) * 100 + 1e-6) / 100;
}

export interface ActiveTransition {
  kind: TransitionKind;
  /** Clamped to what fits right now, which may be less than stored after a trim. */
  duration: number;
  outgoing: Clip;
  incoming: Clip;
  /** Where the two clips meet; the transition runs from `cut - duration / 2` to `cut + duration / 2`. */
  cut: number;
}

/**
 * The transition that actually plays after `clip`, or null: one is stored, a clip still touches its
 * end, and at least the shortest transition still fits. A transition whose clips were moved apart is
 * kept on the clip but has no effect until something touches that end again.
 */
export function activeTransition(
  clipsById: Record<string, Clip>,
  clip: Clip,
  mediaDurationOf: (clip: Clip) => number,
): ActiveTransition | null {
  const stored = clip.transitionOut;
  if (!stored) return null;
  const incoming = incomingClip(clipsById, clip);
  if (!incoming) return null;
  const duration = Math.min(stored.duration, maxTransitionSeconds(clip, incoming, stored.kind, mediaDurationOf));
  if (duration < MIN_TRANSITION_SECONDS) return null;
  return { kind: stored.kind, duration, outgoing: clip, incoming, cut: clip.startTime + clip.duration };
}

export type SetTransitionResult =
  | { ok: true; transition: Transition | null; requested: number | null }
  | { ok: false; error: string };

/**
 * Validates putting a transition on the cut after `clip` (or removing it with `kind: null`): the
 * duration is clamped to what fits, and refused with a reason when there is no cut or no room.
 */
export function planTransition(
  clipsById: Record<string, Clip>,
  clip: Clip | undefined,
  kind: TransitionKind | null,
  seconds: number,
  mediaDurationOf: (clip: Clip) => number,
): SetTransitionResult {
  if (!clip) return { ok: false, error: "No such clip" };
  if (kind === null) return { ok: true, transition: null, requested: null };
  const incoming = incomingClip(clipsById, clip);
  if (!incoming) return { ok: false, error: `No clip starts where "${clip.name}" ends, so there is no cut to put a transition on` };
  if (!Number.isFinite(seconds) || seconds <= 0) return { ok: false, error: "The transition must be longer than 0 seconds" };
  const max = maxTransitionSeconds(clip, incoming, kind, mediaDurationOf);
  if (max < MIN_TRANSITION_SECONDS) {
    return {
      ok: false,
      error:
        kind === "dissolve"
          ? `No room for a dissolve: "${clip.name}" and "${incoming.name}" use their files right up to the cut. Trim them to leave unused media (handles) on both sides.`
          : "The clips are too short for a transition",
    };
  }
  const duration = Math.round(Math.min(seconds, max) * 100) / 100;
  return { ok: true, transition: { kind, duration }, requested: seconds };
}

/**
 * The cut nearest `time` on a track (the end of a clip another clip starts at), or null if the track
 * has no cuts. Used by Cmd+D and friends, which work on the edit point nearest the playhead.
 */
export function nearestCut(clipsById: Record<string, Clip>, track: Track, time: number): Clip | null {
  let best: Clip | null = null;
  let bestDistance = Infinity;
  for (const id of track.clipIds) {
    const clip = clipsById[id];
    if (!clip || !incomingClip(clipsById, clip)) continue;
    const distance = Math.abs(clip.startTime + clip.duration - time);
    if (distance < bestDistance) {
      best = clip;
      bestDistance = distance;
    }
  }
  return best;
}

// ------------------------------------------------------------------------------ rendering

/**
 * A clip as the preview and the export play it. Transitions are turned into these ahead of time, so
 * every renderer only ever sees clips with fades, plus two flags.
 */
export interface RenderClip extends Clip {
  /** Drawn over the layer below it rather than hiding it: the out-going half of a dissolve. */
  seeThrough?: true;
  /** When set, the picture fades in over this long instead of `fadeIn` (the sound still uses `fadeIn`). */
  pictureFadeIn?: number;
  /** Sound fades use an equal-power (quarter-sine) curve, so a crossfade has no dip in the middle. */
  powerFades?: true;
}

/** Suffix of the stand-in track a track's dissolve tails play on, drawn just above it. */
export const TRANSITION_TRACK_SUFFIX = "~transitions";
export const transitionTrackId = (trackId: string): string => `${trackId}${TRANSITION_TRACK_SUFFIX}`;
export const isTransitionTrackId = (trackId: string): boolean => trackId.endsWith(TRANSITION_TRACK_SUFFIX);

/**
 * The timeline as renderers play it, with every active transition turned into plain clips:
 *
 * - **Dip to black** is a fade out on the out-going clip over the first half and a fade in on the
 *   in-coming one over the second, meeting in black (or silence) at the cut.
 * - **Dissolve**: the in-coming clip starts half the transition early (using media before its in
 *   point) and fades in its sound; the out-going clip's last half-transition plus the same length of
 *   media past its out point moves to a stand-in track just above, where it plays see-through and
 *   fades out, picture and sound. The out-going clip on its own track ends where the tail starts.
 *   On an audio track the two sound fades use an equal-power curve.
 *
 * The tail keeps the out-going clip's link id, so its linked sound still pairs with it. Tracks and
 * clips with no active transition come back untouched (the same objects), and the stand-in tracks sit
 * directly before their track in `tracks`, which is top-first order.
 */
export function expandTransitions(
  tracks: Track[],
  clipsById: Record<string, Clip>,
  mediaDurationOf: (clip: Clip) => number,
): { tracks: Track[]; clipsById: Record<string, RenderClip> } {
  let next: Record<string, RenderClip> | null = null;
  const outTracks: Track[] = [];

  for (const track of tracks) {
    const clips = track.clipIds.map((id) => clipsById[id]).filter((c): c is Clip => Boolean(c));
    const active = clips.map((c) => activeTransition(clipsById, c, mediaDurationOf)).filter((t): t is ActiveTransition => t !== null);
    if (active.length === 0) {
      outTracks.push(track);
      continue;
    }
    next ??= { ...clipsById };
    const tails: string[] = [];
    for (const t of active) {
      const half = t.duration / 2;
      const outgoing = next[t.outgoing.id];
      const incoming = next[t.incoming.id];
      if (t.kind === "dipToBlack") {
        next[outgoing.id] = { ...outgoing, fadeOut: half };
        next[incoming.id] = { ...incoming, fadeIn: half };
        continue;
      }
      const { fadeOut: _fadeOut, transitionOut: _transition, ...main } = outgoing;
      next[outgoing.id] = retrimClip(main, 0, -half);
      const tailId = `${outgoing.id}~tail`;
      const { fadeIn: _tailFadeIn, pictureFadeIn: _tailPicture, ...tailBase } = main as RenderClip;
      next[tailId] = {
        ...(outgoing.timeRemap
          ? sliceClip(tailBase, outgoing.duration - half, outgoing.duration + half)
          : { ...tailBase, duration: t.duration, sourceIn: outgoing.sourceOut - half, sourceOut: outgoing.sourceOut + half }),
        id: tailId,
        trackId: transitionTrackId(track.id),
        startTime: t.cut - half,
        fadeOut: t.duration,
        ...(track.type === "video" ? { seeThrough: true as const } : {}),
        powerFades: true,
      };
      tails.push(tailId);
      next[incoming.id] = {
        ...retrimClip(incoming, -half, 0),
        startTime: incoming.startTime - half,
        fadeIn: t.duration,
        ...(track.type === "video" ? { pictureFadeIn: 0 } : {}),
        powerFades: true,
      };
    }
    if (tails.length > 0) {
      outTracks.push({ ...track, id: transitionTrackId(track.id), name: `${track.name} transitions`, clipIds: tails });
    }
    outTracks.push(track);
  }
  return { tracks: outTracks, clipsById: next ?? clipsById };
}

/** 0 to 1: how far through its picture fades a render clip is at `time`. */
export function pictureFadeLevel(clip: RenderClip, time: number, fadeLevel: (clip: Clip, time: number) => number): number {
  return clip.pictureFadeIn === undefined ? fadeLevel(clip, time) : fadeLevel({ ...clip, fadeIn: clip.pictureFadeIn }, time);
}

/** 0 to 1: a render clip's sound level from its fades, on an equal-power curve when it asks for one. */
export function soundFadeLevel(clip: RenderClip, time: number, fadeLevel: (clip: Clip, time: number) => number): number {
  const level = fadeLevel(clip, time);
  return clip.powerFades ? Math.sin((level * Math.PI) / 2) : level;
}
