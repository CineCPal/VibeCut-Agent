"""VibeCut Agent's Python sidecar: the agent session, ML pipelines and NLE bridge scripts.

Rust (`src-tauri/src/sidecar.rs`) runs it as ``python -u -m vibecut_agent <command>`` and talks to it
with the JSON-lines protocol in :mod:`vibecut_agent.protocol`.
"""

__version__ = "0.1.0"
