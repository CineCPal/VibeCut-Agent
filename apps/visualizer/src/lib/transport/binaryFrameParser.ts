/**
 * VCTB binary frames (visualizer-spec.md §5.2 C): a 16-byte big-endian header (magic "VCTB", frame type
 * u8, channel u8, reserved u16, seq id u32, payload length u32), then the payload. Parsed with a DataView
 * over the socket's ArrayBuffer; the payload is a view into the same buffer (no copy).
 *
 * Waveform peaks (0x01) are int16 (min, max) pairs in little-endian order, as an Int16Array reads them on
 * every platform this runs on (the gateway packs them `<h`). Scrub audio (0x03) is 48 kHz mono s16le, the
 * same byte order.
 */
import { VCTB_HEADER_BYTES, VCTB_MAGIC, VctbFrameType } from "@vibecut/contracts";

export interface VctbFrame {
  frameType: number;
  channel: number;
  seqId: number;
  payload: Uint8Array;
}

export class VctbParseError extends Error {}

export function parseVctbFrame(data: ArrayBuffer | ArrayBufferView): VctbFrame {
  const view =
    data instanceof ArrayBuffer
      ? new DataView(data)
      : new DataView(data.buffer, data.byteOffset, data.byteLength);
  if (view.byteLength < VCTB_HEADER_BYTES) throw new VctbParseError("A VCTB frame has a 16-byte header");
  if (view.getUint32(0, false) !== VCTB_MAGIC) throw new VctbParseError("Not a VCTB frame");
  const length = view.getUint32(12, false);
  if (view.byteLength - VCTB_HEADER_BYTES !== length) {
    throw new VctbParseError("The VCTB frame's length doesn't match its payload");
  }
  return {
    frameType: view.getUint8(4),
    channel: view.getUint8(5),
    seqId: view.getUint32(8, false),
    payload: new Uint8Array(view.buffer, view.byteOffset + VCTB_HEADER_BYTES, length),
  };
}

/** Builds a frame (tests, and the mock source's waveform). */
export function packVctbFrame(frameType: number, channel: number, seqId: number, payload: Uint8Array): ArrayBuffer {
  const buffer = new ArrayBuffer(VCTB_HEADER_BYTES + payload.byteLength);
  const view = new DataView(buffer);
  view.setUint32(0, VCTB_MAGIC, false);
  view.setUint8(4, frameType);
  view.setUint8(5, channel);
  view.setUint16(6, 0, false);
  view.setUint32(8, seqId, false);
  view.setUint32(12, payload.byteLength, false);
  new Uint8Array(buffer, VCTB_HEADER_BYTES).set(payload);
  return buffer;
}

/** A scrub audio frame's samples in [-1, 1), for an AudioBuffer. */
export function scrubSamples(frame: VctbFrame): Float32Array {
  if (frame.frameType !== VctbFrameType.TIMELINE_SCRUB_AUDIO) return new Float32Array(0);
  const count = Math.floor(frame.payload.byteLength / 2);
  const view = new DataView(frame.payload.buffer, frame.payload.byteOffset, count * 2);
  const samples = new Float32Array(count);
  for (let i = 0; i < count; i++) samples[i] = view.getInt16(i * 2, true) / 32768;
  return samples;
}

/** A waveform frame's (min, max) pairs as plain numbers in [-1, 1]. */
export function waveformPeaks(frame: VctbFrame): number[] {
  if (frame.frameType !== VctbFrameType.AUDIO_WAVEFORM_PEAKS) return [];
  const count = Math.floor(frame.payload.byteLength / 2);
  const view = new DataView(frame.payload.buffer, frame.payload.byteOffset, count * 2);
  const peaks = new Array<number>(count);
  for (let i = 0; i < count; i++) peaks[i] = view.getInt16(i * 2, true) / 32767;
  return peaks;
}
