/**
 * The mock documentary run, for offline demos (`?source=mock`) and tests. It is the Python mock emitter's
 * own output (packages/contracts/fixtures/mock_trace.jsonl), so the visualizer and the sidecar replay the
 * same run; `replayTimed` re-dates it to now and plays it with its real spacing.
 */
import type { TelemetryEnvelope } from "@vibecut/contracts";
import { TelemetryEnvelopeSchema } from "@vibecut/contracts";
import fixture from "@vibecut/contracts/fixtures/mock_trace.jsonl?raw";

export const MOCK_TRACE_ID = "trc_mock_0001";

/** The fixture's envelopes, checked against the contract. */
export function mockTrace(traceId: string = MOCK_TRACE_ID, startMs?: number): TelemetryEnvelope[] {
  const parsed = fixture
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => TelemetryEnvelopeSchema.parse(JSON.parse(line)));
  const base = parsed[0]?.timestamp_ms ?? 0;
  const shift = startMs === undefined ? 0 : startMs - base;
  return parsed.map((env) => ({ ...env, trace_id: traceId, timestamp_ms: env.timestamp_ms + shift }));
}

/** A larger synthetic trace (n envelopes) built by repeating the run with new task ids, for load tests. */
export function syntheticTrace(count: number, traceId = "trc_synthetic"): TelemetryEnvelope[] {
  const run = mockTrace(traceId);
  const out: TelemetryEnvelope[] = [];
  for (let lap = 0; out.length < count; lap++) {
    for (const env of run) {
      if (out.length >= count) break;
      const payload = JSON.parse(JSON.stringify(env.payload).replaceAll('"task_', `"t${lap}_task_`)) as TelemetryEnvelope["payload"];
      out.push({ ...env, seq_id: out.length + 1, event_id: `evt_syn_${out.length + 1}`, payload, timestamp_ms: env.timestamp_ms + lap * 3000 });
    }
  }
  return out;
}

/** Plays the run into `sink` with its own spacing (divided by `speed`); returns a stop function. */
export function replayTimed(
  sink: (envelopes: TelemetryEnvelope[]) => void,
  options: { speed?: number; traceId?: string; now?: () => number } = {},
): () => void {
  const now = options.now ?? Date.now;
  const speed = options.speed ?? 1;
  const run = mockTrace(options.traceId ?? MOCK_TRACE_ID, now());
  const base = run[0]?.timestamp_ms ?? 0;
  const timers: ReturnType<typeof setTimeout>[] = [];
  const byDelay = new Map<number, TelemetryEnvelope[]>();
  for (const env of run) {
    const delay = Math.round((env.timestamp_ms - base) / speed);
    const group = byDelay.get(delay) ?? [];
    group.push({ ...env, timestamp_ms: base + delay });
    byDelay.set(delay, group);
  }
  for (const [delay, group] of byDelay) {
    timers.push(setTimeout(() => sink(group.map((e) => ({ ...e, timestamp_ms: now() }))), delay));
  }
  return () => timers.forEach(clearTimeout);
}
