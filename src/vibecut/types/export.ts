import type { ColorGraph } from "./color";
import type { TransitionKind } from "./timeline";

export interface ExportVideoSegment {
  path: string;
  timelineStart: number;
  duration: number;
  sourceIn: number;
  fadeIn: number;
  fadeOut: number;
  /**
   * Seconds this segment dissolves in over the end of the one before, which runs on that much past
   * this segment's start. Missing means a cut.
   */
  transitionIn?: number;
  /**
   * The segment's speed changes (see `lib/timeRemap.ts`): points from `(0, sourceIn)` to
   * `(duration, source out)`, `t` in seconds from the segment's start. Missing means normal speed.
   */
  timeMap?: ExportTimePoint[];
  /** The segment's colour grade, a key into `ExportRequest.colorGraphs`. Missing means ungraded. */
  gradeKey?: string;
}

/** One point of a segment's time map: `t` seconds into the segment shows source second `s`. */
export interface ExportTimePoint {
  t: number;
  s: number;
}

export interface ExportAudioSegment {
  path: string;
  timelineStart: number;
  duration: number;
  sourceIn: number;
  volume: number;
  fadeIn: number;
  fadeOut: number;
  /** The fades are one side of a crossfade and follow an equal-power curve. */
  powerFades?: boolean;
  /** As on a video segment. */
  timeMap?: ExportTimePoint[];
}

export interface ExportAudioLane {
  segments: ExportAudioSegment[];
}

/** A chapter written into the MP4, from a sequence marker. Times in seconds. */
export interface ExportChapter {
  start: number;
  end: number;
  title: string;
}

export interface ExportRequest {
  outputPath: string;
  width: number;
  height: number;
  frameRate: number;
  durationSeconds: number;
  videoSegments: ExportVideoSegment[];
  audioLanes: ExportAudioLane[];
  /** Empty for no chapters. */
  chapters: ExportChapter[];
  /** Colour grades by key: each the clip's graph, then the timeline's. Missing or empty for none. */
  colorGraphs?: Record<string, ColorGraph[]>;
}

export interface ExportProgressPayload {
  jobId: string;
  fraction: number;
}

export type ExportPreset = "source" | "1080p" | "720p";

/** One clip of a general, multi-track timeline export (Premiere XML/FCPXML/OTIO) — see
 * rough-cut-studio's xml_builder.build_premiere_xml_timeline for the shared contract every format
 * builder follows. Unlike ExportVideoSegment/ExportAudioSegment above (which flatten the timeline
 * for ffmpeg rendering), this keeps every clip distinct and every VibeCut track as its own output
 * track, since that's what these interchange formats can represent directly. */
export interface TimelineExportClip {
  sourcePath: string;
  sourceName: string;
  startTimeSeconds: number;
  sourceInSeconds: number;
  sourceOutSeconds: number;
  /** Only consulted for a "video" track's clips — an "audio" track's clips always carry sound. */
  hasAudio: boolean;
  /** Linear gain, 1.0 = unity. */
  volume: number;
  fadeInSeconds?: number;
  fadeOutSeconds?: number;
  /** The transition on the cut at this clip's end, at the length that actually plays. */
  transitionOut?: { kind: TransitionKind; seconds: number };
  /**
   * Clips with the same group move together in the other editor (Premiere `<link>`s; in FCPXML, sound
   * connected under its picture). A camera clip, its synced recordings and its muted own sound share one.
   */
  linkGroup?: string;
  /** False for a sound clip muted to 0 (a synced clip's own camera sound): written disabled at full level, so it can be switched back on. */
  enabled?: boolean;
  /** Which of the file's channels to write (1-based), when not all of them (A-Sync's channel routing). */
  audioChannels?: number[];
  /**
   * Speed changes, as on `ExportVideoSegment`: `t` in seconds from the clip's start on the timeline,
   * `s` in source seconds, from `(0, sourceInSeconds)` to `(length, sourceOutSeconds)`. The clip's
   * length on the timeline is then the last point's `t`, not `sourceOut - sourceIn`. Missing means
   * normal speed.
   */
  timeMap?: ExportTimePoint[];
  /** The clip has a colour grade, which these formats can't carry (the export warns). */
  graded?: true;
}

/** What the interchange exports need to know about each source file, keyed by path. */
export interface TimelineExportSource {
  hasVideo: boolean;
  width?: number;
  height?: number;
  audioChannels?: number;
  sampleRate?: number;
}

export interface TimelineExportTrack {
  type: "video" | "audio";
  clips: TimelineExportClip[];
}

export type TimelineExportFormat = "premiereXml" | "fcpxml" | "otio";
