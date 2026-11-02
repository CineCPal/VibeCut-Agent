/**
 * Conduits between bays (visualizer-spec.md §3.3): a 4-point orthogonal polyline from bay to bay whose
 * corners are cut at 45° by 16 px, so packets travel the retro way. `pointAt` places a packet along it.
 */
import type { SubagentType } from "@vibecut/contracts";
import type { StudioBayConfig } from "../../types/studio";
import { BAY_BY_SUBAGENT } from "./bays";

export const CHAMFER = 16;

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

function edgePoint(bay: StudioBayConfig, toward: Point): Point {
  const dx = toward.x - bay.x;
  const dy = toward.y - bay.y;
  // Leave from the side facing the other bay.
  if (Math.abs(dx) / bay.w >= Math.abs(dy) / bay.h) {
    return { x: bay.x + Math.sign(dx) * (bay.w / 2), y: bay.y };
  }
  return { x: bay.x, y: bay.y + Math.sign(dy) * (bay.h / 2) };
}

function chamfer(points: Point[]): Point[] {
  if (points.length < 3) return points;
  const out: Point[] = [points[0]];
  for (let i = 1; i < points.length - 1; i++) {
    const [a, b, c] = [points[i - 1], points[i], points[i + 1]];
    const inLen = Math.hypot(b.x - a.x, b.y - a.y);
    const outLen = Math.hypot(c.x - b.x, c.y - b.y);
    const cut = Math.min(CHAMFER, inLen / 2, outLen / 2);
    if (cut <= 0) {
      out.push(b);
      continue;
    }
    out.push({ x: b.x - ((b.x - a.x) / inLen) * cut, y: b.y - ((b.y - a.y) / inLen) * cut });
    out.push({ x: b.x + ((c.x - b.x) / outLen) * cut, y: b.y + ((c.y - b.y) / outLen) * cut });
  }
  out.push(points[points.length - 1]);
  return out;
}

const cache = new Map<string, Point[]>();

/** The conduit from one bay to another (the same route, reversed, the other way). */
export function conduitPath(from: SubagentType, to: SubagentType): Point[] {
  const key = `${from}>${to}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const a = BAY_BY_SUBAGENT[from];
  const b = BAY_BY_SUBAGENT[to];
  const start = edgePoint(a, b);
  const end = edgePoint(b, a);
  const horizontalFirst = start.y === a.y;
  const corners = horizontalFirst
    ? [start, { x: (start.x + end.x) / 2, y: start.y }, { x: (start.x + end.x) / 2, y: end.y }, end]
    : [start, { x: start.x, y: (start.y + end.y) / 2 }, { x: end.x, y: (start.y + end.y) / 2 }, end];
  const path = chamfer(corners);
  cache.set(key, path);
  return path;
}

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
