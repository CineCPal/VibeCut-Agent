/**
 * The orchestrator's data contracts (ORCHESTRATOR_SPEC.md §3; PLAN.md, "Phase 21"), mirroring the JSON
 * Schemas in src-python/vibecut_agent/orchestrator/schemas.py. The Python side validates; these types are
 * what the app reads when an orchestrated chat's results and commits reach it.
 */
import type { NleHost } from "./nle";

export type SupportedRate = 23.976 | 24 | 25 | 29.97 | 30 | 50 | 59.94 | 60;

export interface RationalTime {
  OTIO_SCHEMA: "RationalTime.1";
  value: number;
  rate: SupportedRate;
}

export interface TimeRange {
  OTIO_SCHEMA: "TimeRange.1";
  start_time: RationalTime;
  duration: RationalTime;
}

// ------------------------------------------------------------------------------ vibecut.otio.delta.v1

export type DeltaOpType =
  | "INSERT_CLIP"
  | "OVERWRITE_CLIP"
  | "TRIM_CLIP"
  | "SPLIT_CLIP"
  | "DELETE_CLIP"
  | "MOVE_CLIP"
  | "INSERT_GAP"
  | "APPLY_TRANSITION"
  | "SET_AUDIO_GAIN"
  | "DUCK_REGION";

export interface ExternalReference {
  OTIO_SCHEMA: "ExternalReference.1";
  /** A file:/// URL. */
  target_url: string;
  source_name: string;
  available_range?: TimeRange;
}

export interface DeltaTransition {
  OTIO_SCHEMA: "Transition.1";
  transition_type: "SMPTE_Dissolve" | "Dip_To_Black" | "Audio_Crossfade";
  in_offset: RationalTime;
  out_offset: RationalTime;
}

export interface AudioParams {
  gain_db?: number;
  duck_Floor_db?: number;
  fade_in_seconds?: number;
  fade_out_seconds?: number;
}

export interface DeltaOperation {
  /** op_ and three or four digits. */
  op_id: string;
  op_type: DeltaOpType;
  track_Selector: { kind: "Video" | "Audio"; index: number };
  clip_id?: string | null;
  media_reference?: ExternalReference | null;
  source_range?: TimeRange;
  timeline_range?: TimeRange;
  ripple?: boolean;
  transition?: DeltaTransition | null;
  audio_params?: AudioParams | null;
  link_group_id?: string | null;
  metadata?: Record<string, unknown>;
}

export interface OtioDelta {
  schema_version: "vibecut.otio.delta.v1";
  delta_id: string;
  target_host: NleHost;
  target_timeline: string;
  expected_timeline_hash?: string | null;
  timeline_fps: SupportedRate;
  narrative_rationale: string;
  operations: DeltaOperation[];
}

// ------------------------------------------------------------------------------ vibecut.whisper.v2

export interface TranscriptWord {
  text: string;
  start: number;
  end: number;
  start_frame: number;
  end_frame: number;
  probability: number;
}

export interface TranscriptSegment {
  segment_id: string;
  start: number;
  end: number;
  start_tc: string;
  end_tc: string;
  source_range: TimeRange;
  text: string;
  speaker: string;
  avg_logprob: number;
  no_speech_prob: number;
  low_confidence: boolean;
  words: TranscriptWord[];
}

export interface WhisperTranscriptResult {
  schema_version: "vibecut.whisper.v2";
  path: string;
  name: string;
  video_size: number;
  video_mtime: number;
  media_fps: number;
  backend: "mlx-whisper" | "faster-whisper" | "whisper.cpp";
  model_id: string;
  speakers: string[];
  speaker_labels?: Record<string, string>;
  excluded_speakers?: string[];
  segments: TranscriptSegment[];
}

// ------------------------------------------------------------------------------ vibecut.vlm.v1

export type ShotScale = "ECU" | "CU" | "MCU" | "MS" | "MWS" | "WS" | "EWS" | "INSERT" | "OTS" | "TWO_SHOT";
export type CameraMotion =
  | "STATIC"
  | "PAN_LEFT"
  | "PAN_RIGHT"
  | "TILT_UP"
  | "TILT_DOWN"
  | "DOLLY_IN"
  | "DOLLY_OUT"
  | "HANDHELD"
  | "GIMBAL_TRACK"
  | "ZOOM";

