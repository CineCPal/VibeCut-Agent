/**
 * What is said on the connected timeline, for the agent (PLAN.md, "Phase 6b"), ported from VibeCut's
 * hostTranscripts.ts / hostReview.ts: the transcript tools of src/vibecut/lib/contentTools.ts (verbatim)
 * over the connected timeline or its draft, cutting into the draft (draft.ts). Transcripts are the
 * `<media>.ivt-cache.json` files VibeCut's transcriber leaves next to each file (VibeCut's, its suite's
 * and this app's `transcribe` share them), read by Rust (transcript.rs). Speakers' names and roles the
 * agent saves are kept for the connection (useConnectionStore), as VibeCut keeps them.
 */
import { invoke } from "@tauri-apps/api/core";
import { runJob } from "../jobs";
import { useAgentStore } from "../../store/useAgentStore";
import { useConnectionStore } from "../../store/useConnectionStore";
import { useSystemStore } from "../../store/useSystemStore";
import type { NleHost } from "../../types/nle";
import type { HostTimeline } from "../../types/timeline";
import { removeRanges } from "../../vibecut/lib/connect/hostDraft";
import { lineExecutors, nextSpeakerInfo, silenceOptions, silencesOutcome, speakerEntry, speakerRolesOutcome, type LineTarget } from "../../vibecut/lib/contentTools";
import type { AudibleClip } from "../../vibecut/lib/silence";
import { resolveSpeaker, speakerIds, speakerStats } from "../../vibecut/lib/speakers";
import { withRemapPoints } from "../../vibecut/lib/timeRemap";
import { laneLines } from "../../vibecut/lib/transcriptLane";
import type { MediaAsset, SpeakerInfo } from "../../vibecut/types/media";
import type { Clip, Track } from "../../vibecut/types/timeline";
import type { TranscriptData } from "../../vibecut/types/transcript";
import type { WaveformPeaks } from "../../vibecut/types/waveform";
import { type Args, bool, type Executor, optStr, strArray, type ToolOutcome } from "./args";
import { connectedView, draftOf, draftSummary, openDraft } from "./draft";
import { TIMELINE_NOUN } from "./edits";
import { poolClipId } from "./projectTools";
import type { ToolContext, ToolDeclaration } from "./tools";

/** The Whisper model the agent transcribes with (VibeCut's agent uses "small" too). */
export const TRANSCRIBE_MODEL = "mlx-community/whisper-small-mlx";
/** VibeCut's MAX_CLIP_VOLUME (playback/envelope.ts): the loudest a clip's level can be, as a gain. */
const MAX_CLIP_VOLUME = 3;
const round2 = (n: number) => Math.round(n * 100) / 100;
const fileName = (path: string) => path.split(/[\\/]/).pop() || path;

/** A short, stable id for a file (FNV-1a): line ids carry it, so it is kept short. */
export function fileKey(path: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < path.length; i++) {
    hash ^= path.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `f${hash.toString(16).padStart(8, "0")}`;
}

// ----------------------------------------------------------------------------- the timeline as VibeCut's clips

export interface HostClips {
  tracks: Track[];
  clipsById: Record<string, Clip>;
  assetsById: Record<string, MediaAsset>;
  /** The clips whose sound is heard (on audio tracks that aren't muted), by id. */
  heard: Record<string, Clip>;
}

/**
 * The host timeline as VibeCut's tracks and clips, with the host's ids (VibeCut's `hostLintTimeline`):
 * a host's picture item never plays sound of its own (its sound is its own audio item), so only audio
 * clips with a file are heard. Switched-off clips and transitions are left out. Each file is one asset,
 * known by `fileKey`.
 */
