"""The orchestrated chat turn (orchestrator/supervisor.py): claude_chat's loop, unchanged, with the
orchestration tools run on the bus, the read-only ones sent to the app and the rest refused; and
agent/chat.py choosing it by EXECUTION_MODE."""

from __future__ import annotations

import json

import pytest

from tests.agent.claude_fakes import install, message, text, tool_use
from tests.agent.test_chat_session import Capture, FakeStdin, run_chat
from tests.orchestrator.app import App, Worker, make_bus
from tests.orchestrator.timeline import delta, make_media, make_snapshot, op
from vibecut_agent.agent.chat_steps import ChatError
from vibecut_agent.config import OrchestratorConfig
from vibecut_agent.orchestrator.supervisor import ORCHESTRATED_INSTRUCTION, make_orchestrated_turn_runner
from vibecut_agent.orchestrator.tool_bus import ORCHESTRATOR_TOOL_NAMES

DECLARATIONS = [
    {
        "name": "list_timeline_clips",
        "description": "Clips.",
        "parameters": {"type": "OBJECT", "properties": {}},
    },
    {
        "name": "split_at_playhead",
        "description": "Split.",
        "parameters": {"type": "OBJECT", "properties": {}},
    },
    {"name": "list_markers", "description": "Markers.", "parameters": {"type": "OBJECT", "properties": {}}},
]


class AppSide:
    """The app's end of the chat: each `tool_calls` event is answered by `app`, in order."""

    def __init__(self, app, wrong_id=None):
        self.app = app
        self.wrong_id = wrong_id
        self.events = []
        self.pending = []

    def emit(self, event_type, **fields):
        self.events.append({"type": event_type, **fields})
        if event_type == "tool_calls":
            for call in fields["calls"]:
                result = self.app.answer(call["name"], call["args"])
                self.pending.append(
                    {"type": "tool_result", "id": self.wrong_id or call["id"], "result": result}
                )

    def read_tool_result(self):
        return self.pending.pop(0)

    def tool_calls(self):
        return [[(c["id"], c["name"]) for c in e["calls"]] for e in self.events if e["type"] == "tool_calls"]

    def statuses(self):
        return [e["detail"] for e in self.events if e["type"] == "status" and e.get("phase") == "tool"]


@pytest.fixture
def snapshot(tmp_path):
    return make_snapshot(make_media(tmp_path))


@pytest.fixture
def config():
    return OrchestratorConfig.from_env("orchestrated")


def turn(runner, side, user_message="go"):
    return runner(
        api_key="secret-key",
        model=None,
        system_instruction="You edit video.",
        tool_declarations=DECLARATIONS,
        history=[],
        user_message=user_message,
        emit=side.emit,
        read_tool_result=side.read_tool_result,
    )


def results_of(request):
    """The tool_result blocks the request answered the previous step with, by id: (result, is_error)."""
    blocks = request["messages"][-1]["content"]
    return {
        b["tool_use_id"]: (json.loads(b["content"]), b.get("is_error", False))
        for b in blocks
        if b.get("type") == "tool_result"
    }


def test_orchestration_runs_here_reading_goes_to_the_app_and_editing_is_refused(
    monkeypatch, config, tmp_path, snapshot
):
    client = install(
        monkeypatch,
        [
            message(
                tool_use("t1", "semantic_asset_search", {"query": "she laughs", "modality": "dialogue"}),
                tool_use("t2", "list_markers", {}),
                tool_use("t3", "split_at_playhead", {}),
                stop_reason="tool_use",
            ),
            message(text("Found the laugh.")),
        ],
    )
    vector = Worker({"hits": [{"rank": 1}]})
    side = AppSide(App(snapshot))
    runner = make_orchestrated_turn_runner(config, make_bus(config, tmp_path, vector=vector))

    outcome = turn(runner, side)

    assert outcome["text"] == "Found the laugh."
    # Only the read-only call reached the app; the search ran here, announced by a status line.
    assert side.tool_calls() == [[("t2", "list_markers")]]
    assert side.statuses() == ["Searching the media index…"]
    assert vector.calls[0][1] == ("she laughs", "dialogue")
    first = client.requests[0]
    assert [t["name"] for t in first["tools"]] == [
        "list_timeline_clips",
        "list_markers",
        *ORCHESTRATOR_TOOL_NAMES,
    ]
    assert first["system"][0]["text"] == f"You edit video.\n\n{ORCHESTRATED_INSTRUCTION}"
    answered = results_of(client.requests[1])
    assert list(answered) == ["t1", "t2", "t3"]
    assert answered["t1"] == ({"hits": [{"rank": 1}]}, False)
    assert answered["t2"] == ({"markers": []}, False)
    assert answered["t3"][1] is True
    assert "edits go through propose_otio_delta" in answered["t3"][0]["error"]


