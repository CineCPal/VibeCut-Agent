/**
 * The virtual studio as an edit suite (PLAN.md, "The studio as an edit suite", 2026-11-05; visualizer-spec.md
 * §3): seven rooms, one per SubagentType, and in each a workstation per bot or tool (lib/studio/stations.ts),
 * where that agent's bot sits at its desk with its gear, an on-air lamp, its nameplate and what it's doing.
 * Packets fly from desk to desk. The floor plan (lib/studio/suite.ts) takes 1, 2 or 3 columns of rooms to suit
 * the box, so a narrow Premiere panel gets one readable column that scrolls.
 *
 * Drawn on one Canvas 2D, reading the store each frame, so a frame never waits on React. With every desk idle
 * and no packet in flight it drops to 6 FPS. Over each desk sits a transparent button: a click or Enter
 * selects the desk's task, and screen readers get the desk's state.
 */
import type { SubagentType } from "@vibecut/contracts";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { AVATAR_ANIMATION, effectiveAvatar, idleBay } from "../../lib/studio/avatarFsm";
import { CONDUITS, pointAt, type Point } from "../../lib/studio/conduits";
import { packetProgress } from "../../lib/studio/packets";
import { STATION_BY_KEY, type StationConfig, type StationGear } from "../../lib/studio/stations";
import { deskActivity } from "../../lib/studio/activity";
import { fitSuite, STUDIO_STYLES, suiteLayout, type RoomPlace, type StationPlace, type StudioStyle, type SuiteLayout } from "../../lib/studio/suite";
import type { TraceState } from "../../lib/reconciler/reduce";
import { selectView, useVisualizerStore } from "../../store/useVisualizerStore";
import type { AvatarState, StudioBayState } from "../../types/studio";
import { buildAtlas, CELL, FRAMES, spriteUrl } from "./ProceduralPixelAvatar";

export const IDLE_FRAME_MS = 166;
const STYLE_LABEL: Record<StudioStyle, string> = { suite: "Suite", compact: "Compact" };
const SANS = "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif";
const MONO = "'Fira Code', 'JetBrains Mono', monospace";
const AVATAR_SIZE = 60;

type Ctx = CanvasRenderingContext2D;
type Guests = Partial<Record<SubagentType, string[]>>;

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

/** A desk's state: its own once its agent has reported, else idle. */
export function stationState(view: TraceState, station: StationConfig): StudioBayState {
  return view.studioStations[station.key] ?? idleBay(station.subagent);
}

/** Agents seen that the catalogue doesn't list, by room, in the order they arrived: each gets a desk. */
export function guestsOf(view: TraceState): Guests {
  const guests: Guests = {};
  for (const [key, state] of Object.entries(view.studioStations)) {
    // A listed agent keeps its own desk, whichever role it reported as.
    if (STATION_BY_KEY.has(key)) continue;
    (guests[state.subagent] ??= []).push(key);
  }
  return guests;
}

export function isStudioIdle(view: TraceState, nowMs: number): boolean {
  if (view.activePackets.some((p) => p.born_ms + p.duration_ms > nowMs)) return false;
  return (
    Object.values(view.studioBays).every((b) => effectiveAvatar(b, nowMs) === "IDLE") &&
    Object.values(view.studioStations).every((s) => effectiveAvatar(s, nowMs) === "IDLE")
  );
}

function rounded(ctx: Ctx, x: number, y: number, w: number, h: number, r: number): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/** Word-wraps `text` to at most `lines` lines no wider than `max`, the last cut with an ellipsis. */
function wrap(ctx: Ctx, text: string, max: number, lines: number): string[] {
  const out: string[] = [];
  let current = "";
  for (const word of text.split(" ")) {
    const next = current ? `${current} ${word}` : word;
    if (current && ctx.measureText(next).width > max) {
      out.push(current);
      current = word;
    } else {
      current = next;
    }
  }
  if (current) out.push(current);
  if (out.length <= lines) return out;
  const kept = out.slice(0, lines);
  let last = kept[lines - 1];
  while (last.length > 1 && ctx.measureText(`${last}…`).width > max) last = last.slice(0, -1);
  kept[lines - 1] = `${last}…`;
  return kept;
}

