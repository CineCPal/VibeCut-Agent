"""The Premiere project's sequences and selection (PLAN.md, "Phase 6a"), ported from VibeCut's
host-premiere/premiere_project.py (its "Phase 8c"). Importing files is media.py's (Phase 5).

What Premiere 26.5.2 does (checked live, PLAN.md "8c.0 probe"):
- QE's `newSequence(name, preset)` makes an empty sequence from a .sqpreset with no dialog, and opens
  it; `clone()` copies one; setting `name` renames. Premiere accepts names that are taken, so names
  are made unique here (VibeCut finds sequences by name).
- `trackItem.setSelected` selects clips in a sequence; `projectItem.select()` selects in the Project
  panel, replacing the selection.
- `importFiles` imports into a chosen bin. A single project item can't be removed from a script, so
  an import is logged (field "imported") but its Revert says to remove the clip by hand.
"""

from __future__ import annotations

import glob
import os
from typing import Any

from vibecut_agent.nle.premiere import HostError, frame_rate
from vibecut_agent.nle.premiere_support import unique_name

MAX_NAME = 200
PRESET_GLOB = "/Applications/Adobe Premiere Pro */Adobe Premiere Pro *.app/Contents/Settings/SequencePresets/HD 1080p/HD 1080p {fps} fps.sqpreset"
PRESET_RATES = ("23.976", "25", "29.97", "50", "59.94")


def _names(host: Any) -> set[str]:
    return set(host.status({}).get("timelines") or [])


def _new_name(value: Any, fallback: str) -> str:
    name = (value if isinstance(value, str) and value.strip() else fallback).strip()
    if not name or len(name) > MAX_NAME or "\n" in name:
        raise HostError("name must be one short line")
    return name


def preset_for(fps: float) -> str:
    """Premiere's own HD 1080p preset nearest `fps` (the newest Premiere's, when several are installed)."""
    rate = min(PRESET_RATES, key=lambda r: abs(float(r) - fps))
    found = sorted(glob.glob(os.environ.get("VIBECUT_PREMIERE_PRESETS") or PRESET_GLOB.format(fps=rate)))
    if not found:
        raise HostError(f"Premiere's HD 1080p {rate} fps sequence preset isn't installed")
    return found[-1]


def _frame_rate_for_new(host: Any, connected: Any, status: dict[str, Any]) -> float:
    """The frame rate a new sequence copies: the connected sequence's, else the one open in Premiere,
    else any in the project, else 25. The connected one may have been deleted or renamed since the
    agent connected; an empty sequence doesn't need it, so that never stops one being made."""
    candidates = [connected, status.get("currentTimeline"), *(status.get("timelines") or [])]
    tried: set[str] = set()
    for name in candidates:
        if not isinstance(name, str) or not name or name in tried:
            continue
        tried.add(name)
        try:
            info = host._send("sequence_info", {"timeline": name})
            return frame_rate(int(info["timebase"]))
        except (HostError, KeyError, TypeError, ValueError):
            continue
    return 25.0


def create_timeline(host: Any, args: dict[str, Any]) -> dict[str, Any]:
    """{timeline (the connected one, for its frame rate), name?} -> an empty 1080p sequence at the
    nearest of Premiere's preset rates, opened."""
    status = host.status({})
    fps = _frame_rate_for_new(host, args.get("timeline"), status)
    name = unique_name(_new_name(args.get("name"), "Sequence (VibeCut)"), set(status.get("timelines") or []))
    made = host._send("create_sequence", {"name": name, "preset": preset_for(fps)})
    return {"timeline": made["name"], "fps": frame_rate(int(made["timebase"]))}


def duplicate_timeline(host: Any, args: dict[str, Any]) -> dict[str, Any]:
    """{timeline, name?} -> a copy, opened."""
    source = host._name(args)
    name = unique_name(_new_name(args.get("name"), f"{source} Copy"), _names(host))
    return {"timeline": host._send("duplicate_sequence", {"timeline": source, "name": name})["name"]}


def open_timeline(host: Any, args: dict[str, Any]) -> dict[str, Any]:
    """{timeline} -> opened in Premiere."""
    return {"timeline": host._send("open_sequence", {"timeline": host._name(args)})["name"]}


def rename_timeline(host: Any, args: dict[str, Any]) -> dict[str, Any]:
    """{timeline, name} -> renamed; a name already taken is refused."""
    old = host._name(args)
    name = _new_name(args.get("name"), "")
    if name == old:
        return {"timeline": old, "before": old}
    if name in _names(host):
        raise HostError(f"There's already a sequence called {name!r}")
    return {
        "timeline": host._send("rename_sequence", {"timeline": old, "name": name})["name"],
        "before": old,
    }


def select_items(host: Any, args: dict[str, Any]) -> dict[str, Any]:
    """{timeline, itemIds, additive?} -> the clips selected in the sequence."""
    ids = args.get("itemIds")
    if not isinstance(ids, list) or not all(isinstance(i, str) for i in ids):
        raise HostError("itemIds must list sequence clip ids")
    return host._send(
        "select_items",
        {
            "timeline": host._name(args),
            "ids": ids,
            "additive": args.get("additive") is True,
        },
    )


def select_pool_clips(host: Any, args: dict[str, Any]) -> dict[str, Any]:
    """{clipIds} -> selected in the Project panel, as far as Premiere keeps them selected."""
    ids = args.get("clipIds")
    if not isinstance(ids, list) or not ids or not all(isinstance(i, str) for i in ids):
        raise HostError("clipIds must list project clip ids")
    selected = host._send("select_project_items", {"ids": ids}).get("selected") or []
    return {
        "selected": [i for i in ids if i in selected],
        "notSelected": [i for i in ids if i not in selected],
    }
