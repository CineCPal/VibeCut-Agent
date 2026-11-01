"""The orchestrator's data contracts (ORCHESTRATOR_SPEC.md §3; PLAN.md, "Phase 21"), Draft 2020-12 JSON
Schemas exactly as the spec writes them (tests/orchestrator/test_schemas.py checks they still match it).

- COMMON_TIME_SCHEMA: `RationalTime` and `TimeRange` (§3.1), which the others `$ref` by `$id`.
- ORCHESTRATOR_TOOLS: Claude's six orchestration tools (§3.2).
- OTIO_DELTA_SCHEMA: a declarative timeline change (`vibecut.otio.delta.v1`, §3.3).
- The workers' results (§3.4): WHISPER_TRANSCRIPT_SCHEMA (`vibecut.whisper.v2`), VLM_KEYFRAME_SCHEMA
  (`vibecut.vlm.v1`), VECTOR_SEARCH_SCHEMA (`vibecut.vector.v1`), GEMMA_VALIDATION_SCHEMA
  (`vibecut.gemma.validator.v1`).

`validate` checks a document against one of them, resolving the `$ref`s between them. jsonschema comes
with the `orchestrator` extra (and the dev group), and is imported only when something is checked."""

from __future__ import annotations

from functools import cache
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from jsonschema.protocols import Validator
    from referencing import Registry

OTIO_DELTA_VERSION = "vibecut.otio.delta.v1"
WHISPER_VERSION = "vibecut.whisper.v2"
VLM_VERSION = "vibecut.vlm.v1"
VECTOR_VERSION = "vibecut.vector.v1"
GEMMA_VALIDATOR_VERSION = "vibecut.gemma.validator.v1"

COMMON_TIME_ID = "https://vibecut.local/schemas/common_time.json"
OTIO_DELTA_ID = "https://vibecut.local/schemas/otio_delta.json"
WHISPER_TRANSCRIPT_ID = "https://vibecut.local/schemas/whisper_transcript_result.json"
VLM_KEYFRAME_ID = "https://vibecut.local/schemas/vlm_keyframe_result.json"
VECTOR_SEARCH_ID = "https://vibecut.local/schemas/vector_search_result.json"
GEMMA_VALIDATION_ID = "https://vibecut.local/schemas/gemma_validation_result.json"

COMMON_TIME_SCHEMA: dict[str, Any] = {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "$id": "https://vibecut.local/schemas/common_time.json",
    "$defs": {
        "RationalTime": {
            "type": "object",
            "required": ["OTIO_SCHEMA", "value", "rate"],
            "additionalProperties": False,
            "properties": {
                "OTIO_SCHEMA": {"type": "string", "const": "RationalTime.1"},
                "value": {
                    "type": "number",
                    "description": "Exact frame count at the given rate (integer for frame-aligned cuts).",
                },
                "rate": {
                    "type": "number",
                    "enum": [23.976, 24.0, 25.0, 29.97, 30.0, 50.0, 59.94, 60.0],
                    "description": "Timeline or media frame rate in frames per second.",
                },
            },
        },
        "TimeRange": {
            "type": "object",
            "required": ["OTIO_SCHEMA", "start_time", "duration"],
            "additionalProperties": False,
            "properties": {
                "OTIO_SCHEMA": {"type": "string", "const": "TimeRange.1"},
                "start_time": {"$ref": "#/$defs/RationalTime"},
                "duration": {"$ref": "#/$defs/RationalTime"},
            },
        },
    },
}

