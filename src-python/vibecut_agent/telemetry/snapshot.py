"""A trace's state at one point, for `GET /api/v1/traces/{trace_id}/snapshot` (visualizer-spec.md §2.3 B).

`snapshot()` gives two things (PLAN.md, "Phase 22", V7):
- `nodes`, `edges`, `otio_tracks` and `recent_logs`: the state worked out here, for any client that wants it
  ready-made (curl, a script).
- `replay_events`: the trace compacted to what still matters. That means every Tier-0 event, each task's
  latest BATCH_PROGRESS, each (task, channel)'s STREAM_CHUNKs joined, and the latest RESOURCE_HEARTBEAT.
  The visualizer hydrates by reducing these with its own reducer, so its UI has one source of truth.

The status order (the causal lattice of §2.3 A) is the visualizer's: a terminal status can't go back to a
working one, except when a recoverable failure is retried with a new SPAWN."""

from __future__ import annotations

from typing import Any

from vibecut_agent.telemetry.bus import CRITICAL_EVENTS, Envelope

STATUS_RANK = {
    "PENDING_SPAWN": 0,
    "SPAWNED": 1,
    "PLANNING": 2,
    "WAITING_UPSTREAM": 2,
    "TOOL_EXECUTION": 2,
    "MUTATION_EMITTED": 3,
    "COMPLETED": 4,
    "FAILED": 4,
}
EVENT_STATUS = {
    "SPAWN": "SPAWNED",
    "PLANNING": "PLANNING",
    "WAITING_UPSTREAM": "WAITING_UPSTREAM",
    "TOOL_INVOCATION": "TOOL_EXECUTION",
    "MUTATION_EMITTED": "MUTATION_EMITTED",
    "COMPLETED": "COMPLETED",
    "FAILED": "FAILED",
}
RECENT_LOGS = 500


def compact(events: list[Envelope]) -> list[Envelope]:
    """The trace with its Tier-1 events folded (see the module docstring), in seq order."""
    kept: list[Envelope] = []
    progress: dict[str, Envelope] = {}
    streams: dict[tuple[str, str], Envelope] = {}
    heartbeat: Envelope | None = None
    for env in sorted(events, key=lambda e: e["seq_id"]):
        kind = env["event_type"]
        payload = env["payload"]
        if kind in CRITICAL_EVENTS:
            kept.append(env)
        elif kind == "BATCH_PROGRESS":
            progress[str(payload.get("task_id"))] = env
        elif kind == "STREAM_CHUNK":
            key = (str(payload.get("task_id")), str(payload.get("stream_channel")))
            before = streams.get(key)
            if before is None:
                streams[key] = env
            else:
                joined = str(before["payload"].get("delta_text", "")) + str(payload.get("delta_text", ""))
                streams[key] = {**env, "payload": {**payload, "delta_text": joined}}
        elif kind == "RESOURCE_HEARTBEAT":
            heartbeat = env
    kept += progress.values()
    kept += streams.values()
    if heartbeat is not None:
        kept.append(heartbeat)
    return sorted(kept, key=lambda e: e["seq_id"])


def _node(task_id: str, env: Envelope) -> dict[str, Any]:
    return {
        "task_id": task_id,
        "trace_id": env["trace_id"],
        "parent_task_id": env.get("parent_task_id"),
        "agent_id": env["agent_id"],
        "subagent_type": env["subagent_type"],
        "task_label": task_id,
        "model_id": "",
        "hardware_backend": "CPU_NEON",
        "status": "PENDING_SPAWN",
        "last_status_seq_id": 0,
        "dependencies": [],
        "latency_ms": 0.0,
        "progress": None,
        "error": None,
        "artifacts": [],
        "emitted_mutations": [],
    }


def _advance(node: dict[str, Any], status: str, seq_id: int, retry: bool = False) -> None:
    current = STATUS_RANK[node["status"]]
    new = STATUS_RANK[status]
    if retry or new > current or (new == 2 and current == 2 and seq_id > node["last_status_seq_id"]):
        node["status"] = status
        node["last_status_seq_id"] = seq_id


