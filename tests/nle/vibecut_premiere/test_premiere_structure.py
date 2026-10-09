"""Track options on the connected sequence (premiere_structure.py, Phase 12d), VibeCut's test against
test_premiere_edit.py's fake Premiere, which switches tracks the way 26.5.2 did in the 8a.0 probe."""

import pytest

from tests.nle.vibecut_premiere.test_premiere_edit import (
    call,
    revert,
    setup,  # noqa: F401  (a fixture)
)
from vibecut_agent.nle.premiere import HostError


def test_track_options_and_revert(setup):  # noqa: F811
    host, premiere, _ = setup
    with pytest.raises(HostError, match="can't solo"):
        call(host, "set_track_options", type="audio", index=1, options={"soloed": True})
    with pytest.raises(HostError, match="contradict"):
        call(
            host,
            "set_track_options",
            type="audio",
            index=1,
            options={"enabled": False, "muted": False},
        )
    result = call(
        host,
        "set_track_options",
        type="audio",
        index=1,
        options={"enabled": False, "locked": True, "syncLocked": False},
    )
    (change,) = result["changes"]
    assert change["options"] == {
        "muted": [False, True],
        "locked": [False, True],
        "syncLocked": [True, False],
    }
    track = host.read_timeline({"timeline": "Main"})["tracks"]
    a1 = next(t for t in track if t["type"] == "audio")
    assert (a1["enabled"], a1["locked"]) == (False, True)
    assert revert(host, result)["reverted"] == [{"kind": "trackOptions", "name": "A1"}]
    assert premiere.flags("audio", 0) == {
        "muted": False,
        "locked": False,
        "targeted": True,
        "syncLocked": True,
    }
    # Changed since: left alone.
    result = call(host, "set_track_options", type="video", index=2, options={"targeted": False})
    premiere.flags("video", 1)["targeted"] = True
    assert revert(host, result)["changedSince"] == [{"name": "V2", "reason": "it was changed since"}]