ORCHESTRATOR_TOOLS: list[dict[str, Any]] = [
    {
        "name": "semantic_asset_search",
        "description": "Performs hybrid dense vector + lexical retrieval across indexed transcripts (Whisper word-level) and visual shot tags (VLM + SigLIP 2). Returns ranked candidate clips with exact RationalTime source ranges.",
        "input_schema": {
            "type": "object",
            "required": ["query", "modality"],
            "additionalProperties": False,
            "properties": {
                "query": {
                    "type": "string",
                    "minLength": 2,
                    "description": "Natural language search query describing dialogue content, visual framing, action, or mood.",
                },
                "modality": {
                    "type": "string",
                    "enum": ["dialogue", "visual", "hybrid"],
                    "description": "Target index modality: 'dialogue' searches Whisper transcripts, 'visual' searches VLM tags + SigLIP2 frames, 'hybrid' combines both via Reciprocal Rank Fusion.",
                },
                "scope_paths": {
                    "type": "array",
                    "items": {"type": "string"},
                    "description": "Optional list of absolute file or folder paths to restrict the search scope.",
                },
                "filters": {
                    "type": "object",
                    "additionalProperties": False,
                    "properties": {
                        "shot_scales": {
                            "type": "array",
                            "items": {
                                "type": "string",
                                "enum": [
                                    "ECU",
                                    "CU",
                                    "MCU",
                                    "MS",
                                    "MWS",
                                    "WS",
                                    "EWS",
                                    "INSERT",
                                    "OTS",
                                    "TWO_SHOT",
                                ],
                            },
                        },
                        "camera_motions": {
                            "type": "array",
                            "items": {
                                "type": "string",
                                "enum": [
                                    "STATIC",
                                    "PAN_LEFT",
                                    "PAN_RIGHT",
                                    "TILT_UP",
                                    "TILT_DOWN",
                                    "DOLLY_IN",
                                    "DOLLY_OUT",
                                    "HANDHELD",
                                    "GIMBAL_TRACK",
                                    "ZOOM",
                                ],
                            },
                        },
                        "speaker": {"type": "string"},
                        "min_duration_seconds": {"type": "number", "minimum": 0.2},
                        "max_duration_seconds": {"type": "number", "minimum": 0.5},
                        "min_technical_score": {"type": "number", "minimum": 0, "maximum": 100},
                    },
                },
                "top_k": {"type": "integer", "minimum": 1, "maximum": 25, "default": 8},
            },
        },
    },
    {
        "name": "transcribe_and_align",
        "description": "Dispatches the Local Whisper Worker on a media file (or reads its verified .ivt-cache.json cache) to return word-level timecode segments and speaker diarization.",
        "input_schema": {
            "type": "object",
            "required": ["media_path"],
            "additionalProperties": False,
            "properties": {
                "media_path": {"type": "string", "description": "Absolute path to the source media file."},
                "model_tier": {
                    "type": "string",
                    "enum": ["tiny", "small", "medium", "large-v3"],
                    "default": "medium",
                },
                "enable_diarization": {"type": "boolean", "default": False},
                "source_range_seconds": {
                    "type": "object",
                    "additionalProperties": False,
                    "properties": {
                        "start": {"type": "number", "minimum": 0},
                        "end": {"type": "number", "minimum": 0},
                    },
                },
            },
        },
    },
    {
        "name": "analyze_shot_visuals",
        "description": "Dispatches the Local Vision-Language Worker (Qwen-VL / Gemma Vision) on extracted keyframes within a clip range to classify framing, lighting, camera motion, and visual content tags.",
        "input_schema": {
            "type": "object",
            "required": ["media_path"],
            "additionalProperties": False,
            "properties": {
                "media_path": {"type": "string", "description": "Absolute path to the video file."},
                "start_seconds": {"type": "number", "minimum": 0, "default": 0},
                "end_seconds": {"type": "number", "minimum": 0},
                "sample_strategy": {
                    "type": "string",
                    "enum": ["scene_cuts", "uniform_2s", "midpoint_only"],
                    "default": "scene_cuts",
                },
                "custom_prompt_focus": {
                    "type": "string",
                    "description": "Optional specific visual question for the local VLM (e.g., 'Check if subject is looking at camera or off-screen left').",
                },
            },
        },
    },
    {
        "name": "detect_media_boundaries",
        "description": "Runs Deterministic Media Core FFmpeg detectors (silence detection, hard scene-cut detection, and EBU R128 loudness) to find frame-accurate cut points.",
        "input_schema": {
            "type": "object",
            "required": ["media_path", "detectors"],
            "additionalProperties": False,
            "properties": {
                "media_path": {"type": "string"},
                "detectors": {
                    "type": "array",
                    "minItems": 1,
                    "items": {"type": "string", "enum": ["silence", "scene_cuts", "loudness"]},
                },
                "start_seconds": {"type": "number", "minimum": 0, "default": 0},
                "end_seconds": {"type": "number", "minimum": 0},
                "silence_noise_db": {"type": "number", "default": -35.0, "maximum": -10.0},
                "silence_min_duration": {"type": "number", "default": 0.35, "minimum": 0.1},
                "scene_cut_sensitivity": {
                    "type": "string",
                    "enum": ["low", "normal", "high"],
                    "default": "normal",
                },
            },
        },
    },
    {
        "name": "propose_otio_delta",
        "description": "Submits a declarative OpenTimelineIO (OTIO) Delta Mutation payload to the Local Gemma Validator and Deterministic OTIO Engine for pre-flight verification without mutating the live NLE timeline.",
        "input_schema": {
            "type": "object",
            "required": ["delta"],
            "additionalProperties": False,
            "properties": {"delta": {"$ref": "https://vibecut.local/schemas/otio_delta.json"}},
        },
    },
    {
        "name": "commit_otio_delta",
        "description": "Executes a previously validated OTIO Delta payload against the connected NLE (DaVinci Resolve or Premiere Pro) inside an atomic backup/revert transaction.",
        "input_schema": {
            "type": "object",
            "required": ["validation_token", "commit_summary"],
            "additionalProperties": False,
            "properties": {
                "validation_token": {
                    "type": "string",
                    "pattern": "^vtok_[a-f0-9]{32}$",
                    "description": "Cryptographic digest token returned by a passing `propose_otio_delta` call.",
                },
                "commit_summary": {
                    "type": "string",
                    "minLength": 5,
                    "description": "Human-readable editorial summary recorded in the VibeCut Agent Edit Log.",
                },
                "execution_strategy": {
                    "type": "string",
                    "enum": ["incremental_bridge", "otio_timeline_rebuild"],
                    "default": "incremental_bridge",
                    "description": "'incremental_bridge' dispatches translated NLE API commands; 'otio_timeline_rebuild' imports a compiled OTIO/XML sequence.",
                },
            },
        },
    },
]

