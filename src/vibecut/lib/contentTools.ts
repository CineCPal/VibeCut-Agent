/**
 * The pure half of VibeCut's src/lib/chatContentTools.ts, verbatim (PLAN.md, "Phase 6b"): the transcript
 * line tools over a `LineTarget` (get_transcript, search_transcript, remove_transcript_lines,
 * remove_speaker_lines, find_filler_words), and the speaker and silence helpers. The half tied to
 * VibeCut's editor stores (its own timeline's lines, list_speakers, set_speaker_roles, find_silences) is
 * left out; VibeCut Agent's adapters are in src/lib/agent/transcriptTools.ts.
 */
import { SPEAKER_ROLES, type SpeakerInfo, type SpeakerRole } from "../types/media";
import { bool, clock, optNum, optStr, round2, strArray, type Args, type ChatToolOutcome, type Executor } from "./chatArgs";
import { DEFAULT_SILENCE_OPTIONS, findSilentRanges, type AudibleClip, type SilenceOptions } from "./silence";
import type { TimeRange } from "./timeline";
import { rangesOfLines, searchLines, speakerCutRanges, type LaneLine } from "./transcriptLane";
import { DEFAULT_FILLERS, findPhrase, phraseTokens } from "./wordMatch";

// Tools that let the agent hear the edit: what is said (transcripts) and where nothing is (silence).
// Lines always have timings; single words only do when the transcriber recorded them (transcripts
// made before it did need transcribe_media with force to gain them).

const DEFAULT_TRANSCRIPT_LIMIT = 200;
const MAX_TRANSCRIPT_LIMIT = 500;
const MAX_SEARCH_MATCHES = 50;

/** The transcript lines on a timeline, plus the names of its media with no transcript. */
export interface LineSource {
  lines: LaneLine[];
  untranscribed: string[];
}

/**
 * Where the line tools read from and cut: VibeCut's own timeline, or a connected editor's timeline
 * through its draft (lib/connect/hostTranscripts.ts). `remove` cuts the ranges and closes the gaps;
 * `fix` names the tool call that transcribes (`force: true` adds word timings).
 */
export interface LineTarget {
  lines: () => Promise<LineSource>;
  remove: (cut: TimeRange[]) => Promise<{ removedSeconds: number; note?: string; result?: Record<string, unknown> }>;
  fix: string;
}

const rangeOut = (r: { start: number; end: number }) => ({ start: round2(r.start), end: round2(r.end) });

const lineOut = (l: LaneLine, withWords = false) => ({
  id: l.id,
  start: round2(l.start),
  end: round2(l.end),
  speaker: l.speaker,
  ...(l.role ? { role: l.role, ...(l.roleInferred ? { roleGuessed: true } : {}) } : {}),
  text: l.text,
  ...(l.partial ? { partial: true } : {}),
  ...(withWords && l.words ? { words: l.words.map((w) => ({ ...rangeOut(w), text: w.text })) } : {}),
});

/** A note when some lines have no word timings, so the model knows single-word cuts won't reach them. */
function wordCoverageNote(lines: LaneLine[], fix: string): string {
  const without = lines.filter((l) => !l.words).length;
  if (without === 0) return "";
  return without === lines.length
    ? ` No line has word timings (transcribed before they were recorded) — ${fix} with force: true adds them.`
    : ` ${without} of ${lines.length} line(s) have no word timings — ${fix} with force: true on their files adds them.`;
}

const untranscribedNote = (names: string[], fix: string) =>
  names.length
    ? ` ${names.length} file(s) on the timeline have no transcript (${names.slice(0, 5).join(", ")}${names.length > 5 ? ", …" : ""}); ${fix} makes them.`
    : "";

const getTranscript = (target: LineTarget): Executor => async (args) => {
  const { lines, untranscribed } = await target.lines();
  const from = optNum(args, "startTime") ?? -Infinity;
  const to = optNum(args, "endTime") ?? Infinity;
  const speaker = optStr(args, "speaker")?.toLowerCase();
  const role = optRole(args);
  const filtered = lines.filter(
    (l) => l.end > from && l.start < to && (!speaker || l.speaker.toLowerCase() === speaker) && (!role || roleMatches(l, role)),
  );
  const offset = Math.max(0, Math.floor(optNum(args, "offset") ?? 0));
  const limit = Math.min(MAX_TRANSCRIPT_LIMIT, Math.max(1, Math.floor(optNum(args, "limit") ?? DEFAULT_TRANSCRIPT_LIMIT)));
  const page = filtered.slice(offset, offset + limit);
  const nextOffset = offset + page.length < filtered.length ? offset + page.length : null;
  const withWords = bool(args, "includeWords");
  return {
    summary: `Read ${page.length} of ${filtered.length} transcript line(s).${untranscribedNote(untranscribed, target.fix)}`,
    result: { lines: page.map((l) => lineOut(l, withWords)), total: filtered.length, nextOffset, untranscribedFiles: untranscribed },
  };
};

