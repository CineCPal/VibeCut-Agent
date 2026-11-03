/**
 * The virtual studio (visualizer-spec.md §3): seven bays on a 1280x980 logical grid, drawn on one Canvas
 * 2D. It reads the store directly each frame, so a frame never waits on React. One requestAnimationFrame
 * loop draws the floor, the conduits, the bays, the avatars, the HUD badges and the packets, crisp with no
 * smoothing. With every bay idle and no packet in flight it drops to 6 FPS.
 *
 * Over each bay sits a transparent button: a click or Enter selects the bay's task, and screen readers get
 * the bay's state.
 */
import type { SubagentType } from "@vibecut/contracts";
import { useEffect, useRef } from "react";
import { BAYS, STUDIO_HEIGHT, STUDIO_WIDTH } from "../../lib/studio/bays";
import { AVATAR_ANIMATION, effectiveAvatar } from "../../lib/studio/avatarFsm";
import { CONDUITS, conduitPath, pointAt, type Point } from "../../lib/studio/conduits";
import { packetProgress } from "../../lib/studio/packets";
import type { TraceState } from "../../lib/reconciler/reduce";
import { selectView, useVisualizerStore } from "../../store/useVisualizerStore";
import { buildAtlas, CELL, FRAMES, spriteUrl } from "./ProceduralPixelAvatar";

export const IDLE_FRAME_MS = 166;
const AVATAR_SCALE = 1.5;
const TITLE_FONT = "700 24px -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif";
const TITLE_LINE = 28;

type Ctx = CanvasRenderingContext2D;

const loaded = new Map<SubagentType, HTMLImageElement | null>();

/** A sprite sheet from public/sprites if one loads, else null (the procedural atlas is used). */
function spriteSheet(subagent: SubagentType): HTMLImageElement | null {
  if (loaded.has(subagent)) return loaded.get(subagent) ?? null;
  loaded.set(subagent, null);
  if (typeof Image === "function" && typeof window !== "undefined" && import.meta.env.MODE !== "test") {
    const img = new Image();
    img.onload = () => loaded.set(subagent, img);
    img.onerror = () => loaded.set(subagent, null);
    img.src = spriteUrl(subagent);
  }
  return null;
}

export function isStudioIdle(view: TraceState, nowMs: number): boolean {
  if (view.activePackets.some((p) => p.born_ms + p.duration_ms > nowMs)) return false;
  return BAYS.every((b) => effectiveAvatar(view.studioBays[b.subagent], nowMs) === "IDLE");
}

function line(ctx: Ctx, path: readonly Point[]): void {
  ctx.beginPath();
  path.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
  ctx.stroke();
}

function pill(ctx: Ctx, x: number, y: number, text: string, color: string): void {
  ctx.font = "600 20px 'Fira Code', 'JetBrains Mono', monospace";
  const w = Math.ceil(ctx.measureText(text).width) + 20;
  ctx.fillStyle = "#0d1117";
  ctx.fillRect(Math.round(x - w / 2), y - 17, w, 34);
  ctx.strokeStyle = color;
  ctx.lineWidth = 2;
  ctx.strokeRect(Math.round(x - w / 2) + 1, y - 16, w - 2, 32);
  ctx.fillStyle = color;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(text, x, y + 0.5);
}

/** Word-wraps `text` to lines no wider than `max` in the current font. */
function wrap(ctx: Ctx, text: string, max: number): string[] {
  const lines: string[] = [];
  let current = "";
  for (const word of text.split(" ")) {
    const next = current ? `${current} ${word}` : word;
    if (current && ctx.measureText(next).width > max) {
      lines.push(current);
      current = word;
    } else {
      current = next;
    }
  }
  if (current) lines.push(current);
  return lines;
}

