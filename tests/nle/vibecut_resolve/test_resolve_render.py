"""Renders through Resolve's Deliver queue (PLAN.md, "Phase 15b"), VibeCut's test_resolve_render.py
ported with resolve_render.py (its "Phase 7c"), without the stills test. The
fake behaves as Resolve 21.1 did in the 7c.0 probe: settings carry over from job to job, MarkIn and
MarkOut set the timeline's own marks, adding a job opens the Deliver page, a job can't be added with
no target folder, WAV can't be chosen, and StopRendering leaves the partial file."""

import os

import pytest

from tests.nle.compat import run_command
from tests.nle.vibecut_resolve.resolve_fakes import START, FakeProject, FakeResolve, FakeTimeline
from vibecut_agent.nle import resolve_render
from vibecut_agent.nle.errors import HostError
from vibecut_agent.nle.resolve import ResolveHost


class RenderTimeline(FakeTimeline):
    def __init__(self, name, **kw):
        super().__init__(name, **kw)
        self.marks = {"video": {}, "audio": {}}

    def GetSetting(self, key):
        return {
            "timelineFrameRate": self.fps,
            "timelineResolutionWidth": "3840",
            "timelineResolutionHeight": "2160",
        }.get(key, "")

    def GetMarkInOut(self):
        return {k: dict(v) for k, v in self.marks.items()}

    def SetMarkInOut(self, first, last, kind="all"):
        for k in ("video", "audio") if kind == "all" else (kind,):
            self.marks[k] = {"in": first, "out": last}
        return True

    def ClearMarkInOut(self, kind="all"):
        for k in ("video", "audio") if kind == "all" else (kind,):
            self.marks[k] = {}
        return True


class RenderProject(FakeProject):
    def __init__(self, timelines, resolve_page):
        super().__init__(timelines)
        self.page = resolve_page
        self.format = {"format": "mov", "codec": "H264"}
        self.settings = {
            "TargetDir": "/Users/me/Renders",
            "ExportVideo": True,
            "ExportAudio": True,
            "AudioCodec": "lpcm",
            "FormatWidth": 3840,
        }
        self.jobs = {}
        self.presets = {}
        self.added = 0

    def GetName(self):
        return "Doc/Final"

    def SetCurrentRenderFormatAndCodec(self, fmt, codec):
        if fmt == "wav":
            return False
        self.format = {"format": fmt, "codec": codec}
        return True

    def GetCurrentRenderFormatAndCodec(self):
        return dict(self.format)

    def SetRenderSettings(self, settings):
        if settings.get("TargetDir") == "":
            return False
        self.settings.update(settings)
        for key, mark in (("MarkIn", "in"), ("MarkOut", "out")):
            if key in settings:
                for kind in ("video", "audio"):
                    self.current.marks[kind][mark] = settings[key] - START
        return True

    def SaveAsNewRenderPreset(self, name):
        kept = {k: v for k, v in self.settings.items() if k != "TargetDir"}
        self.presets[name] = (dict(self.format), kept)
        return True

    def LoadRenderPreset(self, name):
        fmt, kept = self.presets[name]
        self.format = dict(fmt)
        self.settings = {"TargetDir": self.settings.get("TargetDir"), **kept}
        return True

    def DeleteRenderPreset(self, name):
        return self.presets.pop(name, None) is not None

    def AddRenderJob(self):
        self.page["now"] = "deliver"
        if not self.settings.get("TargetDir"):
            return ""
        self.added += 1
        job = f"job-{self.added}"
        ext = "." + self.format["format"]
        self.jobs[job] = {
            "JobId": job,
            "TimelineName": self.current.GetName(),
            "TargetDir": self.settings["TargetDir"],
            "OutputFilename": (
                self.settings.get("CustomName") or self.current.GetName()
            )
            + ext,
            "settings": dict(self.settings),
            "format": dict(self.format),
            "status": "Ready",
        }
        return job

    def GetRenderJobList(self):
        return [
            {k: v for k, v in j.items() if k not in ("settings", "format", "status")}
            for j in self.jobs.values()
        ]

    def DeleteRenderJob(self, job):
        return self.jobs.pop(job, None) is not None

    def StartRendering(self, jobs, interactive):
        for job in jobs:
            j = self.jobs[job]
            if (
                not j["settings"].get("ExportVideo")
                and j["settings"].get("AudioCodec") == "lpcm"
            ):
                return False
            j["status"] = "Rendering"
        return True

    def IsRenderingInProgress(self):
        return any(j["status"] == "Rendering" for j in self.jobs.values())

    def GetRenderJobStatus(self, job):
        j = self.jobs.get(job)
        if not j:
            return {}
        if j["status"] == "Rendering":
            return {
                "JobStatus": "Rendering",
                "CompletionPercentage": 40,
                "EstimatedTimeRemainingInMs": 3000,
            }
        return {
            "JobStatus": j["status"],
            "CompletionPercentage": 100 if j["status"] == "Complete" else 0,
        }

    def StopRendering(self):
        for j in self.jobs.values():
            if j["status"] == "Rendering":
                j["status"] = "Cancelled"
                self.write(j, "partial")

    def write(self, j, text="movie"):
        with open(os.path.join(j["TargetDir"], j["OutputFilename"]), "w") as f:
            f.write(text)

    def finish(self, job):
        self.jobs[job]["status"] = "Complete"
        self.write(self.jobs[job])


