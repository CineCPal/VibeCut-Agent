/**
 * YouTube packaging (PLAN.md, "Phase 20d"):
 *  - `make_chapters` checks the agent's chapters (drafted from the markers and what's said) against
 *    YouTube's rules (the first at 0:00, at least three, each at least ten seconds) and gives them as the
 *    list to paste into the description. It only reads; add_markers puts them on the timeline if asked.
 *  - `find_thumbnails` samples the picture of the edit (each shot a quarter, half and three quarters in),
 *    scores the frames for sharpness, exposure and colour (`media-thumbs`), keeps the best of different
 *    shots and shows them as one contact sheet, so the agent can judge faces, expression and composition,
 *    which a score can't.
 *  - `export_thumbnails` saves the chosen moments as the editor shows them (grade and titles included;
 *    nle/stills.py) into the project's renders folder, with a 1280x720 JPEG under 2 MB beside each for
 *    YouTube (`media-thumbs`).
 * The title and description are the agent's own writing, from the transcripts and the notes.
 */
import { nleCall } from "../ipc";
import { runJob } from "../jobs";
import type { NleHost } from "../../types/nle";
import { type Args, bool, clock, type Executor, optNum, optStr, type ToolOutcome } from "./args";
import { connectedView, draftOf } from "./draft";
import { HOST_SHORT, TIMELINE_NOUN } from "./edits";
import { shotsIn, timelineShots, type Shot } from "./pacingTools";
import type { ToolContext, ToolDeclaration } from "./tools";
import { checkBudget, look, pictureAt, sourceTime } from "./visionTools";

export const YOUTUBE_LIMITS = {
  /** YouTube's rules for chapters. */
  minChapters: 3,
  minChapter: 10,
  maxTitle: 100,
  /** A first chapter this close to the start is moved to 0:00. */
  snapFirst: 10,
  /** media-thumbs' MAX_FRAMES, and how many candidates to show. */
  maxSamples: 60,
  defaultCount: 8,
  maxCount: 12,
  /** Two candidates closer than this (seconds) are the same moment. */
  minApart: 2,
  /** nle/stills.py's MAX_STILLS. */
  maxStills: 12,
} as const;

const round2 = (n: number) => Math.round(n * 100) / 100;
const fileName = (path: string) => path.split(/[\\/]/).pop() || path;

// ----------------------------------------------------------------------------- chapters

export interface Chapter {
  time: number;
  title: string;
}

export interface ChapterCheck {
  chapters: Chapter[];
  /** What was put right (a first chapter moved to 0:00). */
  fixed: string[];
  /** What breaks YouTube's rules and needs the agent to change the chapters. */
  problems: string[];
  /** The list for the description, one "0:00 Title" a line. */
  text: string;
}

/** "0:00", "12:34", or "1:02:03" when the video runs an hour or more: how YouTube reads them. */
export function chapterTime(seconds: number, hours: boolean): string {
  const s = Math.floor(seconds + 1e-6);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, "0");
  return hours ? `${h}:${String(m).padStart(2, "0")}:${sec}` : `${Math.floor(s / 60)}:${sec}`;
}

/** The chapters checked against YouTube's rules for a video `duration` seconds long. */
export function checkChapters(raw: Chapter[], duration: number): ChapterCheck {
  const L = YOUTUBE_LIMITS;
  const fixed: string[] = [];
  const problems: string[] = [];
  const chapters = raw.map((c) => ({ time: round2(c.time), title: c.title.replace(/\s+/g, " ").trim() })).sort((a, b) => a.time - b.time);
  if (chapters.length && chapters[0].time > 0) {
    if (chapters[0].time <= L.snapFirst) {
      fixed.push(`"${chapters[0].title}" moved from ${chapterTime(chapters[0].time, false)} to 0:00 (YouTube's first chapter starts the video)`);
      chapters[0].time = 0;
    } else {
      problems.push(`the first chapter must start at 0:00: add one for the opening (it's ${chapterTime(chapters[0].time, false)} now)`);
    }
  }
  if (chapters.length < L.minChapters) problems.push(`YouTube needs at least ${L.minChapters} chapters (there are ${chapters.length})`);
  chapters.forEach((c, i) => {
    const next = i + 1 < chapters.length ? chapters[i + 1].time : duration;
    if (!c.title) problems.push(`chapter ${i + 1} (${chapterTime(c.time, false)}) has no title`);
    if (c.title.length > L.maxTitle) problems.push(`"${c.title.slice(0, 30)}…" is over ${L.maxTitle} characters`);
    if (c.time >= duration) problems.push(`"${c.title}" at ${chapterTime(c.time, false)} is past the end (${chapterTime(duration, false)})`);
    else if (next - c.time < L.minChapter) problems.push(`"${c.title}" is ${round2(next - c.time)}s long; each chapter must be at least ${L.minChapter}s (merge it or move a boundary)`);
    if (i > 0 && c.time === chapters[i - 1].time) problems.push(`"${chapters[i - 1].title}" and "${c.title}" start at the same time`);
  });
  const hours = duration >= 3600;
  return { chapters, fixed, problems, text: chapters.map((c) => `${chapterTime(c.time, hours)} ${c.title}`).join("\n") };
}

