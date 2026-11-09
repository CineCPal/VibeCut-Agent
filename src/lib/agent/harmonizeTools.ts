/**
 * Harmonizer in the agent (PLAN.md, "Harmonizer in the agent"), ported from VibeCut's harmonize_takes
 * (chatSpeedTools.ts, harmonizeActions.ts): several takes of one performance lined up with a clean
 * reference recording, each following its own tempo drift.
 *
 * The `media-harmonize` job (vibecut_agent/media/harmonize.py) finds each take's stretches; harmonize.ts
 * turns them into a clip with a time map; hostDraft.placeHarmonizedDraft lays them out in the DRAFT, as
 * VibeCut's placeHarmonized does on its timeline: the reference on an audio track, each take on its own
 * video track (the first on top) with its own sound linked beneath and switched off, and a red marker at
 * each stretch it's unsure of. Neither editor can script a variable speed on a clip already on a
 * timeline, so send_to_* builds the takes as pieces at constant speeds (interchange/time_remap), as it
 * does a speed ramp. Clips of the takes already on the timeline are replaced, so each take shows once.
 */
import { runJob } from "../jobs";
import { useConnectionStore } from "../../store/useConnectionStore";
import type { NleHost } from "../../types/nle";
import type { HostTimeline } from "../../types/timeline";
import { placeHarmonizedDraft, referenceZeroIn, withoutTakes, type DraftTake } from "../../vibecut/lib/connect/hostDraft";
import { parseHarmonyResult, placeTake, takeSpeedRange, takeTiming } from "../../vibecut/lib/harmonize";
import type { HarmonyTake } from "../../vibecut/types/harmony";
import { bool, clock, type Args, type Executor, optNum, strArray, type ToolOutcome } from "./args";
import { connectedView, openDraft, saveDraft } from "./draft";
import { HOST_SHORT, TIMELINE_NOUN } from "./edits";
import { factsOf, learnFacts } from "./mediaInfo";
import { poolClipId } from "./projectTools";
import type { ToolContext, ToolDeclaration } from "./tools";

/** Most takes one run lines up (harmonize.py's MAX_TAKES). */
export const MAX_HARMONIZE_TAKES = 16;
/** Below this (0-100: the share of notes, or of same-recording windows, that agreed) a take may not be this
 * piece or this performance at all, and the result says to compare it by ear. */
export const LOW_CONFIDENCE = 40;
/** Below this a take is left out (unless placeAll): on the prototype's recital, takes of the piece scored
 * 64-74 and a file of something else 0, with stretches that ran backwards. */
export const NOT_THIS_PERFORMANCE = 20;
/** How long to wait for the files' formats (picture or not) before guessing from the extension. */
const FACTS_WAIT_MS = 15_000;
const AUDIO_EXTENSIONS = new Set(["wav", "aif", "aiff", "mp3", "m4a", "aac", "flac", "ogg", "opus", "caf", "bwf"]);

const fileName = (path: string) => path.split(/[\\/]/).pop() || path;
const round2 = (n: number) => Math.round(n * 100) / 100;
const pct = (speed: number) => Math.round(speed * 100);

/** Whether a file has picture: its probed format, else its extension. */
export function hasPicture(path: string): boolean {
  const facts = factsOf(path);
  if (facts) return facts.video !== null;
  return !AUDIO_EXTENSIONS.has(path.split(".").pop()?.toLowerCase() ?? "");
}

/** A file named by a clip on the timeline (or draft), a project clip ("p3") or its own absolute path. */
export function pathOfRef(host: NleHost, ref: string, timeline: HostTimeline | null): string {
  if (ref.startsWith("/")) return ref;
  const onTimeline = timeline?.tracks.flatMap((t) => t.clips).find((c) => c.id === ref)?.filePath;
  if (onTimeline) return onTimeline;
  const pool = useConnectionStore.getState().connections[host].pool;
  const clip = pool?.clips.find((c) => c.id === poolClipId(host, ref));
  if (clip?.filePath) return clip.filePath;
  throw new Error(`"${ref}" isn't a clip on the ${TIMELINE_NOUN[host]}, a project clip or a file path`);
}

/** The files asked for, checked as harmonize.py checks them, so a bad request costs no job. */
export function harmonizeRequest(referencePath: string, takePaths: string[], sameRecorderPaths: string[]): { referencePath: string; takePaths: string[]; noRetime: string[] } {
  if (!takePaths.length) throw new Error("takes must list at least one take");
  if (takePaths.length > MAX_HARMONIZE_TAKES) throw new Error(`At most ${MAX_HARMONIZE_TAKES} takes can be lined up at once`);
  if (new Set(takePaths).size !== takePaths.length) throw new Error("The same take is listed twice");
  if (takePaths.includes(referencePath)) throw new Error("The reference recording can't also be a take");
  const stray = sameRecorderPaths.find((p) => !takePaths.includes(p));
  if (stray) throw new Error(`sameRecorder must list takes from takes (${fileName(stray)} isn't one)`);
  return { referencePath, takePaths, noRetime: sameRecorderPaths };
}