class RenderResolve(FakeResolve):
    def __init__(self, project):
        super().__init__(project)
        self.opened = []

    def GetCurrentPage(self):
        return self.project.page["now"]

    def OpenPage(self, page):
        self.opened.append(page)
        self.project.page["now"] = page
        return True


@pytest.fixture
def renders(tmp_path, monkeypatch):
    monkeypatch.setenv("VIBECUT_RENDERS_DIR", str(tmp_path / "renders"))
    resolve_render.JOBS.clear()
    return tmp_path / "renders"


@pytest.fixture
def setup(renders):
    timeline = RenderTimeline("Interview: cut 2", fps="25", length=500)
    project = RenderProject([timeline, RenderTimeline("Other")], {"now": "edit"})
    resolve = RenderResolve(project)
    return ResolveHost(resolve), resolve, project, timeline


def test_a_whole_render_sets_every_field_and_puts_everything_back(setup, renders):
    host, resolve, project, timeline = setup
    timeline.marks = {"video": {"in": 10, "out": 99}, "audio": {"in": 10, "out": 99}}
    started = run_command(
        host,
        "render_video",
        {"timeline": "Interview: cut 2", "preset": "1080p", "name": "client v1"},
    )
    job = started["jobId"]
    folder = renders / "Doc Final"
    assert started["path"] == str(folder / "Interview cut 2 - client v1.mp4")
    assert started["seconds"] == 20.0
    settings = project.jobs[job]["settings"]
    assert project.jobs[job]["format"] == {"format": "mp4", "codec": "H264"}
    assert (
        settings["TargetDir"] == str(folder)
        and settings["CustomName"] == "Interview cut 2 - client v1"
    )
    assert (
        settings["SelectAllFrames"],
        settings["ExportVideo"],
        settings["FormatWidth"],
        settings["FormatHeight"],
        settings["AudioCodec"],
    ) == (True, True, 1920, 1080, "aac")

    assert run_command(host, "render_status", {"jobId": job}) == {
        "state": "rendering",
        "seconds": 20.0,
        "fraction": 0.4,
        "etaSeconds": 3,
    }
    project.finish(job)
    done = run_command(host, "render_status", {"jobId": job})
    assert done == {"state": "done", "seconds": 20.0, "path": started["path"]}
    assert os.path.isfile(started["path"])
    # Taken off the queue; the Deliver settings, target folder, marks and page are back.
    assert project.jobs == {} and project.presets == {}
    assert project.format == {"format": "mov", "codec": "H264"}
    assert (
        project.settings["TargetDir"] == "/Users/me/Renders"
        and project.settings["FormatWidth"] == 3840
    )
    assert timeline.marks == {
        "video": {"in": 10, "out": 99},
        "audio": {"in": 10, "out": 99},
    }
    assert resolve.GetCurrentPage() == "edit"
    # A second render of the same name doesn't overwrite the first.
    again = run_command(
        host,
        "render_video",
        {"timeline": "Interview: cut 2", "preset": "1080p", "name": "client v1"},
    )
    assert again["path"] == str(folder / "Interview cut 2 - client v1 2.mp4")


