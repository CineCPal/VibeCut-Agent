/**
 * Client notes (PLAN.md, "Phase 20c"): `read_client_notes` takes a client's notes, pasted as text with
 * times ("0:42 logo too small", "1:15-1:20 cut this", "01:00:42:10 ...", "1m15s", "at 42s") or left as
 * markers on the timeline, and places each one: the picture playing there, what's being said, and the
 * nearest cut. It only reads; the agent then makes the edits with the edit tools (reviewed as any edit
 * is), and marks a handled marker done by putting DONE_MARK before its name (update_marker), which keeps
 * the client's words and is the same in both editors.
 *
 * Times are read against the timeline: a SMPTE timecode, or an hours:minutes:seconds time, at or after
 * a timeline start such as 01:00:00:00 is taken as the timeline's own timecode; anything shorter
 * ("1:15", "42s") counts from the timeline's start, as a client watching an export sees it.
 */
import type { NleHost } from "../../types/nle";
import type { HostMarker, HostTimeline } from "../../types/timeline";
import { laneLines, type LaneLine } from "../../vibecut/lib/transcriptLane";
import { type Args, bool, clock, type Executor, optStr, type ToolFinding, type ToolOutcome } from "./args";
import { TIMELINE_NOUN } from "./edits";
import { timelineShots, type Shot } from "./pacingTools";
import { timecodeToFrames } from "./timecode";
import { heardView } from "./transcriptTools";
import type { ToolContext, ToolDeclaration } from "./tools";

/** Put before a marker's name once its note is handled; such markers are skipped unless asked for. */
export const DONE_MARK = "✓ ";
/** How far (seconds) from a note a line is still "what's being said" there. */
const NEAR_LINE = 3;
const MAX_TEXT = 100_000;
const round2 = (n: number) => Math.round(n * 100) / 100;

export interface ClientNote {
  /** Timeline seconds. */
  time: number;
  end?: number;
  text: string;
  /** The line (or marker) it came from, as written. */
  source: string;
  markerId?: string;
}

export interface ParsedNotes {
  notes: ClientNote[];
  /** Lines with no time: notes about the whole edit. */
  general: string[];
}

// One time: a SMPTE timecode, a clock time (m:ss or h:mm:ss, decimals allowed), or units (1h2m3s, 2 min
// 5 sec, 42s). Units need a lead-in (start of the note, "at", "@", "around") so "trim 2s" isn't a time.
const SMPTE = String.raw`\d{1,2}:\d{2}:\d{2}[:;]\d{2}`;
const CLOCK = String.raw`\d{1,2}(?::\d{2}){1,2}(?:\.\d+)?`;
const UNITS = String.raw`(?:\d+\s*h(?:ours?|rs?)?\s*)?(?:\d+\s*m(?:in(?:ute)?s?)?\s*)?(?:\d+(?:\.\d+)?\s*s(?:ec(?:ond)?s?)?)?`;
const RANGE = String.raw`\s*(?:-|–|—|to|until|thru|through)\s*`;
const LEAD = String.raw`^\s*(?:[-*•>]|#?\d+[.)]|#\d+)?\s*\[?\s*(?:(?:at|@|around|from|tc|timecode)\s*)?`;
const CLOCK_TIME = new RegExp(String.raw`(?<![\d:.])(${SMPTE}|${CLOCK})(?![\d:])(?:${RANGE}(${SMPTE}|${CLOCK})(?![\d:]))?`, "i");
const UNIT_TIME = new RegExp(String.raw`${LEAD}(${UNITS})\b(?:${RANGE}(${UNITS})\b)?`, "i");
// A range with one unit after it, for both ends: "12-15s", "1 to 2 min".
const BARE_RANGE = new RegExp(String.raw`${LEAD}(\d+(?:\.\d+)?)${RANGE}(\d+(?:\.\d+)?)\s*(s|secs?|seconds?|m|mins?|minutes?)\b`, "i");

