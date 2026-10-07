/**
 * The Story Editor (PLAN.md, "Phase 6d"), ported from VibeCut's connected-editor `run_story_editor`
 * (premiereChatTools.ts): a story cut from interview transcripts, and optionally B-roll, made in one
 * call to the chat's own model (the `assemble` sidecar command, vibecut_agent/story), then opened as a
 * draft (`draftFromPlan`) that send_to_premiere / send_to_resolve makes into a NEW timeline. The user's
 * timeline is never changed.
 *
 * Differences from VibeCut:
 * - The model is the chat's (Gemini, or Claude through structured outputs); VibeCut's was Gemini only.
 * - Transcripts keep their speaker roles, so the interviewer is left out unless the brief asks
 *   (VibeCut's project Story Editor did this; its connected one only dropped switched-off speakers).
 * - B-roll can also come from the B-roll Library's Spyglass scope (`brollFromLibrary`), one catalog
 *   entry per indexed shot, placed from the shot's own start in its file.
 * - No music bed (the user's decision for 6d).
 */
import { cancelSidecar } from "../ipc";
import { runJob } from "../jobs";
import { browseSpyglass } from "../spyglassIpc";
import { useAgentStore } from "../../store/useAgentStore";
import { useConnectionStore } from "../../store/useConnectionStore";
import { useLibraryStore } from "../../store/useLibraryStore";
import { AI_CHOICES, type AiChoice, type ChatProvider, type StoryFirstPass } from "../../types/agent";
import type { NleHost } from "../../types/nle";
import { draftFromPlan, syncedPictures } from "../../vibecut/lib/connect/hostDraft";
import { roughCutPlan, roughCutSummary } from "../../vibecut/lib/sidecarResults";
import {
  briefWantsInterviewer,
  capCatalog,
  capTranscripts,
  payloadSegments,
  storySourceOf,
  withoutInterviewer,
  type StoryTranscriptSource,
} from "../../vibecut/lib/storyEditorContext";
import type { StoryBrollCatalogEntry } from "../../vibecut/types/storyEditor";
import { bool, type Args, type Executor, optStr } from "./args";
import { connectedView, draftOf, draftSummary } from "./draft";
import { TIMELINE_NOUN } from "./edits";
import { aliasOf, poolClipId } from "./projectTools";
import { filesOf, readTranscript, withSpeakers } from "./transcriptTools";
import type { ToolContext, ToolDeclaration } from "./tools";

const fileName = (path: string) => path.split(/[\\/]/).pop() || path;
/** How many Library shots are offered to the model at most (the catalog cap trims further). */
const LIBRARY_SHOTS = 500;

/** A B-roll catalog entry, and where in its file it starts (a Spyglass shot starts mid-clip). */
export interface StoryBroll {
  entry: StoryBrollCatalogEntry;
  offset: number;
}

/** B-roll from the project: `brollClipIds` ("p3"), or every video clip in a bin whose path contains
 * `brollBin` (VibeCut's `poolCatalog`: the clip's logged notes are its caption, its keywords its tags). */
export function poolBroll(host: NleHost, args: Args): StoryBroll[] {
  const pool = useConnectionStore.getState().connections[host].pool;
  if (!pool) return [];
  const bin = optStr(args, "brollBin")?.toLowerCase();
  const ids = Array.isArray(args.brollClipIds) ? new Set((args.brollClipIds as unknown[]).filter((v): v is string => typeof v === "string").map((id) => poolClipId(host, id))) : null;
  if (!bin && !ids) return [];
  return pool.clips
    .filter((c) => c.filePath && !c.offline && c.type.includes("Video") && c.duration)
    .filter((c) => (ids ? ids.has(c.id) : c.bin.toLowerCase().includes(bin!)))
    .map((c) => {
      const meta = c.metadata ?? {};
      return {
        entry: {
          brollId: aliasOf(host, c.id),
          path: c.filePath!,
          durationSeconds: c.duration!,
          caption: [meta.Description, meta.Comments, meta["Log Note"]].filter(Boolean).join(". ") || c.name,
          tags: (meta.Keywords ?? "")
            .split(",")
            .map((k) => k.trim())
            .filter(Boolean),
          technicalScore: null,
        },
        offset: 0,
      };
    });
}

/** B-roll from the B-roll Library's ticked folders (the whole archive when none are): its indexed
 * shots that are on line, each with Spyglass's caption and tags. */
export async function libraryBroll(): Promise<StoryBroll[]> {
  const page = await browseSpyglass(useLibraryStore.getState().scopes, 0, LIBRARY_SHOTS);
  return page.shots
    .filter((s) => s.status === "ok" && s.end - s.start > 0.3)
    .map((s, i) => ({
      entry: { brollId: `b${i + 1}`, path: s.path, durationSeconds: s.end - s.start, caption: s.caption, tags: s.tags, technicalScore: s.technical },
      offset: s.start,
    }));
}

/** The Story Editor's result with each B-roll cut moved to where its catalog entry starts in its file
 * (the model times B-roll from the start of the entry; a Library shot starts mid-clip). */
