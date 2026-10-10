"""Phase 14b: the vision critic (review/critic.py), ported from VibeCut's test_gemini_critic.py. Each
provider's call is faked at its transport, so the parts with their images are checked as they're sent;
one test reads real frames with the local ffmpeg."""

from __future__ import annotations

import base64
import io
import json
import shutil
import subprocess
from pathlib import Path
from typing import Any

import pytest

from vibecut_agent import headless
from vibecut_agent.agent import claude_client, claude_code_json
from vibecut_agent.protocol import Emitter, RequestError
from vibecut_agent.review import critic
from vibecut_agent.story import models

KEY = "test-key-critic"
JPEG = b"\xff\xd8fake-jpeg"
ANSWER = {
    "overall": "The opening drags.",
    "findings": [
        {
            "time": 4.21,
            "severity": "high",
            "category": "continuity",
            "issue": "A jump cut on the same framing.",
            "suggestedFix": "Cover it with B-roll.",
        },
        {"time": "soon", "severity": "high", "category": "story", "issue": "Bad time.", "suggestedFix": ""},
        {"time": 9, "severity": "urgent", "category": "vibes", "issue": "  Odd labels.  ", "suggestedFix": 3},
        {"time": 12, "severity": "low", "category": "pacing", "issue": "", "suggestedFix": "x"},
        "not a finding",
    ],
}


class Capture:
    def __init__(self) -> None:
        self.buffer = io.StringIO()
        self.emitter = Emitter(self.buffer)

    def events(self) -> list[dict[str, Any]]:
        return [json.loads(line) for line in self.buffer.getvalue().splitlines()]


def frame(i: int, path: str = "/m/a.mov") -> dict[str, Any]:
    return {"path": path, "sourceTime": 1.0 + i, "time": 10.0 + i, "label": f"shot {i + 1}, first frame"}


def request(**over: Any) -> dict[str, Any]:
    return {
        "apiKey": KEY,
        "frames": [frame(0), frame(1)],
        "brief": "A 60 s cut",
        "snapshot": "V1: …",
        "transcript": "[0–3] Ana: Hi",
        "lint": [{"time": 4, "category": "black"}],
        **over,
    }


def fake_grab(path: str, time: float, width: int) -> bytes:
    assert width == critic.FRAME_WIDTH
    if "missing" in path:
        raise RuntimeError("the file isn't there")
    return JPEG


def run(req: dict[str, Any]) -> tuple[int, list[dict[str, Any]]]:
    capture = Capture()
    code = critic.run(req, capture.emitter, grab=fake_grab)
    return code, capture.events()


def test_findings_keep_only_well_formed_ones_and_fix_bad_labels() -> None:
    out = critic.findings_from(ANSWER)
    assert out["overall"] == "The opening drags."
    assert out["findings"] == [
        {
            "time": 4.21,
            "severity": "high",
            "category": "continuity",
            "issue": "A jump cut on the same framing.",
            "suggestedFix": "Cover it with B-roll.",
        },
        {"time": 9.0, "severity": "medium", "category": "other", "issue": "Odd labels.", "suggestedFix": ""},
    ]
    many = {"overall": 3, "findings": [{"time": i, "issue": "x"} for i in range(30)]}
    assert len(critic.findings_from(many)["findings"]) == critic.MAX_FINDINGS
    assert critic.findings_from(many)["overall"] == ""
    with pytest.raises(critic.CriticError):
        critic.findings_from(["not", "an", "object"])
    with pytest.raises(critic.CriticError):
        critic.findings_from_text("{nope")


def test_the_parts_caption_each_still_in_timeline_order() -> None:
    parts = critic.build_parts([(frame(0), JPEG), (frame(1), JPEG)], "  ", "", "", [])
    texts = [p.get("text") for p in parts]
    assert texts[0].startswith("Editor's brief: (none given")
    assert "Automatic check findings:\n(none)" in texts
    assert (
        "shot 1, first frame — timeline 10.00s" in texts and "shot 2, first frame — timeline 11.00s" in texts
    )
    images = [p["inline_data"] for p in parts if "inline_data" in p]
    assert images == [{"mime_type": "image/jpeg", "data": base64.b64encode(JPEG).decode()}] * 2
    assert texts[-1] == "Review the cut now."


def test_frames_are_checked() -> None:
    with pytest.raises(RequestError, match="non-empty"):
        critic.parse_frames([])
    with pytest.raises(RequestError, match="At most 32"):
        critic.parse_frames([frame(i) for i in range(33)])
    with pytest.raises(RequestError, match="absolute"):
        critic.parse_frames([{**frame(0), "path": "a.mov"}])
    with pytest.raises(RequestError, match="sourceTime"):
        critic.parse_frames([{**frame(0), "sourceTime": "1"}])
    assert critic.parse_frames([{**frame(0), "sourceTime": -2, "label": ""}])[0] == {
        "path": "/m/a.mov",
        "sourceTime": 0.0,
        "time": 10.0,
        "label": "frame",
    }