OTIO_DELTA_SCHEMA: dict[str, Any] = {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "$id": "https://vibecut.local/schemas/otio_delta.json",
    "title": "OtioDeltaPayload",
    "type": "object",
    "required": [
        "schema_version",
        "delta_id",
        "target_host",
        "target_timeline",
        "timeline_fps",
        "narrative_rationale",
        "operations",
    ],
    "additionalProperties": False,
    "properties": {
        "schema_version": {"type": "string", "const": "vibecut.otio.delta.v1"},
        "delta_id": {"type": "string", "minLength": 8},
        "target_host": {"type": "string", "enum": ["premiere", "resolve"]},
        "target_timeline": {"type": "string", "minLength": 1},
        "expected_timeline_hash": {
            "type": ["string", "null"],
            "description": "SHA-256 hash of the canonicalized HostTimeline snapshot at plan time; prevents stale-state race conditions.",
        },
        "timeline_fps": {"type": "number", "enum": [23.976, 24.0, 25.0, 29.97, 30.0, 50.0, 59.94, 60.0]},
        "narrative_rationale": {
            "type": "string",
            "description": "Supervisor's explanation of pacing, story arc, or visual continuity served by this delta.",
        },
        "operations": {
            "type": "array",
            "minItems": 1,
            "maxItems": 200,
            "items": {"$ref": "#/$defs/DeltaOperation"},
        },
    },
    "$defs": {
        "DeltaOperation": {
            "type": "object",
            "required": ["op_id", "op_type", "track_Selector"],
            "additionalProperties": False,
            "properties": {
                "op_id": {"type": "string", "pattern": "^op_[0-9]{3,4}$"},
                "op_type": {
                    "type": "string",
                    "enum": [
                        "INSERT_CLIP",
                        "OVERWRITE_CLIP",
                        "TRIM_CLIP",
                        "SPLIT_CLIP",
                        "DELETE_CLIP",
                        "MOVE_CLIP",
                        "INSERT_GAP",
                        "APPLY_TRANSITION",
                        "SET_AUDIO_GAIN",
                        "DUCK_REGION",
                    ],
                },
                "track_Selector": {
                    "type": "object",
                    "required": ["kind", "index"],
                    "additionalProperties": False,
                    "properties": {
                        "kind": {"type": "string", "enum": ["Video", "Audio"]},
                        "index": {
                            "type": "integer",
                            "minimum": 1,
                            "description": "1-based track index (e.g. V1 -> 1, V2 -> 2, A1 -> 1).",
                        },
                    },
                },
                "clip_id": {
                    "type": ["string", "null"],
                    "description": "Target clip ID on the timeline (required for TRIM_CLIP, SPLIT_CLIP, DELETE_CLIP, MOVE_CLIP, SET_AUDIO_GAIN).",
                },
                "media_reference": {
                    "type": ["object", "null"],
                    "required": ["OTIO_SCHEMA", "target_url", "source_name"],
                    "additionalProperties": False,
                    "properties": {
                        "OTIO_SCHEMA": {"type": "string", "const": "ExternalReference.1"},
                        "target_url": {"type": "string", "pattern": "^file:///"},
                        "source_name": {"type": "string"},
                        "available_range": {
                            "$ref": "https://vibecut.local/schemas/common_time.json#/$defs/TimeRange"
                        },
                    },
                },
                "source_range": {
                    "$ref": "https://vibecut.local/schemas/common_time.json#/$defs/TimeRange",
                    "description": "In/duration range inside the source media file.",
                },
                "timeline_range": {
                    "$ref": "https://vibecut.local/schemas/common_time.json#/$defs/TimeRange",
                    "description": "Target placement or affected window on the sequence timeline.",
                },
                "ripple": {
                    "type": "boolean",
                    "default": False,
                    "description": "Whether subsequent clips on the track ripple-shift when inserting, trimming, or deleting.",
                },
                "transition": {
                    "type": ["object", "null"],
                    "required": ["OTIO_SCHEMA", "transition_type", "in_offset", "out_offset"],
                    "additionalProperties": False,
                    "properties": {
                        "OTIO_SCHEMA": {"type": "string", "const": "Transition.1"},
                        "transition_type": {
                            "type": "string",
                            "enum": ["SMPTE_Dissolve", "Dip_To_Black", "Audio_Crossfade"],
                        },
                        "in_offset": {
                            "$ref": "https://vibecut.local/schemas/common_time.json#/$defs/RationalTime"
                        },
                        "out_offset": {
                            "$ref": "https://vibecut.local/schemas/common_time.json#/$defs/RationalTime"
                        },
                    },
                },
                "audio_params": {
                    "type": ["object", "null"],
                    "additionalProperties": False,
                    "properties": {
                        "gain_db": {"type": "number", "minimum": -100.0, "maximum": 24.0},
                        "duck_Floor_db": {"type": "number", "minimum": -60.0, "maximum": 0.0},
                        "fade_in_seconds": {"type": "number", "minimum": 0.0},
                        "fade_out_seconds": {"type": "number", "minimum": 0.0},
                    },
                },
                "link_group_id": {
                    "type": ["string", "null"],
                    "description": "Links A-roll picture and synced audio across V/A tracks (mapped to Resolve_OTIO Link Group ID or Premiere link_clips).",
                },
                "metadata": {"type": "object", "additionalProperties": True},
            },
        }
    },
}