export function hostClips(timeline: HostTimeline): HostClips {
  const assetsById: Record<string, MediaAsset> = {};
  const clipsById: Record<string, Clip> = {};
  const heard: Record<string, Clip> = {};
  const tracks: Track[] = [];
  const ordered = [
    ...timeline.tracks.filter((t) => t.type === "video").sort((a, b) => b.index - a.index),
    ...timeline.tracks.filter((t) => t.type === "audio").sort((a, b) => a.index - b.index),
  ];
  for (const host of ordered) {
    const type = host.type === "video" ? "video" : "audio";
    const muted = host.enabled === false;
    const track: Track = {
      id: `${type === "video" ? "V" : "A"}${host.index}`,
      type,
      name: `${type === "video" ? "V" : "A"}${host.index}`,
      order: tracks.length,
      clipIds: [],
      height: 0,
      ...(muted ? (type === "video" ? { enabled: false } : { muted: true }) : {}),
    };
    tracks.push(track);
    for (const c of host.clips) {
      if (!c.enabled || c.kind === "effect" || c.end <= c.start || !c.filePath) continue;
      const id = fileKey(c.filePath);
      assetsById[id] ??= { id, fileName: fileName(c.filePath), filePath: c.filePath, type: "video", durationSeconds: 86_400, hasAudio: true, createdAt: "" };
      const duration = c.end - c.start;
      const speed = Math.abs(c.speed ?? 1) || 1;
      const sourceIn = Math.max(0, c.sourceIn ?? 0);
      const volume = type === "video" ? 0 : c.volumeDb !== undefined ? Math.min(Math.pow(10, c.volumeDb / 20), MAX_CLIP_VOLUME) : undefined;
      let clip: Clip = {
        id: c.id,
        mediaAssetId: id,
        trackId: track.id,
        startTime: c.start,
        duration,
        sourceIn,
        sourceOut: sourceIn + duration * speed,
        name: c.name,
        ...(volume !== undefined && volume !== 1 ? { volume } : {}),
      };
      if (speed !== 1) clip = withRemapPoints(clip, [{ t: 0, s: sourceIn }, { t: duration, s: clip.sourceOut }]);
      clipsById[clip.id] = clip;
      track.clipIds.push(clip.id);
      if (type === "audio" && !muted && (clip.volume ?? 1) > 0) heard[clip.id] = clip;
    }
  }
  return { tracks, clipsById, assetsById, heard };
}

// ----------------------------------------------------------------------------- transcripts

/** A file's transcript (transcript.rs; null when it has none or the file changed since). */
export function readTranscript(mediaPath: string): Promise<TranscriptData | null> {
  return invoke<TranscriptData | null>("read_transcript", { mediaPath });
}

/** A transcript with the names and roles saved for its speakers this connection. */
export function withSpeakers(host: NleHost, path: string, data: TranscriptData): TranscriptData {
  const saved = useConnectionStore.getState().connections[host].speakerInfo[path];
  if (!saved) return data;
  const ids = new Set([...Object.keys(data.speakerInfo ?? {}), ...Object.keys(saved)]);
  return { ...data, speakerInfo: Object.fromEntries([...ids].map((id) => [id, { ...data.speakerInfo?.[id], ...saved[id] }])) };
}

interface HeardView {
  view: HostTimeline;
  clips: HostClips;
  /** By asset id (`fileKey`). */
  transcripts: Record<string, TranscriptData | undefined>;
  untranscribed: string[];
}

/** The connected timeline (or draft), what is heard on it, and those files' transcripts. */
async function heardView(context: ToolContext): Promise<HeardView> {
  const view = await connectedView(context);
  const clips = hostClips(view);
  const ids = [...new Set(Object.values(clips.heard).map((c) => c.mediaAssetId))];
  const transcripts: Record<string, TranscriptData | undefined> = {};
  const untranscribed: string[] = [];
  await Promise.all(
    ids.map(async (id) => {
      const path = clips.assetsById[id].filePath;
      const data = await readTranscript(path).catch(() => null);
      if (data && data.segments.length) transcripts[id] = withSpeakers(context.host, path, data);
      else untranscribed.push(clips.assetsById[id].fileName);
    }),
  );
  return { view, clips, transcripts, untranscribed: untranscribed.sort() };
}

