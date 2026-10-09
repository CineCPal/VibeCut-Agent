"""The `media-frames` command (PLAN.md, "Phase 13b"): frames of media files as JPEG images the model
can look at, alone or tiled into one labelled contact sheet.

request: {"shots": [{"path", "time" (seconds into the file), "label"?}] (1 to MAX_SHOTS),
          "sheet": true (default: one image of every shot) | false (one image per shot, at most MAX_SINGLE)}
result: {"images": [{"mime": "image/jpeg", "data" (base64), "width", "height"}],
         "frames": [{"index", "path", "time", "label", "ok", "message"?}]}

A frame is the file's own picture at that moment: no effects, grade or titles from the editor. A time
past the end of the file gives its last frame; a file with no picture is reported, and the sheet shows a
grey tile in its place.
"""

from __future__ import annotations

import base64
import io
import math
import os
import subprocess
from concurrent.futures import ThreadPoolExecutor
from typing import Any

from PIL import Image, ImageDraw, ImageFont

from vibecut_agent.broll import (
    ffprobe_util,  # noqa: F401 - imported for its side effect: Homebrew's ffmpeg on PATH
)
from vibecut_agent.protocol import Emitter, RequestError, require_absolute_paths

MAX_SHOTS = 12
MAX_SINGLE = 4
# The sheet's width: under the 1568 px a Claude image is scaled down to, and readable for Gemini.
SHEET_WIDTH = 1536
SINGLE_WIDTH = 1024
LABEL_HEIGHT = 30
GAP = 6
# Claude refuses an image over 5 MB of base64 (attachments.py keeps the same margin).
MAX_IMAGE_BYTES = 3_750_000
FFMPEG_TIMEOUT_S = 30.0
WORKERS = 4


def _number(value: Any, field: str) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)) or math.isnan(value):
        raise RequestError(f"{field} must be a number")
    return float(value)


def parse_shots(raw: Any) -> list[dict[str, Any]]:
    if not isinstance(raw, list) or not 1 <= len(raw) <= MAX_SHOTS:
        raise RequestError(f"shots must list 1 to {MAX_SHOTS} frames")
    shots = []
    for i, shot in enumerate(raw):
        if not isinstance(shot, dict):
            raise RequestError(f"shots[{i}] must be an object")
        path = shot.get("path")
        require_absolute_paths([path], "media file")
        time = _number(shot.get("time"), f"shots[{i}].time")
        if time < 0:
            raise RequestError(f"shots[{i}].time must be 0 or more")
        label = shot.get("label")
        shots.append({"path": str(path), "time": time, "label": str(label)[:80] if label else f"{time:.1f}s"})
    return shots


PAST_END = "past the end of the file: its last frame"


def grab(path: str, time: float, width: int) -> tuple[Image.Image, bool]:
    """One frame at `time` seconds, `width` px wide at most. ffmpeg seeks to the keyframe before
    `time` and decodes to it exactly (input seeking is frame-accurate since ffmpeg 2.1)."""
    if not os.path.isfile(path):
        raise RuntimeError("the file isn't there (is its drive attached?)")
    scale = f"scale='min({width},iw)':-2"

    def run(at: float, from_end: bool = False) -> bytes:
        seek = ["-sseof", "-1"] if from_end else ["-ss", f"{at:.3f}"]
        command = ["ffmpeg", "-v", "error", *seek, "-i", path, "-frames:v", "1", "-vf", scale]
        command += ["-f", "image2pipe", "-vcodec", "png", "-"]
        try:
            done = subprocess.run(command, capture_output=True, timeout=FFMPEG_TIMEOUT_S, check=False)
        except subprocess.TimeoutExpired:
            raise RuntimeError("ffmpeg took too long to read the frame") from None
        if done.returncode != 0:
            raise RuntimeError(
                done.stderr.decode(errors="ignore").strip()[-300:] or "ffmpeg couldn't read the frame"
            )
        return done.stdout

    data = run(time)
    past_end = not data
    if past_end:
        data = run(time, from_end=True)
    if not data:
        raise RuntimeError("the file has no picture")
    image = Image.open(io.BytesIO(data))
    image.load()
    return image.convert("RGB"), past_end


