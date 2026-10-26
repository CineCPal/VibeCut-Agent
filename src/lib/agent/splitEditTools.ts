/**
 * J and L cuts (PLAN.md, "Phase 18b"): `make_split_edit` moves the sound's edit away from the picture's at
 * a cut, in the draft. A J cut brings the next shot's sound in early, under the end of the shot before; an
 * L cut lets the shot before's sound run on under the next one. On each audio track, the sound starting at
 * the cut and the sound ending there are trimmed and extended together, so nothing overlaps.
 *
 * It's a draft tool because neither editor can trim a clip's sound apart from its linked picture from a
 * script without unlinking it (several edits, several backups); in the draft it is one change, and
 * send_to_* builds the new timeline. The moved sound no longer starts with its picture, so the rebuild
 * leaves those two unlinked.
 */
import type { NleHost } from "../../types/nle";
import type { DraftClip, HostDraft } from "../../vibecut/lib/connect/hostDraft";
import { type Args, clock, type Executor, optNum, optStr, type ToolOutcome } from "./args";
import { openDraft, saveDraft } from "./draft";
import { TIMELINE_NOUN } from "./edits";
import { factsOf, learnFacts } from "./mediaInfo";
import type { ToolContext, ToolDeclaration } from "./tools";

export const SPLIT_KINDS = ["J", "L"] as const;
export type SplitKind = (typeof SPLIT_KINDS)[number];
export const DEFAULT_SPLIT_SECONDS = 0.5;
/** The most edits one call makes. */
export const MAX_SPLITS = 100;

const round3 = (n: number) => Math.round(n * 1000) / 1000;

export interface SplitEdit {
  /** The cut, in draft seconds. */
  at: number;
  kind: SplitKind;
  seconds: number;
}

/**
 * The draft with one split edit made at the picture cut nearest `at` (within a frame). `lengthOf` gives a
 * file's length when known, so an L cut can't run its sound past the end of the file.
 */
export function splitEdit(draft: HostDraft, edit: SplitEdit, lengthOf: (path: string) => number | undefined = () => undefined): HostDraft {
  const fps = draft.fps;
  const half = 0.5 / fps;
  const snap = (t: number) => round3(Math.round(t * fps) / fps);
  const at = snap(edit.at);
  const d = snap(edit.seconds);
  if (!(d >= 1 / fps)) throw new Error(`seconds must be at least a frame (${round3(1 / fps)}s)`);
  const near = (t: number) => Math.abs(t - at) < half;
  const pictureCut = draft.video.some((t) => t.clips.some((c) => near(c.end) && c.enabled) && t.clips.some((c) => near(c.start) && c.enabled));
  if (!pictureCut) throw new Error(`There's no picture cut at ${clock(at)} (one shot ending and the next starting on the same video track)`);

  let changed = 0;
  const audio = draft.audio.map((track, i) => {
    const outgoing = track.clips.find((c) => near(c.end));
    const incoming = track.clips.find((c) => near(c.start));
    // Only a track with the sound that's extended changes; trimming alone would leave a hole.
    if (edit.kind === "J" ? !incoming : !outgoing) return track;
    for (const c of [outgoing, incoming]) if (c?.timeRemap) throw new Error(`"${c.sourceName}" on A${i + 1} has a speed ramp; clear_clip_speed it first`);
    // J: the cut on this track moves earlier (incoming starts early); L: it moves later.
    const edge = edit.kind === "J" ? at - d : at + d;
    const clips: DraftClip[] = track.clips.map((c) => {
      if (c === outgoing) {
        const sourceOut = round3(c.sourceIn + (edge - c.start) * c.speed);
        if (edge - c.start < 1 / fps - 1e-9) throw new Error(`"${c.sourceName}" on A${i + 1} is shorter than ${d}s; a smaller seconds`);
        const length = lengthOf(c.sourcePath);
        if (length !== undefined && sourceOut > length + 1e-3) throw new Error(`"${c.sourceName}" has only ${round3(length - c.sourceOut)}s of sound after its end; a smaller seconds`);
        return { ...c, end: edge, sourceOut };
      }
      if (c === incoming) {
        const sourceIn = round3(c.sourceIn - (c.start - edge) * c.speed);
        if (sourceIn < -1e-3) throw new Error(`"${c.sourceName}" has only ${round3(c.sourceIn)}s of sound before its start; a smaller seconds`);
        if (c.end - edge < 1 / fps - 1e-9) throw new Error(`"${c.sourceName}" on A${i + 1} is shorter than ${d}s; a smaller seconds`);
        return { ...c, start: edge, sourceIn: Math.max(0, sourceIn) };
      }
      return c;
    });
    // A clip extended into space that had nothing of this cut in it must find it free.
    const sorted = [...clips].sort((a, b) => a.start - b.start);
    for (let k = 1; k < sorted.length; k++) {
      if (sorted[k].start < sorted[k - 1].end - 1e-6) throw new Error(`On A${i + 1}, "${sorted[k - 1].sourceName}" and "${sorted[k].sourceName}" would overlap`);
    }
    if (edge < 0) throw new Error("That would start before the timeline does");
    changed++;
    return { ...track, clips: sorted };
  });
  if (!changed) throw new Error(`No sound is cut at ${clock(at)}; a split edit needs the sound to be cut with the picture there`);
  const duration = round3(Math.max(draft.duration, ...audio.flatMap((t) => t.clips.map((c) => c.end))));
  const change = `${edit.kind} cut at ${round3(at)}s: the ${edit.kind === "J" ? "next shot's sound comes in" : "shot's sound runs on"} ${d}s ${edit.kind === "J" ? "early" : "late"} on ${changed} track(s)`;
  return { ...draft, audio, duration, changes: [...draft.changes, change] };
}