def test_gemini_gets_the_stills_inline_with_the_schema(monkeypatch: pytest.MonkeyPatch) -> None:
    sent: dict[str, Any] = {}

    class Response:
        status_code = 200
        text = ""

        def json(self) -> dict[str, Any]:
            return {"candidates": [{"content": {"parts": [{"text": json.dumps(ANSWER)}]}}]}

    def post(url: str, headers: dict[str, str], data: str, timeout: float) -> Response:
        sent.update(url=url, headers=headers, body=json.loads(data))
        return Response()

    monkeypatch.setattr(models.requests, "post", post)
    code, events = run(request(frames=[frame(0), frame(1, "/m/missing.mov"), frame(2)]))
    assert code == 0, events
    body = sent["body"]
    assert sent["headers"]["x-goog-api-key"] == KEY
    assert body["systemInstruction"]["parts"][0]["text"] == critic.SYSTEM_INSTRUCTION
    assert body["generationConfig"]["temperature"] == 0.3
    assert body["generationConfig"]["responseSchema"] == critic.RESPONSE_SCHEMA
    parts = body["contents"][0]["parts"]
    assert sum("inline_data" in p for p in parts) == 2, "the unreadable still is left out"
    assert any(p.get("text", "").startswith("Automatic check findings:\n[{") for p in parts)
    result = next(e for e in events if e["type"] == "result")
    assert result["framesSent"] == 2 and result["framesFailed"] == 1
    assert [f["time"] for f in result["findings"]] == [4.21, 9.0]


def test_claude_gets_image_blocks_at_medium_effort(monkeypatch: pytest.MonkeyPatch) -> None:
    sent: dict[str, Any] = {}

    def send(
        api_key: str, params: dict[str, Any], timeout: float, on_retry: Any, should_abort: Any
    ) -> dict[str, Any]:
        sent.update(api_key=api_key, params=params)
        return {"stop_reason": "end_turn", "content": [{"type": "text", "text": json.dumps(ANSWER)}]}

    monkeypatch.setattr(claude_client, "send", send)
    code, events = run(request(provider="claude", model="claude-opus-5-5"))
    assert code == 0, events
    params = sent["params"]
    assert sent["api_key"] == KEY and params["model"] == "claude-opus-5-5"
    assert params["output_config"]["effort"] == "medium" and params["max_tokens"] == critic.CLAUDE_MAX_TOKENS
    content = params["messages"][0]["content"]
    images = [b for b in content if b["type"] == "image"]
    assert len(images) == 2 and images[0]["source"] == {
        "type": "base64",
        "media_type": "image/jpeg",
        "data": base64.b64encode(JPEG).decode(),
    }
    assert content[0] == {"type": "text", "text": "Editor's brief: A 60 s cut"}


def test_claude_code_gets_the_blocks_on_the_subscription(monkeypatch: pytest.MonkeyPatch) -> None:
    seen: dict[str, Any] = {}

    def run_json(
        setup: Any,
        model: str,
        system: str,
        text: Any,
        schema: dict[str, Any],
        effort: Any = None,
        should_abort: Any = None,
    ) -> dict[str, Any]:
        seen.update(setup=setup, model=model, text=text, effort=effort, schema=schema)
        return ANSWER

    monkeypatch.setattr(claude_code_json, "run_json", run_json)
    setup = {"program": "/bin/claude", "workDir": "/tmp/w"}
    code, events = run(request(provider="claude-code", apiKey=None, claudeCode=setup))
    assert code == 0, events
    assert (
        seen["setup"] == setup
        and seen["model"] == models.CLAUDE_CODE_DEFAULT_MODEL
        and seen["effort"] == "medium"
    )
    assert isinstance(seen["text"], list) and sum(b["type"] == "image" for b in seen["text"]) == 2
    assert seen["schema"]["additionalProperties"] is False, "the schema is converted for Claude"


def test_failures_are_reported_without_the_key(monkeypatch: pytest.MonkeyPatch) -> None:
    def boom(*args: Any, **kwargs: Any) -> dict[str, Any]:
        raise models.StoryModelError(f"Gemini API returned HTTP 500 for {KEY}")

    monkeypatch.setattr(models, "gemini_json", boom)
    code, events = run(request())
    assert code == 1
    error = next(e for e in events if e["type"] == "error")
    assert KEY not in json.dumps(error)

    code, events = run(request(frames=[frame(0, "/m/missing.mov")]))
    assert code == 1 and "None of the stills" in next(e for e in events if e["type"] == "error")["message"]
    with pytest.raises(RequestError, match="No Gemini API key"):
        critic.run(request(apiKey=""), Capture().emitter, grab=fake_grab)
    with pytest.raises(RequestError, match="Claude Code isn't set up"):
        critic.run(request(provider="claude-code"), Capture().emitter, grab=fake_grab)


@pytest.mark.skipif(shutil.which("ffmpeg") is None, reason="needs ffmpeg")
def test_real_frames_are_read_as_small_jpegs(tmp_path: Path) -> None:
    clip = tmp_path / "red.mov"
    subprocess.run(
        [
            "ffmpeg",
            "-v",
            "error",
            "-f",
            "lavfi",
            "-i",
            "color=c=red:s=1280x720:d=2:r=25",
            "-c:v",
            "mjpeg",
            str(clip),
        ],
        check=True,
    )
    ok, failed = critic.extract_frames(
        [
            {"path": str(clip), "sourceTime": 1.0, "time": 0.0, "label": "x"},
            {"path": str(tmp_path / "gone.mov"), "sourceTime": 0.0, "time": 1.0, "label": "y"},
        ]
    )
    assert len(ok) == 1 and len(failed) == 1
    from PIL import Image

    image = Image.open(io.BytesIO(ok[0][1]))
    assert image.format == "JPEG" and image.width == critic.FRAME_WIDTH
    r, g, b = image.convert("RGB").getpixel((10, 10))
    assert r > 200 and g < 60 and b < 60


def test_critique_is_a_sidecar_command() -> None:
    assert "critique" in headless.COMMANDS
