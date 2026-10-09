"""resolve_organize.py -- the agent organising the Media Pool (PLAN.md, "Phase 12e"), VibeCut's module
verbatim (its "Connect page", phase 3b) but for the import paths.

Five commands change the project directly: `create_bins`, `move_clips`, `set_clip_labels` (clip
colour and flags), `set_clip_metadata` (logged fields and keywords) and `rename_clips`. Resolve's API
has no undo, so each returns every change as {clipId, field, before, after}, and
`revert_pool_changes` puts the `before` back where the clip still has the `after`. Nothing is
deleted, except an empty bin a change created, when that change is reverted.

Every argument is checked before anything changes: an unknown clip, a timeline, an unknown colour or a
field that can't be set fails the whole call. What Resolve itself then refuses is listed in `refused`.

Fields: "bin" (a bin path, "Master/B-roll"), "color" ("" for none), "flags" (a list of colours),
"metadata:<key>" (text) and "name".

What Resolve 21.1 does (checked live against a scratch project):
- `MediaPool.AddSubFolder(parent, name)` makes a second bin with the same name if asked, so existing
  bins are looked up first.
- `MediaPool.MoveClips(items, folder)` returns True; the items stay valid after the move.
- `SetClipColor` takes any case ("orange") and returns False for an unknown colour; `GetClipColor`
  is "" for none; `ClearClipColor` returns True even with no colour set.
- `AddFlag` takes any case, returns False for an unknown colour and adds a flag only once;
  `ClearFlags("All")` clears every flag; `GetFlagList` lists them.
- `SetMetadata({...})` sets Keywords, Comments, Description, Scene, Shot, Take, Angle, "Camera #" and
  "Reel Name"; "" clears one. "Good Take" is refused (False). Keywords are stored as given ("bread,
  oven" keeps its space).
- `MediaPoolItem.SetName` renames the clip (not the file) and reports honestly; it refuses "".
  `SetClipProperty("Clip Name", ...)` renames too, but returns False even when it worked.
- `MediaPool.DeleteFolders([folder])` removes a bin (only called here on an empty one).
"""

from __future__ import annotations

from typing import Any

from vibecut_agent.nle.resolve import MAX_TEXT, RESOLVE_MARKER_COLORS, HostError
from vibecut_agent.nle.resolve_pool import _walk

MAX_CLIPS_PER_CALL = 500
MAX_NAME = 255
CLIP_COLORS = (
    "Orange", "Apricot", "Yellow", "Lime", "Olive", "Green", "Teal", "Navy",
    "Blue", "Purple", "Violet", "Pink", "Tan", "Beige", "Brown", "Chocolate",
)  # fmt: skip
FLAG_COLORS = RESOLVE_MARKER_COLORS
# The logged fields Resolve lets a script set ("Good Take" can be read but not set; Keywords have
# their own argument).
SETTABLE_METADATA = (
    "Comments",
    "Description",
    "Scene",
    "Shot",
    "Take",
    "Angle",
    "Camera #",
    "Reel Name",
)


# ------------------------------------------------------------------------------- finding things


def _root(media_pool: Any) -> tuple[Any, str]:
    root = media_pool.GetRootFolder()
    return root, root.GetName() or "Master"


def _segments(path: Any, root_name: str) -> list[str]:
    """ "Master/B-roll/Day 1", "B-roll/Day 1" and "/B-roll/Day 1/" alike -> ["B-roll", "Day 1"]."""
    if not isinstance(path, str) or not path.strip():
        raise HostError('A bin must be a path like "B-roll" or "Master/B-roll/Day 1"')
    parts = [p.strip() for p in path.split("/") if p.strip()]
    if parts and parts[0].lower() == root_name.lower():
        parts = parts[1:]
    for part in parts:
        if len(part) > MAX_NAME:
            raise HostError(f"Bin name too long: {part[:40]!r}…")
    return parts


def _child(folder: Any, name: str) -> Any:
    """The subfolder called `name`: an exact match first, else one that differs only in case."""
    subs = folder.GetSubFolderList() or []
    for sub in subs:
        if sub.GetName() == name:
            return sub
    for sub in subs:
        if (sub.GetName() or "").lower() == name.lower():
            return sub
    return None


