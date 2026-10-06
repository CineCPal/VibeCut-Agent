"""Fades and transitions on the connected sequence (premiere_effects.py) against test_premiere_edit.py's fake
Premiere, which keeps fade keys and adds transitions the way 26.5.2 did in the 6e.0 probe."""

import pytest

from tests.nle.vibecut_premiere.test_premiere_edit import (
    T,
    call,
    ids_of,
    revert,
    setup,  # noqa: F401  (a fixture)
)
from vibecut_agent.nle.premiere import HostError
from vibecut_agent.nle.premiere_edit import gain


def butt(premiere):
    """Moves B.mov (5-8 s, 2 s into its file) to 3-6 s, right after A.mov (0-3 s, 2 s in)."""
    for _k, _i, c in premiere.everything():
        if c["name"] == "B.mov":
            c["startTicks"], c["endTicks"] = str(3 * T), str(6 * T)


def ticks(seconds):
    return str(round(seconds * T))


def test_a_picture_fades_in_on_opacity_keys_in_the_source_and_reverts(setup):  # noqa: F811
    host, premiere, _ = setup
    picture = ids_of(premiere, "A.mov")[0]
    result = call(host, "set_clip_fades", itemIds=[picture], which="fadeIn", seconds=1)
    assert result["changes"] == [{
        "kind": "fade", "itemId": picture, "name": "A.mov", "track": ["video", 1], "which": "fadeIn", "before": 0.0, "after": 1.0,
    }]  # fmt: skip
    # Keys at source times: A.mov plays its file from 2 s.
    assert premiere.fades[picture]["keys"] == [
        {"ticks": ticks(2), "value": 0.0},
        {"ticks": ticks(3), "value": 100.0},
    ]
    out = call(host, "set_clip_fades", itemIds=[picture], which="fadeOut", seconds=5)
    assert out["changes"][0]["after"] == 2.0 and out["changes"][0]["clamped"] is True
    # The two fades meet: one key between them.
    assert [k["ticks"] for k in premiere.fades[picture]["keys"]] == [ticks(2), ticks(3), ticks(5)]
    reverted = revert(host, result, out)
    assert [r["kind"] for r in reverted["reverted"]] == ["fade", "fade"]
    assert premiere.fades[picture] == {"keys": [], "value": 100.0}


def test_a_sound_fades_from_silence_to_its_level(setup):  # noqa: F811
    host, premiere, _ = setup
    sound = ids_of(premiere, "A.mov", "audio")[0]
    call(host, "set_clip_fades", itemIds=[sound], which="fadeOut", seconds=0.48)
    assert premiere.fades[sound]["keys"] == [
        {"ticks": ticks(4.52), "value": gain(0)},
        {"ticks": ticks(5), "value": 0.0},
    ]


def test_other_keyframes_are_left_alone_and_block_a_slip(setup):  # noqa: F811
    host, premiere, _ = setup
    picture = ids_of(premiere, "A.mov")[0]
    premiere.fades[picture] = {
        "keys": [{"ticks": ticks(2.5), "value": 40.0}, {"ticks": ticks(4), "value": 90.0}],
        "value": None,
    }
    with pytest.raises(HostError, match="has its own Opacity keyframes"):
        call(host, "set_clip_fades", itemIds=[picture], which="fadeIn", seconds=1)
    with pytest.raises(HostError, match="has a fade or keyframes"):
        call(host, "reshape_clip", itemId=picture, slip=0.5)


def test_a_fade_changed_since_is_left(setup):  # noqa: F811
    host, premiere, _ = setup
    picture = ids_of(premiere, "A.mov")[0]
    result = call(host, "set_clip_fades", itemIds=[picture], which="fadeIn", seconds=1)
    premiere.fades[picture]["keys"][1]["ticks"] = ticks(2.5)
    assert revert(host, result)["changedSince"] == [{"name": "A.mov", "reason": "it was changed since"}]


# ------------------------------------------------------------------------------- ducking (13e)


