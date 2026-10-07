import { describe, expect, it } from "vitest";
import { positionLabel, secondsFromLink, timecodeToFrames, timecodeToSeconds } from "./timecode";
import { systemInstruction } from "./prompt";

describe("timecode (Phase 8e)", () => {
  it("reads t: links and nothing else", () => {
    expect(secondsFromLink("t:83.4")).toBe(83.4);
    expect(secondsFromLink("t:12")).toBe(12);
    expect(secondsFromLink("t:-3")).toBeNull();
    expect(secondsFromLink("https://t:3")).toBeNull();
    expect(secondsFromLink(undefined)).toBeNull();
  });

  it("places non-drop timecodes on the timeline from its start", () => {
    expect(timecodeToSeconds("01:00:12:10", { fps: 25, startTimecode: "01:00:00:00" })).toBeCloseTo(12.4);
    expect(timecodeToSeconds("00:00:01:12", { fps: 23.976, startTimecode: "00:00:00:00" })).toBeCloseTo(36 / 23.976);
    // Before the timeline starts, or a frame the rate doesn't have.
    expect(timecodeToSeconds("00:59:59:00", { fps: 25, startTimecode: "01:00:00:00" })).toBeNull();
    expect(timecodeToSeconds("01:00:00:25", { fps: 25, startTimecode: "01:00:00:00" })).toBeNull();
  });

  it("counts drop-frame timecodes at 29.97", () => {
    // 00:01:00;02 is the first frame of minute 1 (two numbers dropped), 1800 frames in.
    expect(timecodeToFrames("00:01:00;02", 29.97)).toBe(1800);
    expect(timecodeToFrames("00:01:00;00", 29.97)).toBeNull();
    // Every tenth minute keeps its numbers: 10 minutes is 17982 frames.
    expect(timecodeToFrames("00:10:00;00", 29.97)).toBe(17982);
    // A colon means non-drop even at 29.97.
    expect(timecodeToFrames("00:01:00:00", 29.97)).toBe(1800);
  });

  it("labels positions as minutes and seconds", () => {
    expect(positionLabel(83.4)).toBe("1:23.4");
    expect(positionLabel(5)).toBe("0:05.0");
    expect(positionLabel(3723.45)).toBe("1:02:03.5");
  });

  it("asks the agent to link timeline positions", () => {
    expect(systemInstruction("resolve")).toContain("[1:23.4](t:83.4)");
  });
});
