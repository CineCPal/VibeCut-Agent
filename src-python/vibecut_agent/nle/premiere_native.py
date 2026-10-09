"""premiere_native.py -- send_to_premiere built inside Premiere (PLAN.md, "Phase 12a").

The XML rebuild (premiere_rebuild.py) has Premiere import a file, and Premiere then makes a new master
clip for every source in it, even one already in the project (the "VibeCut" bin filled up with copies),
and the clips' effects stay behind. Here the new sequence is a clone of the connected one, cut up in place:
1. `clone_sequence` copies it (effects, Lumetri, keyframes and all) into the "VibeCut" bin and opens it.
2. Its transitions are removed (`remove_transitions`); the XML rebuild never carried them either.
3. Each draft clip cut from a clip of the original (its originId) is found in the clone where it was cut
   from: that track is razored at the piece's edges (`razor_cuts`, QE), the pieces no draft clip uses are
   lifted, and the rest are moved into place in two passes: all of them past the end first, then each to
   its start, so no move lands on another clip.
4. Levels, on/off and links are set as the draft has them.
5. A draft clip with no clip of the original to come from (B-roll the draft placed, a Story Editor cut, a
   second use of the same part of a clip) is placed from the project's own item for its file by
   premiere_edit.add_clips, which imports only a file the project doesn't have yet.
6. The markers are replaced by the draft's.
If anything fails, the clone is deleted; the original is never touched.

A clip with a speed ramp, or a new clip at another speed, can't be built this way: `plan` returns None
and premiere_rebuild.py builds that draft from XML, saying so.
"""

from __future__ import annotations

import contextlib
import math
from typing import Any

from vibecut_agent.nle.premiere import HostError, seconds
from vibecut_agent.nle.premiere_edit import Sequence, _read, add_clips, gain
from vibecut_agent.nle.premiere_timing import timecode

# Calls to the panel are kept to what its checks take (bridge.js).
RAZOR_CHUNK = 200
IDS_CHUNK = 500
ADD_CHUNK = 50
LINK_GROUPS_CHUNK = 32
LINK_IDS_CHUNK = 64
MAX_NEW_TRACKS = 8


def _num(value: Any, default: float | None = None) -> float | None:
    if isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value):
        return float(value)
    return default


def layout_clips(raw: Any) -> list[dict[str, Any]]:
    """The draft's clips ({video: [[clip]], audio: [[clip]]}, V1/A1 first) with their kind and 1-based
    track, checked enough that every later step can rely on them."""
    if not isinstance(raw, dict):
        raise HostError("layout must be {video: [...], audio: [...]}")
    out: list[dict[str, Any]] = []
    for kind in ("video", "audio"):
        tracks = raw.get(kind) or []
        if not isinstance(tracks, list):
            raise HostError(f"layout.{kind} must be a list of tracks")
        for index, clips in enumerate(tracks, start=1):
            if not isinstance(clips, list):
                raise HostError(f"layout.{kind}[{index - 1}] must be a list of clips")
            for j, c in enumerate(clips):
                where = f"layout.{kind}[{index - 1}][{j}]"
                if not isinstance(c, dict) or not isinstance(c.get("sourcePath"), str):
                    raise HostError(f"{where} must be a clip with a sourcePath")
                start, end = _num(c.get("start")), _num(c.get("end"))
                source_in, source_out = _num(c.get("sourceIn")), _num(c.get("sourceOut"))
                if (
                    start is None
                    or end is None
                    or source_in is None
                    or source_out is None
                    or end <= start
                    or source_out <= source_in
                ):
                    raise HostError(f"{where} needs start < end and sourceIn < sourceOut, in seconds")
                out.append({
                    "kind": kind,
                    "index": index,
                    "originId": c.get("originId") if isinstance(c.get("originId"), str) else None,
                    "sourcePath": c["sourcePath"],
                    "start": start,
                    "end": end,
                    "sourceIn": source_in,
                    "sourceOut": source_out,
                    "speed": _num(c.get("speed"), 1.0),
                    "enabled": c.get("enabled") is not False,
                    "volumeDb": _num(c.get("volumeDb")),
                    "linkGroup": c.get("linkGroup") if isinstance(c.get("linkGroup"), str) else None,
                    "ramp": c.get("ramp") is True,
                })  # fmt: skip
    if not out:
        raise HostError("There is nothing to put on the new sequence")
    return out


