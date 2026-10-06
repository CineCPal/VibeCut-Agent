import type { MediaAsset, SpeakerRole } from "../types/media";
import type { TranscriptData, TranscriptWord } from "../types/transcript";
import type { Clip } from "../types/timeline";
import { resolveSpeaker, type ResolvedSpeaker } from "./speakers";
import { timelineAt } from "./timeRemap";
import { mergeRanges, type TimeRange } from "./timeline";

/** A stretch of speech shorter than this on the timeline (for example the last sliver of a trimmed clip) is not shown. */
const MIN_VISIBLE_SECONDS = 0.1;

/** One line of a transcript as it sits on the timeline. */
export interface LaneLine {
  /** Stable for the same line at the same place; changes when the clip it sits on moves or is trimmed. */
  id: string;
  assetId: string;
  /** Timeline seconds. */
  start: number;
  end: number;
  text: string;
  /** The speaker's display name (VibeCut's name, else the transcriber's label, else the id). */
  speaker: string;
  /** The transcript's own speaker id ("Speaker 1"). */
  speakerId: string;
  /** The speaker's role, when one is set or guessed (see `resolveSpeaker`). */
  role?: SpeakerRole;
  /** True when that role is a guess the user has not confirmed. */
  roleInferred?: boolean;
  /** True when only part of the spoken line is on the timeline (its clip was trimmed or split). */
  partial: boolean;
  /** The line's words in timeline seconds (only those whose middle is on the timeline, clamped to
   * the visible part), when the transcript has word timings. */
  words?: TranscriptWord[];
}

/**
 * The transcript lines that are on the timeline, in time order. Each line of a transcript is mapped
 * from the source file's time to the timeline through every clip of that file (`sourceIn`,
 * `sourceOut`, `startTime`), so a trimmed or split clip shows only what it still contains and a file
 * used twice shows its lines twice. A video clip and the audio clip linked to it cover the same
 * stretch, so their line is shown once. Lines of speakers the transcriber excluded are kept (their
 * sound is still on the timeline) and carry the interviewer role, so they can be seen and cut.
 *
 * With `assetsById`, a synced recording's clip is skipped when it is linked to a camera clip that
 * shows a transcript: that transcript is the recording's own, shifted into camera time (see
 * `transcriptFor`), so the recording would only repeat every line under a different file.
 */
export function laneLines(
  clipsById: Record<string, Clip>,
  transcriptsByAssetId: Record<string, TranscriptData | undefined>,
  assetsById?: Record<string, MediaAsset>,
): LaneLine[] {
  const lines = new Map<string, LaneLine>();
  const covered = assetsById ? recordingsCoveredByPicture(clipsById, transcriptsByAssetId, assetsById) : new Set<string>();
  for (const clip of Object.values(clipsById)) {
    const transcript = transcriptsByAssetId[clip.mediaAssetId];
    if (!transcript || covered.has(clip.id)) continue;
    const speakers = new Map<string, ResolvedSpeaker>();
    const speakerOf = (id: string) => {
      let resolved = speakers.get(id);
      if (!resolved) {
        resolved = resolveSpeaker(transcript, id);
        speakers.set(id, resolved);
      }
      return resolved;
    };
    transcript.segments.forEach((segment, index) => {
      const from = Math.max(segment.start, clip.sourceIn);
      const to = Math.min(segment.end, clip.sourceOut);
      if (to - from < MIN_VISIBLE_SECONDS) return;
      const start = timelineAt(clip, from);
      const end = timelineAt(clip, to);
      const id = `${clip.mediaAssetId}|${index}|${Math.round(start * 1000)}|${Math.round(end * 1000)}`;
      if (lines.has(id)) return;
      const toTimeline = (t: number) => timelineAt(clip, t);
      const words = segment.words
        ?.filter((w) => {
          const mid = (w.start + w.end) / 2;
          return mid >= from && mid < to;
        })
        .map((w) => ({ start: toTimeline(Math.max(w.start, from)), end: toTimeline(Math.min(w.end, to)), text: w.text }));
      lines.set(id, {
        id,
        assetId: clip.mediaAssetId,
        start,
        end,
        text: segment.text,
        ...speakerFields(speakerOf(segment.speaker)),
        partial: from > segment.start || to < segment.end,
        ...(words && words.length ? { words } : {}),
      });
    });
  }
  return [...lines.values()].sort((a, b) => a.start - b.start || a.end - b.end || a.id.localeCompare(b.id));
}

function speakerFields(s: ResolvedSpeaker): Pick<LaneLine, "speaker" | "speakerId" | "role" | "roleInferred"> {
  return { speaker: s.name, speakerId: s.id, ...(s.role ? { role: s.role, roleInferred: s.inferred } : {}) };
}

