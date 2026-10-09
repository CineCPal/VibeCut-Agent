"""attachments.py

Images sent with a chat message (PLAN.md, "Phase 8g"). The app downsizes them and sends each as
``{"mime", "data"}`` (base64) in the request's ``attachments``. They're checked here, then put into each
provider's own user turn: Gemini ``inline_data`` parts, Claude ``image`` blocks (also how Claude Code
takes them, as one stream-json user line).
"""

from __future__ import annotations

import base64
import binascii
from typing import Any

from vibecut_agent.protocol import RequestError

MAX_IMAGES = 4
IMAGE_TYPES = ("image/png", "image/jpeg", "image/webp", "image/gif")
# Claude refuses an image over 5 MB; the app keeps each under 3.75 MB of bytes (5 MB as base64).
MAX_IMAGE_BYTES = 3_932_160


def parse_images(value: Any) -> list[dict[str, str]]:
    """The request's ``attachments``, checked: at most MAX_IMAGES images of IMAGE_TYPES, each valid
    base64 of at most MAX_IMAGE_BYTES. Absent or empty is no images."""
    if value is None:
        return []
    if not isinstance(value, list):
        raise RequestError("attachments must be a list")
    if len(value) > MAX_IMAGES:
        raise RequestError(f"At most {MAX_IMAGES} images can go with one message")
    images: list[dict[str, str]] = []
    for index, item in enumerate(value, start=1):
        if not isinstance(item, dict) or not isinstance(item.get("data"), str):
            raise RequestError(f"Attachment {index} isn't an image")
        mime = item.get("mime")
        if mime not in IMAGE_TYPES:
            raise RequestError(
                f"Attachment {index} is {mime!r}; only PNG, JPEG, WebP and GIF images can be sent"
            )
        data = item["data"]
        try:
            size = len(base64.b64decode(data, validate=True))
        except (binascii.Error, ValueError):
            raise RequestError(f"Attachment {index} isn't valid base64") from None
        if size == 0:
            raise RequestError(f"Attachment {index} is empty")
        if size > MAX_IMAGE_BYTES:
            raise RequestError(f"Attachment {index} is over {MAX_IMAGE_BYTES / (1024 * 1024):g} MB")
        images.append({"mime": str(mime), "data": data})
    return images


def gemini_parts(images: list[dict[str, str]] | None, text: str) -> list[dict[str, Any]]:
    """A user turn's parts: the images first, then the words (each provider reads them in order)."""
    parts: list[dict[str, Any]] = [
        {"inline_data": {"mime_type": image["mime"], "data": image["data"]}} for image in images or []
    ]
    parts.append({"text": text})
    return parts


def claude_blocks(images: list[dict[str, str]] | None, text: str) -> list[dict[str, Any]]:
    """The same turn as Claude content blocks."""
    blocks: list[dict[str, Any]] = [
        {"type": "image", "source": {"type": "base64", "media_type": image["mime"], "data": image["data"]}}
        for image in images or []
    ]
    blocks.append({"type": "text", "text": text})
    return blocks


# ----------------------------------------------------------------------------- images in tool results
# Phase 13b: a tool (look_at_clip and friends) can answer with images as well as its result. They go
# into the model's view of that answer for the rest of the turn, then the history keeps a note in their
# place: they'd otherwise be sent again with every later message.

MAX_TOOL_IMAGES = 2
TOOL_IMAGES_NOTE = "[The frames this tool returned were shown to you in an earlier turn and aren't kept; look again to see them.]"


def tool_images(message: dict[str, Any]) -> list[dict[str, str]]:
    """The images that came with a ``tool_result`` message, checked like attachments. A bad one is
    dropped rather than failing the turn: the result itself still stands."""
    raw = message.get("images")
    if not isinstance(raw, list) or not raw:
        return []
    try:
        return parse_images(raw[:MAX_TOOL_IMAGES])
    except RequestError:
        return []


def claude_tool_content(text: str, images: list[dict[str, str]]) -> str | list[dict[str, Any]]:
    """A tool_result block's content: the result's text, then its images."""
    if not images:
        return text
    return [{"type": "text", "text": text}, *claude_blocks(images, "")[:-1]]


def gemini_tool_parts(name: str, images: list[dict[str, str]]) -> list[dict[str, Any]]:
    """Parts put after the functionResponse parts of the same turn, for one call's images."""
    if not images:
        return []
    return [{"text": f"The images {name} returned:"}, *gemini_parts(images, "")[:-1]]


def without_tool_images_claude(messages: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """The history with every tool_result's images replaced by TOOL_IMAGES_NOTE. Images the user sent
    (top-level image blocks) stay."""
    out = []
    for message in messages:
        content = message.get("content")
        if message.get("role") != "user" or not isinstance(content, list):
            out.append(message)
            continue
        blocks = []
        for block in content:
            inner = (
                block.get("content")
                if isinstance(block, dict) and block.get("type") == "tool_result"
                else None
            )
            if isinstance(inner, list) and any(
                isinstance(b, dict) and b.get("type") == "image" for b in inner
            ):
                kept = [b for b in inner if not (isinstance(b, dict) and b.get("type") == "image")]
                block = {**block, "content": [*kept, {"type": "text", "text": TOOL_IMAGES_NOTE}]}
            blocks.append(block)
        out.append({**message, "content": blocks})
    return out


def without_tool_images_gemini(contents: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """The same for Gemini: in a turn of functionResponse parts, the images (and their lead-in text)
    become one TOOL_IMAGES_NOTE. A user's own message never has functionResponse parts."""
    out = []
    for content in contents:
        parts = content.get("parts")
        if (
            content.get("role") != "user"
            or not isinstance(parts, list)
            or not any(isinstance(p, dict) and "functionResponse" in p for p in parts)
            or not any(isinstance(p, dict) and "inline_data" in p for p in parts)
        ):
            out.append(content)
            continue
        kept = [p for p in parts if isinstance(p, dict) and "functionResponse" in p]
        out.append({**content, "parts": [*kept, {"text": TOOL_IMAGES_NOTE}]})
    return out
