import type { Clip } from "../types/timeline";
import type { WaveformPeaks } from "../types/waveform";
import type { TimeRange } from "./timeline";
import { sourceAt } from "./timeRemap";

export interface SilenceOptions {
  /** A quiet stretch shorter than this is a natural pause, not dead air. */
  minDurationSeconds: number;
  /** Anything below this level (dBFS, e.g. -40) counts as silent. */
  thresholdDb: number;
  /** Kept at each end of a silent stretch so a cut does not clip the word before or after it. */
  handleSeconds: number;
  /** Only look inside this stretch of the timeline. */
  startTime?: number;
  endTime?: number;
}

export const DEFAULT_SILENCE_OPTIONS: SilenceOptions = { minDurationSeconds: 0.7, thresholdDb: -40, handleSeconds: 0.1 };

/** One clip whose sound counts, with the peaks of its source file. */
export interface AudibleClip {
  clip: Clip;
  peaks: WaveformPeaks;
}

/** Linear 0..1 amplitude of a dBFS level. */
export function dbToAmplitude(db: number): number {
  return 10 ** (db / 20);
}

/** The loudest the clip's source gets in the bucket covering `sourceTime`, scaled by the clip's volume. */
function levelAt({ clip, peaks }: AudibleClip, sourceTime: number): number {
  const index = Math.floor(sourceTime * peaks.peaksPerSecond);
  if (index < 0 || index >= peaks.maxes.length) return 0;
  const level = Math.max(Math.abs(peaks.mins[index] ?? 0), Math.abs(peaks.maxes[index] ?? 0));
  return level * (clip.volume ?? 1);
}

/**
 * Timeline ranges where everything audible is quieter than the threshold for at least the minimum
 * duration, each shrunk by the handle at both ends. The timeline is sampled at the peaks' own rate.
 * Stretches no audible clip covers (gaps, or picture with no sound) are not reported: there is no
 * sound there to judge, and cutting a gap is a different edit.
 */
export function findSilentRanges(audible: AudibleClip[], options: SilenceOptions): TimeRange[] {
  if (audible.length === 0) return [];
  const rate = Math.max(...audible.map((a) => a.peaks.peaksPerSecond));
  const step = 1 / rate;
  const threshold = dbToAmplitude(options.thresholdDb);
  const coverageStart = Math.min(...audible.map((a) => a.clip.startTime));
  const coverageEnd = Math.max(...audible.map((a) => a.clip.startTime + a.clip.duration));
  const from = Math.max(coverageStart, options.startTime ?? coverageStart);
  const to = Math.min(coverageEnd, options.endTime ?? coverageEnd);

  const runs: TimeRange[] = [];
  let runStart: number | null = null;
  const close = (end: number) => {
    if (runStart !== null && end - runStart >= options.minDurationSeconds) runs.push({ start: runStart, end });
    runStart = null;
  };

  for (let t = from; t < to; t += step) {
    const mid = t + step / 2;
    let covered = false;
    let loudest = 0;
    for (const a of audible) {
      const { startTime, duration } = a.clip;
      if (mid < startTime || mid >= startTime + duration) continue;
      covered = true;
      loudest = Math.max(loudest, levelAt(a, sourceAt(a.clip, mid)));
    }
    if (covered && loudest < threshold) {
      if (runStart === null) runStart = t;
    } else {
      close(t);
    }
  }
  close(to);

  return runs
    .map((r) => ({ start: r.start + options.handleSeconds, end: r.end - options.handleSeconds }))
    .filter((r) => r.end - r.start > 0.01);
}
