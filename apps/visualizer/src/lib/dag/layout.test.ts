import { describe, expect, it } from "vitest";
import { computeLayout, countCrossings, createLayoutMemo, fnv1a, topologyHash, type LayoutEdge, type LayoutNode } from "./layout";

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
});
