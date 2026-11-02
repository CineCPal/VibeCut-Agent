"""The pre-flight check of an OTIO delta (ORCHESTRATOR_SPEC.md §3.4 D, `propose_otio_delta`; PLAN.md,
"Phase 21").

`validate` answers with a `vibecut.gemma.validator.v1` result in three steps:

1. The delta must match `otio_delta.json`; one that doesn't is refused with SchemaError (the supervisor
   sends that back to Claude as the tool's error).
2. orchestrator/otio_delta.py replays it on the timeline snapshot it was planned against, frame by frame,
   and lowers it to bridge calls (`translated_nle_batch`). Those checks and that translation are
   deterministic: every ERROR comes from them, and the calls are exactly what they say.
3. Only with `VIBECUT_VALIDATOR_MODE=llm` (model migration v2; the default is "deterministic", which
   stops at step 2 with no model call): the local Gemma (`VIBECUT_GEMMA_MODEL`, or the first of its
   MODEL_ALIASES the server has) then reads the delta, the timeline and those findings, and may add
   WARNINGs an editor would raise (a cut mid-word, a jump in continuity) under the same codes. Its notes
   can never make a delta valid or invalid, and a Gemma that isn't running only means no notes
   (`validator_model` then says "deterministic"). Seen live (Phase 21): its notes cost 1-30 s a proposal
   and were mostly false alarms, which is why it is opt-in.

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
    MediaChannels,
    MediaDuration,
    NleCommand,
    compile_to_nle_commands,
    probe_channels,
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

# The operations each code can be about. Seen live (Phase 21, Gemma 3 4B): nearly all of its notes were about
# things the delta doesn't do, under codes that don't fit the operation; those are dropped (`_review`). Seen
# live again (the follow-up's checks): a correct 89-frame placement drew RATE_MISMATCH and
# TRACK_OVERLAP_COLLISION, which fit a placement. The structural checks settle those codes exactly, so
# Gemma's notes keep only the two where its judgment adds something: a cut point (SOURCE_OUT_OF_BOUNDS on a
# place, trim or split) and a transition (INVALID_TRANSITION_HANDLE).
_SETTLED: set[str] = set()
CODE_OPS: dict[str, set[str]] = {
    "SOURCE_OUT_OF_BOUNDS": {"INSERT_CLIP", "OVERWRITE_CLIP", "TRIM_CLIP", "SPLIT_CLIP"},
    "INVALID_TRANSITION_HANDLE": {"APPLY_TRANSITION"},
    "NEGATIVE_OR_ZERO_DURATION": _SETTLED,
    "TRACK_OVERLAP_COLLISION": _SETTLED,
    "MISSING_MEDIA_FILE": _SETTLED,
    "UNKNOWN_CLIP_ID": _SETTLED,
    "RATE_MISMATCH": _SETTLED,
    "STALE_TIMELINE_HASH": _SETTLED,
}

REVIEW_PROMPT = """You check a video editor's planned timeline change before it runs. The structural checks
have already run; their findings are below. Add only problems a picture editor would see that those checks
can't, in the operations listed in the change: a cut in the middle of a word or a breath, a jump in
continuity, a transition on a hard sound edit, a clip placed over the wrong speaker. Don't note anything the
change doesn't do, and nothing about lengths, rates, overlaps, ids or files: those are checked exactly.
Each note names the operation (op_id) it is about and uses one of these codes, for those op_types:
%(codes)s
Don't repeat the findings below. Answer {"notes": []} when there is nothing to add; most changes need none.

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
        media_channels: MediaChannels = probe_channels,
        validator_mode: str | None = None,
    ) -> None:
        self.config = config
        self.validator_mode = validator_mode or config.validator_mode
        self.model = config.gemma_model
        self.client = client or LocalLlmClient(config.local_llm_base_url, timeout=30.0)
        self.breaker = breaker or CircuitBreaker("The local validator model")
        self._key = key or secrets.token_bytes(32)
        self.media_duration = media_duration
        self.media_channels = media_channels

    def health(self) -> WorkerHealth:
        if self.validator_mode != "llm":
            return {
                "worker": self.name,
                "backend": "deterministic",
                "model": DETERMINISTIC,
                "available": True,
                "detail": "deltas are checked by otio_delta alone (VIBECUT_VALIDATOR_MODE=llm adds Gemma's notes)",
            }
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
        batch, diagnostics = compile_to_nle_commands(
            delta, snapshot, self.media_duration, self.media_channels
        )
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
        if review and self.validator_mode == "llm":
            notes_model = self.review_model()
            notes = self._review(delta, snapshot, diagnostics, notes_model)
            if notes is not None:
                diagnostics += notes
                validator_model = notes_model
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

    def review_model(self) -> str:
        """The model `_review` asks: the configured Gemma, or the first of its aliases the server has."""
        return self.client.resolve_available_model(self.model)

    def _review(
        self, delta: dict[str, Any], snapshot: dict[str, Any], diagnostics: list[Diagnostic], model: str
    ) -> list[Diagnostic] | None:
        """Gemma's notes as WARNINGs, or None when it couldn't give any (not running, failing, or off-format)."""
        prompt = REVIEW_PROMPT % {
            "codes": "\n".join(
                f"- {code}: {', '.join(sorted(ops))}" for code, ops in CODE_OPS.items() if ops
            ),
            "delta": canonical(delta),
            "timeline": canonical(summarise_timeline(snapshot)),
            "findings": canonical(diagnostics) if diagnostics else "none",
        }
        try:
            with self.breaker.guard():
                answer = self.client.chat_json(model, prompt, REVIEW_SCHEMA)
        except (LocalLlmError, CircuitOpen):
            return None
        if errors_against(answer, REVIEW_SCHEMA):
            return None
        op_types = {op["op_id"]: op["op_type"] for op in delta["operations"]}
        found = {(d["code"], d["op_id"]) for d in diagnostics}
        notes: list[Diagnostic] = []
        for note in answer["notes"][:MAX_NOTES]:
            fits = CODE_OPS.get(note["code"], set())
            op_id = note["op_id"]
            # About an operation the delta doesn't have, under a code that doesn't fit its operation, or
            # repeating a structural finding: dropped. A note about no one operation must fit one of them.
            if op_id is not None and op_types.get(op_id) not in fits:
                continue
            if op_id is None and not fits & set(op_types.values()):
                continue
            if (note["code"], op_id) in found:
                continue
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
