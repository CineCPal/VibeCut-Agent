/**
 * Frame-accurate time for the OTIO dock (visualizer-spec.md §4.2 B): exact rates (23.976 is 24000/1001),
 * SMPTE labels with drop-frame at 29.97 and 59.94, and pixel positions. It mirrors
 * src-python/vibecut_agent/core/timecode_math.py and is tested on the same vectors, so a label here is
 * the label the sidecar wrote.
 */
import type { RationalTime, SupportedRate, TimeRange } from "@vibecut/contracts";

export const SUPPORTED_RATES: readonly SupportedRate[] = [23.976, 24, 25, 29.97, 30, 50, 59.94, 60];
export const DROP_FRAME_RATES: readonly number[] = [29.97, 59.94];

/** An exact rate as numerator / denominator frames per second. */
export interface ExactRate {
  num: number;
  den: number;
}

const EXACT: Readonly<Record<string, ExactRate>> = {
  "23.976": { num: 24000, den: 1001 },
  "24": { num: 24, den: 1 },
  "25": { num: 25, den: 1 },
  "29.97": { num: 30000, den: 1001 },
  "30": { num: 30, den: 1 },
  "50": { num: 50, den: 1 },
  "59.94": { num: 60000, den: 1001 },
  "60": { num: 60, den: 1 },
};

export function exactRate(rate: number): ExactRate {
  const exact = EXACT[String(rate)];
  if (!exact) throw new RangeError(`${rate} fps is not a supported rate (${SUPPORTED_RATES.join(", ")})`);
  return exact;
}

export function rationalTime(value: number, rate: SupportedRate): RationalTime {
  exactRate(rate);
  return { OTIO_SCHEMA: "RationalTime.1", value, rate };
}

/** Exact seconds: value · den / num (no float rate in between). */
export function toSeconds(time: RationalTime): number {
  const { num, den } = exactRate(time.rate);
  return (time.value * den) / num;
}

/** A time at another rate, rounded to the nearest frame (halves up, as timecode_math does). */
export function rescale(time: RationalTime, rate: SupportedRate): RationalTime {
  if (time.rate === rate) return time;
  const from = exactRate(time.rate);
  const to = exactRate(rate);
  const frames = (time.value * from.den * to.num) / (from.num * to.den);
  return rationalTime(Math.floor(frames + 0.5), rate);
}

export function rangeEnd(range: TimeRange): RationalTime {
  const duration = rescale(range.duration, range.start_time.rate);
  return rationalTime(range.start_time.value + duration.value, range.start_time.rate);
}

/** x = round(value / rate · pxPerSec), with the exact rate. */
export function toPixels(time: RationalTime, pxPerSec: number): number {
  return Math.round(toSeconds(time) * pxPerSec);
}

function dropPerMinute(rate: number): number {
  // 2 labels a minute at 29.97, 4 at 59.94.
  return Math.floor(Math.round(rate) / 15);
}

/** `HH:MM:SS:FF`, or `HH:MM:SS;FF` drop-frame (the default at 29.97 and 59.94). */
export function toSmpte(time: RationalTime, dropFrame?: boolean): string {
  const rate = time.rate;
  exactRate(rate);
  const drop = dropFrame ?? DROP_FRAME_RATES.includes(rate);
  if (drop && !DROP_FRAME_RATES.includes(rate)) {
    throw new RangeError(`Drop-frame timecode is only for 29.97 and 59.94, not ${rate}`);
  }
  let frame = Math.round(time.value);
  if (frame < 0) throw new RangeError("Timecode can't be negative");
  const timebase = Math.round(rate);
  if (drop) {
    const d = dropPerMinute(rate);
    const perMinute = timebase * 60 - d;
    const perTenMinutes = timebase * 600 - d * 9;
    const tens = Math.floor(frame / perTenMinutes);
    const rest = frame % perTenMinutes;
    frame += d * 9 * tens;
    if (rest > d) frame += d * Math.floor((rest - d) / perMinute);
  }
  const pad = (n: number) => String(n).padStart(2, "0");
  const hours = Math.floor(frame / (timebase * 3600));
  let rest = frame % (timebase * 3600);
  const minutes = Math.floor(rest / (timebase * 60));
  rest %= timebase * 60;
  const seconds = Math.floor(rest / timebase);
  const frames = rest % timebase;
  return `${pad(hours)}:${pad(minutes)}:${pad(seconds)}${drop ? ";" : ":"}${pad(frames)}`;
}

const SMPTE = /^(\d{1,3})[:;.](\d{2})[:;.](\d{2})([:;.])(\d{2})$/;

/** A label's frame; `;` (or `.`) before the frames is drop-frame. */
export function fromSmpte(timecode: string, rate: SupportedRate): RationalTime {
  exactRate(rate);
  const match = SMPTE.exec(timecode.trim());
  if (!match) throw new RangeError(`${timecode} isn't a timecode (HH:MM:SS:FF)`);
  const [, h, m, s, separator, f] = match;
  const [hh, mm, ss, ff] = [h, m, s, f].map(Number);
  const drop = separator === ";" || separator === ".";
  if (drop && !DROP_FRAME_RATES.includes(rate)) throw new RangeError(`Drop-frame timecode is only for 29.97 and 59.94, not ${rate}`);
  const timebase = Math.round(rate);
  if (mm >= 60 || ss >= 60 || ff >= timebase) throw new RangeError(`${timecode} isn't a valid timecode at ${rate} fps`);
  const totalMinutes = hh * 60 + mm;
  let frame = (totalMinutes * 60 + ss) * timebase + ff;
  if (drop) {
    const d = dropPerMinute(rate);
    if (ss === 0 && ff < d && mm % 10 !== 0) throw new RangeError(`${timecode} is skipped in drop-frame timecode`);
    frame -= d * (totalMinutes - Math.floor(totalMinutes / 10));
  }
  return rationalTime(frame, rate);
}

/** "+8f" / "-14f": a frame delta for trim brackets. */
export function frameDelta(frames: number): string {
  return `${frames >= 0 ? "+" : "−"}${Math.abs(Math.round(frames))}f`;
}
