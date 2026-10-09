"""premiere_organize.py -- the agent organising the Premiere project (PLAN.md, "Phase 12e"), VibeCut's
module verbatim (its "Connect page", phase 4e) but for the import paths: Premiere's side of
resolve_organize.py, with the same commands, arguments, change records and Revert.

Five commands change the project directly: `create_bins`, `move_clips`, `set_clip_labels` (the label
colour), `set_clip_metadata` (Description, Log Note, Scene, Shot, Good) and `rename_clips`. Premiere's
Undo doesn't follow scripted changes dependably (phase 4c), so each returns every change as {clipId,
field, before, after}, and `revert_pool_changes` puts the `before` back where the clip still has the
`after`. Nothing is deleted, except an empty bin a change created, when that change is reverted.

Every argument is checked before anything changes: an unknown clip, a sequence, an unknown colour or a
field that can't be set fails the whole call. What Premiere itself then refuses is listed in `refused`.

Fields: "bin" (a bin path, "<project>/B-roll"), "color" (a label colour), "metadata:<name>" (text;
Good is "true" or "false") and "name". Premiere has no flags, every item has a label (it can be changed,
not cleared), and keywords aren't offered: Premiere keeps them in the media's XMP, and VibeCut never
writes to the user's media.

What Premiere 26.5.2 does (checked live against the round-trip scratch project):
- `createBin(name)` returns the new bin and accepts any name (even with "/"; VibeCut's bridge refuses
  one, since its bin paths use "/"). Existing bins are looked up first, as with Resolve.
- `moveBin(bin)` moves an item and returns true; its nodeId stays the same.
- `setColorLabel(i)` sets the label; the Label column then reads its name.
- `setProjectMetadata(xmp, fields)` sets the logged fields in the project only: the media file's size,
  mtime and hash, and its folder, were unchanged.
- The `name` setter renames the item, not its file. `deleteBin()` removes a bin.
"""

from __future__ import annotations

from typing import Any

from vibecut_agent.nle.premiere import MAX_TEXT, HostError, PremiereHost
from vibecut_agent.nle.premiere_pool import (
    METADATA_FIELDS,
    PREMIERE_LABEL_COLORS,
    label_name,
    read_project,
)

MAX_CLIPS_PER_CALL = 500
MAX_NAME = 255


class Project:
    """One read of the project's bins and items (without usage), kept up to date as bins are made."""

    def __init__(self, host: PremiereHost) -> None:
        raw = read_project(host, {}, usage=False)
        self.root: str = raw.get("root") or "Project"
        self.bins: dict[str, str] = {}  # path -> nodeId
        for b in raw.get("bins", []):
            self.bins.setdefault(b["path"], b["id"])
        self.items: dict[str, dict[str, Any]] = {i["id"]: i for i in raw.get("items", [])}
        self.root_path = raw["bins"][0]["path"] if raw.get("bins") else self.root

    def children(self, path: str) -> list[str]:
        prefix = path + "/"
        return [p for p in self.bins if p.startswith(prefix) and "/" not in p[len(prefix) :]]


# ------------------------------------------------------------------------------- finding things


def _segments(path: Any, root_name: str) -> list[str]:
    """ "<project>/B-roll/Day 1", "B-roll/Day 1" and "/B-roll/Day 1/" alike -> ["B-roll", "Day 1"]."""
    if not isinstance(path, str) or not path.strip():
        raise HostError('A bin must be a path like "B-roll" or "B-roll/Day 1"')
    parts = [p.strip() for p in path.split("/") if p.strip()]
    if parts and parts[0].lower() == root_name.lower():
        parts = parts[1:]
    for part in parts:
        if len(part) > MAX_NAME:
            raise HostError(f"Bin name too long: {part[:40]!r}…")
    return parts


def _child(project: Project, parent: str, name: str) -> str | None:
    """The bin called `name` in `parent`: an exact match first, else one that differs only in case."""
    subs = project.children(parent)
    for sub in subs:
        if sub[len(parent) + 1 :] == name:
            return sub
    for sub in subs:
        if sub[len(parent) + 1 :].lower() == name.lower():
            return sub
    return None