def _find_folder(media_pool: Any, path: Any) -> tuple[Any, str, list[str]]:
    """(the deepest existing folder, its path, the names still missing below it)."""
    root, root_name = _root(media_pool)
    folder, found = root, root_name
    parts = _segments(path, root_name)
    for i, name in enumerate(parts):
        sub = _child(folder, name)
        if sub is None:
            return folder, found, parts[i:]
        folder, found = sub, f"{found}/{sub.GetName()}"
    return folder, found, []


def _folder(media_pool: Any, path: Any, create: bool) -> tuple[Any, str, list[str]]:
    """The bin at `path`, made (with any missing parents) when `create` is set. Returns the folder,
    its path, and the paths of the bins that were made, outermost first."""
    folder, found, missing = _find_folder(media_pool, path)
    if missing and not create:
        raise HostError(f"There is no bin {'/'.join([found, *missing])!r}; pass create to make it")
    created: list[str] = []
    for name in missing:
        sub = media_pool.AddSubFolder(folder, name)
        if not sub:
            raise HostError(f"Resolve didn't create the bin {name!r} in {found!r}")
        folder, found = sub, f"{found}/{sub.GetName()}"
        created.append(found)
    return folder, found, created


def _index(media_pool: Any) -> dict[str, tuple[str, Any]]:
    return {clip.GetUniqueId(): (bin_path, clip) for bin_path, clip in _walk(media_pool)}


def _clips(index: dict[str, tuple[str, Any]], ids: Any) -> list[tuple[str, str, Any]]:
    """(id, bin path, clip) for each id, in order and without repeats; any unknown id or timeline fails
    the whole call."""
    if not isinstance(ids, list) or not ids or not all(isinstance(i, str) and i for i in ids):
        raise HostError("clipIds must be a non-empty list of Media Pool clip ids")
    ids = list(dict.fromkeys(ids))
    if len(ids) > MAX_CLIPS_PER_CALL:
        raise HostError(f"At most {MAX_CLIPS_PER_CALL} clips at a time")
    out = []
    for clip_id in ids:
        if clip_id not in index:
            raise HostError(f"There is no Media Pool clip {clip_id!r} any more")
        bin_path, clip = index[clip_id]
        if (clip.GetClipProperty("Type") or "") == "Timeline":
            raise HostError(f"{clip.GetName()!r} is a timeline, not a clip")
        out.append((clip_id, bin_path, clip))
    return out


def _canonical(value: Any, names: tuple[str, ...], what: str) -> str:
    if isinstance(value, str):
        for name in names:
            if name.lower() == value.strip().lower():
                return name
    raise HostError(f"Unknown {what} {value!r}; use one of {', '.join(names)}")


def _flag_list(value: Any, field: str, allow_all: bool = False) -> list[str]:
    if value is None:
        return []
    if not isinstance(value, list):
        raise HostError(f"{field} must be a list of flag colours")
    if allow_all and any(isinstance(v, str) and v.strip().lower() == "all" for v in value):
        return ["All"]
    return list(dict.fromkeys(_canonical(v, FLAG_COLORS, "flag colour") for v in value))


def _text(value: Any, field: str) -> str:
    if not isinstance(value, str):
        raise HostError(f"{field} must be text")
    return value.strip()[:MAX_TEXT]


def _keywords(value: str) -> list[str]:
    return [k.strip() for k in (value or "").split(",") if k.strip()]


def _keyword_list(value: Any, field: str) -> list[str]:
    if value is None:
        return []
    if isinstance(value, str):
        value = _keywords(value)
    if not isinstance(value, list) or not all(isinstance(k, str) for k in value):
        raise HostError(f"{field} must be a list of keywords")
    words = [k.strip() for k in value if k.strip()]
    if any("," in k for k in words):
        raise HostError("A keyword can't contain a comma")
    return words


def _result(
    changes: list[dict[str, Any]], refused: list[dict[str, Any]], created: list[str]
) -> dict[str, Any]:
    return {"changes": changes, "createdBins": created, "refused": refused}


# ------------------------------------------------------------------------------- reading a field


def _read(clip: Any, field: str, index: dict[str, tuple[str, Any]] | None = None) -> Any:
    if field == "bin":
        return index[clip.GetUniqueId()][0] if index and clip.GetUniqueId() in index else None
    if field == "color":
        return clip.GetClipColor() or ""
    if field == "flags":
        return list(clip.GetFlagList() or [])
    if field == "name":
        return clip.GetName() or ""
    if field.startswith("metadata:"):
        metadata = clip.GetMetadata() or {}
        return str(metadata.get(field[len("metadata:") :]) or "") if isinstance(metadata, dict) else ""
    raise HostError(f"Unknown field {field!r}")


