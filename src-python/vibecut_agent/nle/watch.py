"""The watcher loop Rust keeps running for each editor (``premiere-watch``, ``resolve-watch``).

A watcher never gives up on its editor: it probes it every POLL_S seconds and emits a ``state`` event
whenever what it sees changes, with a ``reason`` the agent uses to re-sync:

- ``unavailable``: not reachable yet (``message`` says why: not running, panel not installed...).
- ``connected``: reachable for the first time.
- ``disconnected``: was connected, isn't any more.
- ``reconnected``: reachable again after a disconnect.
- ``restarted``: the editor restarted (Premiere's panel reports a new ``instance``); anything read
  before is stale.
- ``project_changed`` / ``timeline_changed`` / ``timelines_changed``: what the user has open changed.

Between probes it answers calls, one JSON line each on stdin:
``{"type": "call", "id", "command", "args"}`` → ``{"type": "reply", "id", "ok": true, "result"}`` or
``{"type": "reply", "id", "ok": false, "error"}``. Only the adapter's ``calls`` run: READ_CALLS
its editor's direct edits (edits.py) and the B-roll Library's import_media and source_preview
(media.py), and the project calls (project.py). ``end_session`` or stdin closing
ends the watcher.
"""

from __future__ import annotations

import time
from collections.abc import Callable
from typing import Any, Protocol

from vibecut_agent.nle import resolve
from vibecut_agent.nle.edits import premiere_edits, resolve_edits
from vibecut_agent.nle.errors import HostError, Unreachable
from vibecut_agent.nle.media import premiere_media, resolve_media
from vibecut_agent.nle.premiere import PremiereHost
from vibecut_agent.nle.premiere_bridge import PremiereBridge
from vibecut_agent.nle.project import premiere_project, resolve_project
from vibecut_agent.nle.resolve import ResolveHost
from vibecut_agent.protocol import Emitter, RequestError, StdinClosed

POLL_S = 2.0
# The reads both editors answer; each adapter adds its direct edits (edits.py).
READ_CALLS = (
    "status",
    "read_timeline",
    "list_markers",
    "add_markers",
    "update_marker",
    "remove_markers",
    "get_playhead",
    "set_playhead",
)


class Channel(Protocol):
    def read(self, timeout: float | None = None) -> dict[str, Any] | None: ...


class Adapter(Protocol):
    host: str
    calls: tuple[str, ...]

    def probe(self) -> dict[str, Any]:
        """A status snapshot (``product``, ``version``, ``project``, ``timeline``, ``timelines``,
        ``instance``), or Unreachable."""
        ...

    def call(self, command: str, args: dict[str, Any]) -> Any: ...


def _snapshot(status: dict[str, Any], instance: str | None) -> dict[str, Any]:
    return {
        "product": status.get("product"),
        "version": status.get("version"),
        "project": status.get("project"),
        "timeline": status.get("currentTimeline"),
        "timelines": list(status.get("timelines") or []),
        "instance": instance,
    }


class PremiereAdapter:
    host = "premiere"

    def __init__(self, bridge: PremiereBridge | None = None) -> None:
        self.bridge = bridge or PremiereBridge()
        self.api = PremiereHost(self.bridge.request)
        self._prepared = False
        # The direct edits, plus the B-roll Library's import and source preview (media.py).
        self._edits = {
            **premiere_edits(),
            **premiere_media(),
            **premiere_project(self.bridge.folder / "imports"),
        }
        self.calls = READ_CALLS + tuple(self._edits)

    def probe(self) -> dict[str, Any]:
        alive = self.bridge.check_alive()
        if not self._prepared:
            self.bridge.prepare()
            self._prepared = True
        instance = alive.get("instance")
        return _snapshot(self.api.status({}), instance if isinstance(instance, str) else None)

    def call(self, command: str, args: dict[str, Any]) -> Any:
        self.bridge.check_alive()
        if command in self._edits:
            return self._edits[command](self.api, args)
        return getattr(self.api, command)(args)


