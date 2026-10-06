"""Ported from VibeCut's host-premiere tests (PLAN.md, "Phase 6b")."""

from __future__ import annotations

import xml.etree.ElementTree as ET

import pytest

from tests.nle import compat
from tests.nle.vibecut_premiere.premiere_fakes import TB_25, FakeRequests, info, sequence
from vibecut_agent.nle import premiere_rebuild
from vibecut_agent.nle.premiere import HostError, PremiereHost, timeline
from vibecut_agent.nle.premiere_rebuild import default_name, unique_name, validate_tracks


def run_command(host, command, args):
    """VibeCut's run_command; `rebuild` gets the imports folder the watcher gives it (watch.py)."""
    if command == "rebuild":
        return premiere_rebuild.rebuild(host, args, host.imports)
    return compat.run_command(host, command, args)


class FakeProbe:
    def __init__(self, stereo: set[str]) -> None:
        self.stereo = stereo

    def video(self, path):
        return None if path.endswith(".wav") else {"width": 1280, "height": 720, "par_num": 1, "par_den": 1}

    def audio(self, path):
        return {"channels": 2 if path in self.stereo else 1, "sample_rate": 48000}

    def timecode(self, path):
        return None if path.endswith(".wav") else {"seconds": 0.0, "duration": 30.0}


@pytest.fixture
def media(tmp_path):
    a = tmp_path / "A.mov"
    roll = tmp_path / "ROLL.wav"
    a.write_bytes(b"")
    roll.write_bytes(b"")
    return str(a), str(roll)


def clip(path, start, source_in, length, **extra):
    return {
        "sourcePath": path,
        "sourceName": path.rsplit("/", 1)[-1],
        "startTimeSeconds": start,
        "sourceInSeconds": source_in,
        "sourceOutSeconds": source_in + length,
        "hasAudio": False,
        "volume": 1,
        **extra,
    }


def rebuild_host(tmp_path, imported_name=None):
    seen = {}

    def import_sequence(args):
        seen["xml"] = open(args["path"], encoding="utf-8").read()
        seen["args"] = args
        return {"name": imported_name or args["name"], "sequences": 1}

    requests = FakeRequests({
        "status": {"sequences": ["Main", "Main (VibeCut 1)"], "activeSequence": "Main"},
        "sequence_info": info(TB_25, 10),
        "import_sequence": import_sequence,
        "add_markers": lambda args: {"added": [{"id": f"g{i}", "name": m["name"], "comments": "", "startTicks": m["ticks"], "endTicks": m["ticks"], "colorIndex": m["colorIndex"]} for i, m in enumerate(args["markers"])], "alreadyThere": [], "refusedAt": []},
    })  # fmt: skip
    host = PremiereHost(requests)
    host.imports = tmp_path / "imports"
    return host, requests, seen


def test_names():
    assert default_name("Main", {"Main", "Main (VibeCut 1)"}) == "Main (VibeCut 2)"
    assert default_name("Main (VibeCut 2)", {"Main (VibeCut 2)"}) == "Main (VibeCut 1)"
    assert unique_name("Story", {"Story", "Story 2"}) == "Story 3"