export function withBrollOffsets(result: Record<string, unknown>, broll: StoryBroll[]): Record<string, unknown> {
  const offsets = new Map(broll.filter((b) => b.offset > 0).map((b) => [b.entry.brollId, b.offset]));
  if (!offsets.size || !Array.isArray(result.resolvedSegments)) return result;
  return {
    ...result,
    resolvedSegments: result.resolvedSegments.map((seg: Record<string, unknown>) => {
      const offset = seg?.track === "broll" && typeof seg.source_id === "string" ? offsets.get(seg.source_id) : undefined;
      if (!offset || typeof seg.in_seconds !== "number" || typeof seg.out_seconds !== "number") return seg;
      return { ...seg, in_seconds: seg.in_seconds + offset, out_seconds: seg.out_seconds + offset };
    }),
  };
}

/** Stops the Story Editor's job when the user presses Stop (VibeCut's Stop cancelled it too). */
function cancelOnStop(): { started: (id: string) => void; stopped: () => boolean; done: () => void } {
  let jobId: string | null = null;
  let stopped = false;
  const check = () => {
    if (useAgentStore.getState().status !== "stopping" || stopped) return;
    stopped = true;
    if (jobId) cancelSidecar(jobId).catch(() => undefined);
  };
  const unsubscribe = useAgentStore.subscribe(check);
  return {
    started: (id) => {
      jobId = id;
      check();
    },
    stopped: () => stopped,
    done: unsubscribe,
  };
}

/**
 * The model the Story Editor calls: the chat's own, so on Claude (subscription) the user's Claude Code,
 * with no key (PLAN.md, Phase 7e). Its first pass over long footage uses the same provider unless
 * Settings sets it to Gemini (`extraction`).
 */
export function storyModel(choice: AiChoice): { provider: ChatProvider; model?: string; extraction: StoryFirstPass } {
  return { provider: choice.chatProvider, model: choice.model, extraction: useAgentStore.getState().storyFirstPass };
}

/** The most transcript lines one Story Editor run sends. Above 2,000 (extract.SINGLE_PASS_LIMIT in
 * Python) a first pass reads them all and shortlists; this only keeps a run from being enormous. */
export const MAX_STORY_LINES = 20000;

export function storyExecutors(context: ToolContext): Record<string, Executor> {
  const { host } = context;
  const noun = TIMELINE_NOUN[host];

  /** The interview files: the given clips', else every file with sound on the connected timeline. */
  const storyFiles = async (args: Args): Promise<string[]> => {
    const given = Array.isArray(args.clipIds) ? (args.clipIds as unknown[]).filter((v): v is string => typeof v === "string") : [];
    if (given.length) return [...new Set(await filesOf(context, given))];
    const view = await connectedView(context);
    const withSound = view.tracks.filter((t) => t.type === "audio").flatMap((t) => t.clips.map((c) => c.filePath).filter((p): p is string => !!p));
    if (withSound.length) return [...new Set(withSound)];
    throw new Error(`Which clips? The connected ${noun} has no clips with sound; give clipIds (clips on the ${noun} or project clips like "p3")`);
  };

  return {
    run_story_editor: async (args) => {
      const existing = draftOf(host);
      if (existing) throw new Error(`A draft of "${existing.base}" is already open. Send it (send_to_${host}) or discard it (discard_draft) before a Story Editor cut.`);
      if (!context.timeline) throw new Error(`No ${noun} is open to connect the cut to. Ask the user to open one, or create_timeline.`);
      const prompt = optStr(args, "prompt")?.trim();
      if (!prompt) throw new Error("prompt must be the brief: what the piece is about, in the user's terms");

      const files = await storyFiles(args);
      const read = await Promise.all(
        files.map(async (path, i) => {
          const data = await readTranscript(path).catch(() => null);
          return data ? storySourceOf(withSpeakers(host, path, data), path, `s${i + 1}`) : null;
        }),
      );
      const gathered = read.filter((s): s is StoryTranscriptSource => s !== null);
      const missing = files.filter((_, i) => read[i] === null).map(fileName);
      if (!gathered.length) throw new Error(`None of these files has a transcript yet: ${missing.join(", ")}. Ask the user, then transcribe_clips.`);
      const answers = briefWantsInterviewer(prompt) ? gathered : withoutInterviewer(gathered);
      const { sources, truncated } = capTranscripts(answers.length ? answers : gathered, MAX_STORY_LINES);

      const broll = [...poolBroll(host, args), ...(bool(args, "brollFromLibrary") ? await libraryBroll() : [])];
      const capped = capCatalog(broll.map((b) => b.entry));

      const view = await connectedView(context);
      const choice = AI_CHOICES.find((c) => c.id === useAgentStore.getState().aiChoice) ?? AI_CHOICES[0];
      const story = storyModel(choice);
      const sequenceName = optStr(args, "sequenceName") ?? "Story Cut";
      const stop = cancelOnStop();
      let job;
      try {
        job = await runJob(
          "assemble",
          `Story Editor: "${sequenceName}" from ${sources.length} file(s)`,
          {
            provider: story.provider,
            ...(story.model ? { model: story.model } : {}),
            extraction: story.extraction,
            sources: sources.map((s) => ({ sourceId: s.sourceId, segments: payloadSegments(s) })),
            media: Object.fromEntries(sources.map((s) => [s.sourceId, s.mediaPath])),
            brollCatalog: capped.entries,
            prompt,
            sequenceName,
            targetDuration: optStr(args, "targetDuration") ?? "",
            fps: view.fps,
          },
          stop.started,
        );
      } finally {
        stop.done();
      }
      if (stop.stopped()) throw new Error("Stopped by the user");
      if (!job || job.status !== "done") throw new Error(job?.error ?? "The Story Editor didn't finish");
      const plan = roughCutPlan(job.result ? withBrollOffsets(job.result, broll) : null);
      if (!plan || plan.segments.length === 0) return { summary: "The Story Editor returned no usable cuts", result: { cuts: 0 } };
      const summary = roughCutSummary(job.result);
      // The model may rename the cut; the timeline gets the name asked for, when one was.
      // Cuts from a separately recorded WAV take their picture from the camera synced to it in this timeline.
      const draft = draftFromPlan(context.timeline, view.fps, { ...plan, sequenceName: optStr(args, "sequenceName") ?? plan.sequenceName }, syncedPictures(view));
      useConnectionStore.getState().setDraft(host, draft);
      const notes = [
        missing.length ? `left out ${missing.length} file(s) with no transcript (${missing.join(", ")})` : "",
        truncated ? `only the first ${MAX_STORY_LINES} transcript lines were read` : "",
        capped.truncated ? `only ${capped.entries.length} of ${broll.length} B-roll clips were offered` : "",
        plan.unreadable ? `${plan.unreadable} cut(s) couldn't be read` : "",
        ...draft.notCarried,
      ].filter(Boolean);
      return {
        summary: `Draft: ${draft.changes[0]}${summary?.runtimeLabel ? `, ${summary.runtimeLabel}` : ""}${notes.length ? `; ${notes.join("; ")}` : ""}. Send it to make the ${noun} in ${host === "premiere" ? "Premiere" : "Resolve"}.`,
        result: {
          ...draftSummary(draft),
          name: draft.name,
          narrativeSummary: summary?.narrativeSummary ?? "",
          ...(summary?.warnings.length ? { warnings: summary.warnings.slice(0, 10) } : {}),
          brollOffered: capped.entries.length,
        },
      };
    },
  };
}