WHISPER_TRANSCRIPT_SCHEMA: dict[str, Any] = {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "$id": "https://vibecut.local/schemas/whisper_transcript_result.json",
    "title": "WhisperTranscriptResult",
    "type": "object",
    "required": [
        "schema_version",
        "path",
        "name",
        "video_size",
        "video_mtime",
        "media_fps",
        "backend",
        "model_id",
        "speakers",
        "segments",
    ],
    "additionalProperties": False,
    "properties": {
        "schema_version": {"type": "string", "const": "vibecut.whisper.v2"},
        "path": {"type": "string"},
        "name": {"type": "string"},
        "video_size": {"type": "integer"},
        "video_mtime": {"type": "integer"},
        "media_fps": {"type": "number"},
        "backend": {"type": "string", "enum": ["mlx-whisper", "faster-whisper", "whisper.cpp"]},
        "model_id": {"type": "string"},
        "speakers": {"type": "array", "items": {"type": "string"}},
        "speaker_labels": {"type": "object", "additionalProperties": {"type": "string"}},
        "excluded_speakers": {"type": "array", "items": {"type": "string"}},
        "segments": {
            "type": "array",
            "items": {
                "type": "object",
                "required": [
                    "segment_id",
                    "start",
                    "end",
                    "start_tc",
                    "end_tc",
                    "source_range",
                    "text",
                    "speaker",
                    "avg_logprob",
                    "no_speech_prob",
                    "low_confidence",
                    "words",
                ],
                "additionalProperties": False,
                "properties": {
                    "segment_id": {"type": "string"},
                    "start": {"type": "number"},
                    "end": {"type": "number"},
                    "start_tc": {"type": "string", "pattern": "^[0-9]{2}:[0-9]{2}:[0-9]{2}[:;][0-9]{2}$"},
                    "end_tc": {"type": "string", "pattern": "^[0-9]{2}:[0-9]{2}:[0-9]{2}[:;][0-9]{2}$"},
                    "source_range": {
                        "$ref": "https://vibecut.local/schemas/common_time.json#/$defs/TimeRange"
                    },
                    "text": {"type": "string"},
                    "speaker": {"type": "string"},
                    "avg_logprob": {"type": "number"},
                    "no_speech_prob": {"type": "number"},
                    "low_confidence": {"type": "boolean"},
                    "words": {
                        "type": "array",
                        "items": {
                            "type": "object",
                            "required": ["text", "start", "end", "start_frame", "end_frame", "probability"],
                            "additionalProperties": False,
                            "properties": {
                                "text": {"type": "string"},
                                "start": {"type": "number"},
                                "end": {"type": "number"},
                                "start_frame": {"type": "integer", "minimum": 0},
                                "end_frame": {"type": "integer", "minimum": 1},
                                "probability": {"type": "number", "minimum": 0.0, "maximum": 1.0},
                            },
                        },
                    },
                },
            },
        },
    },
}

