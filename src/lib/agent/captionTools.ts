/**
 * Captions on the connected timeline (PLAN.md, "Phase 15a"), ported from VibeCut's hostCaptions.ts (its
 * "13h", probed live there):
 *
 * - Resolve: `Timeline.CreateSubtitlesFromAudio`, Resolve's own transcription onto a subtitle track
 *   (Studio; about 40 s for 30 s of speech). Placing an SRT on a subtitle track through
 *   `AppendToTimeline` crashed Resolve in the probe, so it isn't used.
 * - Premiere: the transcripts of what is heard on the sequence as SRT cues, imported and made a caption
 *   track with `Sequence.createCaptionTrack`. Premiere's scripting can't remove a caption track, so a
 *   revert says to delete it there.
 *
 * Both are direct edits: a backup first, the edit log, and Revert (which removes Resolve's subtitles).
 * Titles aren't offered: neither editor sets a title's text from a script in a usable way.
 */
import type { NleHost } from "../../types/nle";
import type { LaneLine } from "../../vibecut/lib/transcriptLane";
import { type Executor, optNum, optStr } from "./args";
import { refuseWhileDrafting } from "./draft";
import { edit, TIMELINE_NOUN } from "./edits";
import { heardLines } from "./transcriptTools";
import type { ToolContext, ToolDeclaration } from "./tools";

export interface Cue {
  start: number;
  end: number;
  text: string;
}

/** Caption cues from transcript lines (VibeCut's, verbatim): each line split into cues of at most
 * `maxChars` characters (whole words), timed by its words when it has them, else in proportion to their
 * length. */
export function captionCues(lines: LaneLine[], maxChars: number): Cue[] {
  const cues: Cue[] = [];
  for (const line of [...lines].sort((a, b) => a.start - b.start)) {
    const words = line.words?.length ? line.words.map((w) => ({ text: w.text.trim(), start: w.start, end: w.end })) : null;
    const tokens = words ?? line.text.trim().split(/\s+/).map((text) => ({ text, start: NaN, end: NaN }));
    let group: typeof tokens = [];
    const flush = () => {
      if (!group.length) return;
      const text = group.map((t) => t.text).join(" ");
      cues.push({ start: group[0].start, end: group[group.length - 1].end, text });
      group = [];
    };
    for (const token of tokens) {
      if (!token.text) continue;
      const length = group.map((t) => t.text).join(" ").length;
      if (group.length && length + 1 + token.text.length > maxChars) flush();
      group.push(token);
    }
    flush();
    if (!words) {
      // Spread the line's time over its cues by their length.
      const mine = cues.filter((c) => Number.isNaN(c.start));
      const total = mine.reduce((n, c) => n + c.text.length, 0) || 1;
      let at = line.start;
      for (const cue of mine) {
        cue.start = at;
        at += ((line.end - line.start) * cue.text.length) / total;
        cue.end = at;
      }
    }
  }
  const round3 = (n: number) => Math.round(n * 1000) / 1000;
  return cues.filter((c) => c.end > c.start).map((c) => ({ start: round3(c.start), end: round3(c.end), text: c.text }));
}

export function captionToolDeclarations(host: NleHost): ToolDeclaration[] {
  const resolve = host === "resolve";
  return [
    {
      name: "create_captions",
      description: resolve
        ? "Adds captions for what is said on the open timeline: Resolve's own transcription makes a subtitle track (Resolve Studio; takes about as long as the audio plays, or longer), in `language`, with charsPerLine and 1 or 2 lines per subtitle. The timeline must be the one open in Resolve. Revert removes the subtitles. Titles can't be made from a script: tell the user to add them by hand."
        : "Adds captions for what is said on the open sequence: the transcripts of the heard clips (transcribe_clips first) become a caption track, cues of at most charsPerLine characters. Premiere's scripting can't remove a caption track, so to undo it the user deletes it in Premiere (say so). Titles can't be made from a script: tell the user to add them by hand.",
      parameters: {
        type: "OBJECT",
        properties: {
          charsPerLine: { type: "NUMBER", description: "10 to 60. Default 42." },
          ...(resolve
            ? {
                lines: { type: "NUMBER", description: "1 or 2 lines per subtitle. Default 1." },
                language: { type: "STRING", description: '"auto" (default), "english", "spanish", "french", "german", "italian", "portuguese", "japanese", "korean", "chinese"...' },
              }
            : { name: { type: "STRING", description: 'The captions\' project item name. Default "<sequence> captions".' } }),
        },
      },
    },
  ];
}

export function captionExecutors(context: ToolContext): Record<string, Executor> {
  const { host } = context;
  return {
    create_captions: async (args) => {
      refuseWhileDrafting(host, "add captions (send the draft first, then caption the new one)");
      const timeline = context.timeline;
      if (!timeline) throw new Error(`No ${TIMELINE_NOUN[host]} is open`);
      const ctx = { host, timeline, step: context.step, stepText: context.stepText };
      const maxChars = optNum(args, "charsPerLine") ?? 42;
      if (!Number.isInteger(maxChars) || maxChars < 10 || maxChars > 60) throw new Error("charsPerLine must be a whole number from 10 to 60");
      if (host === "resolve") {
        const language = optStr(args, "language") ?? "auto";
        const lines = optNum(args, "lines") ?? 1;
        if (lines !== 1 && lines !== 2) throw new Error("lines must be 1 or 2");
        return edit(ctx, "create_captions", "create_captions", { language, charsPerLine: maxChars, lines }, (r) => `Made ${r.changes[0]?.count ?? 0} subtitles with Resolve's transcription on ${r.changes[0]?.trackName ?? "a subtitle track"}`);
      }
      const { lines, untranscribed } = await heardLines(context);
      if (!lines.length) throw new Error(`There's no transcribed speech on the ${TIMELINE_NOUN[host]}; transcribe the clips first (transcribe_clips)`);
      const cues = captionCues(lines, maxChars);
      const name = optStr(args, "name")?.trim() || `${timeline} captions`;
      const outcome = await edit(ctx, "create_captions", "create_captions", { cues, name }, (r) => `Made a caption track of ${r.changes[0]?.count ?? cues.length} captions from the transcripts ("${name}")`);
      return untranscribed.length ? { ...outcome, summary: `${outcome.summary}; not captioned (no transcript): ${untranscribed.join(", ")}` } : outcome;
    },
  };
}

/** The ground rule the system prompt gains (VibeCut's CAPTION_INSTRUCTION). */
export const CAPTION_INSTRUCTION = `- create_captions adds captions for what is said (Resolve transcribes itself; Premiere uses the
  transcripts, so transcribe_clips first). There is no title tool: neither editor sets a title's text from a script.`;
