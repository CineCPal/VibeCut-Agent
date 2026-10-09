// Cut down from VibeCut's lib/export/flatten.ts to what the edit lint uses (`buildVideoSegments`,
// `clipHasOwnAudio`), with the colour-grade keys left out: the lint never passes grades. The rest of
// both functions is verbatim.
import type { ExportTimePoint, ExportVideoSegment } from "../../types/export";
import type { MediaAsset } from "../../types/media";
import type { Clip, RemapPoint, Track } from "../../types/timeline";
import { effectiveFades } from "../playback/envelope";
import { joinClips, sliceClip } from "../timeRemap";
import { isTrackEnabled } from "../trackState";
import type { RenderClip } from "../transitions";

/** A clip's time map as the export takes it (just the times; ramp marks are for the editor). */
function exportTimeMap(points: RemapPoint[]): ExportTimePoint[] {
  return points.map(({ t, s }) => ({ t, s }));
}

interface Interval {
  start: number;
  end: number;
}

const EPSILON = 1e-6;

/** The parts of `interval` not covered by any interval in `coveredList`. */
function subtract(interval: Interval, coveredList: Interval[]): Interval[] {
  let pieces: Interval[] = [interval];
  for (const covered of coveredList) {
    const next: Interval[] = [];
    for (const piece of pieces) {
      if (covered.end <= piece.start || covered.start >= piece.end) {
        next.push(piece);
        continue;
      }
      if (covered.start > piece.start) next.push({ start: piece.start, end: Math.min(covered.start, piece.end) });
      if (covered.end < piece.end) next.push({ start: Math.max(covered.end, piece.start), end: piece.end });
    }
    pieces = next;
  }
  return pieces.filter((p) => p.end - p.start > EPSILON);
}

/**
 * The video that will actually be visible in the export, one entry per unbroken stretch: for each
 * point in time, the topmost video track (in `trackIds` order) with a resolvable clip wins, exactly
 * like `PlaybackEngine.sync` (an offline or missing asset does not block the track below it, so it
 * is skipped here rather than treated as an opaque clip). Clips a higher track only partly covers
 * are split around the covered part, so a segment's fades only apply where they'd fall at the
 * original start or end of the clip.
 *
 * Takes the timeline with transitions already expanded (`expandTransitions`). A dissolve's see-through
 * tail does not hide what is under it: when nothing covers it, the out-going clip's segment just runs
 * on through the tail's time and the in-coming segment under it gets `transitionIn`, which the render
 * turns into a crossfade between the two. A tail partly covered by a higher track is left out, so
 * that dissolve becomes a cut.
 */
export function buildVideoSegments(
  trackIds: string[],
  tracksById: Record<string, Track>,
  clipsById: Record<string, RenderClip>,
  assetsById: Record<string, MediaAsset>,
  offline: ReadonlySet<string> = new Set(),
): ExportVideoSegment[] {
  const pieces: Array<{ clip: RenderClip; start: number; end: number; transitionIn?: number }> = [];
  const covered: Interval[] = [];
  const tails: RenderClip[] = [];

  for (const trackId of trackIds) {
    const track = tracksById[trackId];
    if (!track || track.type !== "video" || !isTrackEnabled(track)) continue;
    const clips = track.clipIds.map((id) => clipsById[id]).filter((c): c is RenderClip => Boolean(c));
    for (const clip of clips) {
      const asset = assetsById[clip.mediaAssetId];
      if (!asset || offline.has(asset.id)) continue;
      const full = { start: clip.startTime, end: clip.startTime + clip.duration };
      if (clip.seeThrough) {
        const visible = subtract(full, covered);
        if (visible.length === 1 && visible[0].end - visible[0].start >= clip.duration - EPSILON) tails.push(clip);
        continue;
      }
      for (const visible of subtract(full, covered)) pieces.push({ clip, start: visible.start, end: visible.end });
      covered.push(full);
    }
  }

  for (const tail of tails) {
    const tailEnd = tail.startTime + tail.duration;
    // The out-going clip ends where its tail starts, in the same file, at the same source position.
    const before = pieces.find(
      (p) =>
        Math.abs(p.end - tail.startTime) < 1e-3 &&
        Math.abs(p.clip.startTime + p.clip.duration - tail.startTime) < 1e-3 &&
        p.clip.mediaAssetId === tail.mediaAssetId &&
        Math.abs(p.clip.sourceOut - tail.sourceIn) < 1e-3,
    );
    const after = pieces.find((p) => Math.abs(p.start - tail.startTime) < 1e-3 && p !== before);
    if (!before || !after || after.end < tailEnd - 1e-3) continue;
    before.end = tailEnd;
    before.clip =
      before.clip.timeRemap || tail.timeRemap
        ? joinClips(before.clip, tail)
        : { ...before.clip, duration: before.clip.duration + tail.duration, sourceOut: tail.sourceOut };
    after.transitionIn = tail.duration;
  }

  pieces.sort((a, b) => a.start - b.start);
  return pieces.map(({ clip, start, end, transitionIn }) => {
    const asset = assetsById[clip.mediaAssetId];
    // The picture's own fades: an in-coming dissolve clip fades its sound in but not its picture.
    const { fadeIn, fadeOut } = effectiveFades({ ...clip, fadeIn: clip.pictureFadeIn ?? clip.fadeIn });
    const piece = sliceClip(clip, start - clip.startTime, end - clip.startTime);
    return {
      path: asset.filePath,
      timelineStart: start,
      duration: end - start,
      sourceIn: piece.sourceIn,
      ...(piece.timeRemap ? { timeMap: exportTimeMap(piece.timeRemap) } : {}),
      fadeIn: start <= clip.startTime + EPSILON ? fadeIn : 0,
      fadeOut: end >= clip.startTime + clip.duration - EPSILON ? fadeOut : 0,
      ...(transitionIn ? { transitionIn } : {}),
    };
  });
}

/** Whether a clip's own file audio should sound in the export (matches `PlaybackEngine.applySettings`). */
export function clipHasOwnAudio(clip: Clip, track: Track, assetsById: Record<string, MediaAsset>, offline: ReadonlySet<string>): boolean {
  const asset = assetsById[clip.mediaAssetId];
  if (!asset || offline.has(asset.id)) return false;
  if (track.type === "audio") return true;
  // A linked video clip's sound lives on its own audio clip instead; playing both would double it.
  return !clip.linkId && asset.hasAudio !== false;
}
