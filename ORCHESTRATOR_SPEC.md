# Technical Specification: Orchestrator + Heterogeneous Local Sub-Agent Pipeline

**Target Repository:** `/Users/cj/Developer/Personal/VibeCut Agent`  
**Baseline Architecture:** Tauri v2 (`src-tauri/src/lib.rs`) + React 19 (`src/App.tsx`) + Python 3.13 Sidecar (`src-python/vibecut_agent/headless.py`) + NLE Watchers (`src-python/vibecut_agent/nle/watch.py`) + Premiere CEP Bridge (`src-premiere-panel/bridge.js`, `src-premiere-panel/host.jsx`).

---

## 1. System Architecture & Topology

### 1.1 End-to-End Data Flow Topology

```text
+======================================================================================================+
|                                     USER / REACT 19 FRONTEND                                         |
|  [ChatPanel.tsx] / [controller.ts]                         [LibraryPanel.tsx] / [FolderAnalyzer.tsx] |
+=================+============================================================+=======================+
                  | Tauri IPC: startSidecar("chat") / sendToSidecar            | Tauri IPC: startSidecar("ingest-index")
                  v                                                            v
+======================================================================================================+
|                                  RUST TAURI CORE (src-tauri/src/)                                    |
|  [sidecar.rs] (Stdio JSON-Lines Multiplexer)              [nle.rs] (Watcher Process Lifecycle)       |
|  Injects API keys + passes VIBECUT_EXECUTION_MODE ("direct" | "orchestrated")                        |
+=================+============================================================+=======================+
                  |                                                            |
                  | Execution Mode Router (src-python/vibecut_agent/config.py) |
         +--------+------------------------+                                   |
         | EXECUTION_MODE=direct           | EXECUTION_MODE=orchestrated       |
         v (Legacy Baseline Path)          v (New Decoupled Supervisor Path)   |
+------------------------+    +================================================+=======================+
| [claude_chat.py]       |    |                 CLAUDE SUPERVISING EDITOR / ORCHESTRATOR               |
| [gemini_chat.py]       |    |              (src-python/vibecut_agent/orchestrator/supervisor.py)     |
| Emits raw low-level    |    |  - Interprets narrative intent, pacing, story structure, & rhythm      |
| NLE tool_calls back    |    |  - Queries local semantic/vision/audio indexes via High-Level Tools    |
| to [controller.ts] ->  |    |  - Emits declarative OpenTimelineIO (OTIO) Delta Mutation Schemas      |
| [tools.ts] -> nleCall  |    +========================+===============================================+
+-----------+------------+                             |
            |                                          | High-Level Tool Calls (JSON over Tool Bus)
            |                                          v
            |                 +========================================================================+
            |                 |                     LOCAL ORCHESTRATOR TOOL BUS                        |
            |                 |           (src-python/vibecut_agent/orchestrator/tool_bus.py)          |
            |                 |            [Metal / Unified Memory Semaphore Concurrency Gate]         |
            |                 +====+================+==================+=================+=============+
            |                      |                |                  |                 |
            |                      v                v                  v                 v
            |        +----------------+  +-----------------+  +----------------+  +--------------------+
            |        | SPEECH WORKER  |  |  VISION WORKER  |  | VECTOR SEARCH  |  |  GEMMA VALIDATOR   |
            |        | faster-whisper |  | Qwen2.5-VL /    |  | BGE-M3 / Nomic |  |  Ollama / llama.cpp|
            |        | / mlx-whisper  |  | Gemma-3-Vision  |  | + LanceDB /    |  |  Fast JSON Schema  |
            |        | / whisper.cpp  |  | Keyframe Tagger |  | sqlite-vec     |  |  Pre-flight Check  |
            |        | Word-Level TC  |  | Framing/Motion/ |  | Hybrid RRF     |  |  & OTIO-to-NLE API |
            |        | JSON Cache     |  | Lighting Index  |  | Asset Retrieval|  |  Param Translator  |
            |        +-------+--------+  +--------+--------+  +--------+-------+  +---------+----------+
            |                ^                    ^                    ^                    |
            |                |                    |                    |                    | Validated
            |                +--------------------+--------------------+                    | Concrete
            |                                     |                                         | NLE Batch
            |        +============================+============================+            v
            |        |              DETERMINISTIC MEDIA CORE                   |  +--------------------+
            |        |    (src-python/vibecut_agent/core/ & media/)            |  | OTIO DELTA ENGINE  |
            |        |  - [ffmpeg_ops.py]: Streaming silencedetect, scdet,     |  | [otio_delta.py]    |
            |        |    histogram cuts ([shots.py]), proxy keyframes         |  | [timecode_math.py] |
            |        |  - [timecode_math.py]: RationalTime & SMPTE frame math  |  | [otio_builder.py]  |
            |        +=========================================================+  +---------+----------+
            |                                                                               |
            +------------------------------------------+------------------------------------+
                                                       |
                                                       v
+======================================================================================================+
|                           DETERMINISTIC NLE BRIDGE RUNNERS (src-python/vibecut_agent/nle/)           |
|                  [bridge_runner.py] -> Atomic Pre-Mutation Backup + Execution + Rollback             |
+--------------------------------------------------+---------------------------------------------------+
|          DAVINCI RESOLVE RUNNER                  |              ADOBE PREMIERE PRO RUNNER            |
|  [watch.py: ResolveAdapter]                      |  [watch.py: PremiereAdapter] -> [premiere_bridge] |
|  [resolve.py] / [resolve_edit.py]                |  File Queue: ~/Library/Application Support/       |
|  Executes via Resolve's bundled Python +         |  VibeCut Agent/host-bridge/premiere/jobs/<id>.json|
|  DaVinciResolveScript native IPC                 |  -> CEP [bridge.js] -> ExtendScript [host.jsx]    |
+==================================================+===================================================+
```

---

### 1.2 Pipeline Separation: Async Background Ingest vs. Real-Time Interactive Chat Loop

To obey `AGENTS.md` §8 (zero UI thread blocking, zero full-file RAM buffering, deterministic progress reporting) and prevent Apple Silicon Unified Memory / CUDA VRAM thrashing, the system is split into two strictly isolated execution planes:

