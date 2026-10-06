"""tests/test_resolve_pool.py -- read-only Media Pool awareness: bins, clip summaries (from
GetClipProperty and GetMetadata, as Resolve 21.1 returns them), clip details, search and selection."""

import pytest

from tests.nle.compat import run_command
from tests.nle.vibecut_resolve.resolve_fakes import FakeProject, FakeResolve, FakeTimeline
from vibecut_agent.nle.errors import HostError
from vibecut_agent.nle.resolve import ResolveHost


class PoolItem:
    def __init__(self, uid, name, props=None, metadata=None, markers=None):
        self.uid, self.name = uid, name
        self.props = {
            "Clip Name": name,
            "Type": "Video + Audio",
            "FPS": 25.0,
            "Frames": "750",
            "Start TC": "01:00:00:00",
            "Usage": "0",
            "Online Status": "Online",
            **(props or {}),
        }
        self.metadata, self.markers = metadata or {}, markers or {}

    def GetUniqueId(self):
        return self.uid

    def GetName(self):
        return self.name

    def GetClipProperty(self, key=None):
        return self.props if key is None else self.props.get(key)

    def GetMetadata(self):
        return dict(self.metadata)

    def GetMarkers(self):
        return dict(self.markers)


class Bin:
    def __init__(self, name, clips=(), subs=()):
        self.name, self.clips, self.subs = name, list(clips), list(subs)

    def GetName(self):
        return self.name

    def GetClipList(self):
        return self.clips

    def GetSubFolderList(self):
        return self.subs


class Pool:
    def __init__(self, root, selected=()):
        self.root, self.selected = root, list(selected)

    def GetRootFolder(self):
        return self.root

    def GetSelectedClips(self):
        return self.selected


class TimelineWithSelection(FakeTimeline):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.selected, self.under = [], None

    def GetSelectedClips(self):
        return self.selected

    def GetCurrentVideoItem(self):
        return self.under


class Item:
    def __init__(self, uid):
        self.uid = uid

    def GetUniqueId(self):
        return self.uid


@pytest.fixture
def pool_host():
    interview = PoolItem(
        "p-a",
        "A.mov",
        {"Resolution": "1920x1080", "File Path": "/m/A.mov", "Usage": "2"},
    )
    roll = PoolItem(
        "p-r",
        "ROLL.wav",
        {
            "Type": "Audio",
            "Frames": "",
            "Duration": "00:00:30:00",
            "File Path": "/m/ROLL.wav",
        },
    )
    city = PoolItem(
        "p-b", "City.mov",
        {"File Path": "/m/City.mov", "Clip Color": "Orange", "Flags": "Green, Red", "In": "01:00:01:00", "Out": "01:00:04:00"},
        metadata={"Keywords": "city,night", "Comments": "nice pan", "Scene": "3", "Description": ""},
        markers={50: {"name": "Best bit", "color": "Red", "note": "pan starts", "duration": 1}},
    )  # fmt: skip
    offline = PoolItem("p-o", "Lost.mov", {"Online Status": "Offline"})
    assembly = PoolItem("p-t", "Assembly", {"Type": "Timeline"})
    root = Bin(
        "Master",
        [assembly],
        [Bin("Footage", [interview, roll], [Bin("B-roll", [city, offline])])],
    )
    timeline = TimelineWithSelection("Assembly")
    project = FakeProject([timeline])
    project.pool = Pool(root, selected=[city])
    project.GetMediaPool = lambda: project.pool
    return ResolveHost(FakeResolve(project)), timeline


