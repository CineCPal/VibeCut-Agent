"""Resolve test doubles from VibeCut's test_resolve_host.py and test_resolve_pool.py, verbatim."""

from __future__ import annotations

START = 86400  # 01:00:00:00 at 24 fps


class FakeMedia:
    def __init__(self, path):
        self.path = path

    def GetClipProperty(self, key):
        return self.path if key == "File Path" else None


class FakeItem:
    def __init__(self, uid, name, start, end, left=0, path="/m/a.mov", enabled=True, volume=None):
        self.uid, self.name, self.start, self.end, self.left = (
            uid,
            name,
            start,
            end,
            left,
        )
        self.media = FakeMedia(path) if path else None
        self.enabled, self.volume, self.linked = enabled, volume, []
        self.speed, self.fusion = 1.0, 0

    def GetSpeed(self):
        return {"Percentage": self.speed * 100, "PitchCorrection": True}

    def GetFusionCompCount(self):
        return self.fusion

    def GetUniqueId(self):
        return self.uid

    def GetName(self):
        return self.name

    def GetStart(self, subframe=False):
        return float(self.start)

    def GetEnd(self, subframe=False):
        return float(self.end)

    def GetLeftOffset(self, subframe=False):
        return None if self.left is None else float(self.left)

    def GetClipEnabled(self):
        return self.enabled

    def GetMediaPoolItem(self):
        return self.media

    def GetProperty(self):
        return {} if self.volume is None else {"AudioVolume": self.volume}

    def GetLinkedItems(self):
        return self.linked


class FakeTimeline:
    def __init__(self, name, fps="24", length=2400):
        self.name, self.fps, self.length = name, fps, length
        self.tracks = {"video": [[]], "audio": [[]], "subtitle": []}
        self.markers = {}
        self.timecode = "01:00:00:00"
        self.refuse_markers = False
        self.is_open = True

    def GetName(self):
        return self.name

    def GetSetting(self, key):
        return self.fps if key == "timelineFrameRate" else ""

    def GetStartFrame(self):
        return START

    def GetEndFrame(self):
        return START + self.length

    def GetStartTimecode(self):
        return "01:00:00:00"

    def GetTrackCount(self, kind):
        return len(self.tracks[kind])

    def GetItemListInTrack(self, kind, index):
        return self.tracks[kind][index - 1]

    def GetTrackName(self, kind, index):
        return f"{kind[0].upper()}{index}"

    def GetIsTrackEnabled(self, kind, index):
        # Resolve 21.1 says False for every track of a timeline that isn't open.
        return self.is_open

    def GetMarkers(self):
        return dict(self.markers)

    def AddMarker(self, frame, color, name, note, duration, custom=""):
        # Resolve 21.1 refuses an unnamed marker, and one on a frame that already has one.
        if self.refuse_markers or not name or frame in self.markers:
            return False
        self.markers[frame] = {
            "color": color,
            "name": name,
            "note": note,
            "duration": duration,
            "customData": custom,
        }
        return True

    def DeleteMarkerAtFrame(self, frame):
        return self.markers.pop(frame, None) is not None

    def GetCurrentTimecode(self):
        return self.timecode

    def SetCurrentTimecode(self, timecode):
        self.timecode = timecode
        return True


class FakeProject:
    def __init__(self, timelines):
        self.timelines = timelines
        self.current = timelines[0] if timelines else None

    def GetName(self):
        return "Doc"

    def GetTimelineCount(self):
        return len(self.timelines)

    def GetTimelineByIndex(self, i):
        return self.timelines[i - 1]

    def GetCurrentTimeline(self):
        return self.current

    def SetCurrentTimeline(self, timeline):
        self.current = timeline
        return True


class FakeResolve:
    def __init__(self, project):
        self.project = project

    def GetProjectManager(self):
        return self

    def GetCurrentProject(self):
        return self.project

    def GetProductName(self):
        return "DaVinci Resolve Studio"

    def GetVersionString(self):
        return "21.1.0.17"


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
