/**
 * The DAG's layered layout (visualizer-spec.md §2.1), a small Sugiyama:
 *
 * 1. Rank: 0 for a node with no incoming edge, else 1 + the highest rank of its predecessors (longest
 *    path). Back edges found by a DFS are ignored, so a cycle can't hang it.
 * 2. Order within each rank: down and up barycenter sweeps (the median position of a node's neighbours
 *    in the next rank), ties broken by SubagentType ordinal so same-type workers stay together, then id.
 * 3. Coordinates: ranks left to right. A rank taller than `rows` cards wraps into as many columns side by
 *    side as it needs, filled top to bottom and evenly, each column centred vertically. `chooseRows` picks
 *    `rows` for the panel's shape: a run's tasks are mostly one rank (all the supervisor's children), and
 *    one column of them was too tall to read at any zoom that fit it (2026-11-02: 16 tasks, 488 x 1956).
 *
 * `createLayoutMemo` caches the ranking by an FNV-1a hash of the sorted node and edge ids: it runs when a
 * node or edge is added, never when a node's metrics or progress change. Placing is cheap and runs again
 * when the panel's size changes the rows.
 */
import type { SubagentType } from "@vibecut/contracts";
import { SUBAGENT_ORDER } from "../studio/bays";

export const NODE_WIDTH = 208;
export const NODE_HEIGHT = 96;
export const RANK_GAP = 72;
export const ROW_GAP = 28;
/** Between the columns one rank wraps into: closer than ranks, so a rank reads as one group. */
export const WRAP_GAP = 28;
/** The margin fit-to-view keeps around the graph. */
export const FIT_PAD = 32;
/** The most fit-to-view zooms in. */
export const FIT_MAX_ZOOM = 1.25;

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
  /** The most cards a column holds. */
  rows: number;
}

/** Ranks and their order (steps 1-2): what the topology decides. */
export interface Ranking {
  hash: string;
  layers: string[][];
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

export function rankNodes(nodes: readonly LayoutNode[], edges: readonly LayoutEdge[]): Ranking {
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

  return { hash, layers: best, backEdges: [...back] };
}

const tallestOf = (layers: readonly string[][]) => Math.max(1, ...layers.map((l) => l.length));
const stack = (cards: number, size: number, gap: number) => cards * size + Math.max(0, cards - 1) * gap;

/** How many columns a rank of `count` cards wraps into at `rows`, and how many go in each. */
function wrap(count: number, rows: number): { columns: number; perColumn: number } {
  const columns = Math.max(1, Math.ceil(count / rows));
  return { columns, perColumn: Math.max(1, Math.ceil(count / columns)) };
}

/** The graph's size at `rows`. */
export function sizeAt(layers: readonly string[][], rows: number): { width: number; height: number } {
  let width = 0;
  layers.forEach((layer, r) => {
    const { columns } = wrap(layer.length, rows);
    width += (r ? RANK_GAP : 0) + stack(columns, NODE_WIDTH, WRAP_GAP);
  });
  const tallest = Math.max(1, ...layers.map((l) => Math.min(l.length, wrap(l.length, rows).perColumn)));
  return { width, height: stack(tallest, NODE_HEIGHT, ROW_GAP) };
}

/** The zoom fit-to-view gives a `width` x `height` graph in a `boxW` x `boxH` box (before clamping). */
export function fitScale(width: number, height: number, boxW: number, boxH: number): number {
  if (width <= 0 || height <= 0 || boxW <= 0 || boxH <= 0) return 1;
  return Math.min((boxW - 2 * FIT_PAD) / width, (boxH - 2 * FIT_PAD) / height, FIT_MAX_ZOOM);
}

/** The rows that show the graph largest in the box; every rank in one column when the box isn't known. */
export function chooseRows(layers: readonly string[][], boxW: number, boxH: number): number {
  const tallest = tallestOf(layers);
  if (boxW <= 2 * FIT_PAD || boxH <= 2 * FIT_PAD) return tallest;
  let best = tallest;
  let bestScale = -Infinity;
  // From the most rows down, so a tie keeps fewer columns. Rows that wrap the same way (16 cards at 5 rows
  // make 4 columns of 4) count as the rows the columns hold.
  for (let rows = tallest; rows >= 1; rows--) {
    const held = Math.max(1, ...layers.map((l) => Math.min(l.length, wrap(l.length, rows).perColumn)));
    const { width, height } = sizeAt(layers, held);
    const scale = fitScale(width, height, boxW, boxH);
    if (scale > bestScale + 1e-9) {
      best = held;
      bestScale = scale;
    }
  }
  return best;
}

/** Step 3: coordinates for a ranking at `rows` cards a column. */
export function placeLayers(ranking: Ranking, rows: number): LayoutResult {
  const { layers } = ranking;
  const limit = Math.max(1, Math.min(Math.floor(rows), tallestOf(layers)));
  const { width, height } = sizeAt(layers, limit);
  const positions: Record<string, NodePosition> = {};
  let left = 0;
  layers.forEach((layer, r) => {
    const { columns, perColumn } = wrap(layer.length, limit);
    layer.forEach((id, order) => {
      const column = Math.floor(order / perColumn);
      const inColumn = Math.min(perColumn, layer.length - column * perColumn);
      const top = (height - stack(inColumn, NODE_HEIGHT, ROW_GAP)) / 2;
      positions[id] = {
        rank: r,
        order,
        x: left + column * (NODE_WIDTH + WRAP_GAP),
        y: top + (order % perColumn) * (NODE_HEIGHT + ROW_GAP),
        width: NODE_WIDTH,
        height: NODE_HEIGHT,
      };
    });
    left += stack(columns, NODE_WIDTH, WRAP_GAP) + RANK_GAP;
  });
  return { hash: ranking.hash, positions, width, height, backEdges: ranking.backEdges, rows: limit };
}

/** The whole layout. `rows` defaults to every rank in one column. */
export function computeLayout(nodes: readonly LayoutNode[], edges: readonly LayoutEdge[], rows?: number): LayoutResult {
  const ranking = rankNodes(nodes, edges);
  return placeLayers(ranking, rows ?? tallestOf(ranking.layers));
}

export interface LayoutMemo {
  /** The layout for the box (`boxW` x `boxH`, 0 when not known yet). */
  (nodes: readonly LayoutNode[], edges: readonly LayoutEdge[], boxW?: number, boxH?: number): LayoutResult;
  /** How many times the ranking actually ran. */
  runs: number;
}

/** The ranking runs only when the topology hash changes; placing, only when it or the rows change. */
export function createLayoutMemo(): LayoutMemo {
  let ranking: Ranking | null = null;
  let last: LayoutResult | null = null;
  const memo = ((nodes: readonly LayoutNode[], edges: readonly LayoutEdge[], boxW = 0, boxH = 0) => {
    const hash = topologyHash(nodes, edges);
    if (!ranking || ranking.hash !== hash) {
      memo.runs += 1;
      ranking = rankNodes(nodes, edges);
      last = null;
    }
    const rows = chooseRows(ranking.layers, boxW, boxH);
    if (!last || last.rows !== rows) last = placeLayers(ranking, rows);
    return last;
  }) as LayoutMemo;
  memo.runs = 0;
  return memo;
}
