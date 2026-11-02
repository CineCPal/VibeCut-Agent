"""The delta pre-flight (workers/gemma_validator.py): deterministic verdicts, Gemma's notes as warnings (only
with VIBECUT_VALIDATOR_MODE=llm, model migration v2), tokens."""

from __future__ import annotations

import pytest

from tests.orchestrator.timeline import delta, make_media, make_snapshot, op, tr
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


def validator(config, answers, key=b"k" * 32, mode="llm", models=()):
    """A validator whose Gemma (when asked) answers `answers`: in "llm" mode unless a test says otherwise,
    since most of these are about its notes."""
    client = Client(answers, models=models)
    return GemmaValidator(
        config, client=client, key=key, media_duration=lambda path: 60.0, validator_mode=mode
    )  # type: ignore[arg-type]


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
        "code": "SOURCE_OUT_OF_BOUNDS",
        "op_id": "op_001",
        "message": "Cuts mid-word",
        "remediation_hint": "Cut 3 frames later",
    }
    whole = {**note, "op_id": None}
    check = validator(config, [{"notes": [note, whole]}])
    result = check.validate(
        delta(op("op_001", "SPLIT_CLIP", clip_id="c1", timeline_range=tr(50, 1))), snapshot
    )
    assert result["valid"] is True
    assert [(d["severity"], d["op_id"]) for d in result["diagnostics"]] == [
        ("WARNING", "op_001"),
        ("WARNING", None),
    ]
    prompt = check.client.prompts[0][1]
    assert '"op_type":"SPLIT_CLIP"' in prompt and "Findings of the structural checks:\nnone" in prompt
    assert (
        "- INVALID_TRANSITION_HANDLE: APPLY_TRANSITION" in prompt
        and "RATE_MISMATCH" not in prompt.split("The change")[0]
    )


def test_notes_about_what_the_delta_doesnt_do_are_dropped(config, snapshot):
    # Seen live (Phase 21, Gemma 3 4B): nearly every WARNING was about something the delta doesn't do, under
    # a code that doesn't fit its operation; and (the follow-up's checks) RATE_MISMATCH and
    # TRACK_OVERLAP_COLLISION on a correct placement, which the structural checks settle exactly.
    def note(code, op_id):
        return {"code": code, "op_id": op_id, "message": "m", "remediation_hint": "h"}

    d = delta(
        op("op_001", "SPLIT_CLIP", clip_id="c1", timeline_range=tr(50, 1)),
        op("op_002", "DELETE_CLIP", clip_id="nope"),
    )
    notes = [
        note("SOURCE_OUT_OF_BOUNDS", "op_999"),  # no such operation
        note("INVALID_TRANSITION_HANDLE", "op_001"),  # a split has no transition
        note("INVALID_TRANSITION_HANDLE", None),  # nor does the delta
        note("SOURCE_OUT_OF_BOUNDS", "op_002"),  # a deletion has no cut point
        note("RATE_MISMATCH", "op_001"),  # settled by the structural checks
        note("TRACK_OVERLAP_COLLISION", "op_001"),
        note("UNKNOWN_CLIP_ID", "op_002"),
        note("STALE_TIMELINE_HASH", None),
        note("SOURCE_OUT_OF_BOUNDS", "op_001"),  # kept
    ]
    result = validator(config, [{"notes": notes}]).validate(d, snapshot)
    assert [(x["severity"], x["code"], x["op_id"]) for x in result["diagnostics"]] == [
        ("ERROR", "UNKNOWN_CLIP_ID", "op_002"),
        ("WARNING", "SOURCE_OUT_OF_BOUNDS", "op_001"),
    ]


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


def test_by_default_no_model_is_asked(config, snapshot):
    """Model migration v2: otio_delta's checks alone, with no model call, unless VIBECUT_VALIDATOR_MODE=llm."""
    assert config.validator_mode == "deterministic"
    check = GemmaValidator(
        config, client=Client([{"notes": []}]), key=b"k" * 32, media_duration=lambda path: 60.0
    )  # type: ignore[arg-type]
    result = check.validate(delta(op("op_001", "DELETE_CLIP", clip_id="c2")), snapshot)
    assert result["valid"] is True and result["validator_model"] == DETERMINISTIC
    assert check.client.prompts == []
    health = check.health()
    assert (
        health["available"] is True
        and health["model"] == DETERMINISTIC
        and "VIBECUT_VALIDATOR_MODE=llm" in health["detail"]
    )


def test_llm_mode_comes_from_the_environment(monkeypatch, snapshot):
    monkeypatch.setenv("VIBECUT_VALIDATOR_MODE", "llm")
    check = GemmaValidator(
        OrchestratorConfig.from_env("orchestrated"),
        client=Client([{"notes": []}]),
        media_duration=lambda path: 60.0,
    )  # type: ignore[arg-type]
    check.validate(delta(op("op_001", "DELETE_CLIP", clip_id="c2")), snapshot)
    assert len(check.client.prompts) == 1


def test_an_older_gemma_tag_reviews_when_the_configured_one_isnt_pulled(config, snapshot):
    check = validator(config, [{"notes": []}], models=("gemma3:4b-it",))
    result = check.validate(delta(op("op_001", "DELETE_CLIP", clip_id="c2")), snapshot)
    assert check.client.prompts[0][0] == "gemma3:4b-it"
    assert result["validator_model"] == "gemma3:4b-it"


def test_health(config):
    check = GemmaValidator(config, client=Client([{}], models=(config.gemma_model,)), validator_mode="llm")  # type: ignore[arg-type]
    assert check.health()["available"] is True
    check = GemmaValidator(config, client=Client([{}]), validator_mode="llm")  # type: ignore[arg-type]
    health = check.health()
    assert health["available"] is False and "still checked" in health["detail"]