def _set_flags(clip: Any, flags: list[str]) -> bool:
    ok = bool(clip.ClearFlags("All"))
    for flag in flags:
        ok = bool(clip.AddFlag(flag)) and ok
    return ok


def _set_color(clip: Any, color: str) -> bool:
    return bool(clip.SetClipColor(color)) if color else bool(clip.ClearClipColor())


def _rename(clip: Any, name: str) -> bool:
    if hasattr(clip, "SetName"):
        return bool(clip.SetName(name))
    # Older versions: SetClipProperty renames but reports False, so read the name back.
    clip.SetClipProperty("Clip Name", name)
    return clip.GetName() == name


# ------------------------------------------------------------------------------- commands


def create_bins(host: Any, args: dict[str, Any]) -> dict[str, Any]:
    """{paths} -> makes each bin (and any missing parents). Bins that already exist are listed in
    `existing`, not made again."""
    paths = args.get("paths")
    if not isinstance(paths, list) or not paths or not all(isinstance(p, str) for p in paths):
        raise HostError("paths must be a non-empty list of bin paths")
    if len(paths) > 100:
        raise HostError("At most 100 bins at a time")
    media_pool = host._project().GetMediaPool()
    _root_folder, root_name = _root(media_pool)
    for path in paths:
        if not _segments(path, root_name):
            raise HostError(f"{path!r} is the Master bin itself")
    created, existing = [], []
    for path in paths:
        _folder_obj, found, made = _folder(media_pool, path, create=True)
        created.extend(made)
        if not made:
            existing.append(found)
    return {"changes": [], "createdBins": created, "existing": existing, "refused": []}


def move_clips(host: Any, args: dict[str, Any]) -> dict[str, Any]:
    """{clipIds, bin, create (make the bin if it's missing)} -> moves the clips into that bin."""
    media_pool = host._project().GetMediaPool()
    index = _index(media_pool)
    clips = _clips(index, args.get("clipIds"))
    folder, path, created = _folder(media_pool, args.get("bin"), create=args.get("create") is True)
    moving = [(clip_id, bin_path, clip) for clip_id, bin_path, clip in clips if bin_path != path]
    changes, refused = [], []
    if moving and not media_pool.MoveClips([clip for _i, _b, clip in moving], folder):
        refused = [{"clipId": clip_id, "reason": "Resolve didn't move it"} for clip_id, _b, _c in moving]
    else:
        changes = [
            {"clipId": clip_id, "field": "bin", "before": bin_path, "after": path}
            for clip_id, bin_path, _clip in moving
        ]
    return _result(changes, refused, created) | {
        "alreadyThere": [clip_id for clip_id, bin_path, _c in clips if bin_path == path]
    }


def set_clip_labels(host: Any, args: dict[str, Any]) -> dict[str, Any]:
    """{clipIds, color (a clip colour, or null/"" to clear; leave it out to keep), addFlags,
    clearFlags (flag colours, or ["All"])} -> sets each clip's colour and flags."""
    has_color = "color" in args
    color = ""
    if has_color and args["color"] not in (None, ""):
        color = _canonical(args["color"], CLIP_COLORS, "clip colour")
    add = _flag_list(args.get("addFlags"), "addFlags")
    clear = _flag_list(args.get("clearFlags"), "clearFlags", allow_all=True)
    if not has_color and not add and not clear:
        raise HostError("Nothing to change: give color, addFlags or clearFlags")
    media_pool = host._project().GetMediaPool()
    clips = _clips(_index(media_pool), args.get("clipIds"))
    changes, refused = [], []
    for clip_id, _bin, clip in clips:
        if has_color:
            before = _read(clip, "color")
            if before != color:
                if _set_color(clip, color):
                    changes.append(
                        {
                            "clipId": clip_id,
                            "field": "color",
                            "before": before,
                            "after": color,
                        }
                    )
                else:
                    refused.append(
                        {
                            "clipId": clip_id,
                            "reason": f"Resolve didn't set the clip colour {color or '(none)'}",
                        }
                    )
        if add or clear:
            before = _read(clip, "flags")
            kept = [] if clear == ["All"] else [f for f in before if f not in clear]
            after = kept + [f for f in add if f not in kept]
            if after != before:
                if _set_flags(clip, after):
                    changes.append(
                        {
                            "clipId": clip_id,
                            "field": "flags",
                            "before": before,
                            "after": _read(clip, "flags"),
                        }
                    )
                else:
                    refused.append({"clipId": clip_id, "reason": "Resolve didn't set the flags"})
    return _result(changes, refused, [])


