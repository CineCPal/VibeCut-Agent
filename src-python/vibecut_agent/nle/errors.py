from __future__ import annotations


class HostError(Exception):
    """A request the editor can't carry out; the message is shown to the user and the agent."""


class Unreachable(Exception):
    """The editor isn't running, or VibeCut Agent can't reach it; the message says why and what to do."""


class Busy(Unreachable):
    """The editor is running (its panel's heartbeat is fresh) but didn't answer in time: it's working, or
    a dialog is open. The watcher keeps it connected; the call that waited is still refused."""
