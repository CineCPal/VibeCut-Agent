/**
 * The execution DAG (visualizer-spec.md §2.1, §4.2): SVG edges under HTML node cards, laid out by
 * lib/dag/layout.ts, shaped for this pane's size (a tall rank wraps into columns; the pane's size goes to
 * the store). Wheel zooms (0.1x to 4x) around the pointer; dragging with the middle button, or with Space
 * held, pans; F fits the graph. Below COMPACT_BELOW, cards show only what reads at that size: avatar,
 * label and status colour, the label kept readable. Edge styles: a spawn parent is dashed #30363D, a data
 * dependency solid #4a90d9, and a handoff takes its packet's colour and flows while recent. Selecting a
 * node lights its edges and neighbours and dims the rest.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type WheelEvent as ReactWheelEvent } from "react";
import { useNow } from "../../hooks/useTicker";
import { neighbourhood } from "../../lib/reconciler/reduce";
import type { DagEdge, DagNode } from "../../types/dag";
import { FIT_PAD, fitScale } from "../../lib/dag/layout";
import { selectView, useVisualizerStore } from "../../store/useVisualizerStore";
import { DagNodeCard } from "./DagNodeCard";

/** Low enough for fit-to-view to show a large run whole (visualizer-spec.md said 0.25x; decided 2026-11-02). */
export const MIN_ZOOM = 0.1;
export const MAX_ZOOM = 4;
/** Below this zoom a card's 10-12 px text is too small to read, so cards go compact. */
export const COMPACT_BELOW = 0.75;
const PAD = FIT_PAD;
const HANDOFF_ACTIVE_MS = 2000;
/** The pane's size is passed on in steps this big, so a drag of its edge doesn't lay out every pixel. */
const BOX_STEP = 16;

const PACKET_COLOR: Record<string, string> = {
  PROMPT_TOKENS: "#4a90d9",
  CLIP_MANIFEST: "#00c853",
  VLM_TAGS: "#00c853",
  TRANSCRIPT_SLICES: "#00c853",
  OTIO_DELTA: "#ffb300",
  VALIDATION_TOKEN: "#ffb300",
  NLE_COMMIT_BATCH: "#f43f5e",
};

export interface Viewport {
  x: number;
  y: number;
  scale: number;
}

export function clampZoom(scale: number): number {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, scale));
}

/** The viewport that fits a `width` x `height` graph into a `boxW` x `boxH` box. */
export function fitViewport(width: number, height: number, boxW: number, boxH: number): Viewport {
  if (width <= 0 || height <= 0 || boxW <= 0 || boxH <= 0) return { x: PAD, y: PAD, scale: 1 };
  const scale = clampZoom(fitScale(width, height, boxW, boxH));
  return { x: (boxW - width * scale) / 2, y: (boxH - height * scale) / 2, scale };
}

export function edgePath(edge: DagEdge, nodes: Record<string, DagNode>): string | null {
  const a = nodes[edge.source_task_id]?.layout;
  const b = nodes[edge.target_task_id]?.layout;
  if (!a || !b || (a.width === 0 && b.width === 0)) return null;
  const x1 = a.x + a.width;
  const y1 = a.y + a.height / 2;
  const x2 = b.x;
  const y2 = b.y + b.height / 2;
  // A back or same-rank edge loops out to the side.
  const dx = Math.max(40, Math.abs(x2 - x1) / 2);
  // Handoffs bend a little apart from the dependency they ride along.
  const lift = edge.edge_kind === "CONTEXT_HANDOFF" ? -10 : edge.edge_kind === "SPAWN_PARENT" ? 10 : 0;
  return `M ${x1} ${y1} C ${x1 + dx} ${y1 + lift}, ${x2 - dx} ${y2 + lift}, ${x2} ${y2}`;
}