VLM_KEYFRAME_SCHEMA: dict[str, Any] = {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "$id": "https://vibecut.local/schemas/vlm_keyframe_result.json",
    "title": "VlmKeyframeAnalysisResult",
    "type": "object",
    "required": [
        "schema_version",
        "media_path",
        "video_size",
        "video_mtime",
        "media_fps",
        "vlm_model_id",
        "shots",
    ],
    "additionalProperties": False,
    "properties": {
        "schema_version": {"type": "string", "const": "vibecut.vlm.v1"},
        "media_path": {"type": "string"},
        "video_size": {"type": "integer"},
        "video_mtime": {"type": "integer"},
        "media_fps": {"type": "number"},
        "vlm_model_id": {
            "type": "string",
            "description": "Local VLM identifier, e.g. 'qwen2.5-vl:7b-instruct' or 'gemma3:12b-it-qat'.",
        },
        "shots": {
            "type": "array",
            "items": {
                "type": "object",
                "required": [
                    "shot_id",
                    "source_range",
                    "keyframe_timestamp_sec",
                    "shot_scale",
                    "camera_movement",
                    "lighting",
                    "composition",
                    "description",
                    "visual_tags",
                    "editorial_usability_score",
                ],
                "additionalProperties": False,
                "properties": {
                    "shot_id": {"type": "string"},
                    "source_range": {
                        "$ref": "https://vibecut.local/schemas/common_time.json#/$defs/TimeRange"
                    },
                    "keyframe_timestamp_sec": {"type": "number", "minimum": 0.0},
                    "shot_scale": {
                        "type": "string",
                        "enum": ["ECU", "CU", "MCU", "MS", "MWS", "WS", "EWS", "INSERT", "OTS", "TWO_SHOT"],
                    },
                    "camera_movement": {
                        "type": "string",
                        "enum": [
                            "STATIC",
                            "PAN_LEFT",
                            "PAN_RIGHT",
                            "TILT_UP",
                            "TILT_DOWN",
                            "DOLLY_IN",
                            "DOLLY_OUT",
                            "HANDHELD",
                            "GIMBAL_TRACK",
                            "ZOOM",
                        ],
                    },
                    "lighting": {
                        "type": "object",
                        "required": ["key_style", "color_temperature", "contrast"],
                        "additionalProperties": False,
                        "properties": {
                            "key_style": {
                                "type": "string",
                                "enum": [
                                    "NATURAL_DAYLIGHT",
                                    "GOLDEN_HOUR",
                                    "STUDIO_HIGH_KEY",
                                    "LOW_KEY_MOODY",
                                    "NEON_PRACTICAL",
                                    "OVERCAST_SOFT",
                                    "FLUORESCENT_FLAT",
                                ],
                            },
                            "color_temperature": {
                                "type": "string",
                                "enum": ["WARM", "NEUTRAL", "COOL", "MIXED"],
                            },
                            "contrast": {"type": "string", "enum": ["LOW", "MEDIUM", "HIGH"]},
                        },
                    },
                    "composition": {
                        "type": "object",
                        "required": ["subject_count", "eyeline_direction", "focus_quality", "obstructions"],
                        "additionalProperties": False,
                        "properties": {
                            "subject_count": {"type": "integer", "minimum": 0},
                            "eyeline_direction": {
                                "type": "string",
                                "enum": [
                                    "DIRECT_TO_LENS",
                                    "LOOKING_LEFT",
                                    "LOOKING_RIGHT",
                                    "LOOKING_DOWN",
                                    "LOOKING_UP",
                                    "NONE",
                                ],
                            },
                            "focus_quality": {
                                "type": "string",
                                "enum": [
                                    "TACK_SHARP",
                                    "SOFT_FOCUS",
                                    "RACK_FOCUS",
                                    "MOTION_BLUR",
                                    "OUT_OF_FOCUS",
                                ],
                            },
                            "obstructions": {"type": "boolean"},
                        },
                    },
                    "description": {"type": "string", "minLength": 5},
                    "visual_tags": {"type": "array", "items": {"type": "string"}, "minItems": 1},
                    "on_screen_text": {"type": ["string", "null"]},
                    "editorial_usability_score": {"type": "number", "minimum": 0.0, "maximum": 100.0},
                },
            },
        },
    },
}