/** The line tools' view of the connected timeline: its lines, and cuts into the draft. */
function lineTarget(context: ToolContext): LineTarget {
  return {
    lines: async () => {
      const { clips, transcripts, untranscribed } = await heardView(context);
      // Two channels of one recording at the same place give the same line id, so each line shows once.
      return { lines: laneLines(clips.heard, transcripts, clips.assetsById), untranscribed };
    },
    remove: async (cut) => {
      const before = await openDraft(context);
      const next = removeRanges(before, cut);
      useConnectionStore.getState().setDraft(context.host, next);
      return { removedSeconds: Math.max(0, before.duration - next.duration), note: ` in the draft (send_to_${context.host} makes the new ${TIMELINE_NOUN[context.host]})`, result: draftSummary(next) };
    },
    fix: "transcribe_clips",
  };
}

// ----------------------------------------------------------------------------- the tools

/** The files of these clip ids: clips of the connected timeline (or draft), or pool clips ("p3"). */
export async function filesOf(context: ToolContext, ids: string[]): Promise<string[]> {
  const view = await connectedView(context);
  const onTimeline = new Map(view.tracks.flatMap((t) => t.clips.map((c) => [c.id, c.filePath] as const)));
  const pool = useConnectionStore.getState().connections[context.host].pool;
  return ids.map((ref) => {
    if (onTimeline.has(ref)) {
      const path = onTimeline.get(ref);
      if (!path) throw new Error(`Clip ${ref} has no media file (a title, transition or nested ${TIMELINE_NOUN[context.host]})`);
      return path;
    }
    const clip = pool?.clips.find((c) => c.id === poolClipId(context.host, ref));
    if (clip?.filePath) return clip.filePath;
    throw new Error(`There's no clip ${ref} on the connected ${TIMELINE_NOUN[context.host]} or in the project (the snapshot lists both)`);
  });
}

/** Whether the user's own messages in this conversation talk about who is who (VibeCut's
 * `userSpokeAboutSpeakers`): `confirmedByUser` is only the model's claim. */
export function userSpokeAboutSpeakers(names: string[]): boolean {
  const said = useAgentStore
    .getState()
    .messages.filter((m) => m.role === "user")
    .map((m) => m.text.toLowerCase());
  const words = /\b(speakers?|interviewer|interviewee|subject|host|guest)\b/;
  return said.some((t) => words.test(t) || names.some((n) => n.length > 1 && t.includes(n.toLowerCase())));
}

interface TranscribedFile {
  path: string;
  fromCache: boolean;
  speakers: string[];
  segmentCount: number;
}

