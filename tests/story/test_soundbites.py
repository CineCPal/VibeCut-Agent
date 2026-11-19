"""Soundbites from whole transcripts (story/soundbites.py): the `assemble` command in "soundbites" mode, the
first pass over every line with its moments returned, the model stubbed."""

from __future__ import annotations

import io
import json
import threading

from vibecut_agent.agent.redact import _reset_for_tests
from vibecut_agent.protocol import Emitter
from vibecut_agent.story import commands, soundbites


def lines(count: int, offset: float = 0.0) -> list[dict]:
    return [
        {"start": offset + i * 3.0, "end": offset + i * 3.0 + 2.5, "text": f"line {i}", "speaker": "Ana"}
        for i in range(count)
    ]


def request(**extra) -> dict:
    return {
        "mode": "soundbites",
        "provider": "claude-code",
        "claudeCode": {"program": "claude"},
        "prompt": "What students are grateful for",
        "sources": [
            {"sourceId": "s1", "segments": lines(2000)},
            {"sourceId": "s2", "segments": lines(10, 5.0)},
        ],
        "media": {"s1": "/Volumes/Shoot/long.mp4", "s2": "/Volumes/Shoot/short.mp4"},
        "fps": 25,
        **extra,
    }


def run(req: dict) -> tuple[int, list[dict]]:
    out = io.StringIO()
    try:
        code = commands.run(req, Emitter(out))
    finally:
        _reset_for_tests()
    return code, [json.loads(line) for line in out.getvalue().splitlines()]


def test_every_line_is_read_and_the_moments_come_back_strongest_first(monkeypatch):
    asked = []
    lock = threading.Lock()

    def first(setup, system, text, schema, model, effort, should_abort):
        with lock:
            asked.append({"model": model, "effort": effort, "text": text})
        if "line 1700" in text:  # part 2 of s1
            return {
                "themes": ["teachers"],
                "moments": [{"segment_index": 1700, "why": "Names Mr. Ward", "strength": 5}],
            }
        if "### source_id: s2" in text:
            return {
                "themes": ["friends"],
                "moments": [
                    {"segment_index": 3, "why": "Roommates", "strength": 4},
                    {"segment_index": 3, "why": "again", "strength": 2},
                    {"segment_index": 99, "why": "not a line", "strength": 5},
                ],
            }
        return {"themes": ["teachers"], "moments": [{"segment_index": 12, "why": "Advisor", "strength": 4}]}

    monkeypatch.setattr(commands, "claude_code_json_answer", first)
    monkeypatch.setattr(
        commands, "claude_code_story", lambda *a: (_ for _ in ()).throw(AssertionError("no story"))
    )
    code, events = run(request())
    assert code == 0, events
    # 2010 lines: s1 in two parts of at most 1500, s2 in one; Sonnet at low effort.
    assert len(asked) == 3
    assert {a["model"] for a in asked} == {"claude-sonnet-5-5"} and {a["effort"] for a in asked} == {"low"}
    (result,) = [e for e in events if e["type"] == "result"]
    found = result["soundbites"]
    assert [(s["source_id"], s["text"], s["strength"]) for s in found] == [
        ("s1", "line 1700", 5),
        ("s1", "line 12", 4),
        ("s2", "line 3", 4),
    ]
    assert found[0] == {
        "source_id": "s1",
        "file": "/Volumes/Shoot/long.mp4",
        "start": 5100.0,
        "end": 5102.5,
        "speaker": "Ana",
        "text": "line 1700",
        "why": "Names Mr. Ward",
        "strength": 5,
    }
    assert (result["linesRead"], result["files"], result["reader"]) == (
        2010,
        2,
        "Claude Sonnet (subscription)",
    )
    assert set(result["themes"]) == {"teachers", "friends"}


def test_at_most_max_results_come_back(monkeypatch):
    def first(setup, system, text, schema, model, effort, should_abort):
        return {"themes": [], "moments": [{"segment_index": i, "why": "", "strength": 3} for i in range(10)]}

    monkeypatch.setattr(commands, "claude_code_json_answer", first)
    code, events = run(request(maxResults=4))
    assert code == 0
    (result,) = [e for e in events if e["type"] == "result"]
    assert len(result["soundbites"]) == 4
    assert soundbites._count(10_000) == soundbites.MAX_RESULTS and soundbites._count(None) == 40


def test_a_brief_is_needed():
    out = io.StringIO()
    try:
        commands.main(io.StringIO(json.dumps(request(prompt=" "))), Emitter(out))
    finally:
        _reset_for_tests()
    events = [json.loads(line) for line in out.getvalue().splitlines()]
    assert any(e["type"] == "error" and "what to look for" in e["message"] for e in events)
