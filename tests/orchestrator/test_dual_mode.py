"""Both execution modes end to end through agent/chat.py (ORCHESTRATOR_SPEC.md §5 Phase 5), with the
Anthropic client faked and the app's answers queued on stdin as the app would send them.

Orchestrated: Claude proposes and commits a delta in one step; the bus reads the timeline through the app,
validates and signs the delta, reads it again and forwards the validated calls, which the app runs through
the editor's `execute_otio_batch` (nle/bridge_runner.py, here with the editor's edits faked). Direct: the
same answer from Claude reaches the app call for call, as before Phase 21."""

from __future__ import annotations

import copy
import importlib.util
import json

import pytest

from tests.agent.claude_fakes import install, message, text, tool_use
from tests.agent.test_chat_session import Capture, FakeStdin, run_chat
from tests.orchestrator.app import App
from tests.orchestrator.timeline import delta, make_media, make_snapshot, op
from tests.workers.fakes import Client
from vibecut_agent.config import OrchestratorConfig
from vibecut_agent.nle import bridge_runner
from vibecut_agent.workers import gemma_validator
from vibecut_agent.workers.base import LocalLlmError

KEY = b"k" * 32
DECLARATIONS = [
    {
        "name": "list_timeline_clips",
        "description": "Clips.",
        "parameters": {"type": "OBJECT", "properties": {}},
    },
    {"name": "delete_clips", "description": "Delete.", "parameters": {"type": "OBJECT", "properties": {}}},
]


@pytest.fixture
def snapshot(tmp_path):
    return make_snapshot(make_media(tmp_path))


@pytest.fixture
def mode(monkeypatch, tmp_path):
    """Sets the execution mode; the local model server is a closed port, so no test reaches a real one."""
    monkeypatch.delenv("EXECUTION_MODE", raising=False)
    monkeypatch.setenv("VIBECUT_LOCAL_LLM_BASE_URL", "http://127.0.0.1:9")
    monkeypatch.setenv("VIBECUT_INDEX_DIR", str(tmp_path / "vector-index"))

    def set_mode(value):
        monkeypatch.setenv("VIBECUT_EXECUTION_MODE", value)

    return set_mode


def request():
    return {
        "provider": "claude",
        "apiKey": "k",
        "systemInstruction": "s",
        "toolDeclarations": DECLARATIONS,
        "history": [],
        "userMessage": "drop the second shot",
    }


def tool_result(call_id, result):
    return json.dumps({"type": "tool_result", "id": call_id, "result": result})


def results_of(claude_request):
    return {
        b["tool_use_id"]: (json.loads(b["content"]), b.get("is_error", False))
        for b in claude_request["messages"][-1]["content"]
        if b.get("type") == "tool_result"
    }


class Editor:
    """The editor's edit functions, recording each call."""

    def __init__(self):
        self.calls = []

    def edits(self):
        def run(name):
            def edit(host, args):
                self.calls.append((name, copy.deepcopy(args)))
                return {
                    "changes": [{"kind": "deleted", "itemId": i} for i in args.get("itemIds", [])],
                    "refused": [],
                }

            return edit

        return {name: run(name) for name in bridge_runner.BATCH_COMMANDS}


