"""`execute_otio_batch` (ORCHESTRATOR_SPEC.md §1.1, §5 Phase 5; PLAN.md, "Phase 21"): a validated OTIO
delta's bridge calls, run in the editor as one transaction.

request: {timeline, batch: [{seq, source_op_id, host, command, args}] (the validator's
          `translated_nle_batch`, in order), backup?: the request's backup when the app already made one,
          expectedTimelineHash?: the timeline's hash when the batch was validated}
result:  {backup, changes (every call's change records, oldest first), refused: [], renamed (old id -> new
          id, across the batch), executed: [{seq, sourceOpId, command, changes}]}

The batch may only use the calls orchestrator/otio_delta.py makes (BATCH_COMMANDS), all on the one
timeline. With `expectedTimelineHash`, the timeline is read first and must still hash the same
(otio_delta.timeline_hash): a commit can wait for the user's Apply, and the timeline may have changed in
the editor meanwhile. A changed one is refused before anything is touched (no backup either). A backup comes first: the app's for this request when it passes one (the batch's own
`backup_timeline` is then skipped), else one made here. Then each call runs in order through the same
edit functions the direct tools use (nle/edits.py), with the clip ids it names followed through every
`renamed` an earlier call reported (Resolve replaces a clip it reshapes or splits).

A call that fails (HostError, Unreachable) or that the editor refuses in part stops the batch, and the
changes made before it are undone with `revert_timeline_changes`, newest first, their ids followed the
same way. The error raised says which call failed, why, and how the undo went; the backup has the
timeline as it was either way. Unreachable stays Unreachable, so the watcher reports the lost editor."""

from __future__ import annotations

import copy
from collections.abc import Callable, Mapping
from typing import Any

from vibecut_agent.nle.errors import HostError, Unreachable

Edit = Callable[[Any, dict[str, Any]], Any]

BATCH_COMMANDS = (
    "backup_timeline",
    "add_clips",
    "delete_clips",
    "reshape_clip",
    "split_clips",
    "set_clip_levels",
    "set_clip_fades",
    "set_transition",
    "duck_clip",
)
# A delta has at most 200 operations, and one makes at most a few calls.
MAX_COMMANDS = 1000
MAX_HOPS = 50


def follow(item_id: Any, renamed: Mapping[str, str]) -> Any:
    """The clip's id now, after every rename since it was named."""
    for _hop in range(MAX_HOPS):
        if not isinstance(item_id, str) or item_id not in renamed:
            break
        item_id = renamed[item_id]
    return item_id


def remap(args: dict[str, Any], renamed: Mapping[str, str]) -> dict[str, Any]:
    """A call's arguments with the clip ids it names followed (itemId, itemIds, levels[].itemId)."""
    out = copy.deepcopy(args)
    if "itemId" in out:
        out["itemId"] = follow(out["itemId"], renamed)
    if isinstance(out.get("itemIds"), list):
        out["itemIds"] = [follow(i, renamed) for i in out["itemIds"]]
    if isinstance(out.get("levels"), list):
        out["levels"] = [
            {**entry, "itemId": follow(entry.get("itemId"), renamed)} if isinstance(entry, dict) else entry
            for entry in out["levels"]
        ]
    return out


def followed(changes: list[dict[str, Any]], renamed: Mapping[str, str]) -> list[dict[str, Any]]:
    """Change records with every id followed, as src/lib/agent/edits.ts's `followed` does before a revert."""

    def ids(values: Any) -> Any:
        return [follow(v, renamed) for v in values] if isinstance(values, list) else values

    out = []
    for change in changes:
        c = copy.deepcopy(change)
        for key in ("itemId", "incomingId"):
            if key in c:
                c[key] = follow(c[key], renamed)
        for key in ("itemIds", "deletedWith"):
            if key in c:
                c[key] = ids(c[key])
        for key in ("groupsBefore", "groupsAfter"):
            if isinstance(c.get(key), list):
                c[key] = [ids(group) for group in c[key]]
        if isinstance(c.get("items"), list):
            for item in c["items"]:
                for side in ("after", "right"):
                    if isinstance(item, dict) and isinstance(item.get(side), dict) and "id" in item[side]:
                        item[side]["id"] = follow(item[side]["id"], renamed)
        out.append(c)
    return out