def _font(size: int) -> Any:
    try:
        return ImageFont.load_default(size=size)
    except TypeError:  # a Pillow without FreeType: the small bitmap font
        return ImageFont.load_default()


def _encode(image: Image.Image) -> dict[str, Any]:
    for quality in (82, 70, 55, 40):
        out = io.BytesIO()
        image.save(out, format="JPEG", quality=quality, optimize=True)
        if out.tell() <= MAX_IMAGE_BYTES:
            break
    return {
        "mime": "image/jpeg",
        "data": base64.b64encode(out.getvalue()).decode("ascii"),
        "width": image.width,
        "height": image.height,
    }


def _columns(count: int) -> int:
    return 1 if count == 1 else 2 if count in (2, 4) else 3 if count <= 9 else 4


def sheet(tiles: list[Image.Image | None], labels: list[str]) -> Image.Image:
    """The frames in reading order, each over its label. A missing frame is a grey tile."""
    columns = _columns(len(tiles))
    rows = -(-len(tiles) // columns)
    width = (SHEET_WIDTH - GAP * (columns - 1)) // columns
    shapes = [t.height / t.width for t in tiles if t is not None]
    height = round(width * (max(shapes) if shapes else 9 / 16))
    canvas = Image.new(
        "RGB",
        (columns * width + GAP * (columns - 1), rows * (height + LABEL_HEIGHT + GAP) - GAP),
        (18, 18, 18),
    )
    draw = ImageDraw.Draw(canvas)
    font = _font(18)
    for i, (tile, label) in enumerate(zip(tiles, labels)):
        x = (i % columns) * (width + GAP)
        y = (i // columns) * (height + LABEL_HEIGHT + GAP)
        if tile is None:
            draw.rectangle([x, y, x + width - 1, y + height - 1], fill=(70, 70, 70))
            draw.text((x + 10, y + 10), "no picture", fill=(220, 220, 220), font=font)
        else:
            fitted = tile.copy()
            fitted.thumbnail((width, height))
            canvas.paste(fitted, (x + (width - fitted.width) // 2, y + (height - fitted.height) // 2))
        draw.text((x + 6, y + height + 5), f"{i + 1}. {label}", fill=(235, 235, 235), font=font)
    return canvas


def run(request: dict[str, Any], emitter: Emitter) -> int:
    shots = parse_shots(request.get("shots"))
    as_sheet = request.get("sheet", True)
    if not isinstance(as_sheet, bool):
        raise RequestError("sheet must be true or false")
    if not as_sheet and len(shots) > MAX_SINGLE:
        raise RequestError(f"At most {MAX_SINGLE} frames as separate images; use a sheet for more")
    width = (SHEET_WIDTH // _columns(len(shots))) if as_sheet else SINGLE_WIDTH
    emitter.progress(0, len(shots), phase="reading frames", detail="")

    def one(shot: dict[str, Any]) -> tuple[Image.Image, bool] | str:
        try:
            return grab(shot["path"], shot["time"], width)
        except Exception as exc:  # noqa: BLE001 - one unreadable frame is reported, the rest still shown
            return str(exc)

    with ThreadPoolExecutor(max_workers=WORKERS) as pool:
        grabbed = list(pool.map(one, shots))
    frames = []
    for i, (shot, got) in enumerate(zip(shots, grabbed)):
        frame: dict[str, Any] = {
            "index": i + 1,
            "path": shot["path"],
            "time": shot["time"],
            "label": shot["label"],
            "ok": not isinstance(got, str),
        }
        if isinstance(got, str):
            frame["message"] = got
        elif got[1]:
            frame["message"] = PAST_END
        frames.append(frame)
    pictures = [None if isinstance(g, str) else g[0] for g in grabbed]
    if not any(pictures):
        emitter.emit("result", images=[], frames=frames)
        return 1
    if as_sheet:
        images = [_encode(sheet(pictures, [s["label"] for s in shots]))]
    else:
        images = [_encode(p) for p in pictures if p is not None]
    emitter.progress(len(shots), len(shots), phase="done", detail="")
    emitter.emit("result", images=images, frames=frames)
    return 0
