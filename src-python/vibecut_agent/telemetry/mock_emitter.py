"""A made-up documentary rough cut as telemetry (docs/specs/visualizer-spec.md §6 Phase 1; PLAN.md, "Phase 22").

Every SubagentType and every event kind, in the order a real orchestrated turn would make them: the
orchestrator plans, Whisper and the VLM read two interviews and a drone shot, the vector store finds
B-roll, the audio engineer syncs and ducks the music (failing once on the GPU lock and retrying), the
pacing cutter proposes and validates a 4-op OTIO delta at 23.976, and the NLE finisher commits it.

`generate()` is deterministic (a fixed clock and event ids): `packages/contracts/fixtures/mock_trace.jsonl`
is its output, which the visualizer's tests parse with the Zod contracts, so the two sides can't drift.
`play()` emits the same steps into a running bus with their real spacing, for the gateway's
TRIGGER_MOCK_RUN.

    python -m vibecut_agent.telemetry.mock_emitter --out DIR [--trace-id ID] [--realtime] [--speed 4]

writes `<DIR>/<trace_id>.jsonl` (with --realtime, step by step, for the gateway's tailer to stream)."""

from __future__ import annotations

import argparse
import asyncio
import itertools
import sys
import time
from collections.abc import Iterator
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from vibecut_agent.telemetry.bus import Envelope, TelemetryBus

DEFAULT_TRACE_ID = "trc_mock_0001"
# 2026-11-02 13:00:00 UTC, so the fixture's times look like a real session.
EPOCH_MS = 1_793_710_800_000
FPS = 23.976

ORCH = ("orchestrator.supervisor", "MASTER_ORCHESTRATOR")
WHISPER = ("worker.whisper.01", "INGEST_TRANSCRIBE")
VLM = ("worker.vlm.01", "VISION_TAGGER")
VECTOR = ("worker.vector.01", "BROLL_RETRIEVER")
CUTTER = ("worker.otio_cutter.01", "PACING_CUTTER")
AUDIO = ("worker.audio_sync.01", "AUDIO_ENGINEER")
NLE = ("worker.color_nle.01", "COLOR_GRADER")

ROOT, ING, VIS, VEC, AUD, CUT, FIN = (
    "task_root_001",
    "task_ing_002",
    "task_vlm_003",
    "task_vec_004",
    "task_aud_005",
    "task_cut_006",
    "task_nle_007",
)


def rt(frames: float) -> dict[str, Any]:
    return {"OTIO_SCHEMA": "RationalTime.1", "value": frames, "rate": FPS}


def tr(start: float, duration: float) -> dict[str, Any]:
    return {"OTIO_SCHEMA": "TimeRange.1", "start_time": rt(start), "duration": rt(duration)}


@dataclass(frozen=True)
class Step:
    """One event, `at_ms` after the run began."""

    at_ms: int
    agent: tuple[str, str]
    event_type: str
    payload: dict[str, Any]
    parent: str | None = ROOT
    severity: str = "INFO"


def spawn(
    at: int,
    agent: tuple[str, str],
    task: str,
    label: str,
    model: str,
    backend: str,
    upstream: list[str],
    summary: str,
    parent: str | None = ROOT,
) -> Step:
    return Step(
        at,
        agent,
        "SPAWN",
        {
            "task_id": task,
            "task_label": label,
            "model_id": model,
            "hardware_backend": backend,
            "upstream_task_ids": upstream,
            "input_summary": summary,
            "expected_timeout_ms": 60000,
        },
        parent,
    )


def tool(
    at: int, agent: tuple[str, str], task: str, name: str, args: dict[str, Any], gpu: bool, paths: list[str]
) -> Step:
    return Step(
        at,
        agent,
        "TOOL_INVOCATION",
        {
            "task_id": task,
            "tool_call_id": f"call_{task}",
            "tool_name": name,
            "target_subagent": agent[1],
            "arguments": args,
            "requires_gpu_lock": gpu,
            "media_paths": paths,
        },
    )


