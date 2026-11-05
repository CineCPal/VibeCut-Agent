/**
 * The edit suite's workstations (PLAN.md, "The studio as an edit suite", 2026-11-05): one desk per bot or
 * tool, keyed by the envelope's `agent_id` (an instance suffix such as `.01` dropped), each in the room of
 * its SubagentType. The ids are the ones the bus emits (telemetry/instrument.py `TOOL_AGENTS` and
 * `ROOT_AGENT_ID`). An agent not listed here gets a desk of its own at the end of its room.
 */
import type { SubagentType } from "@vibecut/contracts";

/** What stands on the desk, drawn by the canvas. */
export type StationGear =
  | "bridge" // ultrawide command desk
  | "notes" // a ledger and a pin board
  | "deck" // tape decks and a waveform scope
  | "light_table" // a contact strip and a loupe
  | "rack" // a server rack
  | "catalog" // card drawers
  | "flatbed" // a splicer and a filmstrip
  | "console" // a fader console
  | "grade" // trackballs and a vectorscope
  | "monitor"; // a pair of plain monitors

export interface StationConfig {
  /** `agent_id` without an instance suffix. */
  key: string;
  subagent: SubagentType;
  /** The nameplate. */
  title: string;
  /** The line under it: what the desk does. */
  role: string;
  gear: StationGear;
}

export const STATIONS: readonly StationConfig[] = [
  // The Command Bridge.
  { key: "orchestrator.supervisor", subagent: "MASTER_ORCHESTRATOR", title: "Claude", role: "Supervising editor", gear: "bridge" },
  { key: "app.project", subagent: "MASTER_ORCHESTRATOR", title: "Project", role: "Timelines, social versions", gear: "monitor" },
  { key: "app.project_notes", subagent: "MASTER_ORCHESTRATOR", title: "Notes", role: "Brief, people, style", gear: "notes" },
  { key: "app.edit_log", subagent: "MASTER_ORCHESTRATOR", title: "Edit log", role: "Revert", gear: "notes" },
  // Ingest & transcription.
  { key: "worker.whisper", subagent: "INGEST_TRANSCRIBE", title: "Whisper", role: "Transcribe and align", gear: "deck" },
  { key: "app.transcripts", subagent: "INGEST_TRANSCRIBE", title: "Transcripts", role: "Lines, speakers, fillers", gear: "monitor" },
  { key: "app.ingest", subagent: "INGEST_TRANSCRIBE", title: "Ingest", role: "Import media", gear: "deck" },
  // Vision screening.
  { key: "worker.vlm", subagent: "VISION_TAGGER", title: "Vision model", role: "Shot visuals", gear: "light_table" },
  { key: "app.broll_analyzer", subagent: "VISION_TAGGER", title: "Analyzer", role: "Scores a B-roll folder", gear: "light_table" },
  { key: "app.thumbnails", subagent: "VISION_TAGGER", title: "Thumbnails", role: "Candidates, stills", gear: "monitor" },
  // Archive & B-roll vault.
  { key: "worker.vector", subagent: "BROLL_RETRIEVER", title: "Vector index", role: "Hybrid asset search", gear: "rack" },
  { key: "app.broll_library", subagent: "BROLL_RETRIEVER", title: "B-roll Library", role: "Spyglass search", gear: "catalog" },
  { key: "app.media_pool", subagent: "BROLL_RETRIEVER", title: "Bins", role: "Project media", gear: "catalog" },
  // Assembly & pacing.
  { key: "worker.otio_cutter", subagent: "PACING_CUTTER", title: "OTIO cutter", role: "Proposes deltas", gear: "flatbed" },
  { key: "app.timeline", subagent: "PACING_CUTTER", title: "Timeline", role: "Tracks, speed, fades", gear: "flatbed" },
  { key: "app.review", subagent: "PACING_CUTTER", title: "Review", role: "Pacing, checks, chapters", gear: "monitor" },
  { key: "app.style", subagent: "PACING_CUTTER", title: "Style", role: "Learns a reference edit", gear: "monitor" },
  // The mix stage.
  { key: "worker.audio_sync", subagent: "AUDIO_ENGINEER", title: "Boundaries", role: "Silence, cuts, loudness", gear: "console" },
  { key: "app.audio_sync", subagent: "AUDIO_ENGINEER", title: "Sync", role: "Picture to sound", gear: "console" },
  { key: "app.audio_mix", subagent: "AUDIO_ENGINEER", title: "Mix", role: "Loudness, beats", gear: "console" },
  { key: "app.audio_repair", subagent: "AUDIO_ENGINEER", title: "Repair", role: "Dialogue, room tone", gear: "console" },
  // Finishing & delivery.
  { key: "worker.color_nle", subagent: "COLOR_GRADER", title: "Editor link", role: "Commits to the editor", gear: "monitor" },
  { key: "app.markers", subagent: "COLOR_GRADER", title: "Markers", role: "Adds and edits markers", gear: "monitor" },
  { key: "app.color", subagent: "COLOR_GRADER", title: "Colour", role: "Measure, match, balance", gear: "grade" },
  { key: "app.finishing", subagent: "COLOR_GRADER", title: "Transform", role: "Scale and position", gear: "grade" },
  { key: "app.titles", subagent: "COLOR_GRADER", title: "Titles", role: "Lower thirds, captions", gear: "monitor" },
  { key: "app.deliver", subagent: "COLOR_GRADER", title: "Deliver", role: "Exports", gear: "rack" },
];

export const STATION_BY_KEY: ReadonlyMap<string, StationConfig> = new Map(STATIONS.map((s) => [s.key, s]));

/** The desk an envelope's agent sits at: its id without an instance suffix (`worker.vlm.01` → `worker.vlm`). */
export function stationKey(agentId: string): string {
  return agentId.replace(/\.\d+$/, "");
}

/** A desk for an agent the catalogue doesn't list, in its own role's room. */
export function guestStation(key: string, subagent: SubagentType): StationConfig {
  const name = key.split(".").pop() ?? key;
  return { key, subagent, title: name.replaceAll("_", " "), role: key, gear: "monitor" };
}
