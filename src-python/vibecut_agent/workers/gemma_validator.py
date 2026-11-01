"""The pre-flight check of an OTIO delta (ORCHESTRATOR_SPEC.md §3.4 D, `propose_otio_delta`; PLAN.md,
"Phase 21").

`validate` answers with a `vibecut.gemma.validator.v1` result in three steps:

1. The delta must match `otio_delta.json`; one that doesn't is refused with SchemaError (the supervisor
   sends that back to Claude as the tool's error).
2. orchestrator/otio_delta.py replays it on the timeline snapshot it was planned against, frame by frame,
   and lowers it to bridge calls (`translated_nle_batch`). Those checks and that translation are
   deterministic: every ERROR comes from them, and the calls are exactly what they say.
3. The local Gemma (`VIBECUT_GEMMA_MODEL`) then reads the delta, the timeline and those findings, and may
   add WARNINGs an editor would raise (a cut mid-word, a jump in continuity) under the same codes. Its
   notes can never make a delta valid or invalid, and a Gemma that isn't running only means no notes
   (`validator_model` then says "deterministic").

A valid delta gets a `validation_token`: an HMAC of the delta, its calls and the timeline hash under this
validator's key, which `commit_otio_delta` must present. `verify_token` checks one; a token from another
validator (another process), or for a changed delta or timeline, doesn't verify.

Gemma doesn't take the GPU lock: it is the chat turn's small model and must not wait behind an ingest."""

from __future__ import annotations

import hashlib
import hmac
import json
import secrets
from typing import Any

from vibecut_agent.broll import ffprobe_util
from vibecut_agent.config import OrchestratorConfig
from vibecut_agent.orchestrator.otio_delta import (
    Diagnostic,
    MediaDuration,
    NleCommand,
    compile_to_nle_commands,
    timeline_hash,
)
from vibecut_agent.orchestrator.schemas import (
    GEMMA_VALIDATION_ID,
    GEMMA_VALIDATION_SCHEMA,
    GEMMA_VALIDATOR_VERSION,
    OTIO_DELTA_ID,
    errors_against,
    validate,
)
from vibecut_agent.workers.base import (
    CircuitBreaker,
    CircuitOpen,
    LocalLlmClient,
    LocalLlmError,
    WorkerHealth,
)

DETERMINISTIC = "deterministic"
MAX_NOTES = 10
TOKEN_PREFIX = "vtok_"

_DIAGNOSTIC = GEMMA_VALIDATION_SCHEMA["properties"]["diagnostics"]["items"]
REVIEW_SCHEMA: dict[str, Any] = {
    "type": "object",
    "required": ["notes"],
    "additionalProperties": False,
    "properties": {
        "notes": {
            "type": "array",
            "maxItems": MAX_NOTES,
            "items": {
                "type": "object",
                "required": ["code", "op_id", "message", "remediation_hint"],
                "additionalProperties": False,
                "properties": {k: v for k, v in _DIAGNOSTIC["properties"].items() if k != "severity"},
            },
        }
    },
}

REVIEW_PROMPT = """You check a video editor's planned timeline change before it runs. The structural checks
have already run; their findings are below. Add only problems a picture editor would see that those checks
can't: a cut in the middle of a word or a breath, a jump in continuity, a transition on a hard sound edit,
a clip placed over the wrong speaker. Each note names the operation (op_id) and uses the closest code from
the allowed list. Don't repeat the findings below. Answer {"notes": []} when there is nothing to add.

The change (an OTIO delta):
%(delta)s

The timeline it was planned on:
%(timeline)s

Findings of the structural checks:
%(findings)s"""


def canonical(value: Any) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def summarise_timeline(snapshot: dict[str, Any]) -> dict[str, Any]:
    """The parts of a HostTimeline the reviewer needs, kept small."""
    return {
        "timeline": snapshot.get("timeline"),
        "fps": snapshot.get("fps"),
        "tracks": [
            {
                "track": f"{str(t.get('type', '?'))[:1].upper()}{t.get('index')}",
                "clips": [
                    {
                        k: c.get(k)
                        for k in ("id", "name", "start", "end", "sourceIn", "sourceOut", "linkedIds")
                        if k in c
                    }
                    for c in t.get("clips", [])
                ],
            }
            for t in snapshot.get("tracks", [])
            if t.get("type") in ("video", "audio")
        ],
    }


