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

from vibecut_agent.nle.errors import Busy, HostError, Unreachable

# The panel stamps alive.json every second; this long without a stamp means it isn't running.
ALIVE_WITHIN_S = 5.0
# While the panel has a request running, Premiere can be too busy with it to let the panel stamp:
# encodeSequence held a 4K sequence for 9 s (2026-10-21), and the agent said Premiere had quit while
# Media Encoder went on to render the file. Only a gap this long then means Premiere is gone.
RUNNING_WITHIN_S = 60.0
POLL_S = 0.02
# A request the panel has started (renamed to .running) gets this much longer while its heartbeat stays
# fresh: a busy Premiere answered one place_clip 2.5 minutes after its 20 s were up (seen 2026-10-14).
STILL_WORKING_S = 180.0

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
        # Replies to requests this side stopped waiting for; Premiere may still write them (seen 2026-10-16:
        # 30 late `status` answers left in replies/), so each request clears those that have arrived.
        self._late: set[Path] = set()

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
        """The panel's latest heartbeat, or Unreachable saying why there is none. A late heartbeat is
        allowed RUNNING_WITHIN_S while the panel is running a request."""
        alive = self.heartbeat()
        if alive is None:
            raise Unreachable(NOT_INSTALLED)
        stamp = alive.get("time")
        age = self._clock() - stamp if isinstance(stamp, (int, float)) else None
        if age is None:
            raise Unreachable("Premiere Pro isn't running.")
        if age > ALIVE_WITHIN_S:
            if not self._running():
                raise Unreachable("Premiere Pro isn't running.")
            if age > RUNNING_WITHIN_S:
                raise Unreachable(
                    f"Premiere Pro hasn't responded for {round(age)} s while working on a request from "
                    "VibeCut Agent. If it's frozen or has quit, restart it."
                )
        return alive

    def request(self, command: str, args: dict[str, Any], timeout_s: float, *, patient: bool = True) -> Any:
        """Sends one request and returns the panel's result, or raises HostError with its error.

        No answer in time raises Busy while the panel's heartbeat is fresh (Premiere is running but working,
        or a dialog is open), else Unreachable. A request the panel has started gets STILL_WORKING_S more,
        unless `patient` is False (the watcher's probe, which mustn't hold up the calls queued behind it)."""
        self._sweep()
        self.check_alive()
        self._next += 1
        request_id = f"{self._session}-{self._next}"
        job = self.jobs / f"{request_id}.json"
        reply = self.replies / f"{request_id}.json"
        _write_json(job, {"id": request_id, "command": command, "args": args})
        started = self._clock()
        deadline = started + timeout_s
        extended = False
        last_check = started
        while not reply.exists():
            now = self._clock()
            if now >= deadline:
                taken = self._taken(job)
                if taken and patient and not extended:
                    extended = True
                    deadline += STILL_WORKING_S
                    continue
                self._withdraw(job)
                if self._taken(job) or reply.exists():
                    self._late.add(reply)
                message = self._no_answer(command, taken, round(now - started))
                self.check_alive()  # a stale heartbeat raises Unreachable: Premiere is gone, not busy
                raise Busy(message)
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
            self._sweep()  # the panel answers in order, so an earlier late reply is in by now
        if not isinstance(answer, dict) or answer.get("id") != request_id:
            raise HostError(f"Premiere's reply to {command} was for another request")
        if answer.get("ok") is True:
            return answer.get("result")
        error = str(answer.get("error") or "Premiere couldn't do that")
        if error.startswith("Unknown command:"):
            # The panel Premiere has loaded is older than this side: Update panel replaces its files, but
            # Premiere keeps running the copy it loaded until it reloads the panel (seen 2026-10-09).
            running = (self.heartbeat() or {}).get("panelVersion") or "an older version"
            raise HostError(
                f"Premiere is still running VibeCut Agent's panel {running}, loaded before the panel was "
                f"updated, and it can't do {command} yet. Restart Premiere (or close and reopen the panel "
                "in Window > Extensions), then try again. This step wasn't done."
            )
        raise HostError(error)

    def _sweep(self) -> None:
        """Removes late replies that have arrived, and forgets those that never will (the panel no longer
        has the request: it was restarted)."""
        for reply in list(self._late):
            if reply.exists():
                with contextlib.suppress(FileNotFoundError):
                    reply.unlink()
                self._late.discard(reply)
            elif not self._taken(self.jobs / reply.name):
                self._late.discard(reply)

    def _running(self) -> bool:
        """The panel has started a request (this one or one this side stopped waiting for)."""
        return any(self.jobs.glob("*.json.running"))

    @staticmethod
    def _taken(job: Path) -> bool:
        """The panel renames a request to <id>.json.running when it starts on it."""
        return job.with_name(job.name + ".running").exists()

    def _no_answer(self, command: str, taken: bool, waited: int) -> str:
        if taken:
            return (
                f"Premiere started {command} but hadn't finished it after {waited} s. It may be busy "
                "(loading or conforming media, or rendering), or a dialog may be open. VibeCut Agent "
                "stopped waiting, but Premiere may still finish it; wait until it's idle, then try again."
            )
        if (self.heartbeat() or {}).get("busy") is True:
            return (
                f"Premiere didn't start {command} within {waited} s because it was still working on an "
                "earlier request. Wait until it's idle, then try again."
            )
        return (
            f"Premiere didn't answer {command} within {waited} s. A dialog open in Premiere stops it "
            "answering; close it and try again."
        )

    def _withdraw(self, job: Path) -> None:
        """Takes back a request the panel hasn't started, so it doesn't run after this side gave up."""
        with contextlib.suppress(FileNotFoundError):
            job.unlink()
