"""resolve_effects.py -- fades and transitions on the connected Resolve timeline (PLAN.md, "Phase 6, 6e3").

Checked live in 21.1 (PLAN.md, "6e.0 probe"):
- `TimelineItem.GetFades`/`SetFades` take frames; a fade longer than the clip returns False and
  changes nothing. Picture and sound each have their own.
- `TimelineItem.AddTransition({type, category, position, alignment, duration})` puts a transition on
  an edge and returns it as an item of type "transition". "Cross Dissolve" and "Dip To Color
  Dissolve" (black unless changed) are "simple"; "Cross Fade +3 dB" is "audio". Resolve clamps a
  transition longer than the handles by itself, and adds one at a clip's end with nothing after it,
  so the cut and the length are checked here first.
- `Timeline.DeleteClips([transition])` removes only the transition. The clips keep their ids.
"""

from __future__ import annotations

import math
from typing import Any

from vibecut_agent.nle.resolve import HostError, _number, _to_frame
from vibecut_agent.nle.resolve import frame_rate as _frame_rate
from vibecut_agent.nle.resolve_edit import _chosen, _items, _seconds

# kind -> (Resolve's transition, its category) on each kind of track. No dip on sound.
TRANSITIONS = {
    "video": {"dissolve": ("Cross Dissolve", "simple"), "dipToBlack": ("Dip To Color Dissolve", "simple")},
    "audio": {"dissolve": ("Cross Fade +3 dB", "audio")},
}  # fmt: skip
DEFAULT_SECONDS = 1.0


def _label(kind: str, index: int) -> str:
    return f"{kind[0].upper()}{index}"


def _is_transition(item: Any) -> bool:
    return item.GetType() == "transition"


def _fades(item: Any) -> dict[str, int]:
    fades = item.GetFades() or {}
    return {k: round(float(fades.get(k) or 0)) for k in ("FadeIn", "FadeOut")}


def set_clip_fades(host: Any, args: dict[str, Any]) -> dict[str, Any]:
    """{timeline, itemIds, which: fadeIn | fadeOut, seconds (0 removes it)} -> each clip fades in from
    (or out to) black or silence over that time, cut to what fits with its other fade."""
    which = args.get("which")
    if which not in ("fadeIn", "fadeOut"):
        raise HostError('which must be "fadeIn" or "fadeOut"')
    seconds = _number(args.get("seconds"), "seconds")
    if seconds < 0:
        raise HostError("seconds can't be negative")
    _project, timeline = host._timeline(args)
    fps = _frame_rate(timeline)
    key, other = ("FadeIn", "FadeOut") if which == "fadeIn" else ("FadeOut", "FadeIn")
    changes, refused = [], []
    for item_id, kind, index, item in _chosen(_items(timeline), args.get("itemIds")):
        name = item.GetName()
        if _is_transition(item):
            refused.append({"itemId": item_id, "reason": f"{name!r} is a transition"})
            continue
        fades = _fades(item)
        length = int(item.GetEnd()) - int(item.GetStart())
        frames = min(_to_frame(seconds, fps), max(0, length - fades[other]))
        if frames == fades[key]:
            continue
        if not item.SetFades({**fades, key: frames}):
            refused.append({"itemId": item_id, "reason": "Resolve didn't set the fade"})
            continue
        changes.append({
            "kind": "fade", "itemId": item_id, "name": name, "track": [kind, index], "which": which,
            "before": _seconds(fades[key], fps), "after": _seconds(frames, fps),
            **({"clamped": True} if frames < _to_frame(seconds, fps) else {}),
        })  # fmt: skip
    return {"changes": changes, "refused": refused}


def _transition_at(timeline: Any, kind: str, index: int, cut: int) -> Any:
    for other in timeline.GetItemListInTrack(kind, index) or []:
        if _is_transition(other) and int(other.GetStart()) <= cut <= int(other.GetEnd()):
            return other
    return None


def _described(item: Any, kind: str, fps: float) -> dict[str, Any]:
    """A transition as a change records it: VibeCut's kind when it is one of VibeCut's, and Resolve's
    own name and category, so a revert can put it back."""
    name = item.GetName()
    ours = next((k for k, (n, _c) in TRANSITIONS[kind].items() if n == name), None)
    frames = int(item.GetEnd()) - int(item.GetStart())
    category = next(
        (c for n, c in TRANSITIONS[kind].values() if n == name), "audio" if kind == "audio" else "simple"
    )
    return {
        "kind": ours or "other",
        "type": name,
        "category": category,
        "frames": frames,
        "seconds": _seconds(frames, fps),
    }


def _add(item: Any, described: dict[str, Any]) -> Any:
    added = item.AddTransition({
        "type": described["type"], "category": described["category"], "position": "end",
        "alignment": "center", "duration": int(described["frames"]),
    })  # fmt: skip
    return added if added is not None and added.GetStart() is not None and _is_transition(added) else None


def _room(item: Any, incoming: Any, kind: str, fps: float) -> int:
    """The longest transition, in frames, centred on the cut: half of either clip at most, and for a
    dissolve only the unused media both files have past the cut (an even number of frames)."""
    from vibecut_agent.nle.resolve_reshape import _source_frames

    half = (
        min(int(item.GetEnd()) - int(item.GetStart()), int(incoming.GetEnd()) - int(incoming.GetStart())) / 2
    )
    if kind == "dissolve":
        total = _source_frames(item, fps)
        tail = (
            (total - int(item.GetLeftOffset()) - (int(item.GetEnd()) - int(item.GetStart()))) if total else 0
        )
        half = min(half, max(0, tail), max(0, int(incoming.GetLeftOffset() or 0)))
    return 2 * math.floor(half)


