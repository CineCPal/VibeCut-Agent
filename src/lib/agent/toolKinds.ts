/**
 * Which tools change the editor or project (Phase 11d): with Review edits first on, each of these
 * waits for the user's Apply. Every tool the agent has is listed here or in NOT_REVIEWED, and a test
 * fails when a new one is in neither, so a new tool can't slip past review unnoticed.
 *
 * Not reviewed: reads and searches; the selection and the playhead; transcribing (it writes only a
 * transcript beside the media); the Story Editor (it only opens a draft); and the draft's own cuts
 * (remove_time_ranges, rearrange_sections, the transcript-line cuts, set_speed_ramp), which reach the editor only
 * through send_to_*, which is reviewed.
 */
import { lastTimelineView } from "./context";
import { selectActiveHost, useNleStateStore } from "../../store/useNleStateStore";
import { useConnectionStore } from "../../store/useConnectionStore";

export const CHANGING_TOOLS = new Set([
  "add_clips",
  "delete_clips",
  "set_clips_enabled",
  "label_timeline_clips",
  // Phase 16f.
  "set_clip_transform",
  "set_clip_levels",
  "set_clip_fade",
  "split_clip",
  "trim_clip_start",
  "trim_clip_end",
  "slip_clip",
  "move_clip",
  "nest_clips",
  "duck_music",
  "revert_timeline_edits",
  "add_markers",
  "update_marker",
  "remove_markers",
  "create_timeline",
  "duplicate_timeline",
  "switch_timeline",
  "rename_timeline",
  "import_media",
  "link_clips",
  "unlink_clips",
  "sync_clips",
  "sync_and_place",
  "slip_into_sync",
  "set_speaker_roles",
  "send_to_premiere",
  "send_to_resolve",
  "discard_draft",
  // Phase 12b-12d.
  "set_clip_speed",
  "build_broll_selects_timeline",
  "clear_clip_speed",
  "set_transition",
  "add_track",
  "remove_track",
  "set_track_options",
  // Phase 12e: organizing the project.
  "create_bins",
  "move_clips",
  "set_clip_labels",
  "set_clip_metadata",
  "rename_clips",
  // Phase 13d: levels set through set_clip_levels.
  "normalize_loudness",
  // Phase 14c.
  "cut_to_beats",
  // Phase 14d: a new timeline, as duplicate_timeline is.
  "make_social_version",
  // Phase 15a: a caption or subtitle track, reverted like any edit (Premiere's is deleted by hand).
  "create_captions",
  // Phase 18c: cleaned sound laid under the clips, the originals switched off.
  "clean_dialogue",
  // Phase 18d: rendered lower thirds laid on a track above the picture.
  "add_lower_thirds",
]);

export const NOT_REVIEWED = new Set([
  "describe_spyglass_folder",
  "find_broll",
  "find_filler_words",
  "find_silences",
  "get_clip_info",
  // Phase 16f: reads only.
  "get_clip_transform",
  "get_edit_log",
  "get_playhead_time",
  "get_transcript",
  "list_markers",
  "list_media_pool",
  "list_speakers",
  "list_spyglass_folders",
  "list_timeline_clips",
  "list_timelines",
  "look_at_clip",
  "look_at_media",
  "look_at_timeline",
  // Phase 13c: the project's notes in the app, not the editor or project.
  "remember_note",
  "forget_note",
  // Phase 13d: measuring only.
  "measure_loudness",
  "find_beats",
  // Phase 14a: reports only.
  "review_edit",
  // Phase 15b: renders write a new file and leave the timeline as it was (only when the user asks).
  "export_video",
  "export_audio",
  // Each clip's source cut to its own file, outside the editor (renderTools.ts).
  "export_clips",
  "search_media_pool",
  "search_transcript",
  "select_clip",
  "select_media_assets",
  "set_playhead_time",
  "transcribe_clips",
  "run_story_editor",
  "remove_time_ranges",
  "analyze_broll_folder",
  "export_broll_selects",
  "set_speed_ramp",
  "rearrange_sections",
  "remove_transcript_lines",
  "remove_speaker_lines",
  // Phase 18a: a draft cut, like the other draft tools.
  "cut_by_speaker",
  // Phase 18b: also a draft cut.
  "make_split_edit",
]);