def test_a_rebuild_imports_premiere_xml_names_it_and_adds_the_markers(tmp_path, media, monkeypatch):
    a, roll = media

    monkeypatch.setattr(premiere_rebuild, "Probe", lambda: FakeProbe({a}))
    host, requests, seen = rebuild_host(tmp_path)
    tracks = [
        # Bottom to top: A2, A1 (A.mov's right and left channels), ROLL on A3 below them, then V1.
        {"type": "audio", "clips": [clip(roll, 0, 0, 3)]},
        {
            "type": "audio",
            "clips": [clip(a, 0, 2, 3, linkGroup="g@0", audioChannels=[2])],
        },
        {
            "type": "audio",
            "clips": [clip(a, 0, 2, 3, linkGroup="g@0", audioChannels=[1], volume=0.5)],
        },
        {"type": "video", "clips": [clip(a, 0, 2, 3, linkGroup="g@0")]},
    ]
    markers = [
        {"time": 1, "name": "Hook", "color": "Yellow", "note": "n"},
        {"time": 1.5, "name": "Resolve colour", "color": "Lavender"},
        {"time": 99, "name": "late"},
    ]
    result = run_command(host, "rebuild", {"timeline": "Main", "tracks": tracks, "markers": markers})

    assert result["timeline"] == "Main (VibeCut 2)" and result["clips"] == 4 and result["markersAdded"] == 2
    assert seen["args"]["bin"] == "VibeCut" and seen["args"]["name"] == "Main (VibeCut 2)"
    assert list((tmp_path / "imports").iterdir()) == [], "the XML is removed once imported"
    root = ET.fromstring(seen["xml"])
    assert root.find("sequence/name").text == "Main (VibeCut 2)"
    # One XMEML track per written channel: A.mov's two channels and ROLL's one, not A.mov twice over.
    assert len(root.findall("sequence/media/audio/track")) == 3
    assert len(root.findall("sequence/media/video/track")) == 1
    sent = requests.sent("add_markers")[0]
    assert sent["timeline"] == "Main (VibeCut 2)"
    assert [m["colorIndex"] for m in sent["markers"]] == [4, 0], (
        "an unknown colour is Green, a late marker is left out"
    )
    assert any("ROLL.wav" in w for w in result["warnings"])


def test_a_bad_track_is_refused_before_anything_is_imported(tmp_path, media):
    host, requests, _ = rebuild_host(tmp_path)
    with pytest.raises(HostError, match="not a file on this computer"):
        run_command(
            host,
            "rebuild",
            {
                "timeline": "Main",
                "tracks": [{"type": "video", "clips": [clip("/nope/x.mov", 0, 0, 1)]}],
            },
        )
    with pytest.raises(HostError, match="audioChannels"):
        run_command(
            host,
            "rebuild",
            {
                "timeline": "Main",
                "tracks": [
                    {
                        "type": "audio",
                        "clips": [clip(media[0], 0, 0, 1, audioChannels=[0])],
                    }
                ],
            },
        )
    assert requests.sent("import_sequence") == []


def test_audio_clips_of_one_recording_on_several_tracks_are_its_channels():
    raw = sequence()
    second = dict(raw["audio"][0]["clips"][0], id="a2a")
    raw["audio"].append({"name": "Audio 2", "muted": False, "clips": [second], "transitions": []})
    raw["audio"].append(
        {
            "name": "Audio 3",
            "muted": False,
            "clips": [dict(second, id="a3a", startTicks="0", inTicks="0")],
            "transitions": [],
        }
    )
    a1, a2, a3 = (t["clips"][0] for t in timeline(raw)["tracks"] if t["type"] == "audio")
    assert (a1["channel"], a2["channel"]) == (1, 2)
    assert "channel" not in a3, "a different source point is another recording"


def test_validate_tracks_carries_fades_and_transitions(media):
    # A timeline pulled into VibeCut and sent back (PLAN.md, phase 5) keeps VibeCut's fades and
    # dissolves, alongside the channels it already kept; a malformed one is dropped, not refused.
    (track,) = validate_tracks(
        [
            {
                "type": "audio",
                "clips": [
                    clip(
                        media[1],
                        0,
                        0,
                        2,
                        fadeOutSeconds=0.25,
                        audioChannels=[2],
                        transitionOut={"kind": "dipToBlack", "seconds": 0.5},
                    ),
                    clip(media[1], 2, 2, 2, fadeInSeconds=True),
                ],
            }
        ]
    )
    first, second = track["clips"]
    assert first["fade_out_seconds"] == 0.25
    assert first["audio_channels"] == [2]
    assert first["transition_out"] == {"kind": "dipToBlack", "seconds": 0.5}
    assert "fade_in_seconds" not in second