| Dimension | Plane A: Async Background Ingest & Indexing (`ingest-index` Sidecar Job) | Plane B: Real-Time Interactive Chat & Edit Loop (`chat` Sidecar Job) |
| :--- | :--- | :--- |
| **Trigger Mechanism** | Triggered when media folders/bins are added, or explicitly via the B-Roll/Media Library UI (`startSidecar(jobId, "ingest-index", req)`). | Triggered per user prompt in `src/components/chat/ChatPanel.tsx` via `sendUserMessage` (`src/lib/agent/controller.ts`). |
| **Primary Workload** | Heavy, batch I/O and local model inference: FFmpeg audio extraction (`16kHz` mono stream), scene cut detection (`media/shots.py`), keyframe extraction, Whisper word-level transcription, VLM shot tagging, and dense vector embedding (`BGE-M3` / `nomic-embed-text-v1.5` + `SigLIP 2`). | Low-latency supervisory reasoning (Claude), sub-50ms vector queries (`sqlite-vec` / `LanceDB`), rational timecode math (`opentimelineio`), Gemma pre-flight schema validation (<300ms via Ollama/llama.cpp), and NLE bridge dispatch. |
| **Memory & GPU Concurrency** | Governed by an inter-process file lock (`<index_dir>/.gpu.lock`) so Whisper, VLM, and embedding models run sequentially in stages without exceeding 8 GB Unified Memory / VRAM. | Uses only lightweight query embedding + warm Gemma 4B/9B validator in local RAM/VRAM while Claude inference runs remotely (or via Claude Code subscription). Preempts background indexing if GPU lock is contested. |
| **Persistence Artifacts** | Writes immutable, fingerprint-validated cache artifacts next to media or in `<appDataDir>/vector-index/`: `<media>.ivt-cache.json` (Whisper), `<media>.vlm-tags.json` (VLM), `.broll_semantic_index.json` (SigLIP 2), and `vibecut_vectors.db` (`sqlite-vec` / `LanceDB`). | Reads from indexed stores; writes atomic OTIO snapshots (`<appDataDir>/otio_deltas/<step_id>.otio`) and NLE undo records in `src/store/useEditLogStore.ts`. |
| **Progress & Telemetry** | Streams `{ "type": "progress", "fraction": float, "phase": str, "detail": str, "etaSeconds": float }` over stdout JSON-lines to `src/store/useSidecarStore.ts`. | Streams `reply_delta`, `status`, `tool_calls`, and `result` events over stdout JSON-lines to `src/lib/agent/controller.ts`. |

---

## 2. Target Directory & Module Structure

All new backend orchestration, worker, and deterministic media modules reside under `src-python/vibecut_agent/` to maintain compatibility with `uv` packaging and `src-tauri/src/sidecar.rs` bundling (`bundle.resources` in `src-tauri/tauri.conf.json`).

```text
/Users/cj/Developer/Personal/VibeCut Agent/
├── AGENTS.md                                              # [MODIFIED] Shared architecture, dual-mode & schema contracts
├── CLAUDE.md                                              # [MODIFIED] Tactical implementation lock & handoff constraints
├── GEMINI.md                                              # [MODIFIED] Systems Architect governance & review gates
├── ORCHESTRATOR_SPEC.md                                   # [NEW] Canonical Technical Specification Document
├── pyproject.toml                                         # [MODIFIED] Optional extras: orchestrator, vector, whisper-cpp
├── src-tauri/
│   └── src/
│       ├── sidecar.rs                                     # [MODIFIED] Pass VIBECUT_EXECUTION_MODE & local worker env vars; allow "ingest-index"
│       └── commands.rs                                    # [MODIFIED] Expose execution_mode_status & local_worker_health IPC commands
├── src/
│   ├── types/
│   │   ├── system.ts                                      # [MODIFIED] Add ExecutionMode & LocalWorkerStatus types
│   │   └── orchestrator.ts                                # [NEW] TypeScript interfaces for OTIO deltas & orchestrator tool cards
│   ├── lib/
│   │   ├── ipc.ts                                         # [MODIFIED] Add getExecutionModeStatus() & getLocalWorkerHealth()
│   │   └── agent/
│   │       ├── tools.ts                                   # [MODIFIED] Factory switch: directToolDeclarations vs orchestratedToolDeclarations
│   │       ├── orchestratorTools.ts                       # [NEW] Frontend proxy executors when orchestrated tools route via sidecar
│   │       └── controller.ts                              # [MODIFIED] Inject executionMode into sidecar "chat" start payload
│   └── components/
│       └── about/
│           └── AboutModal.tsx                             # [MODIFIED] Display Execution Mode & Local Sub-Agent health (Whisper, VLM, Vector, Gemma)
├── src-python/
│   └── vibecut_agent/
│       ├── config.py                                      # [NEW] ExecutionMode enum, WorkerConfig dataclasses, env loader & factory
│       ├── headless.py                                    # [MODIFIED] Register "ingest-index" & "orchestrator-tool" commands
│       ├── health.py                                      # [MODIFIED] Probe Ollama/llama.cpp, Whisper, Vector DB, and OTIO availability
│       ├── agent/
│       │   ├── chat.py                                    # [MODIFIED] Route turn execution via ExecutionDispatcher (direct vs orchestrated)
│       │   └── claude_chat.py                             # [EXISTING] Preserved untouched for direct mode & wrapped by supervisor in orchestrated mode
│       ├── core/                                          # [NEW] Deterministic Media & Timecode Core
│       │   ├── __init__.py
│       │   ├── timecode_math.py                           # [NEW] Exact RationalTime, TimeRange, SMPTE drop/non-drop math & frame snapping
│       │   └── ffmpeg_ops.py                              # [NEW] Streaming FFmpeg wrappers: silence detect, scene cuts, keyframe extraction
│       ├── workers/                                       # [NEW] Heterogeneous Local Sub-Agent Workers
│       │   ├── __init__.py
│       │   ├── base.py                                    # [NEW] LocalWorker Protocol, GPU/Metal file-lock semaphore, circuit breaker
│       │   ├── ingest_pipeline.py                         # [NEW] Async background ingest coordinator ("ingest-index" command entry)
│       │   ├── whisper_worker.py                          # [NEW] Local Whisper runner (faster-whisper / whisper.cpp / mlx-whisper adapter)
│       │   ├── vlm_worker.py                              # [NEW] Local Qwen-VL / Gemma-Vision keyframe analyzer client (Ollama / llama.cpp HTTP)
│       │   ├── vector_store.py                            # [NEW] Local BGE-M3 / Nomic Embed + sqlite-vec / LanceDB hybrid retrieval engine
│       │   └── gemma_validator.py                         # [NEW] Local Gemma fast JSON validator & OTIO-to-NLE parameter translator
│       ├── orchestrator/                                  # [NEW] Claude Supervising Editor & Tool Bus
│       │   ├── __init__.py
│       │   ├── schemas.py                                 # [NEW] JSON Schemas for Orchestrator tools, OTIO Deltas, and Worker outputs
│       │   ├── otio_delta.py                              # [NEW] OTIO Delta compiler, invariant verifier, and NLE command batch lowering
│       │   ├── tool_bus.py                                # [NEW] Deterministic router dispatching Claude tool_use blocks to local workers
│       │   └── supervisor.py                              # [NEW] Orchestrated chat loop managing Planning -> Retrieval -> Validation -> Commit
│       └── nle/
│           ├── bridge_runner.py                           # [NEW] Transactional NLE runner wrapping PremiereAdapter & ResolveAdapter
│           ├── watch.py                                   # [EXISTING] PremiereAdapter & ResolveAdapter watcher loops
│           ├── edits.py                                   # [EXISTING] Direct edit command registries
│           └── interchange/
│               └── otio_builder.py                        # [EXISTING] Reference OTIO JSON document builder
└── tests/
    ├── core/
    │   ├── test_timecode_math.py                          # [NEW] Frame-accurate RationalTime & drop-frame unit tests
    │   └── test_ffmpeg_ops.py                             # [NEW] Streaming FFmpeg wrapper unit tests
    ├── workers/
    │   ├── test_whisper_worker.py                         # [NEW] Word-level timecode JSON contract tests
    │   ├── test_vlm_worker.py                             # [NEW] Keyframe tagging schema & fallback tests
    │   ├── test_vector_store.py                           # [NEW] Dense vector indexing & hybrid RRF search tests
    │   └── test_gemma_validator.py                        # [NEW] Pre-flight validation & NLE parameter translation tests
    └── orchestrator/
        ├── test_otio_delta.py                             # [NEW] OTIO delta compilation & collision detection tests
        ├── test_tool_bus.py                               # [NEW] Tool bus routing & error recovery tests
        └── test_dual_mode.py                              # [NEW] Regression tests verifying EXECUTION_MODE=direct vs orchestrated
```