def _metadata_values(fields: Any) -> dict[str, str]:
    """The settable logged fields of a `fields` object, by Resolve's own names."""
    if not isinstance(fields, dict):
        raise HostError("fields must be an object of logged fields")
    values: dict[str, str] = {}
    for key, value in fields.items():
        name = next(
            (k for k in SETTABLE_METADATA if k.lower() == str(key).strip().lower()),
            None,
        )
        if name is None:
            settable = ", ".join(SETTABLE_METADATA)
            raise HostError(
                f"Resolve doesn't let a script set {key!r}; settable: {settable} (keywords have their own argument)"
            )
        values[name] = _text(value, name)
    return values


def _per_clip(raw: Any, parse: Any) -> dict[str, Any]:
    """`perClip`: {clipId: fields}, each clip's own values (an analysis score, say), parsed by `parse`."""
    if not isinstance(raw, dict) or not raw:
        raise HostError("perClip must be an object of {clipId: fields}")
    out = {clip_id: parse(fields) for clip_id, fields in raw.items()}
    if not any(out.values()):
        raise HostError("Nothing to change: give fields")
    return out


def set_clip_metadata(host: Any, args: dict[str, Any]) -> dict[str, Any]:
    """{clipIds, fields: {Comments, Description, Scene, ...: text, "" to clear}, keywords: {add, remove,
    replace}} -> sets the logged fields on each clip. Or {perClip: {clipId: fields}} for each clip's own
    values (no keywords then)."""
    if args.get("perClip") is not None:
        if args.get("keywords") or args.get("fields") or args.get("clipIds"):
            raise HostError("Give perClip on its own, without clipIds, fields or keywords")
        per_clip = _per_clip(args["perClip"], _metadata_values)
        args = {"clipIds": list(per_clip)}
    else:
        per_clip = None
    values = _metadata_values(args.get("fields") or {})
    keywords = args.get("keywords") or {}
    if not isinstance(keywords, dict):
        raise HostError("keywords must be an object with add, remove or replace")
    replace = "replace" in keywords
    replace_with = _keyword_list(keywords.get("replace"), "keywords.replace")
    add = _keyword_list(keywords.get("add"), "keywords.add")
    remove = {k.lower() for k in _keyword_list(keywords.get("remove"), "keywords.remove")}
    if per_clip is None and not values and not replace and not add and not remove:
        raise HostError("Nothing to change: give fields or keywords")
    media_pool = host._project().GetMediaPool()
    clips = _clips(_index(media_pool), args.get("clipIds"))
    changes: list[dict[str, Any]] = []
    refused: list[dict[str, Any]] = []
    for clip_id, _bin, clip in clips:
        update: dict[str, str] = {}
        befores: dict[str, str] = {}
        for name, value in (per_clip[clip_id] if per_clip else values).items():
            before = _read(clip, f"metadata:{name}")
            if before != value:
                update[name], befores[name] = value, before
        if replace or add or remove:
            before = _read(clip, "metadata:Keywords")
            words = replace_with if replace else _keywords(before)
            words = [w for w in words if w.lower() not in remove]
            for word in add:
                if word.lower() not in {w.lower() for w in words}:
                    words.append(word)
            after = ",".join(dict.fromkeys(words))
            if after != before and _keywords(after) != _keywords(before):
                update["Keywords"], befores["Keywords"] = after, before
        if not update:
            continue
        if clip.SetMetadata(update):
            changes.extend(
                {
                    "clipId": clip_id,
                    "field": f"metadata:{name}",
                    "before": befores[name],
                    "after": value,
                }
                for name, value in update.items()
            )
        else:
            refused.append({"clipId": clip_id, "reason": f"Resolve didn't set {', '.join(update)}"})
    return _result(changes, refused, [])