def _find_folder(project: Project, path: Any) -> tuple[str, list[str]]:
    """(the deepest existing bin's path, the names still missing below it)."""
    found = project.root_path
    parts = _segments(path, project.root)
    for i, name in enumerate(parts):
        sub = _child(project, found, name)
        if sub is None:
            return found, parts[i:]
        found = sub
    return found, []


def _folder(host: PremiereHost, project: Project, path: Any, create: bool) -> tuple[str, list[str]]:
    """The bin at `path`, made (with any missing parents) when `create` is set. Returns its path and the
    paths of the bins that were made, outermost first."""
    found, missing = _find_folder(project, path)
    if missing and not create:
        raise HostError(f"There is no bin {'/'.join([found, *missing])!r}; pass create to make it")
    created: list[str] = []
    for name in missing:
        made = host._send("create_bin", {"parentId": project.bins[found], "name": name})
        found = f"{found}/{made.get('name') or name}"
        project.bins[found] = made["id"]
        created.append(found)
    return found, created


def _clips(project: Project, ids: Any) -> list[tuple[str, dict[str, Any]]]:
    """(id, item) for each id, in order and without repeats; any unknown id or sequence fails the whole
    call."""
    if not isinstance(ids, list) or not ids or not all(isinstance(i, str) and i for i in ids):
        raise HostError("clipIds must be a non-empty list of project clip ids")
    ids = list(dict.fromkeys(ids))
    if len(ids) > MAX_CLIPS_PER_CALL:
        raise HostError(f"At most {MAX_CLIPS_PER_CALL} clips at a time")
    out = []
    for clip_id in ids:
        item = project.items.get(clip_id)
        if item is None:
            raise HostError(f"There is no clip {clip_id!r} in the Premiere project any more")
        if item.get("sequence"):
            raise HostError(f"{item.get('name')!r} is a sequence, not a clip")
        out.append((clip_id, item))
    return out


def _canonical(value: Any, names: tuple[str, ...], what: str) -> str:
    if isinstance(value, str):
        for name in names:
            if name.lower() == value.strip().lower():
                return name
    raise HostError(f"Unknown {what} {value!r}; use one of {', '.join(names)}")


def _field_name(key: Any) -> str:
    """ "log note", "LogNote" and "Log Note" alike -> "Log Note"."""
    squashed = "".join(str(key).lower().split())
    for name in METADATA_FIELDS:
        if "".join(name.lower().split()) == squashed:
            return name
    settable = ", ".join(METADATA_FIELDS)
    raise HostError(f"Premiere doesn't let a script set {key!r} in the project; settable: {settable}")


def _value(name: str, value: Any) -> str:
    if name == "Good":
        if isinstance(value, bool):
            return "true" if value else "false"
        text = str(value).strip().lower() if isinstance(value, str) else None
        if text in ("true", "yes", "1"):
            return "true"
        if text in ("false", "no", "0", ""):
            return "false"
        raise HostError("Good must be true or false")
    if not isinstance(value, str):
        raise HostError(f"{name} must be text")
    return value.strip()[:MAX_TEXT]


def _result(
    changes: list[dict[str, Any]], refused: list[dict[str, Any]], created: list[str]
) -> dict[str, Any]:
    return {"changes": changes, "createdBins": created, "refused": refused}


# ------------------------------------------------------------------------------- reading a field


def _read(item: dict[str, Any], field: str) -> Any:
    if field == "bin":
        return item.get("bin")
    if field == "color":
        return label_name(item.get("label")) or ""
    if field == "name":
        return item.get("name") or ""
    if field.startswith("metadata:"):
        name = field[len("metadata:") :]
        if name not in METADATA_FIELDS:
            raise HostError(f"Unknown field {field!r}")
        value = str((item.get("columns") or {}).get(METADATA_FIELDS[name]) or "")
        return (value.lower() if value else "false") if name == "Good" else value
    raise HostError(f"Unknown field {field!r}")


def _set(host: PremiereHost, wanted: list[dict[str, Any]]) -> dict[str, dict[str, Any]]:
    """Sends set_project_items; returns each item as Premiere reads it back, by id."""
    if not wanted:
        return {}
    answer = host._send("set_project_items", {"items": wanted})
    return {item["id"]: item for item in answer.get("items", [])}


