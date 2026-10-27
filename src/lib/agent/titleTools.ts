/**
 * Lower thirds (PLAN.md, "Phase 18d"): `add_lower_thirds` renders each name and title as a short ProRes 4444
 * clip with alpha (the `media-titles` job: Pillow, then ffmpeg, its fades baked in) and lays them with
 * add_clips on a video track above every picture, adding one when there isn't one free. Neither editor can
 * place a title of its own from a script where it's wanted (Resolve's Text+ is a ripple insert on V1), so
 * the text isn't editable in the editor: asking again with new words makes a new clip.
 *
 * A direct edit like clean_dialogue: one request, one backup, one Revert, reviewed under Review edits first.
 */
import { runJob } from "../jobs";
import type { NleHost } from "../../types/nle";
import type { HostTimeline } from "../../types/timeline";
import { type Args, clock, type Executor, optNum, optStr, type ToolOutcome } from "./args";
import { connectedView, refuseWhileDrafting } from "./draft";
import { addClips } from "./editTools";
import { TIMELINE_NOUN } from "./edits";
import { timingExecutors } from "./timingTools";
import { laneLines } from "../../vibecut/lib/transcriptLane";
import { withoutBleed } from "./multicamTools";
import { heardView } from "./transcriptTools";
import type { ToolContext, ToolDeclaration } from "./tools";

/** media-titles' MAX_TITLES. */
export const MAX_THIRDS = 20;
export const LOOKS = ["bar", "clean"] as const;
export const POSITIONS = ["left", "center"] as const;
export const DEFAULT_SECONDS = 5;
/** A speaker's lower third comes in this long after they start talking. */
export const SPEAKER_LEAD = 1;

export interface Third {
  name: string;
  title: string;
  at: number;
}

interface RenderedTitle {
  name: string;
  title?: string;
  output?: string;
  reused?: boolean;
  error?: string;
}

const round3 = (n: number) => Math.round(n * 1000) / 1000;

/**
 * Where each lower third goes: its `at`, else `SPEAKER_LEAD` after its speaker's first line (`lines` in
 * timeline time). Each one is kept inside the timeline, and two can't overlap: they share one track.
 */
export function placeThirds(raw: unknown, lines: { start: number; speaker: string }[] | null, seconds: number, duration: number): Third[] {
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > MAX_THIRDS) throw new Error(`thirds must list 1 to ${MAX_THIRDS} lower thirds`);
  const thirds = raw.map((value, i): Third => {
    const e = (typeof value === "object" && value !== null ? value : {}) as Args;
    const name = optStr(e, "name")?.trim();
    if (!name) throw new Error(`thirds[${i}].name is missing`);
    const title = optStr(e, "title")?.trim() ?? "";
    let at = optNum(e, "at");
    const speaker = optStr(e, "speaker")?.trim();
    if (at === undefined) {
      if (!speaker) throw new Error(`thirds[${i}] (${name}): give at (seconds) or speaker (a name from list_speakers)`);
      const first = (lines ?? []).filter((l) => l.speaker.toLowerCase() === speaker.toLowerCase()).sort((a, b) => a.start - b.start)[0];
      if (!first) throw new Error(`thirds[${i}] (${name}): ${speaker} doesn't speak on the timeline${lines && lines.length ? ` (the speakers are: ${[...new Set(lines.map((l) => l.speaker))].join(", ")})` : "; transcribe_clips first"}`);
      at = first.start + SPEAKER_LEAD;
    }
    if (at < 0) throw new Error(`thirds[${i}] (${name}): at must be 0 or later`);
    // Kept inside the timeline when it would run past its end.
    at = round3(Math.max(0, Math.min(at, duration - seconds)));
    return { name, title, at };
  });
  const sorted = [...thirds].sort((a, b) => a.at - b.at);
  for (let k = 1; k < sorted.length; k++) {
    if (sorted[k].at < sorted[k - 1].at + seconds - 1e-6) {
      throw new Error(`${sorted[k - 1].name} (${clock(sorted[k - 1].at)}) and ${sorted[k].name} (${clock(sorted[k].at)}) would overlap; space them at least ${seconds} s apart or use shorter seconds`);
    }
  }
  return thirds;
}

