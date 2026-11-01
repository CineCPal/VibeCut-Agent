"""A validated OTIO delta's calls run as one transaction (nle/bridge_runner.py), with the editor's edit
functions faked: backup first, ids followed through renames, and the changes undone when a call fails."""

from __future__ import annotations

import pytest

from vibecut_agent.nle import bridge_runner
from vibecut_agent.nle.edits import premiere_edits, resolve_edits
from vibecut_agent.nle.errors import HostError, Unreachable

HOST = object()


class Editor:
    """Edit functions that record their calls. `answers[command]` is a result, an exception to raise, or a
    callable of the args; anything else answers {changes: [one record], refused: []}."""

    def __init__(self, **answers):
        self.answers = answers
        self.calls = []

    def edits(self):
        names = [*bridge_runner.BATCH_COMMANDS, "revert_timeline_changes"]
        return {name: self._edit(name) for name in names if self.answers.get(name) is not False}

    def _edit(self, name):
        def run(host, args):
            assert host is HOST
            self.calls.append((name, args))
            answer = self.answers.get(name)
            if isinstance(answer, Exception):
                raise answer
            if callable(answer):
                return answer(args)
            if answer is not None:
                return answer
            if name == "backup_timeline":
                return {"backup": "Cut (before VibeCut 1)"}
            if name == "revert_timeline_changes":
                return {"reverted": args["changes"], "changedSince": [], "failed": [], "lost": []}
            return {"changes": [{"kind": name, "itemId": args.get("itemId")}], "refused": []}

        return run

    def names(self):
        return [name for name, _ in self.calls]


def call(seq, command, op="op_001", **args):
    return {
        "seq": seq,
        "source_op_id": op,
        "host": "resolve",
        "command": command,
        "args": {"timeline": "Cut", **args},
    }


def batch(*calls):
    return [call(1, "backup_timeline", "backup"), *calls]


def run(editor, calls, **extra):
    return bridge_runner.execute_validated_batch(
        HOST, {"timeline": "Cut", "batch": calls, **extra}, editor.edits()
    )


def test_the_calls_run_in_order_after_a_backup():
    editor = Editor()
    calls = batch(
        call(2, "delete_clips", itemIds=["c2"], withLinked=False),
        call(3, "set_clip_levels", "op_002", levels=[{"itemId": "a1", "volumeDb": -6}]),
    )
    result = run(editor, calls)
    assert editor.names() == ["backup_timeline", "delete_clips", "set_clip_levels"]
    assert editor.calls[1][1] == {"timeline": "Cut", "itemIds": ["c2"], "withLinked": False}
    assert result == {
        "backup": "Cut (before VibeCut 1)",
        "changes": [{"kind": "delete_clips", "itemId": None}, {"kind": "set_clip_levels", "itemId": None}],
        "refused": [],
        "renamed": {},
        "executed": [
            {"seq": 2, "sourceOpId": "op_001", "command": "delete_clips", "changes": 1},
            {"seq": 3, "sourceOpId": "op_002", "command": "set_clip_levels", "changes": 1},
        ],
    }


def test_the_apps_backup_for_the_request_is_used_instead():
    editor = Editor()
    result = run(editor, batch(call(2, "delete_clips", itemIds=["c2"])), backup="Cut (before VibeCut 3)")
    assert editor.names() == ["delete_clips"]
    assert result["backup"] == "Cut (before VibeCut 3)"


def test_ids_are_followed_through_renames():
    # Resolve replaces a clip it splits: c1 becomes c1b, which a later trim then replaces with c1c.
    editor = Editor(
        split_clips={"changes": [{"kind": "split", "itemId": "c1"}], "refused": [], "renamed": {"c1": "c1b"}},
        reshape_clip=lambda args: {
            "changes": [{"kind": "reshaped", "itemId": args["itemId"]}],
            "refused": [],
            "renamed": {args["itemId"]: "c1c"},
        },
    )
    calls = batch(
        call(2, "split_clips", itemIds=["c1"], time=2.0),
        call(3, "reshape_clip", "op_002", itemId="c1", sourceOut=11.0),
        call(4, "set_clip_levels", "op_003", levels=[{"itemId": "c1", "volumeDb": -3}]),
        call(5, "set_transition", "op_004", itemId="c1", kind="dissolve", seconds=0.4),
    )
    result = run(editor, calls)
    assert editor.calls[2][1]["itemId"] == "c1b"
    assert editor.calls[3][1]["levels"] == [{"itemId": "c1c", "volumeDb": -3}]
    assert editor.calls[4][1]["itemId"] == "c1c"
    assert result["renamed"] == {"c1": "c1b", "c1b": "c1c"}


