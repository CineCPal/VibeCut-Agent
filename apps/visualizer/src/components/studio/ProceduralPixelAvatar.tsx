/**
 * Procedural pixel-art avatars (visualizer-spec.md §3.4 B): a 16x16 bitmap per SubagentType, with a visor
 * in the state's halo colour, a bob on odd frames, and a few pixels per state (a raised arm to celebrate,
 * a red "!" when blocked, the prop in hand while working). No PNG atlases ship (PLAN.md, "Phase 22", V8),
 * so this is every sprite: drawn as SVG <rect>s, or rasterised into the 512x512 atlas layout of §3.4 A
 * (8 states x 8 frames of 64x64) for the studio canvas and the CSS sprite badges.
 */
import type { SubagentType } from "@vibecut/contracts";
import { SUBAGENT_TYPES } from "@vibecut/contracts";
import { BAY_BY_SUBAGENT } from "../../lib/studio/bays";
import { AVATAR_ANIMATION } from "../../lib/studio/avatarFsm";
import { AVATAR_STATES, type AvatarState } from "../../types/studio";

export const GRID = 16;
export const CELL = 64;
export const FRAMES = 8;
export const ATLAS_SIZE = CELL * FRAMES;

// d outline, h hair, s skin, v visor, m mouth, b body, p prop; "." is transparent.
const BASE = [
  "................",
  ".....dddddd.....",
  "....dhhhhhhd....",
  "...dhhhhhhhhd...",
  "...dssssssssd...",
  "...dsvvvvvvsd...",
  "...dssssssssd...",
  "....dssmmssd....",
  ".....dddddd.....",
  "....dbbbbbbd....",
  "...dbbbbbbbbd...",
  "..dsbbbbbbbbsd..",
  "..dsbbbbbbbbsd..",
  "...dbbbbbbbbd...",
  "....dbbddbbd....",
  "....ddd..ddd....",
];

type Overlay = readonly (readonly [row: number, col: number, code: string])[];

const ROLE_OVERLAY: Readonly<Record<SubagentType, Overlay>> = {
  // A headset with a boom mic, and the tally light on top.
  MASTER_ORCHESTRATOR: [[0, 7, "r"], [0, 8, "r"], [4, 12, "p"], [5, 12, "p"], [6, 12, "p"], [7, 11, "p"], [7, 10, "p"]],
  // Closed-back headphones.
  INGEST_TRANSCRIBE: [[2, 3, "p"], [3, 2, "p"], [4, 2, "p"], [5, 2, "p"], [2, 12, "p"], [3, 13, "p"], [4, 13, "p"], [5, 13, "p"], [1, 4, "p"], [1, 11, "p"]],
  // A loupe held to one eye.
  VISION_TAGGER: [[4, 13, "p"], [5, 13, "w"], [5, 14, "p"], [6, 13, "p"], [6, 14, "p"], [7, 14, "p"]],
  // An archivist's cap.
  BROLL_RETRIEVER: [[1, 5, "p"], [1, 6, "p"], [1, 7, "p"], [1, 8, "p"], [1, 9, "p"], [1, 10, "p"], [2, 11, "p"], [2, 12, "p"], [2, 13, "p"]],
  // Splicing shears in hand.
  PACING_CUTTER: [[11, 14, "w"], [12, 14, "w"], [10, 15, "w"], [13, 15, "w"], [12, 13, "p"]],
  // Big monitoring cans and a tie-clip mic.
  AUDIO_ENGINEER: [[3, 1, "p"], [4, 1, "p"], [5, 1, "p"], [3, 2, "p"], [4, 2, "p"], [5, 2, "p"], [3, 13, "p"], [4, 13, "p"], [5, 13, "p"], [3, 14, "p"], [4, 14, "p"], [5, 14, "p"], [10, 7, "w"]],
  // A beret and a trackball.
  COLOR_GRADER: [[1, 4, "p"], [1, 5, "p"], [1, 6, "p"], [1, 7, "p"], [1, 8, "p"], [0, 6, "p"], [12, 0, "w"], [13, 0, "w"], [12, 1, "w"]],
};

const STATE_OVERLAY: Readonly<Partial<Record<AvatarState, Overlay>>> = {
  // A sound wave at the ear.
  LISTENING: [[3, 15, "v"], [4, 15, "v"], [5, 15, "v"], [2, 14, "v"], [6, 14, "v"]],
  // Thought dots over the head.
  PROCESSING_THINKING: [[0, 12, "w"], [0, 14, "w"], [1, 13, "w"]],
  SUCCESS_CELEBRATE: [[8, 1, "s"], [9, 1, "s"], [10, 1, "s"], [7, 1, "s"], [11, 2, "b"], [12, 2, "b"]],
  BLOCKED_ERROR: [[0, 14, "r"], [1, 14, "r"], [2, 14, "r"], [4, 14, "r"]],
  READING_ASSET: [[12, 12, "c"], [12, 13, "c"], [13, 12, "c"], [13, 13, "c"]],
  WRITING_OTIO: [[12, 12, "g"], [12, 13, "g"], [12, 14, "g"], [13, 13, "g"]],
  RENDERING: [[9, 14, "e"], [10, 14, "e"], [11, 14, "e"]],
};

const HAIR: Readonly<Record<SubagentType, string>> = {
  MASTER_ORCHESTRATOR: "#2b2118",
  INGEST_TRANSCRIBE: "#6b4f2c",
  VISION_TAGGER: "#1c1c1c",
  BROLL_RETRIEVER: "#8a5a2b",
  PACING_CUTTER: "#c08a3e",
  AUDIO_ENGINEER: "#3b2a20",
  COLOR_GRADER: "#5b2333",
};

