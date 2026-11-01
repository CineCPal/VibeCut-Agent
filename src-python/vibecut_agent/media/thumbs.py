"""The `media-thumbs` command (PLAN.md, "Phase 20d"): YouTube thumbnails. It scores frames of the media
under an edit as thumbnail candidates, and turns the stills exported from the editor into the JPEGs
YouTube takes.

request: {"frames": [{"path", "time" (seconds into the file)}] (1 to MAX_FRAMES)}
result:  {"frames": [{"index", "path", "time", "ok": true, "score", "sharpness", "exposure", "colour",
                      "brightness", "dark"} | {"index", "path", "time", "ok": false, "message"}]}

request: {"youtube": [absolute .png or .jpg paths of stills] (1 to MAX_STILLS)}
result:  {"jpegs": [{"from", "path", "width", "height", "bytes"}]}

Scores are 0-100. Sharpness and exposure are the B-roll analyser's (variance of the Laplacian; mid-grey
brightness without clipping), on a frame SCORE_WIDTH px wide; colourfulness is Hasler and Süsstrunk's,
scaled so a vivid frame scores near 100. A near-black frame (a fade, a black card) is `dark` and scores
0. The frames are the files' own pictures (no grade or titles): the editor's own frames are what
`export_thumbnails` exports.

A YouTube JPEG is the still cropped to 16:9 round its middle, scaled to 1280x720 (smaller stills keep
their size), and saved at the highest JPEG quality that keeps it under YouTube's 2 MB, next to the
still as "<still> YouTube.jpg" (a name never reused).
"""

from __future__ import annotations

import os
from concurrent.futures import ThreadPoolExecutor
from typing import Any

import cv2
import numpy as np
from PIL import Image

from vibecut_agent.broll.analyzer import _exposure_score, _sharpness_score
from vibecut_agent.media.frames import grab
from vibecut_agent.protocol import Emitter, RequestError, require_absolute_paths

MAX_FRAMES = 60
MAX_STILLS = 12
SCORE_WIDTH = 640
WORKERS = 4
# Mean brightness (0-1) under which a frame is a fade or a black card.
DARK = 0.06
WEIGHTS = {"sharpness": 0.45, "exposure": 0.35, "colour": 0.20}
# Hasler and Süsstrunk's colourfulness of a vivid frame (0-255 values).
VIVID = 80.0
YOUTUBE_SIZE = (1280, 720)
YOUTUBE_MAX_BYTES = 2 * 1024 * 1024
QUALITIES = (92, 88, 84, 80, 75, 70, 60)


def colourfulness(rgb: np.ndarray) -> float:
    """Hasler and Süsstrunk's colourfulness (0-255 values)."""
    r, g, b = (rgb[..., i].astype(np.float64) for i in range(3))
    rg, yb = r - g, 0.5 * (r + g) - b
    return float(np.sqrt(rg.std() ** 2 + yb.std() ** 2) + 0.3 * np.sqrt(rg.mean() ** 2 + yb.mean() ** 2))


def score_image(image: Image.Image) -> dict[str, Any]:
    """A frame's thumbnail scores (0-100 each) and its weighted score."""
    rgb = np.asarray(image.convert("RGB"))
    gray = cv2.cvtColor(rgb, cv2.COLOR_RGB2GRAY)
    brightness = float(gray.mean()) / 255
    scores = {
        "sharpness": round(float(_sharpness_score(gray)), 1),  # type: ignore[no-untyped-call]
        "exposure": round(float(_exposure_score(gray)), 1),  # type: ignore[no-untyped-call]
        "colour": round(min(colourfulness(rgb) / VIVID, 1.0) * 100, 1),
    }
    dark = brightness < DARK
    score = 0.0 if dark else sum(scores[k] * w for k, w in WEIGHTS.items())
    return {"score": round(score, 1), **scores, "brightness": round(brightness, 3), "dark": dark}


def _one(index: int, path: str, time: float) -> dict[str, Any]:
    base = {"index": index, "path": path, "time": time}
    try:
        image, _past_end = grab(path, time, SCORE_WIDTH)
    except RuntimeError as exc:
        return {**base, "ok": False, "message": str(exc)}
    return {**base, "ok": True, **score_image(image)}


def _frames(raw: Any) -> list[tuple[str, float]]:
    if not isinstance(raw, list) or not 1 <= len(raw) <= MAX_FRAMES:
        raise RequestError(f"frames must list 1 to {MAX_FRAMES} moments of media files")
    out = []
    for i, frame in enumerate(raw):
        if not isinstance(frame, dict):
            raise RequestError(f"frames[{i}] must be {{path, time}}")
        time = frame.get("time")
        if not isinstance(time, (int, float)) or isinstance(time, bool) or time < 0:
            raise RequestError(f"frames[{i}].time must be seconds into the file")
        out.append((frame.get("path"), float(time)))
    require_absolute_paths([p for p, _t in out], "media file")
    return [(str(p), t) for p, t in out]


def youtube_jpeg(still: str) -> dict[str, Any]:
    """`still` as YouTube's thumbnail JPEG, beside it."""
    with Image.open(still) as opened:
        image = opened.convert("RGB")
    width, height = image.size
    want = YOUTUBE_SIZE[0] / YOUTUBE_SIZE[1]
    if width / height > want + 1e-3:
        crop = round(height * want)
        image = image.crop(((width - crop) // 2, 0, (width - crop) // 2 + crop, height))
    elif width / height < want - 1e-3:
        crop = round(width / want)
        image = image.crop((0, (height - crop) // 2, width, (height - crop) // 2 + crop))
    if image.size[0] > YOUTUBE_SIZE[0]:
        image = image.resize(YOUTUBE_SIZE, Image.Resampling.LANCZOS)
    stem = os.path.splitext(still)[0] + " YouTube"
    path, n = stem + ".jpg", 1
    while os.path.exists(path):
        n += 1
        path = f"{stem} {n}.jpg"
    for quality in QUALITIES:
        image.save(path, "JPEG", quality=quality, optimize=True, progressive=True)
        if os.path.getsize(path) <= YOUTUBE_MAX_BYTES:
            break
    return {
        "from": still,
        "path": path,
        "width": image.size[0],
        "height": image.size[1],
        "bytes": os.path.getsize(path),
    }


def run(request: dict[str, Any], emitter: Emitter) -> int:
    stills = request.get("youtube")
    if stills is not None:
        if not isinstance(stills, list) or not 1 <= len(stills) <= MAX_STILLS:
            raise RequestError(f"youtube must list 1 to {MAX_STILLS} stills")
        require_absolute_paths(stills, "still")
        missing = [s for s in stills if not os.path.isfile(s)]
        if missing:
            emitter.error(f"The still isn't there: {missing[0]}")
            return 1
        try:
            jpegs = [youtube_jpeg(str(s)) for s in stills]
        except OSError as exc:
            emitter.error(f"Couldn't make the YouTube JPEG: {exc}")
            return 1
        emitter.emit("result", jpegs=jpegs)
        return 0
    frames = _frames(request.get("frames"))
    emitter.progress(0, len(frames), phase="scoring", detail="")
    with ThreadPoolExecutor(max_workers=WORKERS) as pool:
        scored = list(pool.map(lambda item: _one(item[0], *item[1]), enumerate(frames)))
    if not any(f["ok"] for f in scored):
        emitter.error(next((f["message"] for f in scored if not f["ok"]), "No frame could be read"))
        return 1
    emitter.progress(len(frames), len(frames), phase="done", detail="")
    emitter.emit("result", frames=scored)
    return 0