def test_read_media_pool_lists_bins_clips_and_timelines(pool_host):
    host, _ = pool_host
    pool = run_command(host, "read_media_pool", {})
    assert pool["bins"] == [
        {"path": "Master", "clips": 1},
        {"path": "Master/Footage", "clips": 2},
        {"path": "Master/Footage/B-roll", "clips": 2},
    ]
    assert pool["timelines"] == ["Assembly"] and pool["truncated"] is False
    by_name = {c["name"]: c for c in pool["clips"]}
    assert set(by_name) == {"A.mov", "ROLL.wav", "City.mov", "Lost.mov"}
    assert by_name["A.mov"] == {
        "id": "p-a", "name": "A.mov", "bin": "Master/Footage", "type": "Video + Audio", "duration": 30.0, "fps": 25.0,
        "resolution": "1920x1080", "filePath": "/m/A.mov", "usage": 2,
    }  # fmt: skip
    city = by_name["City.mov"]
    assert (city["clipColor"], city["flags"], city["markIn"], city["markOut"]) == (
        "Orange",
        ["Green", "Red"],
        1.0,
        3.0 + 1.0,
    )
    assert city["metadata"] == {
        "Keywords": "city,night",
        "Comments": "nice pan",
        "Scene": "3",
    }
    assert by_name["ROLL.wav"]["duration"] == 30.0  # from "Duration" when "Frames" is empty
    assert by_name["Lost.mov"]["offline"] is True


def test_selection_reports_the_pool_and_only_the_open_connected_timeline(pool_host):
    host, timeline = pool_host
    timeline.selected, timeline.under = [Item("t-1"), Item("t-2")], Item("t-1")
    assert run_command(host, "read_media_pool", {"timeline": "Assembly"})["selection"] == {
        "pool": ["p-b"],
        "timeline": ["t-1", "t-2"],
        "underPlayhead": "t-1",
    }
    assert run_command(host, "read_media_pool", {"timeline": "Other"})["selection"] == {
        "pool": ["p-b"],
        "timeline": [],
        "underPlayhead": None,
    }


def test_get_clip_info_adds_markers_and_logged_properties(pool_host):
    host, _ = pool_host
    info = run_command(host, "get_clip_info", {"clipId": "p-b"})
    assert info["markers"] == [
        {
            "time": 2.0,
            "name": "Best bit",
            "color": "Red",
            "note": "pan starts",
            "duration": 0.04,
        }
    ]
    assert (
        info["properties"]["Clip Color"] == "Orange" and "Usage" not in info["properties"]
    )  # "0" is left out
    with pytest.raises(HostError, match="no Media Pool clip"):
        run_command(host, "get_clip_info", {"clipId": "nope"})
    with pytest.raises(HostError, match="clipId"):
        run_command(host, "get_clip_info", {})


@pytest.mark.parametrize(
    ("query", "names"),
    [
        ({"keyword": "City"}, ["City.mov"]),
        ({"keyword": "cit"}, []),
        ({"text": "nice pan"}, ["City.mov"]),
        (
            {"text": "footage roll"},
            ["ROLL.wav", "City.mov", "Lost.mov"],
        ),  # bin names count: "Footage/B-roll"
        ({"clipColor": "orange"}, ["City.mov"]),
        ({"flag": "red"}, ["City.mov"]),
        ({"type": "audio"}, ["ROLL.wav"]),
        ({"type": "video + audio", "bin": "b-roll"}, ["City.mov", "Lost.mov"]),
        ({"unused": True}, ["ROLL.wav", "City.mov", "Lost.mov"]),
        ({"marked": True}, ["City.mov"]),
        ({}, ["A.mov", "ROLL.wav", "City.mov", "Lost.mov"]),
    ],
)
def test_search_media_pool(pool_host, query, names):
    host, _ = pool_host
    result = run_command(host, "search_media_pool", query)
    assert [c["name"] for c in result["clips"]] == names and result["total"] == len(names)


from vibecut_agent.nle import resolve_pool  # get_transcripts / transcribe_clips are registered in Phase 6b
from vibecut_agent.nle.resolve_pool import sentences