function fit(ctx: Ctx, text: string, max: number): string {
  return wrap(ctx, text, max, 1)[0] ?? "";
}

/** A screen: dark when idle; lit in the desk's colour with moving bars when busy. */
function screen(ctx: Ctx, x: number, y: number, w: number, h: number, lit: string | null, nowMs: number, seed: number): void {
  ctx.fillStyle = "#30363d";
  ctx.fillRect(x - 2, y - 2, w + 4, h + 4);
  ctx.fillStyle = "#06090d";
  ctx.fillRect(x, y, w, h);
  // The stand.
  ctx.fillStyle = "#30363d";
  ctx.fillRect(x + w / 2 - 3, y + h + 2, 6, 5);
  if (!lit) return;
  ctx.globalAlpha = 0.18;
  ctx.fillStyle = lit;
  ctx.fillRect(x, y, w, h);
  ctx.globalAlpha = 0.85;
  const bars = Math.max(3, Math.floor(w / 9));
  for (let i = 0; i < bars; i++) {
    const level = 0.25 + 0.65 * Math.abs(Math.sin(nowMs / 260 + i * 0.9 + seed));
    const bh = Math.round((h - 6) * level);
    ctx.fillRect(x + 3 + i * 9, y + h - 3 - bh, 5, bh);
  }
  ctx.globalAlpha = 1;
}