const optRefs = (args: Args, key: string): string[] => (args[key] === undefined ? [] : strArray(args, key));

export function harmonizeExecutors(context: ToolContext): Record<string, Executor> {
  const { host } = context;
  const noun = TIMELINE_NOUN[host];

  return {
    harmonize_takes: async (args) => {
      const reference = args.reference;
      if (typeof reference !== "string" || !reference) throw new Error("reference must be the clean recording: a clip id, a project clip or a file path");
      const startTime = optNum(args, "startTime");
      if (startTime !== undefined && !(startTime >= 0)) throw new Error("startTime must be 0 or more seconds");
      const view = await connectedView(context).catch(() => null);
      const request = harmonizeRequest(
        pathOfRef(host, reference, view),
        [...new Set(strArray(args, "takes").map((r) => pathOfRef(host, r, view)))],
        [...new Set(optRefs(args, "sameRecorder").map((r) => pathOfRef(host, r, view)))],
      );

      const files = [request.referencePath, ...request.takePaths];
      const facts = learnFacts(files, FACTS_WAIT_MS);
      const job = await runJob("media-harmonize", `Harmonizer: line up ${request.takePaths.length} take(s) with ${fileName(request.referencePath)}`, request);
      await facts;
      if (job?.result?.cancelled === true) throw new Error("Stopped");
      const result = job?.status === "done" ? parseHarmonyResult(job.result) : null;
      if (!result) throw new Error(`Harmonizer didn't finish: ${job?.error ?? "no result"}`);

      // Take out clips of the takes already there, then find the reference's time 0.
      const { draft: cleared, removed, earliestStart } = withoutTakes(await openDraft(context), request.takePaths);
      const placeAll = bool(args, "placeAll", false);
      const notMatched = result.takes.filter((t) => !placeAll && t.offsetConfidence < NOT_THIS_PERFORMANCE).map((t) => ({ take: fileName(t.path), confidence: Math.round(t.offsetConfidence) }));
      const timings = result.takes
        .filter((t) => placeAll || t.offsetConfidence >= NOT_THIS_PERFORMANCE)
        .map((take) => ({ take, timing: takeTiming(take.segments, take.duration) }));
      if (!timings.length) throw new Error(`None of the takes sounds like ${fileName(request.referencePath)}: ${notMatched.map((t) => `${t.take} (confidence ${t.confidence})`).join(", ")}. Check that the reference is the same piece, or pass placeAll to place them anyway.`);
      const onTimeline = startTime === undefined ? referenceZeroIn(cleared, request.referencePath) : null;
      const earliestLead = Math.min(...timings.map((t) => (t.timing ? t.timing.refStart : Infinity)));
      const inPlace = earliestStart !== null && Number.isFinite(earliestLead) ? earliestStart - earliestLead : undefined;
      const referenceZero = Math.max(0, startTime ?? onTimeline ?? inPlace ?? cleared.duration);

      const problems: string[] = [];
      const placed: { take: HarmonyTake; draft: DraftTake }[] = [];
      for (const { take, timing } of timings) {
        const at = timing ? placeTake(timing, referenceZero) : null;
        if (!at) {
          problems.push(`${fileName(take.path)}: nothing of the take lines up with the reference`);
          continue;
        }
        placed.push({
          take,
          draft: {
            sourcePath: take.path,
            startTime: at.startTime,
            sourceIn: at.sourceIn,
            sourceOut: at.sourceOut,
            duration: at.duration,
            ...(at.timeRemap ? { timeRemap: at.timeRemap } : {}),
            flagged: at.flagged,
            hasSound: true,
            hasPicture: hasPicture(take.path),
          },
        });
      }
      if (!placed.length) throw new Error(`Nothing could be placed: ${problems.join("; ")}`);

      const referenceDuration = factsOf(request.referencePath)?.duration ?? result.referenceDuration;
      const next = placeHarmonizedDraft(cleared, { sourcePath: request.referencePath, duration: referenceDuration }, referenceZero, placed.map((p) => p.draft), { addReference: onTimeline === null });
      const outcome = saveDraft(host, next);

      const takes = placed.map(({ take, draft }) => {
        const speed = takeSpeedRange(draft);
        return {
          take: fileName(take.path),
          picture: draft.hasPicture !== false,
          startsAt: round2(draft.startTime),
          duration: round2(draft.duration),
          slowestPercent: pct(speed.min),
          fastestPercent: pct(speed.max),
          stretches: take.segments.length,
          confidence: Math.round(take.offsetConfidence),
          ...(take.sameRecording ? { sameRecording: true } : {}),
          ...(take.offsetConfidence < LOW_CONFIDENCE ? { unsure: "Few of its notes matched the reference: it may be another piece or another part. Compare it by ear, or leave it out." } : {}),
          flagged: draft.flagged.map((f) => ({ start: round2(draft.startTime + f.start), end: round2(draft.startTime + f.end), speedPercent: pct(f.speed) })),
        };
      });
      const flaggedCount = takes.reduce((n, t) => n + t.flagged.length, 0);
      const unsure = takes.filter((t) => t.unsure).map((t) => t.take);
      return {
        summary:
          `${outcome.summary}. Lined up ${takes.length} take(s) with ${fileName(request.referencePath)}` +
          (onTimeline !== null ? " (its clip already on the timeline)" : ` from ${clock(referenceZero)}`) +
          (removed ? `; replaced ${removed} earlier clip(s) of the takes` : "") +
          (flaggedCount ? `; ${flaggedCount} stretch(es) marked in red to check` : "") +
          (unsure.length ? `; unsure of ${unsure.join(", ")}` : "") +
          (notMatched.length ? `; left out ${notMatched.map((t) => t.take).join(", ")}, which don't sound like this performance` : "") +
          (problems.length ? `; ${problems.length} couldn't be placed` : "") +
          `. It's in the draft: send_to_${host} builds it as a new ${noun}, each take's speed changes as pieces at constant speeds`,
        result: {
          ...(outcome.result as Record<string, unknown>),
          reference: fileName(request.referencePath),
          referenceStartsAt: round2(referenceZero),
          takes,
          ...(removed ? { replacedClips: removed } : {}),
          ...(notMatched.length ? { notThisPerformance: notMatched, notThisPerformanceNote: "Their sound didn't match the reference: probably another piece, a rehearsal of another part, or room sound. Not placed; placeAll places them anyway." } : {}),
          ...(problems.length ? { problems } : {}),
          note: `Each take is on its own video track, retimed to the reference; the topmost track shows. The takes' own sound is beneath, switched off, and the reference is what's heard. After send_to_${host}, cut between takes by trimming or disabling stretches of the upper tracks.`,
        },
      } satisfies ToolOutcome;
    },
  };
}