def progress(
    at: int, agent: tuple[str, str], task: str, phase: str, done: int, total: int, label: str | None
) -> Step:
    return Step(
        at,
        agent,
        "BATCH_PROGRESS",
        {
            "task_id": task,
            "phase": phase,
            "completed_items": done,
            "total_items": total,
            "fraction": round(done / total, 4),
            "eta_seconds": round((total - done) * 0.25, 2),
            "throughput_items_per_sec": 4.0,
            "current_item_label": label,
            "coalesced_event_count": 1,
        },
        severity="DEBUG",
    )


def handoff(
    at: int,
    frm: tuple[str, str],
    to: tuple[str, str],
    from_task: str,
    to_task: str,
    packet: str,
    nbytes: int,
    summary: str,
    clips: int = 0,
    tokens: int = 0,
) -> Step:
    return Step(
        at,
        frm,
        "CONTEXT_HANDOFF",
        {
            "from_task_id": from_task,
            "to_task_id": to_task,
            "from_agent_id": frm[0],
            "to_agent_id": to[0],
            "from_subagent": frm[1],
            "to_subagent": to[1],
            "packet_type": packet,
            "payload_bytes": nbytes,
            "token_count": tokens,
            "clip_count": clips,
            "summary": summary,
        },
    )


def completed(
    at: int,
    agent: tuple[str, str],
    task: str,
    latency: float,
    summary: str,
    artifacts: list[dict[str, Any]],
    tokens: tuple[int, int, int] = (0, 0, 0),
    cost: float = 0.0,
    memory: float = 0.0,
    parent: str | None = ROOT,
) -> Step:
    return Step(
        at,
        agent,
        "COMPLETED",
        {
            "task_id": task,
            "latency_ms": latency,
            "ttfb_ms": round(latency * 0.08, 1),
            "input_tokens": tokens[0],
            "output_tokens": tokens[1],
            "cached_tokens": tokens[2],
            "cost_usd": cost,
            "peak_memory_mb": memory,
            "output_summary": summary,
            "artifacts": artifacts,
        },
        parent,
    )


def thought(
    at: int, agent: tuple[str, str], task: str, text: str, tokens: int, channel: str = "THOUGHT"
) -> Step:
    return Step(
        at,
        agent,
        "STREAM_CHUNK",
        {"task_id": task, "stream_channel": channel, "delta_text": text, "accumulated_tokens": tokens},
        severity="DEBUG",
    )


INTERVIEW_A = "/Volumes/Media/Doc/A001_Intv.mov"
INTERVIEW_B = "/Volumes/Media/Doc/A001_Intv_B.mov"
DRONE = "/Volumes/Media/Doc/B004_Drone.mov"
MUSIC = "/Volumes/Media/Doc/Theme_Bed.wav"

OPERATIONS = [
    {
        "op_id": "op_001",
        "op_type": "TRIM_CLIP",
        "track_kind": "Video",
        "track_index": 1,
        "clip_id": "clip_a001",
        "source_name": "A001_Intv.mov",
        "target_url": "file://" + INTERVIEW_A,
        "source_range": tr(1726, 1188),
        "timeline_range": tr(0, 1188),
        "ripple": True,
        "gain_db": None,
        "transition_type": None,
    },
    {
        "op_id": "op_002",
        "op_type": "INSERT_CLIP",
        "track_kind": "Video",
        "track_index": 2,
        "clip_id": None,
        "source_name": "B004_Drone.mov",
        "target_url": "file://" + DRONE,
        "source_range": tr(5755, 302),
        "timeline_range": tr(240, 302),
        "ripple": False,
        "gain_db": None,
        "transition_type": None,
    },
    {
        "op_id": "op_003",
        "op_type": "OVERWRITE_CLIP",
        "track_kind": "Video",
        "track_index": 1,
        "clip_id": None,
        "source_name": "A001_Intv_B.mov",
        "target_url": "file://" + INTERVIEW_B,
        "source_range": tr(480, 960),
        "timeline_range": tr(1188, 960),
        "ripple": False,
        "gain_db": None,
        "transition_type": None,
    },
    {
        "op_id": "op_004",
        "op_type": "DUCK_REGION",
        "track_kind": "Audio",
        "track_index": 2,
        "clip_id": "clip_music",
        "source_name": "Theme_Bed.wav",
        "target_url": "file://" + MUSIC,
        "source_range": None,
        "timeline_range": tr(0, 2148),
        "ripple": False,
        "gain_db": -12.0,
        "transition_type": None,
    },
]