def test_a_range_marks_the_frames_and_the_old_marks_come_back(setup):
    host, _resolve, project, timeline = setup
    started = run_command(
        host,
        "render_video",
        {
            "timeline": "Interview: cut 2",
            "preset": "source",
            "range": {"start": 5, "end": 10},
        },
    )
    settings = project.jobs[started["jobId"]]["settings"]
    assert (settings["SelectAllFrames"], settings["MarkIn"], settings["MarkOut"]) == (
        False,
        START + 125,
        START + 249,
    )
    assert (settings["FormatWidth"], settings["FormatHeight"]) == (3840, 2160)
    assert started["seconds"] == 5.0
    assert timeline.marks["video"] == {"in": 125, "out": 249}
    project.finish(started["jobId"])
    run_command(host, "render_status", {"jobId": started["jobId"]})
    assert timeline.marks == {"video": {}, "audio": {}}


def test_in_out_uses_the_timelines_marks(setup):
    host, _resolve, project, timeline = setup
    with pytest.raises(HostError, match="no In or Out marked"):
        run_command(
            host, "render_video", {"timeline": "Interview: cut 2", "range": "in_out"}
        )
    timeline.marks["video"] = {"in": 50}
    started = run_command(
        host, "render_video", {"timeline": "Interview: cut 2", "range": "in_out"}
    )
    settings = project.jobs[started["jobId"]]["settings"]
    assert (settings["MarkIn"], settings["MarkOut"]) == (START + 50, START + 499)


def test_bad_requests_are_refused_before_anything_changes(setup):
    host, _resolve, project, timeline = setup
    for args, message in (
        ({"preset": "4k"}, "preset must be one of"),
        ({"range": {"start": 15, "end": 25}}, "within the timeline"),
        ({"range": {"start": 5, "end": 5}}, "at least a frame"),
        ({"range": "middle"}, "range must be"),
    ):
        with pytest.raises(HostError, match=message):
            run_command(host, "render_video", {"timeline": "Interview: cut 2", **args})
    with pytest.raises(HostError, match="format must be one of"):
        run_command(
            host, "render_audio", {"timeline": "Interview: cut 2", "format": "flac"}
        )
    project.current = project.timelines[1]
    with pytest.raises(HostError, match="Open 'Interview: cut 2' in Resolve first"):
        run_command(host, "render_video", {"timeline": "Interview: cut 2"})
    assert project.jobs == {} and project.presets == {} and project.added == 0


def test_aac_is_an_m4a_without_picture(setup, renders):
    host, _resolve, project, _timeline = setup
    started = run_command(
        host, "render_audio", {"timeline": "Interview: cut 2", "format": "aac"}
    )
    settings = project.jobs[started["jobId"]]["settings"]
    assert (settings["ExportVideo"], settings["AudioCodec"]) == (False, "aac")
    assert started["path"].endswith("Interview cut 2.m4a")
    project.finish(started["jobId"])
    assert (
        run_command(host, "render_status", {"jobId": started["jobId"]})["state"]
        == "done"
    )
    assert sorted(os.listdir(renders / "Doc Final")) == ["Interview cut 2.m4a"]


