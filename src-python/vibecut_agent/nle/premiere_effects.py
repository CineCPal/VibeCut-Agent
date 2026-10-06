"""premiere_effects.py -- fades and transitions on the connected Premiere sequence (PLAN.md, "Phase 6, 6e3").

The same commands and change records as host-resolve's resolve_effects.py. What Premiere 26.5.2 does
(PLAN.md, "6e.0 probe"):
- A fade is keyframes on the picture's Opacity (0 to its value) or the sound's Level (silence to its
  level), at source-file times: the clip's in point and out point and a fade's length inside them.
  Keys that aren't a fade made this way (or one key, which Premiere puts on every sound's Level) are
  someone else's, and the clip is refused rather than have them replaced.
- Because the keys sit in the source, a slip or trim would leave a fade where it was in the file, so
  premiere_edit.reshape_clip refuses clips with fades (see `has_fades`).
- Transitions are added through Premiere's QE layer at the clip's end, centred on the cut, a frame
  count long, and removed through the track's own transitions. Premiere shifts a transition that
  doesn't fit its handles by itself, so the length is cut to fit here, keeping it centred.
"""

from __future__ import annotations

from typing import Any

from vibecut_agent.nle.premiere import HostError, seconds
from vibecut_agent.nle.premiere_edit import Sequence, _ids, _number, _read

# kind -> Premiere's transition on each kind of track. No dip on sound.
TRANSITIONS = {
    "video": {"dissolve": "Cross Dissolve", "dipToBlack": "Dip to Black"},
    "audio": {"dissolve": "Constant Power"},
}
DEFAULT_SECONDS = 1.0


# ------------------------------------------------------------------------------- fades


def _fade_state(clip: dict[str, Any], read: dict[str, Any], half: int) -> tuple[float, int, int]:
    """(the value faded to, fade-in ticks, fade-out ticks) from the clip's keys, or a refusal when they
    aren't a fade VibeCut could have made."""
    keys = sorted(((int(k["ticks"]), float(k["value"])) for k in read.get("keys", [])), key=lambda k: k[0])
    if len(keys) <= 1:
        return (keys[0][1] if keys else float(read.get("value") or 0)), 0, 0
    src_in, src_out = int(clip["inTicks"]), int(clip["outTicks"])
    near = lambda a, b: abs(a - b) <= half
    fade_in = fade_out = 0
    base: float | None = None
    rest = list(keys)
    if len(rest) >= 2 and near(rest[0][0], src_in) and rest[0][1] == 0 and rest[1][1] > 0:
        fade_in, base, rest = rest[1][0] - src_in, rest[1][1], rest[2:]
    if fade_in and len(rest) == 1 and near(rest[0][0], src_out) and rest[0][1] == 0:
        # The fades meet: the fade-out starts on the fade-in's last key.
        fade_out, rest = src_out - (src_in + fade_in), []
    elif len(rest) >= 2 and near(rest[-1][0], src_out) and rest[-1][1] == 0 and rest[-2][1] > 0:
        if base is not None and abs(base - rest[-2][1]) > 1e-6:
            rest = keys
        else:
            fade_out, base, rest = src_out - rest[-2][0], rest[-2][1], rest[:-2]
    if rest:
        what = "Level" if clip["kind"] == "audio" else "Opacity"
        raise HostError(f"{clip['name']} has its own {what} keyframes; change them in Premiere")
    return float(base or 0), fade_in, fade_out


def _fade_keys(clip: dict[str, Any], base: float, fade_in: int, fade_out: int) -> list[dict[str, Any]]:
    src_in, src_out = int(clip["inTicks"]), int(clip["outTicks"])
    keys = []
    if fade_in:
        keys += [(src_in, 0.0), (src_in + fade_in, base)]
    if fade_out:
        if not (fade_in and src_out - fade_out == src_in + fade_in):
            keys.append((src_out - fade_out, base))
        keys.append((src_out, 0.0))
    return [{"ticks": str(t), "value": v} for t, v in keys]


def _fades_of(host: Any, timeline: str, ids: list[str]) -> dict[str, dict[str, Any]]:
    return {f["id"]: f for f in host._send("read_fades", {"timeline": timeline, "ids": ids})["items"]}


def has_fades(host: Any, timeline: str, seq: Sequence, ids: list[str]) -> str | None:
    """The name of the first clip with a fade or other keyframes on its Opacity or Level, or None."""
    for item_id, read in _fades_of(host, timeline, ids).items():
        if len(read.get("keys", [])) > 1:
            return seq.clips[item_id]["name"]
    return None


