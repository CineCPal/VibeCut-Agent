"""Helpers the Premiere edit modules share, copied out of VibeCut's premiere_rebuild.py so the edits
don't pull in its rebuild (XML) code."""

from __future__ import annotations

BIN_NAME = "VibeCut"


def unique_name(wanted: str, taken: set[str]) -> str:
    if wanted not in taken:
        return wanted
    n = 2
    while f"{wanted} {n}" in taken:
        n += 1
    return f"{wanted} {n}"


def estimated_audio_tracks(channels: int) -> int:
    """How many audio tracks a file's sound fills in Premiere when the project item can't be asked: one clip
    for mono or stereo (checked live: a stereo WAV, a stereo .mov and a .mov with two mono streams each laid
    one clip), and, not yet checked live, one per channel above that. premiere_edit.py asks the item when
    it can; the orchestrator's validator (otio_delta.py) plans before anything is imported, so it estimates."""
    return 0 if channels <= 0 else 1 if channels <= 2 else channels


class Probe:
    """ffprobe, for a file's picture and sound (how many channels a placed clip fills). Tests pass a fake."""

    def video(self, path: str) -> dict | None:  # type: ignore[type-arg]
        from vibecut_agent.broll.ffprobe_util import probe_video_dimensions

        return probe_video_dimensions(path)

    def audio(self, path: str) -> dict | None:  # type: ignore[type-arg]
        from vibecut_agent.broll.ffprobe_util import probe_audio_format

        return probe_audio_format(path)

    def timecode(self, path: str) -> dict | None:  # type: ignore[type-arg]
        from vibecut_agent.broll.ffprobe_util import probe_start_timecode

        return probe_start_timecode(path)
