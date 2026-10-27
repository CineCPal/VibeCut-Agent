"""The `media-titles` command (PLAN.md, "Phase 18d"): lower thirds rendered as short clips with alpha.

request: {"titles": [{"name", "title"?}] (1 to MAX_TITLES), "width", "height", "fps", "seconds"?,
          "fade"?, "look"? ("bar" | "clean"), "accent"? ("#rrggbb"), "position"? ("left" | "center"),
          "project"?}
result: {"files": [{"name", "title", "output", "reused"} | {"name", "error"}], "folder"}

Neither editor can place a title of its own from a script where it's wanted (Resolve's Text+ is a ripple
insert on V1; see "18d probe"), so each lower third is drawn with Pillow (this ffmpeg has no drawtext) and
encoded by ffmpeg as ProRes 4444 with alpha, its fade in and out baked into the alpha. Both editors lay it
over the picture like any clip (Resolve reads its alpha as Straight; checked live, 21.1).

Sizes follow the frame's short side, so a 9:16 version is as readable as 16:9; a vertical frame puts it
higher, clear of a social app's captions and buttons. Text too wide for the title-safe area is shrunk.
The files go in `~/Movies/VibeCut Renders/<project>/Lower thirds/` (renders.py's folder), named from the
text and a hash of everything drawn, so asking again for the same one reuses it.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import subprocess
from fractions import Fraction
from pathlib import Path
from typing import Any

from vibecut_agent.broll import (
    ffprobe_util,  # noqa: F401 - imported for its side effect: Homebrew's ffmpeg on PATH
)
from vibecut_agent.nle.renders import project_folder, safe_name
from vibecut_agent.protocol import Emitter, RequestError

MAX_TITLES = 20
MAX_TEXT = 80
LOOKS = ("bar", "clean")
POSITIONS = ("left", "center")
DEFAULT_ACCENT = "#f5a623"
FFMPEG_TIMEOUT_S = 300.0

# (file, face index) tried in order; Pillow's own font is the last resort.
BOLD_FONTS = [("/System/Library/Fonts/HelveticaNeue.ttc", 1), ("/System/Library/Fonts/Helvetica.ttc", 1)]
REGULAR_FONTS = [("/System/Library/Fonts/HelveticaNeue.ttc", 0), ("/System/Library/Fonts/Helvetica.ttc", 0)]


def _font(candidates: list[tuple[str, int]], size: int) -> Any:
    from PIL import ImageFont

    for path, index in candidates:
        try:
            return ImageFont.truetype(path, size, index=index)
        except OSError:
            continue
    return ImageFont.load_default(size)


def _rgb(accent: str) -> tuple[int, int, int]:
    return int(accent[1:3], 16), int(accent[3:5], 16), int(accent[5:7], 16)


def _fitted(text: str, candidates: list[tuple[str, int]], size: int, width: float) -> Any:
    """The font at `size`, or smaller until `text` fits in `width` (down to 8 px)."""
    font = _font(candidates, size)
    while size > 8 and font.getlength(text) > width:
        size = max(8, int(size * 0.92))
        font = _font(candidates, size)
    return font


def draw(spec: dict[str, Any], options: dict[str, Any]) -> Any:
    """The lower third as an RGBA image the frame's size."""
    from PIL import Image, ImageDraw, ImageFilter

    width, height = options["width"], options["height"]
    unit = min(width, height)
    vertical = height > width
    margin_x = round(width * (0.08 if vertical else 0.06))
    bottom = round(height * (0.22 if vertical else 0.11))
    safe_width = width - 2 * margin_x
    name, title = spec["name"], spec.get("title") or ""
    name_font = _fitted(name, BOLD_FONTS, round(unit * 0.058), safe_width * 0.9)
    # The title stays smaller than a name that had to shrink to fit.
    title_size = min(round(unit * 0.034), round(name_font.size * 0.6))
    title_font = _fitted(title, REGULAR_FONTS, title_size, safe_width * 0.9) if title else None

    pad = round(unit * 0.022)
    rule = max(3, round(unit * 0.007))
    gap = round(unit * 0.008)
    name_box = name_font.getbbox(name)
    title_box = title_font.getbbox(title) if title_font else (0, 0, 0, 0)
    name_h = name_box[3] - name_box[1]
    title_h = title_box[3] - title_box[1]
    text_w = max(name_font.getlength(name), title_font.getlength(title) if title_font else 0)
    text_h = name_h + (gap * 2 + title_h if title_font else 0)
    box_w = round(text_w + 2 * pad + rule)
    box_h = round(text_h + 2 * pad)
    left = margin_x if options["position"] == "left" else round((width - box_w) / 2)
    top = height - bottom - box_h

    image = Image.new("RGBA", (width, height), (0, 0, 0, 0))
    accent = (*_rgb(options["accent"]), 255)
    text_x = left + rule + pad
    name_y = top + pad - name_box[1]
    title_y = top + pad + name_h + gap * 2 - title_box[1]
    if options["look"] == "bar":
        ImageDraw.Draw(image).rectangle([left, top, left + box_w, top + box_h], fill=(12, 12, 16, 200))
    else:
        # A soft shadow under the text instead of a panel.
        shadow = Image.new("RGBA", (width, height), (0, 0, 0, 0))
        sd = ImageDraw.Draw(shadow)
        offset = max(2, round(unit * 0.003))
        sd.text((text_x + offset, name_y + offset), name, font=name_font, fill=(0, 0, 0, 170))
        if title_font:
            sd.text((text_x + offset, title_y + offset), title, font=title_font, fill=(0, 0, 0, 170))
        image = Image.alpha_composite(image, shadow.filter(ImageFilter.GaussianBlur(max(2, unit * 0.004))))
    d = ImageDraw.Draw(image)
    d.rectangle([left, top, left + rule - 1, top + box_h], fill=accent)
    d.text((text_x, name_y), name, font=name_font, fill=(255, 255, 255, 255))
    if title_font:
        d.text((text_x, title_y), title, font=title_font, fill=(225, 225, 230, 255))
    return image