def plan(
    seq: Sequence, view: dict[str, dict[str, Any]], clips: list[dict[str, Any]]
) -> dict[str, Any] | None:
    """Which draft clips come from a clip of the original (`kept`, with where they sit in it now, in
    ticks) and which are placed new (`placed`). None when the draft can't be built in Premiere."""
    kept: list[dict[str, Any]] = []
    placed: list[dict[str, Any]] = []
    used: dict[str, list[tuple[int, int]]] = {}
    for c in sorted(clips, key=lambda c: (c["kind"], c["index"], c["start"])):
        if c["ramp"]:
            return None
        origin = seq.clips.get(c["originId"] or "")
        read = view.get(c["originId"] or "")
        if origin is not None and read is not None:
            rate = _num(read.get("speed"), 1.0) or 1.0
            same = (
                (origin["kind"], origin["index"]) == (c["kind"], c["index"])
                and origin.get("mediaPath") == c["sourcePath"]
                and rate > 0
                and abs(rate - (c["speed"] or 1.0)) < 1e-3
            )
            if same:
                first, last = int(origin["startTicks"]), int(origin["endTicks"])
                at = max(first, seq.ticks(read["start"] + (c["sourceIn"] - read["sourceIn"]) / rate))
                until = min(last, seq.ticks(read["start"] + (c["sourceOut"] - read["sourceIn"]) / rate))
                spans = used.setdefault(origin["id"], [])
                if until > at and all(until <= s or at >= e for s, e in spans):
                    spans.append((at, until))
                    kept.append(
                        {
                            **c,
                            "origin": origin,
                            "read": read,
                            "from": at,
                            "to": until,
                            "target": seq.ticks(c["start"]),
                        }
                    )
                    continue
        if abs((c["speed"] or 1.0) - 1.0) > 1e-3:
            return None
        placed.append(c)
    return {"kept": kept, "placed": placed}


