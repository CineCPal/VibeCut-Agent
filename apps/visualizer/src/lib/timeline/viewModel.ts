/**
 * The OTIO dock's lanes, built from the deltas only (PLAN.md, "Phase 22", V9: there is no fetch of the
 * timeline as it was). Each op of each delta, at its latest stage, is a clip on its track at its exact
 * RationalTime. V2, V1, A1 and A2 are always shown; any other track an op names is added (video above,
 * audio below).
 */
import type { DeltaOpSummary } from "@vibecut/contracts";
import { SUBAGENT_SHORT } from "../studio/bays";
import { rangeEnd, toPixels, toSeconds } from "../timecode/rationalTime";
import type { ClipDiffViewModel, MutationRecord, OtioTrackViewModel } from "../../types/timeline";
import type { SubagentType } from "@vibecut/contracts";

const TITLES: Record<string, string> = {
  V2: "B-Roll",
  V1: "A-Roll",
  A1: "Dialog",
  A2: "Music",
};

export const RAMP_SECONDS = 0.32;
export const DEFAULT_DUCK_DB = -12;
export const MIN_CLIP_PX = 3;

export function trackLabel(op: Pick<DeltaOpSummary, "track_kind" | "track_index">): string {
  return `${op.track_kind === "Video" ? "V" : "A"}${op.track_index}`;
}

export function buildTracks(mutations: Record<string, MutationRecord>, pxPerSec: number): OtioTrackViewModel[] {
  const lanes = new Map<string, OtioTrackViewModel>();
  const lane = (kind: "Video" | "Audio", index: number) => {
    const label = `${kind === "Video" ? "V" : "A"}${index}`;
    let track = lanes.get(label);
    if (!track) {
      track = { label, kind, index, title: TITLES[label] ?? (kind === "Video" ? "Video" : "Audio"), clips: [] };
      lanes.set(label, track);
    }
    return track;
  };
  lane("Video", 2);
  lane("Video", 1);
  lane("Audio", 1);
  lane("Audio", 2);
  const ordered = Object.values(mutations).sort((a, b) => a.first_seq_id - b.first_seq_id);
  for (const mutation of ordered) {
    for (const op of mutation.operations) {
      const start = op.timeline_range.start_time;
      const x = toPixels(start, pxPerSec);
      const end = toPixels(rangeEnd(op.timeline_range), pxPerSec);
      const clip: ClipDiffViewModel = {
        key: `${mutation.delta_id}:${op.op_id}`,
        op,
        delta_id: mutation.delta_id,
        stage: mutation.mutation_stage,
        task_id: mutation.task_id,
        agent_short: SUBAGENT_SHORT[mutation.subagent as SubagentType] ?? mutation.subagent,
        x,
        width: Math.max(MIN_CLIP_PX, end - x),
      };
      lane(op.track_kind, op.track_index).clips.push(clip);
    }
  }
  return [...lanes.values()].sort((a, b) =>
    a.kind !== b.kind ? (a.kind === "Video" ? -1 : 1) : a.kind === "Video" ? b.index - a.index : a.index - b.index,
  );
}

/** The end of the last op, in seconds (the ruler's length). */
export function timelineSeconds(mutations: Record<string, MutationRecord>): number {
  let end = 0;
  for (const m of Object.values(mutations)) {
    for (const op of m.operations) end = Math.max(end, toSeconds(rangeEnd(op.timeline_range)));
  }
  return end;
}

/**
 * The gain envelope of a duck (or a gain change) over a clip `width` x `height`: 0 dB, a ramp down to the
 * floor, the floor, a ramp back. dB maps linearly to the clip's height from 0 dB (10% down) to -48 dB
 * (the bottom).
 */
export function duckEnvelopePath(width: number, height: number, rampPx: number, floorDb: number, ramps = true): string {
  const y = (db: number) => Math.round((0.1 + (Math.min(0, Math.max(-48, -Math.abs(db))) / -48) * 0.9) * height * 100) / 100;
  const top = y(0);
  const floor = y(floorDb);
  if (!ramps) return `M 0 ${floor} L ${width} ${floor}`;
  const ramp = Math.min(rampPx, width / 2);
  return `M 0 ${top} L ${ramp} ${floor} L ${width - ramp} ${floor} L ${width} ${top}`;
}

/** The frames a trim takes off (negative) or adds: the timeline length against the source length. */
export function trimDeltaFrames(op: DeltaOpSummary): number | null {
  if (!op.source_range) return null;
  return op.timeline_range.duration.value - op.source_range.duration.value;
}