// ----------------------------------------------------------------------------- thumbnails

export interface Candidate {
  /** Timeline seconds. */
  time: number;
  path: string;
  /** Seconds into the file. */
  fileTime: number;
  clipId: string;
  name: string;
  /** Index of its shot, so the picks come from different shots. */
  shot: number;
}

export interface Scored extends Candidate {
  score: number;
  sharpness: number;
  exposure: number;
  colour: number;
}

/** Moments to score: a quarter, half and three quarters into each shot (the middle of a short one), each
 * where a clip with a file is seen; evenly thinned to `max`. */
export function thumbnailMoments(view: Parameters<typeof timelineShots>[0], shots: Shot[], max: number = YOUTUBE_LIMITS.maxSamples): Candidate[] {
  const out: Candidate[] = [];
  shots.forEach((shot, i) => {
    const length = shot.end - shot.start;
    const shares = length >= 3 ? [0.25, 0.5, 0.75] : [0.5];
    for (const share of shares) {
      const time = round2(shot.start + length * share);
      const seen = pictureAt(view, time);
      if (seen?.clip.filePath) out.push({ time, path: seen.clip.filePath, fileTime: sourceTime(seen.clip, time), clipId: seen.clip.id, name: seen.clip.name, shot: i });
    }
  });
  if (out.length <= max) return out;
  const step = out.length / max;
  return Array.from({ length: max }, (_, k) => out[Math.floor(k * step)]);
}

/** The best `count`: highest score first, one a shot until every shot has had its best, never two within
 * `minApart` seconds; frames that are dark (score 0) left out. */
export function pickThumbnails(scored: Scored[], count: number): Scored[] {
  const ranked = scored.filter((s) => s.score > 0).sort((a, b) => b.score - a.score);
  const picks: Scored[] = [];
  const near = (s: Scored) => picks.some((p) => Math.abs(p.time - s.time) < YOUTUBE_LIMITS.minApart);
  for (const s of ranked) {
    if (picks.length >= count) break;
    if (!picks.some((p) => p.shot === s.shot) && !near(s)) picks.push(s);
  }
  for (const s of ranked) {
    if (picks.length >= count) break;
    if (!picks.includes(s) && !near(s)) picks.push(s);
  }
  return picks;
}