def test_wav_comes_out_of_a_small_carrier_movie(setup, renders, monkeypatch):
    host, _resolve, project, _timeline = setup
    taken = []

    def fake_extract(carrier, wav):
        taken.append((os.path.basename(carrier), os.path.basename(wav)))
        with open(wav, "w") as f:
            f.write("wav")
        os.remove(carrier)

    monkeypatch.setattr(resolve_render, "extract_wav", fake_extract)
    started = run_command(
        host, "render_audio", {"timeline": "Interview: cut 2", "format": "wav"}
    )
    job = project.jobs[started["jobId"]]
    assert job["format"] == {"format": "mov", "codec": "ProRes422P"}
    assert (
        job["settings"]["FormatWidth"],
        job["settings"]["FormatHeight"],
        job["settings"]["AudioCodec"],
        job["settings"]["AudioBitDepth"],
    ) == (640, 360, "lpcm", 24)
    project.finish(started["jobId"])
    assert (
        run_command(host, "render_status", {"jobId": started["jobId"]})["path"]
        == started["path"]
    )
    assert taken == [("Interview cut 2.mov", "Interview cut 2.wav")]
    assert sorted(os.listdir(renders / "Doc Final")) == ["Interview cut 2.wav"]


def test_cancel_removes_the_partial_file_and_restores(setup, renders):
    host, resolve, project, _timeline = setup
    started = run_command(
        host, "render_video", {"timeline": "Interview: cut 2", "preset": "prores"}
    )
    assert project.jobs[started["jobId"]]["format"] == {
        "format": "mov",
        "codec": "ProRes422HQ",
    }
    assert resolve.GetCurrentPage() == "deliver"
    result = run_command(host, "cancel_render", {"jobId": started["jobId"]})
    assert result["state"] == "cancelled"
    assert os.listdir(renders / "Doc Final") == []
    assert project.jobs == {} and resolve.GetCurrentPage() == "edit"
    # Asking again gives the same answer, without touching Resolve.
    assert (
        run_command(host, "render_status", {"jobId": started["jobId"]})["state"]
        == "cancelled"
    )


def test_a_failed_render_is_reported_and_cleaned_up(setup, renders):
    host, _resolve, project, _timeline = setup
    started = run_command(host, "render_video", {"timeline": "Interview: cut 2"})
    project.jobs[started["jobId"]]["status"] = "Failed"
    project.write(project.jobs[started["jobId"]], "partial")
    result = run_command(host, "render_status", {"jobId": started["jobId"]})
    assert result["state"] == "failed" and result["error"] == "Resolve's render failed"
    assert os.listdir(renders / "Doc Final") == []
    with pytest.raises(HostError, match="no render with that jobId"):
        run_command(host, "render_status", {"jobId": "job-99"})


def test_a_project_with_no_target_folder_still_renders(setup):
    host, _resolve, project, _timeline = setup
    project.settings.pop("TargetDir")
    started = run_command(host, "render_video", {"timeline": "Interview: cut 2"})
    project.finish(started["jobId"])
    assert (
        run_command(host, "render_status", {"jobId": started["jobId"]})["state"]
        == "done"
    )


class SlowStopProject(RenderProject):
    """As 21.1 did live in 7c: StopRendering returns while the job still renders for a moment, and
    until it has stopped, deleting the job is refused."""

    def __init__(self, timelines, resolve_page):
        super().__init__(timelines, resolve_page)
        self.stopping = 0

    def StopRendering(self):
        self.stopping = 3

    def GetRenderJobStatus(self, job):
        if self.stopping:
            self.stopping -= 1
            if not self.stopping:
                super().StopRendering()
        return super().GetRenderJobStatus(job)

    def DeleteRenderJob(self, job):
        if self.stopping:
            return False
        return super().DeleteRenderJob(job)


def test_cancel_waits_for_resolve_to_stop_before_cleaning_up(renders, monkeypatch):
    monkeypatch.setattr(resolve_render, "STOP_POLL_S", 0)
    timeline = RenderTimeline("Interview", fps="25", length=500)
    project = SlowStopProject([timeline], {"now": "edit"})
    resolve = RenderResolve(project)
    host = ResolveHost(resolve)
    started = run_command(host, "render_video", {"timeline": "Interview"})
    assert (
        run_command(host, "cancel_render", {"jobId": started["jobId"]})["state"]
        == "cancelled"
    )
    assert project.jobs == {} and project.presets == {}
    assert resolve.GetCurrentPage() == "edit" and project.format == {
        "format": "mov",
        "codec": "H264",
    }
    assert os.listdir(renders / "Doc Final") == []