def check_batch(batch: Any, timeline: str, edits: Mapping[str, Edit]) -> list[dict[str, Any]]:
    """The batch, or HostError: a list of known calls, numbered from 1 in order, all for `timeline`."""
    if not isinstance(batch, list) or not batch:
        raise HostError("batch must be a non-empty list of calls")
    if len(batch) > MAX_COMMANDS:
        raise HostError(f"At most {MAX_COMMANDS} calls in a batch")
    for index, entry in enumerate(batch, 1):
        if not isinstance(entry, dict) or not isinstance(entry.get("args"), dict):
            raise HostError(f"batch[{index - 1}] must be a call with args")
        command = entry.get("command")
        if command not in BATCH_COMMANDS:
            raise HostError(f"batch[{index - 1}]: {command!r} isn't a call an OTIO delta makes")
        if command not in edits:
            raise HostError(f"This editor can't run {command} from a script")
        if entry.get("seq") != index:
            raise HostError(f"batch[{index - 1}] is out of order (seq {entry.get('seq')!r})")
        named = entry["args"].get("timeline", timeline)
        if named != timeline:
            raise HostError(f"batch[{index - 1}] is for {named!r}, not {timeline!r}")
    return batch


def _roll_back(
    host: Any,
    edits: Mapping[str, Edit],
    timeline: str,
    changes: list[dict[str, Any]],
    renamed: Mapping[str, str],
    backup: str,
) -> str:
    """Undoes `changes`; says how that went."""
    keep = f'the backup "{backup}" has the timeline as it was'
    if not changes:
        return f"Nothing had changed yet; {keep}."
    try:
        result = edits["revert_timeline_changes"](
            host, {"timeline": timeline, "changes": followed(changes, renamed), "backup": backup}
        )
    except (HostError, Unreachable) as e:
        return f"Undoing the {len(changes)} change(s) before it failed too ({e}); {keep}."
    left = [*result.get("changedSince", []), *result.get("failed", [])]
    if not left:
        return f"The {len(changes)} change(s) before it were undone; {keep}."
    reasons = "; ".join(f"{c.get('name', '?')}: {c.get('reason', '?')}" for c in left[:5])
    return f"{len(left)} of the {len(changes)} change(s) before it couldn't be undone ({reasons}); {keep}."


def execute_validated_batch(host: Any, args: dict[str, Any], edits: Mapping[str, Edit]) -> dict[str, Any]:
    """Runs the batch (see the module docstring) with `edits`, the editor's edit functions."""
    timeline = args.get("timeline")
    if not isinstance(timeline, str) or not timeline:
        raise HostError("timeline must name the timeline the batch is for")
    batch = check_batch(args.get("batch"), timeline, edits)
    expected = args.get("expectedTimelineHash")
    if expected is not None:
        from vibecut_agent.orchestrator.otio_delta import timeline_hash

        if timeline_hash(host.read_timeline({"timeline": timeline})) != expected:
            raise HostError(
                f"STALE_TIMELINE_HASH: {timeline} changed after the edit was checked (while it waited for "
                "Apply?), so nothing was changed. Read the timeline again and plan the edit on what it is now."
            )
    backup = args.get("backup")
    if not isinstance(backup, str) or not backup:
        backup = str(edits["backup_timeline"](host, {"timeline": timeline})["backup"])
    calls = [entry for entry in batch if entry["command"] != "backup_timeline"]
    changes: list[dict[str, Any]] = []
    renamed: dict[str, str] = {}
    executed: list[dict[str, Any]] = []
    for entry in calls:
        command = entry["command"]
        where = f"Call {entry['seq']} of {len(batch)} ({command}, for {entry.get('source_op_id', '?')})"
        try:
            result = edits[command](host, {**remap(entry["args"], renamed), "timeline": timeline})
        except (HostError, Unreachable) as e:
            note = _roll_back(host, edits, timeline, changes, renamed, backup)
            raise type(e)(f"{where} failed: {e}. {note}") from None
        result = result if isinstance(result, dict) else {}
        made = list(result.get("changes") or [])
        changes += made
        renamed.update({str(k): str(v) for k, v in (result.get("renamed") or {}).items()})
        refused = result.get("refused") or []
        if refused:
            note = _roll_back(host, edits, timeline, changes, renamed, backup)
            reasons = "; ".join(
                str(r.get("reason", r)) if isinstance(r, dict) else str(r) for r in refused[:5]
            )
            raise HostError(f"{where} was refused in part: {reasons}. {note}")
        executed.append(
            {
                "seq": entry["seq"],
                "sourceOpId": entry.get("source_op_id"),
                "command": command,
                "changes": len(made),
            }
        )
    return {"backup": backup, "changes": changes, "refused": [], "renamed": renamed, "executed": executed}
