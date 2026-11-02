/** The SMPTE ruler over the lanes (visualizer-spec.md §4.2 B), with the playhead. */
import type { SupportedRate } from "@vibecut/contracts";
import { exactRate, rationalTime, toSmpte } from "../../lib/timecode/rationalTime";

export interface TimecodeRulerProps {
  seconds: number;
  pxPerSec: number;
  rate: SupportedRate;
  playheadSec: number;
  onSeek: (seconds: number) => void;
}

const STEPS = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600];

/** The tick interval in seconds that keeps labels at least 90 px apart. */
export function tickStep(pxPerSec: number): number {
  return STEPS.find((s) => s * pxPerSec >= 90) ?? STEPS[STEPS.length - 1];
}

export function secondsToFrame(seconds: number, rate: SupportedRate): number {
  const { num, den } = exactRate(rate);
  return Math.round((seconds * num) / den);
}

export function TimecodeRuler({ seconds, pxPerSec, rate, playheadSec, onSeek }: TimecodeRulerProps) {
  const step = tickStep(pxPerSec);
  const ticks: number[] = [];
  for (let t = 0; t <= seconds + step; t += step) ticks.push(t);
  const width = Math.max(1, Math.ceil((seconds + step) * pxPerSec));
  return (
    <div
      className="relative h-6 cursor-col-resize border-b border-border bg-surface"
      style={{ width }}
      onClick={(e) => {
        const box = e.currentTarget.getBoundingClientRect();
        onSeek(Math.max(0, (e.clientX - box.left) / pxPerSec));
      }}
      aria-hidden="true"
    >
      {ticks.map((t) => (
        <span key={t} className="absolute top-0 h-full border-l border-border pl-1 font-mono text-[10px] leading-6 text-cool-grey" style={{ left: Math.round(t * pxPerSec) }}>
          {toSmpte(rationalTime(secondsToFrame(t, rate), rate))}
        </span>
      ))}
      <span className="pointer-events-none absolute top-0 h-full w-px bg-loss" style={{ left: Math.round(playheadSec * pxPerSec) }} data-testid="playhead" />
    </div>
  );
}
