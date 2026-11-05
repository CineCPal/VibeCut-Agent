/**
 * Each desk's recent activity, for the compact studio's live traces (PLAN.md, "Studio styles"): how many of
 * its agent's events fell in each of `bins` equal slices of the last `windowMs`, oldest first. It reads the
 * log from its end and stops at the window's start (or after MAX_SCAN rows), so it is cheap every frame.
 * Heartbeats aren't activity.
 */
import type { TelemetryEnvelope } from "@vibecut/contracts";
import { stationKey } from "./stations";

export const ACTIVITY_WINDOW_MS = 20_000;
export const ACTIVITY_BINS = 24;
const MAX_SCAN = 4000;

export function deskActivity(
  logs: readonly TelemetryEnvelope[],
  nowMs: number,
  windowMs: number = ACTIVITY_WINDOW_MS,
  bins: number = ACTIVITY_BINS,
): Map<string, number[]> {
  const out = new Map<string, number[]>();
  const start = nowMs - windowMs;
  const stop = Math.max(0, logs.length - MAX_SCAN);
  for (let i = logs.length - 1; i >= stop; i--) {
    const env = logs[i];
    if (env.timestamp_ms < start) break;
    if (env.event_type === "RESOURCE_HEARTBEAT" || env.timestamp_ms > nowMs) continue;
    const key = stationKey(env.agent_id);
    let counts = out.get(key);
    if (!counts) {
      counts = new Array<number>(bins).fill(0);
      out.set(key, counts);
    }
    const bin = Math.min(bins - 1, Math.floor(((env.timestamp_ms - start) / windowMs) * bins));
    counts[bin] += 1;
  }
  return out;
}
