/** The Python mock emitter's trace (packages/contracts/fixtures) against the Zod contracts. */
import { describe, expect, it } from "vitest";
import fixture from "@vibecut/contracts/fixtures/mock_trace.jsonl?raw";
import {
  CRITICAL_EVENT_TYPES,
  SUBAGENT_TYPES,
  TelemetryEnvelopeSchema,
  TelemetryEventTypeSchema,
  WsClientHelloSchema,
  WsServerMessageSchema,
} from "@vibecut/contracts";

const lines = fixture.split("\n").filter((l) => l.trim());

describe("the shared contracts", () => {
  it("parse every envelope the Python bus wrote", () => {
    const results = lines.map((line) => TelemetryEnvelopeSchema.safeParse(JSON.parse(line)));
    const failures = results.flatMap((r, i) => (r.success ? [] : [`line ${i + 1}: ${r.error.message}`]));
    expect(failures).toEqual([]);
    const envelopes = results.map((r) => (r.success ? r.data : null)).filter((e) => e !== null);
    expect(new Set(envelopes.map((e) => e.subagent_type))).toEqual(new Set(SUBAGENT_TYPES));
    expect(new Set(envelopes.map((e) => e.event_type))).toEqual(new Set(TelemetryEventTypeSchema.options));
    expect(envelopes.map((e) => e.seq_id)).toEqual(envelopes.map((_, i) => i + 1));
  });

  it("reject an envelope whose payload doesn't match", () => {
    const env = JSON.parse(lines[0]);
    expect(TelemetryEnvelopeSchema.safeParse({ ...env, seq_id: 0 }).success).toBe(false);
    expect(TelemetryEnvelopeSchema.safeParse({ ...env, payload: { ...env.payload, kind: "NOPE" } }).success).toBe(false);
    expect(TelemetryEnvelopeSchema.safeParse({ ...env, subagent_type: "INTERN" }).success).toBe(false);
  });

  it("agree on the tiers and the wire messages", () => {
    expect([...CRITICAL_EVENT_TYPES].sort()).toEqual(
      ["COMPLETED", "CONTEXT_HANDOFF", "FAILED", "MUTATION_EMITTED", "PLANNING", "SPAWN", "TOOL_INVOCATION", "WAITING_UPSTREAM"],
    );
    const hello = WsClientHelloSchema.parse({
      type: "CLIENT_HELLO",
      protocol_version: "vibecut.ws.v1",
      client_id: "t",
      host_mode: "standalone",
      subscribe_trace_id: null,
      capabilities: {},
    });
    expect(hello.last_seen_seq_id).toBe(0);
    expect(hello.capabilities.binary_previews).toBe(true);
    expect(
      WsServerMessageSchema.parse({
        type: "PONG",
        client_time_ms: 1,
        server_time_ms: 2,
        latest_seq_id: 3,
      }).type,
    ).toBe("PONG");
  });
});
