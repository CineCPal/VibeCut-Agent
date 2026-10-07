/**
 * What the agent is told about the editor (PLAN.md, Phase 4; shared since Phase 7a): the in-app chat
 * puts it ahead of each message, and the MCP bridge's `get_editor_context` returns it to an outside
 * client. Moved here from controller.ts unchanged.
 */
import { nleCall } from "../ipc";
import { snapshotHeader } from "./snapshot";
import { poolContext, refreshPool } from "./projectTools";
import { draftOf } from "./draft";
import { draftAsTimeline } from "../../vibecut/lib/connect/hostDraft";
import { useConnectionStore } from "../../store/useConnectionStore";
import { useNleStateStore } from "../../store/useNleStateStore";
import type { NleHost } from "../../types/nle";
import type { HostTimeline } from "../../types/timeline";

export function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The bracketed context put ahead of the user's words: the open timeline, then the project's pool. */
export async function snapshotFor(host: NleHost | null, timeline: string | null): Promise<string> {
  // Reply timecodes are placed on the timeline read here, and on nothing when none is (a draft isn't in the editor).
  useNleStateStore.getState().setLastTimeline(null);
  if (!host) return snapshotHeader(null, null);
  // Another project in the editor starts the connection (made timelines, pool ids) over.
  useConnectionStore.getState().forProject(host, useNleStateStore.getState().hosts[host].project);
  await refreshPool(host, timeline);
  let view: HostTimeline | null = null;
  let problem: string | undefined;
  const draft = draftOf(host);
  if (draft) {
    // The tools work on the draft while it's open, so the agent sees the draft (VibeCut's rule).
    view = draftAsTimeline(draft, useNleStateStore.getState().hosts[host].project ?? "");
    const head = `[DRAFT of "${draft.base}", not sent yet: ${draft.changes.length} change(s) (${draft.changes.slice(-3).join("; ")}). Its clip ids are the draft's. send_to_${host} makes it a new ${host === "premiere" ? "sequence" : "timeline"}; discard_draft drops it.]`;
    return `${head}\n${snapshotHeader(host, view)}\n\n${poolContext(host, view)}`;
  }
  if (timeline) {
    try {
      view = await nleCall<HostTimeline>(host, "read_timeline", { timeline });
      useNleStateStore.getState().setLastTimeline({ host, timeline, fps: view.fps, startTimecode: view.startTimecode });
    } catch (error) {
      problem = `"${timeline}" couldn't be read: ${describeError(error)}`;
    }
  }
  return `${snapshotHeader(host, view, problem)}\n\n${poolContext(host, view)}`;
}