export function DagCanvas() {
  const view = useVisualizerStore(selectView);
  const size = useVisualizerStore((s) => s.dagSize);
  const selectedTaskId = useVisualizerStore((s) => s.selectedTaskId);
  const hoveredTaskId = useVisualizerStore((s) => s.hoveredTaskId);
  const selectTask = useVisualizerStore((s) => s.selectTask);
  const setDagBox = useVisualizerStore((s) => s.setDagBox);
  const boxRef = useRef<HTMLDivElement | null>(null);
  const [viewport, setViewport] = useState<Viewport>({ x: PAD, y: PAD, scale: 1 });
  const [userMoved, setUserMoved] = useState(false);
  const drag = useRef<{ x: number; y: number; vx: number; vy: number } | null>(null);
  const [dragging, setDragging] = useState(false);
  const space = useRef(false);
  const now = useNow(500);

  const fit = useCallback(() => {
    const box = boxRef.current;
    if (!box) return;
    setViewport(fitViewport(size.width, size.height, box.clientWidth, box.clientHeight));
    setUserMoved(false);
  }, [size.width, size.height]);

  // The layout is shaped for the pane: tell the store its size, and again when it changes.
  useEffect(() => {
    const box = boxRef.current;
    if (!box) return;
    const measure = () => {
      const step = (v: number) => Math.round(v / BOX_STEP) * BOX_STEP;
      setDagBox(step(box.clientWidth), step(box.clientHeight));
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(box);
    return () => observer.disconnect();
  }, [setDagBox]);

  // Follow the graph as it grows, and the pane as it resizes, until the user pans or zooms.
  const box = useVisualizerStore((s) => s.dagBox);
  useEffect(() => {
    if (!userMoved) fit();
  }, [fit, userMoved, box.width, box.height]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)) return;
      if (e.code === "Space") space.current = e.type === "keydown";
      if (e.type === "keydown" && (e.key === "f" || e.key === "F") && !e.metaKey && !e.ctrlKey) fit();
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("keyup", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("keyup", onKey);
    };
  }, [fit]);

  const onWheel = (e: ReactWheelEvent<HTMLDivElement>) => {
    const box = boxRef.current?.getBoundingClientRect();
    if (!box) return;
    const px = e.clientX - box.left;
    const py = e.clientY - box.top;
    setViewport((v) => {
      const scale = clampZoom(v.scale * Math.exp(-e.deltaY * 0.0015));
      const k = scale / v.scale;
      return { scale, x: px - (px - v.x) * k, y: py - (py - v.y) * k };
    });
    setUserMoved(true);
  };

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button === 1 || (e.button === 0 && space.current)) {
      e.preventDefault();
      drag.current = { x: e.clientX, y: e.clientY, vx: viewport.x, vy: viewport.y };
      setDragging(true);
      e.currentTarget.setPointerCapture?.(e.pointerId);
    }
  };
  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d) return;
    setViewport((v) => ({ ...v, x: d.vx + e.clientX - d.x, y: d.vy + e.clientY - d.y }));
    setUserMoved(true);
  };
  const onPointerUp = () => {
    drag.current = null;
    setDragging(false);
  };

  const focus = selectedTaskId ?? hoveredTaskId;
  const lit = useMemo(() => (focus ? neighbourhood(view, focus) : null), [view, focus]);
  const nodes = Object.values(view.nodes);
  const edges = Object.values(view.edges);
  const width = Math.max(size.width, 1);
  const height = Math.max(size.height, 1);
  // Compact cards keep their label about 13 px on screen, in 2 px steps so a wheel tick re-renders rarely.
  const compact = viewport.scale < COMPACT_BELOW;
  const labelPx = compact ? Math.min(40, Math.round(13 / viewport.scale / 2) * 2) : 0;

  return (
    <div
      ref={boxRef}
      className="relative h-full w-full touch-none overflow-hidden bg-canvas"
      style={{ cursor: dragging ? "grabbing" : undefined }}
      onWheel={onWheel}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onClick={() => selectTask(null)}
      role="group"
      aria-label={`Execution DAG, ${nodes.length} tasks`}
    >
      {nodes.length === 0 && (
        <p className="absolute inset-0 flex items-center justify-center text-sm text-cool-grey">
          Waiting for the first task…
        </p>
      )}
      <div
        className="absolute left-0 top-0 origin-top-left"
        style={{ transform: `translate(${viewport.x}px, ${viewport.y}px) scale(${viewport.scale})`, width, height }}
        data-zoom={viewport.scale.toFixed(2)}
      >
        <svg className="absolute left-0 top-0 overflow-visible" width={width} height={height} aria-hidden="true">
          <defs>
            <marker id="dag-arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="6" markerHeight="6" orient="auto">
              <path d="M0,0 L8,4 L0,8 z" fill="#4a90d9" />
            </marker>
          </defs>
          {edges.map((edge) => {
            const d = edgePath(edge, view.nodes);
            if (!d) return null;
            const on = !lit || (lit.has(edge.source_task_id) && lit.has(edge.target_task_id) && (edge.source_task_id === focus || edge.target_task_id === focus));
            const recent = edge.edge_kind === "CONTEXT_HANDOFF" && now - edge.last_active_ms < HANDOFF_ACTIVE_MS;
            const color =
              edge.edge_kind === "SPAWN_PARENT"
                ? "#30363d"
                : edge.edge_kind === "DATA_DEPENDENCY"
                  ? "#4a90d9"
                  : (PACKET_COLOR[edge.packet_type ?? ""] ?? "#99928a");
            return (
              <path
                key={edge.edge_id}
                d={d}
                fill="none"
                stroke={color}
                strokeWidth={edge.edge_kind === "CONTEXT_HANDOFF" ? 1.5 + Math.min(3, Math.log10(1 + edge.total_bytes) / 2) : 1.5}
                strokeDasharray={edge.edge_kind === "SPAWN_PARENT" ? "6 4" : edge.edge_kind === "CONTEXT_HANDOFF" ? "3 5" : undefined}
                opacity={on ? (edge.edge_kind === "CONTEXT_HANDOFF" && !recent ? 0.5 : 1) : 0.15}
                markerEnd={edge.edge_kind === "DATA_DEPENDENCY" ? "url(#dag-arrow)" : undefined}
                data-edge-kind={edge.edge_kind}
                className={recent ? "dag-flow" : undefined}
              >
                <title>
                  {edge.edge_kind}
                  {edge.packet_type ? ` · ${edge.packet_type} ×${edge.transfer_count} (${edge.total_bytes} B)` : ""}
                </title>
              </path>
            );
          })}
        </svg>
        {nodes.map((node) => (
          <DagNodeCard
            key={node.task_id}
            node={node}
            selected={node.task_id === selectedTaskId}
            highlighted={node.task_id === hoveredTaskId}
            dimmed={lit !== null && !lit.has(node.task_id)}
            onSelect={selectTask}
            labelPx={labelPx}
          />
        ))}
      </div>
      <div className="absolute bottom-2 right-2 flex gap-1 font-mono text-[10px] text-cool-grey">
        <button type="button" className="rounded border border-border bg-surface px-2 py-0.5 hover:text-white" onClick={(e) => { e.stopPropagation(); fit(); }}>
          Fit (F)
        </button>
        <span className="rounded border border-border bg-surface px-2 py-0.5">{Math.round(viewport.scale * 100)}%</span>
      </div>
    </div>
  );
}