def test_an_orchestrated_chat_validates_commits_and_runs_the_delta(monkeypatch, mode, snapshot, tmp_path):
    mode("orchestrated")
    monkeypatch.setattr(gemma_validator.secrets, "token_bytes", lambda n: KEY)
    removal = delta(op("op_001", "DELETE_CLIP", clip_id="c2"))
    # What the sidecar's validator will answer: the same key, and no Gemma.
    expected = gemma_validator.GemmaValidator(
        OrchestratorConfig.from_env(),
        client=Client([LocalLlmError("off")]),
        key=KEY,
        media_duration=lambda p: 60.0,
    ).validate(removal, snapshot)
    token, batch = expected["validation_token"], expected["translated_nle_batch"]

    # The app: its read-only answers, and the commit run in the editor through the batch runner.
    app = App(snapshot)
    editor = Editor()
    committed = bridge_runner.execute_validated_batch(
        object(), {"timeline": "Cut", "batch": batch, "backup": "Cut (before VibeCut 1)"}, editor.edits()
    )
    reads = [app.answer("list_timelines", {}), app.answer("list_timeline_clips", {"detail": True, "includeLocked": True})]
    client = install(
        monkeypatch,
        [
            message(
                tool_use("t1", "propose_otio_delta", {"delta": removal}),
                tool_use(
                    "t2", "commit_otio_delta", {"validation_token": token, "commit_summary": "Drop shot two"}
                ),
                stop_reason="tool_use",
            ),
            message(text("Dropped the second shot.")),
        ],
    )
    stdin = FakeStdin(
        [
            json.dumps(request()),
            tool_result("orch_1", reads[0]),
            tool_result("orch_2", reads[1]),
            tool_result("orch_3", reads[0]),
            tool_result("orch_4", reads[1]),
            tool_result("orch_5", {"committed": True, "editId": "e1", **committed}),
            json.dumps({"type": "end_session"}),
        ]
    )
    capture = Capture()

    assert run_chat(monkeypatch, stdin, capture) == 0

    calls = [[(c["id"], c["name"]) for c in e["calls"]] for e in capture.of_type("tool_calls")]
    assert calls == [
        [("orch_1", "list_timelines"), ("orch_2", "list_timeline_clips")],
        [("orch_3", "list_timelines"), ("orch_4", "list_timeline_clips")],
        [("orch_5", "commit_otio_delta")],
    ]
    commit = capture.of_type("tool_calls")[2]["calls"][0]["args"]
    assert commit["validationToken"] == token
    assert commit["batch"] == batch
    assert (commit["host"], commit["timeline"], commit["commitSummary"]) == (
        "premiere",
        "Cut",
        "Drop shot two",
    )
    assert ("otioPath" in commit) == (importlib.util.find_spec("opentimelineio") is not None)
    # The editor ran the delete alone: the app's backup stood in for the batch's own.
    assert editor.calls == [("delete_clips", {"timeline": "Cut", "itemIds": ["c2"], "withLinked": False})]
    answered = results_of(client.requests[1])
    assert answered["t1"][0]["valid"] is True
    assert answered["t1"][0]["validator_model"] == "deterministic"
    assert answered["t2"] == ({"committed": True, "editId": "e1", **committed}, False)
    statuses = [e["detail"] for e in capture.of_type("status") if e.get("phase") == "tool"]
    assert statuses == ["Checking the planned edit…", "Sending the edit to the editor…"]
    assert capture.of_type("result")[0]["text"] == "Dropped the second shot."


def test_a_direct_chat_sends_claudes_calls_to_the_app_as_they_are(monkeypatch, mode, snapshot):
    mode("direct")
    removal = delta(op("op_001", "DELETE_CLIP", clip_id="c2"))
    client = install(
        monkeypatch,
        [
            message(
                tool_use("t1", "delete_clips", {"itemIds": ["c2"]}),
                tool_use("t2", "propose_otio_delta", {"delta": removal}),
                stop_reason="tool_use",
            ),
            message(text("Done.")),
        ],
    )
    stdin = FakeStdin(
        [
            json.dumps(request()),
            tool_result("t1", {"editId": "e1"}),
            tool_result("t2", {"error": "Unknown tool: propose_otio_delta"}),
            json.dumps({"type": "end_session"}),
        ]
    )
    capture = Capture()

    assert run_chat(monkeypatch, stdin, capture) == 0

    [event] = capture.of_type("tool_calls")
    assert [(c["id"], c["name"], c["args"]) for c in event["calls"]] == [
        ("t1", "delete_clips", {"itemIds": ["c2"]}),
        ("t2", "propose_otio_delta", {"delta": removal}),
    ]
    assert [t["name"] for t in client.requests[0]["tools"]] == ["list_timeline_clips", "delete_clips"]
    assert client.requests[0]["system"][0]["text"] == "s"
    assert not [e for e in capture.of_type("status") if e.get("phase") == "tool"]
    assert results_of(client.requests[1])["t1"] == ({"editId": "e1"}, False)


@pytest.mark.parametrize("value,orchestrated", [("orchestrated", True), ("direct", False)])
def test_the_subscriptions_claude_follows_execution_mode(monkeypatch, mode, value, orchestrated):
    """Claude (subscription): its shim runs the tool bus (mcp_server.py), and its prompt says how to edit."""
    from vibecut_agent.agent import claude_code_chat
    from vibecut_agent.orchestrator.supervisor import ORCHESTRATED_INSTRUCTION

    mode(value)
    seen = {}

    def fake_turn(setup, model, system_instruction, *args, **kwargs):
        seen["turn"] = (setup, system_instruction)
        return {"text": "ok", "history": [], "usage": None, "aborted": False, "outOfSteps": False}

    def fake_prepare(launcher, setup, model, system_instruction, *args):
        seen["prepared"] = (setup, system_instruction)

    monkeypatch.setattr(claude_code_chat, "run_chat_turn", fake_turn)
    monkeypatch.setattr(claude_code_chat, "prepare_turn", fake_prepare)
    subscription = {**request(), "provider": "claude-code", "claudeCode": {"jobId": "job-1"}}
    stdin = FakeStdin([json.dumps(subscription), json.dumps({"type": "end_session"})])
    assert run_chat(monkeypatch, stdin, Capture()) == 0

    for setup, instruction in (seen["turn"], seen["prepared"]):
        if orchestrated:
            assert setup == {"jobId": "job-1", "orchestrated": True}
            assert instruction == f"s\n\n{ORCHESTRATED_INSTRUCTION}"
        else:
            assert setup == {"jobId": "job-1"}
            assert instruction == "s"
