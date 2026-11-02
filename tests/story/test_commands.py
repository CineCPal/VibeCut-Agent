"""The `assemble` command (vibecut_agent/story/commands.py) and its two model calls (models.py),
with the network stubbed: what each provider is sent, what comes back, and that the key never does."""

import io
import json

import pytest

from vibecut_agent.agent import claude_code_json
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
    # Flash by default, thinking hard, at Gemini 3's own temperature.
    assert "gemini-3.8-flash:generateContent" in sent["url"]
    assert sent["headers"]["x-goog-api-key"] == KEY
    config = sent["body"]["generationConfig"]
    assert config["thinkingConfig"] == {"thinkingLevel": "high"} and "temperature" not in config
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


def test_a_chat_on_gemini_pro_cuts_its_story_on_pro(monkeypatch):
    urls = []

    def post(url, headers, data, timeout):
        urls.append(url)
        return FakeResponse(200, {"candidates": [{"content": {"parts": [{"text": json.dumps(ANSWER)}]}}]})

    monkeypatch.setattr(models.requests, "post", post)
    assert run(request(model="gemini-3.1-pro-preview"))[0] == 0
    assert "gemini-3.1-pro-preview:generateContent" in urls[0]


def test_a_key_without_pro_gets_flash_and_is_told(monkeypatch):
    urls = []

    def post(url, headers, data, timeout):
        urls.append(url)
        if "pro" in url:
            return FakeResponse(404, {"error": {"code": 404, "message": "not found"}})
        return FakeResponse(200, {"candidates": [{"content": {"parts": [{"text": json.dumps(ANSWER)}]}}]})

    monkeypatch.setattr(models.requests, "post", post)
    code, events = run(request(model="gemini-3.1-pro-preview"))
    assert code == 0
    assert [u.split("/models/")[1].split(":")[0] for u in urls] == [
        "gemini-3.1-pro-preview",
        "gemini-3.8-flash",
    ]
    notices = [
        e["detail"] for e in events if e["type"] == "status" and "isn't available" in e.get("detail", "")
    ]
    assert notices == [
        "gemini-3.1-pro-preview isn't available on this Gemini API key; using gemini-3.8-flash instead."
    ]


def test_a_retired_flash_falls_back_to_the_alias_and_then_gives_up(monkeypatch):
    urls = []

    def post(url, headers, data, timeout):
        urls.append(url)
        return FakeResponse(404, {"error": {"code": 404}})

    monkeypatch.setattr(models.requests, "post", post)
    with pytest.raises(models.StoryModelError, match="gemini-flash-latest isn't available"):
        models.gemini_json(KEY, "s", "u", {"type": "OBJECT"}, "gemini-3.8-flash")
    assert [u.split("/models/")[1].split(":")[0] for u in urls] == ["gemini-3.8-flash", "gemini-flash-latest"]


def test_claude_answers_through_the_subscriptions_claude_code(monkeypatch):
    sent = {}

    def run_json(setup, model, system, user, schema, effort, should_abort):
        sent.update(setup=setup, model=model, schema=schema, effort=effort)
        return ANSWER

    monkeypatch.setattr(claude_code_json, "run_json", run_json)
    code, events = run(
        {
            **request(provider="claude-code", model="claude-opus-5-5", claudeCode={"program": "/c"}),
            "apiKey": "",
        }
    )
    assert code == 0
    assert (
        sent["setup"] == {"program": "/c"} and sent["model"] == "claude-opus-5-5" and sent["effort"] == "high"
    )
    # Structured outputs need every object closed and every property required.
    item = sent["schema"]["properties"]["broll_segments"]["items"]
    assert item["additionalProperties"] is False and "duck_db" in item["required"]
    assert any(e["type"] == "result" and e["narrativeSummary"] == "How it began." for e in events)


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
        ({"provider": "claude"}, "Unknown provider"),
        ({"provider": "antigravity"}, "Unknown provider"),
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
