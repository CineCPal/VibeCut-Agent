"""The `assemble` command (vibecut_agent/story/commands.py) and its two model calls (models.py),
with the network stubbed: what each provider is sent, what comes back, and that the key never does."""

import io
import json

import pytest

from vibecut_agent.agent import claude_client
from vibecut_agent.agent.redact import _reset_for_tests
from vibecut_agent.protocol import Emitter
from vibecut_agent.story import commands, models

KEY = "sk-test-secret-123"

ANSWER = {
    "sequence_name": "The Bakery",
    "narrative_summary": "How it began.",
    "script_segments": [
        {
            "order": 0,
            "source_id": "s1",
            "segment_index": 0,
            "in_offset_seconds": 0,
            "out_offset_seconds": 0,
            "editorial_note": "Open",
            "on_screen_text": "",
        }
    ],
    "broll_segments": [],
}


@pytest.fixture(autouse=True)
def _clean_secrets():
    yield
    _reset_for_tests()


def request(**extra):
    return {
        "apiKey": KEY,
        "prompt": "How the bakery began",
        "sequenceName": "Story",
        "fps": 25,
        "sources": [
            {
                "sourceId": "s1",
                "segments": [{"start": 0, "end": 3, "text": "We opened in 1999.", "speaker": "Ana"}],
            }
        ],
        "media": {"s1": "/m/ana.mov"},
        **extra,
    }


def run(req):
    buffer = io.StringIO()
    code = commands.main(io.StringIO(json.dumps(req)), Emitter(buffer))
    return code, [json.loads(line) for line in buffer.getvalue().splitlines()]


class FakeResponse:
    def __init__(self, status, body):
        self.status_code = status
        self._body = body
        self.text = json.dumps(body)

    def json(self):
        return self._body


def test_gemini_is_sent_the_brief_with_the_story_schema(monkeypatch):
    sent = {}

    def post(url, headers, data, timeout):
        sent.update(url=url, headers=headers, body=json.loads(data))
        return FakeResponse(200, {"candidates": [{"content": {"parts": [{"text": json.dumps(ANSWER)}]}}]})

    monkeypatch.setattr(models.requests, "post", post)
    code, events = run(request(targetDuration="2 minutes"))
    assert code == 0
    assert "gemini-flash-latest:generateContent" in sent["url"]
    assert sent["headers"]["x-goog-api-key"] == KEY
    config = sent["body"]["generationConfig"]
    assert (
        config["responseMimeType"] == "application/json"
        and "broll_segments" in config["responseSchema"]["properties"]
    )
    user = sent["body"]["contents"][0]["parts"][0]["text"]
    assert (
        "CREATIVE BRIEF:\nHow the bakery began" in user
        and "TARGET RUNTIME: approximately 120 seconds" in user
    )
    assert "[0] 00:00:00:00 - 00:00:03:00  Ana: We opened in 1999." in user
    assert "AVAILABLE B-ROLL CLIPS:\n(none available)" in user
    result = next(e for e in events if e["type"] == "result")
    assert result["sequenceName"] == "The Bakery"
    assert result["resolvedSegments"][0]["source_name"] == "ana.mov"
    assert events[0]["type"] == "starting" and events[-1] == {"type": "done", "cancelled": False}


def test_claude_answers_through_structured_outputs(monkeypatch):
    sent = {}

    def send(api_key, params, timeout, on_retry, should_abort):
        sent.update(api_key=api_key, params=params)
        return {
            "stop_reason": "end_turn",
            "content": [{"type": "thinking", "thinking": ""}, {"type": "text", "text": json.dumps(ANSWER)}],
        }

    monkeypatch.setattr(claude_client, "send", send)
    code, events = run(request(provider="claude", model="claude-opus-5-5"))
    assert code == 0
    params = sent["params"]
    assert sent["api_key"] == KEY
    assert params["model"] == "claude-opus-5-5"
    assert params["betas"] == [claude_client.FALLBACK_BETA] and params["fallbacks"] == "default"
    schema = params["output_config"]["format"]["schema"]
    assert params["output_config"]["format"]["type"] == "json_schema"
    # Structured outputs need every object closed and every property required.
    item = schema["properties"]["broll_segments"]["items"]
    assert item["additionalProperties"] is False and "duck_db" in item["required"]
    assert item["properties"]["audio_mode"] == {"type": "string", "enum": ["silent", "full", "duck_main"]}
    assert "thinking" not in params and "tool_choice" not in params
    assert any(e["type"] == "result" and e["narrativeSummary"] == "How it began." for e in events)