/** What stands on a desk, in the band above it (`x`, `y` its top left, `w` x 58). */
function drawGear(ctx: Ctx, gear: StationGear, x: number, y: number, w: number, lit: string | null, nowMs: number, accent: string): void {
  const cx = x + w / 2;
  switch (gear) {
    case "bridge":
      screen(ctx, x + 6, y + 6, w - 12, 40, lit, nowMs, 1);
      // The tally lamp over the bridge.
      ctx.fillStyle = lit ? "#ff5252" : "#3a1f22";
      ctx.fillRect(cx - 16, y - 2, 32, 6);
      break;
    case "monitor":
      screen(ctx, x + 10, y + 8, 70, 40, lit, nowMs, 2);
      screen(ctx, x + w - 80, y + 8, 70, 40, lit, nowMs, 3);
      break;
    case "deck":
      for (const dx of [26, 70]) {
        ctx.strokeStyle = "#8b949e";
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.arc(x + dx, y + 26, 17, 0, Math.PI * 2);
        ctx.stroke();
        const spin = lit ? nowMs / 180 : 0;
        ctx.beginPath();
        ctx.moveTo(x + dx, y + 26);
        ctx.lineTo(x + dx + Math.cos(spin) * 15, y + 26 + Math.sin(spin) * 15);
        ctx.stroke();
      }
      screen(ctx, x + w - 66, y + 10, 56, 34, lit, nowMs, 4);
      break;
    case "light_table": {
      ctx.fillStyle = lit ? "#e6edf3" : "#2a2f37";
      ctx.globalAlpha = lit ? 0.9 : 1;
      ctx.fillRect(x + 8, y + 12, w - 16, 34);
      ctx.globalAlpha = 1;
      for (let i = 0; i < 4; i++) {
        ctx.fillStyle = lit ? accent : "#161b22";
        ctx.fillRect(x + 16 + i * ((w - 32) / 4), y + 18, (w - 32) / 4 - 8, 22);
      }
      // The loupe.
      ctx.strokeStyle = "#8b949e";
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.arc(x + w - 22, y + 10, 9, 0, Math.PI * 2);
      ctx.stroke();
      break;
    }
    case "rack":
      ctx.fillStyle = "#1c2128";
      ctx.fillRect(cx - 40, y, 80, 54);
      for (let r = 0; r < 5; r++) {
        ctx.fillStyle = "#30363d";
        ctx.fillRect(cx - 36, y + 4 + r * 10, 72, 7);
        const on = lit && Math.floor(nowMs / 140 + r * 3) % 4 !== 0;
        ctx.fillStyle = on ? lit : "#0d1117";
        ctx.fillRect(cx + 26, y + 5 + r * 10, 5, 5);
      }
      break;
    case "catalog":
      for (let r = 0; r < 3; r++) {
        for (let c = 0; c < 5; c++) {
          ctx.fillStyle = "#3b2f25";
          ctx.fillRect(x + 12 + c * 32, y + 4 + r * 17, 28, 14);
          ctx.fillStyle = lit && (r * 5 + c + Math.floor(nowMs / 300)) % 7 === 0 ? lit : "#99928a";
          ctx.fillRect(x + 22 + c * 32, y + 9 + r * 17, 8, 3);
        }
      }
      break;
    case "flatbed": {
      ctx.fillStyle = "#2a2f37";
      ctx.fillRect(x + 6, y + 18, w - 12, 26);
      const offset = lit ? Math.floor(nowMs / 60) % 12 : 0;
      ctx.fillStyle = "#0d1117";
      ctx.fillRect(x + 6, y + 23, w - 12, 16);
      for (let i = -1; i < (w - 12) / 12; i++) {
        const fx = x + 6 + i * 12 + offset;
        if (fx < x + 6 || fx > x + w - 14) continue;
        ctx.fillStyle = lit ? accent : "#30363d";
        ctx.fillRect(fx + 2, y + 26, 8, 10);
        ctx.fillStyle = "#8b949e";
        ctx.fillRect(fx + 4, y + 19, 3, 3);
        ctx.fillRect(fx + 4, y + 40, 3, 3);
      }
      break;
    }
    case "console":
      ctx.fillStyle = "#1c2128";
      ctx.fillRect(x + 8, y + 10, w - 16, 40);
      for (let i = 0; i < 9; i++) {
        const fx = x + 18 + i * ((w - 36) / 9);
        ctx.fillStyle = "#30363d";
        ctx.fillRect(fx, y + 14, 3, 32);
        const level = lit ? 0.2 + 0.6 * Math.abs(Math.sin(nowMs / 400 + i)) : 0.6;
        ctx.fillStyle = lit ? lit : "#72808a";
        ctx.fillRect(fx - 4, y + 14 + 26 * level, 11, 6);
      }
      break;
    case "grade":
      for (const dx of [30, 66, 102]) {
        ctx.fillStyle = "#1c2128";
        ctx.fillRect(x + dx - 16, y + 24, 32, 26);
        ctx.fillStyle = lit ? lit : "#4a4f57";
        ctx.beginPath();
        ctx.arc(x + dx, y + 34, 10, 0, Math.PI * 2);
        ctx.fill();
      }
      // The vectorscope.
      ctx.strokeStyle = lit ?? "#30363d";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(x + w - 28, y + 22, 18, 0, Math.PI * 2);
      ctx.stroke();
      if (lit) {
        const a = nowMs / 500;
        ctx.fillStyle = lit;
        ctx.fillRect(x + w - 28 + Math.cos(a) * 9 - 2, y + 22 + Math.sin(a) * 9 - 2, 4, 4);
      }
      break;
    case "notes":
      ctx.fillStyle = "#2b2418";
      ctx.fillRect(x + 10, y + 4, w - 20, 48);
      ["#ffb300", "#4a90d9", "#00c853", "#99928a", "#ff5252", "#e6edf3"].forEach((c, i) => {
        ctx.fillStyle = c;
        ctx.globalAlpha = lit ? 0.95 : 0.45;
        ctx.fillRect(x + 18 + (i % 3) * 50, y + 10 + Math.floor(i / 3) * 21, 38, 15);
      });
      ctx.globalAlpha = 1;
      break;
  }
}

