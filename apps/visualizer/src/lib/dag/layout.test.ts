import { describe, expect, it } from "vitest";
import {
  chooseRows,
  computeLayout,
  countCrossings,
  createLayoutMemo,
  fitScale,
  fnv1a,
  NODE_HEIGHT,
  NODE_WIDTH,
  rankNodes,
  sizeAt,
  topologyHash,
  type LayoutEdge,
  type LayoutNode,
  type NodePosition,
} from "./layout";

const n = (task_id: string, subagent_type: LayoutNode["subagent_type"] = "VISION_TAGGER"): LayoutNode => ({ task_id, subagent_type });
const e = (source_task_id: string, target_task_id: string): LayoutEdge => ({ source_task_id, target_task_id });

describe("the DAG layout", () => {
  it("ranks by longest path", () => {
    const nodes = [n("root", "MASTER_ORCHESTRATOR"), n("ing", "INGEST_TRANSCRIBE"), n("vlm"), n("vec", "BROLL_RETRIEVER"), n("cut", "PACING_CUTTER")];
    const edges = [e("root", "ing"), e("root", "vlm"), e("ing", "vec"), e("vlm", "vec"), e("vec", "cut"), e("root", "cut")];
    const { positions } = computeLayout(nodes, edges);
    expect(Object.fromEntries(Object.entries(positions).map(([id, p]) => [id, p.rank]))).toEqual({
      root: 0,
      ing: 1,
      vlm: 1,
      vec: 2,
      cut: 3,
    });
    for (const edge of edges) expect(positions[edge.target_task_id].rank).toBeGreaterThan(positions[edge.source_task_id].rank);
    expect(positions.vec.x).toBeGreaterThan(positions.ing.x);
  });

  it("survives a cycle by leaving out its back edge", () => {
    const result = computeLayout([n("a"), n("b"), n("c")], [e("a", "b"), e("b", "c"), e("c", "a")]);
    expect(result.backEdges).toEqual(["c>a"]);
    expect([result.positions.a.rank, result.positions.b.rank, result.positions.c.rank]).toEqual([0, 1, 2]);
  });

  it("orders ranks to cut crossings, grouping same-type workers", () => {
    // Inserted crosswise: a1->b2, a2->b1.
    const nodes = [n("a1"), n("a2"), n("b2"), n("b1")];
    const edges = [e("a1", "b2"), e("a2", "b1")];
    const naive = countCrossings([["a1", "a2"], ["b1", "b2"]], edges.map((x) => [x.source_task_id, x.target_task_id]));
    expect(naive).toBe(1);
    const { positions } = computeLayout(nodes, edges);
    const layers = [0, 1].map((r) =>
      Object.entries(positions).filter(([, p]) => p.rank === r).sort((x, y) => x[1].order - y[1].order).map(([id]) => id),
    );
    expect(countCrossings(layers, edges.map((x) => [x.source_task_id, x.target_task_id]))).toBe(0);

    const grouped = computeLayout(
      [n("r", "MASTER_ORCHESTRATOR"), n("x1", "AUDIO_ENGINEER"), n("y1", "INGEST_TRANSCRIBE"), n("x2", "AUDIO_ENGINEER")],
      [e("r", "x1"), e("r", "y1"), e("r", "x2")],
    ).positions;
    expect(Math.abs(grouped.x1.order - grouped.x2.order)).toBe(1);
    expect(grouped.y1.order).toBe(0);
  });

  it("runs only when the topology changes", () => {
    const memo = createLayoutMemo();
    const nodes = [n("a"), n("b")];
    const edges = [e("a", "b")];
    const first = memo(nodes, edges);
    // Same ids, new objects (as a metrics update makes): no new layout.
    expect(memo([n("b"), n("a")], [e("a", "b")])).toBe(first);
    expect(memo.runs).toBe(1);
    memo([...nodes, n("c")], [...edges, e("b", "c")]);
    expect(memo.runs).toBe(2);
    expect(topologyHash(nodes, edges)).toMatch(/^[0-9a-f]{8}$/);
    expect(fnv1a("")).toBe("811c9dc5");
    expect(fnv1a("a")).toBe("e40c292c");
  });

  // A run as the orchestrator makes it: the supervisor, and every task its child (2026-11-02: 16 tasks).
  const run = (tasks: number) => {
    const nodes = [n("root", "MASTER_ORCHESTRATOR"), ...Array.from({ length: tasks }, (_, i) => n(`t${String(i).padStart(2, "0")}`))];
    return { nodes, edges: nodes.slice(1).map((t) => e("root", t.task_id)) };
  };
  const overlaps = (a: NodePosition, b: NodePosition) =>
    a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

  it("wraps a tall rank into columns for a wide pane, so it shows larger", () => {
    const { nodes, edges } = run(16);
    const { layers } = rankNodes(nodes, edges);
    const column = sizeAt(layers, 16);
    expect(column).toEqual({ width: 488, height: 1956 });
    const rows = chooseRows(layers, 900, 400);
    expect(rows).toBe(4);
    const wrapped = computeLayout(nodes, edges, rows);
    expect(fitScale(wrapped.width, wrapped.height, 900, 400)).toBeGreaterThan(3 * fitScale(column.width, column.height, 900, 400));
    const tasks = nodes.slice(1).map((t) => wrapped.positions[t.task_id]);
    expect(new Set(tasks.map((p) => p.x)).size).toBe(4);
    expect(new Set(tasks.map((p) => p.y)).size).toBe(4);
    // Filled top to bottom, then the next column; all right of the supervisor; none on another.
    expect(wrapped.positions.t01.x).toBe(wrapped.positions.t00.x);
    expect(wrapped.positions.t04.x).toBeGreaterThan(wrapped.positions.t03.x);
    for (const p of tasks) expect(p.x).toBeGreaterThan(wrapped.positions.root.x + NODE_WIDTH);
    const all = Object.values(wrapped.positions);
    for (let i = 0; i < all.length; i++) for (let j = i + 1; j < all.length; j++) expect(overlaps(all[i], all[j])).toBe(false);
    expect(wrapped.height).toBe(4 * NODE_HEIGHT + 3 * 28);
    expect(wrapped.positions.root.y).toBe((wrapped.height - NODE_HEIGHT) / 2);
  });

  it("splits a rank evenly, keeps one column in a tall pane, and every rank whole before it's measured", () => {
    const { nodes, edges } = run(10);
    const { layers } = rankNodes(nodes, edges);
    // 10 at 4 rows: 3 columns of 4, 4 and 2.
    const ys = computeLayout(nodes, edges, 4).positions;
    const columns = new Map<number, number>();
    for (const t of nodes.slice(1)) columns.set(ys[t.task_id].x, (columns.get(ys[t.task_id].x) ?? 0) + 1);
    expect([...columns.values()]).toEqual([4, 4, 2]);
    expect(chooseRows(layers, 400, 3000)).toBe(10);
    expect(chooseRows(layers, 0, 0)).toBe(10);
  });

  it("places again for a new pane size without ranking again", () => {
    const memo = createLayoutMemo();
    const { nodes, edges } = run(16);
    const tall = memo(nodes, edges);
    expect(tall.rows).toBe(16);
    const wide = memo(nodes, edges, 900, 400);
    expect(wide.rows).toBe(4);
    expect(memo(nodes, edges, 900, 400)).toBe(wide);
    expect(memo.runs).toBe(1);
  });
});
