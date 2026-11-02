# packages/core

A pointer, not a package. The deterministic media core lives in the Python sidecar, which is the only
Python Tauri bundles (`src-tauri/tauri.conf.json` `bundle.resources`):

- `src-python/vibecut_agent/core/timecode_math.py`: exact `RationalTime` / `TimeRange` math and SMPTE
  drop-frame timecode. The visualizer's `apps/visualizer/src/lib/timecode/rationalTime.ts` mirrors it and is
  tested on the same vectors.
- `src-python/vibecut_agent/core/ffmpeg_ops.py`: streaming ffmpeg wrappers (silence, scene cuts, contact
  strips).

See `docs/specs/visualizer-spec.md` §5.1 and PLAN.md, "Phase 22".
