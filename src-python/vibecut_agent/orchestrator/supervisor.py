"""The orchestrated chat turn (ORCHESTRATOR_SPEC.md §1.1, §3.2, §4.3; PLAN.md, "Phase 21"): Gemini (the
API-key chat) as the supervising editor, with the local workers behind the tool bus. Claude through the
user's subscription supervises through its MCP shim instead (mcp_server.py), with the same instruction.

`ORCHESTRATED_INSTRUCTION` is what Claude (subscription) is told in orchestrated mode (agent/chat.py).

`make_orchestrated_turn_runner(config)` returns a turn runner with `gemini_chat.run_chat_turn`'s
signature. It ran the Anthropic API's Claude until model migration v2; it is not routed to now, since only
Claude orchestrates (the user's call, 2026-11-02: `config.resolve_chat_turn_runner` gives Gemini its own
loop in either mode), and is kept, with its tests, for a provider that may supervise in-process again.
Each turn runs gemini_chat's own loop, unchanged, with three differences:

- Gemini is given the six orchestration tools (tool_bus.gemini_tools, as full JSON Schema) and, of the
  app's tools, only the ones that read, the B-roll Analyzer, the three sync tools and the three marker tools
  (tool_bus.FORWARDED_TOOLS); every other
  edit goes through `propose_otio_delta` and `commit_otio_delta`. ORCHESTRATED_INSTRUCTION is added to the system prompt to
  say how.
- When Gemini calls tools, `_Router` takes the `tool_calls` event before it reaches the app: the
  orchestration calls run in this process on the bus (each announced with a `status` line, since the
  app doesn't run them), the read-only, sync and marker calls go on to the app as one `tool_calls` event, and any other
  call is answered with an error. gemini_chat then reads the bus's results first and the app's after,
  through the same `read_tool_result`, and answers them in the order Gemini made the calls.
- The bus reaches the app itself (to read the timeline, and to commit) with `tool_calls` events of its
  own, ids `orch_<n>`, whose results it reads before the turn goes on. The app runs them as it runs any
  call, so they show in the chat as tool calls.

The bus, with the validation tokens it has handed out, lives as long as the conversation's process.
A long local tool (transcribing a file) can't be stopped partway; Stop takes effect when it ends."""

from __future__ import annotations

import itertools
from collections.abc import Callable
from typing import Any

from vibecut_agent.agent import gemini_chat
from vibecut_agent.agent.chat_steps import ChatError
from vibecut_agent.config import OrchestratorConfig
from vibecut_agent.orchestrator.tool_bus import (
    FORWARDED_TOOLS,
    STATUS,
    OrchestratorToolBus,
    gemini_tools,
)

ORCHESTRATED_INSTRUCTION = """\
# Orchestrated editing

You are working as the supervising editor, with local workers that index and check the media. You don't \
edit the timeline with individual tools here; every change is one declarative OTIO delta:

1. Find material with semantic_asset_search (dialogue, visual or hybrid), which covers the media the local \
workers have indexed. The user's B-roll Library is Spyglass's index of their archive: search it with \
find_broll (list_spyglass_folders and describe_spyglass_folder show its folders). The project's own bins: \
search_media_pool and list_media_pool. A folder of footage Spyglass hasn't indexed: analyze_broll_folder \
scores its clips and picks each one's best segments. For one file's words or shots, use transcribe_and_align \
or analyze_shot_visuals; for frame-accurate cut points (silences, hard cuts, loudness), \
detect_media_boundaries.
2. Read the timeline (list_timeline_clips with detail=true) for its clip ids, rate and free space.
3. Write the change as a vibecut.otio.delta.v1 delta and send it with propose_otio_delta. Times are \
RationalTime at the timeline's own rate: timeline ranges on whole frames, source ranges in the source's \
seconds times that rate. Name existing clips by their ids; clips the delta makes can't be named until it \
has run. Leave expected_timeline_hash null; the commit checks the timeline itself.
4. If the result isn't valid, read its diagnostics, fix the delta and propose it again. WARNINGs are an \
editor's notes: weigh them, and say so when you go ahead anyway.
5. Commit a valid delta with commit_otio_delta, its validation_token and a one-line summary for the edit \
log. A token is used once; if the timeline changed since, propose again.

Keep each delta to one editorial idea, so each can be reverted on its own.

B-roll from the Library: each find_broll match is one shot, start to end seconds in its file. Use only status \
"ok" matches and prefer higher technical scores. Check a shortlisted shot with analyze_shot_visuals over that \
range (custom_prompt_focus from the brief) to confirm it fits and choose its best seconds, and use \
detect_media_boundaries when it needs a clean in or out point. Place it in the delta with media_reference \
target_url "file://" plus the match's path and a source range of the chosen seconds times the timeline's \
rate, not with add_clips.

Syncing a camera with a separately recorded sound file is the one edit outside the delta: a delta can link \
picture and sound but can't find the offset between them. Use sync_and_place to place cameras with their \
recordings, sync_clips for linked picture and sound already on the timeline, and slip_into_sync to put \
linked sound back in sync. Each is its own edit, backed up and revertible.

Many of the app's own tools work here too, outside the delta, each its own edit with a backup and Revert:
- markers: add_markers (many in one call), update_marker, remove_markers; list_markers reads them. Markers don't change the timeline a validation token was given for;
- project notes: remember_note saves a lasting fact the user tells you, forget_note removes one;
- a clip's look, speed and fades (set_clip_color, match_clip_color, balance_clip_color, set_clip_transform, set_clip_speed, set_speed_ramp, set_clip_fade), audio repair (normalize_loudness, clean_dialogue, fill_room_tone), graphics (add_lower_thirds, create_captions), tracks and clip state (add_track, set_track_options, nest_clips, set_clips_enabled, label_timeline_clips), the project and its bins (create_timeline, switch_timeline, make_social_version, import_media, bins and clip metadata), delivery (export_video, export_audio, export_clips, export_thumbnails), set_playhead_time, learn_style, and revert_timeline_edits to undo the app's edits, a committed delta among them.
These edit the timeline, so propose a delta after them, not before. Cuts, trims, moves, inserts, deletes, gaps, transitions, gain and ducking always go in a delta.

The app's reads are here too: get_transcript, search_transcript, list_speakers and find_filler_words for what's said on the timeline (transcribe_and_align is for one file), get_clip_info, get_clip_transform, get_clip_color, and its checks: check_pacing, review_edit, find_beats, read_client_notes, make_chapters, find_thumbnails.

To look at the picture (what a shot shows, its framing, subject, light), use analyze_shot_visuals on the clip's media file over the range you need, in the source's seconds; sample_strategy "scene_cuts" gives one description per shot, which is what a shot list needs. Tools named elsewhere in these instructions that aren't in your tool list (look_at_clip, look_at_timeline, look_at_media, add_clips, split_clip and the other single cuts) don't exist in this mode: use the tools here instead of saying a task can't be done.
"""

