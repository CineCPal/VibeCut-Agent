"""Names and colours for clips on a timeline (PLAN.md, "Phase 16b"): the request check both editors'
`label_clips` share. Standard library only, as Resolve's own Python runs it."""

from __future__ import annotations

from typing import Any

from vibecut_agent.nle.errors import HostError

MAX_LABELS = 200
MAX_LABEL_NAME = 255


def label_wants(args: dict[str, Any], colors: tuple[str, ...], clear: str | None) -> list[dict[str, Any]]:
    """Checks `labels` ([{itemId, name?, color?}], each naming at least one) -> the same, with each
    colour spelled as the editor spells it (`clear` is the word that clears one, if the editor can)."""
    labels = args.get("labels")
    if not isinstance(labels, list) or not labels or len(labels) > MAX_LABELS:
        raise HostError(f"labels must list 1 to {MAX_LABELS} {{itemId, name, color}}")
    wants: list[dict[str, Any]] = []
    for i, raw in enumerate(labels):
        if not isinstance(raw, dict) or not isinstance(raw.get("itemId"), str) or not raw["itemId"]:
            raise HostError(f"labels[{i}] must be {{itemId, name, color}}")
        want: dict[str, Any] = {"itemId": raw["itemId"]}
        name = raw.get("name")
        if name is not None:
            if not isinstance(name, str) or not name.strip() or len(name) > MAX_LABEL_NAME or "\n" in name:
                raise HostError(f"labels[{i}].name must be one line of 1 to {MAX_LABEL_NAME} characters")
            want["name"] = name.strip()
        color = raw.get("color")
        if color is not None:
            names = (*colors, clear) if clear else colors
            match = next(
                (c for c in names if isinstance(color, str) and c.lower() == color.strip().lower()), None
            )
            if match is None:
                raise HostError(f"labels[{i}].color must be one of {', '.join(names)}")
            want["color"] = "" if match == clear else match
        if len(want) == 1:
            raise HostError(f"labels[{i}] must give a name, a color or both")
        wants.append(want)
    if len({w["itemId"] for w in wants}) != len(wants):
        raise HostError("Each clip may appear once in labels")
    return wants