/** Clips of synced recordings whose link group has the camera clip they are synced to, with a transcript. */
function recordingsCoveredByPicture(
  clipsById: Record<string, Clip>,
  transcriptsByAssetId: Record<string, TranscriptData | undefined>,
  assetsById: Record<string, MediaAsset>,
): Set<string> {
  const groups = new Map<string, Clip[]>();
  for (const clip of Object.values(clipsById)) {
    if (clip.linkId) groups.set(clip.linkId, [...(groups.get(clip.linkId) ?? []), clip]);
  }
  const covered = new Set<string>();
  for (const members of groups.values()) {
    const syncedHere = new Set(
      members.flatMap((m) => (transcriptsByAssetId[m.mediaAssetId] ? (assetsById[m.mediaAssetId]?.syncedAudio ?? []) : []).map((s) => s.assetId)),
    );
    for (const m of members) if (syncedHere.has(m.mediaAssetId)) covered.add(m.id);
  }
  return covered;
}

/** A row for each line so that lines overlapping in time (two files with transcripts, one over the other) do not overlap on screen. Same order as `lines`. */
export function packRows(lines: LaneLine[]): number[] {
  const rowEnds: number[] = [];
  return lines.map((line) => {
    let row = rowEnds.findIndex((end) => end <= line.start + 1e-6);
    if (row < 0) row = rowEnds.length;
    rowEnds[row] = line.end;
    return row;
  });
}

/** The line being spoken at `time` (start inclusive, end exclusive), preferring the one that started last. */
export function lineAt(lines: LaneLine[], time: number): LaneLine | null {
  let found: LaneLine | null = null;
  for (const line of lines) {
    if (line.start > time) break;
    if (time < line.end) found = line;
  }
  return found;
}

/** Lines whose text contains every word of the query, ignoring case. An empty query matches nothing. */
export function searchLines(lines: LaneLine[], query: string): LaneLine[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];
  return lines.filter((line) => {
    const text = line.text.toLowerCase();
    return words.every((word) => text.includes(word));
  });
}

/** The ids of the lines from `anchorId` to `targetId` inclusive, in time order (just the target if the anchor is gone). */
export function lineRange(lines: LaneLine[], anchorId: string | null, targetId: string): string[] {
  const to = lines.findIndex((l) => l.id === targetId);
  if (to < 0) return [];
  const from = anchorId ? lines.findIndex((l) => l.id === anchorId) : -1;
  if (from < 0) return [targetId];
  const [lo, hi] = from <= to ? [from, to] : [to, from];
  return lines.slice(lo, hi + 1).map((l) => l.id);
}

/** The timeline ranges of the given lines, for cutting them out. */
export function rangesOfLines(lines: LaneLine[], ids: readonly string[]): TimeRange[] {
  const wanted = new Set(ids);
  return lines.filter((l) => wanted.has(l.id)).map((l) => ({ start: l.start, end: l.end }));
}

/** Speech kept at each side of a speaker cut, so the neighbouring answer is not clipped. */
export const SPEAKER_CUT_HANDLE_SECONDS = 0.2;
/** A pause longer than this next to a cut line is left alone (it may be action, not dead air). */
export const SPEAKER_CUT_MAX_GAP_SECONDS = 3;

/**
 * The timeline ranges to cut to remove the `cut` lines as a whole speaker's turns, not just their
 * words: each cut also takes the pause between it and the kept lines on either side (up to
 * `SPEAKER_CUT_MAX_GAP_SECONDS`, leaving `SPEAKER_CUT_HANDLE_SECONDS`), so dropping a question closes
 * up to the answers around it. Kept lines are never cut into, even where they overlap a cut line
 * (people talking over each other).
 */
export function speakerCutRanges(lines: LaneLine[], cut: (line: LaneLine) => boolean): TimeRange[] {
  const kept = mergeRanges(lines.filter((l) => !cut(l)).map((l) => ({ start: l.start, end: l.end })));
  const wide = lines.filter(cut).map((line) => {
    let start = line.start;
    let end = line.end;
    const earlier = kept.filter((k) => k.end <= line.start);
    const before = earlier[earlier.length - 1];
    const after = kept.find((k) => k.start >= line.end);
    if (before && line.start - before.end <= SPEAKER_CUT_MAX_GAP_SECONDS) start = Math.min(start, before.end + SPEAKER_CUT_HANDLE_SECONDS);
    if (after && after.start - line.end <= SPEAKER_CUT_MAX_GAP_SECONDS) end = Math.max(end, after.start - SPEAKER_CUT_HANDLE_SECONDS);
    return { start, end };
  });
  // Subtract the kept speech from the (merged) cuts.
  const out: TimeRange[] = [];
  for (const range of mergeRanges(wide)) {
    let from = range.start;
    for (const k of kept) {
      if (k.end <= from || k.start >= range.end) continue;
      if (k.start > from) out.push({ start: from, end: k.start });
      from = Math.max(from, k.end);
    }
    if (from < range.end) out.push({ start: from, end: range.end });
  }
  return out.filter((r) => r.end - r.start > 1e-6);
}
