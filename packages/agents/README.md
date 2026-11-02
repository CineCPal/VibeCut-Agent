# packages/agents

A pointer, not a package. The orchestrator and the local sub-agents live in the Python sidecar:

- `src-python/vibecut_agent/orchestrator/tool_bus.py`: `OrchestratorToolBus`, run by the MCP shim
  (`mcp_server.py`) for Claude. With `VIBECUT_TELEMETRY=1` each tool call is a task in the visualizer.
- `src-python/vibecut_agent/orchestrator/supervisor.py`: the in-process supervisor (kept, not routed to).
- `src-python/vibecut_agent/workers/`: Whisper, the VLM, the vector store, the validator, and the
  `ingest-index` pipeline (instrumented the same way).
- `src-python/vibecut_agent/telemetry/`: the telemetry bus, the gateway and the mock emitter.

See `docs/specs/visualizer-spec.md` §5.1 and PLAN.md, "Phase 22".
