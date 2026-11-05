/**
 * The edit suite's floor plan (PLAN.md, "The studio as an edit suite", 2026-11-05): the seven rooms, each with
 * a row-wrapped grid of workstations, packed into columns of rooms. Each style (PLAN.md, "Studio styles") has
 * its own sizes. `fitSuite` picks the columns for a box so the text stays readable: as many columns as fit at
 * the style's readable scale or more, else one column. The plan fills the box's width; when it's taller than
 * the box, the box scrolls.
 */
import type { SubagentType } from "@vibecut/contracts";
import { BAY_BY_SUBAGENT } from "./bays";
import { guestStation, STATIONS, type StationConfig } from "./stations";

/** The studio's looks (PLAN.md, "Studio styles", 2026-11-05): "suite", the edit suite with a desk and its gear
 * per agent; "compact", tight live tiles with activity traces, for more of the run at once. */
export type StudioStyle = "suite" | "compact";
export const STUDIO_STYLES: readonly StudioStyle[] = ["suite", "compact"];

/** One style's sizes, in logical px. */
export interface SuiteMetrics {
  stationW: number;
  stationH: number;
  stationGap: number;
  roomPad: number;
  roomHeader: number;
  roomGap: number;
  /** The smallest scale the style is drawn at by choice, so its labels stay readable. */
  readableScale: number;
  /** The most columns of rooms it lays out. */
  maxColumns: Columns;
}

export type Columns = 1 | 2 | 3 | 4;

export const METRICS: Readonly<Record<StudioStyle, SuiteMetrics>> = {
  suite: { stationW: 184, stationH: 172, stationGap: 12, roomPad: 14, roomHeader: 44, roomGap: 18, readableScale: 0.6, maxColumns: 3 },
  compact: { stationW: 160, stationH: 62, stationGap: 8, roomPad: 10, roomHeader: 30, roomGap: 12, readableScale: 0.7, maxColumns: 4 },
};

/** One column of rooms: two desks side by side. */
export function cellWidth(m: SuiteMetrics): number {
  return m.roomPad * 2 + m.stationW * 2 + m.stationGap;
}

// The edit suite's sizes, by their old names.
export const STATION_W = METRICS.suite.stationW;
export const STATION_H = METRICS.suite.stationH;
export const CELL_W = cellWidth(METRICS.suite);
export const READABLE_SCALE = METRICS.suite.readableScale;
/** The largest scale for any style: desks are drawn at their own size at most. */
export const MAX_SCALE = 1;

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface StationPlace extends Rect {
  station: StationConfig;
}

export interface RoomPlace extends Rect {
  subagent: SubagentType;
  title: string;
  accent: string;
  stations: StationPlace[];
}

export interface SuiteLayout {
  style: StudioStyle;
  columns: Columns;
  width: number;
  height: number;
  rooms: RoomPlace[];
  /** Every desk by its key. */
  byKey: Map<string, StationPlace>;
}

/** Rooms in reading order for each column count, with how many columns each spans. */
const PLANS: Record<Columns, readonly [SubagentType, number][]> = {
  4: [
    ["INGEST_TRANSCRIBE", 1],
    ["VISION_TAGGER", 1],
    ["BROLL_RETRIEVER", 1],
    ["PACING_CUTTER", 1],
    ["MASTER_ORCHESTRATOR", 1],
    ["AUDIO_ENGINEER", 1],
    ["COLOR_GRADER", 2],
  ],
  3: [
    ["INGEST_TRANSCRIBE", 1],
    ["BROLL_RETRIEVER", 1],
    ["PACING_CUTTER", 1],
    ["VISION_TAGGER", 1],
    ["MASTER_ORCHESTRATOR", 1],
    ["AUDIO_ENGINEER", 1],
    ["COLOR_GRADER", 3],
  ],
  2: [
    ["MASTER_ORCHESTRATOR", 2],
    ["INGEST_TRANSCRIBE", 1],
    ["VISION_TAGGER", 1],
    ["BROLL_RETRIEVER", 1],
    ["PACING_CUTTER", 1],
    ["AUDIO_ENGINEER", 1],
    ["COLOR_GRADER", 1],
  ],
  1: [
    ["MASTER_ORCHESTRATOR", 1],
    ["INGEST_TRANSCRIBE", 1],
    ["VISION_TAGGER", 1],
    ["BROLL_RETRIEVER", 1],
    ["PACING_CUTTER", 1],
    ["AUDIO_ENGINEER", 1],
    ["COLOR_GRADER", 1],
  ],
};