class ResolveAdapter:
    """Keeps one scripting connection and makes a new one whenever the old one stops answering
    (Resolve quit or restarted). Resolve has no instance id, so a restart reads as ``reconnected``."""

    host = "resolve"

    def __init__(self, connect: Callable[[], Any] = resolve.connect) -> None:
        self._connect = connect
        self._resolve: Any = None
        self._edits = {**resolve_edits(), **resolve_media(), **resolve_project()}
        self.calls = READ_CALLS + tuple(self._edits)

    def _api(self) -> ResolveHost:
        if self._resolve is None:
            self._resolve = self._connect()
        return ResolveHost(self._resolve)

    def probe(self) -> dict[str, Any]:
        api = self._api()
        try:
            status = api.status({})
        except Exception as exc:
            self._resolve = None
            raise Unreachable("DaVinci Resolve stopped answering.") from exc
        if not status.get("product"):
            # A connection to a Resolve that has quit answers None to everything.
            self._resolve = None
            raise Unreachable("DaVinci Resolve stopped answering.")
        return _snapshot(status, None)

    def call(self, command: str, args: dict[str, Any]) -> Any:
        api = self._api()
        if command in self._edits:
            return self._edits[command](api, args)
        return getattr(api, command)(args)


class Tracker:
    """Turns probe results into ``state`` events: the full state plus why it changed, or None when
    nothing did."""

    def __init__(self) -> None:
        self.state: dict[str, Any] | None = None
        self._ever_connected = False
        self._last_instance: str | None = None

    def connected(self, snapshot: dict[str, Any]) -> dict[str, Any] | None:
        previous = self.state
        state = {"status": "connected", "message": None, **snapshot}
        if previous == state:
            return None
        instance = snapshot.get("instance")
        new_instance = bool(instance and self._last_instance and instance != self._last_instance)
        if not self._ever_connected:
            reason = "connected"
        elif new_instance:
            reason = "restarted"
        elif previous is None or previous["status"] != "connected":
            reason = "reconnected"
        elif previous["project"] != state["project"]:
            reason = "project_changed"
        elif previous["timeline"] != state["timeline"]:
            reason = "timeline_changed"
        else:
            reason = "timelines_changed"
        self._ever_connected = True
        if instance:
            self._last_instance = instance
        self.state = state
        return {**state, "reason": reason}

    def unreachable(self, message: str) -> dict[str, Any] | None:
        previous = self.state
        state: dict[str, Any] = {
            "status": "disconnected",
            "message": message,
            "product": None,
            "version": None,
            "project": None,
            "timeline": None,
            "timelines": [],
            "instance": None,
        }
        if previous == state:
            return None
        was_connected = previous is not None and previous["status"] == "connected"
        self.state = state
        return {**state, "reason": "disconnected" if was_connected else "unavailable"}


def _reply(emitter: Emitter, adapter: Adapter, message: dict[str, Any]) -> bool:
    """Answers one call. Returns True when the editor turned out to be unreachable."""
    call_id = message.get("id")
    command = message.get("command")
    args = message.get("args", {})
    if command not in adapter.calls:
        emitter.emit("reply", id=call_id, ok=False, error=f"Unknown command: {command!r}")
        return False
    if not isinstance(args, dict):
        emitter.emit("reply", id=call_id, ok=False, error="args must be an object")
        return False
    try:
        emitter.emit("reply", id=call_id, ok=True, result=adapter.call(command, args))
    except Unreachable as exc:
        emitter.emit("reply", id=call_id, ok=False, error=str(exc))
        return True
    except HostError as exc:
        emitter.emit("reply", id=call_id, ok=False, error=str(exc))
    except Exception as exc:  # noqa: BLE001 - an unexpected answer from the editor: report it, keep serving
        emitter.emit("reply", id=call_id, ok=False, error=f"{type(exc).__name__}: {exc}")
    return False


def watch(
    adapter: Adapter,
    channel: Channel,
    emitter: Emitter,
    clock: Callable[[], float] = time.monotonic,
    interval: float = POLL_S,
) -> int:
    emitter.emit("ready", host=adapter.host)
    tracker = Tracker()
    next_probe = clock()
    while True:
        if clock() >= next_probe:
            try:
                event = tracker.connected(adapter.probe())
            except Unreachable as exc:
                event = tracker.unreachable(str(exc))
            except HostError as exc:
                event = tracker.unreachable(str(exc))
            if event is not None:
                emitter.emit("state", host=adapter.host, **event)
            next_probe = clock() + interval
        try:
            message = channel.read(max(0.0, next_probe - clock()))
        except StdinClosed:
            return 0
        except RequestError as exc:
            emitter.error(str(exc))
            continue
        if message is None:
            continue
        kind = message.get("type")
        if kind == "end_session":
            emitter.emit("done", reason="ended")
            return 0
        if kind != "call":
            emitter.error(f"Unknown message type: {kind!r}")
            continue
        if _reply(emitter, adapter, message):
            next_probe = clock()  # report the lost connection now, not at the next tick
