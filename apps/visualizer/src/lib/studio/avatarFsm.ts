/**
 * The avatar state machine (visualizer-spec.md §3.2), driven by envelopes. `avatarOnEvent` is the
 * transition for one envelope at its bay; `effectiveAvatar` adds the two timed rules at render time: the
 * 1.2 s success badge settles to IDLE, and waiting on the GPU lock for over 3 s shows as blocked.
 */
import type { SubagentType, TelemetryEnvelope } from "@vibecut/contracts";
import type { AvatarState, StudioBayState } from "../../types/studio";

export const CELEBRATE_MS = 1200;
export const GPU_WAIT_BLOCKED_MS = 3000;

/** Sprite row, frame rate and halo per state (§3.2's table). */
export const AVATAR_ANIMATION: Readonly<Record<AvatarState, { row: number; fps: number; halo: string }>> = {
  IDLE: { row: 0, fps: 6, halo: "#72808A" },
  LISTENING: { row: 1, fps: 8, halo: "#4a90d9" },
  PROCESSING_THINKING: { row: 2, fps: 12, halo: "#4a90d9" },
  READING_ASSET: { row: 3, fps: 12, halo: "#38bdf8" },
  WRITING_OTIO: { row: 4, fps: 12, halo: "#FFB300" },
  RENDERING: { row: 5, fps: 16, halo: "#00C853" },
  BLOCKED_ERROR: { row: 6, fps: 6, halo: "#FF5252" },
  SUCCESS_CELEBRATE: { row: 7, fps: 12, halo: "#00C853" },
};

export function idleBay(subagent: SubagentType): StudioBayState {
  return {
    subagent,
    avatar: "IDLE",
    since_ms: 0,
    celebrate_until_ms: null,
    active_task_id: null,
    agent_id: null,
    hud: "READY",
    wait_reason: null,
    error_code: null,
    progress: null,
  };
}

const WRITING_TOOLS = /propose_otio_delta/;
const RENDERING_TOOLS = /commit|ffmpeg|sync_audio|render|nle|detect_media_boundaries|loudness/;

/** The state a tool call puts its worker in. */
export function toolAvatar(toolName: string): AvatarState {
  if (WRITING_TOOLS.test(toolName)) return "WRITING_OTIO";
  if (RENDERING_TOOLS.test(toolName)) return "RENDERING";
  return "READING_ASSET";
}

function enter(bay: StudioBayState, avatar: AvatarState, at: number, hud: string): void {
  if (bay.avatar !== avatar) bay.since_ms = at;
  bay.avatar = avatar;
  bay.hud = hud;
  if (avatar !== "SUCCESS_CELEBRATE") bay.celebrate_until_ms = null;
  if (avatar !== "LISTENING") bay.wait_reason = null;
  if (avatar !== "BLOCKED_ERROR") bay.error_code = null;
}

/** Applies one envelope to the bay of its own subagent (mutates `bay`). */
export function avatarOnEvent(bay: StudioBayState, env: TelemetryEnvelope): void {
  const at = env.timestamp_ms;
  const p = env.payload;
  bay.agent_id = env.agent_id;
  switch (p.kind) {
    case "SPAWN":
      bay.active_task_id = p.task_id;
      bay.progress = null;
      enter(bay, "PROCESSING_THINKING", at, "[...]");
      break;
    case "PLANNING":
      bay.active_task_id = p.task_id;
      enter(bay, "PROCESSING_THINKING", at, "[...]");
      break;
    case "WAITING_UPSTREAM":
      enter(bay, "LISTENING", at, p.wait_reason === "GPU_METAL_LOCK" ? "GPU LOCK" : `WAIT: ${p.blocking_task_ids[0] ?? "upstream"}`);
      bay.wait_reason = p.wait_reason;
      break;
    case "TOOL_INVOCATION": {
      bay.active_task_id = p.task_id;
      const next = toolAvatar(p.tool_name);
      enter(bay, next, at, next === "WRITING_OTIO" ? "OTIO Δ" : next === "RENDERING" ? "NLE SYNC" : "0%");
      break;
    }
    case "BATCH_PROGRESS": {
      bay.progress = p.fraction;
      if (p.fraction >= 1) {
        enter(bay, "PROCESSING_THINKING", at, "[...]");
      } else if (bay.avatar !== "WRITING_OTIO" && bay.avatar !== "RENDERING") {
        enter(bay, "READING_ASSET", at, `${Math.round(p.fraction * 100)}%`);
      }
      break;
    }
    case "STREAM_CHUNK":
      if (bay.avatar === "IDLE" || bay.avatar === "LISTENING") enter(bay, "PROCESSING_THINKING", at, "[...]");
      if (bay.avatar === "PROCESSING_THINKING") bay.hud = `[...] ${p.accumulated_tokens} tok`;
      break;
    case "MUTATION_EMITTED":
      if (p.mutation_stage === "PROPOSED") {
        enter(bay, "WRITING_OTIO", at, `OTIO Δ ${p.operations.length} ops`);
      } else if (p.mutation_stage === "ROLLED_BACK") {
        enter(bay, "BLOCKED_ERROR", at, "ROLLED BACK");
        bay.error_code = "NLE_ROLLBACK_EXECUTED";
      } else {
        enter(bay, "RENDERING", at, p.mutation_stage === "COMMITTED" ? "NLE SYNC ✓" : "VALIDATED");
      }
      break;
    case "COMPLETED":
      enter(bay, "SUCCESS_CELEBRATE", at, `✓ ${Math.round(p.latency_ms)}ms`);
      bay.celebrate_until_ms = at + CELEBRATE_MS;
      bay.progress = null;
      break;
    case "FAILED":
      enter(bay, "BLOCKED_ERROR", at, `[!] ${p.error_code}`);
      bay.error_code = p.error_code;
      break;
    default:
      break;
  }
}

/** A handoff arriving at a bay: an idle worker turns to listen. */
export function avatarOnInbound(bay: StudioBayState, env: TelemetryEnvelope): void {
  if (env.payload.kind !== "CONTEXT_HANDOFF") return;
  if (bay.avatar === "IDLE" || bay.avatar === "SUCCESS_CELEBRATE") {
    enter(bay, "LISTENING", env.timestamp_ms, `← ${env.payload.packet_type}`);
  }
}

/** The state to draw at `nowMs`, with the timed rules applied. */
export function effectiveAvatar(bay: StudioBayState, nowMs: number): AvatarState {
  if (bay.avatar === "SUCCESS_CELEBRATE" && bay.celebrate_until_ms !== null && nowMs >= bay.celebrate_until_ms) {
    return "IDLE";
  }
  if (bay.avatar === "LISTENING" && bay.wait_reason === "GPU_METAL_LOCK" && nowMs - bay.since_ms > GPU_WAIT_BLOCKED_MS) {
    return "BLOCKED_ERROR";
  }
  return bay.avatar;
}
