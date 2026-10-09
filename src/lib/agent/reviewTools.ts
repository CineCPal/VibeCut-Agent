/**
 * The agent checks its work (PLAN.md, "Phase 14a"): `review_edit` runs VibeCut's edit lint (editLint.ts,
 * verbatim: black, flash frames, cuts inside a word, level jumps, clipping, picture and sound out of
 * sync) over the connected timeline or its draft, ported from VibeCut's hostReview.ts, plus the checks
 * a delivery needs: offline media, switched-off clips and tracks, stray clips past the end, picture with
 * no sound under it, and (when given a target) clips off a loudness target or peaking too high.
 *
 * With `visual` (the default, Phase 14b), the vision critic looks too: the `critique` sidecar job, a
 * separate call to the chat's own provider and model that sees stills either side of every cut (VibeCut's
 * editReview.ts `sampleFrames`) with what is said there, and gives a picture editor's notes. It's a fresh
 * context on purpose, so the agent doesn't defend its own cut, and its stills never enter the chat.
 *
 * It only reports. Each finding names the clip ids the edit tools take, and the card shows them as
 * timeline positions the user can jump to.
 */
import { runJob } from "../jobs";
import { useAgentStore } from "../../store/useAgentStore";
import { useConnectionStore } from "../../store/useConnectionStore";
import { useSystemStore } from "../../store/useSystemStore";
import { AI_CHOICES } from "../../types/agent";
import type { NleHost } from "../../types/nle";
import type { HostTimeline } from "../../types/timeline";
import { lintEdit, visibleVideo, type LintFinding, type LintInput } from "../../vibecut/lib/editLint";
import { linkGroups } from "../../vibecut/lib/connect/hostDraft";
import { speakerTag } from "../../vibecut/lib/speakers";
import { sourceAtOffset, withRemapPoints } from "../../vibecut/lib/timeRemap";
import { laneLines, type LaneLine } from "../../vibecut/lib/transcriptLane";
import type { ExportVideoSegment } from "../../vibecut/types/export";
import type { MediaAsset } from "../../vibecut/types/media";
import type { Clip, Track } from "../../vibecut/types/timeline";
import type { TranscriptData, TranscriptWord } from "../../vibecut/types/transcript";
import type { WaveformPeaks } from "../../vibecut/types/waveform";
import { type Args, bool, clock, type Executor, optNum, optStr, type ToolFinding, type ToolOutcome } from "./args";
import { measure, MAX_MEASURED, soundBetween } from "./audioTools";
import { connectedView } from "./draft";
import { timelineLines } from "./snapshot";
import { fileKey, readTranscript, withSpeakers } from "./transcriptTools";
import type { ToolContext, ToolDeclaration } from "./tools";

const NOUN: Record<NleHost, string> = { premiere: "sequence", resolve: "timeline" };
/** VibeCut's MAX_CLIP_VOLUME (playback/envelope.ts). */
const MAX_CLIP_VOLUME = 3;
const round2 = (n: number) => Math.round(n * 100) / 100;
const fileName = (path: string) => path.split(/[\\/]/).pop() || path;

export type Severity = "high" | "medium" | "low";
export type DeliveryCategory = "offline" | "switched_off" | "past_end" | "no_sound" | "loudness" | "true_peak";

/** A finding from the automatic check: the lint's, or a delivery check's. */
export interface CheckFinding {
  time: number;
  end?: number;
  severity: Severity;
  category: LintFinding["category"] | DeliveryCategory;
  message: string;
  clipIds: string[];
}

export const REVIEW_LIMITS = {
  /** Picture with no sound under it for this long (seconds) is reported. */
  noSoundSeconds: 1,
  /** A clip starting this long after everything else has ended is a stray past the end. */
  strayGapSeconds: 2,
  /** A clip this many LU off the loudness target is reported. */
  loudnessToleranceLu: 1,
  /** A true peak (after the clip's level) over this is reported. */
  maxTruePeakDb: -1,
  maxFindings: 60,
} as const;

// ----------------------------------------------------------------------------- the lint's view