/** The video track lower thirds go on: the one above the highest picture, and whether it has to be added. */
export function titleTrack(view: HostTimeline): { track: number; add: boolean } {
  const video = view.tracks.filter((t) => t.type === "video");
  const top = Math.max(0, ...video.filter((t) => t.clips.length).map((t) => t.index));
  const track = top + 1;
  return { track, add: !video.some((t) => t.index === track) };
}

export function titleToolDeclarations(host: NleHost): ToolDeclaration[] {
  const noun = TIMELINE_NOUN[host];
  return [
    {
      name: "add_lower_thirds",
      description: `Adds lower thirds (a name, and a title under it, e.g. "Ana Lima" / "Director, Lima Films") to the open ${noun}, each for seconds (default ${DEFAULT_SECONDS}) with a short fade in and out, on a video track above every picture (one is added when needed). Place each at a time (at, ${noun} seconds) or by speaker (a name from list_speakers: it comes in ${SPEAKER_LEAD} s after they first talk). Rendered on this Mac as clips with transparency (ProRes 4444) in ~/Movies/VibeCut Renders/<project>/Lower thirds/, so the words can't be edited in the editor: to change one, revert and ask again. Titles come from the user or the project notes; don't invent them (leave title out instead). look: bar (a dark panel, default) or clean (text with a soft shadow); accent: the rule's colour; position: left (default) or center. Usually once per person, the first time they're on screen. One Revert takes them all off.`,
      parameters: {
        type: "OBJECT",
        properties: {
          thirds: {
            type: "ARRAY",
            items: {
              type: "OBJECT",
              properties: {
                name: { type: "STRING", description: "The person's name." },
                title: { type: "STRING", description: "Their job or role, as the user gave it. Optional." },
                at: { type: "NUMBER", description: `${noun} seconds. Optional when speaker is given.` },
                speaker: { type: "STRING", description: "A speaker's name from list_speakers, to place it when they first talk. Optional." },
              },
              required: ["name"],
            },
          },
          seconds: { type: "NUMBER", description: `How long each stays on, 1 to 30. Default ${DEFAULT_SECONDS}.` },
          look: { type: "STRING", enum: [...LOOKS], description: "Default bar." },
          accent: { type: "STRING", description: 'A colour like "#f5a623" (the default). Optional.' },
          position: { type: "STRING", enum: [...POSITIONS], description: "Default left." },
        },
        required: ["thirds"],
      },
    },
  ];
}

