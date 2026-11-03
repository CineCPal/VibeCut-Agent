import { describe, expect, it } from "vitest";
import { VctbFrameType } from "@vibecut/contracts";
import { packVctbFrame, parseVctbFrame, scrubSamples, VctbParseError, waveformPeaks } from "./binaryFrameParser";

describe("VCTB frames", () => {
  it("parse the 16-byte big-endian header without copying the payload", () => {
    const payload = new Uint8Array([0xff, 0xd8, 0x01, 0x02]);
    const buffer = packVctbFrame(VctbFrameType.VLM_CONTACT_STRIP_JPEG, 3, 0x01020304, payload);
    const bytes = new Uint8Array(buffer);
    expect([...bytes.slice(0, 4)]).toEqual([0x56, 0x43, 0x54, 0x42]);
    expect([...bytes.slice(8, 12)]).toEqual([1, 2, 3, 4]);
    const frame = parseVctbFrame(buffer);
    expect(frame).toMatchObject({ frameType: 2, channel: 3, seqId: 0x01020304 });
    expect([...frame.payload]).toEqual([...payload]);
    expect(frame.payload.buffer).toBe(buffer);
  });

  it("refuse frames that aren't VCTB or whose length is wrong", () => {
    const buffer = packVctbFrame(1, 0, 1, new Uint8Array(4));
    expect(() => parseVctbFrame(new ArrayBuffer(8))).toThrow(VctbParseError);
    const wrongMagic = new Uint8Array(buffer.slice(0));
    wrongMagic[0] = 0x4a;
    expect(() => parseVctbFrame(wrongMagic)).toThrow("Not a VCTB frame");
    expect(() => parseVctbFrame(buffer.slice(0, 18))).toThrow("length");
  });

  it("read waveform peaks as little-endian int16 pairs", () => {
    const pcm = new Uint8Array(new Int16Array([-32767, 32767, -16384, 16384]).buffer);
    const frame = parseVctbFrame(packVctbFrame(VctbFrameType.AUDIO_WAVEFORM_PEAKS, 2, 9, pcm));
    const peaks = waveformPeaks(frame);
    expect(peaks[0]).toBe(-1);
    expect(peaks[1]).toBe(1);
    expect(peaks[2]).toBeCloseTo(-0.5, 3);
    expect(waveformPeaks({ ...frame, frameType: 2 })).toEqual([]);
  });

  it("read scrub audio as little-endian int16 samples in [-1, 1)", () => {
    const pcm = new Uint8Array(new Int16Array([-32768, 16384, 0, 32767]).buffer);
    const frame = parseVctbFrame(packVctbFrame(VctbFrameType.TIMELINE_SCRUB_AUDIO, 1, 5, pcm));
    expect(Array.from(scrubSamples(frame))).toEqual([-1, 0.5, 0, 32767 / 32768]);
    expect(scrubSamples({ ...frame, frameType: VctbFrameType.AUDIO_WAVEFORM_PEAKS })).toHaveLength(0);
  });
});
