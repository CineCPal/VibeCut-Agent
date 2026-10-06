/**
 * What the Story Editor is sent (PLAN.md, "Phase 6d"): VibeCut's src/lib/storyEditorContext.ts, verbatim
 * apart from how sources are gathered. VibeCut read every project asset's loaded transcript
 * (`gatherProjectTranscripts`, tied to its media and transcript stores); here `storySourceOf` builds one
 * source from one file's transcript (transcript.rs), the way its connected-editor `vibeCutStorySource`
 * did, but keeping the speaker roles so the interviewer can be left out. Its Spyglass/analyzer catalog
 * merge (`buildBrollCatalog`) isn't needed: the agent's catalog comes from the project or the Library.
 */
import type { TranscriptData } from "../types/transcript";
import type { StoryBrollCatalogEntry } from "../types/storyEditor";
import { resolveSpeaker, speakerTag } from "./speakers";

/** One video with a transcript, ready to send as a Story Editor source. */
export interface StoryTranscriptSource {
  sourceId: string;
  mediaPath: string;
  fileName: string;
  /** `speaker` is the display name, or "Interviewer (Ana)" for an interviewer (see `speakerTag`). */
  segments: StorySegment[];
}

export interface StorySegment {
  start: number;
  end: number;
  text: string;
  speaker: string;
  /** Set on the interviewer's lines, so they can be left out of the story. */
  interviewer?: boolean;
}

/** One file's transcript as a Story Editor source: speakers named, the interviewer's lines marked (a
 * speaker switched off in the transcriber counts as the interviewer, as `resolveSpeaker` reads it).
 * Null when the transcript has no lines. */
export function storySourceOf(data: TranscriptData, mediaPath: string, sourceId: string): StoryTranscriptSource | null {
  if (data.segments.length === 0) return null;
  return {
    sourceId,
    mediaPath,
    fileName: mediaPath.split(/[\\/]/).pop() || mediaPath,
    segments: data.segments.map((s) => {
      const who = resolveSpeaker(data, s.speaker);
      return { start: s.start, end: s.end, text: s.text, speaker: speakerTag(who), ...(who.role === "interviewer" ? { interviewer: true } : {}) };
    }),
  };
}

/**
 * The sources without the interviewer's lines (see PLAN.md, "Speaker roles"): a rough cut is built
 * from the answers. A source left with nothing is dropped.
 */
export function withoutInterviewer(sources: StoryTranscriptSource[]): StoryTranscriptSource[] {
  return sources
    .map((s) => (s.segments.some((seg) => seg.interviewer) ? { ...s, segments: s.segments.filter((seg) => !seg.interviewer) } : s))
    .filter((s) => s.segments.length > 0);
}

/** Whether a brief asks for the interviewer's lines ("keep the questions", "include the interviewer"). */
export function briefWantsInterviewer(brief: string): boolean {
  return /\b(questions|interviewer|interviewer's|q\s*&\s*a|q and a)(?![\w'])/i.test(brief);
}

/** A source's segments as the assemble command reads them (no app-only fields). */
export function payloadSegments(source: StoryTranscriptSource): { start: number; end: number; text: string; speaker: string }[] {
  return source.segments.map(({ start, end, text, speaker }) => ({ start, end, text, speaker }));
}

/** How many transcript lines a Story Editor request will send, total across every source. */
export function totalSegmentCount(sources: StoryTranscriptSource[]): number {
  return sources.reduce((sum, s) => sum + s.segments.length, 0);
}

/** The most transcript lines one Story Editor request sends, so a whole set of interviews can't
 * silently balloon a single model call past what's reasonable to send or reason over. Sources are
 * trimmed evenly from the end of each one's segment list until the total fits — never dropped as
 * whole sources, so every video still contributes something. */
export const MAX_STORY_SEGMENTS = 2000;

export interface CappedTranscripts {
  sources: StoryTranscriptSource[];
  /** True when segments had to be dropped to fit MAX_STORY_SEGMENTS. */
  truncated: boolean;
}

export function capTranscripts(sources: StoryTranscriptSource[], limit = MAX_STORY_SEGMENTS): CappedTranscripts {
  const total = totalSegmentCount(sources);
  if (total <= limit) return { sources, truncated: false };

  // Trim every source by the same proportion, so one very long transcript doesn't crowd out every
  // other video's lines entirely; each source keeps at least its first line.
  const scale = limit / total;
  const trimmed = sources.map((s) => ({
    ...s,
    segments: s.segments.slice(0, Math.max(1, Math.floor(s.segments.length * scale))),
  }));
  return { sources: trimmed, truncated: true };
}

/** How many B-roll catalog entries one Story Editor request sends. */
export const MAX_STORY_CATALOG_ENTRIES = 500;

export interface CappedCatalog {
  entries: StoryBrollCatalogEntry[];
  /** True when entries had to be dropped to fit MAX_STORY_CATALOG_ENTRIES. */
  truncated: boolean;
}

/** Trims the catalog to `limit` entries, keeping captioned entries over uncaptioned (filename-only)
 * ones first — a captioned entry carries far more signal per token. */
export function capCatalog(entries: StoryBrollCatalogEntry[], limit = MAX_STORY_CATALOG_ENTRIES): CappedCatalog {
  if (entries.length <= limit) return { entries, truncated: false };
  const sorted = [...entries].sort((a, b) => Number(b.caption !== null) - Number(a.caption !== null));
  return { entries: sorted.slice(0, limit), truncated: true };
}
