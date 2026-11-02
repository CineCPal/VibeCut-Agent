"""The Python side of the telemetry contract (`vibecut.telemetry.v1`), re-exported from the sidecar.

The canonical implementation is `src-python/vibecut_agent/telemetry/bus.py` (PLAN.md, "Phase 22", V1):
the sidecar ships only `src-python/` (tauri.conf.json `bundle.resources`), so the bus lives there and this
module gives `packages/contracts` the same names as `telemetry.ts`. Import it with `src-python` on the
path (`uv run`, pytest's `pythonpath`)."""

from __future__ import annotations

from vibecut_agent.telemetry.bus import (
    CRITICAL_EVENTS,
    DELTA_OP_TYPES,
    ENABLE_ENV,
    EVENT_TYPES,
    HARDWARE_BACKENDS,
    SCHEMA_VERSION,
    SEVERITIES,
    SUBAGENT_TYPES,
    SUPPORTED_RATES,
    Envelope,
    HardwareBackend,
    LogSeverity,
    RawTelemetryItem,
    SubagentType,
    TelemetryBus,
    TelemetryEventType,
    get_bus,
    telemetry_dir,
    validate_envelope,
)

__all__ = [
    "CRITICAL_EVENTS",
    "DELTA_OP_TYPES",
    "ENABLE_ENV",
    "EVENT_TYPES",
    "HARDWARE_BACKENDS",
    "SCHEMA_VERSION",
    "SEVERITIES",
    "SUBAGENT_TYPES",
    "SUPPORTED_RATES",
    "Envelope",
    "HardwareBackend",
    "LogSeverity",
    "RawTelemetryItem",
    "SubagentType",
    "TelemetryBus",
    "TelemetryEventType",
    "get_bus",
    "telemetry_dir",
    "validate_envelope",
]