def snapshot(trace_id: str, events: list[Envelope]) -> dict[str, Any]:
    nodes: dict[str, dict[str, Any]] = {}
    edges: dict[str, dict[str, Any]] = {}
    deltas: dict[str, dict[str, Any]] = {}

    def edge(source: str, target: str, kind: str, packet: str | None = None, nbytes: int = 0) -> None:
        edge_id = f"{kind}:{source}->{target}"
        entry = edges.setdefault(
            edge_id,
            {
                "edge_id": edge_id,
                "source_task_id": source,
                "target_task_id": target,
                "edge_kind": kind,
                "packet_type": packet,
                "transfer_count": 0,
                "total_bytes": 0,
            },
        )
        if kind == "CONTEXT_HANDOFF":
            entry["transfer_count"] += 1
            entry["total_bytes"] += nbytes
            entry["packet_type"] = packet

    ordered = sorted(events, key=lambda e: e["seq_id"])
    for env in ordered:
        kind = env["event_type"]
        payload = env["payload"]
        task_id = payload.get("task_id")
        if kind == "CONTEXT_HANDOFF":
            source, target = str(payload["from_task_id"]), str(payload["to_task_id"])
            if source != target:
                edge(
                    source,
                    target,
                    "CONTEXT_HANDOFF",
                    payload.get("packet_type"),
                    int(payload["payload_bytes"]),
                )
            continue
        if not isinstance(task_id, str) or kind not in EVENT_STATUS:
            if kind == "BATCH_PROGRESS" and isinstance(task_id, str):
                node = nodes.setdefault(task_id, _node(task_id, env))
                node["progress"] = {
                    k: payload.get(k) for k in ("phase", "completed_items", "total_items", "fraction")
                }
            continue
        node = nodes.setdefault(task_id, _node(task_id, env))
        if kind == "SPAWN":
            retry = node["status"] == "FAILED" and bool((node["error"] or {}).get("recoverable"))
            node.update(
                agent_id=env["agent_id"],
                subagent_type=env["subagent_type"],
                parent_task_id=env.get("parent_task_id"),
                task_label=payload["task_label"],
                model_id=payload["model_id"],
                hardware_backend=payload["hardware_backend"],
                dependencies=list(payload.get("upstream_task_ids") or []),
            )
            if retry:
                node["error"] = None
            _advance(node, "SPAWNED", env["seq_id"], retry=retry)
            parent = env.get("parent_task_id")
            if parent and parent not in node["dependencies"]:
                edge(parent, task_id, "SPAWN_PARENT")
            for upstream in node["dependencies"]:
                edge(upstream, task_id, "DATA_DEPENDENCY")
            continue
        _advance(node, EVENT_STATUS[kind], env["seq_id"])
        if kind == "COMPLETED":
            node["latency_ms"] = payload.get("latency_ms", 0.0)
            node["artifacts"] = list(payload.get("artifacts") or [])
        elif kind == "FAILED":
            node["error"] = {
                k: payload.get(k)
                for k in ("error_code", "error_message", "recoverable", "retry_attempt", "remediation_hint")
            }
        elif kind == "MUTATION_EMITTED":
            mutation = {
                "delta_id": payload["delta_id"],
                "mutation_stage": payload["mutation_stage"],
                "validation_token": payload.get("validation_token"),
                "operations": payload.get("operations") or [],
                "timeline_fps": payload.get("timeline_fps"),
                "task_id": task_id,
                "seq_id": env["seq_id"],
            }
            node["emitted_mutations"].append(mutation)
            deltas[str(payload["delta_id"])] = mutation

    return {
        "trace_id": trace_id,
        "snapshot_seq_id": ordered[-1]["seq_id"] if ordered else 0,
        "nodes": list(nodes.values()),
        "edges": list(edges.values()),
        "otio_tracks": otio_tracks(deltas),
        "recent_logs": ordered[-RECENT_LOGS:],
        "replay_events": compact(ordered),
    }


def otio_tracks(deltas: dict[str, dict[str, Any]]) -> list[dict[str, Any]]:
    """Each track's latest operations, by delta (the OTIO dock's lanes, V9)."""
    tracks: dict[str, dict[str, Any]] = {}
    for mutation in deltas.values():
        for op in mutation["operations"]:
            label = f"{'V' if op.get('track_kind') == 'Video' else 'A'}{op.get('track_index', 1)}"
            track = tracks.setdefault(label, {"track": label, "operations": []})
            track["operations"].append(
                {**op, "delta_id": mutation["delta_id"], "mutation_stage": mutation["mutation_stage"]}
            )
    return sorted(
        tracks.values(),
        key=lambda t: (
            t["track"][0] != "V",
            -int(t["track"][1:]) if t["track"][0] == "V" else int(t["track"][1:]),
        ),
    )