/** Seconds from the timeline's start for one written time, or null when it isn't one. */
export function noteSeconds(written: string, view: Pick<HostTimeline, "fps" | "startTimecode">): number | null {
  const time = written.trim();
  const startFrames = timecodeToFrames(view.startTimecode, view.fps) ?? 0;
  const start = startFrames / view.fps;
  if (new RegExp(`^${SMPTE}$`).test(time)) {
    const frames = timecodeToFrames(time, view.fps);
    if (frames === null) return null;
    return round2((frames >= startFrames ? frames - startFrames : frames) / view.fps);
  }
  if (new RegExp(`^${CLOCK}$`).test(time)) {
    const parts = time.split(":").map(Number);
    if (parts.slice(1).some((p) => p >= 60)) return null;
    const seconds = parts.reduce((total, p) => total * 60 + p, 0);
    // h:mm:ss at or past an hour-or-later timeline start is the timeline's own timecode.
    if (parts.length === 3 && start >= 3600 && seconds >= start) return round2(seconds - start);
    return round2(seconds);
  }
  const units = /^(?:(\d+)\s*h(?:ours?|rs?)?\s*)?(?:(\d+)\s*m(?:in(?:ute)?s?)?\s*)?(?:(\d+(?:\.\d+)?)\s*s(?:ec(?:ond)?s?)?)?$/i.exec(time);
  if (!units || !(units[1] || units[2] || units[3])) return null;
  return round2(Number(units[1] ?? 0) * 3600 + Number(units[2] ?? 0) * 60 + Number(units[3] ?? 0));
}

