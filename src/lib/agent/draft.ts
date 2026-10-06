/**
 * The draft (PLAN.md, "Phase 6b"), ported from VibeCut's draftSession.ts and its send_to_premiere /
 * send_to_resolve: cuts by what is said, and rearrangements, are made in a copy of the connected
 * timeline (VibeCut's hostDraft.ts, verbatim in src/vibecut/), never in the user's timeline. Sending the
 * draft builds a NEW timeline from it in the editor (the watcher's `rebuild`: Premiere XML or OTIO) and
 * connects to it; the original stays as it was. While a draft is open, direct edits are refused, as in
 * VibeCut: they'd change the timeline the draft was copied from.
 */
import { nleCall } from "../ipc";
import { useConnectionStore } from "../../store/useConnectionStore";
import { useNleStateStore } from "../../store/useNleStateStore";
import type { NleHost } from "../../types/nle";
import type { HostTimeline } from "../../types/timeline";
import { arrangeSections, draftAsTimeline, draftFromSnapshot, rebuildRequest, removeRanges, type HostDraft } from "../../vibecut/lib/connect/hostDraft";
import type { TimeRange } from "../../vibecut/lib/timeline";
import { type Args, clock, type Executor, optStr, type ToolOutcome } from "./args";
import { HOST_SHORT, TIMELINE_NOUN } from "./edits";
import type { ToolContext, ToolDeclaration } from "./tools";

export const draftOf = (host: NleHost): HostDraft | null => useConnectionStore.getState().connections[host].draft;

/** Refuses what would change the connected timeline while a draft of it is open. */
export function refuseWhileDrafting(host: NleHost, what: string): void {
  const draft = draftOf(host);
  if (draft) {
    throw new Error(`A draft of "${draft.base}" is open (${draft.changes.length} change(s)). Send it (send_to_${host}) or discard it (discard_draft) before you ${what}.`);
  }
}

/** The connected timeline as the agent's tools read it: the open draft, else the editor's timeline. */
export async function connectedView(context: ToolContext): Promise<HostTimeline> {
  const draft = draftOf(context.host);
  if (draft) return draftAsTimeline(draft, useNleStateStore.getState().hosts[context.host].project ?? "");
  if (!context.timeline) throw new Error(`No ${TIMELINE_NOUN[context.host]} is open in ${HOST_SHORT[context.host]}. Ask the user to open one, or create_timeline.`);
  return nleCall<HostTimeline>(context.host, "read_timeline", { timeline: context.timeline });
}

/** The open draft, or a new one from the connected timeline as the editor has it now. */
export async function openDraft(context: ToolContext): Promise<HostDraft> {
  const open = draftOf(context.host);
  if (open) return open;
  if (!context.timeline) throw new Error(`No ${TIMELINE_NOUN[context.host]} is open in ${HOST_SHORT[context.host]} to make a draft of.`);
  return draftFromSnapshot(await nleCall<HostTimeline>(context.host, "read_timeline", { timeline: context.timeline }));
}

export const draftSummary = (draft: HostDraft) => ({
  duration: draft.duration,
  changes: draft.changes,
  videoTracks: draft.video.length,
  audioTracks: draft.audio.length,
  ...(draft.notCarried.length ? { notCarried: draft.notCarried } : {}),
});

/** Saves the draft and reports its last change. */
export function saveDraft(host: NleHost, next: HostDraft): ToolOutcome {
  useConnectionStore.getState().setDraft(host, next);
  return { summary: `Draft: ${next.changes[next.changes.length - 1]}; now ${clock(next.duration)}`, result: draftSummary(next) };
}

/** `key` as a list of {start, end} in seconds (VibeCut's chatArgs.ranges). */
export function rangeList(args: Args, key: string): TimeRange[] {
  const raw = args[key];
  if (!Array.isArray(raw) || raw.length === 0) throw new Error(`${key} must be a non-empty array of {start, end}`);
  return raw.map((value, i) => {
    const r = (typeof value === "object" && value !== null ? value : {}) as Args;
    if (typeof r.start !== "number" || typeof r.end !== "number" || !(r.end > r.start)) throw new Error(`${key}[${i}] must have start < end, in seconds`);
    return { start: r.start, end: r.end };
  });
}

interface RebuildResult {
  timeline: string;
  clips: number;
  markersAdded: number;
  warnings: string[];
  bin?: string;
  gradesCopied?: number;
  gradesNotCopied?: number;
}