function drawStation(ctx: Ctx, place: StationPlace, accent: string, state: StudioBayState, avatar: AvatarState, nowMs: number, selected: boolean): void {
  const { x, y, w, h, station } = place;
  const { row, fps, halo } = AVATAR_ANIMATION[avatar];
  const busy = avatar !== "IDLE";
  rounded(ctx, x, y, w, h, 8);
  ctx.fillStyle = busy ? "#1a2029" : "#161b22";
  ctx.fill();
  ctx.lineWidth = selected ? 3 : busy ? 2 : 1;
  ctx.strokeStyle = selected ? "#e6edf3" : busy ? halo : "#30363d";
  ctx.stroke();

  // The gear on the back of the desk, then the desk.
  drawGear(ctx, station.gear, x + 6, y + 10, w - 12, busy ? halo : null, nowMs, accent);
  ctx.fillStyle = "#2a2f37";
  ctx.fillRect(x + 8, y + 72, w - 16, 10);
  ctx.fillStyle = accent;
  ctx.globalAlpha = 0.5;
  ctx.fillRect(x + 8, y + 72, w - 16, 2);
  ctx.globalAlpha = 1;

  // The on-air lamp.
  ctx.fillStyle = busy ? halo : "#30363d";
  ctx.beginPath();
  ctx.arc(x + w - 12, y + 12, 5, 0, Math.PI * 2);
  ctx.fill();

  // The bot, in its chair at the desk.
  const ax = x + 8;
  const ay = y + 86;
  ctx.globalAlpha = 0.35;
  ctx.fillStyle = halo;
  ctx.fillRect(ax + 4, ay + AVATAR_SIZE - 6, AVATAR_SIZE - 8, 6);
  ctx.globalAlpha = busy ? 1 : 0.6;
  const sheet = spriteSheet(station.subagent) ?? buildAtlas(station.subagent);
  if (sheet) {
    const frame = Math.floor(nowMs / (1000 / fps)) % FRAMES;
    ctx.drawImage(sheet as CanvasImageSource, frame * CELL, row * CELL, CELL, CELL, ax, ay, AVATAR_SIZE, AVATAR_SIZE);
  }
  ctx.globalAlpha = 1;

  // The nameplate, what the desk does, and what it's doing now.
  const tx = ax + AVATAR_SIZE + 6;
  const tw = x + w - 8 - tx;
  ctx.textAlign = "left";
  ctx.textBaseline = "top";
  ctx.fillStyle = "#ffffff";
  ctx.font = `700 15px ${SANS}`;
  ctx.fillText(fit(ctx, station.title, tw), tx, y + 90);
  ctx.fillStyle = "#72808a";
  ctx.font = `12px ${SANS}`;
  wrap(ctx, station.role, tw, 2).forEach((line, i) => ctx.fillText(line, tx, y + 110 + i * 15));
  ctx.font = `600 12px ${MONO}`;
  ctx.fillStyle = busy ? halo : "#4a535c";
  ctx.fillText(fit(ctx, busy ? state.hud : "READY", tw), tx, y + 146);

  if (state.progress !== null && avatar === "READING_ASSET") {
    ctx.fillStyle = "#30363d";
    ctx.fillRect(x + 8, y + h - 8, w - 16, 4);
    ctx.fillStyle = "#38bdf8";
    ctx.fillRect(x + 8, y + h - 8, Math.round((w - 16) * state.progress), 4);
  }
}

function drawRoom(ctx: Ctx, room: RoomPlace, busy: number): void {
  rounded(ctx, room.x, room.y, room.w, room.h, 10);
  ctx.fillStyle = "#0f141a";
  ctx.fill();
  ctx.lineWidth = 2;
  ctx.strokeStyle = room.accent;
  ctx.globalAlpha = 0.55;
  ctx.stroke();
  ctx.globalAlpha = 0.12;
  ctx.fillStyle = room.accent;
  ctx.fillRect(room.x + 1, room.y + 1, room.w - 2, 34);
  ctx.globalAlpha = 1;
  ctx.fillStyle = room.accent;
  ctx.fillRect(room.x + 14, room.y + 12, 10, 10);
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  ctx.font = `700 16px ${SANS}`;
  ctx.fillStyle = "#e6edf3";
  const status = busy ? `${busy} at work` : "quiet";
  ctx.fillText(fit(ctx, room.title, room.w - 130), room.x + 32, room.y + 18);
  ctx.font = `12px ${MONO}`;
  ctx.fillStyle = busy ? room.accent : "#72808a";
  ctx.textAlign = "right";
  ctx.fillText(status, room.x + room.w - 14, room.y + 18);
}