export function transcriptExecutors(context: ToolContext): Record<string, Executor> {
  const { host } = context;
  const lines = lineExecutors(lineTarget(context));

  /** Each transcribed file heard on the timeline, by path, with its speakers' saved names and roles. */
  const heardTranscripts = async (): Promise<Map<string, TranscriptData>> => {
    const { clips, transcripts } = await heardView(context);
    const out = new Map<string, TranscriptData>();
    for (const [id, data] of Object.entries(transcripts)) if (data) out.set(clips.assetsById[id].filePath, data);
    return out;
  };

  return {
    ...lines,

    get_transcript: async (args) => {
      const ref = optStr(args, "clipId") ?? optStr(args, "filePath");
      if (!ref) return lines.get_transcript(args);
      // One file's transcript, in the file's own time.
      const path = ref.startsWith("/") ? ref : (await filesOf(context, [ref]))[0];
      const data = await readTranscript(path);
      if (!data || !data.segments.length) throw new Error(`${fileName(path)} has no transcript yet; transcribe_clips makes one`);
      const named = withSpeakers(host, path, data);
      const off = new Set(named.excludedSpeakers);
      const segments = named.segments
        .filter((s) => !off.has(s.speaker))
        .map((s) => {
          const who = resolveSpeaker(named, s.speaker);
          return { start: round2(s.start), end: round2(s.end), speaker: who.name, ...(who.role ? { role: who.role } : {}), text: s.text };
        });
      return {
        summary: `Read ${segments.length} line(s) of ${fileName(path)}'s transcript`,
        result: { file: path, segments, note: "Times are seconds in the file (sourceIn/sourceOut for add_clips), not on the timeline." },
      };
    },

    transcribe_clips: async (args) => {
      const ids = args.clipIds === undefined ? [] : strArray(args, "clipIds");
      const given = args.filePaths === undefined ? [] : strArray(args, "filePaths");
      const files = [...new Set([...(await filesOf(context, ids)), ...given])];
      if (!files.length) throw new Error("Give clipIds (timeline or project clips) or filePaths");
      const haveToken = useSystemStore.getState().keys?.huggingface ?? false;
      const speakers = args.speakers === undefined ? haveToken : bool(args, "speakers");
      if (speakers && !haveToken) {
        throw new Error("Telling speakers apart needs a Hugging Face token (Settings → API keys). Transcribe with speakers: false, or ask the user to add the token.");
      }
      const job = await runJob("transcribe", `Transcribe ${files.length} file(s)`, {
        videos: files,
        model: TRANSCRIBE_MODEL,
        diarize: speakers,
        format: "txt",
        force: bool(args, "force"),
      });
      const result = (job?.result ?? {}) as { files?: TranscribedFile[]; failed?: { path: string; message: string }[] };
      const done = result.files ?? [];
      if (!done.length) throw new Error(job?.error ?? result.failed?.[0]?.message ?? "Transcription didn't finish");
      return {
        summary: `Transcribed ${done.length} file(s)${done.some((f) => f.fromCache) ? ` (${done.filter((f) => f.fromCache).length} already were)` : ""}${result.failed?.length ? `; ${result.failed.length} failed` : ""}`,
        result: { files: done.map((f) => ({ path: f.path, fromCache: f.fromCache, speakers: f.speakers, lines: f.segmentCount })), ...(result.failed?.length ? { failed: result.failed } : {}) },
      };
    },

    list_speakers: async (args) => {
      const byFile = await heardTranscripts();
      const requested = args.files === undefined ? null : strArray(args, "files");
      const unknown = (requested ?? []).filter((f) => !byFile.has(f));
      if (unknown.length) throw new Error(`Not a transcribed file heard on the ${TIMELINE_NOUN[host]}: ${unknown.join(", ")}`);
      const files = [...byFile]
        .filter(([path]) => !requested || requested.includes(path))
        .map(([path, data]) => {
          const stats = speakerStats(data);
          return {
            file: path,
            fileName: fileName(path),
            speakers: speakerIds(data)
              .filter((id) => stats.has(id))
              .map((id) => {
                const who = resolveSpeaker(data, id);
                const st = stats.get(id)!;
                return {
                  speakerId: id,
                  name: who.name,
                  ...(who.role ? { role: who.role, ...(who.inferred ? { roleGuessed: true } : {}) } : {}),
                  lines: st.lines,
                  seconds: round2(st.seconds),
                  questionShare: round2(st.questionShare),
                  wordsPerLine: Math.round(st.wordsPerLine),
                  samples: st.samples,
                };
              }),
          };
        });
      const single = files.filter((f) => f.speakers.length === 1).length;
      return {
        summary: `Listed the speakers of ${files.length} transcript(s).`,
        result: {
          files,
          ...(single ? { note: `${single} transcript(s) have one speaker, likely transcribed without telling speakers apart; transcribe_clips with speakers: true and force: true does.` } : {}),
        },
      };
    },

    set_speaker_roles: async (args) => {
      const raw = args.speakers;
      if (!Array.isArray(raw) || raw.length === 0) throw new Error("speakers must be a non-empty array");
      const claimed = bool(args, "confirmedByUser");
      const names = raw.flatMap((e) => (typeof e === "object" && e !== null ? [String((e as Args).speakerId ?? ""), String((e as Args).name ?? "")] : []));
      const confirmed = claimed && userSpokeAboutSpeakers(names);
      const byFile = await heardTranscripts();
      const updates = new Map<string, Record<string, SpeakerInfo>>();
      const kept: string[] = [];
      const done: string[] = [];
      for (const [i, entry] of raw.entries()) {
        if (typeof entry !== "object" || entry === null) throw new Error(`speakers[${i}] must be an object`);
        const e = entry as Args;
        const file = optStr(e, "file") ?? "";
        const data = byFile.get(file);
        if (!data) throw new Error(`speakers[${i}].file is not a transcribed file heard on the ${TIMELINE_NOUN[host]} (list_speakers gives them)`);
        const speakerId = optStr(e, "speakerId") ?? "";
        if (!speakerIds(data).includes(speakerId)) throw new Error(`${fileName(file)} has no speaker "${speakerId}" (it has: ${speakerIds(data).join(", ")})`);
        const { role, name } = speakerEntry(e, i);
        const current = { ...data.speakerInfo?.[speakerId], ...updates.get(file)?.[speakerId] };
        const next = nextSpeakerInfo(current, role, name, confirmed);
        if (!next) {
          kept.push(`${speakerId} in ${fileName(file)} stays ${current.role} (set by the user)`);
          continue;
        }
        updates.set(file, { ...updates.get(file), [speakerId]: next });
        done.push(`${name ?? current.name ?? speakerId}${role ? ` = ${role}` : ""} (${fileName(file)})`);
      }
      for (const [file, bySpeaker] of updates) useConnectionStore.getState().setSpeakerInfo(host, file, bySpeaker);
      return speakerRolesOutcome(done, kept, claimed, confirmed) as ToolOutcome;
    },

    find_silences: async (args) => {
      const options = silenceOptions(args);
      const { clips } = await heardView(context);
      const heard = Object.values(clips.heard);
      const paths = [...new Set(heard.map((c) => clips.assetsById[c.mediaAssetId].filePath))];
      if (!paths.length) throw new Error(`Nothing is heard on the ${TIMELINE_NOUN[host]}: no sound clips with a file`);
      const job = await runJob("audio-peaks", `Measure the sound of ${paths.length} file(s)`, { paths: paths.slice(0, 64) });
      const result = (job?.result ?? {}) as { peaks?: Record<string, WaveformPeaks>; failed?: { path: string; message: string }[] };
      const peaks = result.peaks ?? {};
      const failures = (result.failed ?? []).map((f) => `${fileName(f.path)}: ${f.message}`);
      const audible: AudibleClip[] = heard.flatMap((clip) => {
        const levels = peaks[clips.assetsById[clip.mediaAssetId].filePath];
        return levels ? [{ clip, peaks: levels }] : [];
      });
      if (audible.length === 0) throw new Error(`Could not read the sound of any clip${failures.length ? ` (${failures[0]})` : job?.error ? ` (${job.error})` : ""}`);
      return silencesOutcome(audible, options, failures) as ToolOutcome;
    },
  };
}

