"""Linking clips (PLAN.md, "Phase 6c"): `set_links` and its Revert for both editors, VibeCut's
premiere_structure.py / resolve_structure.py link functions verbatim (names prefixed by editor so both live
here). The agent's link_clips / unlink_clips, and sync_and_place's camera + recorder groups, use them.
Standard library only: the Resolve half runs under Resolve's own Python.
"""

from __future__ import annotations

from typing import Any

from vibecut_agent.nle.errors import HostError
from vibecut_agent.nle.premiere_edit import Sequence, _label, _read
from vibecut_agent.nle.resolve import _linked, _track_locked
from vibecut_agent.nle.resolve_edit import _items
from vibecut_agent.nle.resolve_reshape import _label as _resolve_label

MAX_CLIPS = 32


# ------------------------------------------------------------------------------- Premiere


def premiere_link_groups(seq: Sequence) -> dict[str, frozenset[str]]:
    """Each clip's link group (itself alone when it's linked to nothing)."""
    parent = {item_id: item_id for item_id in seq.clips}

    def root(item_id: str) -> str:
        while parent[item_id] != item_id:
            parent[item_id] = parent[parent[item_id]]
            item_id = parent[item_id]
        return item_id

    for item_id, clip in seq.clips.items():
        for other in clip.get("linkedIds", []):
            if other in seq.clips:
                parent[root(other)] = root(item_id)
    members: dict[str, set[str]] = {}
    for item_id in seq.clips:
        members.setdefault(root(item_id), set()).add(item_id)
    return {item_id: frozenset(members[root(item_id)]) for item_id in seq.clips}


def _as_lists(groups: set[frozenset[str]]) -> list[list[str]]:
    return sorted(sorted(g) for g in groups)


def _premiere_refuse_locked(seq: Sequence, ids: Any) -> None:
    for item_id in ids:
        clip = seq.clips[item_id]
        if seq.locked(clip["kind"], clip["index"]):
            raise HostError(
                f"{_label(clip['kind'], clip['index'])} is locked in Premiere; unlock it first, or ask the user"
            )


def _premiere_regroup(host: Any, timeline: str, groups: list[list[str]]) -> None:
    host._send(
        "set_links",
        {
            "timeline": timeline,
            "unlink": [i for g in groups for i in g],
            "groups": [g for g in groups if len(g) > 1],
        },
    )


def premiere_set_links(host: Any, args: dict[str, Any]) -> dict[str, Any]:
    """{timeline, itemIds, action: "link" | "unlink"} -> "link" makes one group of the clips and the
    groups they're in; "unlink" takes the clips out of their groups (the rest of each group stays
    linked)."""
    timeline = host._name(args)
    action = args.get("action")
    if action not in ("link", "unlink"):
        raise HostError('action must be "link" or "unlink"')
    ids = args.get("itemIds")
    if (
        not isinstance(ids, list)
        or not ids
        or not all(isinstance(i, str) and i for i in ids)
    ):
        raise HostError("itemIds must be a non-empty list of sequence clip ids")
    ids = list(dict.fromkeys(ids))
    if len(ids) > MAX_CLIPS:
        raise HostError(f"At most {MAX_CLIPS} clips at a time")
    if action == "link" and len(ids) < 2:
        raise HostError("Give at least two clips to link")
    seq = _read(host, timeline)
    for item_id in ids:
        seq.clip(item_id)
    groups = premiere_link_groups(seq)
    touched = {groups[i] for i in ids}
    _premiere_refuse_locked(seq, {i for g in touched for i in g})
    if action == "link":
        wanted = {frozenset().union(*touched)}
    else:
        wanted = set()
        for group in touched:
            rest = group - set(ids)
            if rest:
                wanted.add(frozenset(rest))
            wanted |= {frozenset([i]) for i in group & set(ids)}
    if wanted == touched:
        return {"changes": [], "refused": []}
    before, after = _as_lists(touched), _as_lists(wanted)
    _premiere_regroup(host, timeline, after)
    now = premiere_link_groups(_read(host, timeline))
    if _as_lists({now[i] for g in after for i in g if i in now}) != after:
        _premiere_regroup(host, timeline, before)
        raise HostError(
            "Premiere didn't link the clips as asked, so they were put back as they were"
        )
    return {
        "changes": [
            {
                "kind": "link",
                "action": "linked" if action == "link" else "unlinked",
                "name": seq.clips[ids[0]].get("name", ""),
                "itemIds": ids,
                "groupsBefore": before,
                "groupsAfter": after,
            }
        ],
        "refused": [],
    }


def premiere_revert_links(host: Any, timeline: str, change: dict[str, Any]) -> str:
    """ "reverted", "changed" (the clips aren't grouped as the change left them) or "failed"."""
    before, after = change.get("groupsBefore") or [], change.get("groupsAfter") or []
    seq = _read(host, timeline)
    ids = {i for g in after for i in g}
    if not ids or any(i not in seq.clips for i in ids):
        return "changed"
    now = premiere_link_groups(seq)
    if _as_lists({now[i] for i in ids}) != _as_lists({frozenset(g) for g in after}):
        return "changed"
    if any(seq.locked(seq.clips[i]["kind"], seq.clips[i]["index"]) for i in ids):
        return "failed"
    _premiere_regroup(host, timeline, before)
    now = premiere_link_groups(_read(host, timeline))
    wanted = _as_lists({frozenset(g) for g in before})
    return (
        "reverted"
        if _as_lists({now[i] for g in before for i in g if i in now}) == wanted
        else "failed"
    )