function lighten(hex: string, amount: number): string {
  const n = Number.parseInt(hex.slice(1), 16);
  const mix = (c: number) => Math.round(c + (255 - c) * amount);
  const r = mix((n >> 16) & 0xff);
  const g = mix((n >> 8) & 0xff);
  const b = mix(n & 0xff);
  return `#${((r << 16) | (g << 8) | b).toString(16).padStart(6, "0")}`;
}

export interface Pixel {
  x: number;
  y: number;
  color: string;
}

/** The avatar's lit pixels for a state and frame (0..7). */
export function avatarPixels(subagent: SubagentType, state: AvatarState, frame: number): Pixel[] {
  const accent = BAY_BY_SUBAGENT[subagent].accent;
  const halo = AVATAR_ANIMATION[state].halo;
  const busy = state === "PROCESSING_THINKING" || state === "RENDERING";
  const palette: Record<string, string> = {
    d: "#0b0f14",
    h: HAIR[subagent],
    s: "#f1c27d",
    v: busy && frame % 4 >= 2 ? lighten(halo, 0.45) : halo,
    m: "#7a3b2e",
    b: accent,
    p: lighten(accent, 0.35),
    w: "#e6edf3",
    r: "#FF5252",
    c: "#38bdf8",
    g: "#FFB300",
    e: frame % 2 ? "#00C853" : "#0f5132",
  };
  const grid = BASE.map((row) => row.split(""));
  for (const [r, c, code] of [...ROLE_OVERLAY[subagent], ...(STATE_OVERLAY[state] ?? [])]) grid[r][c] = code;
  const bob = state === "BLOCKED_ERROR" ? 0 : frame % 2;
  const pixels: Pixel[] = [];
  for (let y = 0; y < GRID; y++) {
    for (let x = 0; x < GRID; x++) {
      const code = grid[y][x];
      const ty = y + bob;
      if (code === "." || ty >= GRID) continue;
      pixels.push({ x, y: ty, color: palette[code] });
    }
  }
  return pixels;
}

export interface ProceduralPixelAvatarProps {
  subagent: SubagentType;
  state: AvatarState;
  frame?: number;
  size?: number;
  title?: string;
}

/** One avatar frame as crisp SVG (4x4 rects on a 64x64 viewBox). */
export function ProceduralPixelAvatar({ subagent, state, frame = 0, size = 64, title }: ProceduralPixelAvatarProps) {
  const scale = CELL / GRID;
  return (
    <svg
      width={size}
      height={size}
      viewBox={`0 0 ${CELL} ${CELL}`}
      shapeRendering="crispEdges"
      role="img"
      aria-label={title ?? `${subagent} ${state}`}
      data-avatar-state={state}
    >
      {avatarPixels(subagent, state, frame).map((p) => (
        <rect key={`${p.x}-${p.y}`} x={p.x * scale} y={p.y * scale} width={scale} height={scale} fill={p.color} />
      ))}
    </svg>
  );
}

type AnyCanvas = HTMLCanvasElement | OffscreenCanvas;
type Any2d = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

function newCanvas(size: number): AnyCanvas | null {
  if (typeof OffscreenCanvas === "function") return new OffscreenCanvas(size, size);
  if (typeof document === "undefined") return null;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  return canvas;
}

const atlases = new Map<SubagentType, AnyCanvas | null>();

/** The role's 512x512 atlas (rows = states, columns = frames), or null where there's no 2D canvas. */
export function buildAtlas(subagent: SubagentType): AnyCanvas | null {
  if (atlases.has(subagent)) return atlases.get(subagent) ?? null;
  const canvas = newCanvas(ATLAS_SIZE);
  let ctx: Any2d | null = null;
  try {
    ctx = canvas ? (canvas.getContext("2d") as Any2d | null) : null;
  } catch {
    ctx = null;
  }
  if (!canvas || !ctx) {
    atlases.set(subagent, null);
    return null;
  }
  const scale = CELL / GRID;
  AVATAR_STATES.forEach((state, row) => {
    for (let frame = 0; frame < FRAMES; frame++) {
      for (const p of avatarPixels(subagent, state, frame)) {
        ctx.fillStyle = p.color;
        ctx.fillRect(frame * CELL + p.x * scale, row * CELL + p.y * scale, scale, scale);
      }
    }
  });
  atlases.set(subagent, canvas);
  return canvas;
}

const dataUrls = new Map<SubagentType, string | null>();

/** The atlas as a data URL for CSS sprites, or null (no canvas, or a canvas that can't encode). */
export function atlasDataUrl(subagent: SubagentType): string | null {
  if (dataUrls.has(subagent)) return dataUrls.get(subagent) ?? null;
  let url: string | null = null;
  if (typeof document !== "undefined") {
    try {
      const canvas = document.createElement("canvas");
      canvas.width = ATLAS_SIZE;
      canvas.height = ATLAS_SIZE;
      const ctx = canvas.getContext("2d");
      const atlas = buildAtlas(subagent);
      if (ctx && atlas) {
        ctx.drawImage(atlas as CanvasImageSource, 0, 0);
        url = canvas.toDataURL("image/png");
        if (!url.startsWith("data:image/png")) url = null;
      }
    } catch {
      url = null;
    }
  }
  dataUrls.set(subagent, url);
  return url;
}

/** Sprite sheets dropped into public/sprites win over the procedural ones (§3.4 A). */
export function spriteUrl(subagent: SubagentType): string {
  return `${import.meta.env.BASE_URL}sprites/${subagent.toLowerCase()}_atlas.png`;
}

export const ALL_SUBAGENTS = SUBAGENT_TYPES;
