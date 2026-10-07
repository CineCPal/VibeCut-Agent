"""Phase 7e: the Story Editor on Claude (subscription), and its first pass over long footage
(story/extract.py), with every model call stubbed."""

import io
import json
import threading

import pytest

from vibecut_agent.agent.redact import _reset_for_tests
from vibecut_agent.protocol import Emitter
from vibecut_agent.story import commands, extract

SETUP = {"program": "/u/.local/bin/claude", "workDir": "/tmp/vca-work", "jobId": "j1", "mcp": {}}

ANSWER = {
    "sequence_name": "Campus",
    "narrative_summary": "A year on campus.",
    "script_segments": [
        {
            "order": 0,
            "source_id": "s1",
            "segment_index": 2400,
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


def segments(n, start=0):
    return [
        {"start": i * 4.0, "end": i * 4.0 + 3.5, "text": f"line {i}", "speaker": "Ana"}
        for i in range(start, start + n)
    ]


def request(lines=10, **extra):
    return {
        "provider": "claude-code",
        "claudeCode": SETUP,
        "model": "claude-opus-5-5",
        "prompt": "A year on campus",
        "sequenceName": "Campus",
        "fps": 25,
        "sources": [{"sourceId": "s1", "segments": segments(lines)}],
        "media": {"s1": "/m/ana.mov"},
        **extra,
    }


def run(req):
    buffer = io.StringIO()
    code = commands.main(io.StringIO(json.dumps(req)), Emitter(buffer))
    return code, [json.loads(line) for line in buffer.getvalue().splitlines()]


def prompt_sources(n_by_source):
    return [
        {
            "source_id": sid,
            "segments": [{"index": i, "start_tc": "", "end_tc": "", "text": f"{sid} {i}"} for i in range(n)],
        }
        for sid, n in n_by_source.items()
    ]


# ------------------------------------------------------------------ the story on the subscription


def test_a_short_story_is_one_claude_code_call_with_no_key(monkeypatch):
    calls = []

    def answer(setup, system, text, schema, model=None, effort="high", should_abort=None):
        calls.append({"setup": setup, "model": model, "effort": effort, "text": text, "schema": schema})
        return {**ANSWER, "script_segments": [{**ANSWER["script_segments"][0], "segment_index": 3}]}

    monkeypatch.setattr(
        commands,
        "claude_code_story",
        lambda setup, brief, sources, catalog, target, model, abort: answer(setup, "", brief, {}, model),
    )
    code, events = run(request(lines=10))
    assert code == 0, events
    assert len(calls) == 1
    assert calls[0]["setup"] == SETUP and calls[0]["model"] == "claude-opus-5-5"
    result = next(e for e in events if e["type"] == "result")
    assert len(result["resolvedSegments"]) == 1
    assert not any(e.get("phase") == "extracting" for e in events)


def test_claude_code_story_uses_json_schema_and_high_effort(monkeypatch):
    from vibecut_agent.agent import claude_code_json
    from vibecut_agent.story import models

    seen = {}

    def run_json(setup, model, system, text, schema, effort=None, should_abort=None):
        seen.update(model=model, effort=effort, schema=schema, system=system, text=text)
        return ANSWER

    monkeypatch.setattr(claude_code_json, "run_json", run_json)
    out = models.claude_code_story(SETUP, "Brief", prompt_sources({"s1": 2}), [], 60, "nonsense")
    assert out == ANSWER
    assert seen["model"] == "claude-sonnet-5-5", "an unknown model falls back to the default"
    assert seen["effort"] == "high"
    assert seen["schema"]["type"] == "object" and seen["schema"]["additionalProperties"] is False
    assert "TARGET RUNTIME: approximately 60 seconds" in seen["text"]


def test_no_setup_on_the_subscription_is_refused():
    req = request()
    del req["claudeCode"]
    code, events = run(req)
    assert code == 2
    assert "isn't set up" in events[-2]["message"]


# ------------------------------------------------------------------ the first pass


def test_parts_split_each_source_in_order():
    parts = extract.parts_of(prompt_sources({"a": 3200, "b": 10}), size=1500)
    assert [(p["source_id"], len(p["segments"])) for p in parts] == [
        ("a", 1500),
        ("a", 1500),
        ("a", 200),
        ("b", 10),
    ]
    assert parts[1]["segments"][0]["index"] == 1500


def test_the_shortlist_keeps_neighbours_strongest_first_and_in_order():
    sources = prompt_sources({"a": 100, "b": 100})
    moments = [
        {"source_id": "a", "segment_index": 50, "why": "x", "strength": 2},
        {"source_id": "b", "segment_index": 0, "why": "y", "strength": 5},
        {"source_id": "a", "segment_index": 10, "why": "z", "strength": 4},
    ]
    kept = extract.shortlist(sources, moments)
    assert [(s["source_id"], [seg["index"] for seg in s["segments"]]) for s in kept] == [
        ("a", [9, 10, 11, 49, 50, 51]),
        ("b", [0, 1]),
    ]
    tight = extract.shortlist(sources, moments, limit=5)
    assert [(s["source_id"], [seg["index"] for seg in s["segments"]]) for s in tight] == [
        ("a", [9, 10, 11]),
        ("b", [0, 1]),
    ]


def test_moments_naming_unknown_segments_are_dropped():
    part = prompt_sources({"a": 5})[0]
    answer = {
        "moments": [
            {"segment_index": 4, "why": "ok", "strength": 9},
            {"segment_index": 99, "why": "no", "strength": 5},
            "junk",
        ]
    }
    assert extract.moments_in(answer, part) == [
        {"source_id": "a", "segment_index": 4, "why": "ok", "strength": 5}
    ]


def test_long_footage_gets_a_first_pass_then_one_story_call(monkeypatch):
    asked = []
    lock = threading.Lock()

    def first(setup, system, text, schema, model=None, effort="high", should_abort=None):
        with lock:
            asked.append({"model": model, "effort": effort, "text": text, "schema": schema})
        if "PART 2 of" in text:
            return {
                "themes": ["move-in"],
                "moments": [{"segment_index": 2400, "why": "Best line", "strength": 5}],
            }
        return {"themes": ["first day"], "moments": []}

    story_calls = []

    def story(setup, brief, sources, catalog, target, model, abort):
        story_calls.append({"brief": brief, "sources": sources})
        return ANSWER

    monkeypatch.setattr(commands, "claude_code_json_answer", first)
    monkeypatch.setattr(commands, "claude_code_story", story)
    code, events = run(request(lines=3000))
    assert code == 0, events
    assert len(asked) == 2, "3000 lines: two parts of at most 1500"
    assert {a["model"] for a in asked} == {"claude-sonnet-5-5"} and {a["effort"] for a in asked} == {"medium"}
    assert all(a["schema"] is extract.EXTRACT_SCHEMA for a in asked)
    assert len(story_calls) == 1
    sent = story_calls[0]["sources"]
    assert [seg["index"] for seg in sent[0]["segments"]] == [2399, 2400, 2401]
    assert (
        "FIRST-PASS NOTES" in story_calls[0]["brief"]
        and "s1 [2400] (strength 5): Best line" in story_calls[0]["brief"]
    )
    assert (
        "Themes: first day; move-in" in story_calls[0]["brief"]
        or "Themes: move-in; first day" in story_calls[0]["brief"]
    )
    progress = [e["detail"] for e in events if e.get("phase") == "extracting"]
    assert progress[0] == "First pass with Claude Sonnet (subscription): 0 of 2 part(s) of 3000 lines"
    assert progress[-1].startswith("First pass with Claude Sonnet (subscription): 2 of 2")
    result = next(e for e in events if e["type"] == "result")
    assert "3000 transcript lines were too many for one read" in result["warnings"][0]


def test_the_first_pass_can_run_on_gemini_with_its_key(monkeypatch):
    used = []
    monkeypatch.setattr(
        commands,
        "gemini_json",
        lambda key, system, text, schema, model, on_retry: (
            used.append((key, model)),
            {"themes": [], "moments": [{"segment_index": 5, "why": "w", "strength": 3}]},
        )[1],
    )
    picks_line_5 = {**ANSWER, "script_segments": [{**ANSWER["script_segments"][0], "segment_index": 5}]}
    monkeypatch.setattr(commands, "claude_code_story", lambda *a: picks_line_5)
    code, events = run(request(lines=2100, extraction="gemini", extractionKey="g-secret-key"))
    assert code == 0, events
    assert used and all(u == ("g-secret-key", "gemini-flash-latest") for u in used)
    assert not any("g-secret-key" in json.dumps(e) for e in events)


def test_a_gemini_first_pass_without_a_key_says_so(monkeypatch):
    monkeypatch.setattr(commands, "claude_code_story", lambda *a: pytest.fail("no story call expected"))
    code, events = run(request(lines=2100, extraction="gemini"))
    assert code == 1
    assert "no Gemini API key is set" in next(e for e in events if e["type"] == "error")["message"]


def test_a_failed_part_fails_the_cut(monkeypatch):
    from vibecut_agent.story.models import StoryModelError

    def boom(*a, **k):
        raise StoryModelError("Claude Code hit your plan's usage limit")

    monkeypatch.setattr(commands, "claude_code_json_answer", boom)
    monkeypatch.setattr(commands, "claude_code_story", lambda *a: pytest.fail("no story call expected"))
    code, events = run(request(lines=2100))
    assert code == 1
    assert "usage limit" in next(e for e in events if e["type"] == "error")["message"]


def test_stop_during_the_first_pass_stops_the_cut():
    sources = prompt_sources({"a": 4000})
    stop = threading.Event()

    def ask(system, text, schema):
        stop.set()
        return {"themes": [], "moments": []}

    with pytest.raises(extract.ExtractionStopped):
        extract.first_pass("brief", sources, None, ask, should_abort=stop.is_set, workers=1)


def test_a_first_pass_that_finds_nothing_is_an_error():
    with pytest.raises(ValueError, match="found nothing"):
        extract.first_pass(
            "brief", prompt_sources({"a": 2100}), None, lambda s, t, sc: {"themes": [], "moments": []}
        )