# ------------------------------------------------------------------------------- Resolve


def resolve_link_groups(found: dict[str, tuple[str, int, Any]]) -> dict[str, frozenset[str]]:
    """Each clip's link group (itself alone when it's linked to nothing), from mutual links only."""
    parent = {item_id: item_id for item_id in found}

    def root(item_id: str) -> str:
        while parent[item_id] != item_id:
            parent[item_id] = parent[parent[item_id]]
            item_id = parent[item_id]
        return item_id

    for item_id, (_kind, _index, item) in found.items():
        for other in _linked(item):
            other_id = other.GetUniqueId()
            if other_id in found:
                parent[root(other_id)] = root(item_id)
    members: dict[str, set[str]] = {}
    for item_id in found:
        members.setdefault(root(item_id), set()).add(item_id)
    return {item_id: frozenset(members[root(item_id)]) for item_id in found}


def _resolve_regroup(
    timeline: Any, found: dict[str, tuple[str, int, Any]], groups: list[list[str]]
) -> None:
    """Unlinks every clip of `groups`, then links each group of two or more."""
    every = [found[i][2] for g in groups for i in g if i in found]
    if len(every) > 1:
        timeline.SetClipsLinked(every, False)
    for group in groups:
        items = [found[i][2] for i in group if i in found]
        if len(items) > 1:
            timeline.SetClipsLinked(items, True)


def _resolve_refuse_locked(timeline: Any, places: list[tuple[str, int]]) -> None:
    for kind, index in dict.fromkeys(places):
        if _track_locked(timeline, kind, index):
            raise HostError(
                f"{_resolve_label(kind, index)} is locked in Resolve; unlock it first, or ask the user"
            )


def resolve_set_links(host: Any, args: dict[str, Any]) -> dict[str, Any]:
    """{timeline, itemIds, action: "link" | "unlink"} -> "link" makes one group of the clips and the
    groups they're in; "unlink" takes the clips out of their groups (the rest of each group stays
    linked)."""
    _project, timeline = host._timeline(args)
    action = args.get("action")
    if action not in ("link", "unlink"):
        raise HostError('action must be "link" or "unlink"')
    ids = args.get("itemIds")
    if (
        not isinstance(ids, list)
        or not ids
        or not all(isinstance(i, str) and i for i in ids)
    ):
        raise HostError("itemIds must be a non-empty list of timeline clip ids")
    ids = list(dict.fromkeys(ids))
    if len(ids) > MAX_CLIPS:
        raise HostError(f"At most {MAX_CLIPS} clips at a time")
    found = _items(timeline)
    for item_id in ids:
        if item_id not in found:
            raise HostError(
                f"There is no clip {item_id!r} on the connected timeline any more"
            )
        if found[item_id][2].GetLeftOffset() is None:
            raise HostError(
                f"{found[item_id][2].GetName()!r} is a transition or generator; it can't be linked"
            )
    if action == "link" and len(ids) < 2:
        raise HostError("Give at least two clips to link")
    groups = resolve_link_groups(found)
    touched = {groups[i] for i in ids}
    _resolve_refuse_locked(timeline, [found[i][:2] for g in touched for i in g])
    if action == "link":
        wanted = {frozenset().union(*touched)}
    else:
        wanted = set()
        for group in touched:
            rest = group - set(ids)
            if rest:
                wanted.add(frozenset(rest))
            wanted |= {frozenset([i]) for i in group & set(ids)}
    if wanted == touched:
        return {"changes": [], "refused": []}
    before, after = _as_lists(touched), _as_lists(wanted)
    _resolve_regroup(timeline, found, after)
    now = resolve_link_groups(_items(timeline))
    got = _as_lists({now[i] for g in after for i in g if i in now})
    if got != after:
        # Put them back as they were.
        _resolve_regroup(timeline, _items(timeline), before)
        raise HostError(
            "Resolve didn't link the clips as asked, so they were put back as they were"
        )
    name = found[ids[0]][2].GetName()
    return {
        "changes": [
            {
                "kind": "link",
                "action": "linked" if action == "link" else "unlinked",
                "name": name,
                "itemIds": ids,
                "groupsBefore": before,
                "groupsAfter": after,
            }
        ],
        "refused": [],
    }


def resolve_revert_links(timeline: Any, change: dict[str, Any]) -> str:
    """ "reverted", "changed" (the clips aren't grouped as the change left them) or "failed"."""
    before, after = change.get("groupsBefore") or [], change.get("groupsAfter") or []
    found = _items(timeline)
    ids = {i for g in after for i in g}
    if not ids or any(i not in found for i in ids):
        return "changed"
    now = resolve_link_groups(found)
    if _as_lists({now[i] for i in ids}) != _as_lists({frozenset(g) for g in after}):
        return "changed"
    _resolve_regroup(timeline, found, before)
    now = resolve_link_groups(_items(timeline))
    wanted = _as_lists({frozenset(g) for g in before})
    return (
        "reverted"
        if _as_lists({now[i] for g in before for i in g if i in now}) == wanted
        else "failed"
    )
