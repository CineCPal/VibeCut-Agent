"""Request files between VibeCut Agent and its panel inside Premiere Pro (src-premiere-panel).

Adapted from VibeCut's host-premiere/bridge.py, in VibeCut Agent's own folder so it never shares a
queue with VibeCut's panel:
- This side writes ``jobs/<id>.json`` = {id, command, args} (to a temporary name, then renamed, so the
  panel never reads half a file).
- The panel answers with ``replies/<id>.json`` = {id, ok, result} or {id, ok: false, error}.
- The panel rewrites ``alive.json`` every second: {time, busy, panelVersion, premiereVersion,
  instance, startedAt}. ``instance`` is new each time Premiere loads the panel.

There is no network port. Only the panel's fixed commands run; this side sends one request at a time
and waits for its reply.
"""

from __future__ import annotations

import contextlib
import json
import os
import secrets
import time
from collections.abc import Callable
from pathlib import Path
from typing import Any

from vibecut_agent.nle.errors import HostError, Unreachable

# The panel stamps alive.json every second; this long without a stamp means it isn't running.
ALIVE_WITHIN_S = 5.0
POLL_S = 0.02

NOT_INSTALLED = (
    "VibeCut Agent's panel isn't running in Premiere Pro. Install it from Settings > Editors, "
    "then start or restart Premiere."
)


def default_dir() -> Path:
    custom = os.environ.get("VIBECUT_AGENT_PREMIERE_BRIDGE_DIR")
    if custom:
        return Path(custom)
    return Path.home() / "Library" / "Application Support" / "VibeCut Agent" / "host-bridge" / "premiere"


def _write_json(path: Path, value: Any) -> None:
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_text(json.dumps(value, ensure_ascii=False, allow_nan=False), encoding="utf-8")
    os.replace(tmp, path)


class PremiereBridge:
    def __init__(
        self,
        folder: Path | None = None,
        clock: Callable[[], float] = time.time,
        sleep: Callable[[float], None] = time.sleep,
    ) -> None:
        self.folder = folder or default_dir()
        self.jobs = self.folder / "jobs"
        self.replies = self.folder / "replies"
        self._clock = clock
        self._sleep = sleep
        self._session = secrets.token_hex(4)
        self._next = 0

    def prepare(self) -> None:
        """Makes the folders and clears the requests and replies a previous run left behind."""
        for folder in (self.jobs, self.replies):
            folder.mkdir(parents=True, exist_ok=True)
            for leftover in folder.glob("*.json*"):
                with contextlib.suppress(FileNotFoundError):
                    leftover.unlink()

    def heartbeat(self) -> dict[str, Any] | None:
        try:
            value = json.loads((self.folder / "alive.json").read_text(encoding="utf-8"))
        except (FileNotFoundError, ValueError, OSError):
            return None
        return value if isinstance(value, dict) else None

    def check_alive(self) -> dict[str, Any]:
        """The panel's latest heartbeat, or Unreachable saying why there is none."""
        alive = self.heartbeat()
        if alive is None:
            raise Unreachable(NOT_INSTALLED)
        stamp = alive.get("time")
        age = self._clock() - stamp if isinstance(stamp, (int, float)) else None
        if age is None or age > ALIVE_WITHIN_S:
            raise Unreachable("Premiere Pro isn't running.")
        return alive

    def request(self, command: str, args: dict[str, Any], timeout_s: float) -> Any:
        """Sends one request and returns the panel's result, or raises HostError with its error."""
        self.check_alive()
        self._next += 1
        request_id = f"{self._session}-{self._next}"
        job = self.jobs / f"{request_id}.json"
        reply = self.replies / f"{request_id}.json"
        _write_json(job, {"id": request_id, "command": command, "args": args})
        deadline = self._clock() + timeout_s
        last_check = self._clock()
        while not reply.exists():
            now = self._clock()
            if now >= deadline:
                self._withdraw(job)
                raise Unreachable(
                    f"Premiere didn't answer {command} within {round(timeout_s)} s. A dialog open in "
                    "Premiere stops it answering; close it and try again."
                )
            if now - last_check >= 1.0:
                last_check = now
                try:
                    self.check_alive()
                except Unreachable:
                    self._withdraw(job)
                    raise
            self._sleep(POLL_S)
        try:
            answer = json.loads(reply.read_text(encoding="utf-8"))
        except ValueError as exc:
            raise HostError(f"Premiere's reply to {command} couldn't be read") from exc
        finally:
            with contextlib.suppress(FileNotFoundError):
                reply.unlink()
        if not isinstance(answer, dict) or answer.get("id") != request_id:
            raise HostError(f"Premiere's reply to {command} was for another request")
        if answer.get("ok") is True:
            return answer.get("result")
        raise HostError(str(answer.get("error") or "Premiere couldn't do that"))

    def _withdraw(self, job: Path) -> None:
        """Takes back a request the panel hasn't started, so it doesn't run after this side gave up."""
        with contextlib.suppress(FileNotFoundError):
            job.unlink()
