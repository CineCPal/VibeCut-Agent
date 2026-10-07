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
            raise RequestError(f"Attachment {index} is {mime!r}; only PNG, JPEG, WebP and GIF images can be sent")
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
