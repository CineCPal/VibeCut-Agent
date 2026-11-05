/** The seven rooms of the edit suite (visualizer-spec.md §3.1): each role's title, accent and props. Where they
 * stand and their workstations are lib/studio/suite.ts and lib/studio/stations.ts (PLAN.md, "The studio as an
 * edit suite", 2026-11-05). */
import type { SubagentType } from "@vibecut/contracts";
import type { StudioBayConfig } from "../../types/studio";

export const BAYS: readonly StudioBayConfig[] = [
  {
    bay: 0,
    subagent: "MASTER_ORCHESTRATOR",
    title: "Command Bridge",
    accent: "#4a90d9",
    props: "Curved ultrawide command desk, prompt teleprompter, ON-AIR tally lamp",
  },
  {
    bay: 1,
    subagent: "INGEST_TRANSCRIBE",
    title: "Ingest & Transcription",
    accent: "#38bdf8",
    props: "Reel-to-reel decks, green CRT spectrogram, timecode slate",
  },
  {
    bay: 2,
    subagent: "VISION_TAGGER",
    title: "Vision Screening Room",
    accent: "#a855f7",
    props: "3-frame contact-strip light table, loupe arm, RGB histogram",
  },
  {
    bay: 3,
    subagent: "BROLL_RETRIEVER",
    title: "Archive & B-roll Vault",
    accent: "#00C853",
    props: "Card catalog, sqlite-vec blade rack, robotic bin picker",
  },
  {
    bay: 4,
    subagent: "PACING_CUTTER",
    title: "Assembly & Pacing",
    accent: "#FFB300",
    props: "Flatbed splicer, OTIO filmstrip dispenser, Gemma scanner gate",
  },
  {
    bay: 5,
    subagent: "AUDIO_ENGINEER",
    title: "Mix Stage",
    accent: "#14b8a6",
    props: "Motorized fader console, nearfield monitors, EBU R128 LUFS tower",
  },
  {
    bay: 6,
    subagent: "COLOR_GRADER",
    title: "Finishing & Delivery",
    accent: "#f43f5e",
    props: "Trackball control surface, vectorscope, Premiere/Resolve uplink",
  },
];

export const BAY_BY_SUBAGENT: Readonly<Record<SubagentType, StudioBayConfig>> = Object.fromEntries(
  BAYS.map((bay) => [bay.subagent, bay]),
) as Record<SubagentType, StudioBayConfig>;

/** Short names for pills and badges. */
export const SUBAGENT_SHORT: Readonly<Record<SubagentType, string>> = {
  MASTER_ORCHESTRATOR: "ORCH",
  INGEST_TRANSCRIBE: "WHISPER",
  VISION_TAGGER: "VISION",
  BROLL_RETRIEVER: "VECTOR",
  PACING_CUTTER: "CUTTER",
  AUDIO_ENGINEER: "AUDIO",
  COLOR_GRADER: "NLE",
};

/** The SubagentType ordinal, for grouping same-type nodes in the DAG. */
export const SUBAGENT_ORDER: Readonly<Record<SubagentType, number>> = Object.fromEntries(
  BAYS.map((bay) => [bay.subagent, bay.bay]),
) as Record<SubagentType, number>;