VECTOR_SEARCH_SCHEMA: dict[str, Any] = {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "$id": "https://vibecut.local/schemas/vector_search_result.json",
    "title": "VectorSearchResult",
    "type": "object",
    "required": [
        "schema_version",
        "query",
        "modality",
        "embedding_model",
        "vector_backend",
        "latency_ms",
        "hits",
    ],
    "additionalProperties": False,
    "properties": {
        "schema_version": {"type": "string", "const": "vibecut.vector.v1"},
        "query": {"type": "string"},
        "modality": {"type": "string", "enum": ["dialogue", "visual", "hybrid"]},
        "embedding_model": {"type": "string", "enum": ["BAAI/bge-m3", "nomic-ai/nomic-embed-text-v1.5"]},
        "vector_backend": {"type": "string", "enum": ["sqlite-vec", "lancedb"]},
        "latency_ms": {"type": "number", "minimum": 0.0},
        "hits": {
            "type": "array",
            "items": {
                "type": "object",
                "required": [
                    "hit_id",
                    "rank",
                    "media_path",
                    "filename",
                    "source_range",
                    "start_tc",
                    "end_tc",
                    "scores",
                    "evidence",
                ],
                "additionalProperties": False,
                "properties": {
                    "hit_id": {"type": "string"},
                    "rank": {"type": "integer", "minimum": 1},
                    "media_path": {"type": "string"},
                    "filename": {"type": "string"},
                    "source_range": {
                        "$ref": "https://vibecut.local/schemas/common_time.json#/$defs/TimeRange"
                    },
                    "start_tc": {"type": "string"},
                    "end_tc": {"type": "string"},
                    "scores": {
                        "type": "object",
                        "required": ["rrf_combined", "dense_cosine", "siglip_visual", "technical_quality"],
                        "additionalProperties": False,
                        "properties": {
                            "rrf_combined": {"type": "number", "minimum": 0.0, "maximum": 100.0},
                            "dense_cosine": {"type": "number", "minimum": -1.0, "maximum": 1.0},
                            "siglip_visual": {"type": ["number", "null"]},
                            "technical_quality": {"type": ["number", "null"]},
                        },
                    },
                    "evidence": {
                        "type": "object",
                        "required": ["matched_modality"],
                        "additionalProperties": False,
                        "properties": {
                            "matched_modality": {
                                "type": "string",
                                "enum": ["transcript", "vlm_shot", "both"],
                            },
                            "transcript_excerpt": {"type": ["string", "null"]},
                            "speaker": {"type": ["string", "null"]},
                            "shot_scale": {"type": ["string", "null"]},
                            "camera_movement": {"type": ["string", "null"]},
                            "vlm_description": {"type": ["string", "null"]},
                            "visual_tags": {"type": "array", "items": {"type": "string"}},
                        },
                    },
                },
            },
        },
    },
}

