"""The connection layer to Premiere Pro and DaVinci Resolve (PLAN.md, Phase 3).

Each editor has a watcher process (:mod:`vibecut_agent.nle.watch`) that Rust keeps running:
``premiere-watch`` under uv, ``resolve-watch`` under Resolve's own Python. Everything here is
standard library only, because Resolve's interpreter has no access to the uv environment.
"""