def test_a_proposal_from_one_turn_is_committed_in_the_next(monkeypatch, config, tmp_path, snapshot):
    app = App(snapshot)
    runner = make_orchestrated_turn_runner(config, make_bus(config, tmp_path))
    removal = delta(op("op_001", "DELETE_CLIP", clip_id="c2"))
    client = install(
        monkeypatch,
        [
            message(tool_use("t1", "propose_otio_delta", {"delta": removal}), stop_reason="tool_use"),
            message(text("It checks out.")),
        ],
    )
    first = AppSide(app)
    turn(runner, first, "drop the second shot")
    # The bus read the timeline through the app, as calls of its own.
    assert first.tool_calls() == [[("orch_1", "list_timelines"), ("orch_2", "list_timeline_clips")]]
    proposal, failed = results_of(client.requests[1])["t1"]
    assert proposal["valid"] is True and not failed
    token = proposal["validation_token"]

    client = install(
        monkeypatch,
        [
            message(
                tool_use(
                    "t9", "commit_otio_delta", {"validation_token": token, "commit_summary": "Drop shot two"}
                ),
                stop_reason="tool_use",
            ),
            message(text("Done.")),
        ],
    )
    second = AppSide(app)
    turn(runner, second, "do it")
    assert second.tool_calls() == [
        [("orch_3", "list_timelines"), ("orch_4", "list_timeline_clips")],
        [("orch_5", "commit_otio_delta")],
    ]
    assert app.calls[-1][1]["batch"] == proposal["translated_nle_batch"]
    assert results_of(client.requests[1])["t9"] == ({"committed": True}, False)


def test_a_broken_answer_from_the_app_ends_the_turn(monkeypatch, config, tmp_path, snapshot):
    install(
        monkeypatch,
        [
            message(
                tool_use(
                    "t1", "propose_otio_delta", {"delta": delta(op("op_001", "DELETE_CLIP", clip_id="c2"))}
                ),
                stop_reason="tool_use",
            )
        ],
    )
    runner = make_orchestrated_turn_runner(config, make_bus(config, tmp_path))
    with pytest.raises(ChatError, match="unknown call id 'nope'"):
        turn(runner, AppSide(App(snapshot), wrong_id="nope"))


# ------------------------------------------------------------------------------ agent/chat.py


def chat_request():
    return {
        "provider": "claude",
        "apiKey": "k",
        "systemInstruction": "s",
        "toolDeclarations": DECLARATIONS,
        "history": [],
        "userMessage": "hello",
    }


@pytest.mark.parametrize("mode,orchestrated", [("orchestrated", True), ("direct", False), (None, False)])
def test_the_chat_session_follows_execution_mode(monkeypatch, mode, orchestrated):
    monkeypatch.delenv("EXECUTION_MODE", raising=False)
    if mode is None:
        monkeypatch.delenv("VIBECUT_EXECUTION_MODE", raising=False)
    else:
        monkeypatch.setenv("VIBECUT_EXECUTION_MODE", mode)
    client = install(monkeypatch, [message(text("Hi."))])
    stdin = FakeStdin([json.dumps(chat_request()), json.dumps({"type": "end_session"})])
    capture = Capture()

    assert run_chat(monkeypatch, stdin, capture) == 0

    assert capture.of_type("result")[0]["text"] == "Hi."
    names = [t["name"] for t in client.requests[0]["tools"]]
    if orchestrated:
        assert names == ["list_timeline_clips", "list_markers", *ORCHESTRATOR_TOOL_NAMES]
        assert ORCHESTRATED_INSTRUCTION in client.requests[0]["system"][0]["text"]
    else:
        assert names == ["list_timeline_clips", "split_at_playhead", "list_markers"]
        assert client.requests[0]["system"][0]["text"] == "s"


def test_gemini_ignores_orchestrated_mode(monkeypatch):
    from vibecut_agent.agent import gemini_chat

    monkeypatch.setenv("VIBECUT_EXECUTION_MODE", "orchestrated")
    seen = {}

    def fake_turn(**kwargs):
        seen.update(kwargs)
        return {"text": "ok", "history": [], "usage": None, "aborted": False, "outOfSteps": False}

    monkeypatch.setattr(gemini_chat, "run_chat_turn", fake_turn)
    request = {**chat_request(), "provider": "gemini"}
    stdin = FakeStdin([json.dumps(request), json.dumps({"type": "end_session"})])
    assert run_chat(monkeypatch, stdin, Capture()) == 0
    assert seen["tool_declarations"] == DECLARATIONS
    assert seen["system_instruction"] == "s"