/**
 * The lint's view of a host timeline (VibeCut's `hostLintTimeline`): the host's tracks and clips one to
 * one, with the host's ids (topmost video track first). Clips the editor links become one link group.
 * A host's picture item never plays sound (its sound is its own audio item), so video clips are silent.
 * Switched-off clips, transitions and adjustment layers are left out; a title or nested timeline counts
 * as picture, with no file. Each file is one asset, known by `fileKey`. `syncOffsets["<picture>|<sound>"]`
 * are the offsets found for separate recordings (camera time = recording time + offset).
 */
export function lintTimeline(timeline: HostTimeline, syncOffsets: Record<string, number> = {}): LintInput {
  const groups = linkGroups(timeline);
  const assetsById: Record<string, MediaAsset> = {};
  const offline = new Set<string>();
  const clipsById: Record<string, Clip> = {};
  const tracks: Track[] = [];
  const blank = { type: "video" as const, durationSeconds: 86_400, createdAt: "" };

  const assetFor = (path: string | undefined, clipId: string): MediaAsset => {
    if (!path) {
      const id = `none:${clipId}`;
      return (assetsById[id] ??= { ...blank, id, fileName: "", filePath: id, hasAudio: false });
    }
    const id = fileKey(path);
    return (assetsById[id] ??= { ...blank, id, fileName: fileName(path), filePath: path, hasAudio: true });
  };

  const ordered = [
    ...timeline.tracks.filter((t) => t.type === "video").sort((a, b) => b.index - a.index),
    ...timeline.tracks.filter((t) => t.type === "audio").sort((a, b) => a.index - b.index),
  ];
  for (const host of ordered) {
    const type = host.type === "video" ? "video" : "audio";
    const track: Track = {
      id: `${type === "video" ? "V" : "A"}${host.index}`,
      type,
      name: `${type === "video" ? "V" : "A"}${host.index}`,
      order: tracks.length,
      clipIds: [],
      height: 0,
      ...(host.enabled === false ? (type === "video" ? { enabled: false } : { muted: true }) : {}),
    };
    tracks.push(track);
    for (const c of host.clips) {
      if (!c.enabled || c.kind === "effect" || c.end <= c.start) continue;
      if (type === "audio" && !c.filePath) continue;
      const asset = assetFor(c.filePath, c.id);
      if (c.offline) offline.add(asset.id);
      const duration = c.end - c.start;
      const speed = Math.abs(c.speed ?? 1) || 1;
      const sourceIn = Math.max(0, c.sourceIn ?? 0);
      const volume = type === "video" ? 0 : c.volumeDb !== undefined ? Math.min(Math.pow(10, c.volumeDb / 20), MAX_CLIP_VOLUME) : undefined;
      let clip: Clip = {
        id: c.id,
        mediaAssetId: asset.id,
        trackId: track.id,
        startTime: c.start,
        duration,
        sourceIn,
        sourceOut: sourceIn + duration * speed,
        name: c.name,
        ...(volume !== undefined && volume !== 1 ? { volume } : {}),
        ...(groups.has(c.id) ? { linkId: `link:${groups.get(c.id)}` } : {}),
      };
      if (speed !== 1) clip = withRemapPoints(clip, [{ t: 0, s: sourceIn }, { t: duration, s: clip.sourceOut }]);
      clipsById[clip.id] = clip;
      track.clipIds.push(clip.id);
    }
  }

  // Separate recordings synced on this connection: on the picture's asset, as VibeCut keeps them.
  for (const [pair, offset] of Object.entries(syncOffsets)) {
    const [picturePath, soundPath] = pair.split("|");
    const picture = assetsById[fileKey(picturePath)];
    const sound = assetsById[fileKey(soundPath ?? "")];
    if (!picture || !sound || picture === sound) continue;
    picture.syncedAudio = [{ assetId: sound.id, offset, method: "waveform" }, ...(picture.syncedAudio ?? []).filter((s) => s.assetId !== sound.id)];
  }

  return { tracks, clipsById, assetsById, offline, frameRate: timeline.fps > 0 ? timeline.fps : 25 };
}

/** A cut inside a word only counts where it is heard: on a sound clip, not on a picture alone. */
export const heardFinding = (input: LintInput) => (finding: LintFinding) =>
  finding.category !== "mid_word_cut" || finding.clipIds.some((id) => input.tracks.find((t) => t.id === input.clipsById[id]?.trackId)?.type === "audio");

/** Words and waveform peaks for the files heard on the timeline, best effort: a file that can't be
 * read is just left out of the checks that need it. The transcripts come back too (with the speakers'
 * saved names), for the critic. */
