/**
 * The rooms that hand work on to each other (visualizer-spec.md §3.3), drawn as cable trays between them, and
 * `pointAt`, which places a packet along its path from desk to desk (PLAN.md, "The studio as an edit suite").
 */
import type { SubagentType } from "@vibecut/contracts";

export interface Point {
  x: number;
  y: number;
}

/** The conduits drawn even when idle: the bridge to every bay, and the hand-on routes of a cut. */
export const CONDUITS: readonly [SubagentType, SubagentType][] = [
  ["MASTER_ORCHESTRATOR", "INGEST_TRANSCRIBE"],
  ["MASTER_ORCHESTRATOR", "VISION_TAGGER"],
  ["MASTER_ORCHESTRATOR", "BROLL_RETRIEVER"],
  ["MASTER_ORCHESTRATOR", "PACING_CUTTER"],
  ["MASTER_ORCHESTRATOR", "AUDIO_ENGINEER"],
  ["MASTER_ORCHESTRATOR", "COLOR_GRADER"],
  ["INGEST_TRANSCRIBE", "BROLL_RETRIEVER"],
  ["VISION_TAGGER", "BROLL_RETRIEVER"],
  ["BROLL_RETRIEVER", "PACING_CUTTER"],
  ["AUDIO_ENGINEER", "PACING_CUTTER"],
  ["PACING_CUTTER", "COLOR_GRADER"],
  ["AUDIO_ENGINEER", "COLOR_GRADER"],
];

export function pathLength(path: readonly Point[]): number {
  let length = 0;
  for (let i = 1; i < path.length; i++) length += Math.hypot(path[i].x - path[i - 1].x, path[i].y - path[i - 1].y);
  return length;
}

/** The point `t` (0..1) of the way along `path`. */
export function pointAt(path: readonly Point[], t: number): Point {
  const total = pathLength(path);
  let remaining = Math.max(0, Math.min(1, t)) * total;
  for (let i = 1; i < path.length; i++) {
    const seg = Math.hypot(path[i].x - path[i - 1].x, path[i].y - path[i - 1].y);
    if (remaining <= seg || i === path.length - 1) {
      const f = seg === 0 ? 0 : Math.min(1, remaining / seg);
      return { x: path[i - 1].x + (path[i].x - path[i - 1].x) * f, y: path[i - 1].y + (path[i].y - path[i - 1].y) * f };
    }
    remaining -= seg;
  }
  return path[path.length - 1];
}
