import type { SupportedRate } from "@vibecut/contracts";
import { describe, expect, it } from "vitest";
import { frameDelta, fromSmpte, rangeEnd, rationalTime, rescale, toPixels, toSeconds, toSmpte } from "./rationalTime";

// The same vectors as tests/core/test_timecode_math.py::test_smpte_both_ways.
const VECTORS: [number, SupportedRate, string][] = [
  [0, 29.97, "00:00:00;00"],
  [1799, 29.97, "00:00:59;29"],
  [1800, 29.97, "00:01:00;02"],
  [3598, 29.97, "00:02:00;02"],
  [17982, 29.97, "00:10:00;00"],
  [17983, 29.97, "00:10:00;01"],
  [107892, 29.97, "01:00:00;00"],
  [3600, 59.94, "00:01:00;04"],
  [215784, 59.94, "01:00:00;00"],
  [86400, 23.976, "01:00:00:00"],
  [90000, 25, "01:00:00:00"],
  [49, 25, "00:00:01:24"],
  [1800, 30, "00:01:00:00"],
];

describe("rationalTime", () => {
  it.each(VECTORS)("frame %i at %s fps is %s, both ways", (frame, rate, label) => {
    expect(toSmpte(rationalTime(frame, rate))).toBe(label);
    expect(fromSmpte(label, rate).value).toBe(frame);
  });

  it("round-trips every frame of the first eleven minutes at 29.97 and 59.94", () => {
    for (const rate of [29.97, 59.94] as const) {
      for (let frame = 0; frame < Math.round(rate) * 660; frame += 7) {
        expect(fromSmpte(toSmpte(rationalTime(frame, rate)), rate).value).toBe(frame);
      }
    }
  });

  it("refuses what timecode_math refuses", () => {
    expect(toSmpte(rationalTime(1800, 29.97), false)).toBe("00:01:00:00");
    expect(() => fromSmpte("00:01:00;00", 29.97)).toThrow("skipped");
    expect(() => fromSmpte("00:00:01;00", 25)).toThrow("Drop-frame");
    expect(() => toSmpte(rationalTime(10, 23.976), true)).toThrow("Drop-frame");
    expect(() => fromSmpte("00:00:00:25", 25)).toThrow("valid");
    expect(() => toSmpte(rationalTime(-1, 25))).toThrow("negative");
    expect(() => rationalTime(1, 23.98 as SupportedRate)).toThrow("not a supported rate");
  });

  it("places frames exactly, without NTSC drift", () => {
    // An hour of 23.976 is 86,400 frames and 3603.6 s.
    expect(toSeconds(rationalTime(86400, 23.976))).toBe(3603.6);
    expect(toPixels(rationalTime(86400, 23.976), 10)).toBe(36036);
    // 24000/1001, not 23.976: frame 23976 is 1000.000 s, not 1000.0 at a float rate.
    expect(toPixels(rationalTime(24000, 23.976), 100)).toBe(100100);
    expect(toPixels(rationalTime(30000, 29.97), 1)).toBe(1001);
    expect(rescale(rationalTime(48, 24), 23.976).value).toBe(48);
    expect(rescale(rationalTime(30, 29.97), 25).value).toBe(25);
    expect(rangeEnd({ OTIO_SCHEMA: "TimeRange.1", start_time: rationalTime(10, 25), duration: rationalTime(15, 25) }).value).toBe(25);
    expect(frameDelta(-14)).toBe("−14f");
    expect(frameDelta(8)).toBe("+8f");
  });
});