export function harmonizeToolDeclarations(host: NleHost): ToolDeclaration[] {
  const noun = TIMELINE_NOUN[host];
  return [
    {
      name: "harmonize_takes",
      description: `Harmonizer: lines several takes of the same performance (a song, a recital, a piece of music: multicam angles or separate run-throughs) up with a clean reference recording of it by their sound, following each take's tempo drift, so takes that were played faster or slower stay in sync. Puts the result in the draft (opened from the connected ${noun} if there isn't one): the reference on an audio track (or lined up with its clip already on the ${noun}), each take on its own video track, the first on top, sped up or slowed down in stretches, its own sound beneath and switched off, and a red "Check sync" marker on any stretch it's unsure of. Clips of the takes already on the ${noun} are replaced, so each take shows once. Runs locally (librosa, installed on first use) and takes about a minute per take of a few minutes. Each take reports a confidence (0-100). It can also sort out which files are takes of this piece: give it every candidate (up to ${MAX_HARMONIZE_TAKES}), and ones whose sound doesn't match (confidence under ${NOT_THIS_PERFORMANCE}) are left out and listed; under ${LOW_CONFIDENCE} they're placed but marked unsure. For one fixed offset between a camera and a separate sound recording (interviews, dialogue), use sync_and_place or sync_clips instead. Then send_to_${host} to build it in ${HOST_SHORT[host]}.`,
      parameters: {
        type: "OBJECT",
        properties: {
          reference: { type: "STRING", description: `The clean recording, usually the audio file from the mixer or recorder: a clip id on the ${noun}, a project clip ("p3") or an absolute path.` },
          takes: { type: "ARRAY", items: { type: "STRING" }, description: `The takes (camera angles or performances), up to ${MAX_HARMONIZE_TAKES}, in the order to stack them (the first on top). Same forms as reference.` },
          sameRecorder: {
            type: "ARRAY",
            items: { type: "STRING" },
            description: "Optional: takes whose sound came from the same recorder as the reference; they are only lined up, never sped up or slowed down.",
          },
          startTime: { type: "NUMBER", description: `Optional ${noun} time for the reference's start. Default: where its clip already is, else where the takes were, else the end of the ${noun}.` },
          placeAll: { type: "BOOLEAN", description: `Optional, default false: also place takes whose sound doesn't match the reference (confidence under ${NOT_THIS_PERFORMANCE}), which are otherwise left out and listed.` },
        },
        required: ["reference", "takes"],
      },
    },
  ];
}

export function harmonizeInstruction(host: NleHost): string {
  return `- Takes of one performance (several angles or run-throughs of a song or piece against one clean
  recording): harmonize_takes lines them up by ear with the tempo drift followed, in the draft; then
  send_to_${host}. To find which files are takes of the piece, give it the candidates: those that don't
  match are left out and listed. Say which takes were left out, unsure, or had red "Check sync" markers.`;
}