/** The compact style's room: a slim header with a live load bar (the share of its desks at work). */
function drawCompactRoom(ctx: Ctx, room: RoomPlace, busy: number, nowMs: number): void {
  rounded(ctx, room.x, room.y, room.w, room.h, 8);
  ctx.fillStyle = "#0f141a";
  ctx.fill();
  ctx.lineWidth = 1.5;
  ctx.strokeStyle = room.accent;
  ctx.globalAlpha = busy ? 0.75 : 0.35;
  ctx.stroke();
  ctx.globalAlpha = 1;
  ctx.fillStyle = room.accent;
  ctx.beginPath();
  ctx.arc(room.x + 14, room.y + 14, 4, 0, Math.PI * 2);
  ctx.fill();
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  ctx.font = `700 13px ${SANS}`;
  ctx.fillStyle = "#e6edf3";
  ctx.fillText(fit(ctx, room.title, room.w - 90), room.x + 24, room.y + 14);
  ctx.textAlign = "right";
  ctx.font = `11px ${MONO}`;
  ctx.fillStyle = busy ? room.accent : "#72808a";
  ctx.fillText(busy ? `${busy}/${room.stations.length} live` : "idle", room.x + room.w - 10, room.y + 14);
  // The load bar, its edge shimmering while the room works.
  const share = room.stations.length ? busy / room.stations.length : 0;
  ctx.fillStyle = "#1c232c";
  ctx.fillRect(room.x + 10, room.y + 24, room.w - 20, 2);
  if (share > 0) {
    ctx.fillStyle = room.accent;
    ctx.globalAlpha = 0.7 + 0.3 * Math.sin(nowMs / 220);
    ctx.fillRect(room.x + 10, room.y + 24, Math.max(4, (room.w - 20) * share), 2);
    ctx.globalAlpha = 1;
  }
}

