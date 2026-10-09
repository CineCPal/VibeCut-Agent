"""Where renders from a connected editor go, and the ffmpeg step after them (PLAN.md, "Phase 15b"),
ported from VibeCut's rcs_utils/host_renders.py (its "Phase 7c") without the stills helpers.

Shared by resolve_render.py (run with Resolve's own Python, so standard library only) and premiere_render.py:
- Every render and audio export goes into one folder per editor project,
  `~/Movies/VibeCut Renders/<project>/` (`VIBECUT_RENDERS_DIR` overrides the first part, for tests).
  The frontend never sends a path; the sidecars build it here, and a name is never reused, so
  nothing is overwritten.
- ffmpeg (`VIBECUT_FFMPEG`, else the one on PATH, which Rust puts the usual tool folders on) takes
  the sound out of Resolve's WAV carrier file.
"""

from __future__ import annotations

import os
import re
import shutil
import subprocess

MAX_NAME = 80
FFMPEG_TIMEOUT_S = 300


class RenderError(Exception):
    """A render step that couldn't be carried out; the message is shown to the user and the agent."""


def renders_root() -> str:
    custom = os.environ.get("VIBECUT_RENDERS_DIR")
    if custom:
        return os.path.abspath(custom)
    return os.path.join(os.path.expanduser("~"), "Movies", "VibeCut Renders")


def safe_name(text: object, fallback: str = "Render") -> str:
    """A file or folder name from an editor's project or timeline name, or the agent's `name`: no
    path separators, colons, control characters or leading dots, at most MAX_NAME characters."""
    name = re.sub(r"[\x00-\x1f/\\:]+", " ", str(text or ""))
    name = re.sub(r"\s+", " ", name).strip().lstrip(".").strip()
    return name[:MAX_NAME].rstrip() or fallback


def project_folder(project: object) -> str:
    folder = os.path.join(renders_root(), safe_name(project, "Untitled project"))
    os.makedirs(folder, exist_ok=True)
    return folder


def unique_stem(folder: str, stem: str, extensions: tuple[str, ...]) -> str:
    """`stem`, else "stem 2", "stem 3", …: the first that has no file with any of `extensions` in
    `folder` (a render may also leave a carrier file under another extension)."""
    n = 1
    while True:
        candidate = stem if n == 1 else f"{stem} {n}"
        if not any(
            os.path.exists(os.path.join(folder, candidate + ext)) for ext in extensions
        ):
            return candidate
        n += 1


def output_stem(
    project: object, timeline: object, name: object, extensions: tuple[str, ...]
) -> tuple[str, str]:
    """(folder, stem) for a new render of `timeline`: "<timeline>" or "<timeline> - <name>"."""
    folder = project_folder(project)
    stem = safe_name(timeline, "Timeline")
    if name is not None and str(name).strip():
        stem = f"{stem} - {safe_name(name)}"
    return folder, unique_stem(folder, stem, extensions)


def inside(path: str, folder: str) -> bool:
    real = os.path.realpath(path)
    root = os.path.realpath(folder)
    return real.startswith(root + os.sep)


def remove_quietly(path: str | None) -> None:
    if not path:
        return
    try:
        os.remove(path)
    except OSError:
        pass


def ffmpeg() -> str:
    custom = os.environ.get("VIBECUT_FFMPEG")
    if custom:
        return custom
    found = shutil.which("ffmpeg")
    if not found:
        raise RenderError(
            "ffmpeg not found. Install ffmpeg (brew install ffmpeg) or set VIBECUT_FFMPEG"
        )
    return found


def _run(args: list[str], what: str) -> None:
    try:
        done = subprocess.run(
            [ffmpeg(), "-v", "error", "-nostdin", "-y", *args],
            capture_output=True,
            text=True,
            timeout=FFMPEG_TIMEOUT_S,
            check=False,
        )
    except (OSError, subprocess.TimeoutExpired) as exc:
        raise RenderError(f"ffmpeg couldn't {what}: {exc}") from exc
    if done.returncode != 0:
        detail = (done.stderr or "").strip().splitlines()
        raise RenderError(
            f"ffmpeg couldn't {what}: {detail[-1] if detail else 'exit ' + str(done.returncode)}"
        )


def extract_wav(carrier: str, wav: str) -> None:
    """The sound of `carrier` (Resolve's movie with uncompressed sound) as a WAV, copied, not
    re-encoded. The carrier is removed either way."""
    try:
        _run(
            ["-i", carrier, "-vn", "-map", "0:a:0", "-c:a", "copy", wav],
            "take the sound out of the render",
        )
    except RenderError:
        remove_quietly(wav)
        raise
    finally:
        remove_quietly(carrier)
