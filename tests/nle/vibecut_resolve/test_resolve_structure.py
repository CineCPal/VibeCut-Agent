"""Track options on the connected timeline (resolve_structure.py, Phase 12d), VibeCut's test against
test_resolve_edit.py's fakes, with track switches as Resolve 21.1 did them in the 8a.0 probe."""

import pytest

from tests.nle.vibecut_resolve.test_resolve_edit import START, call, make_edit
from vibecut_agent.nle.resolve import HostError


@pytest.fixture
def edit():
    host, timeline, project, c = make_edit()
    timeline.tracks["video"].append([])
    c["b"] = timeline.place("video", 2, c["broll"], 0, 100)
    return host, timeline, project, c


def revert(host, *changes):
    return call(host, "revert_timeline_changes", changes=list(changes))


def test_track_options_on_the_open_timeline_and_revert(edit):
    host, timeline, project, _c = edit
    with pytest.raises(HostError, match="open in it"):
        call(host, "set_track_options", type="audio", index=1, options={"enabled": False})
    project.current = timeline
    with pytest.raises(HostError, match="can't set a track's muted"):
        call(host, "set_track_options", type="audio", index=1, options={"muted": True})
    (change,) = call(
        host,
        "set_track_options",
        type="audio",
        index=1,
        options={"enabled": False, "locked": True},
    )["changes"]
    assert change == {
        "kind": "trackOptions", "name": "A1", "type": "audio", "index": 1,
        "options": {"enabled": [True, False], "locked": [False, True]},
    }  # fmt: skip
    a1 = host._read_track(timeline, "audio", 1, START, 25.0, True)
    assert (a1["enabled"], a1["locked"]) == (False, True)
    assert revert(host, change)["reverted"] == [{"kind": "trackOptions", "name": "A1"}]
    assert timeline.GetIsTrackEnabled("audio", 1) and not timeline.GetIsTrackLocked("audio", 1)
