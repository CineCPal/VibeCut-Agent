"""premiere_native.py -- send_to_premiere built inside Premiere (PLAN.md, "Phase 12a").

The XML rebuild (premiere_rebuild.py) has Premiere import a file, and Premiere then makes a new master
clip for every source in it, even one already in the project (the "VibeCut" bin filled up with copies).
Here the new sequence is made from the project's own clips instead:
1. `clone_sequence` copies the connected sequence into the "VibeCut" bin (its settings, tracks and track
   names) and opens it; every clip on the copy is then lifted (`remove_items`) and its transitions removed.
2. Each draft piece is placed with `place_clip`: the project item it was cut from (else the one for its
   file, which is imported only when the project doesn't have it), its source range, at its start, on
   its tracks. A picture and its sound from the same moment of the same file go in together; the half
   a piece doesn't want is lifted again at once, before the next placement.
3. Levels and on/off are set as the draft has them, and the result is read back: every piece must be
   there, where the draft has it. If anything fails, the copy is deleted; the original is never touched.

Effects, Lumetri and keyframes don't come across (the XML rebuild never carried them either). Moving
the copy's own clips into place would have kept them, but Premiere 26.5.2 loses clips when a script
moves many of them (seen live, 2026-10-09: 180 moves read back as done, while Premiere's timeline showed
four clips), so nothing is moved.

A clip with a speed ramp, or at another speed, can't be placed this way: `plan` returns None and
premiere_rebuild.py builds that draft from XML, saying so.
"""

from __future__ import annotations

import contextlib
import math
from typing import Any

from vibecut_agent.nle.premiere import TICKS_PER_SECOND, HostError, seconds
from vibecut_agent.nle.premiere_edit import Sequence, _read, gain
from vibecut_agent.nle.premiere_support import BIN_NAME

IDS_CHUNK = 500
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
                    "ramp": c.get("ramp") is True,
                })  # fmt: skip
    if not out:
        raise HostError("There is nothing to put on the new sequence")
    return out


def plan(seq: Sequence, clips: list[dict[str, Any]]) -> list[dict[str, Any]] | None:
    """The placements that make the draft: one per picture and its sound from the same moment of the
    same file, each with its project item when the original has it. None when the draft can't be placed
    (a speed ramp, or a speed other than normal)."""
    if any(c["ramp"] or abs((c["speed"] or 1.0) - 1.0) > 1e-3 for c in clips):
        return None
    groups: dict[tuple[Any, ...], list[dict[str, Any]]] = {}
    for c in sorted(clips, key=lambda c: (c["start"], c["kind"] != "video", c["index"])):
        key = (seq.ticks(c["start"]), c["sourcePath"], round(c["sourceIn"], 3), round(c["sourceOut"], 3))
        groups.setdefault(key, []).append(c)
    out = []
    for (at, path, _in, _out), members in groups.items():
        pictures = [c for c in members if c["kind"] == "video"]
        sounds = sorted((c for c in members if c["kind"] == "audio"), key=lambda c: c["index"])
        # Two pictures of the same moment on different tracks are placed apart.
        for picture in pictures[1:]:
            out.append(_placement(seq, at, path, [picture], []))
        out.append(_placement(seq, at, path, pictures[:1], sounds))
    return out


def _placement(
    seq: Sequence, at: int, path: str, pictures: list[dict[str, Any]], sounds: list[dict[str, Any]]
) -> dict[str, Any]:
    first = (pictures or sounds)[0]
    origin = next((seq.clips[c["originId"]] for c in pictures + sounds if c["originId"] in seq.clips), None)
    item_id = origin.get("projectItemId") if origin and origin.get("mediaPath") == path else None
    frames = max(1, round((first["end"] - first["start"]) * TICKS_PER_SECOND / seq.timebase))
    return {
        "path": path,
        "itemId": item_id if isinstance(item_id, str) and item_id else None,
        "atTicks": at,
        "inSeconds": first["sourceIn"],
        "outSeconds": first["sourceIn"] + frames * seq.timebase / TICKS_PER_SECOND,
        "picture": pictures[0] if pictures else None,
        "sounds": sounds,
        "name": path.rsplit("/", 1)[-1],
    }


def _chunks(items: list[Any], size: int) -> list[list[Any]]:
    return [items[i : i + size] for i in range(0, len(items), size)]


