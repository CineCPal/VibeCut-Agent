/** A project's bins and clips as both editors' `read_media_pool` returns them (vibecut_agent/nle/premiere_pool.py
 * and resolve_pool.py), ported from VibeCut's src/types/connect.ts. */

/** One Media Pool / Project panel clip. */
export interface HostPoolClip {
  id: string;
  name: string;
  /** "Master/Footage/B-roll". */
  bin: string;
  /** "Video + Audio", "Video", "Audio", "Still", ... */
  type: string;
  duration?: number;
  fps?: number;
  resolution?: string;
  filePath?: string;
  clipColor?: string;
  flags?: string[];
  /** How many times it's used on timelines. */
  usage: number;
  offline?: boolean;
  /** Marked In/Out, seconds from the clip's start. */
  markIn?: number;
  markOut?: number;
  /** Logged fields that are set: Keywords, Comments, Description, Scene, Shot, Take ... */
  metadata?: Record<string, string>;
}

export interface HostSelection {
  /** Pool clip ids. */
  pool: string[];
  /** Timeline clip ids, and the clip under the playhead: only when the connected timeline is open. */
  timeline: string[];
  underPlayhead: string | null;
}

export interface HostPool {
  bins: { path: string; clips: number }[];
  clips: HostPoolClip[];
  timelines: string[];
  truncated: boolean;
  selection: HostSelection;
}
