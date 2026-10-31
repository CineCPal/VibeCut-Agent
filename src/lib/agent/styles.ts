/**
 * Learned styles (PLAN.md, "Phase 20b"): `learn_style` keeps a reference edit's pace, look and cutting to
 * the beat as one line in the project notes' Style section. The line reads as a sentence for the user
 * and the agent, and ends in a tag the tools read back: `{style "<name>" medianShot=3.76 ...}`.
 * `check_pacing` takes a style as its target and `match_clip_color` as its reference.
 */
import { loadNotes, MAX_NOTES_BYTES, saveNotes, withNote, withoutLine } from "../projectNotes";
import { useNleStateStore } from "../../store/useNleStateStore";
import type { NleHost } from "../../types/nle";
import type { PacingTarget } from "./pacingTools";

export const LOOK_KEYS = ["brightness", "contrast", "warmth", "tint", "colour"] as const;
const NUMBER_KEYS = ["medianShot", "p90Shot", "cutsPerMinute", ...LOOK_KEYS, "onBeat", "bpm"] as const;
type NumberKey = (typeof NUMBER_KEYS)[number];

export type Look = Record<(typeof LOOK_KEYS)[number], number>;

export type LearnedStyle = { name: string; medianShot: number; p90Shot: number; cutsPerMinute: number } & Partial<Record<Exclude<NumberKey, "medianShot" | "p90Shot" | "cutsPerMinute">, number>>;

const TAG = /\{style "([^"{}]+)"([^}]*)\}/;

/** A style's name: what the user calls it, without quotes or braces (they'd break the tag). */
export function styleName(raw: string | undefined): string {
  const name = (raw ?? "").replace(/\s+/g, " ").trim();
  if (!name || name.length > 40 || /["{}]/.test(name)) throw new Error('name must be 1 to 40 characters, without quotes or braces (e.g. "client promo")');
  return name;
}

/** The tag that ends a style's note line. */
export function styleTag(style: LearnedStyle): string {
  const values = NUMBER_KEYS.flatMap((k) => (style[k] !== undefined ? [`${k}=${style[k]}`] : []));
  return `{style "${style.name}" ${values.join(" ")}}`;
}

/** The styles learned into these notes, from their tags. */
export function parseStyles(text: string): LearnedStyle[] {
  return text.split("\n").flatMap((line) => {
    const tag = line.startsWith("-") ? TAG.exec(line) : null;
    if (!tag) return [];
    const values: Partial<Record<NumberKey, number>> = {};
    for (const [, key, value] of tag[2].matchAll(/(\w+)=(-?[\d.]+)/g)) {
      if ((NUMBER_KEYS as readonly string[]).includes(key) && Number.isFinite(Number(value))) values[key as NumberKey] = Number(value);
    }
    if (values.medianShot === undefined || values.p90Shot === undefined || values.cutsPerMinute === undefined) return [];
    return [{ ...values, name: tag[1] } as LearnedStyle];
  });
}

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/** The style called `name` in these notes. */
export function findStyle(text: string, name: string): LearnedStyle {
  const styles = parseStyles(text);
  const found = styles.find((s) => same(s.name, name));
  if (found) return found;
  throw new Error(styles.length ? `There's no learned style "${name}"; the project has ${styles.map((s) => `"${s.name}"`).join(", ")}` : `No style has been learned for this project yet; learn_style measures a reference edit first`);
}

/** The notes with this style's line in place of any earlier one of the same name. */
export function withStyle(text: string, style: LearnedStyle, sentence: string, date: string): string {
  let notes = text;
  for (;;) {
    const index = notes.split("\n").findIndex((line) => {
      const tag = line.startsWith("-") ? TAG.exec(line) : null;
      return tag !== null && same(tag[1], style.name);
    });
    if (index < 0) break;
    notes = withoutLine(notes, index);
  }
  return withNote(notes, "style", `${sentence} ${styleTag(style)} (${date})`) ?? notes;
}

/** A style's pace as `check_pacing`'s target: its median shot, and twice the length 90% of its shots
 * stay under as the longest shot. */
export function styleTarget(style: LearnedStyle): PacingTarget {
  return { medianShot: style.medianShot, maxShot: Math.round(style.p90Shot * 2 * 100) / 100 };
}

/** A style's look, for `match_clip_color`. */
export function styleLook(style: LearnedStyle): Look {
  const look = Object.fromEntries(LOOK_KEYS.map((k) => [k, style[k]]));
  if (LOOK_KEYS.some((k) => look[k] === undefined)) throw new Error(`The style "${style.name}" has no look (its reference's frames couldn't be measured); learn_style it again`);
  return look as Look;
}

function projectOf(host: NleHost): string {
  const project = useNleStateStore.getState().hosts[host].project;
  if (!project) throw new Error("No project is open in the editor, so there are no learned styles");
  return project;
}

/** The style called `name` in the open project's notes. */
export async function learnedStyle(host: NleHost, name: string): Promise<LearnedStyle> {
  return findStyle(await loadNotes(host, projectOf(host)), name);
}

/** Saves a style to the open project's notes; the project's name. */
export async function saveStyle(host: NleHost, style: LearnedStyle, sentence: string): Promise<string> {
  const project = projectOf(host);
  const after = withStyle(await loadNotes(host, project), style, sentence, new Date().toISOString().slice(0, 10));
  if (new TextEncoder().encode(after).length > MAX_NOTES_BYTES) throw new Error(`The project notes are full (${MAX_NOTES_BYTES / 1024} KB); forget_note lines that no longer hold first`);
  await saveNotes(host, project, after);
  return project;
}
