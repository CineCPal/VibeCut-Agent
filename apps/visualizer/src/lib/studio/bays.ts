/** The seven studio bays (visualizer-spec.md §3.1). Anchors are the bays' centres on the 1280x720 grid. */
import type { SubagentType } from "@vibecut/contracts";
import type { StudioBayConfig } from "../../types/studio";

export const STUDIO_WIDTH = 1280;
export const STUDIO_HEIGHT = 720;

export const BAYS: readonly StudioBayConfig[] = [
  {
    bay: 0,
    subagent: "MASTER_ORCHESTRATOR",
    title: "Command Bridge",
    x: 520,
    y: 360,
    w: 240,
    h: 150,
    accent: "#4a90d9",
    props: "Curved ultrawide command desk, prompt teleprompter, ON-AIR tally lamp",
  },
  {
    bay: 1,
    subagent: "INGEST_TRANSCRIBE",
    title: "Ingest & Transcription Rack",
    x: 180,
    y: 160,
    w: 220,
    h: 140,
    accent: "#38bdf8",
    props: "Reel-to-reel decks, green CRT spectrogram, timecode slate",
  },
  {
    bay: 2,
    subagent: "VISION_TAGGER",
    title: "Vision Screening Room",
    x: 180,
    y: 540,
    w: 220,
    h: 140,
    accent: "#a855f7",
    props: "3-frame contact-strip light table, loupe arm, RGB histogram",
  },
  {
    bay: 3,
    subagent: "BROLL_RETRIEVER",
    title: "Archive & B-Roll Vault",
    x: 640,
    y: 140,
    w: 220,
    h: 140,
    accent: "#00C853",
    props: "Card catalog, sqlite-vec blade rack, robotic bin picker",
  },
  {
    bay: 4,
    subagent: "PACING_CUTTER",
    title: "Assembly & Pacing Bench",
    x: 1060,
    y: 160,
    w: 230,
    h: 150,
    accent: "#FFB300",
    props: "Flatbed splicer, OTIO filmstrip dispenser, Gemma scanner gate",
  },
  {
    bay: 5,
    subagent: "AUDIO_ENGINEER",
    title: "Mixing & Foley Desk",
    x: 620,
    y: 560,
    w: 220,
    h: 140,
    accent: "#14b8a6",
    props: "Motorized fader console, nearfield monitors, EBU R128 LUFS tower",
  },
  {
    bay: 6,
    subagent: "COLOR_GRADER",
    title: "DI Grading & NLE Finishing Suite",
    x: 1060,
    y: 480,
    w: 230,
    h: 150,
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

/** The bay whose centre-rect contains a logical point, if any. */
export function bayAt(x: number, y: number): StudioBayConfig | null {
  return (
    BAYS.find((b) => Math.abs(x - b.x) <= b.w / 2 && Math.abs(y - b.y) <= b.h / 2) ?? null
  );
}
