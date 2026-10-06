"""VibeCut's ``run_command(host, command, args)``, which its edit tests call, over this package's hosts
and call tables (edits.py, media.py, project.py)."""

from typing import Any

from vibecut_agent.nle.edits import premiere_edits, resolve_edits
from vibecut_agent.nle.media import premiere_media, resolve_media
from vibecut_agent.nle.premiere import PremiereHost
from vibecut_agent.nle.project import premiere_project, resolve_project


def run_command(host: Any, command: str, args: Any) -> Any:
    if isinstance(host, PremiereHost):
        edits = {**premiere_edits(), **premiere_media(), **premiere_project()}
    else:
        edits = {**resolve_edits(), **resolve_media(), **resolve_project()}
    if command in edits:
        return edits[command](host, args)
    return getattr(host, command)(args)