const searchTranscript = (target: LineTarget): Executor => async (args) => {
  const query = optStr(args, "query");
  if (!query) throw new Error("query must be a non-empty string");
  const { lines, untranscribed } = await target.lines();
  const matches = searchLines(lines, query);
  const tokens = phraseTokens(query);
  // Where the query occurs word for word inside a line, its exact span — so a phrase can be cut
  // without losing the rest of the line.
  const out = matches.slice(0, MAX_SEARCH_MATCHES).map((l) => {
    const phraseRanges = l.words ? findPhrase(l.words, tokens).map(rangeOut) : [];
    return { ...lineOut(l), ...(phraseRanges.length ? { phraseRanges } : {}) };
  });
  return {
    summary: `Found ${matches.length} transcript line(s) matching "${query.slice(0, 40)}".${untranscribedNote(untranscribed, target.fix)}`,
    result: { matches: out, total: matches.length, untranscribedFiles: untranscribed },
  };
};

const removeTranscriptLines = (target: LineTarget): Executor => async (args) => {
  const lineIds = strArray(args, "lineIds");
  if (lineIds.length === 0) throw new Error("lineIds must not be empty");
  const { lines } = await target.lines();
  const known = new Set(lines.map((l) => l.id));
  const stale = lineIds.filter((id) => !known.has(id));
  if (stale.length) {
    // Line ids encode where a line sits on the timeline, so any earlier cut changes them.
    throw new Error(
      `${stale.length} of ${lineIds.length} line id(s) are not on the timeline any more (an earlier edit moved them). Call get_transcript or search_transcript again for current ids.`,
    );
  }
  const cut = rangesOfLines(lines, lineIds);
  const { removedSeconds, note, result } = await target.remove(cut);
  return {
    summary: `Cut ${lineIds.length} transcript line(s), ${clock(removedSeconds)} in total${note ?? ""}.`,
    result: { removedSeconds: round2(removedSeconds), ranges: cut.map((r) => ({ start: round2(r.start), end: round2(r.end) })), ...result },
  };
};

/** A role filter: one of SPEAKER_ROLES, or "none" for speakers with no role. */
type RoleFilter = SpeakerRole | "none";

export function optRole(args: Args): RoleFilter | undefined {
  const value = optStr(args, "role");
  if (value === undefined) return undefined;
  if (value === "none" || SPEAKER_ROLES.includes(value as SpeakerRole)) return value as RoleFilter;
  throw new Error(`role must be one of: ${[...SPEAKER_ROLES, "none"].join(", ")}`);
}

export const roleMatches = (l: LaneLine, role: RoleFilter) => (role === "none" ? !l.role : l.role === role);

/** The role and name of one `set_speaker_roles` entry, checked. */
export function speakerEntry(e: Args, i: number): { role?: SpeakerRole; name?: string } {
  const role = optStr(e, "role");
  if (role !== undefined && !SPEAKER_ROLES.includes(role as SpeakerRole)) throw new Error(`speakers[${i}].role must be one of: ${SPEAKER_ROLES.join(", ")}`);
  return { role: role as SpeakerRole | undefined, name: optStr(e, "name") };
}

/** A speaker's info after a `set_speaker_roles` entry, or null when it would replace a role the user
 * set: only something the user said in this conversation replaces that. */
export function nextSpeakerInfo(current: SpeakerInfo, role: SpeakerRole | undefined, name: string | undefined, confirmed: boolean): SpeakerInfo | null {
  if (role && current.role && !current.inferred && !confirmed && current.role !== role) return null;
  const next: SpeakerInfo = { ...current, ...(name ? { name } : {}) };
  if (role) {
    next.role = role;
    next.inferred = !confirmed;
  }
  return next;
}

export function speakerRolesOutcome(done: string[], kept: string[], claimed: boolean, confirmed: boolean): ChatToolOutcome {
  return {
    summary: done.length ? `Set speaker ${done.join(", ")}.` : "No speaker roles changed.",
    result: {
      updated: done.length,
      ...(claimed && !confirmed
        ? { confirmationIgnored: "The user's messages don't say who is who, so these were saved as guesses." }
        : {}),
      ...(kept.length
        ? {
            keptUserRoles: kept,
            note: "The user set these roles; they stay. If the transcript suggests they are wrong, make no cut by them: tell the user what you see and ask them to confirm or swap them.",
          }
        : {}),
    },
  };
}

