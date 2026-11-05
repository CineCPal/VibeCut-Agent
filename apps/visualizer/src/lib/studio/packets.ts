/** Data-packet sprites (visualizer-spec.md §3.3): colour, size, and travel time by payload. */
import type { SubagentType } from "@vibecut/contracts";
import type { DataPacketSprite, PacketType } from "../../types/studio";

export const MIN_TRANSIT_MS = 350;
export const MAX_TRANSIT_MS = 900;
export const MAX_ACTIVE_PACKETS = 64;

const STYLE: Record<PacketType, { color: string; w: number; h: number }> = {
  PROMPT_TOKENS: { color: "#4a90d9", w: 8, h: 8 },
  CLIP_MANIFEST: { color: "#00C853", w: 10, h: 10 },
  VLM_TAGS: { color: "#00C853", w: 10, h: 10 },
  TRANSCRIPT_SLICES: { color: "#00C853", w: 10, h: 10 },
  OTIO_DELTA: { color: "#FFB300", w: 12, h: 8 },
  VALIDATION_TOKEN: { color: "#FFB300", w: 12, h: 8 },
  NLE_COMMIT_BATCH: { color: "#f43f5e", w: 12, h: 6 },
};

/** T = clamp(350 + 60·log10(max(1, bytes)), 350, 900). */
export function transitMs(payloadBytes: number): number {
  const t = MIN_TRANSIT_MS + 60 * Math.log10(Math.max(1, payloadBytes));
  return Math.min(MAX_TRANSIT_MS, Math.max(MIN_TRANSIT_MS, t));
}

let counter = 0;

export function makePacket(
  from: SubagentType,
  to: SubagentType,
  packetType: PacketType,
  payloadBytes: number,
  bornMs: number,
  label: string | null = null,
  keys: { from: string | null; to: string | null } = { from: null, to: null },
): DataPacketSprite {
  const style = STYLE[packetType];
  counter += 1;
  return {
    id: `pkt_${counter}`,
    from,
    to,
    packet_type: packetType,
    color: style.color,
    w: style.w,
    h: style.h,
    label,
    from_key: keys.from,
    to_key: keys.to,
    born_ms: bornMs,
    duration_ms: transitMs(payloadBytes),
  };
}

/** How far along its conduit a packet is (0..1), or null once it has arrived. */
export function packetProgress(packet: DataPacketSprite, nowMs: number): number | null {
  const t = (nowMs - packet.born_ms) / packet.duration_ms;
  if (t > 1) return null;
  return Math.max(0, t);
}