export async function withWordsAndPeaks(input: LintInput, host: NleHost): Promise<{ input: LintInput; transcripts: Record<string, TranscriptData | undefined> }> {
  const audio = new Set(input.tracks.filter((t) => t.type === "audio").flatMap((t) => t.clipIds.map((id) => input.clipsById[id]?.mediaAssetId)));
  const assets = [...audio].map((id) => (id ? input.assetsById[id] : undefined)).filter((a): a is MediaAsset => Boolean(a) && !input.offline?.has(a!.id));
  const transcripts: Record<string, TranscriptData | undefined> = {};
  if (!assets.length) return { input, transcripts };
  const wordsByAssetId: Record<string, TranscriptWord[]> = {};
  const peaksByAssetId: Record<string, WaveformPeaks> = {};
  const [peaksJob] = await Promise.all([
    runJob("audio-peaks", `Measure the sound of ${assets.length} file(s)`, { paths: assets.slice(0, 64).map((a) => a.filePath) }).catch(() => null),
    ...assets.map(async (asset) => {
      const transcript = await readTranscript(asset.filePath).catch(() => null);
      if (transcript?.segments.length) transcripts[asset.id] = withSpeakers(host, asset.filePath, transcript);
      const words = transcript?.segments.flatMap((s) => s.words ?? []) ?? [];
      if (words.length) wordsByAssetId[asset.id] = words;
    }),
  ]);
  const peaks = ((peaksJob?.result ?? {}) as { peaks?: Record<string, WaveformPeaks> }).peaks ?? {};
  for (const asset of assets) if (peaks[asset.filePath]) peaksByAssetId[asset.id] = peaks[asset.filePath];
  return { input: { ...input, wordsByAssetId, peaksByAssetId }, transcripts };
}

// ----------------------------------------------------------------------------- delivery checks

interface Span {
  start: number;
  end: number;
}

/** The union of `spans`, sorted. */
function merged(spans: Span[]): Span[] {
  const out: Span[] = [];
  for (const s of [...spans].sort((a, b) => a.start - b.start)) {
    const last = out[out.length - 1];
    if (last && s.start <= last.end + 1e-6) last.end = Math.max(last.end, s.end);
    else out.push({ ...s });
  }
  return out;
}

/** The parts of `within` no span in `covered` reaches. */
function gaps(within: Span, covered: Span[]): Span[] {
  const out: Span[] = [];
  let at = within.start;
  for (const c of merged(covered)) {
    if (c.end <= at) continue;
    if (c.start >= within.end) break;
    if (c.start > at) out.push({ start: at, end: c.start });
    at = Math.max(at, c.end);
  }
  if (at < within.end) out.push({ start: at, end: within.end });
  return out;
}

/**
 * The checks a delivery needs that the lint doesn't make, over `range` of the timeline: offline media,
 * switched-off clips and tracks with clips on them, clips stranded past the end, and picture with no
 * sound under it. Pure, so the tests give it timelines directly.
 */