def _move(host: PremiereHost, project: Project, ids: list[str], path: str) -> set[str]:
    answer = host._send("move_project_items", {"ids": ids, "binId": project.bins[path]})
    return set(answer.get("moved") or [])


# ------------------------------------------------------------------------------- commands


def create_bins(host: PremiereHost, args: dict[str, Any]) -> dict[str, Any]:
    """{paths} -> makes each bin (and any missing parents). Bins that already exist are listed in
    `existing`, not made again."""
    paths = args.get("paths")
    if not isinstance(paths, list) or not paths or not all(isinstance(p, str) for p in paths):
        raise HostError("paths must be a non-empty list of bin paths")
    if len(paths) > 100:
        raise HostError("At most 100 bins at a time")
    project = Project(host)
    for path in paths:
        if not _segments(path, project.root):
            raise HostError(f"{path!r} is the project itself")
    created, existing = [], []
    for path in paths:
        found, made = _folder(host, project, path, create=True)
        created.extend(made)
        if not made:
            existing.append(found)
    return {"changes": [], "createdBins": created, "existing": existing, "refused": []}


def move_clips(host: PremiereHost, args: dict[str, Any]) -> dict[str, Any]:
    """{clipIds, bin, create (make the bin if it's missing)} -> moves the clips into that bin."""
    project = Project(host)
    clips = _clips(project, args.get("clipIds"))
    path, created = _folder(host, project, args.get("bin"), create=args.get("create") is True)
    moving = [(clip_id, item) for clip_id, item in clips if item.get("bin") != path]
    moved = _move(host, project, [clip_id for clip_id, _i in moving], path) if moving else set()
    changes = [
        {"clipId": clip_id, "field": "bin", "before": item.get("bin"), "after": path}
        for clip_id, item in moving
        if clip_id in moved
    ]
    refused = [
        {"clipId": clip_id, "reason": "Premiere didn't move it"}
        for clip_id, _i in moving
        if clip_id not in moved
    ]
    return _result(changes, refused, created) | {
        "alreadyThere": [clip_id for clip_id, item in clips if item.get("bin") == path]
    }


def set_clip_labels(host: PremiereHost, args: dict[str, Any]) -> dict[str, Any]:
    """{clipIds, color (a label colour)} -> sets each clip's label."""
    if args.get("addFlags") or args.get("clearFlags"):
        raise HostError("Premiere has no flags; use a label colour")
    if "color" not in args:
        raise HostError("Nothing to change: give color")
    if args["color"] in (None, "") or str(args["color"]).strip().lower() == "none":
        raise HostError("Every Premiere item has a label; it can be changed but not cleared")
    color = _canonical(args["color"], PREMIERE_LABEL_COLORS, "label colour")
    project = Project(host)
    clips = _clips(project, args.get("clipIds"))
    changing = [(clip_id, item) for clip_id, item in clips if _read(item, "color") != color]
    back = _set(
        host,
        [{"id": clip_id, "label": PREMIERE_LABEL_COLORS.index(color)} for clip_id, _i in changing],
    )
    changes, refused = [], []
    for clip_id, item in changing:
        if label_name(back.get(clip_id, {}).get("label")) == color:
            changes.append(
                {
                    "clipId": clip_id,
                    "field": "color",
                    "before": _read(item, "color"),
                    "after": color,
                }
            )
        else:
            refused.append({"clipId": clip_id, "reason": f"Premiere didn't set the label {color}"})
    return _result(changes, refused, [])


def _metadata_values(fields: Any) -> dict[str, str]:
    """The logged fields of a `fields` object, by Premiere's own names."""
    if not isinstance(fields, dict):
        raise HostError("fields must be an object of logged fields")
    values = {}
    for key, value in fields.items():
        name = _field_name(key)
        values[name] = _value(name, value)
    return values