def mutation(
    at: int, stage: str, token: str | None, agent: tuple[str, str] = CUTTER, task: str = CUT
) -> Step:
    return Step(
        at,
        agent,
        "MUTATION_EMITTED",
        {
            "task_id": task,
            "delta_id": "delta_004",
            "mutation_stage": stage,
            "validation_token": token,
            "target_host": "resolve",
            "target_timeline": "Doc Teaser v1",
            "timeline_fps": FPS,
            "narrative_rationale": "Open on the strongest interview bite, lift with the drone reveal on "
            "V2, cut to the second take for the turn, and duck the bed under dialogue.",
            "operations": OPERATIONS,
            "otio_snapshot_path": None if stage != "COMMITTED" else "otio_deltas/delta_004.otio",
        },
        severity="MUTATION",
    )


TOKEN = "vtok_8f3a91c2" + "0" * 24


def steps() -> list[Step]:
    """The run, in emission order."""
    out: list[Step] = [
        spawn(
            0,
            ORCH,
            ROOT,
            "Documentary teaser rough cut",
            "claude-code-opus-5-5",
            "CLOUD_API",
            [],
            "Cut a 90-second teaser from the interviews, B-roll on V2, duck the music bed",
            parent=None,
        ),
        Step(
            40,
            ORCH,
            "PLANNING",
            {
                "task_id": ROOT,
                "planning_phase": "INTENT_DECOMPOSITION",
                "thought_summary": "Transcribe both interview takes, tag the drone footage, then search for "
                "kinetic B-roll to cover the turn.",
                "thinking_budget_tokens": 4096,
                "active_timeline_name": "Doc Teaser v1",
                "active_timeline_fps": FPS,
            },
            parent=None,
        ),
        thought(60, ORCH, ROOT, "The strongest bite is at 00:01:12 ", 18),
        thought(75, ORCH, ROOT, "in take A; take B has the cleaner turn. ", 34),
        spawn(
            120,
            WHISPER,
            ING,
            "Transcribe interviews",
            "mlx-community/whisper-large-v3-turbo",
            "METAL_MPS",
            [ROOT],
            "A001_Intv.mov, A001_Intv_B.mov",
        ),
        handoff(130, ORCH, WHISPER, ROOT, ING, "PROMPT_TOKENS", 512, "Transcribe both takes", tokens=96),
        spawn(
            140, VLM, VIS, "Tag drone shots", "qwen3-vl:8b-instruct", "METAL_MPS", [ROOT], "B004_Drone.mov"
        ),
        handoff(150, ORCH, VLM, ROOT, VIS, "PROMPT_TOKENS", 384, "Tag the drone footage", tokens=64),
        spawn(160, AUDIO, AUD, "Sync and loudness", "ffmpeg ebur128", "CPU_NEON", [ROOT], "Theme_Bed.wav"),
        handoff(170, ORCH, AUDIO, ROOT, AUD, "PROMPT_TOKENS", 256, "Sync takes, measure the bed", tokens=40),
        tool(
            200,
            WHISPER,
            ING,
            "transcribe_and_align",
            {"media_path": INTERVIEW_A, "model_tier": "large-v3-turbo"},
            True,
            [INTERVIEW_A],
        ),
        Step(
            220,
            VLM,
            "WAITING_UPSTREAM",
            {
                "task_id": VIS,
                "wait_reason": "GPU_METAL_LOCK",
                "blocking_task_ids": [ING],
                "lock_holder_agent_id": WHISPER[0],
                "queue_depth": 1,
                "estimated_wait_ms": 1800,
            },
        ),
        tool(
            240,
            AUDIO,
            AUD,
            "detect_media_boundaries",
            {"media_path": MUSIC, "detectors": ["loudness"]},
            False,
            [MUSIC],
        ),
    ]
    # Whisper's word callbacks: 40 within a few frames (coalesced into few envelopes).
    out += [progress(300 + i * 2, WHISPER, ING, "transcribe", i + 1, 40, "A001_Intv.mov") for i in range(40)]
    out += [
        Step(
            420,
            AUDIO,
            "FAILED",
            {
                "task_id": AUD,
                "error_code": "LOCAL_MODEL_UNAVAILABLE",
                "error_message": "The GPU lock was still held after 30 s",
                "recoverable": True,
                "retry_attempt": 0,
                "max_retries": 2,
                "remediation_hint": "Retry once the transcription releases the lock",
                "stack_excerpt": None,
            },
            severity="WARN",
        ),
        completed(
            900,
            WHISPER,
            ING,
            780.0,
            "2 takes, 142 words",
            [
                {
                    "artifact_type": "TRANSCRIPT_SUMMARY",
                    "media_path": INTERVIEW_A,
                    "segment_count": 12,
                    "word_count": 142,
                    "speakers": ["SPEAKER_00"],
                    "cache_path": INTERVIEW_A + ".ivt-cache.json",
                },
            ],
            memory=2140.0,
        ),
        handoff(920, WHISPER, VECTOR, ING, VEC, "TRANSCRIPT_SLICES", 18_432, "12 segments", tokens=142),
        tool(
            960,
            VLM,
            VIS,
            "analyze_shot_visuals",
            {"media_path": DRONE, "sample_strategy": "scene_cuts"},
            True,
            [DRONE],
        ),
    ]
    out += [progress(1000 + i * 30, VLM, VIS, "vision", i + 1, 28, f"shot_{i + 1:03d}") for i in range(28)]
    out += [
        spawn(
            1050,
            AUDIO,
            AUD,
            "Sync and loudness (retry)",
            "ffmpeg ebur128",
            "CPU_NEON",
            [ROOT],
            "Theme_Bed.wav",
        ),
        completed(
            1300,
            AUDIO,
            AUD,
            260.0,
            "2 pairs synced, bed at -14 LUFS",
            [
                {
                    "artifact_type": "AUDIO_SYNC_MAP",
                    "matched_pairs": 2,
                    "max_drift_ms": 4.2,
                    "loudness_lufs": -14.0,
                },
            ],
        ),
        completed(
            1900,
            VLM,
            VIS,
            940.0,
            "28 shots",
            [
                {
                    "artifact_type": "VLM_SHOT_TAGS",
                    "media_path": DRONE,
                    "shot_count": 28,
                    "dominant_scales": ["EWS", "WS"],
                    "contact_strip_frame_ids": ["strip_042"],
                },
            ],
            memory=6020.0,
        ),
        handoff(1920, VLM, VECTOR, VIS, VEC, "VLM_TAGS", 9_216, "28 shot tags"),
        spawn(
            1950,
            VECTOR,
            VEC,
            "Find kinetic B-roll",
            "BAAI/bge-m3",
            "METAL_MPS",
            [ING, VIS],
            "kinetic aerial reveal, golden hour",
        ),
        tool(
            1970,
            VECTOR,
            VEC,
            "semantic_asset_search",
            {"query": "kinetic aerial reveal, golden hour", "modality": "hybrid", "top_k": 8},
            True,
            [],
        ),
        completed(
            2050,
            VECTOR,
            VEC,
            64.0,
            "8 hits",
            [
                {
                    "artifact_type": "CLIP_RANGES",
                    "count": 1,
                    "clips": [
                        {
                            "hit_id": "hit_001",
                            "filename": "B004_Drone.mov",
                            "media_path": DRONE,
                            "source_range": tr(5755, 302),
                            "start_tc": "00:04:00:00",
                            "end_tc": "00:04:12:14",
                            "score": 91.4,
                            "modality": "hybrid",
                            "thumbnail_frame_id": "strip_042",
                        },
                    ],
                },
            ],
        ),
        handoff(2070, VECTOR, CUTTER, VEC, CUT, "CLIP_MANIFEST", 4_096, "8 B-roll candidates", clips=8),
        handoff(2080, AUDIO, CUTTER, AUD, CUT, "CLIP_MANIFEST", 1_024, "Sync map and loudness"),
        spawn(
            2100,
            CUTTER,
            CUT,
            "Assemble the teaser",
            "claude-code-opus-5-5",
            "CLOUD_API",
            [VEC, AUD],
            "4 ops on Doc Teaser v1",
        ),
        Step(
            2120,
            CUTTER,
            "PLANNING",
            {
                "task_id": CUT,
                "planning_phase": "ROUGH_CUT_STRUCTURING",
                "thought_summary": "Trim take A to the bite, drone on V2 over the setup, take B for the turn.",
                "thinking_budget_tokens": 2048,
                "active_timeline_name": "Doc Teaser v1",
                "active_timeline_fps": FPS,
            },
        ),
        thought(2140, CUTTER, CUT, "Matching interview bite at 00:01:12 ", 12),
        thought(2150, CUTTER, CUT, "with kinetic B-roll shot_042...", 22),
        tool(
            2200,
            CUTTER,
            CUT,
            "propose_otio_delta",
            {"delta": {"delta_id": "delta_004", "operations": 4}},
            False,
            [],
        ),
        mutation(2210, "PROPOSED", None),
        completed(
            2400,
            CUTTER,
            CUT,
            300.0,
            "delta_004 valid, 0 diagnostics",
            [
                {
                    "artifact_type": "VALIDATION_REPORT",
                    "delta_id": "delta_004",
                    "valid": True,
                    "validation_token": TOKEN,
                    "validator_mode": "deterministic",
                    "diagnostic_count": 0,
                },
            ],
            tokens=(1420, 390, 512),
            cost=0.0,
        ),
        mutation(2390, "VALIDATED", TOKEN),
        handoff(2420, CUTTER, NLE, CUT, FIN, "OTIO_DELTA", 6_144, "delta_004 + vtok"),
        spawn(2440, NLE, FIN, "Commit to Resolve", "resolve-bridge", "NLE_IPC", [CUT], "delta_004"),
        tool(
            2460,
            NLE,
            FIN,
            "commit_otio_delta",
            {"validation_token": TOKEN, "commit_summary": "Teaser rough cut, pass 1"},
            False,
            [],
        ),
        handoff(2470, NLE, NLE, FIN, FIN, "NLE_COMMIT_BATCH", 2_048, "5 bridge calls"),
        mutation(2800, "COMMITTED", TOKEN, NLE, FIN),
        completed(2820, NLE, FIN, 380.0, "Committed delta_004 (backup kept)", []),
        thought(2850, ORCH, ROOT, "The teaser opens on take A and turns on take B.", 58, "ASSISTANT_TEXT"),
        completed(
            2900,
            ORCH,
            ROOT,
            2900.0,
            "Rough cut committed",
            [],
            tokens=(9840, 1210, 6400),
            cost=0.0,
            parent=None,
        ),
    ]
    return sorted(out, key=lambda s: s.at_ms)