export const needsReview = (name: string): boolean => CHANGING_TOOLS.has(name);

const VERB: Record<string, string> = {
  add_clips: "Add clips",
  cut_to_beats: "Cut to the beat with shots",
  make_social_version: "Make a social version",
  create_captions: "Add captions",
  clean_dialogue: "Clean the dialogue of",
  add_lower_thirds: "Add lower thirds",
  delete_clips: "Delete",
  set_clips_enabled: "Turn on/off",
  label_timeline_clips: "Name or colour",
  set_clip_transform: "Scale or move",
  set_clip_levels: "Change the level of",
  set_clip_fade: "Fade",
  split_clip: "Split",
  trim_clip_start: "Trim the start of",
  trim_clip_end: "Trim the end of",
  slip_clip: "Slip",
  move_clip: "Move",
  nest_clips: "Nest",
  duck_music: "Duck the music under",
  revert_timeline_edits: "Revert earlier edits",
  add_markers: "Add markers",
  update_marker: "Change a marker",
  remove_markers: "Remove markers",
  create_timeline: "Create a timeline",
  duplicate_timeline: "Copy a timeline",
  switch_timeline: "Switch to another timeline",
  rename_timeline: "Rename a timeline",
  import_media: "Import media",
  link_clips: "Link",
  unlink_clips: "Unlink",
  sync_clips: "Sync",
  sync_and_place: "Sync and place",
  slip_into_sync: "Slip into sync",
  set_speaker_roles: "Set speaker names and roles",
  send_to_premiere: "Send the draft to Premiere as a new sequence",
  send_to_resolve: "Send the draft to Resolve as a new timeline",
  discard_draft: "Discard the draft",
  set_clip_speed: "Change the speed of",
  clear_clip_speed: "Put back to normal speed",
  build_broll_selects_timeline: "Build a timeline of B-roll selects",
  set_transition: "Set the transition after",
  add_track: "Add a track",
  remove_track: "Remove a track",
  set_track_options: "Switch a track",
  create_bins: "Create bins",
  move_clips: "Move project clips into a bin",
  set_clip_labels: "Change the colour of",
  set_clip_metadata: "Change the logged notes of",
  rename_clips: "Rename project clips",
};

/** Clip names for ids, from the timeline last read (or, for a short pool id like "p3", the project's
 * clips), else the ids themselves. */
function clipNames(ids: string[]): string[] {
  const nle = useNleStateStore.getState();
  const host = selectActiveHost(nle);
  const timeline = host ? nle.hosts[host].timeline : null;
  const view = host && timeline ? lastTimelineView(host, timeline) : null;
  const names = new Map(view?.tracks.flatMap((t) => t.clips.map((c) => [c.id, c.name] as const)) ?? []);
  if (host) {
    const { pool, aliases } = useConnectionStore.getState().connections[host];
    for (const clip of pool?.clips ?? []) names.set(aliases[clip.id] ?? clip.id, clip.name);
  }
  return ids.map((id) => names.get(id) ?? id);
}

const listed = (items: string[], max = 3) =>
  items.length <= max ? items.join(", ") : `${items.slice(0, max).join(", ")} and ${items.length - max} more`;

/** A plain line for a review card: what the change does, and to what. */
export function describeChange(name: string, args: unknown): string {
  const verb = VERB[name] ?? name;
  const a = typeof args === "object" && args !== null ? (args as Record<string, unknown>) : {};
  const strings = (value: unknown) => (Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : []);
  const ids = [...strings(a.clipIds), ...(typeof a.clipId === "string" ? [a.clipId] : [])];
  const count = (key: string) => (Array.isArray(a[key]) ? (a[key] as unknown[]).length : 0);
  if (ids.length) {
    const names = clipNames(ids);
    return `${verb} ${ids.length === 1 ? "" : `${ids.length} clips: `}${listed(names)}`;
  }
  for (const key of ["clips", "shots", "thirds", "markers", "paths", "markerIds", "renames"]) {
    if (count(key)) return `${verb} (${count(key)})`;
  }
  const named = [a.name, a.newName, a.timeline, a.aspect].find((v): v is string => typeof v === "string" && v.length > 0);
  return named ? `${verb}: ${named}` : verb;
}