---

## 3. Inter-Agent Data Contracts & Schemas

All schemas below must be implemented verbatim in `src-python/vibecut_agent/orchestrator/schemas.py` and mirrored in TypeScript at `src/types/orchestrator.ts`.

### 3.1 Fundamental Timecode Primitive (`RationalTime` & `TimeRange`)

Floating-point seconds alone are forbidden at the OTIO mutation boundary due to frame-rounding drift on `23.976` (`24000/1001`) and `29.97` (`30000/1001`) timelines (as documented in `src-python/vibecut_agent/nle/interchange/otio_builder.py`). Every time value across orchestrator and worker boundaries carries an exact `RationalTime` alongside human-readable SMPTE timecode.

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://vibecut.local/schemas/common_time.json",
  "$defs": {
    "RationalTime": {
      "type": "object",
      "required": ["OTIO_SCHEMA", "value", "rate"],
      "additionalProperties": false,
      "properties": {
        "OTIO_SCHEMA": { "type": "string", "const": "RationalTime.1" },
        "value": {
          "type": "number",
          "description": "Exact frame count at the given rate (integer for frame-aligned cuts)."
        },
        "rate": {
          "type": "number",
          "enum": [23.976, 24.0, 25.0, 29.97, 30.0, 50.0, 59.94, 60.0],
          "description": "Timeline or media frame rate in frames per second."
        }
      }
    },
    "TimeRange": {
      "type": "object",
      "required": ["OTIO_SCHEMA", "start_time", "duration"],
      "additionalProperties": false,
      "properties": {
        "OTIO_SCHEMA": { "type": "string", "const": "TimeRange.1" },
        "start_time": { "$ref": "#/$defs/RationalTime" },
        "duration": { "$ref": "#/$defs/RationalTime" }
      }
    }
  }
}
```

---

### 3.2 Claude Orchestrator Tool Call Schemas

When `EXECUTION_MODE=orchestrated`, Claude receives six high-level orchestration tools (instead of 40+ granular NLE mutation tools) in addition to read-only timeline inspection tools (`list_timelines`, `list_timeline_clips`, `list_markers`, `get_playhead_time`, `get_edit_log`).

```json
{
  "orchestrator_tools": [
    {
      "name": "semantic_asset_search",
      "description": "Performs hybrid dense vector + lexical retrieval across indexed transcripts (Whisper word-level) and visual shot tags (VLM + SigLIP 2). Returns ranked candidate clips with exact RationalTime source ranges.",
      "input_schema": {
        "type": "object",
        "required": ["query", "modality"],
        "additionalProperties": false,
        "properties": {
          "query": {
            "type": "string",
            "minLength": 2,
            "description": "Natural language search query describing dialogue content, visual framing, action, or mood."
          },
          "modality": {
            "type": "string",
            "enum": ["dialogue", "visual", "hybrid"],
            "description": "Target index modality: 'dialogue' searches Whisper transcripts, 'visual' searches VLM tags + SigLIP2 frames, 'hybrid' combines both via Reciprocal Rank Fusion."
          },
          "scope_paths": {
            "type": "array",
            "items": { "type": "string" },
            "description": "Optional list of absolute file or folder paths to restrict the search scope."
          },
          "filters": {
            "type": "object",
            "additionalProperties": false,
            "properties": {
              "shot_scales": {
                "type": "array",
                "items": {
                  "type": "string",
                  "enum": ["ECU", "CU", "MCU", "MS", "MWS", "WS", "EWS", "INSERT", "OTS", "TWO_SHOT"]
                }
              },
              "camera_motions": {
                "type": "array",
                "items": {
                  "type": "string",
                  "enum": ["STATIC", "PAN_LEFT", "PAN_RIGHT", "TILT_UP", "TILT_DOWN", "DOLLY_IN", "DOLLY_OUT", "HANDHELD", "GIMBAL_TRACK", "ZOOM"]
                }
              },
              "speaker": { "type": "string" },
              "min_duration_seconds": { "type": "number", "minimum": 0.2 },
              "max_duration_seconds": { "type": "number", "minimum": 0.5 },
              "min_technical_score": { "type": "number", "minimum": 0, "maximum": 100 }
            }
          },
          "top_k": {
            "type": "integer",
            "minimum": 1,
            "maximum": 25,
            "default": 8
          }
        }
      }
    },
    {
      "name": "transcribe_and_align",
      "description": "Dispatches the Local Whisper Worker on a media file (or reads its verified .ivt-cache.json cache) to return word-level timecode segments and speaker diarization.",
      "input_schema": {
        "type": "object",
        "required": ["media_path"],
        "additionalProperties": false,
        "properties": {
          "media_path": {
            "type": "string",
            "description": "Absolute path to the source media file."
          },
          "model_tier": {
            "type": "string",
            "enum": ["tiny", "small", "medium", "large-v3"],
            "default": "medium"
          },
          "enable_diarization": {
            "type": "boolean",
            "default": false
          },
          "source_range_seconds": {
            "type": "object",
            "additionalProperties": false,
            "properties": {
              "start": { "type": "number", "minimum": 0 },
              "end": { "type": "number", "minimum": 0 }
            }
          }
        }
      }
    },
    {
      "name": "analyze_shot_visuals",
      "description": "Dispatches the Local Vision-Language Worker (Qwen-VL / Gemma Vision) on extracted keyframes within a clip range to classify framing, lighting, camera motion, and visual content tags.",
      "input_schema": {
        "type": "object",
        "required": ["media_path"],
        "additionalProperties": false,
        "properties": {
          "media_path": {
            "type": "string",
            "description": "Absolute path to the video file."
          },
          "start_seconds": {
            "type": "number",
            "minimum": 0,
            "default": 0
          },
          "end_seconds": {
            "type": "number",
            "minimum": 0
          },
          "sample_strategy": {
            "type": "string",
            "enum": ["scene_cuts", "uniform_2s", "midpoint_only"],
            "default": "scene_cuts"
          },
          "custom_prompt_focus": {
            "type": "string",
            "description": "Optional specific visual question for the local VLM (e.g., 'Check if subject is looking at camera or off-screen left')."
          }
        }
      }
    },
    {
      "name": "detect_media_boundaries",
      "description": "Runs Deterministic Media Core FFmpeg detectors (silence detection, hard scene-cut detection, and EBU R128 loudness) to find frame-accurate cut points.",
      "input_schema": {
        "type": "object",
        "required": ["media_path", "detectors"],
        "additionalProperties": false,
        "properties": {
          "media_path": { "type": "string" },
          "detectors": {
            "type": "array",
            "minItems": 1,
            "items": {
              "type": "string",
              "enum": ["silence", "scene_cuts", "loudness"]
            }
          },
          "start_seconds": { "type": "number", "minimum": 0, "default": 0 },
          "end_seconds": { "type": "number", "minimum": 0 },
          "silence_noise_db": { "type": "number", "default": -35.0, "maximum": -10.0 },
          "silence_min_duration": { "type": "number", "default": 0.35, "minimum": 0.1 },
          "scene_cut_sensitivity": { "type": "string", "enum": ["low", "normal", "high"], "default": "normal" }
        }
      }
    },
    {
      "name": "propose_otio_delta",
      "description": "Submits a declarative OpenTimelineIO (OTIO) Delta Mutation payload to the Local Gemma Validator and Deterministic OTIO Engine for pre-flight verification without mutating the live NLE timeline.",
      "input_schema": {
        "type": "object",
        "required": ["delta"],
        "additionalProperties": false,
        "properties": {
          "delta": { "$ref": "https://vibecut.local/schemas/otio_delta.json" }
        }
      }
    },
    {
      "name": "commit_otio_delta",
      "description": "Executes a previously validated OTIO Delta payload against the connected NLE (DaVinci Resolve or Premiere Pro) inside an atomic backup/revert transaction.",
      "input_schema": {
        "type": "object",
        "required": ["validation_token", "commit_summary"],
        "additionalProperties": false,
        "properties": {
          "validation_token": {
            "type": "string",
            "pattern": "^vtok_[a-f0-9]{32}$",
            "description": "Cryptographic digest token returned by a passing `propose_otio_delta` call."
          },
          "commit_summary": {
            "type": "string",
            "minLength": 5,
            "description": "Human-readable editorial summary recorded in the VibeCut Agent Edit Log."
          },
          "execution_strategy": {
            "type": "string",
            "enum": ["incremental_bridge", "otio_timeline_rebuild"],
            "default": "incremental_bridge",
            "description": "'incremental_bridge' dispatches translated NLE API commands; 'otio_timeline_rebuild' imports a compiled OTIO/XML sequence."
          }
        }
      }
    }
  ]
}
```

---

### 3.3 Standardized OTIO Delta Mutation Payload Schema (`otio_delta.json`)

```json
{
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
    "operations"
  ],
  "additionalProperties": false,
  "properties": {
    "schema_version": { "type": "string", "const": "vibecut.otio.delta.v1" },
    "delta_id": { "type": "string", "minLength": 8 },
    "target_host": { "type": "string", "enum": ["premiere", "resolve"] },
    "target_timeline": { "type": "string", "minLength": 1 },
    "expected_timeline_hash": {
      "type": ["string", "null"],
      "description": "SHA-256 hash of the canonicalized HostTimeline snapshot at plan time; prevents stale-state race conditions."
    },
    "timeline_fps": {
      "type": "number",
      "enum": [23.976, 24.0, 25.0, 29.97, 30.0, 50.0, 59.94, 60.0]
    },
    "narrative_rationale": {
      "type": "string",
      "description": "Supervisor's explanation of pacing, story arc, or visual continuity served by this delta."
    },
    "operations": {
      "type": "array",
      "minItems": 1,
      "maxItems": 200,
      "items": { "$ref": "#/$defs/DeltaOperation" }
    }
  },
  "$defs": {
    "DeltaOperation": {
      "type": "object",
      "required": ["op_id", "op_type", "track_Selector"],
      "additionalProperties": false,
      "properties": {
        "op_id": { "type": "string", "pattern": "^op_[0-9]{3,4}$" },
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
            "DUCK_REGION"
          ]
        },
        "track_Selector": {
          "type": "object",
          "required": ["kind", "index"],
          "additionalProperties": false,
          "properties": {
            "kind": { "type": "string", "enum": ["Video", "Audio"] },
            "index": { "type": "integer", "minimum": 1, "description": "1-based track index (e.g. V1 -> 1, V2 -> 2, A1 -> 1)." }
          }
        },
        "clip_id": {
          "type": ["string", "null"],
          "description": "Target clip ID on the timeline (required for TRIM_CLIP, SPLIT_CLIP, DELETE_CLIP, MOVE_CLIP, SET_AUDIO_GAIN)."
        },
        "media_reference": {
          "type": ["object", "null"],
          "required": ["OTIO_SCHEMA", "target_url", "source_name"],
          "additionalProperties": false,
          "properties": {
            "OTIO_SCHEMA": { "type": "string", "const": "ExternalReference.1" },
            "target_url": { "type": "string", "pattern": "^file:///" },
            "source_name": { "type": "string" },
            "available_range": { "$ref": "https://vibecut.local/schemas/common_time.json#/$defs/TimeRange" }
          }
        },
        "source_range": {
          "$ref": "https://vibecut.local/schemas/common_time.json#/$defs/TimeRange",
          "description": "In/duration range inside the source media file."
        },
        "timeline_range": {
          "$ref": "https://vibecut.local/schemas/common_time.json#/$defs/TimeRange",
          "description": "Target placement or affected window on the sequence timeline."
        },
        "ripple": {
          "type": "boolean",
          "default": false,
          "description": "Whether subsequent clips on the track ripple-shift when inserting, trimming, or deleting."
        },
        "transition": {
          "type": ["object", "null"],
          "required": ["OTIO_SCHEMA", "transition_type", "in_offset", "out_offset"],
          "additionalProperties": false,
          "properties": {
            "OTIO_SCHEMA": { "type": "string", "const": "Transition.1" },
            "transition_type": { "type": "string", "enum": ["SMPTE_Dissolve", "Dip_To_Black", "Audio_Crossfade"] },
            "in_offset": { "$ref": "https://vibecut.local/schemas/common_time.json#/$defs/RationalTime" },
            "out_offset": { "$ref": "https://vibecut.local/schemas/common_time.json#/$defs/RationalTime" }
          }
        },
        "audio_params": {
          "type": ["object", "null"],
          "additionalProperties": false,
          "properties": {
            "gain_db": { "type": "number", "minimum": -100.0, "maximum": 24.0 },
            "duck_Floor_db": { "type": "number", "minimum": -60.0, "maximum": 0.0 },
            "fade_in_seconds": { "type": "number", "minimum": 0.0 },
            "fade_out_seconds": { "type": "number", "minimum": 0.0 }
          }
        },
        "link_group_id": {
          "type": ["string", "null"],
          "description": "Links A-roll picture and synced audio across V/A tracks (mapped to Resolve_OTIO Link Group ID or Premiere link_clips)."
        },
        "metadata": {
          "type": "object",
          "additionalProperties": true
        }
      }
    }
  }
}
```

---

### 3.4 Local Worker Response Schemas

#### A. Speech-to-Text Worker Response (`WhisperTranscriptResult`)

```json
{
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
    "segments"
  ],
  "additionalProperties": false,
  "properties": {
    "schema_version": { "type": "string", "const": "vibecut.whisper.v2" },
    "path": { "type": "string" },
    "name": { "type": "string" },
    "video_size": { "type": "integer" },
    "video_mtime": { "type": "integer" },
    "media_fps": { "type": "number" },
    "backend": { "type": "string", "enum": ["mlx-whisper", "faster-whisper", "whisper.cpp"] },
    "model_id": { "type": "string" },
    "speakers": { "type": "array", "items": { "type": "string" } },
    "speaker_labels": { "type": "object", "additionalProperties": { "type": "string" } },
    "excluded_speakers": { "type": "array", "items": { "type": "string" } },
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
          "words"
        ],
        "additionalProperties": false,
        "properties": {
          "segment_id": { "type": "string" },
          "start": { "type": "number" },
          "end": { "type": "number" },
          "start_tc": { "type": "string", "pattern": "^[0-9]{2}:[0-9]{2}:[0-9]{2}[:;][0-9]{2}$" },
          "end_tc": { "type": "string", "pattern": "^[0-9]{2}:[0-9]{2}:[0-9]{2}[:;][0-9]{2}$" },
          "source_range": { "$ref": "https://vibecut.local/schemas/common_time.json#/$defs/TimeRange" },
          "text": { "type": "string" },
          "speaker": { "type": "string" },
          "avg_logprob": { "type": "number" },
          "no_speech_prob": { "type": "number" },
          "low_confidence": { "type": "boolean" },
          "words": {
            "type": "array",
            "items": {
              "type": "object",
              "required": ["text", "start", "end", "start_frame", "end_frame", "probability"],
              "additionalProperties": false,
              "properties": {
                "text": { "type": "string" },
                "start": { "type": "number" },
                "end": { "type": "number" },
                "start_frame": { "type": "integer", "minimum": 0 },
                "end_frame": { "type": "integer", "minimum": 1 },
                "probability": { "type": "number", "minimum": 0.0, "maximum": 1.0 }
              }
            }
          }
        }
      }
    }
  }
}
```

#### B. Vision & Framing Analysis Worker Response (`VlmKeyframeAnalysisResult`)

```json
{
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
    "shots"
  ],
  "additionalProperties": false,
  "properties": {
    "schema_version": { "type": "string", "const": "vibecut.vlm.v1" },
    "media_path": { "type": "string" },
    "video_size": { "type": "integer" },
    "video_mtime": { "type": "integer" },
    "media_fps": { "type": "number" },
    "vlm_model_id": {
      "type": "string",
      "description": "Local VLM identifier, e.g. 'qwen2.5-vl:7b-instruct' or 'gemma3:12b-it-qat'."
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
          "editorial_usability_score"
        ],
        "additionalProperties": false,
        "properties": {
          "shot_id": { "type": "string" },
          "source_range": { "$ref": "https://vibecut.local/schemas/common_time.json#/$defs/TimeRange" },
          "keyframe_timestamp_sec": { "type": "number", "minimum": 0.0 },
          "shot_scale": {
            "type": "string",
            "enum": ["ECU", "CU", "MCU", "MS", "MWS", "WS", "EWS", "INSERT", "OTS", "TWO_SHOT"]
          },
          "camera_movement": {
            "type": "string",
            "enum": ["STATIC", "PAN_LEFT", "PAN_RIGHT", "TILT_UP", "TILT_DOWN", "DOLLY_IN", "DOLLY_OUT", "HANDHELD", "GIMBAL_TRACK", "ZOOM"]
          },
          "lighting": {
            "type": "object",
            "required": ["key_style", "color_temperature", "contrast"],
            "additionalProperties": false,
            "properties": {
              "key_style": { "type": "string", "enum": ["NATURAL_DAYLIGHT", "GOLDEN_HOUR", "STUDIO_HIGH_KEY", "LOW_KEY_MOODY", "NEON_PRACTICAL", "OVERCAST_SOFT", "FLUORESCENT_FLAT"] },
              "color_temperature": { "type": "string", "enum": ["WARM", "NEUTRAL", "COOL", "MIXED"] },
              "contrast": { "type": "string", "enum": ["LOW", "MEDIUM", "HIGH"] }
            }
          },
          "composition": {
            "type": "object",
            "required": ["subject_count", "eyeline_direction", "focus_quality", "obstructions"],
            "additionalProperties": false,
            "properties": {
              "subject_count": { "type": "integer", "minimum": 0 },
              "eyeline_direction": { "type": "string", "enum": ["DIRECT_TO_LENS", "LOOKING_LEFT", "LOOKING_RIGHT", "LOOKING_DOWN", "LOOKING_UP", "NONE"] },
              "focus_quality": { "type": "string", "enum": ["TACK_SHARP", "SOFT_FOCUS", "RACK_FOCUS", "MOTION_BLUR", "OUT_OF_FOCUS"] },
              "obstructions": { "type": "boolean" }
            }
          },
          "description": { "type": "string", "minLength": 5 },
          "visual_tags": { "type": "array", "items": { "type": "string" }, "minItems": 1 },
          "on_screen_text": { "type": ["string", "null"] },
          "editorial_usability_score": { "type": "number", "minimum": 0.0, "maximum": 100.0 }
        }
      }
    }
  }
}
```

#### C. Semantic Asset Search Response (`VectorSearchResult`)

```json
{
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
    "hits"
  ],
  "additionalProperties": false,
  "properties": {
    "schema_version": { "type": "string", "const": "vibecut.vector.v1" },
    "query": { "type": "string" },
    "modality": { "type": "string", "enum": ["dialogue", "visual", "hybrid"] },
    "embedding_model": { "type": "string", "enum": ["BAAI/bge-m3", "nomic-ai/nomic-embed-text-v1.5"] },
    "vector_backend": { "type": "string", "enum": ["sqlite-vec", "lancedb"] },
    "latency_ms": { "type": "number", "minimum": 0.0 },
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
          "evidence"
        ],
        "additionalProperties": false,
        "properties": {
          "hit_id": { "type": "string" },
          "rank": { "type": "integer", "minimum": 1 },
          "media_path": { "type": "string" },
          "filename": { "type": "string" },
          "source_range": { "$ref": "https://vibecut.local/schemas/common_time.json#/$defs/TimeRange" },
          "start_tc": { "type": "string" },
          "end_tc": { "type": "string" },
          "scores": {
            "type": "object",
            "required": ["rrf_combined", "dense_cosine", "siglip_visual", "technical_quality"],
            "additionalProperties": false,
            "properties": {
              "rrf_combined": { "type": "number", "minimum": 0.0, "maximum": 100.0 },
              "dense_cosine": { "type": "number", "minimum": -1.0, "maximum": 1.0 },
              "siglip_visual": { "type": ["number", "null"] },
              "technical_quality": { "type": ["number", "null"] }
            }
          },
          "evidence": {
            "type": "object",
            "required": ["matched_modality"],
            "additionalProperties": false,
            "properties": {
              "matched_modality": { "type": "string", "enum": ["transcript", "vlm_shot", "both"] },
              "transcript_excerpt": { "type": ["string", "null"] },
              "speaker": { "type": ["string", "null"] },
              "shot_scale": { "type": ["string", "null"] },
              "camera_movement": { "type": ["string", "null"] },
              "vlm_description": { "type": ["string", "null"] },
              "visual_tags": { "type": "array", "items": { "type": "string" } }
            }
          }
        }
      }
    }
  }
}
```

#### D. Local Gemma Pre-Flight Validation & Parameter Translation Response (`GemmaValidationResult`)

```json
{
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
    "translated_nle_batch"
  ],
  "additionalProperties": false,
  "properties": {
    "schema_version": { "type": "string", "const": "vibecut.gemma.validator.v1" },
    "delta_id": { "type": "string" },
    "valid": { "type": "boolean" },
    "validation_token": {
      "type": ["string", "null"],
      "pattern": "^vtok_[a-f0-9]{32}$",
      "description": "Issued only when valid=true; required by `commit_otio_delta`."
    },
    "validator_model": { "type": "string", "description": "e.g. 'gemma3:4b-it' or 'gemma2:9b-instruct'." },
    "diagnostics": {
      "type": "array",
      "items": {
        "type": "object",
        "required": ["severity", "code", "op_id", "message", "remediation_hint"],
        "additionalProperties": false,
        "properties": {
          "severity": { "type": "string", "enum": ["ERROR", "WARNING"] },
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
              "INVALID_TRANSITION_HANDLE"
            ]
          },
          "op_id": { "type": ["string", "null"] },
          "message": { "type": "string" },
          "remediation_hint": { "type": "string" }
        }
      }
    },
    "translated_nle_batch": {
      "type": "array",
      "description": "Concrete, ordered NLE bridge calls ready for PremiereAdapter.call() or ResolveAdapter.call().",
      "items": {
        "type": "object",
        "required": ["seq", "source_op_id", "host", "command", "args"],
        "additionalProperties": false,
        "properties": {
          "seq": { "type": "integer", "minimum": 1 },
          "source_op_id": { "type": "string" },
          "host": { "type": "string", "enum": ["premiere", "resolve"] },
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
              "rebuild"
            ]
          },
          "args": { "type": "object", "additionalProperties": true }
        }
      }
    }
  }
}
```

---

## 4. Dual-Mode Configuration Strategy

The existing `direct` execution path must remain 100% intact. Switching between `direct` and `orchestrated` is controlled via environment configuration and clean factory dispatchers across Python, Rust, and TypeScript.

### 4.1 Environment Variables (`.env` & Runtime Environment)

```dotenv
# Execution Mode: "direct" (legacy single-agent NLE calls) | "orchestrated" (Supervisor + Local Workers)
EXECUTION_MODE=direct
VIBECUT_EXECUTION_MODE=direct