def heartbeat(at: int) -> Step:
    return Step(
        at,
        ("system.telemetry", "MASTER_ORCHESTRATOR"),
        "RESOURCE_HEARTBEAT",
        {
            "kind": "RESOURCE_HEARTBEAT",
            "host_cpu_percent": 1.1,
            "sidecar_rss_mb": 412.0,
            "unified_memory_used_gb": 9.4,
            "unified_memory_total_gb": 64.0,
            "gpu_lock_holder": None,
            "active_workers": 3,
            "dropped_debug_events": 0,
            "nle_connected": {"premiere": False, "resolve": True},
        },
        parent=None,
        severity="DEBUG",
    )


def waveform_peaks(buckets: int = 256) -> bytes:
    """The music bed's peaks for VCTB 0x01: `buckets` (min, max) pairs of little-endian int16 (as a
    browser's Int16Array reads them; the frame's header is big-endian), ducked by 12 dB in the middle."""
    import math
    import struct

    values = []
    for i in range(buckets):
        level = 0.55 + 0.35 * math.sin(i / 7.0) * math.sin(i / 29.0)
        if buckets * 0.25 <= i < buckets * 0.75:
            level *= 0.25
        peak = int(max(0.02, min(1.0, abs(level))) * 32767)
        values += [-peak, peak]
    return struct.pack(f"<{len(values)}h", *values)