export function deliveryChecks(view: HostTimeline, range: Span = { start: 0, end: view.duration }): CheckFinding[] {
  const findings: CheckFinding[] = [];
  const inRange = (c: { start: number; end: number }) => c.end > range.start && c.start < range.end;
  const media = view.tracks.flatMap((t) => t.clips.filter((c) => c.kind !== "effect" && c.end > c.start).map((c) => ({ c, t })));

  for (const { c, t } of media) {
    if (!inRange(c)) continue;
    const track = `${t.type === "video" ? "V" : "A"}${t.index}`;
    if (c.offline && c.enabled) {
      findings.push({ time: round2(c.start), end: round2(c.end), severity: "high", category: "offline", message: `${c.name} on ${track} is offline: its media is missing, so it plays as ${t.type === "video" ? "a red frame or black" : "silence"}.`, clipIds: [c.id] });
    } else if (!c.enabled) {
      findings.push({ time: round2(c.start), end: round2(c.end), severity: "low", category: "switched_off", message: `${c.name} on ${track} is switched off, so it won't be in the export. Delete it or switch it on.`, clipIds: [c.id] });
    }
  }

  for (const t of view.tracks) {
    const clips = t.clips.filter((c) => c.enabled && c.kind !== "effect" && inRange(c));
    if (t.enabled !== false || !clips.length || t.type === "subtitle") continue;
    const track = `${t.type === "video" ? "V" : "A"}${t.index}`;
    findings.push({
      time: round2(Math.max(range.start, Math.min(...clips.map((c) => c.start)))),
      severity: "medium",
      category: "switched_off",
      message: `Track ${track} is switched off with ${clips.length} clip(s) on it, so ${t.type === "video" ? "its picture" : "its sound"} won't be in the export.`,
      clipIds: clips.slice(0, 8).map((c) => c.id),
    });
  }

  // Strays: a short last stretch of clips well after the rest of the edit has ended. A long stretch
  // after a pause is the edit going on, not a stray.
  const live = media.filter(({ c, t }) => c.enabled && t.enabled !== false);
  const blocks = merged(live.map(({ c }) => ({ start: c.start, end: c.end })));
  if (blocks.length > 1) {
    const last = blocks[blocks.length - 1];
    const before = blocks[blocks.length - 2].end;
    const edit = before - blocks[0].start;
    if (last.start - before >= REVIEW_LIMITS.strayGapSeconds && last.end - last.start <= Math.max(10, edit * 0.2) && inRange(last)) {
      const tail = live.filter(({ c }) => c.start >= last.start - 1e-6);
      findings.push({
        time: round2(last.start),
        severity: "medium",
        category: "past_end",
        message: `${tail.length} clip(s) sit ${clock(last.start - before)} after the rest of the edit ends (${clock(before)}), so the export runs on through black to ${clock(last.end)}.`,
        clipIds: tail.slice(0, 8).map(({ c }) => c.id),
      });
    }
  }

  // Picture with nothing heard under it. Black stretches are the lint's; this is the opposite case.
  const span = (t: HostTimeline["tracks"][number]) =>
    t.clips.filter((c) => c.enabled && !c.offline && c.kind !== "effect" && c.end > c.start).map((c) => ({ start: Math.max(c.start, range.start), end: Math.min(c.end, range.end) }));
  const picture = merged(view.tracks.filter((t) => t.type === "video" && t.enabled !== false).flatMap(span)).filter((s) => s.end > s.start);
  const sound = view.tracks.filter((t) => t.type === "audio" && t.enabled !== false).flatMap((t) => span({ ...t, clips: t.clips.filter((c) => c.filePath && (c.volumeDb ?? 0) > -60) }));
  if (sound.length) {
    for (const p of picture) {
      for (const g of gaps(p, sound)) {
        const length = g.end - g.start;
        if (length < REVIEW_LIMITS.noSoundSeconds) continue;
        findings.push({
          time: round2(g.start),
          end: round2(g.end),
          severity: length >= 3 ? "medium" : "low",
          category: "no_sound",
          message: `No sound from ${clock(g.start)} to ${clock(g.end)} under the picture: dead air, unless it's meant to be silent.`,
          clipIds: [],
        });
      }
    }
  }
  return findings;
}

/** Clips more than the tolerance off `target` (after their level), and true peaks over the ceiling. */
export function loudnessFindings(
  rows: { clipId: string; name: string; time: number; levelDb: number; integratedLufs: number | null; truePeakDb: number | null }[],
  target: number,
): CheckFinding[] {
  const out: CheckFinding[] = [];
  for (const r of rows) {
    if (r.integratedLufs !== null) {
      const plays = round2(r.integratedLufs + r.levelDb);
      const off = plays - target;
      if (Math.abs(off) > REVIEW_LIMITS.loudnessToleranceLu) {
        out.push({
          time: round2(r.time),
          severity: Math.abs(off) >= 4 ? "medium" : "low",
          category: "loudness",
          message: `${r.name} plays at about ${plays.toFixed(1)} LUFS, ${Math.abs(off).toFixed(1)} LU ${off > 0 ? "over" : "under"} the ${target} LUFS target (normalize_loudness levels it).`,
          clipIds: [r.clipId],
        });
      }
    }
    if (r.truePeakDb !== null && r.truePeakDb + r.levelDb > REVIEW_LIMITS.maxTruePeakDb) {
      const peak = round2(r.truePeakDb + r.levelDb);
      out.push({
        time: round2(r.time),
        severity: peak > 0 ? "high" : "medium",
        category: "true_peak",
        message: `${r.name} peaks at about ${peak.toFixed(1)} dBTP after its level, over the ${REVIEW_LIMITS.maxTruePeakDb} dBTP most platforms allow.`,
        clipIds: [r.clipId],
      });
    }
  }
  return out;
}

