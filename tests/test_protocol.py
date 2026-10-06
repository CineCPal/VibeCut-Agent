import io
import json

import pytest

from vibecut_agent.protocol import (
    Emitter,
    RequestError,
    parse_request_object,
    read_line_request,
    read_request,
    require_absolute_paths,
)


def test_emit_writes_one_json_object_per_line(recorder):
    recorder.emitter.emit("status", phase="scan")
    recorder.emitter.error("boom")
    assert recorder.events == [
        {"type": "status", "phase": "scan"},
        {"type": "error", "message": "boom"},
    ]


def test_progress_clamps_the_fraction(recorder):
    recorder.emitter.progress(5, 10, phase="analyze")
    recorder.emitter.progress(20, 10)
    recorder.emitter.progress(1, 0)
    fractions = [event["fraction"] for event in recorder.events]
    assert fractions == [0.5, 1.0, 0.0]
    assert recorder.events[0]["phase"] == "analyze"


def test_emit_ignores_a_closed_stream():
    stream = io.StringIO()
    emitter = Emitter(stream)
    stream.close()
    emitter.emit("result")  # must not raise


def test_emit_keeps_unicode_and_stringifies_unknown_types(recorder):
    recorder.emitter.emit("result", title="Café", value=object.__new__(type("X", (), {})))
    event = recorder.events[0]
    assert event["title"] == "Café"
    assert isinstance(event["value"], str)


@pytest.mark.parametrize(
    ("text", "message"),
    [
        ("", "No request"),
        ("   \n", "No request"),
        ("{not json", "not valid JSON"),
        ("[1, 2]", "must be a JSON object"),
    ],
)
def test_bad_requests_are_rejected(text, message):
    with pytest.raises(RequestError, match=message):
        parse_request_object(text)


def test_read_request_reads_to_eof():
    assert read_request(io.StringIO('{"a":\n 1}')) == {"a": 1}


def test_read_line_request_reads_one_line():
    stream = io.StringIO('{"a": 1}\n{"b": 2}\n')
    assert read_line_request(stream) == {"a": 1}
    assert json.loads(stream.readline()) == {"b": 2}


def test_require_absolute_paths():
    require_absolute_paths(["/Volumes/Media/a.mov"])
    with pytest.raises(RequestError, match="absolute"):
        require_absolute_paths(["media/a.mov"], label="clip")
