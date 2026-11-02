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


@pytest.fixture(autouse=True)
def isolated_index_dir(monkeypatch: pytest.MonkeyPatch, tmp_path_factory: pytest.TempPathFactory) -> None:
    """No test touches the real index folder or its GPU lock (~/Library/Application Support/VibeCut
    Agent/vector-index): the workers, the titler, the critic and SigLIP 2 all take that lock. A test that
    sets VIBECUT_INDEX_DIR itself, or clears it, still can."""
    monkeypatch.setenv("VIBECUT_INDEX_DIR", str(tmp_path_factory.mktemp("vector-index")))