def set_clip_fades(host: Any, args: dict[str, Any]) -> dict[str, Any]:
    """{timeline, itemIds, which: fadeIn | fadeOut, seconds (0 removes it)} -> each clip fades in from
    (or out to) black or silence over that time, cut to what fits with its other fade."""
    which = args.get("which")
    if which not in ("fadeIn", "fadeOut"):
        raise HostError('which must be "fadeIn" or "fadeOut"')
    wanted = _number(args.get("seconds"), "seconds", 0)
    timeline = host._name(args)
    seq = _read(host, timeline)
    ids = _ids(args)
    clips = [seq.clip(i) for i in ids]
    for clip in clips:
        if clip.get("speed") not in (None, 1) or clip.get("reversed"):
            raise HostError(f"{clip['name']} has a speed change; fade it in Premiere")
    reads = _fades_of(host, timeline, ids)
    half = seq.timebase // 2
    changes, plans = [], []
    for clip in clips:
        base, fade_in, fade_out = _fade_state(clip, reads[clip["id"]], half)
        length = int(clip["endTicks"]) - int(clip["startTicks"])
        ticks = seq.ticks(wanted)
        mine, other = (fade_in, fade_out) if which == "fadeIn" else (fade_out, fade_in)
        new = min(ticks, max(0, length - other))
        if new == mine:
            continue
        fades = (new, fade_out) if which == "fadeIn" else (fade_in, new)
        if base <= 0:
            what = "silent" if clip["kind"] == "audio" else "fully transparent"
            raise HostError(f"{clip['name']} is {what}, so there's nothing to fade")
        plans.append({"id": clip["id"], "keys": _fade_keys(clip, base, *fades), "value": base})
        changes.append({
            "kind": "fade", "itemId": clip["id"], "name": clip["name"], "track": [clip["kind"], clip["index"]],
            "which": which, "before": seconds(mine), "after": seconds(new), **({"clamped": True} if new < ticks else {}),
        })  # fmt: skip
    if plans:
        host._send("set_fades", {"timeline": timeline, "items": plans})
    return {"changes": changes, "refused": []}


def revert_fade(host: Any, timeline: str, seq: Sequence, item_id: str, change: dict[str, Any]) -> str:
    """ "reverted" or "changed" (its fade isn't what the change left)."""
    clip = seq.clips[item_id]
    try:
        base, fade_in, fade_out = _fade_state(
            clip, _fades_of(host, timeline, [item_id])[item_id], seq.timebase // 2
        )
    except HostError:
        return "changed"
    now = fade_in if change.get("which") == "fadeIn" else fade_out
    if abs(now - seq.ticks(float(change.get("after") or 0))) > seq.timebase // 2:
        return "changed"
    before = seq.ticks(float(change.get("before") or 0))
    fades = (before, fade_out) if change.get("which") == "fadeIn" else (fade_in, before)
    host._send(
        "set_fades",
        {
            "timeline": timeline,
            "items": [{"id": item_id, "keys": _fade_keys(clip, base, *fades), "value": base}],
        },
    )
    return "reverted"


# ------------------------------------------------------------------------------- ducking (13e)

MIN_DUCK_DB, MAX_DUCK_DB = -40.0, -1.0
MAX_KEYS = 400  # bridge.js's MAX_LEVEL_KEYS
MIN_RAMP, MAX_RAMP = 0.05, 2.0


def _same_keys(a: list[dict[str, Any]], b: list[dict[str, Any]], half: int) -> bool:
    if len(a) != len(b):
        return False
    pairs = zip(sorted(a, key=lambda k: int(k["ticks"])), sorted(b, key=lambda k: int(k["ticks"])))
    return all(
        abs(int(x["ticks"]) - int(y["ticks"])) <= half and abs(float(x["value"]) - float(y["value"])) < 1e-4
        for x, y in pairs
    )


def duck_keys(
    clip: dict[str, Any],
    seq: Sequence,
    base: float,
    fade_in: int,
    fade_out: int,
    spans: list[tuple[float, float]],
    duck_db: float,
    ramp_s: float,
) -> tuple[list[dict[str, Any]], int]:
    """The clip's Level keys (source ticks) with its fades and a dip to `duck_db` below `base` over each
    span (timeline seconds), ramping over `ramp_s` outside it; spans closer than two ramps merge. Returns
    (keys, spans used)."""
    start, end = int(clip["startTicks"]), int(clip["endTicks"])
    src_in = int(clip["inTicks"])
    ramp = max(seq.timebase, seq.ticks(ramp_s))
    lo, hi = start + fade_in + ramp, end - fade_out - ramp
    low = base * 10 ** (duck_db / 20)
    dips: list[list[int]] = []
    for a, b in sorted(spans):
        a_t, b_t = max(lo, seq.ticks(a)), min(hi, seq.ticks(b))
        if b_t - a_t < seq.timebase:
            continue
        if dips and a_t - dips[-1][1] <= 2 * ramp:
            dips[-1][1] = max(dips[-1][1], b_t)
        else:
            dips.append([a_t, b_t])
    to_source = lambda t: src_in + (t - start)
    keys: list[tuple[int, float]] = [
        (int(k["ticks"]), float(k["value"])) for k in _fade_keys(clip, base, fade_in, fade_out)
    ]
    for a_t, b_t in dips:
        keys += [
            (to_source(a_t - ramp), base),
            (to_source(a_t), low),
            (to_source(b_t), low),
            (to_source(b_t + ramp), base),
        ]
    merged: dict[int, float] = {}
    for t, v in keys:
        merged[t] = v
    return [{"ticks": str(t), "value": v} for t, v in sorted(merged.items())], len(dips)


