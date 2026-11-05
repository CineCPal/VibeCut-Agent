"""The in-process orchestrated turn (orchestrator/supervisor.py): gemini_chat's loop, unchanged, with the
orchestration tools run on the bus, the read-only ones sent to the app and the rest refused. It is kept but
not routed to: agent/chat.py gives Gemini its own loop in either mode, and only Claude (subscription)
orchestrates, through its shim."""

from __future__ import annotations

import json

import pytest

from tests.agent.gemini_fakes import answered, call, install, message, system_text, text, tool_names
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
            for call_ in fields["calls"]:
                result = self.app.answer(call_["name"], call_["args"])
                self.pending.append(
                    {"type": "tool_result", "id": self.wrong_id or call_["id"], "result": result}
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


def test_orchestration_runs_here_reading_goes_to_the_app_and_editing_is_refused(
    monkeypatch, config, tmp_path, snapshot
):
    client = install(
        monkeypatch,
        [
            message(
                call("semantic_asset_search", {"query": "she laughs", "modality": "dialogue"}),
                call("list_markers", {}),
                call("split_at_playhead", {}),
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
    assert [[name for _id, name in batch] for batch in side.tool_calls()] == [["list_markers"]]
    assert side.statuses() == ["Searching the media index…"]
    assert vector.calls[0][1] == ("she laughs", "dialogue")
    first = client.requests[0]
    assert tool_names(first) == ["list_timeline_clips", "list_markers", *ORCHESTRATOR_TOOL_NAMES]
    assert system_text(first) == f"You edit video.\n\n{ORCHESTRATED_INSTRUCTION}"
    # Answered in the order Gemini made the calls: the bus's, the app's, the refusal.
    results = answered(client.requests[1])
    assert [name for name, _ in results] == ["semantic_asset_search", "list_markers", "split_at_playhead"]
    assert results[0][1] == {"hits": [{"rank": 1}]}
    assert results[1][1] == {"markers": []}
    assert "edits go through propose_otio_delta" in results[2][1]["error"]


def test_the_orchestration_tools_go_to_gemini_as_full_json_schema(monkeypatch, config, tmp_path, snapshot):
    client = install(monkeypatch, [message(text("Hi."))])
    runner = make_orchestrated_turn_runner(config, make_bus(config, tmp_path))

    turn(runner, AppSide(App(snapshot)))

    declarations = client.requests[0]["tools"][0]["functionDeclarations"]
    app_tools = [d for d in declarations if d["name"] not in ORCHESTRATOR_TOOL_NAMES]
    bus_tools = [d for d in declarations if d["name"] in ORCHESTRATOR_TOOL_NAMES]
    # The app's own tools keep Gemini's dialect; the bus's carry JSON Schema that `parameters` refuses.
    assert all("parameters" in d and "parametersJsonSchema" not in d for d in app_tools)
    assert all("parametersJsonSchema" in d and "parameters" not in d for d in bus_tools)
    assert "$ref" not in json.dumps([d["parametersJsonSchema"] for d in bus_tools])


def test_a_proposal_from_one_turn_is_committed_in_the_next(monkeypatch, config, tmp_path, snapshot):
    app = App(snapshot)
    runner = make_orchestrated_turn_runner(config, make_bus(config, tmp_path))
    removal = delta(op("op_001", "DELETE_CLIP", clip_id="c2"))
    client = install(
        monkeypatch,
        [message(call("propose_otio_delta", {"delta": removal})), message(text("It checks out."))],
    )
    first = AppSide(app)
    turn(runner, first, "drop the second shot")
    # The bus read the timeline through the app, as calls of its own.
    assert first.tool_calls() == [[("orch_1", "list_timelines"), ("orch_2", "list_timeline_clips")]]
    [(name, proposal)] = answered(client.requests[1])
    assert name == "propose_otio_delta" and proposal["valid"] is True
    token = proposal["validation_token"]

    client = install(
        monkeypatch,
        [
            message(
                call("commit_otio_delta", {"validation_token": token, "commit_summary": "Drop shot two"})
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
    assert answered(client.requests[1]) == [("commit_otio_delta", {"committed": True})]


def test_a_broken_answer_from_the_app_ends_the_turn(monkeypatch, config, tmp_path, snapshot):
    install(
        monkeypatch,
        [message(call("propose_otio_delta", {"delta": delta(op("op_001", "DELETE_CLIP", clip_id="c2"))}))],
    )
    runner = make_orchestrated_turn_runner(config, make_bus(config, tmp_path))
    with pytest.raises(ChatError, match="unknown call id 'nope'"):
        turn(runner, AppSide(App(snapshot), wrong_id="nope"))


# ------------------------------------------------------------------------------ agent/chat.py


def chat_request():
    return {
        "provider": "gemini",
        "apiKey": "k",
        "systemInstruction": "s",
        "toolDeclarations": DECLARATIONS,
        "history": [],
        "userMessage": "hello",
    }


@pytest.mark.parametrize("mode", ["orchestrated", "direct", None])
def test_a_gemini_chat_session_edits_directly_in_any_mode(monkeypatch, mode):
    """Only Claude (subscription) orchestrates (the user's call, 2026-11-02): Gemini keeps every tool and
    its own instruction, and gets no orchestration tools."""
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
    assert tool_names(client.requests[0]) == ["list_timeline_clips", "split_at_playhead", "list_markers"]
    assert system_text(client.requests[0]) == "s"


def test_claude_code_supervises_through_its_shim_not_this_loop(monkeypatch):
    """The subscription's Claude edits through its MCP shim (mcp_server.py), with the same instruction."""
    from vibecut_agent.agent import claude_code_chat

    monkeypatch.setenv("VIBECUT_EXECUTION_MODE", "orchestrated")
    seen = {}

    def fake_turn(setup, model, system_instruction, *args, **kwargs):
        seen.update(setup=setup, system_instruction=system_instruction)
        return {"text": "ok", "history": [], "usage": None, "aborted": False, "outOfSteps": False}

    monkeypatch.setattr(claude_code_chat, "run_chat_turn", fake_turn)
    monkeypatch.setattr(claude_code_chat, "prepare_turn", lambda *a, **k: None)
    request = {**chat_request(), "provider": "claude-code", "claudeCode": {"program": "/bin/claude"}}
    del request["apiKey"]
    stdin = FakeStdin([json.dumps(request), json.dumps({"type": "end_session"})])
    assert run_chat(monkeypatch, stdin, Capture()) == 0
    assert seen["setup"]["orchestrated"] is True
    assert seen["system_instruction"] == f"s\n\n{ORCHESTRATED_INSTRUCTION}"


def test_the_instruction_names_the_marker_and_vision_tools_this_mode_has():
    """The app's own prompt names direct-mode tools (add_markers through a delta, look_at_media); the
    orchestrated section says which ones exist here, so Claude uses them instead of giving up."""
    from vibecut_agent.orchestrator.tool_bus import FORWARDED_TOOLS

    for name in ("add_markers", "update_marker", "remove_markers"):
        assert name in FORWARDED_TOOLS
        assert name in ORCHESTRATED_INSTRUCTION
    assert "analyze_shot_visuals" in ORCHESTRATED_INSTRUCTION
    assert "look_at_media" in ORCHESTRATED_INSTRUCTION
    for name in ("look_at_clip", "look_at_timeline", "look_at_media"):
        assert name not in FORWARDED_TOOLS


# What a delta covers (vibecut.otio.delta.v1's operations); these stay out of orchestrated mode.
DELTA_EDITS = (
    "add_clips",
    "delete_clips",
    "split_clip",
    "trim_clip_start",
    "trim_clip_end",
    "slip_clip",
    "move_clip",
    "set_transition",
    "set_clip_levels",
    "duck_music",
    "close_gaps",
    "insert_clip",
    "replace_clip",
    "remove_time_ranges",
    "rearrange_sections",
)


def app_tool_names() -> set[str]:
    """Every tool the app declares (src/lib/agent/*.ts), read from the source."""
    import re
    from pathlib import Path

    names: set[str] = set()
    for path in (Path(__file__).resolve().parents[2] / "src" / "lib" / "agent").glob("*.ts"):
        if not path.name.endswith(".test.ts"):
            names.update(re.findall(r'^\s*name: "([a-z_]+)"', path.read_text(), re.MULTILINE))
    return names


def test_every_forwarded_tool_is_one_the_app_declares():
    from vibecut_agent.orchestrator.tool_bus import FORWARDED_TOOLS

    missing = sorted(set(FORWARDED_TOOLS) - app_tool_names())
    assert missing == []
    assert len(FORWARDED_TOOLS) == len(set(FORWARDED_TOOLS))


def test_cuts_stay_in_the_delta():
    from vibecut_agent.orchestrator.tool_bus import FORWARDED_TOOLS

    assert [name for name in DELTA_EDITS if name in FORWARDED_TOOLS] == []
    assert set(DELTA_EDITS) <= app_tool_names()


def test_each_forwarded_tool_but_the_pointers_has_a_studio_station():
    """The visualizer shows a forwarded call at its bay and station (TOOL_AGENTS); only the timeline reads and
    the two that just point (the playhead, a selection) go untraced."""
    from vibecut_agent.orchestrator.tool_bus import FORWARDED_TOOLS
    from vibecut_agent.telemetry.bus import SUBAGENT_TYPES
    from vibecut_agent.telemetry.instrument import TOOL_AGENTS

    untraced = {
        "list_timelines",
        "list_timeline_clips",
        "list_markers",
        "get_playhead_time",
        "get_edit_log",
        "set_playhead_time",
        "select_clip",
    }
    assert sorted(n for n in FORWARDED_TOOLS if n not in TOOL_AGENTS and n not in untraced) == []
    for name, (subagent, agent_id, _backend, label) in TOOL_AGENTS.items():
        assert subagent in SUBAGENT_TYPES, name
        assert agent_id.startswith(("worker.", "app.")), name
        assert label, name


def test_the_instruction_names_the_notes_and_the_app_reads():
    for name in ("remember_note", "forget_note", "get_transcript", "review_edit", "revert_timeline_edits"):
        assert name in ORCHESTRATED_INSTRUCTION


def test_every_traced_agent_has_a_desk_in_its_own_room_in_the_studio():
    """The visualizer's edit suite seats each agent_id at a desk in its SubagentType's room
    (apps/visualizer/src/lib/studio/stations.ts); the bus's agents must be the ones listed there."""
    import re
    from pathlib import Path

    from vibecut_agent.telemetry.instrument import ROOT_AGENT_ID, TOOL_AGENTS

    source = (Path(__file__).resolve().parents[2] / "apps/visualizer/src/lib/studio/stations.ts").read_text()
    desks = dict(re.findall(r'key: "([a-z_.]+)", subagent: "([A-Z_]+)"', source))
    assert desks[ROOT_AGENT_ID] == "MASTER_ORCHESTRATOR"
    for name, (subagent, agent_id, _backend, _label) in TOOL_AGENTS.items():
        assert desks.get(agent_id) == subagent, name