const SEVERITY_ORDER: Record<Severity, number> = { high: 0, medium: 1, low: 2 };

/** All findings in timeline order, the most severe kept when there are too many. */
export function ordered(findings: CheckFinding[]): CheckFinding[] {
  const kept = findings.length > REVIEW_LIMITS.maxFindings ? [...findings].sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] || a.time - b.time).slice(0, REVIEW_LIMITS.maxFindings) : findings;
  return [...kept].sort((a, b) => a.time - b.time || SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);
}

// ----------------------------------------------------------------------------- the critic's stills and words

/** At most this many stills go to the critic in one review (the sidecar takes up to 32). */
export const MAX_REVIEW_FRAMES = 24;
/** A shot longer than this also gets a still from its middle, when the budget allows. */
const MID_FRAME_MIN_SECONDS = 4;
const MAX_TRANSCRIPT_CHARS = 12_000;

export interface TimeWindow {
  start: number;
  end: number;
}

export interface ReviewFrame {
  path: string;
  /** Seconds in the source file. */
  sourceTime: number;
  /** Seconds on the timeline. */
  time: number;
  label: string;
}

const inWindow = (s: ExportVideoSegment, window?: TimeWindow) => !window || (s.timelineStart < window.end && s.timelineStart + s.duration > window.start);

/**
 * The stills the critic sees (VibeCut's editReview.ts, verbatim): for every visible shot, a frame just
 * after it starts and just before it ends, so each cut is seen from both sides, and one from the middle
 * of longer shots. Within `max`, the cut frames come first; when even those don't fit, shots are taken
 * evenly across the cut.
 */
export function sampleFrames(segments: ExportVideoSegment[], frameRate: number, window?: TimeWindow, max = MAX_REVIEW_FRAMES): ReviewFrame[] {
  const frame = 1 / (frameRate > 0 ? frameRate : 25);
  const shots = segments.filter((s) => inWindow(s, window)).sort((a, b) => a.timelineStart - b.timelineStart);
  if (shots.length === 0 || max <= 0) return [];

  const at = (s: ExportVideoSegment, index: number, offset: number, place: string): ReviewFrame => ({
    path: s.path,
    sourceTime: round2(
      s.timeMap
        ? sourceAtOffset({ sourceIn: s.sourceIn, sourceOut: s.timeMap[s.timeMap.length - 1].s, duration: s.duration, timeRemap: s.timeMap }, offset)
        : s.sourceIn + offset,
    ),
    time: round2(s.timelineStart + offset),
    label: `shot ${index + 1}, ${place}`,
  });
  // Two frames in from each end: the very first/last frame of a source can be a black or blurred edge.
  const inset = (s: ExportVideoSegment) => Math.min(2 * frame, s.duration / 2);
  const edges = (s: ExportVideoSegment, i: number) =>
    s.duration > 4 * frame ? [at(s, i, inset(s), "first frame"), at(s, i, s.duration - inset(s), "last frame")] : [at(s, i, s.duration / 2, "only frame")];

  const perShot = Math.max(1, Math.floor(max / 2));
  const picked = shots.length <= perShot ? shots.map((_, i) => i) : evenly(shots.length, perShot);
  const frames = picked.flatMap((i) => edges(shots[i], i));

  const long = picked.filter((i) => shots[i].duration >= MID_FRAME_MIN_SECONDS);
  const room = max - frames.length;
  if (room > 0 && long.length > 0) {
    const chosen = long.length <= room ? long : evenly(long.length, room).map((k) => long[k]);
    for (const i of chosen) frames.push(at(shots[i], i, shots[i].duration / 2, "middle"));
  }
  return frames.slice(0, max).sort((a, b) => a.time - b.time);
}

/** `count` indices spread evenly over 0..n-1, first and last included. */
function evenly(n: number, count: number): number[] {
  if (count >= n) return [...Array(n).keys()];
  if (count === 1) return [0];
  return [...new Set([...Array(count).keys()].map((j) => Math.round((j * (n - 1)) / (count - 1))))];
}

