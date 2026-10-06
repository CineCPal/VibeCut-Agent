"""claude_schema.py

Turns the Gemini-shaped schemas the rest of VibeCut already writes into the JSON Schema Claude reads.

The frontend declares every chat tool once, in Gemini's OpenAPI subset (uppercase `"OBJECT"`,
`"STRING"`, … — see src/types/chat.ts), and the critic/looker response schemas are written the same
way. Converting here, at the one place a Claude request is built, keeps those declarations single-
sourced instead of maintaining a second copy of ~70 tools per target.

- `to_claude_tool`: `{name, description, parameters}` -> `{name, description, input_schema}`.
- `to_json_schema`: the type conversion itself — lowercases every `type`, turns `nullable: true` into a
  `[type, "null"]` union, and recurses through `properties`/`items`.
- `strict_schema`: the same, plus what structured outputs (`output_config.format`) require of every
  object: `additionalProperties: false` and every property listed in `required`.
"""

from __future__ import annotations

from typing import Any

_EMPTY_OBJECT = {"type": "object", "properties": {}}


def to_json_schema(schema: Any, strict: bool = False) -> Any:
    """The Gemini-shaped `schema` as standard JSON Schema. Anything that isn't a dict is returned as is."""
    if not isinstance(schema, dict):
        return schema
    out: dict[str, Any] = {}
    for key, value in schema.items():
        if key == "nullable":
            continue
        if key == "type" and isinstance(value, str):
            out["type"] = value.lower()
        elif key == "properties" and isinstance(value, dict):
            out["properties"] = {name: to_json_schema(prop, strict) for name, prop in value.items()}
        elif key == "items":
            out["items"] = to_json_schema(value, strict)
        else:
            out[key] = value
    if schema.get("nullable") is True and isinstance(out.get("type"), str):
        out["type"] = [out["type"], "null"]
    if strict and out.get("type") == "object":
        properties = out.setdefault("properties", {})
        out["required"] = list(properties)
        out["additionalProperties"] = False
    return out


def strict_schema(schema: dict[str, Any]) -> dict[str, Any]:
    """`to_json_schema` for structured outputs: every object closed and every property required."""
    strict: dict[str, Any] = to_json_schema(schema, strict=True)
    return strict


def to_claude_tool(declaration: dict[str, Any]) -> dict[str, Any]:
    """One Gemini function declaration as a Claude tool definition. A tool with no parameters still
    gets an empty object schema, which Claude requires."""
    parameters = declaration.get("parameters")
    input_schema = to_json_schema(parameters) if isinstance(parameters, dict) else dict(_EMPTY_OBJECT)
    if input_schema.get("type") != "object":
        input_schema = dict(_EMPTY_OBJECT)
    tool: dict[str, Any] = {"name": declaration.get("name"), "input_schema": input_schema}
    if declaration.get("description"):
        tool["description"] = declaration["description"]
    return tool


def to_claude_tools(declarations: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return [to_claude_tool(d) for d in declarations if isinstance(d, dict) and d.get("name")]
