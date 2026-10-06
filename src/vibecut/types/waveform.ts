/** Peak audio levels for one source file, one (min, max) pair every `1 / peaksPerSecond` seconds. */
export interface WaveformPeaks {
  peaksPerSecond: number;
  mins: number[];
  maxes: number[];
}