/** What is still heard of a line: a line a cut went through has only the words left on the timeline,
 * when the transcript has word timings (else the whole line, marked as cut). */
const heardText = (l: LaneLine) => (!l.partial ? l.text : l.words?.length ? l.words.map((w) => w.text).join(" ") : `${l.text} (partly cut)`);

/** What is said on the timeline, one line per transcript line, for the critic (VibeCut's, verbatim). */
export function transcriptExcerpt(lines: LaneLine[], window?: TimeWindow, maxChars = MAX_TRANSCRIPT_CHARS): string {
  const out: string[] = [];
  let length = 0;
  for (const l of lines) {
    if (window && (l.end <= window.start || l.start >= window.end)) continue;
    const line = `[${round2(l.start)}–${round2(l.end)}] ${speakerTag({ id: l.speakerId, name: l.speaker, role: l.role })}: ${heardText(l)}`;
    if (length + line.length > maxChars) {
      out.push("(…transcript truncated)");
      break;
    }
    out.push(line);
    length += line.length + 1;
  }
  return out.join("\n");
}

/** The heard clips of the lint's view (audio tracks that aren't muted), for the transcript lines. */
function heardClips(input: LintInput): Record<string, Clip> {
  const out: Record<string, Clip> = {};
  for (const t of input.tracks) if (t.type === "audio" && !t.muted) for (const id of t.clipIds) if (input.clipsById[id] && (input.clipsById[id].volume ?? 1) > 0) out[id] = input.clipsById[id];
  return out;
}

export interface CriticFinding {
  time: number;
  severity: Severity;
  category: string;
  issue: string;
  suggestedFix: string;
}

export interface CriticAnswer {
  overall: string;
  findings: CriticFinding[];
  framesSent: number;
  /** Which model reviewed ("Gemini Flash", or the chat's). */
  by?: string;
}

/** The model the critic runs on: Gemini Flash when Settings says so (the default) and there's a Gemini key,
 * else the chat's own. `fellBack` says Gemini was wanted but had no key. */
export function criticModel(): { provider: string; model?: string; label: string; fellBack: boolean } {
  const state = useAgentStore.getState();
  const wantsGemini = state.criticModel !== "same";
  if (wantsGemini && useSystemStore.getState().keys?.gemini) return { provider: "gemini", label: "Gemini Flash", fellBack: false };
  const choice = AI_CHOICES.find((c) => c.id === state.aiChoice) ?? AI_CHOICES[0];
  return { provider: choice.chatProvider, ...(choice.model ? { model: choice.model } : {}), label: choice.label, fellBack: wantsGemini && choice.chatProvider !== "gemini" };
}

/** The most recent thing the user asked the agent, as the critic's brief. */
function lastUserRequest(): string {
  return [...useAgentStore.getState().messages].reverse().find((m) => m.role === "user")?.text ?? "";
}

/** The critic's answer from the `critique` job, checked (it came from a model). */
export function criticAnswer(result: unknown): CriticAnswer | null {
  if (typeof result !== "object" || result === null) return null;
  const r = result as Record<string, unknown>;
  if (!Array.isArray(r.findings)) return null;
  const findings = r.findings.flatMap((f): CriticFinding[] => {
    if (typeof f !== "object" || f === null) return [];
    const x = f as Record<string, unknown>;
    if (typeof x.time !== "number" || typeof x.issue !== "string") return [];
    const severity = x.severity === "high" || x.severity === "low" ? x.severity : "medium";
    return [{ time: x.time, severity, category: typeof x.category === "string" ? x.category : "other", issue: x.issue, suggestedFix: typeof x.suggestedFix === "string" ? x.suggestedFix : "" }];
  });
  return { overall: typeof r.overall === "string" ? r.overall : "", findings, framesSent: typeof r.framesSent === "number" ? r.framesSent : 0 };
}

// ----------------------------------------------------------------------------- the tool

