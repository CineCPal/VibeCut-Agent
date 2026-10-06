/** The Connect page's view of another editor (PLAN.md, "Connect page"). Times are seconds from the
 * start of the host timeline; ids are the host's own. Shapes match `src-python/host-resolve`, and
 * `src-python/host-premiere` answers in the same shapes. */

export type ConnectHost = "resolve" | "premiere";

export interface HostClip {
  id: string;
  name: string;
  start: number;
  end: number;
  enabled: boolean;
  /** A transition or generator: no source file. */
  kind?: "effect";
  sourceIn?: number;
  sourceOut?: number;
  /** Constant speed when not 1. */
  speed?: number;
  /** A draft clip's speed ramp: its slowest and fastest speed. */
  ramp?: { min: number; max: number };
  /** Has Fusion effects, which a rebuilt timeline can't carry. */
  fusion?: boolean;
  /** Premiere: a nested sequence, with no source file of its own. */
  nested?: boolean;
  /** Premiere: its media is offline. */
  offline?: boolean;
  /** Premiere: the one channel of its file this clip plays, when the file's channels are on several
   * audio tracks (A1 left, A2 right). */
  channel?: number;
  filePath?: string;
  volumeDb?: number;
  linkedIds?: string[];
  /** Resolve: seconds of fade in and out (Premiere's are keyframes, not read with the timeline). */
  fadeIn?: number;
  fadeOut?: number;
}

export interface HostTrack {
  type: "video" | "audio" | "subtitle";
  index: number;
  name: string;
  /** Null when the host can't say (Resolve only reports it for the timeline open in it; Premiere
   * reports its track output or mute switch for every sequence). */
  enabled: boolean | null;
  /** Null or absent when the host can't say (Resolve: only for the timeline open in it). VibeCut
   * keeps off a locked track's clips (PLAN.md, "Phase 8a"). */
  locked?: boolean | null;
  /** Premiere: its mute switch (a video track's output), and whether it's targeted. */
  muted?: boolean;
  targeted?: boolean;
  clips: HostClip[];
}

export interface HostMarker {
  id: string;
  time: number;
  name: string;
  color: string;
  note: string;
  duration: number;
}

export interface HostTimeline {
  project: string;
  timeline: string;
  fps: number;
  startTimecode: string;
  duration: number;
  /** Whether it is the timeline open in the host right now. */
  isCurrent: boolean;
  tracks: HostTrack[];
  markers: HostMarker[];
}

/** What the host reports on connecting, and on `status`. */
export interface HostStatus {
  product: string;
  version: string;
  project: string | null;
  timelines: string[];
  currentTimeline: string | null;
  /** Premiere: VibeCut's Agent plugin is running in it (PLAN.md, "Phase 6, 6c"). */
  agentPanel?: boolean;
}

export type ConnectStatus = "disconnected" | "connecting" | "connected" | "error";