def test_a_sound_ducks_over_a_span_with_ramps_in_the_source_and_reverts(setup):  # noqa: F811
    host, premiere, _ = setup
    sound = ids_of(premiere, "A.mov", "audio")[0]
    result = call(
        host, "duck_clip", itemId=sound, spans=[{"start": 1.0, "end": 2.0}], duckDb=-12, rampSeconds=0.2
    )
    change = result["changes"][0]
    assert {k: change[k] for k in ("kind", "itemId", "name", "duckDb", "spans")} == {
        "kind": "duck",
        "itemId": sound,
        "name": "A.mov",
        "duckDb": -12,
        "spans": 1,
    }
    low = gain(0) * 10 ** (-12 / 20)
    # A.mov plays its file from 2 s, so timeline 0.8-2.2 s is 2.8-4.2 s in the source.
    got = [(k["ticks"], round(k["value"], 6)) for k in premiere.fades[sound]["keys"]]
    assert got == [
        (ticks(2.8), round(gain(0), 6)),
        (ticks(3), round(low, 6)),
        (ticks(4), round(low, 6)),
        (ticks(4.2), round(gain(0), 6)),
    ]
    assert [r["kind"] for r in revert(host, result)["reverted"]] == ["duck"]
    # Put back as it was: Premiere's one key at the sound's level.
    assert [k["value"] for k in premiere.fades[sound]["keys"]] == [gain(0)]


def test_a_duck_keeps_the_fades_merges_close_spans_and_a_second_duck_is_refused(setup):  # noqa: F811
    host, premiere, _ = setup
    picture, sound = ids_of(premiere, "A.mov")[0], ids_of(premiere, "A.mov", "audio")[0]
    call(host, "set_clip_fades", itemIds=[sound], which="fadeOut", seconds=0.48)
    # A picture's id means its sound; the two spans 0.2 s apart merge into one dip.
    result = call(
        host,
        "duck_clip",
        itemId=picture,
        spans=[{"start": 0.6, "end": 1.0}, {"start": 1.2, "end": 1.6}],
        rampSeconds=0.2,
    )
    assert result["changes"][0]["spans"] == 1
    keys = premiere.fades[sound]["keys"]
    assert keys[-2:] == [{"ticks": ticks(4.52), "value": gain(0)}, {"ticks": ticks(5), "value": 0.0}]
    assert len(keys) == 6
    with pytest.raises(HostError, match="already has Level keyframes"):
        call(host, "duck_clip", itemId=sound, spans=[{"start": 0.5, "end": 1.0}])
    with pytest.raises(HostError, match="duckDb must be"):
        call(host, "duck_clip", itemId=sound, spans=[{"start": 0.5, "end": 1.0}], duckDb=-60)


def test_a_duck_changed_since_is_left(setup):  # noqa: F811
    host, premiere, _ = setup
    sound = ids_of(premiere, "A.mov", "audio")[0]
    result = call(host, "duck_clip", itemId=sound, spans=[{"start": 1.0, "end": 2.0}])
    premiere.fades[sound]["keys"] = [
        dict(k, value=0.01) if i == 1 else dict(k) for i, k in enumerate(premiere.fades[sound]["keys"])
    ]
    assert revert(host, result)["changedSince"] == [{"name": "A.mov", "reason": "it was changed since"}]


def test_a_duck_sends_a_number_as_the_value_and_refuses_too_many_keys(setup):  # noqa: F811
    host, premiere, _ = setup
    sound = ids_of(premiere, "A.mov", "audio")[0]
    sent = []
    original = host._send

    def spy(command, args):
        if command == "set_fades":
            sent.append(args)
        return original(command, args)

    host._send = spy
    result = call(host, "duck_clip", itemId=sound, spans=[{"start": 1.0, "end": 2.0}])
    revert(host, result)
    # Both the duck and its revert give a number: the bridge refuses None.
    assert all(isinstance(item["value"], float) for args in sent for item in args["items"])
    from vibecut_agent.nle import premiere_effects

    premiere_effects.MAX_KEYS, before = 3, premiere_effects.MAX_KEYS
    try:
        with pytest.raises(HostError, match="more than Premiere's bridge takes"):
            call(host, "duck_clip", itemId=sound, spans=[{"start": 1.0, "end": 2.0}])
    finally:
        premiere_effects.MAX_KEYS = before
