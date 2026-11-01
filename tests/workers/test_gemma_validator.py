"""The delta pre-flight (workers/gemma_validator.py): deterministic verdicts, Gemma's notes as warnings, tokens."""

from __future__ import annotations

import pytest

from tests.orchestrator.timeline import delta, make_media, make_snapshot, op
from tests.workers.fakes import Client
from vibecut_agent.config import OrchestratorConfig
from vibecut_agent.orchestrator.otio_delta import timeline_hash
from vibecut_agent.orchestrator.schemas import SchemaError
from vibecut_agent.workers.base import LocalLlmError
from vibecut_agent.workers.gemma_validator import DETERMINISTIC, GemmaValidator


@pytest.fixture
def snapshot(tmp_path):
    return make_snapshot(make_media(tmp_path))


@pytest.fixture
def config(tmp_path):
    return OrchestratorConfig.from_env("orchestrated")


def validator(config, answers, key=b"k" * 32):
    return GemmaValidator(config, client=Client(answers), key=key, media_duration=lambda path: 60.0)  # type: ignore[arg-type]


def test_a_valid_delta_gets_a_token_and_its_calls(config, snapshot):
    d = delta(op("op_001", "DELETE_CLIP", clip_id="c2"))
    d["expected_timeline_hash"] = timeline_hash(snapshot)
    check = validator(config, [{"notes": []}])
    result = check.validate(d, snapshot)
    assert result["valid"] is True
    assert result["validator_model"] == config.gemma_model
    assert result["validation_token"].startswith("vtok_") and len(result["validation_token"]) == 37
    assert [c["command"] for c in result["translated_nle_batch"]] == ["backup_timeline", "delete_clips"]
    assert check.verify_token(
        result["validation_token"], d, result["translated_nle_batch"], timeline_hash(snapshot)
    )
    changed = delta(op("op_001", "DELETE_CLIP", clip_id="c1"))
    assert not check.verify_token(
        result["validation_token"], changed, result["translated_nle_batch"], timeline_hash(snapshot)
    )
    assert not validator(config, [{"notes": []}], key=b"other" * 7).verify_token(
        result["validation_token"], d, result["translated_nle_batch"], timeline_hash(snapshot)
    )


def test_errors_mean_no_token_and_no_calls(config, snapshot):
    result = validator(config, [{"notes": []}]).validate(
        delta(op("op_001", "DELETE_CLIP", clip_id="zz")), snapshot
    )
    assert result["valid"] is False
    assert result["validation_token"] is None
    assert result["translated_nle_batch"] == []
    assert [d["code"] for d in result["diagnostics"]] == ["UNKNOWN_CLIP_ID"]


def test_a_stale_timeline(config, snapshot):
    d = delta(op("op_001", "DELETE_CLIP", clip_id="c2"))
    d["expected_timeline_hash"] = "0" * 64
    result = validator(config, [{"notes": []}]).validate(d, snapshot)
    assert result["valid"] is False
    assert result["diagnostics"][0]["code"] == "STALE_TIMELINE_HASH"


def test_gemma_can_only_warn(config, snapshot):
    note = {
        "code": "TRACK_OVERLAP_COLLISION",
        "op_id": "op_001",
        "message": "Cuts mid-word",
        "remediation_hint": "Cut 3 frames later",
    }
    stray = {**note, "op_id": "op_999"}
    check = validator(config, [{"notes": [note, stray]}])
    result = check.validate(delta(op("op_001", "DELETE_CLIP", clip_id="c2")), snapshot)
    assert result["valid"] is True
    assert [(d["severity"], d["op_id"]) for d in result["diagnostics"]] == [
        ("WARNING", "op_001"),
        ("WARNING", None),
    ]
    prompt = check.client.prompts[0][1]
    assert '"op_type":"DELETE_CLIP"' in prompt and "Findings of the structural checks:\nnone" in prompt


@pytest.mark.parametrize(
    "answer", [LocalLlmError("down"), {"notes": [{"code": "MADE_UP"}]}, {"verdict": "fine"}]
)
def test_without_a_usable_gemma_the_checks_still_stand(config, snapshot, answer):
    result = validator(config, [answer]).validate(delta(op("op_001", "DELETE_CLIP", clip_id="c2")), snapshot)
    assert result["valid"] is True
    assert result["validator_model"] == DETERMINISTIC
    assert result["diagnostics"] == []


def test_review_can_be_skipped(config, snapshot):
    check = validator(config, [{"notes": []}])
    result = check.validate(delta(op("op_001", "DELETE_CLIP", clip_id="c2")), snapshot, review=False)
    assert result["validator_model"] == DETERMINISTIC
    assert check.client.prompts == []


def test_a_malformed_delta_is_refused(config, snapshot):
    bad = delta(op("op_1", "DELETE_CLIP", clip_id="c2"))
    with pytest.raises(SchemaError, match="OtioDeltaPayload"):
        validator(config, [{"notes": []}]).validate(bad, snapshot)


def test_health(config):
    check = GemmaValidator(config, client=Client([{}], models=(config.gemma_model,)))  # type: ignore[arg-type]
    assert check.health()["available"] is True
    check = GemmaValidator(config, client=Client([{}]))  # type: ignore[arg-type]
    health = check.health()
    assert health["available"] is False and "still checked" in health["detail"]