def duck_clip(host: Any, args: dict[str, Any]) -> dict[str, Any]:
    """{timeline, itemId, spans: [{start, end}] (timeline seconds), duckDb, rampSeconds} -> the clip's
    sound (a picture clip's id means its linked sound) dips by duckDb over each span, with Level keys
    that keep its fades. Refused for a clip with Level keys VibeCut didn't make as a fade."""
    duck_db = _number(args.get("duckDb", -12), "duckDb")
    if not MIN_DUCK_DB <= duck_db <= MAX_DUCK_DB:
        raise HostError(f"duckDb must be from {MIN_DUCK_DB:g} to {MAX_DUCK_DB:g} dB")
    ramp_s = _number(args.get("rampSeconds", 0.3), "rampSeconds")
    if not MIN_RAMP <= ramp_s <= MAX_RAMP:
        raise HostError(f"rampSeconds must be from {MIN_RAMP:g} to {MAX_RAMP:g}")
    raw = args.get("spans")
    if not isinstance(raw, list) or not raw or len(raw) > 1000:
        raise HostError("spans must be a non-empty list of {start, end} in timeline seconds")
    spans = []
    for i, span in enumerate(raw):
        if not isinstance(span, dict):
            raise HostError(f"spans[{i}] must be an object")
        a, b = (
            _number(span.get("start"), f"spans[{i}].start", 0),
            _number(span.get("end"), f"spans[{i}].end", 0),
        )
        if b > a:
            spans.append((a, b))
    timeline = host._name(args)
    seq = _read(host, timeline)
    clip = seq.clip(args.get("itemId"))
    sound = (
        [clip["id"]]
        if clip["kind"] == "audio"
        else [p for p in seq.partners(clip["id"]) if seq.clips[p]["kind"] == "audio"]
    )
    if not sound:
        raise HostError(f"{clip['name']} has no sound to duck")
    reads = _fades_of(host, timeline, sound)
    half = seq.timebase // 2
    plans, changes = [], []
    for item_id in sound:
        each = seq.clips[item_id]
        if each.get("speed") not in (None, 1) or each.get("reversed"):
            raise HostError(f"{each['name']} has a speed change; duck it in Premiere")
        read = reads[item_id]
        try:
            base, fade_in, fade_out = _fade_state(each, read, half)
        except HostError:
            raise HostError(
                f"{each['name']} already has Level keyframes (a duck, or the user's own); revert the earlier duck first, or change them in Premiere"
            ) from None
        if base <= 0:
            raise HostError(f"{each['name']} is silent, so there's nothing to duck")
        keys, used = duck_keys(each, seq, base, fade_in, fade_out, spans, duck_db, ramp_s)
        if not used:
            continue
        if len(keys) > MAX_KEYS:
            raise HostError(
                f"That's {used} ducks on {each['name']}, more than Premiere's bridge takes; duck a shorter stretch, or raise bridgeSeconds"
            )
        plans.append({"id": item_id, "keys": keys, "value": base})
        changes.append({
            "kind": "duck", "itemId": item_id, "name": each["name"], "track": [each["kind"], each["index"]],
            "duckDb": duck_db, "spans": used, "before": {"keys": read.get("keys", []), "value": base}, "after": keys,
        })  # fmt: skip
    if plans:
        host._send("set_fades", {"timeline": timeline, "items": plans})
    return {"changes": changes, "refused": []}


def revert_duck(host: Any, timeline: str, seq: Sequence, item_id: str, change: dict[str, Any]) -> str:
    """ "reverted" or "changed" (its Level keys aren't what the duck left)."""
    now = _fades_of(host, timeline, [item_id])[item_id]
    if not _same_keys(now.get("keys", []), change.get("after", []), seq.timebase // 2):
        return "changed"
    before = change.get("before") or {}
    # The bridge wants a number even when keys are given (a sound's read value is None with its one key).
    value = before.get("value")
    if not isinstance(value, (int, float)):
        value = float((before.get("keys") or [{"value": 0}])[0]["value"])
    host._send(
        "set_fades",
        {"timeline": timeline, "items": [{"id": item_id, "keys": before.get("keys", []), "value": value}]},
    )
    return "reverted"


# ------------------------------------------------------------------------------- transitions
