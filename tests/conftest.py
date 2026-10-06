import io
import json
from typing import Any

import pytest

from vibecut_agent.protocol import Emitter


class Recorder:
    """An Emitter target that keeps every event it was sent."""

    def __init__(self) -> None:
        self.stream = io.StringIO()
        self.emitter = Emitter(self.stream)

    @property
    def events(self) -> list[dict[str, Any]]:
        return [json.loads(line) for line in self.stream.getvalue().splitlines()]


@pytest.fixture
def recorder() -> Recorder:
    return Recorder()
