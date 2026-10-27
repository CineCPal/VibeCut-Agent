/**
 * Timeline edits in the draft (PLAN.md, "Phase 19a"): `close_gaps` (a ripple delete of the empty
 * stretches), `insert_clip` (insert or overwrite a part of a file) and `replace_clip` (another file in a
 * clip's place, at its length).
 *
 * They're draft tools because a ripple moves every later clip on every track, and neither editor can
 * do that from a script in one edit (Premiere's insert moves only its targeted tracks; PLAN.md, "7b.0
 * probe"). In the draft each is one change, and send_to_* builds the new timeline. Replacing a clip
 * moves nothing, but a new file's clip can't be swapped in place from a script either; in the draft it
 * sits with the other edits it usually comes with.
 */
import type { NleHost } from "../../types/nle";
import {
  arrangeSections,
  draftClipAt,
  draftGroup,
  insertDraftClip,
  isSoundOnly,
  overwriteDraftClip,
  type DraftClip,
  type DraftMarker,
  type EditOptions,
  type HostDraft,
  type TimeRange,
} from "../../vibecut/lib/connect/hostDraft";
import { bool, type Executor, num, optNum, optStr, type ToolOutcome } from "./args";
import { openDraft, saveDraft } from "./draft";
import { TIMELINE_NOUN } from "./edits";
import { factsOf, learnFacts, type MediaFacts } from "./mediaInfo";
import { draftIdFor } from "./timingTools";
import type { ToolContext, ToolDeclaration } from "./tools";

/** Stills: their file has a frame, not a length, so any length can be cut from one. */
const STILL = /\.(png|jpe?g|tiff?|psd|exr|dpx|heic|webp|bmp|gif)$/i;
const FACTS_WAIT_MS = 5_000;

const round3 = (n: number) => Math.round(n * 1000) / 1000;
const fileName = (path: string) => path.split(/[\\/]/).pop() || path;
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

export interface GapOptions {
  /** Shorter gaps stay; default a frame. */
  minSeconds?: number;
  /** Only gaps inside this stretch of the timeline. */
  from?: number;
  to?: number;
}

/** The stretches where no track has a clip (an off clip still counts as one), the end included. */
export function findGaps(draft: HostDraft, options: GapOptions = {}): TimeRange[] {
  const fps = draft.fps;
  const snap = (t: number) => round3(Math.round(t * fps) / fps);
  const half = 0.5 / fps;
  const spans = [...draft.video, ...draft.audio].flatMap((t) => t.clips.map((c) => ({ start: snap(c.start), end: snap(c.end) }))).sort((a, b) => a.start - b.start);
  if (!spans.length) throw new Error("The draft has no clips");
  const gaps: TimeRange[] = [];
  let cursor = 0;
  for (const s of spans) {
    if (s.start > cursor + half) gaps.push({ start: cursor, end: s.start });
    cursor = Math.max(cursor, s.end);
  }
  const duration = snap(draft.duration);
  if (duration > cursor + half) gaps.push({ start: cursor, end: duration });
  const min = Math.max(options.minSeconds ?? 0, 1 / fps);
  const from = options.from ?? 0;
  const to = options.to ?? Infinity;
  return gaps.filter((g) => g.end - g.start >= min - 1e-6 && g.start >= from - half && g.end <= to + half);
}

/**
 * The draft with its gaps closed: everything after each one moves earlier, on every track together, so
 * sync holds. A marker in a gap moves to where the gap was, so none is lost.
 */