TRANSCRIPTION = {
    "language": "en",
    "segments": [
        {
            "start": "01:00:00:02",
            "end": "01:00:05:08",
            "speaker": "Speaker 1",
            "text": " So how did it start? (...) Well, it began at home",
            "words": [
                {"start": "01:00:00:02", "end": "01:00:00:07", "text": " So"},
                {"start": "01:00:00:08", "end": "01:00:01:00", "text": " how"},
                {"start": "01:00:01:00", "end": "01:00:01:10", "text": " did it"},
                {"start": "01:00:01:10", "end": "01:00:02:14", "text": " start?"},
                {"start": "01:00:02:14", "end": "01:00:02:18", "text": " (...)"},
                {"start": "01:00:02:18", "end": "01:00:03:04", "text": " Well,"},
                {
                    "start": "01:00:03:07",
                    "end": "01:00:05:08",
                    "text": " it began at home",
                },
            ],
        },
        {
            "start": "01:00:06:00",
            "end": "01:00:07:00",
            "speaker": None,
            "text": " No words listed.",
        },
        {
            "start": "01:00:08:00",
            "end": "01:00:09:00",
            "text": " (...)",
            "words": [{"start": "01:00:08:00", "end": "01:00:09:00", "text": " (...)"}],
        },
    ],
}


def test_sentences_split_long_segments_by_word_timing_and_count_from_the_clips_start():
    assert sentences(TRANSCRIPTION, "01:00:00:00", 25.0) == [
        {
            "start": 0.08,
            "end": 2.56,
            "text": "So how did it start?",
            "speaker": "Speaker 1",
        },
        {
            "start": 2.72,
            "end": 5.32,
            "text": "Well, it began at home",
            "speaker": "Speaker 1",
        },
        {"start": 6.0, "end": 7.0, "text": "No words listed.", "speaker": ""},
    ]
    assert sentences(None, "00:00:00:00", 25.0) == []


class Transcribable(PoolItem):
    def __init__(self, *args, transcription=None, refuse=False, **kwargs):
        super().__init__(*args, **kwargs)
        self.transcription, self.refuse, self.asked = transcription, refuse, []

    def GetTranscription(self):
        return self.transcription

    def TranscribeAudio(self, speakers):
        self.asked.append(speakers)
        if self.refuse:
            return False
        self.transcription = TRANSCRIPTION
        return True


@pytest.fixture
def speech_host():
    said = Transcribable("p-1", "INT1.mov", {"File Path": "/m/INT1.mov"}, transcription=TRANSCRIPTION)
    silent = Transcribable("p-2", "INT2.mov", {"File Path": "/m/INT2.mov"})
    broken = Transcribable("p-3", "Bad.mov", refuse=True)
    project = FakeProject([])
    project.pool = Pool(Bin("Master", [said, silent, broken]))
    project.GetMediaPool = lambda: project.pool
    return ResolveHost(FakeResolve(project)), silent, broken


def test_get_transcripts_says_which_clips_have_none(speech_host):
    host, _, _ = speech_host
    clips = resolve_pool.get_transcripts(host, {"clipIds": ["p-1", "p-2"]})["clips"]
    assert [(c["clipId"], c["transcribed"], len(c["segments"])) for c in clips] == [
        ("p-1", True, 3),
        ("p-2", False, 0),
    ]
    assert clips[0]["filePath"] == "/m/INT1.mov"
    with pytest.raises(HostError, match="clipIds"):
        resolve_pool.get_transcripts(host, {"clipIds": []})
    with pytest.raises(HostError, match="no Media Pool clip"):
        resolve_pool.get_transcripts(host, {"clipIds": ["gone"]})


def test_transcribe_clips_runs_resolves_transcription_and_reports_failures(speech_host):
    host, silent, broken = speech_host
    result = resolve_pool.transcribe_clips(host, {"clipIds": ["p-2", "p-3", "p-2"]})
    assert result == {"transcribed": ["p-2"], "failed": ["p-3"]}
    assert silent.asked == [True] and broken.asked == [True]  # speakers detected unless asked not to
    resolve_pool.transcribe_clips(host, {"clipIds": ["p-2"], "speakers": False})
    assert silent.asked[-1] is False