class GemmaValidator:
    name = "gemma"

    def __init__(
        self,
        config: OrchestratorConfig,
        client: LocalLlmClient | None = None,
        breaker: CircuitBreaker | None = None,
        key: bytes | None = None,
        media_duration: MediaDuration = ffprobe_util.probe_duration_seconds,
    ) -> None:
        self.config = config
        self.model = config.gemma_model
        self.client = client or LocalLlmClient(config.local_llm_base_url, timeout=30.0)
        self.breaker = breaker or CircuitBreaker("The local validator model")
        self._key = key or secrets.token_bytes(32)
        self.media_duration = media_duration

    def health(self) -> WorkerHealth:
        available, detail = self.client.has_model(self.model)
        if not available:
            detail += "; deltas are still checked, without the model's notes"
        return {
            "worker": self.name,
            "backend": "ollama",
            "model": self.model,
            "available": available,
            "detail": detail,
        }

    def sign(self, delta: dict[str, Any], batch: list[NleCommand], snapshot_hash: str) -> str:
        message = "\n".join([canonical(delta), canonical(batch), snapshot_hash]).encode("utf-8")
        return TOKEN_PREFIX + hmac.new(self._key, message, hashlib.sha256).hexdigest()[:32]

    def verify_token(
        self, token: str, delta: dict[str, Any], batch: list[NleCommand], snapshot_hash: str
    ) -> bool:
        return hmac.compare_digest(token, self.sign(delta, batch, snapshot_hash))

    def validate(
        self, delta: dict[str, Any], snapshot: dict[str, Any], *, review: bool = True
    ) -> dict[str, Any]:
        """The `vibecut.gemma.validator.v1` result for a delta planned on `snapshot` (a HostTimeline).
        Raises SchemaError for a delta that doesn't match its schema."""
        validate(delta, OTIO_DELTA_ID)
        batch, diagnostics = compile_to_nle_commands(delta, snapshot, self.media_duration)
        snapshot_hash = timeline_hash(snapshot)
        expected = delta.get("expected_timeline_hash")
        if expected and expected != snapshot_hash:
            diagnostics.insert(
                0,
                {
                    "severity": "ERROR",
                    "code": "STALE_TIMELINE_HASH",
                    "op_id": None,
                    "message": f"{delta['target_timeline']} changed since this delta was planned",
                    "remediation_hint": "Read the timeline again and plan the delta on what it is now",
                },
            )
        validator_model = DETERMINISTIC
        if review:
            notes = self._review(delta, snapshot, diagnostics)
            if notes is not None:
                diagnostics += notes
                validator_model = self.model
        valid = not any(d["severity"] == "ERROR" for d in diagnostics)
        result = {
            "schema_version": GEMMA_VALIDATOR_VERSION,
            "delta_id": delta["delta_id"],
            "valid": valid,
            "validation_token": self.sign(delta, batch, snapshot_hash) if valid else None,
            "validator_model": validator_model,
            "diagnostics": diagnostics,
            "translated_nle_batch": batch if valid else [],
        }
        validate(result, GEMMA_VALIDATION_ID)
        return result

    def _review(
        self, delta: dict[str, Any], snapshot: dict[str, Any], diagnostics: list[Diagnostic]
    ) -> list[Diagnostic] | None:
        """Gemma's notes as WARNINGs, or None when it couldn't give any (not running, failing, or off-format)."""
        prompt = REVIEW_PROMPT % {
            "delta": canonical(delta),
            "timeline": canonical(summarise_timeline(snapshot)),
            "findings": canonical(diagnostics) if diagnostics else "none",
        }
        try:
            with self.breaker.guard():
                answer = self.client.chat_json(self.model, prompt, REVIEW_SCHEMA)
        except (LocalLlmError, CircuitOpen):
            return None
        if errors_against(answer, REVIEW_SCHEMA):
            return None
        op_ids = {op["op_id"] for op in delta["operations"]}
        notes: list[Diagnostic] = []
        for note in answer["notes"][:MAX_NOTES]:
            op_id = note["op_id"] if note["op_id"] in op_ids else None
            notes.append(
                {
                    "severity": "WARNING",
                    "code": note["code"],
                    "op_id": op_id,
                    "message": note["message"],
                    "remediation_hint": note["remediation_hint"],
                }
            )
        return notes