export function closeGaps(draft: HostDraft, options: GapOptions = {}): HostDraft {
  const fps = draft.fps;
  const gaps = findGaps(draft, options);
  if (!gaps.length) throw new Error(`There are no gaps${options.minSeconds ? ` of ${options.minSeconds}s or more` : ""}${options.from !== undefined || options.to !== undefined ? " there" : ""}; a stretch where only some tracks are empty isn't a gap`);
  const kept: TimeRange[] = [];
  let cursor = 0;
  for (const g of gaps) {
    if (g.start > cursor) kept.push({ start: cursor, end: g.start });
    cursor = g.end;
  }
  if (draft.duration > cursor + 0.5 / fps) kept.push({ start: cursor, end: draft.duration });
  const removed = round3(gaps.reduce((s, g) => s + g.end - g.start, 0));
  const next = arrangeSections(draft, kept, `Closed ${plural(gaps.length, "gap")} (${removed}s)`);
  // arrangeSections drops the markers outside its sections; here every marker is kept.
  const markers: DraftMarker[] = draft.markers
    .map((m) => {
      let shift = 0;
      for (const g of gaps) {
        if (g.end <= m.time + 1e-6) shift += g.end - g.start;
        else if (g.start <= m.time + 1e-6) shift += m.time - g.start;
      }
      return { ...m, time: round3(Math.round((m.time - shift) * fps) / fps) };
    })
    .sort((a, b) => a.time - b.time);
  return { ...next, markers };
}

export interface Replacement {
  sourcePath: string;
  sourceIn: number;
  /** Leave the clip's linked picture or sound as it is. */
  keepLinked: boolean;
  hasPicture: boolean;
  hasSound: boolean;
  /** The file's length, when known (not for a still). */
  length?: number;
  /** The file's sound channels, when known. */
  channels?: number;
}

/**
 * Puts a part of another file in a clip's place, at the clip's length, from `sourceIn` (a replace edit):
 * nothing else moves. The clip's linked picture or sound is replaced with the new file's too, unless
 * `keepLinked`; a linked part the new file doesn't have (the sound under a picture from a silent file)
 * is taken out. Each replaced clip keeps its place, track, on/off and level.
 */
export function replaceDraftClip(draft: HostDraft, id: string, r: Replacement): HostDraft {
  const fps = draft.fps;
  const at = draftClipAt(draft, id);
  const { main, group } = draftGroup(draft, id);
  const name = fileName(r.sourcePath);
  if (!r.sourcePath.startsWith("/")) throw new Error("The file must be an absolute path");
  if (!(r.sourceIn >= 0)) throw new Error("sourceIn must be 0 or later");
  if (at.kind === "video" && !r.hasPicture) throw new Error(`${name} has no picture; a picture clip needs a file with picture`);
  if (at.kind === "audio" && !r.hasSound) throw new Error(`${name} has no sound; a sound clip needs a file with sound`);
  const length = round3(main.end - main.start);
  const sourceOut = round3(r.sourceIn + length);
  if (r.length !== undefined && sourceOut > r.length + 1e-3) {
    throw new Error(`${name} is ${round3(r.length)}s long, so from ${round3(r.sourceIn)}s it has ${round3(Math.max(0, r.length - r.sourceIn))}s, and the clip is ${length}s; an earlier sourceIn, or trim the clip first`);
  }
  const kindOf = new Map<DraftClip, "video" | "audio">();
  for (const kind of ["video", "audio"] as const) for (const t of draft[kind]) for (const c of t.clips) if (group.has(c)) kindOf.set(c, kind);
  const has = (kind: "video" | "audio") => (kind === "video" ? r.hasPicture : r.hasSound);
  const replaced = new Set<DraftClip>([main]);
  const removed = new Set<DraftClip>();
  if (!r.keepLinked) for (const [c, kind] of kindOf) if (c !== main) (has(kind) ? replaced : removed).add(c);
  const linkGroup = replaced.size > 1 ? { linkGroup: `replaced-${draft.changes.length}-${Math.round(main.start * fps)}` } : {};
  const swap = (c: DraftClip, kind: "video" | "audio"): DraftClip => {
    // A channel the new file has stays (Premiere's split stereo); otherwise the clip plays all of them.
    const channels = kind === "audio" && c.channels && r.channels !== undefined && Math.max(...c.channels) <= r.channels ? { channels: c.channels } : {};
    return {
      sourcePath: r.sourcePath,
      sourceName: name,
      start: c.start,
      end: c.end,
      sourceIn: round3(r.sourceIn),
      sourceOut,
      speed: 1,
      enabled: c.enabled,
      volumeDb: kind === "audio" ? c.volumeDb : null,
      ...linkGroup,
      ...channels,
    };
  };
  const change = (kind: "video" | "audio") => (t: HostDraft["video"][number]) => ({
    ...t,
    clips: t.clips.filter((c) => !removed.has(c)).map((c) => (replaced.has(c) ? swap(c, kind) : c)),
  });
  const notes = [
    r.keepLinked && kindOf.size > 1 ? `its linked ${at.kind === "video" ? "sound" : "picture"} kept` : "",
    removed.size ? `its linked ${at.kind === "video" ? "sound" : "picture"} taken out (${name} has none)` : "",
  ].filter(Boolean);
  return {
    ...draft,
    video: draft.video.map(change("video")),
    audio: draft.audio.map(change("audio")),
    changes: [...draft.changes, `Replaced "${main.sourceName}" at ${round3(main.start)}s (${length}s) with ${name} from ${round3(r.sourceIn)}s${notes.length ? `; ${notes.join("; ")}` : ""}`],
  };
}