export interface VlmShot {
  shot_id: string;
  source_range: TimeRange;
  keyframe_timestamp_sec: number;
  shot_scale: ShotScale;
  camera_movement: CameraMotion;
  lighting: {
    key_style: "NATURAL_DAYLIGHT" | "GOLDEN_HOUR" | "STUDIO_HIGH_KEY" | "LOW_KEY_MOODY" | "NEON_PRACTICAL" | "OVERCAST_SOFT" | "FLUORESCENT_FLAT";
    color_temperature: "WARM" | "NEUTRAL" | "COOL" | "MIXED";
    contrast: "LOW" | "MEDIUM" | "HIGH";
  };
  composition: {
    subject_count: number;
    eyeline_direction: "DIRECT_TO_LENS" | "LOOKING_LEFT" | "LOOKING_RIGHT" | "LOOKING_DOWN" | "LOOKING_UP" | "NONE";
    focus_quality: "TACK_SHARP" | "SOFT_FOCUS" | "RACK_FOCUS" | "MOTION_BLUR" | "OUT_OF_FOCUS";
    obstructions: boolean;
  };
  description: string;
  visual_tags: string[];
  on_screen_text?: string | null;
  editorial_usability_score: number;
}

export interface VlmKeyframeAnalysisResult {
  schema_version: "vibecut.vlm.v1";
  media_path: string;
  video_size: number;
  video_mtime: number;
  media_fps: number;
  vlm_model_id: string;
  shots: VlmShot[];
}

// ------------------------------------------------------------------------------ vibecut.vector.v1

export interface VectorSearchHit {
  hit_id: string;
  rank: number;
  media_path: string;
  filename: string;
  source_range: TimeRange;
  start_tc: string;
  end_tc: string;
  scores: { rrf_combined: number; dense_cosine: number; siglip_visual: number | null; technical_quality: number | null };
  evidence: {
    matched_modality: "transcript" | "vlm_shot" | "both";
    transcript_excerpt?: string | null;
    speaker?: string | null;
    shot_scale?: string | null;
    camera_movement?: string | null;
    vlm_description?: string | null;
    visual_tags?: string[];
  };
}

export interface VectorSearchResult {
  schema_version: "vibecut.vector.v1";
  query: string;
  modality: "dialogue" | "visual" | "hybrid";
  embedding_model: "BAAI/bge-m3" | "nomic-ai/nomic-embed-text-v1.5";
  vector_backend: "sqlite-vec" | "lancedb";
  latency_ms: number;
  hits: VectorSearchHit[];
}

// ------------------------------------------------------------------------------ vibecut.gemma.validator.v1

export type DiagnosticCode =
  | "SOURCE_OUT_OF_BOUNDS"
  | "NEGATIVE_OR_ZERO_DURATION"
  | "TRACK_OVERLAP_COLLISION"
  | "MISSING_MEDIA_FILE"
  | "UNKNOWN_CLIP_ID"
  | "RATE_MISMATCH"
  | "STALE_TIMELINE_HASH"
  | "INVALID_TRANSITION_HANDLE";

export interface ValidationDiagnostic {
  severity: "ERROR" | "WARNING";
  code: DiagnosticCode;
  op_id: string | null;
  message: string;
  remediation_hint: string;
}

export type BatchCommandName =
  | "backup_timeline"
  | "add_clips"
  | "delete_clips"
  | "reshape_clip"
  | "split_clips"
  | "set_clip_levels"
  | "set_clip_fades"
  | "set_transition"
  | "duck_clip"
  | "set_links"
  | "add_track"
  | "rebuild";

export interface NleBatchCommand {
  seq: number;
  source_op_id: string;
  host: NleHost;
  command: BatchCommandName;
  args: Record<string, unknown>;
}

export interface GemmaValidationResult {
  schema_version: "vibecut.gemma.validator.v1";
  delta_id: string;
  valid: boolean;
  /** vtok_ and 32 hex digits, on a valid delta. */
  validation_token: string | null;
  validator_model: string;
  diagnostics: ValidationDiagnostic[];
  translated_nle_batch: NleBatchCommand[];
}

// ------------------------------------------------------------------------------ the app's side

/** What the orchestrator's tool bus sends the app's `commit_otio_delta` executor (orchestrator/tool_bus.py). */
export interface OtioCommitArgs {
  validationToken: string;
  deltaId: string;
  commitSummary: string;
  host: NleHost;
  timeline: string;
  batch: NleBatchCommand[];
  /** The timeline as the delta leaves it, saved as OTIO, when the sidecar could write it. */
  otioPath?: string;
}

/** One call of a batch, as `execute_otio_batch` reports it (nle/bridge_runner.py). */
export interface ExecutedCall {
  seq: number;
  sourceOpId: string | null;
  command: BatchCommandName;
  changes: number;
}

/** A local worker's health (workers/base.py `WorkerHealth`). */
export interface WorkerHealth {
  worker: string;
  backend: string;
  model: string;
  available: boolean;
  detail: string;
}

export type ExecutionMode = "direct" | "orchestrated";

/** The `orchestrator-health` command's result (workers/health_report.py). */
export interface OrchestratorHealth {
  executionMode: ExecutionMode;
  workers: WorkerHealth[];
  localLlmBaseUrl: string;
  indexDir: string;
}
