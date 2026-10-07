"""streaming.ReplyStream (Phase 8b): deltas joined, and breaks, resets and other events kept in order."""

from vibecut_agent.agent.streaming import FLUSH_CHARS, FLUSH_SECONDS, ReplyStream


class Clock:
    def __init__(self):
        self.now = 0.0

    def __call__(self):
        return self.now


def make():
    events = []
    clock = Clock()
    stream = ReplyStream(lambda kind, **fields: events.append((kind, fields)), clock=clock)
    return stream, events, clock


def test_deltas_are_joined_until_time_or_size_says_send():
    stream, events, clock = make()
    stream.text("Hel")
    stream.text("lo")
    assert events == []
    clock.now += FLUSH_SECONDS
    stream.text(" there")
    assert events == [("reply_delta", {"text": "Hello there"})]
    stream.text("x" * FLUSH_CHARS)
    assert events[-1] == ("reply_delta", {"text": "x" * FLUSH_CHARS})


def test_any_other_event_goes_after_the_waiting_text():
    stream, events, _ = make()
    stream.text("Looking")
    stream.emit("status", detail="Running x…")
    assert events == [("reply_delta", {"text": "Looking"}), ("status", {"detail": "Running x…"})]


def test_a_break_sends_the_text_then_the_break_and_only_after_something_was_said():
    stream, events, _ = make()
    stream.brk()
    assert events == []
    stream.text("Let me look.")
    stream.brk()
    assert events == [("reply_delta", {"text": "Let me look."}), ("reply_break", {})]
    assert stream.started is False


def test_a_reset_drops_the_waiting_text():
    stream, events, _ = make()
    stream.reset()
    assert events == []
    stream.text("half an ans")
    stream.reset()
    assert events == [("reply_reset", {})]
    stream.flush()
    assert events == [("reply_reset", {})]


def test_empty_deltas_are_ignored():
    stream, events, _ = make()
    stream.text("")
    stream.brk()
    stream.flush()
    assert events == []