export function reviewToolDeclarations(host: NleHost): ToolDeclaration[] {
  const noun = NOUN[host];
  return [
    {
      name: "review_edit",
      description: `Reviews the connected ${noun} (or the draft) as it stands, without changing it. An automatic check finds mechanical problems: black gaps, flash frames, cuts inside a word, jumps in sound level across a cut, clipping, linked picture and sound out of sync; and for delivery: offline media, switched-off clips and tracks, stray clips past the end, picture with no sound under it, and (with targetLufs) clips off that loudness or peaking over -1 dBTP. Each finding has a time, a severity, the clip ids involved and what to do. Unless visual is false, a separate critic also looks at stills either side of every cut (up to ${MAX_REVIEW_FRAMES}, raw source frames without effects or grades) with what is said there, and reports continuity, framing, B-roll relevance, pacing and story problems with suggested fixes. The critic is a separate model call, so call it after a substantial edit or when asked, not after small edits or more than once per request. Give startTime and endTime to review only part.`,
      parameters: {
        type: "OBJECT",
        properties: {
          startTime: { type: "NUMBER", description: `Only review from this ${noun} time. Optional.` },
          endTime: { type: "NUMBER", description: `Only review up to this ${noun} time. Optional.` },
          targetLufs: { type: "NUMBER", description: "Also check each heard clip against this loudness (e.g. -14 web, -16 podcast, -23 EBU). Optional; measuring takes a few seconds." },
          brief: { type: "STRING", description: "What the cut is meant to achieve, for the critic. Default: the user's last message." },
          visual: { type: "BOOLEAN", description: "Run the vision critic too. Default true; false runs only the fast automatic check." },
        },
      },
    },
  ];
}

/** The last review and what the timeline was then (VibeCut's ReviewMemo): the same review asked again
 * with nothing changed answers from here, so an agent can't spend its steps re-reviewing an unchanged cut. */
interface ReviewMemo {
  key: string;
  seen: string;
  at: number;
  outcome: ToolOutcome;
}
let lastReview: ReviewMemo | null = null;
/** After this long the editor may have been changed by hand, so a review runs again. */
const REVIEW_MEMO_MS = 10 * 60 * 1000;
export const UNCHANGED_REVIEW_NOTE = "Nothing has changed since your last review_edit; fix something or reply.";

/** For tests: forget the last review. */
export function forgetLastReview(): void {
  lastReview = null;
}

/** The findings as the card shows them, the automatic check's and the critic's, in time order. */
export function cardFindings(findings: CheckFinding[], critic: CriticFinding[] = []): ToolFinding[] {
  const rows: ToolFinding[] = [
    ...findings.map((f): ToolFinding => ({ time: f.time, ...(f.end !== undefined ? { end: f.end } : {}), severity: f.severity, text: f.message, source: "check" })),
    ...critic.map((f): ToolFinding => ({ time: f.time, severity: f.severity, text: f.suggestedFix ? `${f.issue} Fix: ${f.suggestedFix}` : f.issue, source: "critic" })),
  ];
  return rows.sort((a, b) => a.time - b.time);
}

export function reviewSummary(findings: CheckFinding[], critic?: CriticAnswer | null, criticError?: string): string {
  const high = findings.filter((f) => f.severity === "high").length;
  const check = findings.length ? `${findings.length} problem(s) found by the automatic check${high ? `, ${high} serious` : ""}` : "the automatic check found nothing to fix";
  const notes = critic ? `; ${critic.findings.length} note(s) from the critic (${critic.by ? `${critic.by}, ` : ""}${critic.framesSent} stills)` : criticError ? ` (the critic couldn't run: ${criticError})` : "";
  const overall = critic?.overall ? ` ${critic.overall}` : "";
  return `Reviewed the cut: ${check}${notes}.${overall}`;
}