/** The note's words: the line without its time, a list marker, a lead-in ("at") or the punctuation round them. */
function noteText(line: string, matched: string, at: number): string {
  const before = line
    .slice(0, at)
    .replace(/^\s*(?:[-*•>]|#?\d+[.)]|#\d+)(?=\s)/, "")
    .replace(/(?:\s|^)(?:at|around|from|tc|timecode)\s*\[?\s*$|@\s*\[?\s*$|\[\s*$/i, "");
  const after = line.slice(at + matched.length).replace(/^\s*\]/, "");
  return `${before} ${after}`
    .replace(/^[\s\]):,;|–—-]+/, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

/**
 * The notes in a client's text, one a line: a line with a time (leading, or a clock time anywhere in it)
 * is a note there; an indented line goes on with the note before it; any other line is a general note.
 */
export function parseClientNotes(text: string, view: Pick<HostTimeline, "fps" | "startTimecode">): ParsedNotes {
  const notes: ClientNote[] = [];
  const general: string[] = [];
  let last: ClientNote | undefined;
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) {
      last = undefined;
      continue;
    }
    const clock = CLOCK_TIME.exec(line);
    const bare = clock ? null : BARE_RANGE.exec(line);
    const unit = clock || bare ? null : UNIT_TIME.exec(line);
    const found = clock ?? bare ?? unit;
    const unitOf = bare ? bare[3] : "";
    const first = found?.[1] ? `${found[1].trim()}${unitOf}` : undefined;
    const time = first ? noteSeconds(first, view) : null;
    if (found && first && time !== null) {
      const second = found[2] ? `${found[2].trim()}${unitOf}` : undefined;
      const end = second ? noteSeconds(second, view) : null;
      const note: ClientNote = { time, ...(end !== null && end > time ? { end } : {}), text: noteText(line, found[0], found.index), source: line.trim() };
      notes.push(note);
      last = note;
    } else if (last && /^\s/.test(line)) {
      last.text = `${last.text} ${line.trim()}`.trim();
      last.source = `${last.source}\n${line.trim()}`;
    } else {
      general.push(line.trim());
      last = undefined;
    }
  }
  return { notes, general };
}

/** A marker's note: its name and its comment; a span when it lasts more than a frame. */
export function markerNote(marker: HostMarker, fps: number): ClientNote {
  const text = [marker.name, marker.note].map((s) => s?.trim()).filter(Boolean).join(" — ");
  return {
    time: round2(marker.time),
    ...(marker.duration > 1.5 / fps ? { end: round2(marker.time + marker.duration) } : {}),
    text,
    source: text,
    markerId: marker.id,
  };
}

export interface PlacedNote extends ClientNote {
  n: number;
  /** The picture playing at the note's time (the topmost switched-on video). */
  picture?: { clipId?: string; name?: string };
  /** Every clip under the note's time, by track. */
  under: { clipId: string; name: string; track: string }[];
  /** What's being said there (or just before or after, within NEAR_LINE seconds). */
  said?: { text: string; speaker: string; start: number; end: number; where: "at" | "before" | "after" };
  /** The nearest cut in the picture, and how far from the note (negative: before it). */
  nearestCut?: { time: number; offset: number };
  /** Why it can't be placed on the timeline, when it can't. */
  problem?: string;
}

const trackLabel = (type: string, index: number) => `${type === "video" ? "V" : "A"}${index}`;

/** Each note placed on the timeline: the picture, the clips and the words there, and the nearest cut. */
export function placeNotes(notes: ClientNote[], view: HostTimeline, shots: Shot[], lines: LaneLine[], noun = "timeline"): PlacedNote[] {
  const cuts = shots.slice(1).map((s) => s.start).filter((t, i, all) => i === 0 || t !== all[i - 1]);
  return notes.map((note, i) => {
    const placed: PlacedNote = { ...note, n: i + 1, under: [] };
    if (note.time > view.duration + 0.01) {
      placed.problem = `past the end of the ${noun} (${clock(view.duration)}): a different cut, or a timecode that counts from elsewhere`;
      return placed;
    }
    const at = note.time;
    const until = note.end ?? note.time;
    const shot = shots.find((s) => at >= s.start - 1e-3 && at < s.end - 1e-3) ?? shots.find((s) => Math.abs(at - s.end) < 1e-3);
    if (shot) placed.picture = { ...(shot.clipId ? { clipId: shot.clipId } : {}), ...(shot.name ? { name: shot.name } : {}) };
    for (const track of view.tracks) {
      for (const c of track.clips) {
        if (c.start <= until + 1e-3 && c.end > at + 1e-3) placed.under.push({ clipId: c.id, name: c.name, track: trackLabel(track.type, track.index) });
      }
    }
    const during = lines.filter((l) => l.start <= until + 0.25 && l.end >= at - 0.25);
    if (during.length) {
      placed.said = { text: during.map((l) => l.text).join(" "), speaker: during[0].speaker, start: round2(during[0].start), end: round2(during[during.length - 1].end), where: "at" };
    } else {
      const before = [...lines].reverse().find((l) => l.end < at && at - l.end <= NEAR_LINE);
      const after = lines.find((l) => l.start > until && l.start - until <= NEAR_LINE);
      const near = before && (!after || at - before.end <= after.start - until) ? { line: before, where: "before" as const } : after ? { line: after, where: "after" as const } : undefined;
      if (near) placed.said = { text: near.line.text, speaker: near.line.speaker, start: round2(near.line.start), end: round2(near.line.end), where: near.where };
    }
    if (cuts.length) {
      const nearest = cuts.reduce((best, t) => (Math.abs(t - at) < Math.abs(best - at) ? t : best), cuts[0]);
      placed.nearestCut = { time: round2(nearest), offset: round2(nearest - at) };
    }
    return placed;
  });
}

/** One placed note in words, for the summary and the chat's chips. */
export function describeNote(note: PlacedNote): string {
  const when = note.end !== undefined ? `${clock(note.time)}–${clock(note.end)}` : clock(note.time);
  if (note.problem) return `${note.n}. ${when} "${note.text}": ${note.problem}`;
  const parts = [`${note.n}. ${when} "${note.text}"`];
  if (note.picture?.name) parts.push(`on "${note.picture.name}"`);
  else parts.push("over black");
  if (note.said) parts.push(`${note.said.where === "at" ? "" : `just ${note.said.where}: `}${note.said.speaker ? `${note.said.speaker}: ` : ""}"${note.said.text}"`);
  if (note.nearestCut) parts.push(`nearest cut ${clock(note.nearestCut.time)} (${Math.abs(note.nearestCut.offset) < 0.05 ? "right there" : `${Math.abs(note.nearestCut.offset).toFixed(1)}s ${note.nearestCut.offset < 0 ? "before" : "after"}`})`);
  return parts.join(", ");
}

export function clientNotesToolDeclarations(host: NleHost): ToolDeclaration[] {
  const noun = TIMELINE_NOUN[host];
  return [
    {
      name: "read_client_notes",
      description: `Reads a client's review notes and places each on the connected ${noun} (or the draft): the picture playing there, every clip under it, what's being said (or just before or after), and the nearest cut. Give text (the notes as pasted: one a line, each with a time such as "0:42", "1:15-1:20", "01:00:42:10", "1m15s" or "at 42s"; an indented line goes on with the note above; a line with no time is a general note) or fromMarkers=true (the ${noun}'s markers as notes: name and comment; colors limits it to some marker colors; markers already marked done, their name starting "${DONE_MARK.trim()}", are skipped unless includeDone). Timecodes at or after the ${noun}'s start timecode (e.g. 01:00:00:00) are its own; shorter times count from its start. It only reads: then make the edits with the edit tools.`,
      parameters: {
        type: "OBJECT",
        properties: {
          text: { type: "STRING", description: "The notes as the client wrote them." },
          fromMarkers: { type: "BOOLEAN", description: `Use the ${noun}'s markers as the notes.` },
          colors: { type: "ARRAY", items: { type: "STRING" }, description: "With fromMarkers: only markers of these colors. Optional." },
          includeDone: { type: "BOOLEAN", description: `With fromMarkers: also markers marked done. Default false.` },
        },
      },
    },
  ];
}

export function clientNotesExecutors(context: ToolContext): Record<string, Executor> {
  return {
    read_client_notes: async (args: Args): Promise<ToolOutcome> => {
      const text = optStr(args, "text");
      const fromMarkers = bool(args, "fromMarkers");
      if (!text && !fromMarkers) throw new Error("Give text (the client's notes) or fromMarkers=true");
      if (text && fromMarkers) throw new Error("Give text or fromMarkers, not both");
      if (text && text.length > MAX_TEXT) throw new Error(`text is too long (over ${MAX_TEXT} characters)`);
      const colors = Array.isArray(args.colors) ? args.colors.filter((c): c is string => typeof c === "string").map((c) => c.toLowerCase()) : [];
      const heard = await heardView(context);
      const view = heard.view;
      const noun = TIMELINE_NOUN[context.host];

      let parsed: ParsedNotes;
      let skippedDone = 0;
      if (text) {
        parsed = parseClientNotes(text, view);
      } else {
        const markers = [...(view.markers ?? [])].sort((a, b) => a.time - b.time);
        const wanted = markers.filter((m) => !colors.length || colors.includes(m.color.toLowerCase()));
        const open = bool(args, "includeDone") ? wanted : wanted.filter((m) => !m.name.startsWith(DONE_MARK.trim()));
        skippedDone = wanted.length - open.length;
        parsed = { notes: open.map((m) => markerNote(m, view.fps)), general: [] };
      }
      parsed.notes.sort((a, b) => a.time - b.time);

      const lines = laneLines(heard.clips.heard, heard.transcripts, heard.clips.assetsById);
      const placed = placeNotes(parsed.notes, view, timelineShots(view), lines, noun);
      const notes: string[] = [];
      if (heard.untranscribed.length && placed.length) notes.push(`what's said is from the transcribed files only; not transcribed: ${heard.untranscribed.join(", ")}`);
      if (skippedDone) notes.push(`${skippedDone} marker(s) already marked done were skipped`);
      if (!placed.length && !parsed.general.length) {
        throw new Error(text ? "No notes found in the text: each note needs a time such as 0:42, 1:15-1:20 or 01:00:42:10" : `There are no ${skippedDone ? "open " : ""}markers on the ${noun}${colors.length ? ` in ${colors.join(", ")}` : ""}`);
      }

      const findings: ToolFinding[] = placed
        .filter((n) => !n.problem)
        .map((n) => ({ time: n.time, ...(n.end !== undefined ? { end: n.end } : {}), severity: "low", text: n.text || "(no words)", source: "client" }));
      const unplaced = placed.filter((n) => n.problem).length;
      const head = `${placed.length} client note(s) on "${view.timeline}"${parsed.general.length ? ` and ${parsed.general.length} general` : ""}${unplaced ? ` (${unplaced} can't be placed)` : ""}`;
      return {
        summary: [head, ...placed.map(describeNote), ...parsed.general.map((g) => `general: "${g}"`)].join("\n"),
        result: { from: text ? "text" : "markers", notes: placed, general: parsed.general, ...(notes.length ? { remarks: notes } : {}) },
        findings,
      };
    },
  };
}

/** The ground rule the system prompt gains (Phase 20c). */
export const CLIENT_NOTES_INSTRUCTION = `- Client notes: when the user pastes a client's notes, or asks to go through the client's markers,
  read_client_notes first (text, or fromMarkers), then work through them in order with the edit tools.
  Do the clear ones; for a note that's a matter of taste ("make it pop") or unclear, propose what you'd
  do and ask. When a note came from a marker and is handled, update_marker its name to start with
  "${DONE_MARK.trim()} " (keep the client's words). End with a checklist: done, needs the user, couldn't be done and why.`;