// ----------------------------------------------------------------------------- declarations (VibeCut's, for a connected editor)

const DRAFT_NOTE = "The cut is made in the draft (opened from the connected timeline if there isn't one) and the rest closes up; send the draft to make the new timeline.";

export function transcriptToolDeclarations(host: NleHost): ToolDeclaration[] {
  const noun = TIMELINE_NOUN[host];
  return [
    {
      name: "get_transcript",
      description: `Without clipId: reads what is said on the connected ${noun} (or the draft): the transcript lines of every sound clip, in ${noun} time order, with speaker, the speaker's role when known (roleGuessed when it is a guess) and a line id for remove_transcript_lines. Filter by time range, speaker and/or role; results are paged (use nextOffset). includeWords adds each word's ${noun} time. Files with no transcript are listed in untranscribedFiles. With clipId (a clip on the ${noun}, or a project clip "p3") or filePath: that file's transcript, in seconds of the file (use them as sourceIn/sourceOut with add_clips), for footage that isn't on the ${noun}.`,
      parameters: {
        type: "OBJECT",
        properties: {
          clipId: { type: "STRING", description: `A clip id from the ${noun}'s snapshot, or a project clip's short id ("p3"). Optional.` },
          filePath: { type: "STRING", description: "An absolute media file path. Optional." },
          startTime: { type: "NUMBER", description: `Only lines ending after this ${noun} time. Optional.` },
          endTime: { type: "NUMBER", description: `Only lines starting before this ${noun} time. Optional.` },
          speaker: { type: "STRING", description: "Only this speaker's lines (display name, case-insensitive). Optional." },
          role: { type: "STRING", description: "Only lines of speakers with this role: interviewer, subject, other, or none. Optional." },
          offset: { type: "NUMBER", description: "Skip this many lines (paging). Optional." },
          limit: { type: "NUMBER", description: "At most this many lines (default 200, max 500). Optional." },
          includeWords: { type: "BOOLEAN", description: "Also return per-word timings. Larger result: use a time range with it. Optional." },
        },
      },
    },
    {
      name: "transcribe_clips",
      description: `Transcribes media files on this Mac (Whisper; Apple Silicon), saving each transcript next to its file, where VibeCut and this app both read it. Give clipIds (clips on the ${noun}, or project clips like "p3") and/or filePaths. speakers tells speakers apart (default: on when a Hugging Face token is set). Slow (a few minutes for long interviews; the first run downloads the model), so ask first unless the user asked. Files already transcribed are reused unless force.`,
      parameters: {
        type: "OBJECT",
        properties: {
          clipIds: { type: "ARRAY", items: { type: "STRING" } },
          filePaths: { type: "ARRAY", items: { type: "STRING" } },
          speakers: { type: "BOOLEAN", description: "Tell speakers apart. Optional." },
          force: { type: "BOOLEAN", description: "Transcribe again, e.g. to add word timings or tell speakers apart. Optional." },
        },
      },
    },
    {
      name: "search_transcript",
      description: `Finds transcript lines on the connected ${noun} (or the draft) containing every word of the query (case-insensitive). Returns up to 50 lines with ${noun} times and line ids. When the query occurs word for word in a line with word timings, phraseRanges gives its exact span: pass those to remove_time_ranges to cut just the phrase.`,
      parameters: { type: "OBJECT", properties: { query: { type: "STRING" } }, required: ["query"] },
    },
    {
      name: "remove_transcript_lines",
      description: `Cuts the given transcript lines (ids from get_transcript/search_transcript) out of every track. ${DRAFT_NOTE} Line ids change after any cut, so fetch fresh ids before cutting again. Prefer this over remove_time_ranges for content-based cuts: the line bounds are exact.`,
      parameters: { type: "OBJECT", properties: { lineIds: { type: "ARRAY", items: { type: "STRING" } } }, required: ["lineIds"] },
    },
    {
      name: "remove_speaker_lines",
      description: `Cuts every line of a role (e.g. interviewer) or speaker in one call, with the pauses around them, so the kept answers close up; a kept speaker's words are never cut into. ${DRAFT_NOTE} keepLineIds keeps specific lines (e.g. a question an answer needs).`,
      parameters: {
        type: "OBJECT",
        properties: {
          role: { type: "STRING", description: "interviewer, subject, other or none. Give role or speaker." },
          speaker: { type: "STRING", description: "A speaker's display name. Give role or speaker." },
          startTime: { type: "NUMBER", description: `Only lines within this ${noun} range. Optional.` },
          endTime: { type: "NUMBER", description: "Optional." },
          keepLineIds: { type: "ARRAY", items: { type: "STRING" }, description: "Lines to keep. Optional." },
        },
      },
    },
    {
      name: "find_filler_words",
      description: `Finds filler words by their word timings (by default um, uh, erm, er, ah, hmm, mm, mhm) and returns each occurrence's ${noun} range. Pass fillers to look for other words or phrases instead (e.g. ["you know", "like"], only when the user asks). Only finds them: pass the ranges you want gone to remove_time_ranges in one call. Lines without word timings are counted in linesWithoutWordTimings.`,
      parameters: {
        type: "OBJECT",
        properties: {
          fillers: { type: "ARRAY", items: { type: "STRING" }, description: "Words or phrases to find. Optional." },
          startTime: { type: "NUMBER", description: `Only from this ${noun} time. Optional.` },
          endTime: { type: "NUMBER", description: `Only up to this ${noun} time. Optional.` },
        },
      },
    },
    {
      name: "find_silences",
      description: `Measures the sound clips heard on the connected ${noun} (or the draft) and returns the stretches where everything is quieter than a threshold for at least a minimum duration (dead air, long pauses), shrunk by a short handle at each end so a cut won't clip neighbouring words. Only finds them: pass the ranges you want gone to remove_time_ranges. Gaps with no sound clip are not reported.`,
      parameters: {
        type: "OBJECT",
        properties: {
          minDurationSeconds: { type: "NUMBER", description: "Shortest pause worth reporting. Default 0.7." },
          thresholdDb: { type: "NUMBER", description: "Silence threshold in dBFS. Default -40; use -35 for noisy rooms, -50 for very quiet ones." },
          handleSeconds: { type: "NUMBER", description: "Kept at each end of a pause. Default 0.1." },
          startTime: { type: "NUMBER", description: `Only look from this ${noun} time. Optional.` },
          endTime: { type: "NUMBER", description: `Only look up to this ${noun} time. Optional.` },
        },
      },
    },
    {
      name: "list_speakers",
      description: `Lists who speaks in each transcribed file heard on the connected ${noun}: speaker id, name, role (interviewer/subject/other, roleGuessed when unconfirmed) and the numbers that tell an interviewer apart (lines, seconds talked, questionShare: share of lines ending in "?", wordsPerLine) plus sample lines.`,
      parameters: { type: "OBJECT", properties: { files: { type: "ARRAY", items: { type: "STRING" }, description: "Only these files (paths from an earlier list_speakers). Optional." } } },
    },
    {
      name: "set_speaker_roles",
      description: "Saves speakers' roles and/or names (file and speakerId from list_speakers) for this session, so the transcript tools and remove_speaker_lines know who the interviewer is. Saved as a guess unless confirmedByUser. A role the user set is only replaced with confirmedByUser.",
      parameters: {
        type: "OBJECT",
        properties: {
          speakers: {
            type: "ARRAY",
            items: {
              type: "OBJECT",
              properties: {
                file: { type: "STRING", description: "The file's path, from list_speakers." },
                speakerId: { type: "STRING" },
                role: { type: "STRING", description: "interviewer, subject or other. Optional." },
                name: { type: "STRING", description: 'The person\'s real name, only when the user or the transcript gives it ("I\'m Ana"). Never a role or a description such as "Interviewer". Optional.' },
              },
              required: ["file", "speakerId"],
            },
          },
          confirmedByUser: { type: "BOOLEAN", description: "True only when the user's own message said who is who. Optional." },
        },
        required: ["speakers"],
      },
    },
  ];
}