# Local LLM / VLM Runtime (Ollama or llama.cpp OpenAI-compatible server)
VIBECUT_LOCAL_LLM_BASE_URL=http://127.0.0.1:11434
VIBECUT_GEMMA_MODEL=gemma3:4b-it
VIBECUT_VLM_MODEL=qwen2.5-vl:7b-instruct

# Local Speech-to-Text Worker ("mlx-whisper" | "faster-whisper" | "whisper.cpp")
VIBECUT_WHISPER_BACKEND=mlx-whisper
VIBECUT_WHISPER_MODEL=mlx-community/whisper-medium-mlx
VIBECUT_WHISPER_CPP_BIN=/opt/homebrew/bin/whisper-cli

# Local Dense Vector Store ("sqlite-vec" | "lancedb") & Embedding Model
VIBECUT_VECTOR_BACKEND=sqlite-vec
VIBECUT_EMBED_MODEL=BAAI/bge-m3
# How long Ollama keeps the embedding model loaded after a call ("30m", seconds, -1 for ever; empty: Ollama's default)
VIBECUT_EMBED_KEEP_ALIVE=30m

# Set by the app (src-tauri/src/sidecar.rs, mcp_bridge.rs): its data folder; each edit's .otio goes to <it>/otio_deltas
# VIBECUT_APP_DATA_DIR=~/Library/Application Support/com.cj.vibecutagent
```

### 4.2 Rust Sidecar Environment Passthrough (`src-tauri/src/sidecar.rs`)

Because `src-tauri/src/sidecar.rs` scrubs environment variables and only passes `VIBECUT_*`, `UV_*`, `HF_*`, and `XDG_*` prefixes:
1. In `src-tauri/src/sidecar.rs`, map `EXECUTION_MODE` (if set in the host environment or `.env`) into `VIBECUT_EXECUTION_MODE` when spawning `uv run`.
2. Add `"ingest-index"` and `"orchestrator-tool"` to `COMMANDS` in both `src-tauri/src/sidecar.rs` and `src-python/vibecut_agent/headless.py`.

### 4.3 Python Configuration & Factory Pattern (`src-python/vibecut_agent/config.py`)

```python
"""Runtime configuration and Dual-Mode Execution Factory for VibeCut Agent."""