/** Builds the new timeline from the draft, connects to it and closes the draft. */
export async function sendDraft(context: ToolContext, name?: string): Promise<ToolOutcome> {
  const { host } = context;
  const draft = draftOf(host);
  if (!draft) throw new Error("There's no draft to send");
  const request = rebuildRequest(draft, name);
  // Premiere's rebuild carries no grades.
  if (host === "premiere") delete request.grades;
  const r = await nleCall<RebuildResult>(host, "rebuild", request);
  const store = useConnectionStore.getState();
  store.addMadeTimeline(host, r.timeline);
  store.setDraft(host, null);
  context.timeline = r.timeline;
  const notes = [
    host === "premiere" ? `in the "${r.bin ?? "VibeCut"}" bin` : r.gradesCopied ? `${r.gradesCopied} grade(s) carried` : null,
    r.markersAdded ? `${r.markersAdded} marker(s)` : null,
    draft.notCarried.length ? `not carried: ${draft.notCarried.join(", ")}` : null,
  ].filter(Boolean);
  return {
    summary: `Made the new ${TIMELINE_NOUN[host]} "${r.timeline}" in ${HOST_SHORT[host]} from the draft (${r.clips} clip(s)${notes.length ? `; ${notes.join("; ")}` : ""}), opened it and connected to it; "${draft.base}" is unchanged`,
    result: { ...r, original: draft.base, ...(draft.notCarried.length ? { notCarried: draft.notCarried } : {}) },
  };
}

export function discardDraft(host: NleHost): ToolOutcome {
  const draft = draftOf(host);
  if (!draft) return { summary: "There was no draft open", result: { discarded: false } };
  useConnectionStore.getState().setDraft(host, null);
  return { summary: `Discarded the draft of "${draft.base}" (${draft.changes.length} change(s)); the ${TIMELINE_NOUN[host]} is as it was`, result: { discarded: true } };
}

export function draftExecutors(context: ToolContext): Record<string, Executor> {
  const { host } = context;
  return {
    remove_time_ranges: async (args) => saveDraft(host, removeRanges(await openDraft(context), rangeList(args, "ranges"))),
    rearrange_sections: async (args) => saveDraft(host, arrangeSections(await openDraft(context), rangeList(args, "sections"))),
    [`send_to_${host}`]: (args) => sendDraft(context, optStr(args, "name")),
    discard_draft: async () => discardDraft(host),
  };
}

const rangeItems = (description: string) => ({
  type: "ARRAY",
  description,
  items: { type: "OBJECT", properties: { start: { type: "NUMBER" }, end: { type: "NUMBER" } }, required: ["start", "end"] },
});

export function draftToolDeclarations(host: NleHost): ToolDeclaration[] {
  const noun = TIMELINE_NOUN[host];
  const editor = HOST_SHORT[host];
  return [
    {
      name: "remove_time_ranges",
      description: `In the draft (opened from the connected ${noun} if there isn't one), removes these time ranges from every track and closes the gaps (a ripple delete). Overlapping ranges are merged. Later times move earlier, so give all the ranges for one request in one call, in the ${noun}'s current times.`,
      parameters: { type: "OBJECT", properties: { ranges: rangeItems(`Seconds from the start of the ${noun} (or draft).`) }, required: ["ranges"] },
    },
    {
      name: "rearrange_sections",
      description: `In the draft, rebuilds the ${noun} from these sections, played one after another in the order given; everything not listed is dropped. Every track is cut at each section's edges and moves with it, and markers inside a section move with it.`,
      parameters: { type: "OBJECT", properties: { sections: rangeItems("In the order they should play.") }, required: ["sections"] },
    },
    {
      name: `send_to_${host}`,
      description: `Builds a new ${editor} ${noun} from the draft (named like "Interview (VibeCut 1)" unless you give a name)${host === "premiere" ? ' in a "VibeCut" bin' : ", carrying each clip's grade"}, keeps the markers, opens it in ${editor} and connects to it. The original ${noun} is not changed. Call it once, when the draft is done.`,
      parameters: { type: "OBJECT", properties: { name: { type: "STRING", description: `Name for the new ${noun}. Optional.` } } },
    },
    {
      name: "discard_draft",
      description: `Throws the draft away; the ${noun} is as it was.`,
      parameters: { type: "OBJECT", properties: {} },
    },
  ];
}

export function draftInstruction(host: NleHost): string {
  const noun = TIMELINE_NOUN[host];
  return `- Cutting by content (remove_time_ranges, rearrange_sections, remove_transcript_lines,
  remove_speaker_lines) works in a DRAFT: a copy of the connected ${noun} where the rest closes up after
  each cut. The snapshot shows the draft while one is open, with its own clip ids. When it's done, call
  send_to_${host} once: it creates a NEW ${noun} (like "Interview (VibeCut 1)"), opens it and connects to
  it; the user's ${noun} is left as it is. Say which ${noun} you created. discard_draft throws it away.
  While a draft is open, direct edits, create_timeline and switch_timeline are refused: send or discard
  it first. A rebuilt ${noun} can't carry transitions, effects, titles, adjustment layers or nested
  ${noun}s; the draft lists what won't be carried (notCarried). Mention it when you send.`;
}