export function titleExecutors(context: ToolContext): Record<string, Executor> {
  const { host } = context;
  const noun = TIMELINE_NOUN[host];
  return {
    add_lower_thirds: async (args): Promise<ToolOutcome> => {
      refuseWhileDrafting(host, "add lower thirds");
      const seconds = optNum(args, "seconds") ?? DEFAULT_SECONDS;
      if (!(seconds >= 1 && seconds <= 30)) throw new Error("seconds must be from 1 to 30");
      const look = optStr(args, "look") ?? "bar";
      if (!(LOOKS as readonly string[]).includes(look)) throw new Error("look must be bar or clean");
      const position = optStr(args, "position") ?? "left";
      if (!(POSITIONS as readonly string[]).includes(position)) throw new Error("position must be left or center");
      const accent = optStr(args, "accent");
      if (accent !== undefined && !/^#[0-9a-fA-F]{6}$/.test(accent)) throw new Error('accent must be a colour like "#f5a623"');

      const bySpeaker = Array.isArray(args.thirds) && args.thirds.some((t) => typeof t === "object" && t !== null && (t as Args).at === undefined);
      let view: HostTimeline;
      let lines: { start: number; speaker: string }[] | null = null;
      if (bySpeaker) {
        // Who talks when, with each line heard in another mic's bleed kept only on the louder mic:
        // else the first person's words, picked up by the second's mic, would place the second's title.
        const heard = await heardView(context);
        view = heard.view;
        const said = laneLines(heard.clips.heard, heard.transcripts, heard.clips.assetsById).map((l) => ({ start: l.start, end: l.end, speaker: l.speaker, file: heard.clips.assetsById[l.assetId]?.filePath ?? "", text: l.text }));
        const pieces = view.tracks
          .filter((t) => t.type === "audio")
          .flatMap((t) => t.clips)
          .flatMap((c) => (c.filePath ? [{ path: c.filePath, start: c.start, end: c.end, sourceIn: c.sourceIn ?? 0, speed: c.speed ?? 1, enabled: c.enabled }] : []));
        lines = (await withoutBleed(said, pieces)).turns;
      } else {
        view = await connectedView(context);
      }
      const thirds = placeThirds(args.thirds, lines, seconds, view.duration);
      const width = view.width ?? 1920;
      const height = view.height ?? 1080;

      const job = await runJob("media-titles", `Render ${thirds.length} lower third(s)`, {
        titles: thirds.map((t) => ({ name: t.name, ...(t.title ? { title: t.title } : {}) })),
        width,
        height,
        fps: view.fps,
        seconds,
        look,
        position,
        project: view.project,
        ...(accent ? { accent } : {}),
      });
      const files = ((job?.result ?? {}) as { files?: RenderedTitle[] }).files ?? [];
      const rendered = thirds.flatMap((t, i) => (files[i]?.output ? [{ third: t, path: files[i].output! }] : []));
      const failed = files.flatMap((f) => (f.error ? [`${f.name}: ${f.error}`] : []));
      if (!rendered.length) throw new Error(failed[0] ?? job?.error ?? "No lower third could be rendered");

      const { track, add } = titleTrack(view);
      if (add) await timingExecutors(context).add_track({ type: "video" });
      const ctx = { host, timeline: context.timeline ?? "", step: context.step, stepText: context.stepText };
      const specs = rendered.map(({ third, path }) => ({ path, at: third.at, sourceIn: 0, sourceOut: seconds, videoTrack: track, picture: true, sound: false }));
      const added = await addClips(ctx, "add_lower_thirds", specs);
      const r = added.result as { changes?: { at?: number; itemIds?: string[] }[]; refused?: { reason: string }[]; error?: string };
      if (r.error) throw new Error(r.error);
      const placed = (r.changes ?? []).length;
      if (!placed) throw new Error(`The lower thirds couldn't be placed: ${(r.refused ?? []).map((x) => x.reason).join("; ") || "nothing was added"}`);

      return {
        summary: `Added ${placed} lower third(s) on V${track}${add ? " (a new track)" : ""}: ${rendered.map(({ third }) => `${third.name} at ${clock(third.at)}`).join(", ")}${failed.length ? `; ${failed.length} couldn't be rendered` : ""}`,
        result: {
          track: `V${track}`,
          ...(add ? { newTrack: true } : {}),
          seconds,
          look,
          thirds: rendered.map(({ third, path }) => ({ name: third.name, ...(third.title ? { title: third.title } : {}), at: third.at, file: path })),
          ...(view.width === undefined ? { note: `The ${noun}'s frame size wasn't known, so they were drawn for 1920x1080` } : {}),
          ...(failed.length ? { failed } : {}),
          ...(r.refused?.length ? { refused: r.refused.map((x) => x.reason) } : {}),
          next: `look_at_timeline at one of them to check it, or revert_timeline_edits lastStep=true to take them off`,
        },
      };
    },
  };
}

/** The ground rule the system prompt gains (Phase 18d). */
export const TITLE_INSTRUCTION = `- Lower thirds (names and titles on screen): add_lower_thirds, once per person, placed by speaker or
  time. Use the names and titles the user or the project notes give; ask for a title rather than invent one.`;