export function drawStudio(ctx: Ctx, view: TraceState, nowMs: number, selectedTaskId: string | null): void {
  ctx.imageSmoothingEnabled = false;
  ctx.fillStyle = "#0d1117";
  ctx.fillRect(0, 0, STUDIO_WIDTH, STUDIO_HEIGHT);
  // Floor tiles.
  ctx.fillStyle = "#11161d";
  for (let x = 0; x < STUDIO_WIDTH; x += 32) {
    for (let y = (x / 32) % 2 ? 0 : 32; y < STUDIO_HEIGHT; y += 64) ctx.fillRect(x, y, 32, 32);
  }

  // Conduits: dormant, then lit where a packet is in flight.
  const live = view.activePackets
    .map((packet) => ({ packet, t: packetProgress(packet, nowMs) }))
    .filter((p): p is { packet: (typeof view.activePackets)[number]; t: number } => p.t !== null);
  ctx.lineCap = "square";
  ctx.strokeStyle = "#30363d";
  ctx.lineWidth = 2;
  for (const [a, b] of CONDUITS) line(ctx, conduitPath(a, b));
  for (const { packet } of live) {
    const path = conduitPath(packet.from, packet.to);
    ctx.globalAlpha = 0.25;
    ctx.strokeStyle = packet.color;
    ctx.lineWidth = 10;
    line(ctx, path);
    ctx.globalAlpha = 1;
    ctx.lineWidth = 4;
    line(ctx, path);
  }

  for (const bay of BAYS) {
    const state = view.studioBays[bay.subagent];
    const avatar = effectiveAvatar(state, nowMs);
    const { row, fps, halo } = AVATAR_ANIMATION[avatar];
    const left = Math.round(bay.x - bay.w / 2);
    const top = Math.round(bay.y - bay.h / 2);
    const selected = selectedTaskId !== null && state.active_task_id === selectedTaskId;
    ctx.fillStyle = "#161b22";
    ctx.fillRect(left, top, bay.w, bay.h);
    ctx.strokeStyle = selected ? "#e6edf3" : bay.accent;
    ctx.lineWidth = selected ? 3 : 2;
    ctx.strokeRect(left + 1, top + 1, bay.w - 2, bay.h - 2);
    // The desk.
    ctx.fillStyle = bay.accent;
    ctx.globalAlpha = 0.35;
    ctx.fillRect(left + 20, top + bay.h - 40, bay.w - 40, 14);
    ctx.globalAlpha = 1;
    ctx.fillStyle = "#c9c2b8";
    ctx.font = TITLE_FONT;
    ctx.textAlign = "left";
    ctx.textBaseline = "top";
    wrap(ctx, `BAY ${bay.bay}: ${bay.title.toUpperCase()}`, bay.w - 24).forEach((text, i) =>
      ctx.fillText(text, left + 12, top + 22 + i * TITLE_LINE),
    );

    // The avatar, standing at the desk.
    const frame = Math.floor(nowMs / (1000 / fps)) % FRAMES;
    const size = CELL * AVATAR_SCALE;
    const ax = Math.round(bay.x - size / 2);
    const ay = Math.round(top + bay.h - size - 28);
    ctx.globalAlpha = 0.35;
    ctx.fillStyle = halo;
    ctx.fillRect(ax - 4, ay + size - 8, size + 8, 8);
    ctx.globalAlpha = 1;
    const sheet = spriteSheet(bay.subagent) ?? buildAtlas(bay.subagent);
    if (sheet) {
      ctx.drawImage(sheet as CanvasImageSource, frame * CELL, row * CELL, CELL, CELL, ax, ay, size, size);
    }
    pill(ctx, bay.x, top, state.hud, halo);
    if (state.progress !== null && avatar === "READING_ASSET") {
      ctx.fillStyle = "#30363d";
      ctx.fillRect(left + 20, top + bay.h - 18, bay.w - 40, 6);
      ctx.fillStyle = "#38bdf8";
      ctx.fillRect(left + 20, top + bay.h - 18, Math.round((bay.w - 40) * state.progress), 6);
    }
  }

  // Packets, with a short comet tail.
  for (const { packet, t } of live) {
    const path = conduitPath(packet.from, packet.to);
    for (let k = 3; k >= 0; k--) {
      const p = pointAt(path, Math.max(0, t - k * 0.03));
      ctx.globalAlpha = k === 0 ? 1 : 0.18 * (4 - k);
      ctx.fillStyle = packet.color;
      ctx.fillRect(Math.round(p.x - packet.w / 2), Math.round(p.y - packet.h / 2), packet.w, packet.h);
    }
    ctx.globalAlpha = 1;
    if (packet.label) {
      const p = pointAt(path, t);
      ctx.fillStyle = "#e6edf3";
      ctx.font = "600 18px 'Fira Code', monospace";
      ctx.textAlign = "left";
      ctx.textBaseline = "bottom";
      ctx.fillText(packet.label, Math.round(p.x + packet.w), Math.round(p.y - 4));
    }
  }
}

