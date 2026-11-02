"""The orchestrator's tool bus (ORCHESTRATOR_SPEC.md §1.1, §3.2; PLAN.md, "Phase 21"): Claude's six
orchestration tools, run in the chat sidecar.

`dispatch(name, args)` checks the arguments against the tool's `input_schema` (schemas.py), runs it and
returns what goes back to Claude as the tool result; it never raises for a tool's own failure, which comes
back as `{"error": ...}` (with `details` for a schema mismatch) for Claude to read and recover from.

- `semantic_asset_search`: the vector store (workers/vector_store.py).
- `transcribe_and_align`: the Whisper worker; the shared `.ivt-cache.json` answers when it can. Telling
  speakers apart needs the Hugging Face token, which only the Transcribe tab and `ingest-index` are given.
- `analyze_shot_visuals`: the VLM worker.
- `detect_media_boundaries`: core/ffmpeg_ops.py's silence and scene-cut detectors and media/loudness.py's
  EBU R128 measurement. They are ffmpeg, not models, so they don't take the GPU lock.
- `propose_otio_delta`: reads the timeline the delta is planned on through the app (`list_timelines`, then
  `list_timeline_clips` with detail), and has the validator (workers/gemma_validator.py) check and compile
  it. A passing delta's token, delta, calls and timeline hash are kept for the commit.
- `commit_otio_delta`: the token must be one this bus handed out and hasn't committed. The timeline is
  read again and must still hash the same (STALE_TIMELINE_HASH otherwise), the token must verify, and
  then the validated calls go to the app as a `commit_otio_delta` call of its own (`validationToken`,
  `deltaId`, `commitSummary`, `host`, `timeline`, `batch`, `expectedTimelineHash` (which the editor checks
  again just before it edits, since a commit can wait for Apply), and `otioPath` when the `orchestrator` extra
  could write the timeline as it will be to `<appDataDir>/otio_deltas/<delta_id>.otio`). The app's executor
  for it, and the bridge's `execute_otio_batch`, are Phase 5; until then the app answers "Unknown tool"
  and the token stays usable. Only `incremental_bridge` is offered: neither bridge imports an OTIO yet.

The app is reached through `call_app`, which the supervisor sets for each turn: it sends tool calls to
the app and returns their results in order. The bus lives for the whole conversation, so a token from
one turn can be committed in the next.

A result too long for Claude's context (a long file's word-level transcript) is cut down by `fit`: words
first, then the later entries of its main list, saying what was left out and how to ask for the rest."""

from __future__ import annotations

import json
import os
import re
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from typing import Any
from urllib.parse import urldefrag, urljoin

from vibecut_agent.agent.chat_steps import ChatError
from vibecut_agent.config import OrchestratorConfig
from vibecut_agent.core import ffmpeg_ops
from vibecut_agent.orchestrator.otio_delta import (
    NleCommand,
    apply_delta_to_otio,
    timeline_hash,
    write_otio,
)
from vibecut_agent.orchestrator.schemas import (
    ORCHESTRATOR_TOOLS,
    SCHEMAS,
    SchemaError,
    validate_tool_input,
)
from vibecut_agent.protocol import RequestError
from vibecut_agent.workers.base import CircuitOpen, GpuLock, GpuLockTimeout

# The app's tools Claude keeps in orchestrated mode: they only read (ORCHESTRATOR_SPEC.md §3.2).
READ_ONLY_TOOLS = (
    "list_timelines",
    "list_timeline_clips",
    "list_markers",
    "get_playhead_time",
    "get_edit_log",
)
ORCHESTRATOR_TOOL_NAMES = tuple(tool["name"] for tool in ORCHESTRATOR_TOOLS)
# What a tool result may be, in characters of JSON, before `fit` cuts it down.
MAX_RESULT_CHARS = 60_000
# How long a chat-side model call waits for the GPU lock (an ingest may hold it) before saying so.
CHAT_LOCK_TIMEOUT_SECONDS = 30.0
# The list each kind of result is mostly made of, in the order `fit` looks for them.
RESULT_LISTS = ("segments", "shots", "hits", "silences", "scene_cuts")
NOTE_ROOM = 300