from __future__ import annotations

import os
from collections.abc import Callable
from dataclasses import dataclass
from enum import StrEnum
from typing import Any


class ExecutionMode(StrEnum):
    DIRECT = "direct"
    ORCHESTRATED = "orchestrated"


@dataclass(frozen=True)
class OrchestratorConfig:
    execution_mode: ExecutionMode
    local_llm_base_url: str
    gemma_model: str
    vlm_model: str
    whisper_backend: str
    whisper_model: str
    whisper_cpp_bin: str
    vector_backend: str
    embed_model: str
    index_dir: str

    @classmethod
    def from_env(cls, request_override: str | None = None) -> OrchestratorConfig:
        raw_mode = (
            request_override
            or os.environ.get("VIBECUT_EXECUTION_MODE")
            or os.environ.get("EXECUTION_MODE")
            or "direct"
        ).strip().lower()
        mode = (
            ExecutionMode.ORCHESTRATED
            if raw_mode == ExecutionMode.ORCHESTRATED.value
            else ExecutionMode.DIRECT
        )
        default_index = os.path.expanduser("~/Library/Application Support/VibeCut Agent/vector-index")
        return cls(
            execution_mode=mode,
            local_llm_base_url=os.environ.get("VIBECUT_LOCAL_LLM_BASE_URL", "http://127.0.0.1:11434"),
            gemma_model=os.environ.get("VIBECUT_GEMMA_MODEL", "gemma3:4b-it"),
            vlm_model=os.environ.get("VIBECUT_VLM_MODEL", "qwen2.5-vl:7b-instruct"),
            whisper_backend=os.environ.get("VIBECUT_WHISPER_BACKEND", "mlx-whisper"),
            whisper_model=os.environ.get("VIBECUT_WHISPER_MODEL", "mlx-community/whisper-medium-mlx"),
            whisper_cpp_bin=os.environ.get("VIBECUT_WHISPER_CPP_BIN", "/opt/homebrew/bin/whisper-cli"),
            vector_backend=os.environ.get("VIBECUT_VECTOR_BACKEND", "sqlite-vec"),
            embed_model=os.environ.get("VIBECUT_EMBED_MODEL", "BAAI/bge-m3"),
            index_dir=os.environ.get("VIBECUT_INDEX_DIR", default_index),
        )