def set_clip_metadata(host: PremiereHost, args: dict[str, Any]) -> dict[str, Any]:
    """{clipIds, fields: {Description, Log Note, Scene, Shot: text, "" to clear; Good: true/false}} ->
    sets the logged fields on each clip, in the project only. Or {perClip: {clipId: fields}} for each
    clip's own values (an analysis score, say)."""
    if args.get("keywords"):
        raise HostError(
            "Premiere keeps keywords in the media files, which VibeCut doesn't write to; "
            "put them in Description or Log Note instead"
        )
    if args.get("perClip") is not None:
        if args.get("fields") or args.get("clipIds"):
            raise HostError("Give perClip on its own, without clipIds or fields")
        raw = args["perClip"]
        if not isinstance(raw, dict) or not raw:
            raise HostError("perClip must be an object of {clipId: fields}")
        per_clip = {clip_id: _metadata_values(f) for clip_id, f in raw.items()}
        if not any(per_clip.values()):
            raise HostError("Nothing to change: give fields")
        project = Project(host)
        clips = _clips(project, list(per_clip))
    else:
        values = _metadata_values(args.get("fields") or {})
        if not values:
            raise HostError("Nothing to change: give fields")
        project = Project(host)
        clips = _clips(project, args.get("clipIds"))
        per_clip = {clip_id: values for clip_id, _item in clips}
    wanted: list[dict[str, Any]] = []
    befores: dict[str, Any] = {}
    targets: dict[str, Any] = {}
    for clip_id, item in clips:
        update = {
            name: value
            for name, value in per_clip[clip_id].items()
            if _read(item, f"metadata:{name}") != value
        }
        if update:
            targets[clip_id] = update
            befores[clip_id] = {name: _read(item, f"metadata:{name}") for name in update}
            wanted.append(
                {
                    "id": clip_id,
                    "fields": [{"key": METADATA_FIELDS[n], "value": v} for n, v in update.items()],
                }
            )
    back = _set(host, wanted)
    changes, refused = [], []
    for want in wanted:
        clip_id = want["id"]
        now = back.get(clip_id)
        failed = []
        for name, before in befores[clip_id].items():
            after = targets[clip_id][name]
            if now is not None and _read(now, f"metadata:{name}") == after:
                changes.append(
                    {
                        "clipId": clip_id,
                        "field": f"metadata:{name}",
                        "before": before,
                        "after": after,
                    }
                )
            else:
                failed.append(name)
        if failed:
            refused.append(
                {
                    "clipId": clip_id,
                    "reason": f"Premiere didn't set {', '.join(failed)}",
                }
            )
    return _result(changes, refused, [])


def rename_clips(host: PremiereHost, args: dict[str, Any]) -> dict[str, Any]:
    """{renames: [{clipId, name}]} -> renames each clip in the project. Files keep their names."""
    renames = args.get("renames")
    if not isinstance(renames, list) or not renames or not all(isinstance(r, dict) for r in renames):
        raise HostError("renames must be a non-empty list of {clipId, name}")
    names = {}
    for i, rename in enumerate(renames):
        name = rename.get("name")
        if not isinstance(name, str) or not name.strip():
            raise HostError(f"renames[{i}].name must be a non-empty name")
        if len(name.strip()) > MAX_NAME or "\n" in name or "\r" in name:
            raise HostError(f"renames[{i}].name must be one line of at most {MAX_NAME} characters")
        names[rename.get("clipId")] = name.strip()
    project = Project(host)
    clips = _clips(project, list(names))
    changing = [(clip_id, item) for clip_id, item in clips if _read(item, "name") != names[clip_id]]
    back = _set(host, [{"id": clip_id, "name": names[clip_id]} for clip_id, _i in changing])
    changes, refused = [], []
    for clip_id, item in changing:
        after = names[clip_id]
        if back.get(clip_id, {}).get("name") == after:
            changes.append(
                {
                    "clipId": clip_id,
                    "field": "name",
                    "before": _read(item, "name"),
                    "after": after,
                }
            )
        else:
            refused.append({"clipId": clip_id, "reason": f"Premiere didn't rename it to {after!r}"})
    return _result(changes, refused, [])


# ------------------------------------------------------------------------------- reverting