export function youtubeToolDeclarations(host: NleHost): ToolDeclaration[] {
  const noun = TIMELINE_NOUN[host];
  const editor = HOST_SHORT[host];
  return [
    {
      name: "make_chapters",
      description: `Checks YouTube chapters for the connected ${noun} and gives them as the list to paste into the description. Draft them first from the ${noun}'s markers and what's said (get_transcript): a chapter where the subject changes, with a short, specific title. It checks YouTube's rules: the first at 0:00 (a first chapter within ${YOUTUBE_LIMITS.snapFirst}s is moved there), at least ${YOUTUBE_LIMITS.minChapters}, each at least ${YOUTUBE_LIMITS.minChapter}s long (the last up to the end of the ${noun}, or end). When it lists problems, fix the chapters and call it again. It only reads; add_markers puts the chapters on the ${noun} if the user wants them there.`,
      parameters: {
        type: "OBJECT",
        properties: {
          chapters: {
            type: "ARRAY",
            items: { type: "OBJECT", properties: { time: { type: "NUMBER", description: `Seconds from the ${noun}'s start.` }, title: { type: "STRING" } }, required: ["time", "title"] },
          },
          end: { type: "NUMBER", description: `Optional: where the video ends, in seconds of the ${noun}, when it's exported shorter than the ${noun}.` },
        },
        required: ["chapters"],
      },
    },
    {
      name: "find_thumbnails",
      description: `Finds thumbnail candidates in the connected ${noun}: it scores frames from every shot (a quarter, half and three quarters in) for sharpness, exposure and colour, keeps the best few from different shots, and shows them to you as one numbered contact sheet. The frames are the source files' own (no grade or titles). Judge them yourself: a clear face with an expression, a strong subject, room for a title; then export_thumbnails the ones you and the user like. It only reads.`,
      parameters: {
        type: "OBJECT",
        properties: {
          count: { type: "NUMBER", description: `How many candidates to show. Default ${YOUTUBE_LIMITS.defaultCount}, at most ${YOUTUBE_LIMITS.maxCount}.` },
          start: { type: "NUMBER", description: "Optional." },
          end: { type: "NUMBER", description: "Optional." },
        },
      },
    },
    {
      name: "export_thumbnails",
      description: `Saves moments of the ${noun} as ${editor} shows them (grade, effects and titles included) as PNG stills in the project's renders folder, and beside each a 1280x720 JPEG under 2 MB for YouTube (youtube false leaves them out). Times are seconds on the ${noun}, e.g. from find_thumbnails. The playhead is put back. ${host === "resolve" ? "The timeline must be the one open in Resolve. " : ""}Not while a draft is open.`,
      parameters: {
        type: "OBJECT",
        properties: {
          times: { type: "ARRAY", items: { type: "NUMBER" }, description: `1 to ${YOUTUBE_LIMITS.maxStills} moments.` },
          name: { type: "STRING", description: "Optional: goes in the file names." },
          youtube: { type: "BOOLEAN", description: "Optional; default true." },
        },
        required: ["times"],
      },
    },
  ];
}

