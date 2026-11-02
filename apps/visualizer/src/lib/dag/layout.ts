/**
 * The DAG's layered layout (visualizer-spec.md §2.1), a small Sugiyama:
 *
 * 1. Rank: 0 for a node with no incoming edge, else 1 + the highest rank of its predecessors (longest
 *    path). Back edges found by a DFS are ignored, so a cycle can't hang it.
 * 2. Order within each rank: down and up barycenter sweeps (the median position of a node's neighbours
 *    in the next rank), ties broken by SubagentType ordinal so same-type workers stay together, then id.
 * 3. Coordinates: ranks left to right, each rank centred vertically.
 *
 * `createLayoutMemo` caches the result by an FNV-1a hash of the sorted node and edge ids: the layout runs
 * when a node or edge is added, never when a node's metrics or progress change.
 */
import type { SubagentType } from "@vibecut/contracts";
import { SUBAGENT_ORDER } from "../studio/bays";

export const NODE_WIDTH = 208;
export const NODE_HEIGHT = 96;
export const RANK_GAP = 72;
export const ROW_GAP = 28;

export interface LayoutNode {
  task_id: string;
  subagent_type: SubagentType;
}

export interface LayoutEdge {
  source_task_id: string;
  target_task_id: string;
}

export interface NodePosition {
  rank: number;
  order: number;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface LayoutResult {
  hash: string;
  positions: Record<string, NodePosition>;
  width: number;
  height: number;
  /** Edges left out of ranking because they close a cycle. */
  backEdges: string[];
}

/** FNV-1a (32-bit) of a string, as 8 hex digits. */
export function fnv1a(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

export function topologyHash(nodes: readonly LayoutNode[], edges: readonly LayoutEdge[]): string {
  const nodeIds = nodes.map((n) => n.task_id).sort();
  const edgeIds = edges.map((e) => `${e.source_task_id}>${e.target_task_id}`).sort();
  return fnv1a(`${nodeIds.join("|")}#${edgeIds.join("|")}`);
}

function uniqueEdges(nodes: readonly LayoutNode[], edges: readonly LayoutEdge[]): [string, string][] {
  const known = new Set(nodes.map((n) => n.task_id));
  const seen = new Set<string>();
  const out: [string, string][] = [];
  for (const e of edges) {
    if (e.source_task_id === e.target_task_id) continue;
    if (!known.has(e.source_task_id) || !known.has(e.target_task_id)) continue;
    const key = `${e.source_task_id}>${e.target_task_id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push([e.source_task_id, e.target_task_id]);
  }
  return out;
}

function tieKey(node: LayoutNode): string {
  return `${String(SUBAGENT_ORDER[node.subagent_type] ?? 9).padStart(2, "0")}:${node.task_id}`;
}

/** Edge crossings between adjacent ranks (for tests and tuning). */
export function countCrossings(layers: string[][], edges: readonly [string, string][]): number {
  const position = new Map<string, number>();
  const rankOf = new Map<string, number>();
  layers.forEach((layer, r) => layer.forEach((id, i) => {
    position.set(id, i);
    rankOf.set(id, r);
  }));
  let crossings = 0;
  for (let r = 0; r + 1 < layers.length; r++) {
    const between = edges
      .filter(([s, t]) => rankOf.get(s) === r && rankOf.get(t) === r + 1)
      .map(([s, t]) => [position.get(s) as number, position.get(t) as number] as const);
    for (let i = 0; i < between.length; i++) {
      for (let j = i + 1; j < between.length; j++) {
        const [a1, b1] = between[i];
        const [a2, b2] = between[j];
        if ((a1 - a2) * (b1 - b2) < 0) crossings += 1;
      }
    }
  }
  return crossings;
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

export function computeLayout(nodes: readonly LayoutNode[], edges: readonly LayoutEdge[]): LayoutResult {
  const hash = topologyHash(nodes, edges);
  const byId = new Map(nodes.map((n) => [n.task_id, n]));
  const pairs = uniqueEdges(nodes, edges);
  const out = new Map<string, string[]>();
  for (const n of nodes) out.set(n.task_id, []);
  for (const [s, t] of pairs) out.get(s)?.push(t);

  // Back edges by DFS (iterative), visiting in a stable order.
  const state = new Map<string, 0 | 1 | 2>();
  const back = new Set<string>();
  const ordered = [...nodes].sort((a, b) => tieKey(a).localeCompare(tieKey(b)));
  for (const start of ordered) {
    if (state.get(start.task_id)) continue;
    const stack: [string, number][] = [[start.task_id, 0]];
    state.set(start.task_id, 1);
    while (stack.length) {
      const top = stack[stack.length - 1];
      const children = out.get(top[0]) ?? [];
      if (top[1] < children.length) {
        const child = children[top[1]];
        top[1] += 1;
        const seen = state.get(child) ?? 0;
        if (seen === 1) back.add(`${top[0]}>${child}`);
        else if (seen === 0) {
          state.set(child, 1);
          stack.push([child, 0]);
        }
      } else {
        state.set(top[0], 2);
        stack.pop();
      }
    }
  }
  const forward = pairs.filter(([s, t]) => !back.has(`${s}>${t}`));
  const preds = new Map<string, string[]>();
  const succs = new Map<string, string[]>();
  const indegree = new Map<string, number>();
  for (const n of nodes) {
    preds.set(n.task_id, []);
    succs.set(n.task_id, []);
    indegree.set(n.task_id, 0);
  }
  for (const [s, t] of forward) {
    preds.get(t)?.push(s);
    succs.get(s)?.push(t);
    indegree.set(t, (indegree.get(t) ?? 0) + 1);
  }

  // Longest-path ranks in topological order (Kahn).
  const rank = new Map<string, number>();
  const queue = ordered.filter((n) => indegree.get(n.task_id) === 0).map((n) => n.task_id);
  for (const id of queue) rank.set(id, 0);
  for (let i = 0; i < queue.length; i++) {
    const id = queue[i];
    for (const next of succs.get(id) ?? []) {
      rank.set(next, Math.max(rank.get(next) ?? 0, (rank.get(id) ?? 0) + 1));
      const left = (indegree.get(next) ?? 0) - 1;
      indegree.set(next, left);
      if (left === 0) queue.push(next);
    }
  }

  const layers: string[][] = [];
  for (const n of ordered) {
    const r = rank.get(n.task_id) ?? 0;
    (layers[r] ??= []).push(n.task_id);
  }
  for (let r = 0; r < layers.length; r++) layers[r] ??= [];

  const sweep = (layer: string[], neighbours: Map<string, string[]>, positions: Map<string, number>) => {
    const keyed = layer.map((id, index) => {
      const m = median((neighbours.get(id) ?? []).filter((x) => positions.has(x)).map((x) => positions.get(x) as number));
      return { id, key: m ?? index, tie: tieKey(byId.get(id) as LayoutNode) };
    });
    keyed.sort((a, b) => a.key - b.key || a.tie.localeCompare(b.tie));
    return keyed.map((k) => k.id);
  };
  const positionsOf = (layer: string[]) => new Map(layer.map((id, i) => [id, i]));
  let best = layers.map((l) => [...l]);
  let bestCrossings = countCrossings(best, forward);
  for (let pass = 0; pass < 4 && bestCrossings > 0; pass++) {
    const next = best.map((l) => [...l]);
    for (let r = 1; r < next.length; r++) next[r] = sweep(next[r], preds, positionsOf(next[r - 1]));
    for (let r = next.length - 2; r >= 0; r--) next[r] = sweep(next[r], succs, positionsOf(next[r + 1]));
    const crossings = countCrossings(next, forward);
    if (crossings < bestCrossings) {
      best = next;
      bestCrossings = crossings;
    }
  }

  const tallest = Math.max(1, ...best.map((l) => l.length));
  const height = tallest * NODE_HEIGHT + (tallest - 1) * ROW_GAP;
  const positions: Record<string, NodePosition> = {};
  best.forEach((layer, r) => {
    const layerHeight = layer.length * NODE_HEIGHT + Math.max(0, layer.length - 1) * ROW_GAP;
    const top = (height - layerHeight) / 2;
    layer.forEach((id, order) => {
      positions[id] = {
        rank: r,
        order,
        x: r * (NODE_WIDTH + RANK_GAP),
        y: top + order * (NODE_HEIGHT + ROW_GAP),
        width: NODE_WIDTH,
        height: NODE_HEIGHT,
      };
    });
  });
  return {
    hash,
    positions,
    width: Math.max(0, best.length * (NODE_WIDTH + RANK_GAP) - RANK_GAP),
    height,
    backEdges: [...back],
  };
}

export interface LayoutMemo {
  (nodes: readonly LayoutNode[], edges: readonly LayoutEdge[]): LayoutResult;
  /** How many times the layout actually ran. */
  runs: number;
}

/** `computeLayout`, run only when the topology hash changes. */
export function createLayoutMemo(): LayoutMemo {
  let last: LayoutResult | null = null;
  const memo = ((nodes: readonly LayoutNode[], edges: readonly LayoutEdge[]) => {
    const hash = topologyHash(nodes, edges);
    if (last && last.hash === hash) return last;
    memo.runs += 1;
    last = computeLayout(nodes, edges);
    return last;
  }) as LayoutMemo;
  memo.runs = 0;
  return memo;
}