export function storyToolDeclarations(host: NleHost): ToolDeclaration[] {
  const noun = TIMELINE_NOUN[host];
  return [
    {
      name: "run_story_editor",
      description: `Builds a story cut from interview transcripts with the Story Editor (one editorial pass by the chat's model over every interview at once) and puts it in a new draft named sequenceName; then call send_to_${host} to make it a new ${noun}. The connected ${noun} isn't changed. Files: those of clipIds, else every file with sound on the connected ${noun}; files with no transcript are left out (transcribe_clips first). The interviewer's lines are left out unless the brief asks for the questions. B-roll (optional): brollBin (a project bin whose clips' logging describes them), brollClipIds, and/or brollFromLibrary (the shots in the B-roll Library's ticked folders, described by Spyglass).`,
      parameters: {
        type: "OBJECT",
        properties: {
          prompt: { type: "STRING", description: "The brief: what the piece is about, tone, structure. Pass on what the user asked for in their own terms; don't add structure they didn't ask for, such as a hook, cold open or teaser (the Story Editor then opens on the story's natural start)." },
          sequenceName: { type: "STRING", description: `Name of the new ${noun}. Optional.` },
          targetDuration: { type: "STRING", description: 'E.g. "2 minutes". Optional.' },
          clipIds: { type: "ARRAY", items: { type: "STRING" }, description: `Interview clips on the ${noun} or in the project. Optional.` },
          brollBin: { type: "STRING", description: 'Part of a project bin path, e.g. "B-roll". Optional.' },
          brollClipIds: { type: "ARRAY", items: { type: "STRING" }, description: 'Specific B-roll project clips ("p3"). Optional.' },
          brollFromLibrary: { type: "BOOLEAN", description: "Offer the B-roll Library's shots (its ticked folders, else the whole archive). Optional." },
        },
        required: ["prompt"],
      },
    },
  ];
}

export function storyInstruction(host: NleHost): string {
  const noun = TIMELINE_NOUN[host];
  return `- For a story cut from interviews ("make a 2-minute piece about how the bakery began"), use
  run_story_editor: it reads the interviews' transcripts (transcribe_clips first if they have none),
  asks the Story Editor for the cut, with B-roll when asked, and puts it in a draft. Tell the user
  what it chose (its narrativeSummary), then send_to_${host} makes the new ${noun}; refine the draft
  with remove_time_ranges or rearrange_sections first if the user wants changes.`;
}
