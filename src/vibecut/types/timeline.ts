import type { ColorGraph } from "./color";
import type { ConnectHost } from "./connect";

export type TrackType = "video" | "audio";

export const TRANSITION_KINDS = ["dissolve", "dipToBlack"] as const;
/** On a video track: Cross Dissolve and Dip to Black. On an audio track: Constant Power and Dip to Silence. */
export type TransitionKind = (typeof TRANSITION_KINDS)[number];

/** A transition centred on the cut at the end of a clip, into the clip that starts there. */
export interface Transition {
  kind: TransitionKind;
  /** Seconds, split evenly either side of the cut. */
  duration: number;
}

/**
 * One point of a clip's time map: `t` seconds after the clip's start on the timeline shows source
 * time `s`. Between points the map is a straight line, so each stretch plays at one speed. `ramp`
 * marks the in-between steps of an eased speed change; they are part of the map but are not
 * keyframes of their own (see `lib/timeRemap.ts`).
 */
export interface RemapPoint {
  t: number;
  s: number;
  ramp?: true;
}

export interface Clip {
  id: string;
  mediaAssetId: string;
  trackId: string;
  startTime: number;
  duration: number;
  sourceIn: number;
  sourceOut: number;
  name: string;
  /** Loudness of this clip in the preview, 0 to 3 (300%). Missing means full volume (1). */
  volume?: number;
  /** Seconds to fade in from silence and black at the start of the clip. Missing means no fade. */
  fadeIn?: number;
  /** Seconds to fade out to silence and black at the end of the clip. Missing means no fade. */
  fadeOut?: number;
  /** Clips sharing a link id are selected, deleted and split together (e.g. a video and its audio). */
  linkId?: string;
  /**
   * The transition on the cut at this clip's end. It only plays while another clip on the track starts
   * right there, and is shortened to fit what media the two clips have (see `lib/transitions.ts`).
   */
  transitionOut?: Transition;
  /**
   * Speed changes and ramps: the clip's time map, from `(0, sourceIn)` to `(duration, sourceOut)`,
   * with both times always rising. Missing means the clip plays at normal speed, so its duration
   * equals `sourceOut - sourceIn`. Always read it through `lib/timeRemap.ts`.
   */
  timeRemap?: RemapPoint[];
  /**
   * The clip's colour grade, a node graph from the Color page (see `types/color.ts`). Missing means
   * ungraded. Split halves and dissolve tails carry the same graph.
   */
  grade?: ColorGraph;
  /**
   * The Resolve or Premiere clip this one was pulled from (PLAN.md, "Connect page, phase 5"). Sending
   * the timeline back uses it for the clip's grade (Resolve), its switch, and the channels it played.
   * Missing for clips made in VibeCut. Split halves carry it too.
   */
  hostOrigin?: HostOrigin;
}

export interface HostOrigin {
  /** The host's own clip id, from the read it was pulled from. */
  clipId: string;
  /** It was switched off in the host. VibeCut plays it; it goes back switched off. */
  enabled?: false;
  /** Sound only: the channels of its file it played there (one channel of a split stereo pair). */
  channels?: number[];
}

/** Where a pulled timeline came from (PLAN.md, "Connect page, phase 5"). */
export interface SequenceHost {
  kind: ConnectHost;
  project: string;
  /** The host timeline it was pulled from; a send-back rebuilds next to it. */
  timeline: string;
  fps: number;
  startTimecode: string;
  /** ISO time of the pull. */
  pulledAt: string;
}

export interface Track {
  id: string;
  type: TrackType;
  name: string;
  order: number;
  clipIds: string[];
  height: number;
  /**
   * Sync-lock: ripple edits on other tracks shift this track too, so it stays in sync with them.
   * Missing means on (Premiere's default); only `false` is stored.
   */
  syncLocked?: boolean;
  /**
   * Track targeting: Cmd+K with nothing selected, and Up/Down edit-point jumps, act on targeted tracks.
   * Missing means on; only `false` is stored.
   */
  targeted?: boolean;
  /**
   * Source patching: where Insert and Overwrite from the Source monitor put a clip. At most one track
   * of each type; when none is marked, the first track of that type is the destination.
   */
  sourcePatched?: boolean;
  /**
   * Off (Resolve's Disable Track, video tracks only): the track's clips are left out of the picture
   * and the sound, in playback and export, but stay on the timeline. Missing means on; only `false`
   * is stored. Audio tracks have Mute and Solo instead, and ignore it.
   */
  enabled?: boolean;
  /** Mute: the track's sound is silenced in playback and export. Only `true` is stored. */
  muted?: boolean;
  /**
   * Solo (audio tracks): while any audio track is soloed, only soloed tracks are heard, in playback
   * and in a rendered export. Only `true` is stored.
   */
  soloed?: boolean;
}

export const MARKER_COLORS = ["green", "red", "violet", "blue", "white"] as const;
export type MarkerColor = (typeof MARKER_COLORS)[number];

/** A named point in time on the sequence (Premiere's sequence marker). Saved with the project. */
export interface Marker {
  id: string;
  time: number;
  name: string;
  color: MarkerColor;
  note?: string;
}

/** A stretch of B-roll set aside while browsing, not yet on the timeline (see lib/brollPool.ts). */
export interface PoolItem {
  id: string;
  /** The file on disk. It is imported into the project only when the shot is used. */
  path: string;
  filename: string;
  /** The stretch of the file, in seconds. */
  start: number;
  end: number;
  /** What Spyglass saw in the shot, when it came from Spyglass. */
  caption?: string;
  tags?: string[];
  technical?: number;
  /** Spyglass's shot id, for its keyframe. */
  shotId?: number;
}

export interface Sequence {
  id: string;
  name: string;
  trackIds: string[];
  frameRate: number;
  /** Sorted by time. Missing means none. */
  markers?: Marker[];
  /** In the user's order. Missing means empty. */
  brollPool?: PoolItem[];
  /** The timeline grade: a colour graph applied after every clip's own grade. Missing means none. */
  timelineGrade?: ColorGraph;
  /** The sequence's In and Out marks (I and O with the Program monitor active), in seconds. Missing means unmarked. */
  inPoint?: number;
  outPoint?: number;
  /** Pulled from Resolve or Premiere. Missing for VibeCut's own timelines. */
  host?: SequenceHost;
}

export type ActiveInteraction =
  | { kind: "move"; clipId: string; trackId: string; startTime: number }
  /** A linked group dragged together; `trackIdOf` holds the new track of each member that changes track. */
  | { kind: "move-group"; clipIds: string[]; delta: number; trackIdOf?: Record<string, string> }
  | { kind: "trim-start"; clipId: string; sourceIn: number; startTime: number }
  | { kind: "trim-end"; clipId: string; sourceOut: number }
  /** Ripple and rolling edits in progress: how each affected clip will look once the drag ends. */
  | { kind: "preview"; overrides: Record<string, Clip> }
  | null;

/** The timeline's editing tools: Selection (V), Blade (C), Ripple edit (B) and Rolling edit (N). */
export type EditTool = "select" | "blade" | "ripple" | "roll";

/** One timeline's editable content: what `useTimelineStore` holds for the timeline being shown. */
export interface TimelineContent {
  sequence: Sequence;
  tracksById: Record<string, Track>;
  clipsById: Record<string, Clip>;
}

/** Where a timeline was being viewed, kept while another one is shown. Not saved in undo. */
export interface TimelineView {
  playheadTime: number;
  pixelsPerSecond: number;
}

/** A folder in the Project pool. Bins nest; a bin at the top level has no parent. */
export interface Bin {
  id: string;
  name: string;
  parentId: string | null;
}