export function youtubeExecutors(context: ToolContext): Record<string, Executor> {
  const { host } = context;
  const noun = TIMELINE_NOUN[host];
  return {
    make_chapters: async (args: Args): Promise<ToolOutcome> => {
      const raw = args.chapters;
      if (!Array.isArray(raw) || !raw.length) throw new Error("chapters must list {time, title}");
      const chapters = raw.map((value, i) => {
        const entry = (value ?? {}) as Args;
        const time = optNum(entry, "time");
        const title = optStr(entry, "title") ?? "";
        if (time === undefined || time < 0) throw new Error(`chapters[${i}].time must be seconds from the ${noun}'s start`);
        return { time, title };
      });
      const view = await connectedView(context);
      const end = optNum(args, "end");
      if (end !== undefined && !(end > 0 && end <= view.duration + 0.01)) throw new Error(`end must be inside the ${noun} (0–${clock(view.duration)})`);
      const checked = checkChapters(chapters, end ?? view.duration);
      const ok = checked.problems.length === 0;
      const head = ok ? `${checked.chapters.length} chapters ready for YouTube` : `The chapters break YouTube's rules: ${checked.problems.join("; ")}`;
      return {
        summary: [head, ...checked.fixed.map((f) => `fixed: ${f}`), ...(ok ? [checked.text] : [])].join("\n"),
        result: { ok, ...checked },
      };
    },

    find_thumbnails: async (args: Args): Promise<ToolOutcome> => {
      checkBudget(context.step);
      const count = optNum(args, "count") ?? YOUTUBE_LIMITS.defaultCount;
      if (!Number.isInteger(count) || count < 1 || count > YOUTUBE_LIMITS.maxCount) throw new Error(`count must be 1 to ${YOUTUBE_LIMITS.maxCount}`);
      const view = await connectedView(context);
      const range = { start: Math.max(0, optNum(args, "start") ?? 0), end: Math.min(view.duration, optNum(args, "end") ?? view.duration) };
      if (!(range.end > range.start)) throw new Error(`start–end must be inside the ${noun} (0–${clock(view.duration)})`);
      const moments = thumbnailMoments(view, shotsIn(timelineShots(view), range));
      if (!moments.length) throw new Error(`There's no picture from a media file on the ${noun} between ${clock(range.start)} and ${clock(range.end)}`);
      const job = await runJob("media-thumbs", `Score ${moments.length} thumbnail frames`, { frames: moments.map((m) => ({ path: m.path, time: m.fileTime })) });
      const frames = ((job?.result ?? {}) as { frames?: ({ index: number; ok: boolean; score?: number; sharpness?: number; exposure?: number; colour?: number })[] }).frames;
      if (!frames) throw new Error(`Couldn't score the frames: ${job?.error ?? "no result"}`);
      const scored: Scored[] = frames
        .filter((f) => f.ok)
        .map((f) => ({ ...moments[f.index], score: f.score ?? 0, sharpness: f.sharpness ?? 0, exposure: f.exposure ?? 0, colour: f.colour ?? 0 }));
      const picks = pickThumbnails(scored, count);
      if (!picks.length) throw new Error(`Every frame scored was dark or unreadable`);
      const shown = await look(
        // The sheet numbers its tiles itself; the label is the time on the timeline.
        picks.map((p) => ({ path: p.path, time: p.fileTime, label: clock(p.time), clipId: p.clipId })),
        `Found ${picks.length} thumbnail candidate(s) from ${moments.length} frames: ${picks.map((p, i) => `${i + 1}. ${clock(p.time)} "${p.name}" (${Math.round(p.score)})`).join(", ")}`,
        {},
      );
      return {
        ...shown,
        result: {
          ...(shown.result as Record<string, unknown>),
          candidates: picks.map((p, i) => ({ n: i + 1, time: p.time, clipId: p.clipId, name: p.name, score: p.score, sharpness: p.sharpness, exposure: p.exposure, colour: p.colour })),
          scored: scored.length,
          next: "Pick by what's in them (faces, expression, subject, room for a title), then export_thumbnails their times.",
        },
      };
    },

    export_thumbnails: async (args: Args): Promise<ToolOutcome> => {
      if (!context.timeline) throw new Error(`No ${HOST_SHORT[host]} ${noun} is open`);
      if (draftOf(host)) throw new Error(`A draft is open. Thumbnails are of the ${noun} in ${HOST_SHORT[host]}, so send the draft (send_to_${host}) or discard it first.`);
      const times = Array.isArray(args.times) ? args.times : [];
      if (!times.length || times.length > YOUTUBE_LIMITS.maxStills || !times.every((t) => typeof t === "number" && Number.isFinite(t) && t >= 0)) {
        throw new Error(`times must list 1 to ${YOUTUBE_LIMITS.maxStills} moments of the ${noun}, in seconds`);
      }
      const name = optStr(args, "name");
      const exported = await nleCall<{ stills: { time: number; path: string }[]; folder: string }>(host, "export_stills", { timeline: context.timeline, times, ...(name ? { name } : {}) });
      const lines = exported.stills.map((s) => `${clock(s.time)}: ${fileName(s.path)}`);
      let jpegs: { from: string; path: string; bytes: number }[] = [];
      const notes: string[] = [];
      if (args.youtube === undefined || bool(args, "youtube")) {
        const job = await runJob("media-thumbs", `Make ${exported.stills.length} YouTube thumbnail(s)`, { youtube: exported.stills.map((s) => s.path) });
        jpegs = ((job?.result ?? {}) as { jpegs?: typeof jpegs }).jpegs ?? [];
        if (!jpegs.length) notes.push(`the YouTube JPEGs weren't made: ${job?.error ?? "no result"}`);
      }
      return {
        summary: [`Saved ${exported.stills.length} still(s) in ${exported.folder}`, ...lines, ...(jpegs.length ? [`and ${jpegs.length} YouTube JPEG(s): ${jpegs.map((j) => fileName(j.path)).join(", ")}`] : []), ...notes].join("\n"),
        result: { folder: exported.folder, stills: exported.stills, ...(jpegs.length ? { youtube: jpegs } : {}), ...(notes.length ? { notes } : {}) },
      };
    },
  };
}

/** The ground rule the system prompt gains (Phase 20d). */
export const YOUTUBE_INSTRUCTION = `- YouTube: for chapters, draft them from the markers and what's said, then make_chapters (fix what it
  lists and call it again); give the user its list to paste. For a thumbnail, find_thumbnails, judge the
  sheet (a clear face with an expression, a strong subject, room for a title), and export_thumbnails the
  ones you or the user pick. A title and description are your own writing from the transcripts and the
  notes: a title under about 60 characters that says what the video gives the viewer, without
  clickbait the video doesn't back up; a description whose first two lines stand alone (they show above
  "more"), then the chapters. A Short is make_social_version.`;
