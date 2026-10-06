import type { SpeakerInfo } from "./media";

/** One word of a line, when the transcriber recorded word timings; seconds in the source file. */
export interface TranscriptWord {
  start: number;
  end: number;
  text: string;
}

/** One spoken line of a transcript; times are seconds in the source file. */
export interface TranscriptSegment {
  start: number;
  end: number;
  text: string;
  speaker: string;
  /** Absent for transcripts made before word timings were recorded, or lines edited by hand. */
  words?: TranscriptWord[];
}

/** What the Rust `read_transcript` command returns for a media file. */
export interface TranscriptData {
  segments: TranscriptSegment[];
  speakers: string[];
  /** Display names the user gave to speakers in the transcriber, by speaker id. */
  speakerLabels: Record<string, string>;
  /** Speakers whose lines the user turned off in the transcriber. */
  excludedSpeakers: string[];
  /**
   * Set when the Blair suite transcribed a synced external recording instead of the video's own sound;
   * the times were already shifted onto the video by `syncOffsetSeconds`.
   */
  audioSource?: string;
  syncOffsetSeconds?: number;
  /**
   * VibeCut's own names and roles for these speakers, from the project (the transcript owner's
   * `MediaAsset.speakers`). Filled in by `transcriptFor`; never read from the transcript file.
   */
  speakerInfo?: Record<string, SpeakerInfo>;
}
