import type { SpeakerRole } from "../types/media";
import type { TranscriptData } from "../types/transcript";

// Who is speaking and in what role (see PLAN.md, "Speaker roles"). Roles live on the asset that owns
// the transcript (`MediaAsset.speakers`) and reach readers through `transcriptFor`'s `speakerInfo`.

export interface ResolvedSpeaker {
  /** The transcript's own speaker id ("Speaker 1"). */
  id: string;
  /** VibeCut's name, else the transcriber's label, else the id. */
  name: string;
  role?: SpeakerRole;
  /** True when the role is a guess (the agent's, or read from the transcriber's excluded speakers). */
  inferred: boolean;
}

export function resolveSpeaker(data: TranscriptData, id: string): ResolvedSpeaker {
  const info = data.speakerInfo?.[id];
  const name = info?.name?.trim() || data.speakerLabels[id]?.trim() || id;
  if (info?.role) return { id, name, role: info.role, inferred: info.inferred === true };
  // Turning a speaker off in the transcriber meant "not part of the story": the usual case is the interviewer.
  if (data.excludedSpeakers.includes(id)) return { id, name, role: "interviewer", inferred: true };
  return { id, name, inferred: false };
}

/** A speaker as the Story Editor and the review read it: "Interviewer (Ana)", or just the name. */
export function speakerTag(speaker: Pick<ResolvedSpeaker, "id" | "name" | "role">): string {
  if (speaker.role !== "interviewer") return speaker.name;
  const plain = speaker.name === speaker.id || /^interviewer$/i.test(speaker.name.trim());
  return plain ? "Interviewer" : `Interviewer (${speaker.name})`;
}

/** The speaker ids in a transcript, in order of first appearance (the transcriber's list first). */
export function speakerIds(data: TranscriptData): string[] {
  return [...new Set([...data.speakers, ...data.segments.map((s) => s.speaker)])];
}

export interface SpeakerStats {
  lines: number;
  seconds: number;
  /** Share of lines that end with a question mark, 0 to 1. */
  questionShare: number;
  /** Mean words per line. */
  wordsPerLine: number;
  samples: string[];
}

const SAMPLE_COUNT = 3;
const SAMPLE_CHARS = 120;

/**
 * Per-speaker numbers that give the interviewer away: they ask most of the questions, talk less and
 * in shorter lines. Samples are spread across the transcript rather than taken from its start.
 */
export function speakerStats(data: TranscriptData): Map<string, SpeakerStats> {
  const bySpeaker = new Map<string, { lines: string[]; seconds: number; questions: number; words: number }>();
  for (const segment of data.segments) {
    const entry = bySpeaker.get(segment.speaker) ?? { lines: [], seconds: 0, questions: 0, words: 0 };
    const text = segment.text.trim();
    entry.lines.push(text);
    entry.seconds += Math.max(0, segment.end - segment.start);
    if (/\?["'”’)]*$/.test(text)) entry.questions++;
    entry.words += text.split(/\s+/).filter(Boolean).length;
    bySpeaker.set(segment.speaker, entry);
  }
  const out = new Map<string, SpeakerStats>();
  for (const [id, e] of bySpeaker) {
    const step = Math.max(1, Math.floor(e.lines.length / SAMPLE_COUNT));
    const samples = e.lines
      .filter((_, i) => i % step === 0)
      .slice(0, SAMPLE_COUNT)
      .map((t) => (t.length > SAMPLE_CHARS ? `${t.slice(0, SAMPLE_CHARS - 1)}…` : t));
    out.set(id, {
      lines: e.lines.length,
      seconds: e.seconds,
      questionShare: e.lines.length ? e.questions / e.lines.length : 0,
      wordsPerLine: e.lines.length ? e.words / e.lines.length : 0,
      samples,
    });
  }
  return out;
}
