/** The OTIO dock's view models (visualizer-spec.md §4.2 B). */
import type { DeltaOpSummary, SupportedRate } from "@vibecut/contracts";

export type MutationStage = "PROPOSED" | "VALIDATED" | "COMMITTED" | "ROLLED_BACK";

/** One delta as last seen, with its ops. */
export interface MutationRecord {
  delta_id: string;
  task_id: string;
  subagent: string;
  mutation_stage: MutationStage;
  validation_token: string | null;
  target_host: "premiere" | "resolve";
  target_timeline: string;
  timeline_fps: SupportedRate;
  narrative_rationale: string;
  operations: DeltaOpSummary[];
  seq_id: number;
  /** The seq of the event that made it PROPOSED, for the entrance flash. */
  first_seq_id: number;
}

/** One op drawn on a lane. */
export interface ClipDiffViewModel {
  key: string;
  op: DeltaOpSummary;
  delta_id: string;
  stage: MutationStage;
  task_id: string;
  /** e.g. "CUTTER" for the attribution pill. */
  agent_short: string;
  /** Pixel position and width on the lane. */
  x: number;
  width: number;
}

export interface OtioTrackViewModel {
  /** "V2", "V1", "A1", "A2", … */
  label: string;
  kind: "Video" | "Audio";
  index: number;
  title: string;
  clips: ClipDiffViewModel[];
}
