/**
 * A colour grade: a Resolve-style node graph, stored on a clip (`Clip.grade`) or on the sequence
 * (`Sequence.timelineGrade`, applied after every clip's own). The Metal renderer in
 * `src-tauri/src/color/` runs it; `src-tauri/src/color/graph.rs` holds the matching Rust types and
 * validation, and `src/test/fixtures/color/` has JSON both test suites read.
 *
 * Nodes are wired from the implicit `"source"` (the decoded picture) to the implicit `"output"`.
 */

export const GRAPH_SOURCE = "source";
export const GRAPH_OUTPUT = "output";

export interface ColorGraph {
  nodes: ColorNode[];
  edges: ColorEdge[];
}

/** A wire into input `input` of `to`. Correctors, CSTs and LUTs have one input (0); mixers one per branch. */
export interface ColorEdge {
  from: string;
  to: string;
  input: number;
}

export type ColorNode = CorrectorNode | CstNode | LutNode | MixerNode;

interface NodeBase {
  id: string;
  /** Shown on the node; empty shows its number. */
  label: string;
  enabled: boolean;
  /** Where it sits in the node editor. */
  position: { x: number; y: number };
}

/** `[r, g, b, master]`: a channel's value is its own plus the master. */
export type Wheel = [number, number, number, number];

export interface Primaries {
  /** Stops, -10..10. */
  exposure: number;
  /** -100..400 (percent change), about `pivot`. */
  contrast: number;
  pivot: number;
  /** The tone ranges, -100..100. */
  highlights: number;
  shadows: number;
  whites: number;
  blacks: number;
  /** -100..100. */
  temperature: number;
  tint: number;
  /** -100..400. */
  saturation: number;
  /** -100..100. */
  vibrance: number;
  lift: Wheel;
  gamma: Wheel;
  gain: Wheel;
  offset: Wheel;
}

export type CurvePoint = [number, number];

export interface Curves {
  master: CurvePoint[];
  r: CurvePoint[];
  g: CurvePoint[];
  b: CurvePoint[];
}

export const HSL_BANDS = ["red", "orange", "yellow", "green", "aqua", "blue", "purple", "magenta"] as const;
export type HslBandName = (typeof HSL_BANDS)[number];

/** -100..100 each. Hue turns by up to ±30°. */
export interface HslBand {
  hue: number;
  sat: number;
  lum: number;
}

/** An HSL key on the node's input: hue in degrees, saturation and luminance 0..1, each with soft edges. */
export interface Qualifier {
  enabled: boolean;
  useHue: boolean;
  hueCenter: number;
  hueWidth: number;
  hueSoft: number;
  useSat: boolean;
  satLow: number;
  satHigh: number;
  satSoft: number;
  useLum: boolean;
  lumLow: number;
  lumHigh: number;
  lumSoft: number;
  invert: boolean;
}

export const WINDOW_SHAPES = ["circle", "linear", "polygon", "gradient"] as const;
export type WindowShape = (typeof WINDOW_SHAPES)[number];

/**
 * A power window in frame-relative coordinates: `center` is 0..1 across and down from the top-left;
 * `width`, `height` and `softness` are fractions of the frame's height; `rotation` is in degrees. A
 * polygon uses `points` (frame-relative) instead of the size and rotation. A gradient is fully on
 * the side its rotation points to (0° = up), fading over `softness`.
 */
export interface PowerWindow {
  id: string;
  shape: WindowShape;
  enabled: boolean;
  invert: boolean;
  mode: "add" | "subtract";
  center: [number, number];
  width: number;
  height: number;
  rotation: number;
  softness: number;
  points: [number, number][];
}

export interface CorrectorNode extends NodeBase {
  kind: "corrector";
  primaries: Primaries;
  curves: Curves;
  hsl: Record<HslBandName, HslBand>;
  /** Null when the node has no qualifier. */
  qualifier: Qualifier | null;
  windows: PowerWindow[];
  /** 0..1: scales the node's key. */
  keyGain: number;
}

export const GAMUTS = ["rec709", "rec2020", "p3d65", "davinciWideGamut", "sGamut3Cine", "sGamut3"] as const;
export type Gamut = (typeof GAMUTS)[number];

export const TRANSFERS = ["linear", "srgb", "gamma22", "gamma24", "rec709", "davinciIntermediate", "sLog3", "appleLog"] as const;
export type Transfer = (typeof TRANSFERS)[number];

export interface CstNode extends NodeBase {
  kind: "cst";
  inputGamut: Gamut;
  inputTransfer: Transfer;
  outputGamut: Gamut;
  outputTransfer: Transfer;
  toneMapping: "none" | "simple";
  gamutMapping: "none" | "compress";
}

export interface LutNode extends NodeBase {
  kind: "lut";
  /** The LUT's content hash in the library. */
  lutId: string;
  /** Its name when applied, shown even when the library no longer has it. */
  name: string;
  /** 0..100. */
  intensity: number;
  interpolation: "trilinear" | "tetrahedral";
}

export interface MixerNode extends NodeBase {
  kind: "parallel" | "layer";
}

export type LutCategory = "technical" | "creative";

/** A LUT in the library (`color_list_luts`). */
export interface LutInfo {
  id: string;
  name: string;
  category: LutCategory;
  /** "3D 33", "1D + 3D 65", … */
  shape: string;
  file: string;
}