/** The compact style's desk: a live tile with its bot, name, what it's doing and its last 20 s of activity. */
function drawCompactStation(
  ctx: Ctx,
  place: StationPlace,
  accent: string,
  state: StudioBayState,
  avatar: AvatarState,
  nowMs: number,
  selected: boolean,
  activity: number[] | undefined,
): void {
  const { x, y, w, h, station } = place;
  const { row, fps, halo } = AVATAR_ANIMATION[avatar];
  const busy = avatar !== "IDLE";
  rounded(ctx, x, y, w, h, 6);
  ctx.fillStyle = busy ? "#18202b" : "#131820";
  ctx.fill();
  // A success flashes the tile green as it fades.
  if (avatar === "SUCCESS_CELEBRATE" && state.celebrate_until_ms !== null) {
    ctx.globalAlpha = Math.max(0, (state.celebrate_until_ms - nowMs) / 1200) * 0.25;
    ctx.fillStyle = halo;
    ctx.fill();
    ctx.globalAlpha = 1;
  }
  // A busy tile pulses its border and a light sweeps across it.
  if (busy) {
    ctx.save();
    ctx.clip();
    const sweep = x + ((nowMs / 6) % (w + 40)) - 20;
    ctx.globalAlpha = 0.07;
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(sweep, y, 14, h);
    ctx.restore();
    ctx.globalAlpha = 1;
  }
  rounded(ctx, x, y, w, h, 6);
  ctx.lineWidth = selected ? 2.5 : 1.5;
  ctx.strokeStyle = selected ? "#e6edf3" : busy ? halo : "#262c34";
  ctx.globalAlpha = selected || !busy ? 1 : 0.55 + 0.45 * Math.abs(Math.sin(nowMs / 320));
  ctx.stroke();
  ctx.globalAlpha = 1;
  // The state bar down the left edge.
  ctx.fillStyle = busy ? halo : accent;
  ctx.globalAlpha = busy ? 1 : 0.25;
  ctx.fillRect(x, y + 6, 3, h - 12);
  ctx.globalAlpha = 1;

  const size = 34;
  ctx.globalAlpha = busy ? 1 : 0.5;
  const sheet = spriteSheet(station.subagent) ?? buildAtlas(station.subagent);
  if (sheet) {
    const frame = Math.floor(nowMs / (1000 / fps)) % FRAMES;
    ctx.drawImage(sheet as CanvasImageSource, frame * CELL, row * CELL, CELL, CELL, x + 8, y + (h - size) / 2, size, size);
  }
  ctx.globalAlpha = 1;

  const tx = x + 48;
  const tw = x + w - 8 - tx;
  ctx.textAlign = "left";
  ctx.textBaseline = "top";
  ctx.font = `700 13px ${SANS}`;
  ctx.fillStyle = busy ? "#ffffff" : "#99928a";
  ctx.fillText(fit(ctx, station.title, tw - 8), tx, y + 7);
  ctx.font = `600 11px ${MONO}`;
  ctx.fillStyle = busy ? halo : "#4a535c";
  ctx.fillText(fit(ctx, busy ? state.hud : "ready", tw), tx, y + 24);

  // The activity trace: its events per slice of the last 20 s, newest at the right.
  const counts = activity ?? [];
  const most = Math.max(1, ...counts);
  const bw = tw / Math.max(1, counts.length || 24);
  ctx.fillStyle = busy ? halo : accent;
  for (let i = 0; i < counts.length; i++) {
    if (!counts[i]) continue;
    const bh = Math.max(2, Math.round((counts[i] / most) * 16));
    ctx.globalAlpha = 0.35 + 0.65 * (i / counts.length);
    ctx.fillRect(tx + i * bw, y + h - 6 - bh, Math.max(1, bw - 1), bh);
  }
  ctx.globalAlpha = 1;
  ctx.fillStyle = "#262c34";
  ctx.fillRect(tx, y + h - 6, tw, 1);

  // The on-air lamp.
  ctx.fillStyle = busy ? halo : "#262c34";
  ctx.beginPath();
  ctx.arc(x + w - 9, y + 10, 3.5, 0, Math.PI * 2);
  ctx.fill();

  if (state.progress !== null && avatar === "READING_ASSET") {
    ctx.fillStyle = "#38bdf8";
    ctx.fillRect(x + 3, y + h - 3, Math.round((w - 6) * state.progress), 2);
  }
}

function roomCentre(room: RoomPlace): Point {
  return { x: room.x + room.w / 2, y: room.y + room.h / 2 };
}

/** Where a packet leaves from or arrives at: its desk, else its room's first desk. */
function deskPoint(layout: SuiteLayout, key: string | null, subagent: SubagentType): Point {
  const place = (key && layout.byKey.get(key)) || layout.rooms.find((r) => r.subagent === subagent)?.stations[0];
  // The suite's packets reach the desk's gear; the compact style's land on the bot, clear of its text.
  if (place) return layout.style === "compact" ? { x: place.x + 25, y: place.y + place.h / 2 } : { x: place.x + place.w / 2, y: place.y + 60 };
  const room = layout.rooms.find((r) => r.subagent === subagent);
  return room ? roomCentre(room) : { x: 0, y: 0 };
}

