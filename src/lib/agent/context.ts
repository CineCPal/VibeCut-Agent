/**
 * What the agent is told about the editor (PLAN.md, Phase 4; shared since Phase 7a): the in-app chat
 * puts it ahead of each message, and the MCP bridge's `get_editor_context` returns it to an outside
 * client. Moved here from controller.ts unchanged.
 */
import { nleCall } from "../ipc";
import { snapshotHeader } from "./snapshot";
import { poolContext, refreshPool } from "./projectTools";
import { draftOf } from "./draft";
import { filesOf, learnFacts, sourcesContext } from "./mediaInfo";
import { libraryContext, transcriptsContext } from "./awareness";
import { loadNotes, notesContext } from "../projectNotes";
import { draftAsTimeline } from "../../vibecut/lib/connect/hostDraft";
import { useConnectionStore } from "../../store/useConnectionStore";
import { useNleStateStore } from "../../store/useNleStateStore";
import type { NleHost } from "../../types/nle";
import type { HostTimeline } from "../../types/timeline";

/** The timeline the last snapshot read (Phase 11c: what @-mentions offer clips and markers from). */
let lastView: { host: NleHost; timeline: string; view: HostTimeline } | null = null;

export function lastTimelineView(host: NleHost, timeline: string): HostTimeline | null {
  return lastView && lastView.host === host && lastView.timeline === timeline ? lastView.view : null;
}

export function rememberTimelineView(host: NleHost, timeline: string, view: HostTimeline): void {
  lastView = { host, timeline, view };
}

export function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The bracketed context put ahead of the user's words: the open timeline, then the project's pool. */
export async function snapshotFor(host: NleHost | null, timeline: string | null): Promise<string> {
  // Reply timecodes are placed on the timeline read here, and on nothing when none is (a draft isn't in the editor).
  useNleStateStore.getState().setLastTimeline(null);
  if (!host) return snapshotHeader(null, null);
  // Another project in the editor starts the connection (made timelines, pool ids) over.
  const project = useNleStateStore.getState().hosts[host].project;
  useConnectionStore.getState().forProject(host, project);
  // The project's notes come first (Phase 13c), read beside everything else.
  const notes = project ? loadNotes(host, project).then((text) => `${notesContext(project, text)}\n\n`, () => "") : Promise.resolve("");
  // The pool and the timeline are read side by side (Phase 11f); the watcher answers them in turn.
  const pool = refreshPool(host, timeline);
  let view: HostTimeline | null = null;
  let problem: string | undefined;
  const draft = draftOf(host);
  if (draft) {
    await pool;
    // The tools work on the draft while it's open, so the agent sees the draft (VibeCut's rule).
    view = draftAsTimeline(draft, useNleStateStore.getState().hosts[host].project ?? "");
    const head = `[DRAFT of "${draft.base}", not sent yet: ${draft.changes.length} change(s) (${draft.changes.slice(-3).join("; ")}). Its clip ids are the draft's. send_to_${host} makes it a new ${host === "premiere" ? "sequence" : "timeline"}; discard_draft drops it.]`;
    return `${await notes}${head}\n${snapshotHeader(host, view)}\n\n${poolContext(host, view)}${await awarenessFor(host, view)}`;
  }
  if (timeline) {
    try {
      view = await nleCall<HostTimeline>(host, "read_timeline", { timeline });
      useNleStateStore.getState().setLastTimeline({ host, timeline, fps: view.fps, startTimecode: view.startTimecode });
      rememberTimelineView(host, timeline, view);
    } catch (error) {
      problem = `"${timeline}" couldn't be read: ${describeError(error)}`;
    }
  }
  await pool;
  return `${await notes}${snapshotHeader(host, view, problem)}\n\n${poolContext(host, view)}${await awarenessFor(host, view)}`;
}

/** Phase 13a's lines after the pool: the files' formats, their transcripts, and what find_broll searches.
 * Each is best effort: a failure leaves its line out, never the snapshot. */
async function awarenessFor(host: NleHost, view: HostTimeline | null): Promise<string> {
  const lines: string[] = [];
  if (view) {
    const [, transcripts] = await Promise.all([
      learnFacts(filesOf(view)).catch(() => undefined),
      transcriptsContext(host, view).catch(() => null),
    ]);
    const sources = sourcesContext(view);
    if (sources) lines.push(sources);
    if (transcripts) lines.push(transcripts);
  }
  lines.push(libraryContext());
  return `\n\n${lines.join("\n")}`;
}
