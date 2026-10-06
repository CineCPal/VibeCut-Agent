"""tests/test_claude_schema.py — Gemini-shaped declarations and schemas converted for Claude."""

from vibecut_agent.agent.claude_schema import strict_schema, to_claude_tool, to_claude_tools, to_json_schema

TRIM = {
    "name": "trim_clip_end",
    "description": "Trim a clip's end.",
    "parameters": {
        "type": "OBJECT",
        "properties": {
            "clipId": {"type": "STRING", "description": "The clip."},
            "seconds": {"type": "NUMBER"},
            "tracks": {
                "type": "ARRAY",
                "items": {
                    "type": "OBJECT",
                    "properties": {"kind": {"type": "STRING", "enum": ["video", "audio"]}},
                },
            },
            "ripple": {"type": "BOOLEAN", "nullable": True},
        },
        "required": ["clipId"],
    },
}


def test_a_declaration_becomes_a_claude_tool_with_lowercase_json_schema():
    tool = to_claude_tool(TRIM)

    assert tool["name"] == "trim_clip_end"
    assert tool["description"] == "Trim a clip's end."
    schema = tool["input_schema"]
    assert schema["type"] == "object"
    assert schema["required"] == ["clipId"]
    assert schema["properties"]["clipId"] == {"type": "string", "description": "The clip."}
    assert schema["properties"]["seconds"] == {"type": "number"}
    items = schema["properties"]["tracks"]["items"]
    assert items["type"] == "object"
    assert items["properties"]["kind"] == {"type": "string", "enum": ["video", "audio"]}
    assert schema["properties"]["ripple"] == {"type": ["boolean", "null"]}
    assert "parameters" not in tool


def test_a_tool_without_parameters_gets_an_empty_object_schema():
    assert to_claude_tool({"name": "split_at_playhead", "description": "d"})["input_schema"] == {
        "type": "object",
        "properties": {},
    }
    assert to_claude_tool({"name": "x", "parameters": {}})["input_schema"] == {
        "type": "object",
        "properties": {},
    }


def test_to_claude_tools_skips_entries_without_a_name():
    assert [t["name"] for t in to_claude_tools([TRIM, {"description": "nameless"}, "junk"])] == [
        "trim_clip_end"
    ]


def test_the_conversion_does_not_change_its_input():
    before = repr(TRIM)
    to_claude_tool(TRIM)
    assert repr(TRIM) == before


def test_strict_schema_closes_every_object_and_requires_every_property():
    schema = strict_schema(TRIM["parameters"])

    assert schema["additionalProperties"] is False
    assert schema["required"] == ["clipId", "seconds", "tracks", "ripple"]
    items = schema["properties"]["tracks"]["items"]
    assert items["additionalProperties"] is False
    assert items["required"] == ["kind"]


def test_non_dict_values_pass_through():
    assert to_json_schema("STRING") == "STRING"
    assert to_json_schema({"type": "STRING", "enum": ["a"]}) == {"type": "string", "enum": ["a"]}