export function reviewExecutors(context: ToolContext): Record<string, Executor> {
  const { host } = context;
  return {
    review_edit: async (args: Args) => {
      const view = await connectedView(context);
      const start = optNum(args, "startTime") ?? 0;
      const end = optNum(args, "endTime") ?? view.duration;
      if (!(end > start)) throw new Error("endTime must be after startTime");
      const target = optNum(args, "targetLufs");
      if (target !== undefined && (target < -40 || target > -5)) throw new Error("targetLufs must be between -40 and -5");

      const key = JSON.stringify([host, view.timeline, start, end, target ?? null, optStr(args, "brief") ?? null, bool(args, "visual", true), useAgentStore.getState().criticModel]);
      const seen = JSON.stringify([view.tracks, view.duration]);
      if (lastReview && lastReview.key === key && lastReview.seen === seen && Date.now() - lastReview.at < REVIEW_MEMO_MS) {
        const result = lastReview.outcome.result as Record<string, unknown>;
        return { ...lastReview.outcome, summary: `${lastReview.outcome.summary} (unchanged since the last review)`, result: { ...result, note: UNCHANGED_REVIEW_NOTE } };
      }

      const notes: string[] = [];
      const { input: lintInput, transcripts } = await withWordsAndPeaks(lintTimeline(view, useConnectionStore.getState().connections[host].syncOffsets), host);
      const keep = heardFinding(lintInput);
      const lint = lintEdit(lintInput).filter((f) => (f.end ?? f.time) >= start && f.time <= end && keep(f));
      let findings: CheckFinding[] = [...lint, ...deliveryChecks(view, { start, end })];

      if (target !== undefined) {
        const parts = soundBetween(view, start, end);
        if (parts.length > MAX_MEASURED) notes.push(`loudness measured for the first ${MAX_MEASURED} of ${parts.length} sound clips`);
        const measured = parts.slice(0, MAX_MEASURED);
        if (measured.length) {
          const levels = await measure(measured).catch((error: unknown) => {
            notes.push(`loudness couldn't be measured (${error instanceof Error ? error.message : String(error)})`);
            return null;
          });
          if (levels) {
            const rows = measured.map((p, i) => ({ clipId: p.clip.id, name: p.clip.name, time: Math.max(p.clip.start, start), levelDb: p.clip.volumeDb ?? 0, integratedLufs: levels[i].integratedLufs, truePeakDb: levels[i].truePeakDb }));
            findings.push(...loudnessFindings(rows, target));
          }
        }
      }

      findings = ordered(findings);
      const automaticCheck = findings.map(({ time, end: until, severity, category, message, clipIds }) => ({ time, ...(until !== undefined ? { end: until } : {}), severity, category, message, clipIds }));

      let critic: CriticAnswer | null = null;
      let criticError: string | undefined;
      if (bool(args, "visual", true)) {
        const window = { start, end };
        // A title or nested timeline has no file to take a frame from.
        const frames = sampleFrames(visibleVideo(lintInput), lintInput.frameRate, window).filter((f) => !f.path.startsWith("none:"));
        if (!frames.length) criticError = `there is no picture on the ${NOUN[host]} to look at`;
        else {
          const reviewer = criticModel();
          if (reviewer.fellBack) notes.push(`there's no Gemini key, so the critic ran on ${reviewer.label}`);
          const job = await runJob("critique", `Review the cut (${frames.length} stills, ${reviewer.label})`, {
            provider: reviewer.provider,
            ...(reviewer.model ? { model: reviewer.model } : {}),
            frames,
            brief: optStr(args, "brief") ?? lastUserRequest(),
            snapshot: timelineLines(view).join("\n"),
            transcript: transcriptExcerpt(laneLines(heardClips(lintInput), transcripts, lintInput.assetsById), window),
            lint: automaticCheck.map(({ time, severity, category, message }) => ({ time, severity, category, message })),
          });
          critic = job?.status === "done" ? criticAnswer(job.result) : null;
          if (critic) critic.by = reviewer.label;
          if (!critic) criticError = job?.error ?? `the review ${job?.status ?? "didn't finish"}`;
        }
      }

      const outcome: ToolOutcome = {
        summary: reviewSummary(findings, critic, criticError) + (notes.length ? ` (${notes.join("; ")})` : ""),
        result: {
          automaticCheck,
          critic: critic ? { overall: critic.overall, findings: critic.findings, stillsSeen: critic.framesSent, model: critic.by } : { skipped: criticError ?? "not requested" },
          ...(notes.length ? { notes } : {}),
        },
        findings: cardFindings(findings, critic?.findings),
      };
      lastReview = { key, seen, at: Date.now(), outcome };
      return outcome;
    },
  };
}

/** The ground rule the system prompt gains (VibeCut's REVIEW_INSTRUCTION). */
export const REVIEW_INSTRUCTION = `- review_edit checks the timeline (or the draft) and only reports. Use it when the user asks for a review,
  notes or a QC, and after a substantial edit (a rough cut sent as a draft, a restructure, B-roll placed)
  before you summarise. Before a delivery, pass targetLufs (the notes' target, else -14 for web). Fix what is
  worth fixing with the edit tools, using the clip ids it names, and say what you left. Call it at most once
  per batch of edits: with nothing changed since, it only repeats its last findings.`;
