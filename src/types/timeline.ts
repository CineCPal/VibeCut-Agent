/** A timeline as both editors' `read_timeline` returns it (vibecut_agent/nle/premiere.py and resolve.py). */

export interface HostMarker {
  id: string;
  /** Seconds from the timeline's start. */
  time: number;
  name: string;
  color: string;
  note: string;
  duration: number;
}

export interface HostClip {
  id: string;
  name: string;
  start: number;
  end: number;
  enabled: boolean;
  /** "effect": a transition, generator or adjustment layer, with no source file. */
  kind?: "effect";
  sourceIn?: number;
  sourceOut?: number;
  speed?: number;
  filePath?: string;
  volumeDb?: number;
  fadeIn?: number;
  fadeOut?: number;
  fusion?: boolean;
  nested?: boolean;
  offline?: boolean;
  channel?: number;
  linkedIds?: string[];
}

export interface HostTrack {
  type: "video" | "audio" | "subtitle";
  index: number;
  name: string;
  /** null where the editor doesn't say (Resolve, for a timeline that isn't open). */
  enabled: boolean | null;
  locked?: boolean | null;
  clips: HostClip[];
}

export interface HostTimeline {
  project: string;
  timeline: string;
  fps: number;
  startTimecode: string;
  duration: number;
  isCurrent: boolean;
  tracks: HostTrack[];
  markers: HostMarker[];
}