def test_a_failing_call_undoes_the_ones_before_it():
    editor = Editor(
        split_clips={"changes": [{"kind": "split", "itemId": "c1"}], "refused": [], "renamed": {"c1": "c1b"}},
        set_transition=HostError("Resolve couldn't add the dissolve"),
    )
    calls = batch(
        call(2, "split_clips", itemIds=["c1"], time=2.0),
        call(3, "reshape_clip", "op_002", itemId="c1", sourceOut=11.0),
        call(4, "set_transition", "op_003", itemId="c1", kind="dissolve", seconds=0.4),
        call(5, "delete_clips", "op_004", itemIds=["c2"]),
    )
    with pytest.raises(HostError) as raised:
        run(editor, calls)
    assert str(raised.value) == (
        "Call 4 of 5 (set_transition, for op_003) failed: Resolve couldn't add the dissolve. The 2 change(s) "
        'before it were undone; the backup "Cut (before VibeCut 1)" has the timeline as it was.'
    )
    assert editor.names() == [
        "backup_timeline",
        "split_clips",
        "reshape_clip",
        "set_transition",
        "revert_timeline_changes",
    ]
    revert = editor.calls[-1][1]
    # Oldest first, ids followed to what the clips are called now.
    assert revert == {
        "timeline": "Cut",
        "changes": [{"kind": "split", "itemId": "c1b"}, {"kind": "reshape_clip", "itemId": "c1b"}],
        "backup": "Cut (before VibeCut 1)",
    }


def test_a_lost_editor_stays_unreachable_and_says_where_the_backup_is():
    editor = Editor(
        reshape_clip=Unreachable("Premiere Pro stopped answering."),
        revert_timeline_changes=Unreachable("Premiere Pro stopped answering."),
    )
    calls = batch(
        call(2, "delete_clips", itemIds=["c2"]), call(3, "reshape_clip", "op_002", itemId="c1", start=1.0)
    )
    with pytest.raises(Unreachable) as raised:
        run(editor, calls)
    assert "Call 3 of 3 (reshape_clip, for op_002) failed: Premiere Pro stopped answering." in str(
        raised.value
    )
    assert "Undoing the 1 change(s) before it failed too" in str(raised.value)
    assert '"Cut (before VibeCut 1)" has the timeline as it was' in str(raised.value)


def test_a_partial_refusal_is_a_failure_too():
    editor = Editor(
        delete_clips={
            "changes": [{"kind": "deleted", "itemId": "c2"}],
            "refused": [{"itemId": "a2", "reason": "Premiere didn't remove it"}],
        },
        revert_timeline_changes=lambda args: {
            "reverted": [],
            "changedSince": [{"name": "b.mov", "reason": "it was moved since"}],
            "failed": [],
            "lost": [],
        },
    )
    with pytest.raises(HostError) as raised:
        run(editor, batch(call(2, "delete_clips", itemIds=["c2", "a2"])))
    assert str(raised.value) == (
        "Call 2 of 2 (delete_clips, for op_001) was refused in part: Premiere didn't remove it. 1 of the 1 "
        'change(s) before it couldn\'t be undone (b.mov: it was moved since); the backup "Cut (before VibeCut 1)" '
        "has the timeline as it was."
    )


def test_a_first_call_failing_has_nothing_to_undo():
    editor = Editor(delete_clips=HostError("There's no clip c9"))
    with pytest.raises(HostError, match="Nothing had changed yet"):
        run(editor, batch(call(2, "delete_clips", itemIds=["c9"])))
    assert "revert_timeline_changes" not in editor.names()


@pytest.mark.parametrize(
    "calls,message",
    [
        ([], "batch must be a non-empty list"),
        ([call(1, "nest_clips")], "'nest_clips' isn't a call an OTIO delta makes"),
        ([call(2, "delete_clips", itemIds=["c1"])], "out of order"),
        ([{**call(1, "delete_clips"), "args": {"timeline": "Other"}}], "is for 'Other', not 'Cut'"),
        ([call(1, "duck_clip", itemId="m1")], "This editor can't run duck_clip"),
    ],
)
def test_a_batch_that_isnt_a_validated_one_is_refused_before_anything_runs(calls, message):
    editor = Editor(duck_clip=False)
    with pytest.raises(HostError, match=message):
        run(editor, calls)
    assert editor.calls == []


def test_both_editors_register_the_batch():
    assert "execute_otio_batch" in premiere_edits()
    assert "execute_otio_batch" in resolve_edits()
    # Resolve can't duck from a script, so the validator never sends it duck_clip (otio_delta.py).
    assert "duck_clip" not in resolve_edits()
