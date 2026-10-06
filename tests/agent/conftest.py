import pytest


@pytest.fixture(autouse=True)
def _forget_registered_secrets():
    """redact.py's registry is process-wide, so a test's fake key (often just "k") would otherwise be
    scrubbed out of every later test's error messages."""
    from vibecut_agent.agent import redact

    redact._reset_for_tests()