def _cuts(seq: Sequence, kept: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Where to razor the clone: each kept piece's edges that fall inside the clip it comes from."""
    seen: set[tuple[str, int, int]] = set()
    cuts = []
    for k in kept:
        first, last = int(k["origin"]["startTicks"]), int(k["origin"]["endTicks"])
        for edge in (k["from"], k["to"]):
            key = (k["kind"], k["index"], edge)
            if first < edge < last and key not in seen:
                seen.add(key)
                cuts.append({"type": k["kind"], "track": k["index"] - 1, "timecode": timecode(seq, edge)})
    return cuts


def _pieces(after: Sequence, kept: list[dict[str, Any]], half: int) -> dict[int, str]:
    """The clone's clip for each kept piece (by its place in `kept`), found by track and place."""
    found: dict[int, str] = {}
    for n, k in enumerate(kept):
        match = next(
            (
                c["id"]
                for c in after.clips.values()
                if (c["kind"], c["index"]) == (k["kind"], k["index"])
                and abs(int(c["startTicks"]) - k["from"]) <= half
                and abs(int(c["endTicks"]) - k["to"]) <= half
                and c["id"] not in found.values()
            ),
            None,
        )
        if match is None:
            raise HostError(
                f"Premiere didn't cut {k['origin'].get('name') or 'a clip'} at {seconds(k['from'])}–{seconds(k['to'])} s "
                "on the new sequence"
            )
        found[n] = match
    return found


def _chunks(items: list[Any], size: int) -> list[list[Any]]:
    return [items[i : i + size] for i in range(0, len(items), size)]


def _link_batches(groups: list[list[str]]) -> list[list[list[str]]]:
    """set_links calls: at most 32 groups and 64 clips each."""
    batches: list[list[list[str]]] = [[]]
    count = 0
    for group in groups:
        if batches[-1] and (len(batches[-1]) >= LINK_GROUPS_CHUNK or count + len(group) > LINK_IDS_CHUNK):
            batches.append([])
            count = 0
        batches[-1].append(group)
        count += len(group)
    return [b for b in batches if b]


def _placements(placed: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """add_clips entries for the new clips: a picture and its sound from the same moment of the same
    file go in together, linked; the sound's channels fill the tracks from its first one."""
    groups: dict[tuple[Any, ...], list[dict[str, Any]]] = {}
    for n, c in enumerate(placed):
        key = (c["linkGroup"] or f"#{n}", c["sourcePath"], round(c["start"], 3), round(c["sourceIn"], 3))
        groups.setdefault(key, []).append(c)
    out = []
    for members in groups.values():
        picture = next((c for c in members if c["kind"] == "video"), None)
        sounds = sorted((c for c in members if c["kind"] == "audio"), key=lambda c: c["index"])
        first = picture or sounds[0]
        entry: dict[str, Any] = {
            "path": first["sourcePath"],
            "sourceIn": first["sourceIn"],
            "sourceOut": first["sourceOut"],
            "at": first["start"],
            "picture": picture is not None,
            "sound": bool(sounds),
        }
        if picture is not None:
            entry["videoTrack"] = picture["index"]
        if sounds:
            entry["audioTrack"] = sounds[0]["index"]
            if sounds[0]["volumeDb"] is not None:
                entry["volumeDb"] = sounds[0]["volumeDb"]
        out.append(entry)
    return out


def build(
    host: Any, base: str, name: str, bin_name: str, seq: Sequence, steps: dict[str, Any]
) -> dict[str, Any]:
    """Makes `name` from the draft (`steps` is plan()'s answer). Returns the rebuild's result."""
    kept, placed = steps["kept"], steps["placed"]
    made = host._send("clone_sequence", {"timeline": base, "name": name, "bin": bin_name})
    name = made.get("name", name)
    warnings: list[str] = []
    try:
        if any(t.get("transitions") for kind in ("video", "audio") for t in seq.tracks[kind]):
            host._send("remove_transitions", {"timeline": name})
            warnings.append("Transitions weren't carried; add them again with set_transition.")

        for chunk in _chunks(_cuts(seq, kept), RAZOR_CHUNK):
            host._send("razor_cuts", {"timeline": name, "cuts": chunk})
        after = _read(host, name)
        pieces = _pieces(after, kept, after.timebase // 2)

        unused = [i for i in after.clips if i not in set(pieces.values())]
        for chunk in _chunks(unused, IDS_CHUNK):
            host._send("remove_items", {"timeline": name, "ids": chunk})

        movers = [n for n, k in enumerate(kept) if k["target"] != k["from"]]
        if movers:
            ends = [int(c["endTicks"]) for c in after.clips.values()] + [
                k["target"] + k["to"] - k["from"] for k in kept
            ]
            park = seq.ticks(seconds(max(ends)) + 1.0)
            for chunk in _chunks(movers, IDS_CHUNK):
                host._send(
                    "move_items",
                    {"timeline": name, "ids": [pieces[n] for n in chunk], "offsetTicks": str(park)},
                )
            for chunk in _chunks(movers, IDS_CHUNK):
                moves = [
                    {"id": pieces[n], "offsetTicks": str(kept[n]["target"] - kept[n]["from"] - park)}
                    for n in chunk
                ]
                host._send("move_items", {"timeline": name, "moves": moves})

        settings = []
        for n, k in enumerate(kept):
            item: dict[str, Any] = {"id": pieces[n]}
            if k["enabled"] == bool(k["origin"].get("disabled")):
                item["disabled"] = not k["enabled"]
            if k["kind"] == "audio":
                was = _num(k["read"].get("volumeDb"))
                want = k["volumeDb"] if k["volumeDb"] is not None else 0.0
                if was is not None and abs(want - was) > 0.05:
                    item["level"] = gain(want)
            if len(item) > 1:
                settings.append(item)
        for chunk in _chunks(settings, IDS_CHUNK):
            try:
                host._send("set_items", {"timeline": name, "items": chunk})
            except HostError as exc:
                warnings.append(f"Some levels or on/off settings weren't set: {exc}")

        linked: dict[tuple[str, int], list[str]] = {}
        for n, k in enumerate(kept):
            if k["linkGroup"]:
                linked.setdefault((k["linkGroup"], k["target"]), []).append(pieces[n])
        groups = [g for g in linked.values() if len(g) > 1]
        for batch in _link_batches(groups):
            host._send(
                "set_links", {"timeline": name, "unlink": [i for g in batch for i in g], "groups": batch}
            )

        if placed:
            now = _read(host, name)
            more = {
                kind: max(
                    0,
                    max((c["index"] for c in placed if c["kind"] == kind), default=0) - len(now.tracks[kind]),
                )
                for kind in ("video", "audio")
            }
            if any(v > MAX_NEW_TRACKS for v in more.values()):
                raise HostError("The draft has more tracks than VibeCut can add to a sequence at once")
            if any(more.values()):
                host._send("add_tracks", {"timeline": name, **more})
        for chunk in _chunks(_placements(placed), ADD_CHUNK):
            add_clips(host, {"timeline": name, "clips": chunk})

        host._send("open_sequence", {"timeline": name})
    except Exception:
        with contextlib.suppress(Exception):
            host._send("delete_sequence", {"timeline": name})
        raise
    return {
        "timeline": name,
        "clips": len(kept) + len(placed),
        "carried": len(kept),
        "placed": len(placed),
        "warnings": warnings,
    }


def view_of(host: Any, base: str) -> dict[str, dict[str, Any]]:
    """The original's clips as the agent reads them (seconds, speed, level), by id."""
    tracks = host.read_timeline({"timeline": base}).get("tracks", [])
    return {c["id"]: c for t in tracks for c in t.get("clips", []) if c.get("kind") is None}