STATUS = {
    "semantic_asset_search": "Searching the media index…",
    "transcribe_and_align": "Reading the transcript…",
    "analyze_shot_visuals": "Looking at the shots…",
    "detect_media_boundaries": "Finding cut points…",
    "propose_otio_delta": "Checking the planned edit…",
    "commit_otio_delta": "Sending the edit to the editor…",
}

AppCall = Callable[[list[tuple[str, dict[str, Any]]]], list[Any]]
Status = Callable[[str], None]
Measure = Callable[[str, float, float | None], dict[str, Any]]


class ToolBusError(Exception):
    """A tool that can't run as asked; its message goes back to Claude as the tool's error."""


@dataclass
class Proposal:
    delta: dict[str, Any]
    batch: list[NleCommand]
    snapshot_hash: str


def _no_app(calls: list[tuple[str, dict[str, Any]]]) -> list[Any]:
    raise ToolBusError("The editor can't be reached from here")


def _quiet(detail: str) -> None:
    pass


def _measure_loudness(path: str, start: float, end: float | None) -> dict[str, Any]:
    from vibecut_agent.media import loudness

    return loudness.measure(path, start, end)


def default_workers(config: OrchestratorConfig) -> dict[str, Callable[[], Any]]:
    """Builders for the chat's workers, each with a GPU lock that gives up after CHAT_LOCK_TIMEOUT_SECONDS."""

    def lock() -> GpuLock:
        return GpuLock.for_config(config, timeout=CHAT_LOCK_TIMEOUT_SECONDS)

    def whisper() -> Any:
        from vibecut_agent.workers.whisper_worker import WhisperWorker

        return WhisperWorker(config, lock=lock())

    def vlm() -> Any:
        from vibecut_agent.workers.vlm_worker import VlmWorker

        return VlmWorker(config, lock=lock())

    def vector() -> Any:
        from vibecut_agent.workers.vector_store import VectorStore

        return VectorStore(config, lock=lock())

    def validator() -> Any:
        from vibecut_agent.workers.gemma_validator import GemmaValidator

        return GemmaValidator(config)

    return {"whisper": whisper, "vlm": vlm, "vector": vector, "validator": validator}


def inline_refs(schema: Any, base: str = "") -> Any:
    """`schema` with every `$ref` replaced by what it points to (in SCHEMAS), so it stands alone: Claude's
    tool definitions can't fetch the spec's schemas by `$id`. The `$id`, `$schema` and `$defs` of what is
    inlined are dropped; none of the spec's schemas refers to itself."""
    if isinstance(schema, list):
        return [inline_refs(item, base) for item in schema]
    if not isinstance(schema, dict):
        return schema
    if "$ref" in schema:
        url, fragment = urldefrag(urljoin(base, schema["$ref"]))
        target: Any = SCHEMAS[url]
        for part in [p for p in fragment.split("/") if p]:
            target = target[part]
        rest = {k: v for k, v in schema.items() if k != "$ref"}
        return {**inline_refs(target, url), **inline_refs(rest, base)}
    base = schema.get("$id", base)
    return {k: inline_refs(v, base) for k, v in schema.items() if k not in ("$id", "$schema", "$defs")}


def claude_tools() -> list[dict[str, Any]]:
    """The six tools as the chat's tool declarations (`{name, description, parameters}`), their schemas
    inlined."""
    return [
        {
            "name": tool["name"],
            "description": tool["description"],
            "parameters": inline_refs(tool["input_schema"]),
        }
        for tool in ORCHESTRATOR_TOOLS
    ]


def gemini_tools() -> list[dict[str, Any]]:
    """The six tools as Gemini function declarations (model migration v2, PLAN.md D5). Their schemas
    are full JSON Schema (`additionalProperties`, `const`, `pattern`), which Gemini's `parameters` (an
    OpenAPI subset) refuses, so they go as `parametersJsonSchema`, inlined as for Claude."""
    return [
        {
            "name": tool["name"],
            "description": tool["description"],
            "parametersJsonSchema": inline_refs(tool["input_schema"]),
        }
        for tool in ORCHESTRATOR_TOOLS
    ]


