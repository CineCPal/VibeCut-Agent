import pytest

from tests.nle.fakes import FakePanel, sequence
from vibecut_agent.nle.errors import HostError, Unreachable
from vibecut_agent.nle.premiere import PremiereHost, level_db, timecode, timeline
from vibecut_agent.nle.premiere_bridge import NOT_INSTALLED, PremiereBridge


def test_timeline_converts_ticks_levels_and_markers():
    t = timeline(sequence())
    assert t["fps"] == 23.976
    assert t["startTimecode"] == "01:00:00:00"
    assert t["duration"] == 10.0
    assert t["isCurrent"] is True

    v1 = t["tracks"][0]
    assert [c["id"] for c in v1["clips"]] == ["v1a", "tr-v1-1", "adj", "v1b"]
    a, dissolve, adjustment, b = v1["clips"]
    assert a == {
        "id": "v1a",
        "name": "A.mov",
        "start": 0.0,
        "end": 3.0,
        "enabled": True,
        "sourceIn": 2.0,
        "sourceOut": 5.0,
        "filePath": "/media/A.mov",
        "linkedIds": ["a1a"],
    }
    assert dissolve["kind"] == adjustment["kind"] == "effect"
    # A retimed clip's points are in timeline time; reversed clips have a negative speed.
    assert b["sourceIn"] == 2.0 and b["speed"] == -2.0

    assert t["tracks"][1]["enabled"] is False and t["tracks"][1]["muted"] is True
    audio = [tr for tr in t["tracks"] if tr["type"] == "audio"]
    assert [tr["clips"][0]["channel"] for tr in audio] == [1, 2]
    assert audio[0]["clips"][0]["volumeDb"] == -6.02

    assert [(m["id"], m["time"], m["color"], m["duration"]) for m in t["markers"]] == [
        ("m1", 1.0, "Green", 1.0),
        ("m2", 4.0, "Red", 0.0),
    ]


def test_unit_helpers():
    assert timecode(10594584000 * (86400 + 25), 10594584000) == "01:00:01:01"
    assert level_db(0) == -96.0
    assert level_db("loud") is None


def test_host_status_dedupes_sequence_names_and_needs_a_timeline_name(tmp_path):
    handlers = {
        "status": lambda _a: {
            "version": "26.5.2",
            "project": "Doc",
            "sequences": ["A", "B", "A"],
            "activeSequence": "B",
        },
        "read_sequence": lambda a: {**sequence(), "name": a["timeline"]},
    }
    with FakePanel(tmp_path, handlers) as panel:
        bridge = PremiereBridge(tmp_path)
        host = PremiereHost(bridge.request)
        assert host.status({}) == {
            "product": "Adobe Premiere Pro",
            "version": "26.5.2",
            "project": "Doc",
            "timelines": ["A", "B"],
            "currentTimeline": "B",
        }
        assert host.read_timeline({"timeline": "Cut 2"})["timeline"] == "Cut 2"
        with pytest.raises(HostError, match="timeline must name"):
            host.read_timeline({})
    assert [r["command"] for r in panel.seen] == ["status", "read_sequence"]


def test_bridge_reports_panel_errors(tmp_path):
    def refuse(_args):
        raise RuntimeError("No project is open in Premiere Pro")

    with FakePanel(tmp_path, {"status": refuse}), pytest.raises(HostError, match="No project is open"):
        PremiereBridge(tmp_path).request("status", {}, 5)


def test_bridge_says_to_restart_premiere_when_its_loaded_panel_is_older(tmp_path):
    def old_panel(_args):
        raise RuntimeError("Unknown command: clone_sequence")

    with FakePanel(tmp_path, {"clone_sequence": old_panel}), pytest.raises(HostError) as exc:
        PremiereBridge(tmp_path).request("clone_sequence", {}, 5)
    assert "still running VibeCut Agent's panel 0.1.0" in str(exc.value)
    assert "Restart Premiere" in str(exc.value)