const removeSpeakerLines = (target: LineTarget): Executor => async (args) => {
  const role = optRole(args);
  const speaker = optStr(args, "speaker")?.toLowerCase();
  if (!role && !speaker) throw new Error("Give role or speaker");
  const from = optNum(args, "startTime") ?? -Infinity;
  const to = optNum(args, "endTime") ?? Infinity;
  const keep = new Set(args["keepLineIds"] === undefined ? [] : strArray(args, "keepLineIds"));
  const { lines } = await target.lines();
  const matches = (l: LaneLine) =>
    l.start >= from - 1e-6 && l.end <= to + 1e-6 && !keep.has(l.id) && (!role || roleMatches(l, role)) && (!speaker || l.speaker.toLowerCase() === speaker);
  const matched = lines.filter(matches);
  if (matched.length === 0) {
    const roles = [...new Set(lines.map((l) => l.role ?? "none"))];
    throw new Error(`No transcript lines on the timeline match (roles present: ${roles.join(", ") || "none"}). Set roles with set_speaker_roles first.`);
  }
  const cut = speakerCutRanges(lines, matches).map((r) => ({ start: Math.max(r.start, from), end: Math.min(r.end, to) }));
  const { removedSeconds, note, result } = await target.remove(cut);
  const who = role ?? matched[0].speaker;
  return {
    summary: `Cut ${matched.length} ${who} line(s), ${clock(removedSeconds)} in total${note ?? ""}.`,
    result: { removedLines: matched.length, removedSeconds: round2(removedSeconds), ranges: cut.map(rangeOut), ...result },
  };
};

const MAX_FILLER_RESULTS = 300;

/** Finds filler words (or any words/phrases asked for) by their word timings, across the timeline. */
const findFillerWords = (target: LineTarget): Executor => async (args: Args) => {
  const requested = args["fillers"] === undefined ? DEFAULT_FILLERS : strArray(args, "fillers");
  const phrases = requested.map(phraseTokens).filter((t) => t.length > 0);
  if (phrases.length === 0) throw new Error("fillers must contain at least one word");
  const from = optNum(args, "startTime") ?? -Infinity;
  const to = optNum(args, "endTime") ?? Infinity;
  const { lines, untranscribed } = await target.lines();
  const inWindow = lines.filter((l) => l.end > from && l.start < to);

  const occurrences: { text: string; start: number; end: number; lineId: string }[] = [];
  for (const line of inWindow) {
    if (!line.words) continue;
    for (const tokens of phrases) {
      for (const r of findPhrase(line.words, tokens)) {
        if (r.start >= from && r.end <= to) occurrences.push({ text: tokens.join(" "), start: r.start, end: r.end, lineId: line.id });
      }
    }
  }
  occurrences.sort((a, b) => a.start - b.start);
  const total = occurrences.reduce((sum, o) => sum + (o.end - o.start), 0);
  const counts: Record<string, number> = {};
  for (const o of occurrences) counts[o.text] = (counts[o.text] ?? 0) + 1;
  return {
    summary: `Found ${occurrences.length} filler word(s), ${clock(total)} in total.${wordCoverageNote(inWindow, target.fix)}${untranscribedNote(untranscribed, target.fix)}`,
    result: {
      occurrences: occurrences.slice(0, MAX_FILLER_RESULTS).map((o) => ({ ...o, ...rangeOut(o) })),
      total: occurrences.length,
      counts,
      linesWithoutWordTimings: inWindow.filter((l) => !l.words).length,
      untranscribedFiles: untranscribed,
    },
  };
};

/** find_silences' options, checked. */
export function silenceOptions(args: Args): SilenceOptions {
  const options = {
    minDurationSeconds: optNum(args, "minDurationSeconds") ?? DEFAULT_SILENCE_OPTIONS.minDurationSeconds,
    thresholdDb: optNum(args, "thresholdDb") ?? DEFAULT_SILENCE_OPTIONS.thresholdDb,
    handleSeconds: optNum(args, "handleSeconds") ?? DEFAULT_SILENCE_OPTIONS.handleSeconds,
    startTime: optNum(args, "startTime"),
    endTime: optNum(args, "endTime"),
  };
  if (options.minDurationSeconds <= 0) throw new Error("minDurationSeconds must be greater than 0");
  if (options.thresholdDb >= 0) throw new Error("thresholdDb must be negative (dBFS), e.g. -40");
  return options;
}

/** The silent stretches over the clips that are heard, as find_silences reports them. */
export function silencesOutcome(audible: AudibleClip[], options: SilenceOptions, failures: string[]): ChatToolOutcome {
  const silences = findSilentRanges(audible, options);
  const total = silences.reduce((sum, r) => sum + (r.end - r.start), 0);
  return {
    summary: `Found ${silences.length} silent stretch(es), ${clock(total)} in total${failures.length ? ` (${failures.length} file(s) could not be measured)` : ""}.`,
    result: {
      silences: silences.map((r) => ({ start: round2(r.start), end: round2(r.end) })),
      totalSeconds: round2(total),
      unmeasuredFiles: failures,
    },
  };
}

/** The tools that read lines and cut by them, for one timeline. */
export function lineExecutors(target: LineTarget): Record<string, Executor> {
  return {
    get_transcript: getTranscript(target),
    search_transcript: searchTranscript(target),
    remove_transcript_lines: removeTranscriptLines(target),
    remove_speaker_lines: removeSpeakerLines(target),
    find_filler_words: findFillerWords(target),
  };
}