TOOL_RESULT_ID_PREFIX = "orch_"


class _Router:
    """One turn's tool traffic between the chat loop, the bus and the app; see the module docstring."""

    def __init__(
        self,
        emit: Callable[..., None],
        read_tool_result: Callable[[], dict[str, Any]],
        bus: OrchestratorToolBus,
        ids: itertools.count[int],
    ) -> None:
        self._emit = emit
        self._read = read_tool_result
        self.bus = bus
        self._ids = ids
        self.answered: list[dict[str, Any]] = []

    def emit(self, event_type: str, **fields: Any) -> None:
        if event_type != "tool_calls":
            self._emit(event_type, **fields)
            return
        forwarded = []
        for call in fields.get("calls") or []:
            name = call.get("name")
            if self.bus.handles(name):
                self._emit("status", phase="tool", detail=STATUS[name])
                result = self.bus.dispatch(name, call.get("args") or {})
            elif name in FORWARDED_TOOLS:
                forwarded.append(call)
                continue
            else:
                result = {
                    "error": f"{name} isn't available here: edits go through propose_otio_delta and "
                    "commit_otio_delta"
                }
            self.answered.append({"type": "tool_result", "id": call.get("id"), "result": result})
        if forwarded:
            self._emit("tool_calls", calls=forwarded)

    def read_tool_result(self) -> dict[str, Any]:
        if self.answered:
            return self.answered.pop(0)
        return self._read()

    def call_app(self, calls: list[tuple[str, dict[str, Any]]]) -> list[Any]:
        """Runs the calls in the app and returns their results, in the calls' order."""
        ids = [f"{TOOL_RESULT_ID_PREFIX}{next(self._ids)}" for _ in calls]
        self._emit("tool_calls", calls=[{"id": i, "name": n, "args": a} for i, (n, a) in zip(ids, calls)])
        results: dict[str, Any] = {}
        while len(results) < len(ids):
            message = self._read()
            result_id = message.get("id")
            if result_id in results:
                raise ChatError(f"Tool result for call {result_id!r} was sent twice")
            if result_id not in ids:
                raise ChatError(f"Tool result for unknown call id {result_id!r}")
            results[result_id] = message.get("result")
        return [results[i] for i in ids]

    def status(self, detail: str) -> None:
        self._emit("status", phase="tool", detail=detail)


def make_orchestrated_turn_runner(
    config: OrchestratorConfig, bus: OrchestratorToolBus | None = None
) -> Callable[..., dict[str, Any]]:
    """The orchestrated turn runner for one conversation (see the module docstring)."""
    bus = bus or OrchestratorToolBus(config)
    ids = itertools.count(1)

    def run_orchestrated_turn(
        *,
        system_instruction: str,
        tool_declarations: list[dict[str, Any]],
        emit: Callable[..., None],
        read_tool_result: Callable[[], dict[str, Any]],
        **turn: Any,
    ) -> dict[str, Any]:
        router = _Router(emit, read_tool_result, bus, ids)
        bus.call_app = router.call_app
        bus.status = router.status
        reading = [d for d in tool_declarations if isinstance(d, dict) and d.get("name") in FORWARDED_TOOLS]
        instruction = (
            f"{system_instruction}\n\n{ORCHESTRATED_INSTRUCTION}"
            if system_instruction
            else ORCHESTRATED_INSTRUCTION
        )
        return gemini_chat.run_chat_turn(
            system_instruction=instruction,
            tool_declarations=[*reading, *gemini_tools()],
            emit=router.emit,
            read_tool_result=router.read_tool_result,
            **turn,
        )

    return run_orchestrated_turn