def _stem(spec: dict[str, Any], options: dict[str, Any]) -> str:
    drawn = {
        k: options[k] for k in ("width", "height", "fps", "seconds", "fade", "look", "accent", "position")
    }
    digest = hashlib.sha1(json.dumps([spec["name"], spec.get("title") or "", drawn], sort_keys=True).encode())
    words = safe_name(f"{spec['name']}{' - ' + spec['title'] if spec.get('title') else ''}", "Lower third")
    return f"{words[:60].rstrip()} {digest.hexdigest()[:8]}"


def render(spec: dict[str, Any], options: dict[str, Any], folder: Path) -> dict[str, Any]:
    output = folder / f"{_stem(spec, options)}.mov"
    if output.is_file():
        return {"output": str(output), "reused": True}
    still = folder / f".{output.stem}.png"
    partial = output.with_name(f".{output.stem}.part.mov")
    draw(spec, options).save(still)
    seconds, fade = options["seconds"], options["fade"]
    filters = (
        f"format=rgba,fade=t=in:st=0:d={fade}:alpha=1,fade=t=out:st={seconds - fade:.3f}:d={fade}:alpha=1"
    )
    rate = Fraction(options["fps"]).limit_denominator(1001)
    command = [
        "ffmpeg",
        "-hide_banner",
        "-nostats",
        "-v",
        "error",
        "-y",
        "-loop",
        "1",
        "-framerate",
        str(rate),
    ]
    command += ["-i", str(still), "-t", f"{seconds:.3f}", "-vf", filters if fade > 0 else "format=rgba"]
    command += ["-c:v", "prores_ks", "-profile:v", "4444", "-pix_fmt", "yuva444p10le", "-r", str(rate)]
    command += ["-an", str(partial)]
    try:
        done = subprocess.run(command, capture_output=True, timeout=FFMPEG_TIMEOUT_S, check=False)
    except subprocess.TimeoutExpired:
        partial.unlink(missing_ok=True)
        raise RuntimeError("ffmpeg took too long to render it") from None
    finally:
        still.unlink(missing_ok=True)
    if done.returncode != 0:
        partial.unlink(missing_ok=True)
        raise RuntimeError(done.stderr.decode(errors="ignore").strip()[-300:] or "ffmpeg couldn't render it")
    partial.replace(output)
    return {"output": str(output), "reused": False}


def _text(value: Any, where: str, required: bool) -> str:
    if value is None and not required:
        return ""
    if not isinstance(value, str) or (required and not value.strip()):
        raise RequestError(f"{where} must be text")
    text = re.sub(r"\s+", " ", value).strip()
    if len(text) > MAX_TEXT:
        raise RequestError(f"{where} is over {MAX_TEXT} characters; shorten it")
    return text


def _number(request: dict[str, Any], key: str, default: float, low: float, high: float) -> float:
    value = request.get(key, default)
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not low <= value <= high:
        raise RequestError(f"{key} must be a number from {low:g} to {high:g}")
    return float(value)


def parse_request(request: dict[str, Any]) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    titles = request.get("titles")
    if not isinstance(titles, list) or not 1 <= len(titles) <= MAX_TITLES:
        raise RequestError(f"titles must list 1 to {MAX_TITLES} lower thirds")
    specs = []
    for i, t in enumerate(titles):
        if not isinstance(t, dict):
            raise RequestError(f"titles[{i}] must be {{name, title?}}")
        specs.append(
            {
                "name": _text(t.get("name"), f"titles[{i}].name", True),
                "title": _text(t.get("title"), f"titles[{i}].title", False),
            }
        )
    accent = request.get("accent", DEFAULT_ACCENT)
    if not isinstance(accent, str) or not re.fullmatch(r"#[0-9a-fA-F]{6}", accent):
        raise RequestError('accent must be a colour like "#f5a623"')
    look = request.get("look", "bar")
    if look not in LOOKS:
        raise RequestError(f"look must be one of {', '.join(LOOKS)}")
    position = request.get("position", "left")
    if position not in POSITIONS:
        raise RequestError(f"position must be one of {', '.join(POSITIONS)}")
    seconds = _number(request, "seconds", 5, 1, 30)
    options = {
        "width": int(_number(request, "width", 1920, 320, 8192)),
        "height": int(_number(request, "height", 1080, 320, 8192)),
        "fps": _number(request, "fps", 25, 10, 120),
        "seconds": seconds,
        "fade": min(_number(request, "fade", 0.3, 0, 2), seconds / 3),
        "look": look,
        "accent": accent.lower(),
        "position": position,
    }
    return specs, options


def run(request: dict[str, Any], emitter: Emitter) -> int:
    specs, options = parse_request(request)
    folder = Path(project_folder(request.get("project") or "Untitled project")) / "Lower thirds"
    os.makedirs(folder, exist_ok=True)
    files = []
    for n, spec in enumerate(specs):
        emitter.progress(n, len(specs), phase="rendering", detail=spec["name"])
        entry: dict[str, Any] = {"name": spec["name"], "title": spec["title"]}
        try:
            entry.update(render(spec, options, folder))
        except Exception as exc:  # noqa: BLE001 - one that fails is reported, the rest still rendered
            entry["error"] = str(exc)
        files.append(entry)
    emitter.progress(len(specs), len(specs), phase="done", detail="")
    emitter.emit("result", files=files, folder=str(folder), seconds=options["seconds"])
    return 0 if any("error" not in f for f in files) else 1