def resolve_chat_turn_runner(
    provider: str,
    config: OrchestratorConfig,
) -> Callable[..., dict[str, Any]]:
    """Factory returning the turn runner for `agent/chat.py`.

    - ExecutionMode.DIRECT: returns the existing `claude_chat.run_chat_turn` or `gemini_chat.run_chat_turn` untouched.
    - ExecutionMode.ORCHESTRATED: returns `orchestrator.supervisor.run_orchestrated_turn`, which intercepts
      orchestrator tool calls in-process via `ToolBus` and delegates NLE commits back through the host channel.
    """
    if config.execution_mode == ExecutionMode.ORCHESTRATED and provider == "claude":
        from vibecut_agent.orchestrator.supervisor import make_orchestrated_turn_runner

        return make_orchestrated_turn_runner(config)

    if provider == "claude":
        from vibecut_agent.agent import claude_chat

        return claude_chat.run_chat_turn

    from vibecut_agent.agent import gemini_chat

    return gemini_chat.run_chat_turn
```

---

## 5. Phased Implementation Checklist for Claude Code CLI

Execute the following 5 atomic phases sequentially. Do not advance to the next phase until all verification commands for the current phase exit `0`.

### Phase 1: Branching, Configuration Toggle, and Interface Scaffolding
1. Run `git checkout -b feat/orchestrator-subagent-pipeline`.
2. Add optional dependency group `orchestrator` (`opentimelineio>=0.17.0`, `jsonschema>=4.23.0`, `sqlite-vec>=0.1.6`, `faster-whisper>=1.1.0`) and mypy overrides in `pyproject.toml`.
3. Create `src-python/vibecut_agent/config.py`, `src-python/vibecut_agent/workers/base.py`, and `__init__.py` files for `core/`, `workers/`, and `orchestrator/`.
4. Forward `EXECUTION_MODE` -> `VIBECUT_EXECUTION_MODE` in `src-tauri/src/sidecar.rs` and include `executionMode` in `src-python/vibecut_agent/health.py`.
5. Run verification: `uvx ruff check src-python/ tests/ && uv run mypy src-python && uv run pytest tests/ -v && npm run lint && npx tsc --noEmit && npm run test:run`.

### Phase 2: Deterministic Core (FFmpeg & OTIO Timecode Math)
1. Implement `src-python/vibecut_agent/core/timecode_math.py` (`seconds_to_rational`, `rational_to_seconds`, `rational_to_smpte`, `smpte_to_rational`, `ranges_overlap`).
2. Implement `src-python/vibecut_agent/core/ffmpeg_ops.py` (`detect_silences`, `detect_scene_cuts`, `extract_keyframes_for_vlm`).
3. Add unit tests in `tests/core/test_timecode_math.py` and `tests/core/test_ffmpeg_ops.py`.
4. Run verification: `uv run pytest tests/core/ -v && uvx ruff check src-python/vibecut_agent/core/ tests/core/ && uv run mypy src-python/vibecut_agent/core/`.

### Phase 3: Local Workers (Whisper Runner, VLM Keyframe Tagger, Vector Store, Gemma Validator)
1. Implement `src-python/vibecut_agent/orchestrator/schemas.py` with all Draft 2020-12 JSON schemas from Section 3.
2. Implement `src-python/vibecut_agent/workers/whisper_worker.py` (`mlx-whisper`, `faster-whisper`, `whisper.cpp` backends).
3. Implement `src-python/vibecut_agent/workers/vlm_worker.py` (Ollama / llama.cpp keyframe tagging).
4. Implement `src-python/vibecut_agent/workers/vector_store.py` (`sqlite-vec` / `LanceDB` + Reciprocal Rank Fusion).
5. Implement `src-python/vibecut_agent/workers/gemma_validator.py` (structural checks + Gemma JSON translation + `validation_token` signing).
6. Implement `src-python/vibecut_agent/workers/ingest_pipeline.py` and wire `"ingest-index"` in `headless.py` and `sidecar.rs`.
7. Add unit tests in `tests/workers/` and run `uv run pytest tests/workers/ -v && uv run mypy src-python`.

### Phase 4: Claude Orchestrator Tool Definitions & State Machine
1. Implement `src-python/vibecut_agent/orchestrator/otio_delta.py` (`apply_delta_to_otio`, `compile_to_nle_commands`).
2. Implement `src-python/vibecut_agent/orchestrator/tool_bus.py` (`OrchestratorToolBus`).
3. Implement `src-python/vibecut_agent/orchestrator/supervisor.py` (`make_orchestrated_turn_runner`) and wire `resolve_chat_turn_runner` into `src-python/vibecut_agent/agent/chat.py`.
4. Add unit tests in `tests/orchestrator/test_otio_delta.py` and `tests/orchestrator/test_tool_bus.py`.
5. Run verification: `uv run pytest tests/orchestrator/ -v && uv run mypy src-python`.

### Phase 5: NLE Bridge Dispatch & End-to-End Integration Testing
1. Implement `src-python/vibecut_agent/nle/bridge_runner.py` (`execute_validated_batch` with automatic `backup_timeline` and rollback on `HostError`/`Unreachable`) and register `"execute_otio_batch"` in `src-python/vibecut_agent/nle/edits.py`.
2. Implement `src/types/orchestrator.ts` and `src/lib/agent/orchestratorTools.ts`, update `src/lib/agent/tools.ts`, `src/lib/agent/toolKinds.ts`, and `src/components/about/AboutModal.tsx`.
3. Add dual-mode integration tests in `tests/orchestrator/test_dual_mode.py`.
4. Run full verification suite:
   ```bash
   uvx ruff check src-python/ tests/
   uvx ruff format --check src-python/ tests/
   uv run mypy src-python
   uv run pytest tests/ -v --cov=src-python/vibecut_agent
   npm run lint && npx tsc --noEmit
   npm run test:run
   ```