def fit(result: Any, limit: int = MAX_RESULT_CHARS) -> Any:
    """`result`, cut down to `limit` characters of JSON when it is longer (see the module docstring)."""

    def size(value: Any) -> int:
        return len(json.dumps(value, ensure_ascii=False, default=str))

    if size(result) <= limit or not isinstance(result, dict):
        return result
    key = next((k for k in RESULT_LISTS if isinstance(result.get(k), list)), None)
    if key is None:
        return {"error": f"The result was too long to send ({size(result):,} characters); narrow the request"}
    entries: list[Any] = result[key]
    slim = dict(result)
    notes = []
    if any(isinstance(e, dict) and "words" in e for e in entries):
        entries = [
            {k: v for k, v in e.items() if k != "words"} if isinstance(e, dict) else e for e in entries
        ]
        slim[key] = entries
        notes.append("word timings were left out")
    kept = len(entries)
    # Room for the note added below.
    while kept > 0 and size(slim) > limit - NOTE_ROOM:
        kept = kept * 3 // 4 if kept > 4 else kept - 1
        slim[key] = entries[:kept]
    if kept < len(entries):
        notes.append(f"only the first {kept} of {len(entries)} {key} are here")
    slim["truncated"] = (
        "Too long to send whole: "
        + "; ".join(notes)
        + ". Ask again for a shorter range of the file for the rest, or for word timings."
    )
    return slim


def _connected_timeline(status: dict[str, Any]) -> str:
    """The timeline every app tool works on (`connected`, the one `list_timeline_clips` read), from
    `list_timelines` (src/lib/agent/projectTools.ts: `{project, timelines: [{name, connected?,
    openInEditor?, ...}]}`)."""
    timelines = status.get("timelines")
    for entry in timelines if isinstance(timelines, list) else []:
        if isinstance(entry, dict) and entry.get("connected") is True and isinstance(entry.get("name"), str):
            return str(entry["name"])
    raise ToolBusError("Couldn't read the timeline: no timeline is connected in the editor")


def _snapshot_from(status: Any, clips: Any) -> dict[str, Any]:
    """A HostTimeline (as compile_to_nle_commands reads it) from `list_timelines` and
    `list_timeline_clips {detail: true, includeLocked: true}` results (locks for the validator; not hashed)."""
    for answer in (status, clips):
        if not isinstance(answer, dict):
            raise ToolBusError("Couldn't read the timeline: the editor gave no answer")
        if "error" in answer:
            raise ToolBusError(f"Couldn't read the timeline: {answer['error']}")
    kinds = {"V": "video", "A": "audio", "S": "subtitle"}
    tracks = []
    for track in clips.get("tracks") or []:
        label = str(track.get("track") or "")
        if label[:1] not in kinds or not label[1:].isdigit():
            raise ToolBusError(f"Couldn't read the timeline: a track is labelled {label!r}")
        tracks.append(
            {
                "type": kinds[label[:1]],
                "index": int(label[1:]),
                "name": track.get("name"),
                "locked": track.get("locked") is True,
                "clips": track.get("clips") or [],
            }
        )
    return {
        "project": status.get("project"),
        "timeline": _connected_timeline(status),
        "fps": clips.get("fps"),
        "duration": clips.get("duration"),
        "tracks": tracks,
    }


def default_otio_dir(config: OrchestratorConfig) -> Path:
    """`<appDataDir>/otio_deltas`: the app passes its data folder as VIBECUT_APP_DATA_DIR (sidecar.rs,
    mcp_bridge.rs). Run without it (an outside MCP client, a terminal), next to the vector index."""
    app_data = os.environ.get("VIBECUT_APP_DATA_DIR", "").strip()
    return Path(app_data) / "otio_deltas" if app_data else Path(config.index_dir).parent / "otio_deltas"


