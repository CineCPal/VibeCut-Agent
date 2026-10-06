"""tests/test_redact.py — the process-wide secret scrubber (see backend/redact.py)."""

import io

from vibecut_agent.agent import redact


def test_scrub_removes_registered_and_extra_secrets():
    redact.register_secret("  registered-key-123  ")

    text = redact.scrub("a registered-key-123 and an extra-key-456", "extra-key-456")

    assert text == "a [REDACTED] and an [REDACTED]"


def test_empty_or_non_string_secrets_are_ignored():
    for value in ("", "   ", None, 42):
        redact.register_secret(value)

    assert redact.scrub("nothing to hide", "", None) == "nothing to hide"


def test_a_longer_secret_containing_a_shorter_one_is_removed_whole():
    redact.register_secret("abc")
    redact.register_secret("abcdef")

    assert redact.scrub("x abcdef y") == "x [REDACTED] y"


def test_scrub_accepts_an_exception():
    redact.register_secret("key-in-exception")

    assert redact.scrub(ValueError("failed with key-in-exception")) == "failed with [REDACTED]"


def test_print_scrubbed_exc_never_writes_the_key():
    redact.register_secret("traceback-key-789")
    out = io.StringIO()

    try:
        raise RuntimeError("request failed: traceback-key-789")
    except RuntimeError:
        redact.print_scrubbed_exc(file=out)

    assert "traceback-key-789" not in out.getvalue()
    assert "RuntimeError: request failed: [REDACTED]" in out.getvalue()