def _place(host: Any, name: str, p: dict[str, Any]) -> list[dict[str, Any]]:
    """One placement; the halves the draft doesn't have there are lifted again at once."""
    picture, sounds = p["picture"], p["sounds"]
    placed: list[dict[str, Any]] = host._send(
        "place_clip",
        {
            "timeline": name,
            "path": p["path"],
            "inSeconds": p["inSeconds"],
            "outSeconds": p["outSeconds"],
            "atTicks": str(p["atTicks"]),
            # The panel's tracks are 0-based; -1 is none.
            "videoTrack": picture["index"] - 1 if picture else -1,
            "audioTrack": sounds[0]["index"] - 1 if sounds else -1,
            "bin": BIN_NAME,
            **({"itemId": p["itemId"]} if p["itemId"] else {}),
        },
    )["placed"]
    wanted_audio = {c["index"] for c in sounds}
    unwanted = [
        q["id"]
        for q in placed
        if (q["type"] == "video" and (picture is None or q["track"] + 1 != picture["index"]))
        or (q["type"] == "audio" and q["track"] + 1 not in wanted_audio)
    ]
    if unwanted:
        host._send("remove_items", {"timeline": name, "ids": unwanted})
    return [q for q in placed if q["id"] not in unwanted]


def build(
    host: Any, base: str, name: str, bin_name: str, seq: Sequence, placements: list[dict[str, Any]]
) -> dict[str, Any]:
    """Makes `name` from the draft (`placements` is plan()'s answer). Returns the rebuild's result."""
    made = host._send("clone_sequence", {"timeline": base, "name": name, "bin": bin_name})
    name = made.get("name", name)
    warnings: list[str] = []
    try:
        copy = _read(host, name)
        if any(t.get("transitions") for kind in ("video", "audio") for t in copy.tracks[kind]):
            host._send("remove_transitions", {"timeline": name})
        for chunk in _chunks(list(copy.clips), IDS_CHUNK):
            host._send("remove_items", {"timeline": name, "ids": chunk})
        if _read(host, name).clips:
            raise HostError("Premiere didn't clear the copy of the sequence")

        wanted = {"video": 0, "audio": 0}
        for p in placements:
            if p["picture"]:
                wanted["video"] = max(wanted["video"], p["picture"]["index"])
            for s in p["sounds"]:
                wanted["audio"] = max(wanted["audio"], s["index"])
        more = {kind: max(0, wanted[kind] - len(copy.tracks[kind])) for kind in wanted}
        if any(v > MAX_NEW_TRACKS for v in more.values()):
            raise HostError("The draft has more tracks than VibeCut can add to a sequence at once")
        if any(more.values()):
            host._send("add_tracks", {"timeline": name, **more})

        settings = []
        for p in placements:
            for q in _place(host, name, p):
                draft = (
                    p["picture"]
                    if q["type"] == "video"
                    else next((s for s in p["sounds"] if s["index"] == q["track"] + 1), None)
                )
                if draft is None:
                    continue
                item: dict[str, Any] = {"id": q["id"]}
                if not draft["enabled"]:
                    item["disabled"] = True
                if q["type"] == "audio" and draft["volumeDb"] is not None and abs(draft["volumeDb"]) > 0.05:
                    item["level"] = gain(draft["volumeDb"])
                if len(item) > 1:
                    settings.append(item)
        for chunk in _chunks(settings, IDS_CHUNK):
            try:
                host._send("set_items", {"timeline": name, "items": chunk})
            except HostError as exc:
                warnings.append(f"Some levels or on/off settings weren't set: {exc}")

        _check(_read(host, name), placements, name)
        host._send("open_sequence", {"timeline": name})
    except Exception:
        with contextlib.suppress(Exception):
            host._send("delete_sequence", {"timeline": name})
        raise
    count = sum((1 if p["picture"] else 0) + len(p["sounds"]) for p in placements)
    return {"timeline": name, "clips": count, "warnings": warnings}


def _check(after: Sequence, placements: list[dict[str, Any]], name: str) -> None:
    """Every piece must be on its track where the draft has it."""
    tb = after.timebase
    have = {(c["kind"], c["index"], round(int(c["startTicks"]) / tb)) for c in after.clips.values()}
    for p in placements:
        tracks = ([("video", p["picture"]["index"])] if p["picture"] else []) + [
            ("audio", s["index"]) for s in p["sounds"]
        ]
        frame = round(p["atTicks"] / tb)
        for kind, index in tracks:
            if not any((kind, index, frame + d) in have for d in (-1, 0, 1)):
                raise HostError(
                    f"Premiere didn't place {p['name']} at {seconds(p['atTicks'])} s on "
                    f'{kind[0].upper()}{index} of "{name}", so the new sequence was deleted'
                )
