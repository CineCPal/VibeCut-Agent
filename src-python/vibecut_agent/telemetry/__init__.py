"""Telemetry for the visualizer (docs/specs/visualizer-spec.md, `vibecut.telemetry.v1`; PLAN.md, "Phase 22").

`bus` emits and journals events, `instrument` builds them for the tool bus and the ingest command,
`gateway` serves them over HTTP, SSE and WebSocket, and `mock_emitter` makes a deterministic trace to try
it all on. Stdlib only."""