export function splitEditToolDeclarations(host: NleHost): ToolDeclaration[] {
  const noun = TIMELINE_NOUN[host];
  return [
    {
      name: "make_split_edit",
      description: `Makes J and L cuts in the draft (opened from the connected ${noun} if there isn't one). At a picture cut, J brings the next shot's sound in early, under the end of the shot before (hear the answer before seeing who gives it); L lets the shot's sound run on under the next shot (a reaction, B-roll over the last words). Each audio track cut there moves its edit by \`seconds\` (default ${DEFAULT_SPLIT_SECONDS}); the picture stays. Needs that much media beyond the clip's edge. Give every edit in one call, at the cut times the snapshot shows. A refused edit is named and the rest are made. In the new ${noun}, the moved sound is no longer linked to its picture.`,
      parameters: {
        type: "OBJECT",
        properties: {
          edits: {
            type: "ARRAY",
            items: {
              type: "OBJECT",
              properties: {
                at: { type: "NUMBER", description: `The picture cut, in ${noun} seconds.` },
                type: { type: "STRING", enum: [...SPLIT_KINDS] },
                seconds: { type: "NUMBER", description: `Default ${DEFAULT_SPLIT_SECONDS}.` },
              },
              required: ["at", "type"],
            },
          },
        },
        required: ["edits"],
      },
    },
  ];
}

export function splitEditExecutors(context: ToolContext): Record<string, Executor> {
  return {
    make_split_edit: async (args): Promise<ToolOutcome> => {
      const raw = args.edits;
      if (!Array.isArray(raw) || raw.length === 0) throw new Error("edits must list at least one edit");
      if (raw.length > MAX_SPLITS) throw new Error(`At most ${MAX_SPLITS} edits per call`);
      const edits: SplitEdit[] = raw.map((value, i) => {
        const e = (typeof value === "object" && value !== null ? value : {}) as Args;
        const at = optNum(e, "at");
        if (at === undefined) throw new Error(`edits[${i}].at must be a number`);
        const kind = optStr(e, "type")?.toUpperCase();
        if (kind !== "J" && kind !== "L") throw new Error(`edits[${i}].type must be J or L`);
        return { at, kind, seconds: optNum(e, "seconds") ?? DEFAULT_SPLIT_SECONDS };
      });
      let draft = await openDraft(context);
      const before = draft.changes.length;
      const paths = [...new Set(draft.audio.flatMap((t) => t.clips.map((c) => c.sourcePath)))];
      await learnFacts(paths, 5_000);
      const lengthOf = (path: string) => factsOf(path)?.duration ?? undefined;
      const refused: string[] = [];
      for (const edit of edits) {
        try {
          draft = splitEdit(draft, edit, lengthOf);
        } catch (error) {
          refused.push(`${edit.kind} at ${clock(edit.at)}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      const made = draft.changes.length - before;
      if (!made) throw new Error(refused.join("; "));
      const saved = saveDraft(context.host, draft);
      return {
        summary: `Made ${made} split edit(s) in the draft${refused.length ? `; refused ${refused.length}` : ""}`,
        result: { ...(saved.result as object), made: draft.changes.slice(before), ...(refused.length ? { refused } : {}) },
      };
    },
  };
}

/** The ground rule the system prompt gains (Phase 18b). */
export const SPLIT_EDIT_INSTRUCTION = `- J and L cuts (make_split_edit, in the draft) smooth an interview or a dialogue scene: a J cut where
  an answer or a new scene starts, an L cut where a reaction or B-roll should carry the last words.
  Half a second to a second is usual; use them sparingly, not at every cut.`;
