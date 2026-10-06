/** Checked access to a tool call's arguments, ported from VibeCut's chatArgs.ts. */

export type Args = Record<string, unknown>;

/** One executed tool call: `summary` is shown in the chat, `result` goes back to the model. */
export interface ToolOutcome {
  summary: string;
  result: unknown;
}

export type Executor = (args: Args) => Promise<ToolOutcome>;

export function optStr(args: Args, key: string): string | undefined {
  const value = args[key];
  return typeof value === "string" ? value : undefined;
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
  if (!Array.isArray(value) || value.length === 0 || !value.every((v) => typeof v === "string")) {
    throw new Error(`${key} must be a non-empty array of strings`);
  }
  return value as string[];
}

/** "12.3s": how times read in summaries and snapshots. */
export const clock = (seconds: number): string => `${seconds.toFixed(1)}s`;