def rename_clips(host: Any, args: dict[str, Any]) -> dict[str, Any]:
    """{renames: [{clipId, name}]} -> renames each clip in the Media Pool. Files keep their names."""
    renames = args.get("renames")
    if not isinstance(renames, list) or not renames or not all(isinstance(r, dict) for r in renames):
        raise HostError("renames must be a non-empty list of {clipId, name}")
    names = {}
    for i, rename in enumerate(renames):
        name = rename.get("name")
        if not isinstance(name, str) or not name.strip():
            raise HostError(f"renames[{i}].name must be a non-empty name")
        if len(name.strip()) > MAX_NAME or "\n" in name:
            raise HostError(f"renames[{i}].name must be one line of at most {MAX_NAME} characters")
        names[rename.get("clipId")] = name.strip()
    media_pool = host._project().GetMediaPool()
    clips = _clips(_index(media_pool), list(names))
    changes, refused = [], []
    for clip_id, _bin, clip in clips:
        before, after = _read(clip, "name"), names[clip_id]
        if before == after:
            continue
        if _rename(clip, after):
            changes.append({"clipId": clip_id, "field": "name", "before": before, "after": after})
        else:
            refused.append({"clipId": clip_id, "reason": f"Resolve didn't rename it to {after!r}"})
    return _result(changes, refused, [])


# ------------------------------------------------------------------------------- reverting


def _restore(media_pool: Any, clip: Any, field: str, value: Any) -> bool:
    if field == "bin":
        folder, _path, missing = _find_folder(media_pool, value)
        if missing:
            return False
        return bool(media_pool.MoveClips([clip], folder))
    if field == "color":
        return _set_color(clip, str(value or ""))
    if field == "flags":
        return _set_flags(clip, [str(f) for f in value or []])
    if field == "name":
        return _rename(clip, str(value))
    return bool(clip.SetMetadata({field[len("metadata:") :]: str(value or "")}))


def _same(field: str, a: Any, b: Any) -> bool:
    if field == "flags":
        return sorted(a or []) == sorted(b or [])
    if field == "metadata:Keywords":
        return [k.lower() for k in _keywords(a)] == [k.lower() for k in _keywords(b)]
    if field == "bin":
        return str(a or "").lower() == str(b or "").lower()
    return (a or "") == (b or "")


def revert_pool_changes(host: Any, args: dict[str, Any]) -> dict[str, Any]:
    """{changes (as the commands returned them, oldest first), createdBins} -> puts each `before` back,
    newest first, where the clip still has the `after`; a clip changed since (by hand in Resolve, or
    later by the agent) is left as it is and listed in `changedSince`. Then removes each created bin
    that's empty again, innermost first; one with clips in it is kept and listed in `binsKept`."""
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
        if field not in (
            "bin",
            "color",
            "flags",
            "name",
            "imported",
        ) and not field.startswith("metadata:"):
            raise HostError(f"Unknown field {field!r}")
    media_pool = host._project().GetMediaPool()
    index = _index(media_pool)
    reverted, changed_since, failed = [], [], []
    for change in reversed(changes):
        clip_id, field = change["clipId"], change["field"]
        if clip_id not in index:
            failed.append(
                {
                    "clipId": clip_id,
                    "field": field,
                    "reason": "The clip isn't in the Media Pool any more",
                }
            )
            continue
        clip = index[clip_id][1]
        if field == "imported":
            # A clip import_media brought in (resolve_project.py) goes again while no timeline uses it.
            if str(clip.GetClipProperty("Usage") or "0") != "0":
                changed_since.append({"clipId": clip_id, "field": field})
            elif media_pool.DeleteClips([clip]):
                reverted.append({"clipId": clip_id, "field": field})
                index = _index(media_pool)
            else:
                failed.append(
                    {
                        "clipId": clip_id,
                        "field": field,
                        "reason": "Resolve didn't remove it",
                    }
                )
            continue
        if not _same(field, _read(clip, field, index), change.get("after")):
            changed_since.append({"clipId": clip_id, "field": field})
            continue
        if _restore(media_pool, clip, field, change.get("before")):
            reverted.append({"clipId": clip_id, "field": field})
            if field == "bin":
                index = _index(media_pool)
        else:
            failed.append(
                {
                    "clipId": clip_id,
                    "field": field,
                    "reason": "Resolve didn't put it back",
                }
            )
    removed, kept = [], []
    for path in sorted(dict.fromkeys(created), key=lambda p: p.count("/"), reverse=True):
        folder, _found, missing = _find_folder(media_pool, path)
        if missing:
            continue  # already gone
        if folder.GetClipList() or folder.GetSubFolderList():
            kept.append(path)
        elif media_pool.DeleteFolders([folder]):
            removed.append(path)
        else:
            kept.append(path)
    return {
        "reverted": reverted,
        "changedSince": changed_since,
        "failed": failed,
        "binsRemoved": removed,
        "binsKept": kept,
    }