export function drawSuite(ctx: Ctx, layout: SuiteLayout, view: TraceState, nowMs: number, selectedTaskId: string | null): void {
  const compact = layout.style === "compact";
  ctx.imageSmoothingEnabled = false;
  ctx.fillStyle = "#0a0d12";
  ctx.fillRect(0, 0, layout.width, layout.height);
  // The floor's tiles (the suite only).
  if (!compact) {
    ctx.fillStyle = "#0d1117";
    for (let x = 0; x < layout.width; x += 24) {
      for (let y = (x / 24) % 2 ? 0 : 24; y < layout.height; y += 48) ctx.fillRect(x, y, 24, 24);
    }
  }
  // Cable trays between rooms that hand work on, under the rooms: they show in the corridors.
  const roomOf = new Map(layout.rooms.map((r) => [r.subagent, r]));
  ctx.strokeStyle = "#1f2630";
  ctx.lineWidth = compact ? 3 : 6;
  for (const [a, b] of CONDUITS) {
    const ra = roomOf.get(a);
    const rb = roomOf.get(b);
    if (!ra || !rb) continue;
    const pa = roomCentre(ra);
    const pb = roomCentre(rb);
    ctx.beginPath();
    ctx.moveTo(pa.x, pa.y);
    ctx.lineTo(pb.x, pa.y);
    ctx.lineTo(pb.x, pb.y);
    ctx.stroke();
  }

  const activity = compact ? deskActivity(view.logs, nowMs) : null;
  for (const room of layout.rooms) {
    const states = room.stations.map((place) => {
      const state = stationState(view, place.station);
      return { place, state, avatar: effectiveAvatar(state, nowMs) };
    });
    const busy = states.filter((s) => s.avatar !== "IDLE").length;
    if (compact) drawCompactRoom(ctx, room, busy, nowMs);
    else drawRoom(ctx, room, busy);
    for (const { place, state, avatar } of states) {
      const selected = selectedTaskId !== null && state.active_task_id === selectedTaskId;
      if (activity) drawCompactStation(ctx, place, room.accent, state, avatar, nowMs, selected, activity.get(place.station.key));
      else drawStation(ctx, place, room.accent, state, avatar, nowMs, selected);
    }
  }

  // Packets, desk to desk, each with a short trail and a comet tail; one label per spot, so packets that leave
  // together don't print over each other.
  const labelled: Point[] = [];
  for (const packet of view.activePackets) {
    const t = packetProgress(packet, nowMs);
    if (t === null) continue;
    const path = [deskPoint(layout, packet.from_key, packet.from), deskPoint(layout, packet.to_key, packet.to)];
    const tail = pointAt(path, Math.max(0, t - 0.18));
    const head = pointAt(path, t);
    ctx.globalAlpha = 0.35;
    ctx.strokeStyle = packet.color;
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(tail.x, tail.y);
    ctx.lineTo(head.x, head.y);
    ctx.stroke();
    for (let k = 3; k >= 0; k--) {
      const p = pointAt(path, Math.max(0, t - k * 0.04));
      ctx.globalAlpha = k === 0 ? 1 : 0.2 * (4 - k);
      ctx.fillStyle = packet.color;
      ctx.fillRect(Math.round(p.x - packet.w / 2), Math.round(p.y - packet.h / 2), packet.w, packet.h);
    }
    ctx.globalAlpha = 1;
    // In the compact style a packet lands with a ring at its desk.
    if (compact && t > 0.75) {
      const ring = (t - 0.75) / 0.25;
      ctx.globalAlpha = 1 - ring;
      ctx.strokeStyle = packet.color;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(path[1].x, path[1].y, 6 + ring * 22, 0, Math.PI * 2);
      ctx.stroke();
      ctx.globalAlpha = 1;
    }
    const p = head;
    if (packet.label && t > 0.08 && t < 0.92 && !labelled.some((q) => Math.abs(q.x - p.x) < 90 && Math.abs(q.y - p.y) < 16)) {
      labelled.push(p);
      ctx.fillStyle = "#e6edf3";
      ctx.font = `600 13px ${MONO}`;
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
  const boxRef = useRef<HTMLDivElement | null>(null);
  const view = useVisualizerStore(selectView);
  const selectTask = useVisualizerStore((s) => s.selectTask);
  const selectedTaskId = useVisualizerStore((s) => s.selectedTaskId);
  const style = useVisualizerStore((s) => s.studioStyle);
  const setStudioStyle = useVisualizerStore((s) => s.setStudioStyle);
  const [box, setBox] = useState<{ width: number; height: number } | null>(null);

  // Guest desks change the plan; key them so the plan is rebuilt only then.
  const guestKey = JSON.stringify(guestsOf(view));
  const guests = useMemo(() => JSON.parse(guestKey) as Guests, [guestKey]);
  const fitted = useMemo(() => (box ? fitSuite(box.width, box.height, guests, style) : null), [box, guests, style]);
  const layout = useMemo(() => suiteLayout(fitted?.columns ?? 3, guests, style), [fitted?.columns, guests, style]);
  const layoutRef = useRef(layout);
  layoutRef.current = layout;

  useLayoutEffect(() => {
    const element = boxRef.current;
    if (!element) return;
    const measure = () => {
      const next = { width: element.clientWidth, height: element.clientHeight };
      setBox((prev) => (prev && prev.width === next.width && prev.height === next.height ? prev : next));
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

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
    canvas.width = layout.width * dpr;
    canvas.height = layout.height * dpr;
    context.setTransform(dpr, 0, 0, dpr, 0, 0);
    let frame = 0;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let stopped = false;
    const tick = () => {
      if (stopped) return;
      const now = Date.now();
      const state = useVisualizerStore.getState();
      const current = selectView(state);
      drawSuite(context, layoutRef.current, current, now, state.selectedTaskId);
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
  }, [layout.width, layout.height, layout.style]);

  const scrolls = fitted !== null && box !== null && fitted.height > box.height;
  return (
    <div className={`flex h-full w-full flex-col bg-canvas ${className}`}>
      <div className="flex shrink-0 items-center justify-end gap-2 border-b border-border/60 px-2 py-1">
        <span className="text-[11px] text-cool-grey">Studio</span>
        <div role="group" aria-label="Studio style (S)" className="flex overflow-hidden rounded border border-border text-[11px]">
          {STUDIO_STYLES.map((option) => (
            <button
              key={option}
              type="button"
              aria-pressed={style === option}
              title={`${STYLE_LABEL[option]} studio (S switches)`}
              className={`px-2 py-0.5 ${style === option ? "bg-athletic-blue text-white" : "text-cool-grey hover:text-warm-grey"}`}
              onClick={() => setStudioStyle(option)}
            >
              {STYLE_LABEL[option]}
            </button>
          ))}
        </div>
      </div>
      <div
        ref={boxRef}
        className={`relative min-h-0 flex-1 ${scrolls ? "overflow-y-auto overflow-x-hidden" : "overflow-hidden"}`}
      >
        <div className={`flex min-h-full justify-center ${scrolls ? "items-start" : "items-center"}`}>
          <div
            className="relative shrink-0"
            data-testid="studio-frame"
            data-columns={layout.columns}
            style={
              fitted
                ? { width: `${fitted.width}px`, height: `${fitted.height}px` }
                : { width: "100%", aspectRatio: `${layout.width} / ${layout.height}` }
            }
          >
            <canvas
              ref={canvasRef}
              className="pixelated absolute inset-0 h-full w-full"
              role="img"
              aria-label={`Virtual edit suite (${STYLE_LABEL[layout.style]}): ${layout.rooms.length} rooms, ${layout.byKey.size} workstations`}
            />
            {layout.rooms.flatMap((room) =>
              room.stations.map((place) => {
                const state = stationState(view, place.station);
                const avatar = effectiveAvatar(state, Date.now());
                return (
                  <button
                    key={place.station.key}
                    type="button"
                    className="absolute rounded-md bg-transparent focus-visible:outline-2"
                    style={{
                      left: `${(place.x / layout.width) * 100}%`,
                      top: `${(place.y / layout.height) * 100}%`,
                      width: `${(place.w / layout.width) * 100}%`,
                      height: `${(place.h / layout.height) * 100}%`,
                    }}
                    aria-label={`${room.title}, ${place.station.title}: ${avatar.replaceAll("_", " ").toLowerCase()}${state.active_task_id ? `, task ${state.active_task_id}` : ""}`}
                    aria-pressed={selectedTaskId !== null && state.active_task_id === selectedTaskId}
                    data-subagent={room.subagent}
                    data-station={place.station.key}
                    data-avatar-state={avatar}
                    disabled={!state.active_task_id}
                    onClick={() => selectTask(state.active_task_id)}
                  />
                );
              }),
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
