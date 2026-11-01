"""The orchestrator's contracts (orchestrator/schemas.py): exactly the spec's, and checked with their $refs."""

import json
import re
from pathlib import Path

import pytest

from vibecut_agent.orchestrator import schemas
from vibecut_agent.orchestrator.schemas import SchemaError, errors_in, validate, validate_tool_input

SPEC = Path(__file__).resolve().parents[2] / "ORCHESTRATOR_SPEC.md"


def spec_blocks() -> list[dict]:
    text = SPEC.read_text(encoding="utf-8")
    section = text[
        text.index("## 3. Inter-Agent Data Contracts") : text.index("## 4. Dual-Mode Configuration")
    ]
    return [json.loads(block) for block in re.findall(r"```json\n(.*?)```", section, re.DOTALL)]


def test_schemas_are_the_specs():
    common, tools, delta, whisper, vlm, vector, gemma = spec_blocks()
    assert schemas.COMMON_TIME_SCHEMA == common
    assert schemas.ORCHESTRATOR_TOOLS == tools["orchestrator_tools"]
    assert schemas.OTIO_DELTA_SCHEMA == delta
    assert schemas.WHISPER_TRANSCRIPT_SCHEMA == whisper
    assert schemas.VLM_KEYFRAME_SCHEMA == vlm
    assert schemas.VECTOR_SEARCH_SCHEMA == vector
    assert schemas.GEMMA_VALIDATION_SCHEMA == gemma
    for schema_id, schema in schemas.SCHEMAS.items():
        assert schema["$id"] == schema_id
    assert [t["name"] for t in schemas.ORCHESTRATOR_TOOLS] == [
        "semantic_asset_search",
        "transcribe_and_align",
        "analyze_shot_visuals",
        "detect_media_boundaries",
        "propose_otio_delta",
        "commit_otio_delta",
    ]


def rt(value, rate=25.0):
    return {"OTIO_SCHEMA": "RationalTime.1", "value": value, "rate": rate}


def tr(start, duration, rate=25.0):
    return {"OTIO_SCHEMA": "TimeRange.1", "start_time": rt(start, rate), "duration": rt(duration, rate)}


DELTA = {
    "schema_version": "vibecut.otio.delta.v1",
    "delta_id": "delta_0001",
    "target_host": "premiere",
    "target_timeline": "Cut",
    "timeline_fps": 25.0,
    "narrative_rationale": "Open on the wide.",
    "operations": [
        {
            "op_id": "op_001",
            "op_type": "INSERT_CLIP",
            "track_Selector": {"kind": "Video", "index": 1},
            "media_reference": {
                "OTIO_SCHEMA": "ExternalReference.1",
                "target_url": "file:///m/a.mov",
                "source_name": "a",
            },
            "source_range": tr(0, 50),
            "timeline_range": tr(100, 50),
        }
    ],
}


def test_a_delta_and_its_refs():
    validate(DELTA, schemas.OTIO_DELTA_ID)
    bad = json.loads(json.dumps(DELTA))
    bad["operations"][0]["source_range"]["duration"]["rate"] = 48.0
    bad["operations"][0]["op_id"] = "op_1"
    errors = errors_in(bad, schemas.OTIO_DELTA_ID)
    assert any("48.0 is not one of" in e for e in errors)
    assert any("does not match" in e for e in errors)
    with pytest.raises(SchemaError, match="OtioDeltaPayload doesn't match its schema") as caught:
        validate(bad, schemas.OTIO_DELTA_ID)
    assert len(caught.value.errors) == 2


def test_tool_inputs():
    validate_tool_input("propose_otio_delta", {"delta": DELTA})
    validate_tool_input(
        "commit_otio_delta", {"validation_token": "vtok_" + "0" * 32, "commit_summary": "Opened wide"}
    )
    validate_tool_input(
        "semantic_asset_search",
        {"query": "laughing", "modality": "hybrid", "filters": {"shot_scales": ["CU"]}},
    )
    with pytest.raises(SchemaError, match="commit_otio_delta's input"):
        validate_tool_input("commit_otio_delta", {"validation_token": "vtok_xyz", "commit_summary": "x"})
    with pytest.raises(SchemaError):
        validate_tool_input("semantic_asset_search", {"query": "a", "modality": "audio"})
    with pytest.raises(KeyError):
        validate_tool_input("delete_everything", {})
    with pytest.raises(KeyError):
        errors_in({}, "https://vibecut.local/schemas/nope.json")
