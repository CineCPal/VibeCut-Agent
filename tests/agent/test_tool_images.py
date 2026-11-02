"""Images in tool results (Phase 13b): shown to the model for the rest of the turn, then left out of the
history, for Gemini (Claude Code gets them through its MCP shim, tests/test_mcp_server.py)."""

from __future__ import annotations

import base64
import json

from tests.agent import test_gemini_chat as gemini_tests
from vibecut_agent.agent import gemini_chat
from vibecut_agent.agent.attachments import (
    TOOL_IMAGES_NOTE,
    tool_images,
    without_tool_images_gemini,
)

JPEG = base64.b64encode(b"\xff\xd8\xff\xe0 a tiny jpeg").decode()
FRAME = {"mime": "image/jpeg", "data": JPEG}


class Recorder:
    """Answers every tool call with a sheet attached."""

    def __init__(self) -> None:
        self.events: list[dict] = []
        self.pending: list[str] = []

    def emit(self, event_type, **fields):
        self.events.append({"type": event_type, **fields})
        if event_type == "tool_calls":
            self.pending = [c["id"] for c in fields["calls"]]

    def read_tool_result(self):
        return {
            "type": "tool_result",
            "id": self.pending.pop(0),
            "result": {"shown": "a sheet"},
            "images": [FRAME],
        }


def test_bad_or_too_many_images_are_dropped_not_fatal():
    assert tool_images({"images": [FRAME, FRAME, FRAME]}) == [FRAME, FRAME]
    assert tool_images({"images": [{"mime": "text/plain", "data": "eA=="}]}) == []
    assert tool_images({"images": "nope"}) == [] and tool_images({}) == []


def test_gemini_sees_the_frames_after_the_function_responses(monkeypatch):
    bodies: list[dict] = []
    answers = [
        gemini_tests.function_call_response(("trim_clip_end", {})),
        gemini_tests.text_response("A close-up."),
    ]

    def post(*_a, **k):
        bodies.append(json.loads(k["data"]))
        return answers.pop(0)

    monkeypatch.setattr(gemini_chat, "_http_post", post)
    outcome = gemini_tests.run_turn(Recorder())
    parts = bodies[1]["contents"][-1]["parts"]
    assert "functionResponse" in parts[0]
    assert parts[1:] == [
        {"text": "The images trim_clip_end returned:"},
        {"inline_data": {"mime_type": "image/jpeg", "data": JPEG}},
    ]
    turn = outcome["history"][-2]["parts"]
    assert [list(p) for p in turn] == [["functionResponse"], ["text"]] and turn[1]["text"] == TOOL_IMAGES_NOTE


def test_the_users_own_images_stay_in_the_history():
    gemini = [
        {
            "role": "user",
            "parts": [{"inline_data": {"mime_type": "image/png", "data": "x"}}, {"text": "this"}],
        }
    ]
    assert without_tool_images_gemini(gemini) == gemini
