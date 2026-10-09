import type { Clip } from "../../types/timeline";

/** The most a clip can be turned up: three times its natural level (about +9.5 dB). */
export const MAX_CLIP_VOLUME = 3;

/**
 * The fade in and fade out that actually apply to a clip: never longer than the clip, and together no
 * longer than it either (the fade in wins if trimming left no room for both).
 */
export function effectiveFades(clip: Pick<Clip, "duration" | "fadeIn" | "fadeOut">): { fadeIn: number; fadeOut: number } {
  const fadeIn = Math.min(Math.max(clip.fadeIn ?? 0, 0), clip.duration);
  const fadeOut = Math.min(Math.max(clip.fadeOut ?? 0, 0), clip.duration - fadeIn);
  return { fadeIn, fadeOut };
}

/** 0 to 1: how far through its fades a clip is at `time` (1 in the middle, 0 at the very start of a fade in). */
export function fadeLevel(clip: Pick<Clip, "startTime" | "duration" | "fadeIn" | "fadeOut">, time: number): number {
  const { fadeIn, fadeOut } = effectiveFades(clip);
  let level = 1;
  if (fadeIn > 0) level = Math.min(level, (time - clip.startTime) / fadeIn);
  if (fadeOut > 0) level = Math.min(level, (clip.startTime + clip.duration - time) / fadeOut);
  return Math.min(1, Math.max(0, level));
}