/** One Media Pool clip as `read_media_pool` reports it (src-python/host-resolve/resolve_pool.py). */
export interface HostPoolClip {
  id: string;
  name: string;
  /** "Master/Footage/B-roll". */
  bin: string;
  /** Resolve's own: "Video + Audio", "Video", "Audio", "Still", ... */
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
  /** Media Pool clip ids. */
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

/** One field of one Media Pool clip as a pool command changed it (src-python/host-resolve/resolve_organize.py).
 * Fields: "bin" (a bin path), "color" ("" for none), "flags", "metadata:<key>" and "name". */
export interface PoolChange {
  clipId: string;
  field: string;
  before: string | string[];
  after: string | string[];
}

/** What a pool command did, as `create_bins`, `move_clips`, `set_clip_labels`, `set_clip_metadata`
 * and `rename_clips` report it. */
export interface PoolChangeResult {
  changes: PoolChange[];
  createdBins: string[];
  refused: { clipId: string; reason: string }[];
}

/** One agent tool call that changed the Media Pool, kept for the connection so it can be reverted. */
export interface PoolLogEntry {
  id: string;
  /** The chat message the agent was answering: Revert can undo a whole request. */
  step: string;
  /** That message's words, to label the step. */
  stepText: string;
  at: number;
  tool: string;
  summary: string;
  changes: PoolChange[];
  createdBins: string[];
  /** Set once reverted: how many changes were left because the clip had changed since. */
  reverted?: { at: number; changedSince: number; failed: number; binsKept: string[] };
}

/** One direct edit on the connected timeline as `add_clips`, `delete_clips`, `set_clips_enabled`,
 * `set_clip_levels`, `reshape_clip`, `set_clip_fades` and `set_transition` report it (src-python/host-resolve/resolve_edit.py). Kept as Resolve sent it, since
 * `revert_timeline_changes` takes it back as it was. */
/** A transition on a cut as a "transition" change records it: VibeCut's kind when it is one of
 * VibeCut's ("other" for the editor's own), and the editor's name for it. */
export interface HostTransitionState {
  kind: "dissolve" | "dipToBlack" | "other";
  type: string;
  frames: number;
  seconds: number;
}

export interface TimelineChange {
  kind: "added" | "deleted" | "enabled" | "level" | "reshaped" | "fade" | "transition" | "duck" | "captions" | "speed" | "split" | "track" | "grade" | "link" | "trackOptions";
  name?: string;
  /** "deleted", "enabled", "level": the timeline clip. */
  itemId?: string;
  /** "added": the picture and sound placed. */
  itemIds?: string[];
  /** "added": where, in seconds from the timeline's start, and on which tracks ("V2", "A1"). */
  at?: number;
  end?: number;
  tracks?: string[];
  /** "deleted": where it was. */
  track?: [string, number];
  start?: number;
  /** "deleted": the clips lifted with it. */
  deletedWith?: string[];
  /** "transition": what was on the cut before and after (null: none). "fade": seconds. */
  before?: boolean | number | HostTransitionState | null;
  after?: boolean | number | HostTransitionState | null;
  /** "fade": which end. */
  which?: "fadeIn" | "fadeOut";
  /** "transition": the clip after the cut, and where the cut is (seconds). */
  incomingId?: string;
  cut?: number;
  /** "fade", "transition": cut shorter than asked to fit. */
  clamped?: boolean;
  /** "reshaped": "trimmed", "slipped" or "moved", and each clip replaced (picture and its sound).
   * "split": each clip cut, where it was, its left piece, and the new right piece. */
  how?: string;
  items?: { before: ClipPlacement; after: ClipPlacement; right?: ClipPlacement }[];
  /** "speed": whether later clips moved with its end, and where its end was before. Premiere also
   * lists the clip and each linked partner it set, with its speed before. */
  ripple?: boolean;
  speeds?: { id: string; before: number }[];
  endBefore?: number;
  /** "track": added or removed, which kind, and the 1-based indexes. "link": what was done. */
  action?: "added" | "removed" | "linked" | "unlinked";
  type?: "video" | "audio";
  indexes?: number[];
  /** "grade": what VibeCut set on the clip in words, and its state afterwards (null: VibeCut's grade
   * taken off). Resolve: the grade versions before and after; Premiere: VibeCut's Lumetri component and
   * its values before and after. */
  description?: string;
  stateAfter?: unknown;
  /** "link": linked or unlinked, and the clips' link groups before and after (singletons included). */
  groupsBefore?: string[][];
  groupsAfter?: string[][];
  /** "trackOptions": each option set, [before, after] ("enabled", "locked"; Premiere's "muted",
   * "targeted", "syncLocked"). "reshaped" moves of several clips: how many groups moved. */
  options?: Record<string, [boolean, boolean]>;
  groups?: number;
  /** "reshaped": what didn't carry onto the new clip. */
  notCarried?: string[];
  [key: string]: unknown;
}

/** Where a reshaped clip was or is: its id then, track, seconds from the timeline's start, and the
 * source frame it starts at. */
export interface ClipPlacement {
  id: string;
  track: [string, number];
  start: number;
  end: number;
  sourceStartFrame: number;
}

/** One agent tool call that edited the connected timeline directly (phase 3). */
export interface TimelineEditEntry {
  id: string;
  step: string;
  stepText: string;
  at: number;
  tool: string;
  summary: string;
  timeline: string;
  /** The copy made before this request's first edit ("Interview (before VibeCut 1)"). */
  backup: string | null;
  changes: TimelineChange[];
  reverted?: { at: number; changedSince: number; failed: number; lost: string[]; gradedFromBackup?: string[] };
}