GEMMA_VALIDATION_SCHEMA: dict[str, Any] = {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "$id": "https://vibecut.local/schemas/gemma_validation_result.json",
    "title": "GemmaValidationResult",
    "type": "object",
    "required": [
        "schema_version",
        "delta_id",
        "valid",
        "validation_token",
        "validator_model",
        "diagnostics",
        "translated_nle_batch",
    ],
    "additionalProperties": False,
    "properties": {
        "schema_version": {"type": "string", "const": "vibecut.gemma.validator.v1"},
        "delta_id": {"type": "string"},
        "valid": {"type": "boolean"},
        "validation_token": {
            "type": ["string", "null"],
            "pattern": "^vtok_[a-f0-9]{32}$",
            "description": "Issued only when valid=true; required by `commit_otio_delta`.",
        },
        "validator_model": {"type": "string", "description": "e.g. 'gemma3:4b-it' or 'gemma2:9b-instruct'."},
        "diagnostics": {
            "type": "array",
            "items": {
                "type": "object",
                "required": ["severity", "code", "op_id", "message", "remediation_hint"],
                "additionalProperties": False,
                "properties": {
                    "severity": {"type": "string", "enum": ["ERROR", "WARNING"]},
                    "code": {
                        "type": "string",
                        "enum": [
                            "SOURCE_OUT_OF_BOUNDS",
                            "NEGATIVE_OR_ZERO_DURATION",
                            "TRACK_OVERLAP_COLLISION",
                            "MISSING_MEDIA_FILE",
                            "UNKNOWN_CLIP_ID",
                            "RATE_MISMATCH",
                            "STALE_TIMELINE_HASH",
                            "INVALID_TRANSITION_HANDLE",
                        ],
                    },
                    "op_id": {"type": ["string", "null"]},
                    "message": {"type": "string"},
                    "remediation_hint": {"type": "string"},
                },
            },
        },
        "translated_nle_batch": {
            "type": "array",
            "description": "Concrete, ordered NLE bridge calls ready for PremiereAdapter.call() or ResolveAdapter.call().",
            "items": {
                "type": "object",
                "required": ["seq", "source_op_id", "host", "command", "args"],
                "additionalProperties": False,
                "properties": {
                    "seq": {"type": "integer", "minimum": 1},
                    "source_op_id": {"type": "string"},
                    "host": {"type": "string", "enum": ["premiere", "resolve"]},
                    "command": {
                        "type": "string",
                        "enum": [
                            "backup_timeline",
                            "add_clips",
                            "delete_clips",
                            "reshape_clip",
                            "split_clips",
                            "set_clip_levels",
                            "set_clip_fades",
                            "set_transition",
                            "duck_clip",
                            "set_links",
                            "add_track",
                            "rebuild",
                        ],
                    },
                    "args": {"type": "object", "additionalProperties": True},
                },
            },
        },
    },
}