export interface VirtualStudioCanvasProps {
  className?: string;
}

export function VirtualStudioCanvas({ className = "" }: VirtualStudioCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const view = useVisualizerStore(selectView);
  const selectTask = useVisualizerStore((s) => s.selectTask);
  const selectedTaskId = useVisualizerStore((s) => s.selectedTaskId);

  useEffect(() => {
    const canvas = canvasRef.current;
    let ctx: Ctx | null = null;
    try {
      ctx = canvas?.getContext("2d") ?? null;
    } catch {
      ctx = null;
    }
    if (!canvas || !ctx) return;
    const context = ctx;
    const dpr = Math.max(1, Math.round(window.devicePixelRatio || 1));
    canvas.width = STUDIO_WIDTH * dpr;
    canvas.height = STUDIO_HEIGHT * dpr;
    context.setTransform(dpr, 0, 0, dpr, 0, 0);
    let frame = 0;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let stopped = false;
    const tick = () => {
      if (stopped) return;
      const now = Date.now();
      const state = useVisualizerStore.getState();
      const current = selectView(state);
      drawStudio(context, current, now, state.selectedTaskId);
      if (isStudioIdle(current, now)) {
        timer = setTimeout(() => {
          frame = requestAnimationFrame(tick);
        }, IDLE_FRAME_MS);
      } else {
        frame = requestAnimationFrame(tick);
      }
    };
    frame = requestAnimationFrame(tick);
    return () => {
      stopped = true;
      cancelAnimationFrame(frame);
      if (timer) clearTimeout(timer);
    };
  }, []);

  return (
    <div className={`relative h-full w-full overflow-hidden bg-canvas ${className}`}>
      <div className="absolute inset-0 flex items-center justify-center" style={{ containerType: "size" }}>
        <div
          className="relative"
          style={{
            aspectRatio: `${STUDIO_WIDTH} / ${STUDIO_HEIGHT}`,
            width: `min(100cqw, calc(100cqh * ${STUDIO_WIDTH} / ${STUDIO_HEIGHT}))`,
          }}
        >
          <canvas
            ref={canvasRef}
            className="pixelated absolute inset-0 h-full w-full"
            role="img"
            aria-label="Virtual editing studio: seven agent bays"
          />
          {BAYS.map((bay) => {
            const state = view.studioBays[bay.subagent];
            const avatar = effectiveAvatar(state, Date.now());
            return (
              <button
                key={bay.subagent}
                type="button"
                className="absolute rounded-sm bg-transparent focus-visible:outline-2"
                style={{
                  left: `${((bay.x - bay.w / 2) / STUDIO_WIDTH) * 100}%`,
                  top: `${((bay.y - bay.h / 2) / STUDIO_HEIGHT) * 100}%`,
                  width: `${(bay.w / STUDIO_WIDTH) * 100}%`,
                  height: `${(bay.h / STUDIO_HEIGHT) * 100}%`,
                }}
                aria-label={`Bay ${bay.bay}: ${bay.title}, ${avatar.replaceAll("_", " ").toLowerCase()}${state.active_task_id ? `, task ${state.active_task_id}` : ""}`}
                aria-pressed={selectedTaskId !== null && state.active_task_id === selectedTaskId}
                data-subagent={bay.subagent}
                data-avatar-state={avatar}
                disabled={!state.active_task_id}
                onClick={() => selectTask(state.active_task_id)}
              />
            );
          })}
        </div>
      </div>
    </div>
  );
}