class OrchestratorToolBus:
    def __init__(
        self,
        config: OrchestratorConfig,
        *,
        workers: dict[str, Callable[[], Any]] | None = None,
        measure_loudness: Measure = _measure_loudness,
        otio_dir: str | os.PathLike[str] | None = None,
        hf_token: str | None = None,
    ) -> None:
        self.config = config
        self.call_app: AppCall = _no_app
        self.status: Status = _quiet
        self._builders = workers or default_workers(config)
        self._workers: dict[str, Any] = {}
        self.measure_loudness = measure_loudness
        self.otio_dir = Path(otio_dir) if otio_dir else default_otio_dir(config)
        self.hf_token = hf_token
        self.proposals: dict[str, Proposal] = {}
        self._handlers: dict[str, Callable[[dict[str, Any]], Any]] = {
            "semantic_asset_search": self.semantic_asset_search,
            "transcribe_and_align": self.transcribe_and_align,
            "analyze_shot_visuals": self.analyze_shot_visuals,
            "detect_media_boundaries": self.detect_media_boundaries,
            "propose_otio_delta": self.propose_otio_delta,
            "commit_otio_delta": self.commit_otio_delta,
        }

    def handles(self, name: str) -> bool:
        return name in self._handlers

    def worker(self, name: str) -> Any:
        if name not in self._workers:
            self._workers[name] = self._builders[name]()
        return self._workers[name]

    def dispatch(self, name: str, args: Any) -> Any:
        """The tool's result for Claude; see the module docstring. A broken tool_result exchange with the
        app (ChatError, RequestError) is not the tool's failure and is raised."""
        handler = self._handlers.get(name)
        if handler is None:
            return {"error": f"{name} isn't one of the orchestrator's tools"}
        try:
            validate_tool_input(name, args)
            return fit(handler(args))
        except (ChatError, RequestError):
            raise
        except SchemaError as e:
            return {"error": f"The arguments don't fit {name}'s schema", "details": e.errors[:20]}
        except GpuLockTimeout:
            return {
                "error": "The local models are busy (media is being indexed); try again in a minute, "
                "or work from what's already indexed"
            }
        except (ToolBusError, CircuitOpen) as e:
            return {"error": str(e)}
        except Exception as e:  # noqa: BLE001 - any worker failure goes back to Claude as the tool's error
            return {"error": f"{name} failed: {e}"}

    # Helpers.

    @staticmethod
    def _media(path: Any) -> str:
        if not isinstance(path, str) or not os.path.isabs(path):
            raise ToolBusError("media_path must be an absolute path")
        if not os.path.isfile(path):
            raise ToolBusError(f"{path} isn't there (is its drive attached?)")
        return path

    @staticmethod
    def _window(start: float | None, end: float | None) -> None:
        if start is not None and end is not None and end <= start:
            raise ToolBusError("The range ends before it starts")

    def _progress(self, name: str) -> Callable[[str, float, str], None]:
        def report(phase: str, fraction: float, detail: str) -> None:
            self.status(f"{name}: {detail}" if detail else f"{name}: {phase}")

        return report

    def read_timeline(self) -> dict[str, Any]:
        status, clips = self.call_app(
            [("list_timelines", {}), ("list_timeline_clips", {"detail": True, "includeLocked": True})]
        )
        return _snapshot_from(status, clips)

    # The tools.

    def semantic_asset_search(self, args: dict[str, Any]) -> Any:
        scope = args.get("scope_paths")
        if scope and not all(os.path.isabs(p) for p in scope):
            raise ToolBusError("scope_paths must be absolute paths")
        return self.worker("vector").search(
            args["query"],
            args["modality"],
            scope_paths=scope,
            filters=args.get("filters"),
            top_k=args.get("top_k", 8),
        )

    def transcribe_and_align(self, args: dict[str, Any]) -> Any:
        path = self._media(args["media_path"])
        window = args.get("source_range_seconds") or {}
        start, end = window.get("start"), window.get("end")
        self._window(start, end)
        diarize = args.get("enable_diarization") is True
        if diarize and not self.hf_token:
            raise ToolBusError(
                "Telling speakers apart needs the Hugging Face token, which the chat isn't given; leave "
                "enable_diarization off, or have the user index the file with speakers on"
            )
        return self.worker("whisper").transcribe(
            path,
            model_tier=args.get("model_tier"),
            enable_diarization=diarize,
            hf_token=self.hf_token,
            start=start,
            end=end,
            on_progress=self._progress(os.path.basename(path)),
        )

    def analyze_shot_visuals(self, args: dict[str, Any]) -> Any:
        path = self._media(args["media_path"])
        start, end = args.get("start_seconds", 0.0), args.get("end_seconds")
        self._window(start, end)
        return self.worker("vlm").analyze(
            path,
            start=start,
            end=end,
            sample_strategy=args.get("sample_strategy", "scene_cuts"),
            custom_prompt_focus=args.get("custom_prompt_focus"),
            on_progress=self._progress(os.path.basename(path)),
        )

    def detect_media_boundaries(self, args: dict[str, Any]) -> Any:
        path = self._media(args["media_path"])
        start, end = args.get("start_seconds", 0.0), args.get("end_seconds")
        self._window(start, end)
        detectors = list(dict.fromkeys(args["detectors"]))
        result: dict[str, Any] = {"media_path": path, "start_seconds": start, "end_seconds": end}
        try:
            if "silence" in detectors:
                result["silences"] = ffmpeg_ops.detect_silences(
                    path,
                    start=start,
                    end=end,
                    noise_db=args.get("silence_noise_db", -35.0),
                    min_duration=args.get("silence_min_duration", 0.35),
                )
            if "scene_cuts" in detectors:
                result["scene_cuts"] = ffmpeg_ops.detect_scene_cuts(
                    path, start=start, end=end, sensitivity=args.get("scene_cut_sensitivity", "normal")
                )
        except ffmpeg_ops.FfmpegOpError as e:
            raise ToolBusError(str(e)) from None
        if "loudness" in detectors:
            try:
                result["loudness"] = self.measure_loudness(path, start, end)
            except RuntimeError as e:
                raise ToolBusError(f"Couldn't measure the loudness: {e}") from None
        return result

    def propose_otio_delta(self, args: dict[str, Any]) -> Any:
        delta = args["delta"]
        snapshot = self.read_timeline()
        result = self.worker("validator").validate(delta, snapshot)
        if result["valid"]:
            self.proposals[result["validation_token"]] = Proposal(
                delta, result["translated_nle_batch"], timeline_hash(snapshot)
            )
        return result

    def commit_otio_delta(self, args: dict[str, Any]) -> Any:
        token = args["validation_token"]
        proposal = self.proposals.get(token)
        if proposal is None:
            raise ToolBusError(
                "That validation_token isn't from a passing propose_otio_delta in this conversation, or it "
                "was already committed; propose the delta again"
            )
        if args.get("execution_strategy", "incremental_bridge") != "incremental_bridge":
            raise ToolBusError(
                "Only incremental_bridge is available: neither editor bridge imports an OTIO yet"
            )
        snapshot = self.read_timeline()
        current = timeline_hash(snapshot)
        if current != proposal.snapshot_hash:
            del self.proposals[token]
            raise ToolBusError(
                "STALE_TIMELINE_HASH: the timeline changed since the delta was validated; read it again "
                "and propose the delta on what it is now"
            )
        if not self.worker("validator").verify_token(token, proposal.delta, proposal.batch, current):
            del self.proposals[token]
            raise ToolBusError("The validation_token doesn't verify; propose the delta again")
        commit: dict[str, Any] = {
            "validationToken": token,
            "deltaId": proposal.delta["delta_id"],
            "commitSummary": args["commit_summary"],
            "host": proposal.delta["target_host"],
            "timeline": proposal.delta["target_timeline"],
            "batch": proposal.batch,
            # The editor checks it again just before it edits: the user may change the timeline while the
            # commit waits for Apply (nle/bridge_runner.py).
            "expectedTimelineHash": current,
        }
        otio_path = self._write_projection(proposal.delta, snapshot)
        if otio_path is not None:
            commit["otioPath"] = otio_path
        [outcome] = self.call_app([("commit_otio_delta", commit)])
        if not (isinstance(outcome, dict) and "error" in outcome):
            del self.proposals[token]
        return outcome

    def _write_projection(self, delta: dict[str, Any], snapshot: dict[str, Any]) -> str | None:
        """The timeline as the delta will leave it, saved as OTIO; None when OTIO isn't installed or the
        file couldn't be written (the commit doesn't depend on it)."""
        # The delta_id is Claude's text: only a plain file name is made of it.
        name = re.sub(r"[^A-Za-z0-9_-]", "_", delta["delta_id"])[:120]
        try:
            timeline = apply_delta_to_otio(
                delta,
                snapshot,
                self.worker("validator").media_duration,
                self.worker("validator").media_channels,
            )
            return str(write_otio(timeline, self.otio_dir, name))
        except ImportError:
            return None
        except Exception as e:  # noqa: BLE001 - the projection is a record, not part of the edit
            self.status(f"Couldn't save the OTIO of the edit: {e}")
            return None