/** What a file has, from its probed facts or, when they aren't back, its extension. */
async function fileParts(path: string): Promise<{ facts?: MediaFacts; picture: boolean; sound: boolean; still: boolean }> {
  if (!path.startsWith("/")) throw new Error("path must be an absolute file path");
  await learnFacts([path], FACTS_WAIT_MS);
  const facts = factsOf(path);
  const still = STILL.test(path);
  if (facts) return { facts, picture: !!facts.video, sound: !!facts.audio, still };
  return { picture: !isSoundOnly(path), sound: !still, still };
}

export function draftEditToolDeclarations(host: NleHost): ToolDeclaration[] {
  const noun = TIMELINE_NOUN[host];
  const inDraft = `in the draft (opened from the connected ${noun} if there isn't one)`;
  return [
    {
      name: "close_gaps",
      description: `Closes the gaps ${inDraft}: every stretch where no track has a clip is taken out and everything after it moves earlier, on all tracks together (a ripple delete), so sync holds. A stretch where only some tracks are empty (B-roll on V2 with nothing between shots) isn't a gap and stays. An off clip counts as a clip. Markers in a gap move to where it was. from/to close only the gaps inside that stretch.`,
      parameters: {
        type: "OBJECT",
        properties: {
          minSeconds: { type: "NUMBER", description: "Leave gaps shorter than this. Optional; default a frame." },
          from: { type: "NUMBER", description: `${noun} seconds. Optional.` },
          to: { type: "NUMBER", description: `${noun} seconds. Optional.` },
        },
      },
    },
    {
      name: "insert_clip",
      description: `Edits part of a media file into the ${noun} ${inDraft}. mode "insert" (the default) cuts every track at \`at\` and moves everything from there later by the clip's length, on all tracks together, so sync holds; "overwrite" lays it over what's on its tracks there and moves nothing. Its picture goes on videoTrack (default V1) and its sound on audioTrack (default A1), linked; a track one past the last is added. A sound-only file goes on audio alone; picture/sound false leaves that part out. One clip per call; later times move after an insert, so read the result's draft before the next.`,
      parameters: {
        type: "OBJECT",
        properties: {
          path: { type: "STRING", description: "Absolute media file path." },
          sourceIn: { type: "NUMBER", description: "Seconds into the file. Default 0." },
          sourceOut: { type: "NUMBER", description: "Seconds into the file; after sourceIn." },
          at: { type: "NUMBER", description: `Seconds from the ${noun}'s start.` },
          mode: { type: "STRING", enum: ["insert", "overwrite"], description: "Optional; default insert." },
          videoTrack: { type: "NUMBER", description: "1-based. Optional; default 1." },
          audioTrack: { type: "NUMBER", description: "1-based. Optional; default 1." },
          picture: { type: "BOOLEAN", description: "Optional; default true when the file has picture." },
          sound: { type: "BOOLEAN", description: "Optional; default true when the file has sound." },
        },
        required: ["path", "sourceOut", "at"],
      },
    },
    {
      name: "replace_clip",
      description: `Replaces a clip ${inDraft} with part of another file, from sourceIn, at the clip's own place and length (a replace edit): nothing else moves. Its linked picture or sound is replaced with the new file's too, unless keepLinked (keep the interview sound under a new picture); a linked part the new file doesn't have is taken out. The file must have enough media from sourceIn to fill the clip. To change the length as well, replace, then trim.`,
      parameters: {
        type: "OBJECT",
        properties: {
          clipId: { type: "STRING", description: "A timeline clip id (a draft clip's while a draft is open)." },
          path: { type: "STRING", description: "Absolute media file path." },
          sourceIn: { type: "NUMBER", description: "Seconds into the file. Default 0." },
          keepLinked: { type: "BOOLEAN", description: "Optional; default false." },
        },
        required: ["clipId", "path"],
      },
    },
  ];
}

