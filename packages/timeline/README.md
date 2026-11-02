# packages/timeline

A pointer, not a package. The OTIO delta engine and the NLE bridges live in the Python sidecar:

- `src-python/vibecut_agent/orchestrator/otio_delta.py`: `vibecut.otio.delta.v1` checks and lowering to
  NLE commands.
- `src-python/vibecut_agent/nle/interchange/otio_builder.py`: the OTIO document builder.
- `src-python/vibecut_agent/nle/bridge_runner.py`: the atomic backup / execute / revert transaction.

The visualizer's OTIO dock (`apps/visualizer/src/components/timeline/`) shows these deltas as they are
proposed, validated and committed. See `docs/specs/visualizer-spec.md` §5.1 and PLAN.md, "Phase 22".
