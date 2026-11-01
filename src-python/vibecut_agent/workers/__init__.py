"""The local sub-agent workers for `EXECUTION_MODE=orchestrated` (ORCHESTRATOR_SPEC.md §2; PLAN.md,
"Phase 21"): Whisper, the VLM keyframe tagger, the vector store and the Gemma validator. Every worker
shares base.py's GPU lock, so only one local model runs at a time."""