def set_transition(host: Any, args: dict[str, Any]) -> dict[str, Any]:
    """{timeline, itemId (the clip before the cut), kind: dissolve | dipToBlack | none, seconds
    (default 1, or the current length when changing kind)} -> the transition on the cut at the clip's
    end, into the clip that starts there on the same track, centred and cut to what fits."""
    kind_wanted = args.get("kind")
    if kind_wanted not in ("dissolve", "dipToBlack", "none"):
        raise HostError('kind must be "dissolve", "dipToBlack" or "none"')
    _project, timeline = host._timeline(args)
    fps = _frame_rate(timeline)
    origin = int(timeline.GetStartFrame())
    ((item_id, kind, index, item),) = _chosen(_items(timeline), [args.get("itemId")])
    name = item.GetName()
    if _is_transition(item) or item.GetLeftOffset() is None:
        raise HostError(f"{name!r} is a transition, generator or title; give the clip before the cut")
    cut = int(item.GetEnd())
    incoming = next(
        (
            o
            for o in timeline.GetItemListInTrack(kind, index) or []
            if not _is_transition(o) and int(o.GetStart()) == cut
        ),
        None,
    )
    if incoming is None:
        raise HostError(
            f"No clip starts where {name!r} ends on {_label(kind, index)}, so there is no cut to put a transition on"
        )
    if kind_wanted != "none" and kind_wanted not in TRANSITIONS[kind]:
        raise HostError("A dip to black is for picture; on sound use a dissolve (a crossfade), or fades")
    existing = _transition_at(timeline, kind, index, cut)
    before = _described(existing, kind, fps) if existing is not None else None
    change = {
        "kind": "transition", "itemId": item_id, "incomingId": incoming.GetUniqueId(),
        "name": f"{name} → {incoming.GetName()}", "track": [kind, index], "cut": _seconds(cut - origin, fps),
        "before": before, "after": None,
    }  # fmt: skip
    if kind_wanted == "none":
        if existing is None:
            return {"changes": [], "refused": []}
        if not timeline.DeleteClips([existing], False):
            raise HostError("Resolve didn't remove the transition")
        return {"changes": [change], "refused": []}

    seconds = args.get("seconds")
    asked = (
        _to_frame(_number(seconds, "seconds"), fps)
        if seconds is not None
        else (before["frames"] if before else _to_frame(DEFAULT_SECONDS, fps))
    )
    if asked <= 0:
        raise HostError("The transition must be longer than 0 seconds")
    room = _room(item, incoming, kind_wanted, fps)
    if room < 2:
        raise HostError(
            f"No room for a dissolve: {name!r} and {incoming.GetName()!r} use their files right up to the cut. Trim them to leave unused media (handles) on both sides."
            if kind_wanted == "dissolve"
            else "The clips are too short for a transition"
        )
    frames = min(asked, room)
    if existing is not None and not timeline.DeleteClips([existing], False):
        raise HostError("Resolve didn't remove the transition that was there")
    transition, category = TRANSITIONS[kind][kind_wanted]
    wanted = {
        "kind": kind_wanted,
        "type": transition,
        "category": category,
        "frames": frames,
        "seconds": _seconds(frames, fps),
    }
    added = _add(item, wanted)
    if added is None:
        if before is not None:
            _add(item, before)
        raise HostError(
            f"Resolve didn't add the {transition}" + (", so the one there was put back" if before else "")
        )
    change["after"] = _described(added, kind, fps)
    if frames < asked:
        change["clamped"] = True
    return {"changes": [change], "refused": []}


# ------------------------------------------------------------------------------- reverting


def revert_fade(item: Any, change: dict[str, Any], fps: float) -> str:
    """ "reverted", "changed" (its fade isn't what the change left) or "failed"."""
    key = "FadeIn" if change.get("which") == "fadeIn" else "FadeOut"
    fades = _fades(item)
    if abs(fades[key] - _to_frame(float(change.get("after") or 0), fps)) > 0:
        return "changed"
    return (
        "reverted"
        if item.SetFades({**fades, key: _to_frame(float(change.get("before") or 0), fps)})
        else "failed"
    )


def revert_transition(timeline: Any, item: Any, change: dict[str, Any], origin: int, fps: float) -> str:
    """ "reverted", "changed" (the cut has another transition now, or none) or "failed"."""
    kind, index = change["track"]
    cut = origin + _to_frame(float(change["cut"]), fps)
    if int(item.GetEnd()) != cut:
        return "changed"
    now = _transition_at(timeline, kind, int(index), cut)
    after = change.get("after")
    if (now is None) != (after is None) or (
        now is not None
        and after is not None
        and (
            now.GetName() != after["type"] or int(now.GetEnd()) - int(now.GetStart()) != int(after["frames"])
        )
    ):
        return "changed"
    if now is not None and not timeline.DeleteClips([now], False):
        return "failed"
    before = change.get("before")
    if before is not None and _add(item, before) is None:
        return "failed"
    return "reverted"