export function transcriptInstruction(host: NleHost): string {
  const noun = TIMELINE_NOUN[host];
  return `- What is said: get_transcript reads the transcript lines of what is heard on the ${noun} (or the
  draft), in its time, with line ids; with clipId or filePath it reads one file's transcript in the
  file's own time, for footage not on the ${noun} yet. search_transcript finds a topic or phrase.
  Transcripts are saved next to each media file; a file without one is listed in untranscribedFiles,
  and transcribe_clips makes them (slow: ask first unless the user asked).
- Tightening ("cut the ums", "remove the dead air"): find_filler_words and find_silences only find;
  pass every range you want gone to ONE remove_time_ranges call (later times shift after a cut).
  remove_transcript_lines cuts whole lines by id. These cuts go into the draft.
- Interviews: list_speakers tells the interviewer apart (questions, short lines); set_speaker_roles saves
  who is who (as a guess unless the user said so). remove_speaker_lines drops every line of a role,
  e.g. the interviewer's questions, with keepLineIds for ones an answer needs.
- Building a cut from interviews not yet on a ${noun}: transcribe_clips, read each file's transcript
  (get_transcript with clipId), choose the soundbites, create_timeline, then add_clips each soundbite
  in order (path, sourceIn/sourceOut from the transcript, at = where the previous one ends).
- A camera filmed with a separate recorder: transcribe the RECORDER's file (the better sound), and
  sync_and_place them before cutting.`;
}

/** Whether a draft is open on this editor (for the snapshot and the chat's draft bar). */
export const hasDraft = (host: NleHost) => draftOf(host) !== null;