export function suiteWidth(columns: Columns, style: StudioStyle = "suite"): number {
  const m = METRICS[style];
  return columns * cellWidth(m) + (columns + 1) * m.roomGap;
}

/** The desks of one room: the catalogue's, then any guest agents seen there, in the order they arrived. */
export function roomStations(subagent: SubagentType, guests: readonly string[] = []): StationConfig[] {
  const listed = STATIONS.filter((s) => s.subagent === subagent);
  const known = new Set(listed.map((s) => s.key));
  return [...listed, ...guests.filter((k) => !known.has(k)).map((k) => guestStation(k, subagent))];
}

/**
 * The floor plan for `columns` in `style`, with `guests` (desk keys by room) given desks after the listed ones.
 * Pure: the same arguments give the same plan.
 */
export function suiteLayout(
  columns: Columns,
  guests: Partial<Record<SubagentType, readonly string[]>> = {},
  style: StudioStyle = "suite",
): SuiteLayout {
  const m = METRICS[style];
  const cell = cellWidth(m);
  const rooms: RoomPlace[] = [];
  const byKey = new Map<string, StationPlace>();
  let col = 0;
  let rowY = m.roomGap;
  let rowRooms: RoomPlace[] = [];
  const closeRow = () => {
    const h = Math.max(0, ...rowRooms.map((r) => r.h));
    for (const room of rowRooms) room.h = h;
    rowY += h + m.roomGap;
    rowRooms = [];
    col = 0;
  };
  for (const [subagent, wanted] of PLANS[columns]) {
    const span = Math.min(wanted, columns);
    if (col + span > columns) closeRow();
    const x = m.roomGap + col * (cell + m.roomGap);
    const w = span * cell + (span - 1) * m.roomGap;
    const perRow = Math.max(1, Math.floor((w - m.roomPad * 2 + m.stationGap) / (m.stationW + m.stationGap)));
    const desks = roomStations(subagent, guests[subagent]);
    const rows = Math.max(1, Math.ceil(desks.length / perRow));
    const h = m.roomHeader + rows * m.stationH + (rows - 1) * m.stationGap + m.roomPad;
    const bay = BAY_BY_SUBAGENT[subagent];
    const room: RoomPlace = { subagent, title: bay.title, accent: bay.accent, x, y: rowY, w, h, stations: [] };
    // Centre the desks' grid in the room's width.
    const used = Math.min(desks.length, perRow) * (m.stationW + m.stationGap) - m.stationGap;
    const left = x + Math.round((w - used) / 2);
    desks.forEach((station, i) => {
      const place: StationPlace = {
        station,
        x: left + (i % perRow) * (m.stationW + m.stationGap),
        y: rowY + m.roomHeader + Math.floor(i / perRow) * (m.stationH + m.stationGap),
        w: m.stationW,
        h: m.stationH,
      };
      room.stations.push(place);
      byKey.set(station.key, place);
    });
    rooms.push(room);
    rowRooms.push(room);
    col += span;
    if (col >= columns) closeRow();
  }
  if (rowRooms.length) closeRow();
  return { style, columns, width: suiteWidth(columns, style), height: rowY, rooms, byKey };
}

export interface SuiteFit {
  columns: Columns;
  /** CSS px per logical px. */
  scale: number;
  /** The drawn size in CSS px. */
  width: number;
  height: number;
}

/**
 * How to draw `style` in a box of `width` x `height` CSS px: of the column counts that keep the style's
 * readable scale at the box's width, one that fits the box whole if any (the most columns), else the most
 * columns; with none readable, one column. It fills the width up to MAX_SCALE. Null until the box has a size.
 */
export function fitSuite(
  width: number,
  height: number,
  guests: Partial<Record<SubagentType, readonly string[]>> = {},
  style: StudioStyle = "suite",
): SuiteFit | null {
  if (!(width > 0) || !(height > 0)) return null;
  const m = METRICS[style];
  const counts = ([4, 3, 2, 1] as const).filter((c) => c <= m.maxColumns);
  const options = counts.map((columns) => {
    const plan = suiteLayout(columns, guests, style);
    const scale = Math.min(MAX_SCALE, width / plan.width);
    return { columns, scale, plan };
  });
  const readable = options.filter((o) => o.scale >= m.readableScale);
  // Readable and whole in the box beats readable and scrolling; otherwise the most columns that are readable.
  const whole = readable.find((o) => o.plan.height * o.scale <= height);
  const pick = whole ?? readable[0] ?? options[options.length - 1];
  return {
    columns: pick.columns,
    scale: pick.scale,
    width: Math.floor(pick.plan.width * pick.scale),
    height: Math.floor(pick.plan.height * pick.scale),
  };
}
