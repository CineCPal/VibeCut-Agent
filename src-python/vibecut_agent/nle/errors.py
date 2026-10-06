from __future__ import annotations


class HostError(Exception):
    """A request the editor can't carry out; the message is shown to the user and the agent."""


class Unreachable(Exception):
    """The editor isn't running, or VibeCut Agent can't reach it; the message says why and what to do."""
