import type { ChatReviewItem } from "../types/chat";
import type { TimeRange } from "./timeline";

/** One executed tool call's outcome: `summary` is shown in the chat transcript, `result` is sent
 * back to Gemini as the functionResponse for the call. */
export interface ChatToolOutcome {
  summary: string;
  result: unknown;
  /** Findings to list under the summary line in the chat (review_edit). */
  review?: ChatReviewItem[];
  /** Files the tool wrote for the user (a connected editor's render), each shown with Show in Finder. */
  files?: string[];
}

export type Args = Record<string, unknown>;
export type Executor = (args: Args) => Promise<ChatToolOutcome>;

export function str(args: Args, key: string): string {
  const value = args[key];
  if (typeof value !== "string" || !value) throw new Error(`${key} must be a non-empty string`);
  return value;
}
export function optStr(args: Args, key: string): string | undefined {
  const value = args[key];
  return typeof value === "string" && value ? value : undefined;
}
export function num(args: Args, key: string): number {
  const value = args[key];
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${key} must be a number`);
  return value;
}
export function optNum(args: Args, key: string): number | undefined {
  const value = args[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
export function bool(args: Args, key: string, fallback = false): boolean {
  const value = args[key];
  return typeof value === "boolean" ? value : fallback;
}
export function strArray(args: Args, key: string): string[] {
  const value = args[key];
  if (!Array.isArray(value) || !value.every((v) => typeof v === "string")) {
    throw new Error(`${key} must be an array of strings`);
  }
  return value as string[];
}
export function ranges(args: Args, key: string): TimeRange[] {
  const value = args[key];
  if (!Array.isArray(value)) throw new Error(`${key} must be an array of {start, end} objects`);
  return value.map((r, i) => {
    if (typeof r !== "object" || r === null || typeof (r as Args).start !== "number" || typeof (r as Args).end !== "number") {
      throw new Error(`${key}[${i}] must be {start: number, end: number}`);
    }
    const range = { start: (r as Args).start as number, end: (r as Args).end as number };
    if (!(range.end > range.start)) throw new Error(`${key}[${i}] must have end greater than start (got ${range.start} to ${range.end})`);
    return range;
  });
}

export const clock = (seconds: number): string => `${seconds.toFixed(1)}s`;

/** Seconds rounded to hundredths — enough precision for an edit, far fewer tokens than a raw float. */
export const round2 = (seconds: number): number => Math.round(seconds * 100) / 100;