SCHEMAS: dict[str, dict[str, Any]] = {
    COMMON_TIME_ID: COMMON_TIME_SCHEMA,
    OTIO_DELTA_ID: OTIO_DELTA_SCHEMA,
    WHISPER_TRANSCRIPT_ID: WHISPER_TRANSCRIPT_SCHEMA,
    VLM_KEYFRAME_ID: VLM_KEYFRAME_SCHEMA,
    VECTOR_SEARCH_ID: VECTOR_SEARCH_SCHEMA,
    GEMMA_VALIDATION_ID: GEMMA_VALIDATION_SCHEMA,
}
TOOLS_BY_NAME: dict[str, dict[str, Any]] = {tool["name"]: tool for tool in ORCHESTRATOR_TOOLS}


class SchemaError(ValueError):
    """A document doesn't match its schema. `errors` lists each problem as "<where>: <what>"."""

    def __init__(self, what: str, errors: list[str]) -> None:
        super().__init__(f"{what} doesn't match its schema: " + "; ".join(errors[:5]))
        self.errors = errors


@cache
def _registry() -> Registry[Any]:
    from referencing import Registry, Resource
    from referencing.jsonschema import DRAFT202012

    return Registry().with_resources(
        (uri, Resource.from_contents(schema, default_specification=DRAFT202012))
        for uri, schema in SCHEMAS.items()
    )


@cache
def _validator(schema_id: str | None, tool: str | None) -> Validator:
    from jsonschema import Draft202012Validator

    if tool is not None:
        schema = TOOLS_BY_NAME[tool]["input_schema"]
    else:
        assert schema_id is not None
        schema = SCHEMAS[schema_id]
    return Draft202012Validator(schema, registry=_registry())


def _problems(validator: Validator, document: Any) -> list[str]:
    errors = sorted(validator.iter_errors(document), key=lambda e: list(e.absolute_path))
    return [f"{e.json_path}: {e.message}" for e in errors]


def errors_in(document: Any, schema_id: str) -> list[str]:
    """Every way `document` breaks the schema with this `$id` (empty when it matches)."""
    if schema_id not in SCHEMAS:
        raise KeyError(f"No schema {schema_id}")
    return _problems(_validator(schema_id, None), document)


def errors_against(document: Any, schema: dict[str, Any]) -> list[str]:
    """Every way `document` breaks a schema given inline (e.g. one shot of VLM_KEYFRAME_SCHEMA), its `$ref`s
    resolved against SCHEMAS."""
    from jsonschema import Draft202012Validator

    return _problems(Draft202012Validator(schema, registry=_registry()), document)


def validate(document: Any, schema_id: str) -> None:
    """Raises SchemaError unless `document` matches the schema with this `$id`."""
    errors = errors_in(document, schema_id)
    if errors:
        raise SchemaError(SCHEMAS[schema_id].get("title") or schema_id, errors)


def validate_tool_input(tool: str, arguments: Any) -> None:
    """Raises SchemaError unless `arguments` fit the orchestration tool's `input_schema`."""
    if tool not in TOOLS_BY_NAME:
        raise KeyError(f"No orchestration tool {tool}")
    errors = _problems(_validator(None, tool), arguments)
    if errors:
        raise SchemaError(f"{tool}'s input", errors)