def test_bridge_without_a_heartbeat_says_to_install_the_panel(tmp_path):
    with pytest.raises(Unreachable) as exc:
        PremiereBridge(tmp_path).check_alive()
    assert str(exc.value) == NOT_INSTALLED


def test_bridge_with_a_stale_heartbeat_says_premiere_isnt_running(tmp_path):
    panel = FakePanel(tmp_path, {})
    (tmp_path / "jobs").mkdir()
    panel.beat(at=1000.0)
    bridge = PremiereBridge(tmp_path, clock=lambda: 1010.0)
    with pytest.raises(Unreachable, match="isn't running"):
        bridge.check_alive()


def test_bridge_withdraws_a_request_nobody_answers(tmp_path):
    now = [0.0]

    def clock() -> float:
        return now[0]

    def sleep(seconds: float) -> None:
        now[0] += seconds

    panel = FakePanel(tmp_path, {})
    (tmp_path / "jobs").mkdir()
    (tmp_path / "replies").mkdir()
    panel.beat(at=0.0)
    bridge = PremiereBridge(tmp_path, clock=clock, sleep=sleep)
    with pytest.raises(Unreachable, match="didn't answer status within 3 s"):
        bridge.request("status", {}, 3.0)
    assert list((tmp_path / "jobs").iterdir()) == []


def test_prepare_clears_leftovers(tmp_path):
    (tmp_path / "jobs").mkdir()
    (tmp_path / "jobs" / "old.json").write_text("{}")
    (tmp_path / "jobs" / "old.json.running").write_text("{}")
    PremiereBridge(tmp_path).prepare()
    assert list((tmp_path / "jobs").iterdir()) == []
    assert (tmp_path / "replies").is_dir()


TPS = 254016000000


def test_timeline_says_where_the_playhead_and_marks_are():
    """Phase 13a (panel 0.9.1): the playhead on the open sequence, and In/Out when set."""
    raw = {**sequence(), "playheadTicks": str(4 * TPS), "inTicks": str(2 * TPS), "outTicks": str(6 * TPS)}
    t = timeline(raw)
    assert t["playhead"] == 4.0
    assert t["inOut"] == {"in": 2.0, "out": 6.0}


def test_unset_marks_and_a_closed_sequence_say_nothing():
    end = sequence()["endTicks"]
    # Premiere reads an unset In as 0 and an unset Out as the end.
    assert "inOut" not in timeline({**sequence(), "inTicks": "0", "outTicks": end})
    # Only an Out: from the start.
    assert timeline({**sequence(), "inTicks": "0", "outTicks": str(5 * TPS)})["inOut"] == {
        "in": 0.0,
        "out": 5.0,
    }
    # Only an In (Out past the end or before the In): to the end.
    assert timeline({**sequence(), "inTicks": str(3 * TPS), "outTicks": "-1"})["inOut"] == {
        "in": 3.0,
        "out": 10.0,
    }
    closed = timeline({**sequence(), "isActive": False, "playheadTicks": str(TPS)})
    assert "playhead" not in closed
    # An older panel sends neither.
    assert "playhead" not in timeline(sequence()) and "inOut" not in timeline(sequence())


def test_premieres_own_readings_seen_live():
    """26.5.2, 2026-10-09: unset marks are both -400000 s; marks set with I and O at 59.94 fps."""
    unset = "-101606400000000000"
    raw = {**sequence(), "timebase": "4237833600", "endTicks": "158918760000000", "playheadTicks": "0"}
    assert "inOut" not in timeline({**raw, "inTicks": unset, "outTicks": unset})
    marked = timeline(
        {**raw, "playheadTicks": "61507916870400", "inTicks": "29995386220800", "outTicks": "61512154704000"}
    )
    assert marked["playhead"] == 242.142
    assert marked["inOut"] == {"in": 118.085, "out": 242.159}