def all_steps() -> list[Step]:
    """The run with a heartbeat each second."""
    return sorted(steps() + [heartbeat(ms) for ms in range(1000, 3001, 1000)], key=lambda s: s.at_ms)


def ticks(run: list[Step], window_ms: int = 50) -> Iterator[tuple[int, list[Step]]]:
    """The steps grouped into the bus's 50 ms flush windows."""
    for tick, group in itertools.groupby(run, key=lambda s: s.at_ms // window_ms):
        yield tick * window_ms, list(group)


def emit(bus: TelemetryBus, trace_id: str, step: Step) -> None:
    bus.emit_nowait(
        trace_id=trace_id,
        agent_id=step.agent[0],
        subagent_type=step.agent[1],
        event_type=step.event_type,
        payload={"kind": step.event_type, **step.payload},
        parent_task_id=step.parent,
        severity=step.severity,
    )


def generate(trace_id: str = DEFAULT_TRACE_ID, epoch_ms: int = EPOCH_MS) -> list[Envelope]:
    """The whole run as envelopes, the same every time."""
    now = {"ms": 0}
    counter = itertools.count(1)
    ids = itertools.count(1)
    bus = TelemetryBus(
        clock=lambda: (epoch_ms + now["ms"]) / 1000.0,
        monotonic_clock=lambda: now["ms"] * 1_000_000 + next(counter),
        event_ids=lambda: f"evt_mock_{next(ids):06d}",
    )
    envelopes: list[Envelope] = []
    for _, group in ticks(all_steps()):
        for step in group:
            now["ms"] = step.at_ms
            emit(bus, trace_id, step)
        envelopes += bus.flush()
    return envelopes


def write_journal(out_dir: Path, trace_id: str = DEFAULT_TRACE_ID) -> Path:
    import json

    out_dir.mkdir(parents=True, exist_ok=True)
    path = out_dir / f"{trace_id}.jsonl"
    path.write_text("".join(json.dumps(e, ensure_ascii=False) + "\n" for e in generate(trace_id)), "utf-8")
    return path


async def play(bus: TelemetryBus, trace_id: str, speed: float = 1.0) -> None:
    """The run emitted into a running bus with its real spacing (divided by `speed`)."""
    began = time.monotonic()
    for at_ms, group in ticks(all_steps()):
        delay = at_ms / 1000.0 / max(speed, 0.01) - (time.monotonic() - began)
        if delay > 0:
            await asyncio.sleep(delay)
        for step in group:
            emit(bus, trace_id, step)


def write_realtime(out_dir: Path, trace_id: str, speed: float) -> Path:
    """The run journaled step by step, as a real run's sidecar would write it."""
    bus = TelemetryBus(out_dir)
    began = time.monotonic()
    for at_ms, group in ticks(all_steps()):
        delay = at_ms / 1000.0 / max(speed, 0.01) - (time.monotonic() - began)
        if delay > 0:
            time.sleep(delay)
        for step in group:
            emit(bus, trace_id, step)
        bus.flush()
    return out_dir / f"{trace_id}.jsonl"


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0] if __doc__ else None)
    parser.add_argument("--out", type=Path, required=True, help="the folder for <trace_id>.jsonl")
    parser.add_argument("--trace-id", default=DEFAULT_TRACE_ID)
    parser.add_argument("--realtime", action="store_true", help="write step by step with the run's timing")
    parser.add_argument("--speed", type=float, default=1.0, help="with --realtime, how much faster to run")
    options = parser.parse_args(argv)
    if options.realtime:
        path = write_realtime(options.out, options.trace_id, options.speed)
    else:
        path = write_journal(options.out, options.trace_id)
    print(path, file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
