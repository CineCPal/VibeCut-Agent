/**
 * Starts and stops the B-roll analyzer's jobs (PLAN.md, Phase 4). Progress, ETA and the result come
 * back as sidecar events into `useSidecarStore` (useSidecarBridge), as for any job.
 */
import { cancelSidecar, nleCall, startSidecar } from "./ipc";
import { newId } from "./id";
import { addClips } from "./agent/editTools";
import { HOST_SHORT, TIMELINE_NOUN } from "./agent/edits";
import { useBrollStore } from "../store/useBrollStore";
import { selectActiveHost, useNleStateStore } from "../store/useNleStateStore";
import { useSidecarStore } from "../store/useSidecarStore";

const jobId = () => newId().replace(/[^\w-]/g, "").slice(0, 64);

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Scores every clip in the folder: technical quality, plus energy and brief relevance when on. */
export async function startAnalysis(): Promise<void> {
  const { folder, contentAware, brief, dedupe } = useBrollStore.getState();
  if (!folder) return;
  const id = jobId();
  const name = folder.split("/").filter(Boolean).pop() ?? folder;
  useSidecarStore.getState().addJob({ id, command: "broll-analyze", label: `Analyze ${name}` });
  useBrollStore.getState().setAnalyzeJob(id);
  try {
    await startSidecar(id, "broll-analyze", {
      folder,
      enableEnergy: contentAware,
      ...(contentAware && brief.trim() ? { brief: brief.trim() } : {}),
      ...(contentAware && dedupe ? { dedupe: true } : {}),
    });
  } catch (error) {
    useSidecarStore.getState().fail(id, describeError(error));
  }
}

/** Finds the clips that fit a sentence (needs content-aware scoring's model). */
export async function startMatch(): Promise<void> {
  const { folder, query } = useBrollStore.getState();
  const text = query.trim();
  if (!folder || !text) return;
  const id = jobId();
  useSidecarStore.getState().addJob({ id, command: "broll-match", label: `Find "${text}"` });
  useBrollStore.getState().setMatchJob(id);
  try {
    await startSidecar(id, "broll-match", { folder, queries: [{ id: "q", text }], topK: 8 });
  } catch (error) {
    useSidecarStore.getState().fail(id, describeError(error));
  }
}

export async function cancelJob(id: string): Promise<void> {
  useSidecarStore.getState().markCancelling(id);
  await cancelSidecar(id).catch(() => undefined);
}

/** Where a pick can go now: the editor and timeline it would be placed on, or why there's none. */
export function placementTarget(only?: "premiere" | "resolve"): { host: "premiere" | "resolve"; timeline: string } | string {
  const nle = useNleStateStore.getState();
  const host = only ? (nle.hosts[only].status === "connected" ? only : null) : selectActiveHost(nle);
  if (!host) return only ? `Connect ${HOST_SHORT[only]} to place clips` : "Connect Premiere Pro or DaVinci Resolve to place clips";
  const timeline = nle.hosts[host].timeline;
  if (!timeline) return `Open a ${TIMELINE_NOUN[host]} in ${HOST_SHORT[host]} to place clips`;
  return { host, timeline };
}

/** Places a clip's best stretch at the playhead of the open timeline, as a logged, revertible edit
 * (its own request, so the chat's Revert takes it back). `sound: false` places the picture only, as
 * the Library does for B-roll; `host` places it in that editor only (the Premiere B-roll panel's). Returns
 * what happened. */
export async function placeAtPlayhead(
  clip: { path: string; filename: string; start: number; end: number },
  options: { sound?: boolean; host?: "premiere" | "resolve" } = {},
): Promise<string> {
  const target = placementTarget(options.host);
  if (typeof target === "string") throw new Error(target);
  const { time } = await nleCall<{ time: number }>(target.host, "get_playhead", { timeline: target.timeline });
  const ctx = { ...target, step: `broll-${jobId()}`, stepText: `Place ${clip.filename}` };
  const spec: Record<string, unknown> = { path: clip.path, sourceIn: clip.start, sourceOut: clip.end, at: time };
  if (options.sound === false) spec.sound = false;
  const outcome = await addClips(ctx, "place_broll", [spec]);
  return outcome.summary;
}