def _restore(host: PremiereHost, project: Project, clip_id: str, field: str, value: Any) -> bool:
    """Puts `value` back and updates the project's copy of the item to match."""
    item = project.items[clip_id]
    if field == "bin":
        path, missing = _find_folder(project, value)
        if missing or clip_id not in _move(host, project, [clip_id], path):
            return False
        item["bin"] = path
        return True
    if field == "color":
        try:
            label = PREMIERE_LABEL_COLORS.index(_canonical(value, PREMIERE_LABEL_COLORS, "label colour"))
        except HostError:
            return False
        back = _set(host, [{"id": clip_id, "label": label}]).get(clip_id)
    elif field == "name":
        back = _set(host, [{"id": clip_id, "name": str(value)}]).get(clip_id)
    else:
        name = field[len("metadata:") :]
        text = _value(name, value if value is not None else "")
        back = _set(
            host,
            [
                {
                    "id": clip_id,
                    "fields": [{"key": METADATA_FIELDS[name], "value": text}],
                }
            ],
        ).get(clip_id)
        value = text
    if back is None:
        return False
    item.update(
        name=back.get("name"),
        label=back.get("label"),
        columns=back.get("columns") or {},
    )
    return _read(item, field) == str(value)


def _same(field: str, a: Any, b: Any) -> bool:
    if field == "bin":
        return str(a or "").lower() == str(b or "").lower()
    return (a or "") == (b or "")


def revert_pool_changes(host: PremiereHost, args: dict[str, Any]) -> dict[str, Any]:
    """{changes (as the commands returned them, oldest first), createdBins} -> puts each `before` back,
    newest first, where the clip still has the `after`; a clip changed since (by hand in Premiere, or
    later by the agent) is left as it is and listed in `changedSince`. Then removes each created bin
    that's empty again, innermost first; one with something in it is kept and listed in `binsKept`."""
    changes = args.get("changes") or []
    created = args.get("createdBins") or []
    if not isinstance(changes, list) or not all(
        isinstance(c, dict) and isinstance(c.get("clipId"), str) and isinstance(c.get("field"), str)
        for c in changes
    ):
        raise HostError("changes must be a list of {clipId, field, before, after}")
    if not isinstance(created, list) or not all(isinstance(p, str) for p in created):
        raise HostError("createdBins must be a list of bin paths")
    for change in changes:
        field = change["field"]
        if field not in ("bin", "color", "name", "imported") and not (
            field.startswith("metadata:") and field[len("metadata:") :] in METADATA_FIELDS
        ):
            raise HostError(f"Unknown field {field!r}")
    project = Project(host)
    reverted, changed_since, failed = [], [], []
    for change in reversed(changes):
        clip_id, field = change["clipId"], change["field"]
        if field == "imported":
            # Premiere's scripting can't remove one project item (PLAN.md, "8c.0 probe"), and removing
            # its bin could take the clip out of sequences using it.
            failed.append(
                {
                    "clipId": clip_id,
                    "field": field,
                    "reason": "Premiere can't remove a project clip from a script; delete it in the Project panel if it isn't wanted",
                }
            )
            continue
        item = project.items.get(clip_id)
        if item is None:
            failed.append(
                {
                    "clipId": clip_id,
                    "field": field,
                    "reason": "The clip isn't in the Premiere project any more",
                }
            )
            continue
        if not _same(field, _read(item, field), change.get("after")):
            changed_since.append({"clipId": clip_id, "field": field})
            continue
        if _restore(host, project, clip_id, field, change.get("before")):
            reverted.append({"clipId": clip_id, "field": field})
        else:
            failed.append(
                {
                    "clipId": clip_id,
                    "field": field,
                    "reason": "Premiere didn't put it back",
                }
            )
    removed, kept = [], []
    for path in sorted(dict.fromkeys(created), key=lambda p: p.count("/"), reverse=True):
        found, missing = _find_folder(project, path)
        if missing:
            continue  # already gone
        inside = any(i.get("bin") == found for i in project.items.values()) or project.children(found)
        if not inside and host._send("delete_bin", {"id": project.bins[found]}).get("deleted"):
            removed.append(path)
            del project.bins[found]
        else:
            kept.append(path)
    return {
        "reverted": reverted,
        "changedSince": changed_since,
        "failed": failed,
        "binsRemoved": removed,
        "binsKept": kept,
    }