def test_an_unknown_claude_model_falls_back_to_the_default(monkeypatch):
    seen = {}
    monkeypatch.setattr(
        claude_client,
        "send",
        lambda api_key, params, **_: (
            seen.update(params)
            or {"stop_reason": "end_turn", "content": [{"type": "text", "text": json.dumps(ANSWER)}]}
        ),
    )
    run(request(provider="claude", model="gpt-whatever"))
    assert seen["model"] == claude_client.DEFAULT_MODEL


@pytest.mark.parametrize(("stop", "says"), [("refusal", "declined"), ("max_tokens", "cut off")])
def test_claude_stopping_early_is_an_error(monkeypatch, stop, says):
    monkeypatch.setattr(claude_client, "send", lambda *a, **k: {"stop_reason": stop, "content": []})
    code, events = run(request(provider="claude"))
    assert code == 1
    assert says in next(e for e in events if e["type"] == "error")["message"]


def test_the_key_never_appears_in_an_event(monkeypatch):
    def post(url, headers, data, timeout):
        return FakeResponse(400, {"error": f"bad key {KEY}"})

    monkeypatch.setattr(models.requests, "post", post)
    code, events = run(request())
    assert code == 1
    assert KEY not in json.dumps(events)
    assert "HTTP 400" in next(e for e in events if e["type"] == "error")["message"]


def test_a_cut_with_no_usable_line_is_an_error(monkeypatch):
    bad = {**ANSWER, "script_segments": [{"order": 0, "source_id": "ghost", "segment_index": 0}]}
    monkeypatch.setattr(
        models.requests,
        "post",
        lambda *a, **k: FakeResponse(
            200, {"candidates": [{"content": {"parts": [{"text": json.dumps(bad)}]}}]}
        ),
    )
    code, events = run(request())
    assert code == 1
    assert "unknown source_id 'ghost'" in next(e for e in events if e["type"] == "error")["message"]


@pytest.mark.parametrize(
    ("change", "says"),
    [
        ({"apiKey": ""}, "No Gemini API key"),
        ({"prompt": "  "}, "brief"),
        ({"sources": []}, "No transcripts"),
        ({"provider": "llama"}, "Unknown provider"),
        ({"targetDuration": "soonish"}, "as a duration"),
        (
            {"brollCatalog": [{"brollId": "b1", "path": "relative.mov", "durationSeconds": 3}]},
            "absolute path",
        ),
        ({"brollCatalog": [{"brollId": "b1", "path": "/nowhere/b.mov", "durationSeconds": 3}]}, "not a file"),
        ({"sources": [{"sourceId": "s1", "segments": [{"start": 3, "end": 1}]}]}, "usable line"),
    ],
)
def test_bad_requests_are_refused_before_any_call(monkeypatch, change, says):
    monkeypatch.setattr(models.requests, "post", lambda *a, **k: pytest.fail("no call expected"))
    code, events = run(request(**change))
    assert code == 2
    assert says in next(e for e in events if e["type"] == "error")["message"]


def test_the_catalog_reaches_the_prompt(monkeypatch, tmp_path):
    clip = tmp_path / "sunset.mp4"
    clip.write_bytes(b"x")
    sent = {}

    def post(url, headers, data, timeout):
        sent.update(json.loads(data))
        return FakeResponse(200, {"candidates": [{"content": {"parts": [{"text": json.dumps(ANSWER)}]}}]})

    monkeypatch.setattr(models.requests, "post", post)
    catalog = [
        {
            "brollId": "b1",
            "path": str(clip),
            "durationSeconds": 6,
            "caption": "golden sunset",
            "tags": ["sky", 3],
            "technicalScore": 82.4,
        }
    ]
    assert run(request(brollCatalog=catalog))[0] == 0
    user = sent["contents"][0]["parts"][0]["text"]
    assert "[b1] duration 6.0s; caption: golden sunset; tags: sky; quality 82/100" in user


def test_assemble_is_a_registered_command():
    from vibecut_agent.headless import COMMANDS

    assert "assemble" in COMMANDS
