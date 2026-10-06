import io

from vibecut_agent import __version__, health, session
from vibecut_agent.headless import dispatch


def test_health_reports_versions(recorder):
    assert health.run(recorder.emitter, io.StringIO("{}")) == 0
    [event] = recorder.events
    assert event["type"] == "result"
    assert event["version"] == __version__
    assert event["python"].count(".") == 2


def test_session_answers_until_end_session(recorder):
    stdin = io.StringIO(
        "{}\n"
        '{"type": "ping", "id": 7}\n'
        "\n"
        "not json\n"
        '{"type": "mystery"}\n'
        '{"type": "end_session"}\n'
        '{"type": "ping", "id": 8}\n'
    )
    assert session.run(recorder.emitter, stdin) == 0
    types = [event["type"] for event in recorder.events]
    assert types == ["ready", "pong", "error", "error", "done"]
    assert recorder.events[1]["id"] == 7
    assert "mystery" in recorder.events[3]["message"]


def test_session_ends_when_stdin_closes(recorder):
    assert session.run(recorder.emitter, io.StringIO('{}\n{"type": "ping"}\n')) == 0
    assert [event["type"] for event in recorder.events] == ["ready", "pong"]


def test_dispatch_rejects_unknown_commands(recorder):
    assert dispatch("format-disk", recorder.emitter, io.StringIO("{}")) == 2
    assert recorder.events == [{"type": "error", "message": "Unknown command: format-disk"}]


def test_dispatch_reports_bad_requests(recorder):
    assert dispatch("health", recorder.emitter, io.StringIO("[]")) == 2
    assert recorder.events[0]["type"] == "error"
