/** The virtual studio's types (visualizer-spec.md §3). */
import type { SubagentType } from "@vibecut/contracts";

/** The avatar FSM's states (§3.2); each is a row of the 8x8 sprite atlas. */
export type AvatarState =
  | "IDLE"
  | "LISTENING"
  | "PROCESSING_THINKING"
  | "READING_ASSET"
  | "WRITING_OTIO"
  | "RENDERING"
  | "BLOCKED_ERROR"
  | "SUCCESS_CELEBRATE";

export const AVATAR_STATES: readonly AvatarState[] = [
  "IDLE",
  "LISTENING",
  "PROCESSING_THINKING",
  "READING_ASSET",
  "WRITING_OTIO",
  "RENDERING",
  "BLOCKED_ERROR",
  "SUCCESS_CELEBRATE",
];

export interface StudioBayConfig {
  bay: number;
  subagent: SubagentType;
  title: string;
  /** Logical anchor (the bay's centre) on the 1280x980 grid (§3.1, made taller)'s table. */
  x: number;
  y: number;
  w: number;
  h: number;
  accent: string;
  props: string;
}

/** One bay's live state, kept by the reducer. */
export interface StudioBayState {
  subagent: SubagentType;
  avatar: AvatarState;
  /** When the avatar entered its state (envelope ms). */
  since_ms: number;
  /** SUCCESS_CELEBRATE lasts until then, and the avatar is IDLE after. */
  celebrate_until_ms: number | null;
  active_task_id: string | null;
  agent_id: string | null;
  /** The overhead HUD badge's text. */
  hud: string;
  wait_reason: string | null;
  error_code: string | null;
  progress: number | null;
}

export type PacketType =
  | "PROMPT_TOKENS"
  | "CLIP_MANIFEST"
  | "TRANSCRIPT_SLICES"
  | "VLM_TAGS"
  | "OTIO_DELTA"
  | "VALIDATION_TOKEN"
  | "NLE_COMMIT_BATCH";

export interface DataPacketSprite {
  id: string;
  from: SubagentType;
  to: SubagentType;
  packet_type: PacketType;
  color: string;
  /** Sprite size in logical pixels. */
  w: number;
  h: number;
  label: string | null;
  /** Wall clock (performance-free, Date.now()) when it left, and how long it travels. */
  born_ms: number;
  duration_ms: number;
}