export function draftEditExecutors(context: ToolContext): Record<string, Executor> {
  const { host } = context;
  return {
    close_gaps: async (args): Promise<ToolOutcome> => {
      const draft = await openDraft(context);
      return saveDraft(host, closeGaps(draft, { minSeconds: optNum(args, "minSeconds"), from: optNum(args, "from"), to: optNum(args, "to") }));
    },
    insert_clip: async (args): Promise<ToolOutcome> => {
      const path = optStr(args, "path") ?? "";
      const sourceIn = optNum(args, "sourceIn") ?? 0;
      const sourceOut = num(args, "sourceOut");
      const mode = optStr(args, "mode") ?? "insert";
      if (mode !== "insert" && mode !== "overwrite") throw new Error('mode must be "insert" or "overwrite"');
      const parts = await fileParts(path);
      const withPicture = bool(args, "picture", parts.picture);
      const withSound = bool(args, "sound", parts.sound);
      if (withPicture && !parts.picture) throw new Error(`${fileName(path)} has no picture`);
      if (withSound && !parts.sound) throw new Error(`${fileName(path)} has no sound; sound false`);
      const length = parts.still ? null : parts.facts?.duration;
      if (length && sourceOut > length + 1e-3) throw new Error(`${fileName(path)} is ${round3(length)}s long; sourceOut ${sourceOut}s is past its end`);
      const options: EditOptions = {
        sourcePath: path,
        sourceIn,
        sourceOut,
        at: num(args, "at"),
        videoTrack: optNum(args, "videoTrack"),
        audioTrack: optNum(args, "audioTrack"),
        withPicture,
        withSound,
      };
      const draft = await openDraft(context);
      return saveDraft(host, mode === "insert" ? insertDraftClip(draft, options) : overwriteDraftClip(draft, options));
    },
    replace_clip: async (args): Promise<ToolOutcome> => {
      const clipId = optStr(args, "clipId");
      if (!clipId) throw new Error("clipId is required");
      const path = optStr(args, "path") ?? "";
      const parts = await fileParts(path);
      const draft = await openDraft(context);
      const next = replaceDraftClip(draft, draftIdFor(draft, clipId), {
        sourcePath: path,
        sourceIn: optNum(args, "sourceIn") ?? 0,
        keepLinked: bool(args, "keepLinked"),
        hasPicture: parts.picture,
        hasSound: parts.sound,
        ...(parts.still || !parts.facts?.duration ? {} : { length: parts.facts.duration }),
        ...(parts.facts?.audio?.channels ? { channels: parts.facts.audio.channels } : {}),
      });
      return saveDraft(host, next);
    },
  };
}

/** The ground rule the system prompt gains (Phase 19a). */
export const DRAFT_EDIT_INSTRUCTION = `- Ripple edits go in the draft: close_gaps (take out stretches where every track is empty),
  insert_clip (insert pushes everything later on all tracks; overwrite lays over what's there) and
  replace_clip (another file, or another part of one, in a clip's place at its length). Read the
  draft's times again after an insert or a gap close, since later clips move. When the user asks to
  close gaps on one track only, say that would pull it out of sync with the others, and offer close_gaps.`;
