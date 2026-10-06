import type { TakeHarmony } from "./harmony";
export type MediaType = "video" | "audio";

export const SYNC_METHODS = ["waveform", "manual", "a-sync"] as const;
export type SyncMethod = (typeof SYNC_METHODS)[number];

/**
 * A separately recorded sound file lined up with a camera clip (see PLAN.md, "Synced audio").
 * `offset` is the seconds the recording is delayed: camera time = recording time + offset. A camera
 * clip that starts 20 minutes into a long recorder roll has an offset of -1200.
 */
export const SPEAKER_ROLES = ["interviewer", "subject", "other"] as const;
export type SpeakerRole = (typeof SPEAKER_ROLES)[number];

/**
 * What VibeCut knows about one speaker of a transcript (see PLAN.md, "Speaker roles"). Kept on the
 * asset whose transcript it is, keyed by the transcript's speaker id ("Speaker 1").
 */
export interface SpeakerInfo {
  /** A display name; overrides the transcriber's label. */
  name?: string;
  role?: SpeakerRole;
  /** True when the agent guessed the role; the user setting it clears this. */
  inferred?: boolean;
}

export interface SyncedAudio {
  /** The recording's own asset (an ordinary audio asset in the bin). */
  assetId: string;
  offset: number;
  method: SyncMethod;
  /** How clearly the waveform match stood out, 0 to 1 (waveform syncs only). */
  confidence?: number;
  /** How far the late estimate drifted from the early one, in seconds (a warning; not corrected). */
  driftSeconds?: number;
  /** A-Sync's channel routing: missing is every channel, [0] a downmix, else 1-based channels. */
  channels?: number[];
}

export interface MediaAsset {
  id: string;
  fileName: string;
  filePath: string;
  type: MediaType;
  durationSeconds: number;
  frameRate?: number;
  width?: number;
  height?: number;
  thumbnailUrl?: string;
  /** Whether the file has an audio track. Unknown (undefined) for projects saved before this was recorded. */
  hasAudio?: boolean;
  /** ffprobe codec names (e.g. "h264", "aac"). Unknown for media imported before these were recorded. */
  videoCodec?: string;
  audioCodec?: string;
  /** Channel count and sample rate of the first audio stream. Unknown for media imported before these were recorded. */
  audioChannels?: number;
  audioSampleRate?: number;
  /**
   * On a camera clip: the recordings synced to it, the first being the main one (its transcript and
   * levels stand in for the camera's). Placing the clip puts these on audio tracks, linked to the
   * picture, with the camera's own sound kept muted beneath them.
   */
  syncedAudio?: SyncedAudio[];
  /** Names and roles of the speakers in this asset's own transcript, by speaker id. */
  speakers?: Record<string, SpeakerInfo>;
  /** On a performance take: how Harmonizer lined it up with a reference recording. */
  harmony?: TakeHarmony;
  createdAt: string;
}

/** Metadata returned by the Rust `import_media` command, before an id is assigned. */
export type ProbedMedia = Omit<MediaAsset, "id" | "createdAt" | "thumbnailUrl" | "syncedAudio" | "speakers" | "harmony">;

export interface ImportError {
  path: string;
  message: string;
}

export interface ImportResult {
  assets: ProbedMedia[];
  errors: ImportError[];
}

export interface ImportProgress {
  done: number;
  total: number;
}
