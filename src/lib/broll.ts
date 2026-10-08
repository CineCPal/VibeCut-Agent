/**
 * Starts and stops the B-roll analyzer's jobs (PLAN.md, Phase 4), and sends its selects to a Premiere XML
 * or a new timeline (Phase 10). Progress, ETA and the result come back as sidecar events into
 * `useSidecarStore` (useSidecarBridge), as for any job.
 */
import { cancelSidecar, chooseSavePath, nleCall, startSidecar } from "./ipc";
import { awaitJob, jobId, runJob } from "./jobs";
import { addClips } from "./agent/editTools";
import { count, HOST_SHORT, TIMELINE_NOUN } from "./agent/edits";
import { draftOf } from "./agent/draft";
import { timelineLayout, type Selects } from "./brollSelects";
import { runParams, useBrollStore } from "../store/useBrollStore";
import { useConnectionStore } from "../store/useConnectionStore";
import { selectActiveHost, useNleStateStore } from "../store/useNleStateStore";
import { useSidecarStore } from "../store/useSidecarStore";
import type { AnalyzeResult, ExportResult } from "../types/broll";
import type { NleHost } from "../types/nle";

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Scores every clip in the folder: technical quality, plus energy and brief relevance when on, with
 * the panel's segment options. A finished run is kept (`keepResult`), so a restart still shows it. */
export async function startAnalysis(): Promise<void> {
  const state = useBrollStore.getState();
  const { folder } = state;
  if (!folder) return;
  const params = runParams(state);
  const id = jobId();
  const name = folder.split("/").filter(Boolean).pop() ?? folder;
  useSidecarStore.getState().addJob({ id, command: "broll-analyze", label: `Analyze ${name}` });
  useBrollStore.getState().setAnalyzeJob(id);
  try {
    await startSidecar(id, "broll-analyze", {
      folder,
      enableEnergy: params.contentAware,
      windowSec: params.windowSec,
      maxSegments: params.maxSegments,
      minGapSec: params.minGapSec,
      ...(params.contentAware ? { energyWeight: params.energyWeight / 100 } : {}),
      ...(params.brief ? { brief: params.brief, relevanceWeight: params.relevanceWeight / 100 } : {}),
      ...(params.dedupe ? { dedupe: true } : {}),
      ...(state.workers ? { workers: state.workers } : {}),
    });
  } catch (error) {
    useSidecarStore.getState().fail(id, describeError(error));
    return;
  }
  void awaitJob(id).then((job) => {
    const result = job?.result as AnalyzeResult | null | undefined;
    if (job?.status !== "done" || !result || result.cancelled || !Array.isArray(result.ranked)) return;
    if (useBrollStore.getState().folder === folder) useBrollStore.getState().keepResult(folder, params, result);
  });
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

/** The longest add_clips batch: Premiere takes at most 50 clips a call (premiere_edit.add_clips). */
const BUILD_BATCH = 50;

const clockLength = (seconds: number) => {
  const total = Math.round(seconds);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
};

/** The sequence name to use: the option, or the default when it's blank. */
const nameOf = (name: string) => name.trim().replace(/\s+/g, " ") || "B-Roll Selects";

/** Asks where to save, then writes the selects as a Premiere XML (`broll-export`, read from the folder's
 * cache, no decoding). Returns what happened, or null if the user cancelled the save dialog. */
export async function exportSelectsXml(chosen: Selects, onStart?: (id: string) => void): Promise<{ text: string; path: string } | null> {
  const { folder, sequenceName, contentAware, lastResult } = useBrollStore.getState();
  if (!folder || !chosen.clips.length) throw new Error("No segments are selected.");
  const folderName = folder.split("/").filter(Boolean).pop() ?? "B-roll";
  const path = await chooseSavePath("Export Premiere XML", `${folder}/${folderName} selects.xml`, ["xml"]);
  if (!path) return null;
  const outputPath = path.toLowerCase().endsWith(".xml") ? path : `${path}.xml`;
  const job = await runJob(
    "broll-export",
    `Export ${folderName} selects`,
    {
      folder,
      outputPath,
      sequenceName: nameOf(sequenceName),
      showEnergy: contentAware && (lastResult?.params.contentAware ?? false),
      clips: chosen.clips.map((c) => ({ path: c.path, score: c.score, energy: c.energy, segments: c.segments.map(({ start, end }) => ({ start, end })) })),
    },
    onStart,
  );
  if (job?.status !== "done" || !job.result) throw new Error(job?.error ?? "The export stopped before it finished.");
  const r = job.result as unknown as ExportResult;
  return {
    text: `Wrote ${count(r.segments, "segment")} from ${count(r.clips, "clip")} (${clockLength(r.seconds)}). In Premiere: File → Import.`,
    path: r.exportPath,
  };
}

/** Why Build timeline is off now (no editor, or a Story Editor draft is open), or null. */
export function buildBlocked(): string | null {
  const host = selectActiveHost(useNleStateStore.getState());
  if (!host) return "Connect Premiere Pro or DaVinci Resolve to build a timeline";
  if (draftOf(host)) return `A Story Editor draft is open in ${HOST_SHORT[host]}; send or discard it first`;
  return null;
}

/** Makes a new timeline in the connected editor with the selects laid back to back, picture and sound.
 * The clips go in as one request, so the Agent tab's Revert takes the build back; the new timeline
 * itself stays (Revert doesn't delete timelines, as for the agent's create_timeline). */
export async function buildSelectsTimeline(chosen: Selects, onProgress?: (text: string) => void): Promise<string> {
  const blocked = buildBlocked();
  if (blocked) throw new Error(blocked);
  if (!chosen.clips.length) throw new Error("No segments are selected.");
  const nle = useNleStateStore.getState();
  const host = selectActiveHost(nle) as NleHost;
  const current = nle.hosts[host].timeline;
  const name = nameOf(useBrollStore.getState().sequenceName);
  onProgress?.(`Making "${name}" in ${HOST_SHORT[host]}…`);
  const { timeline } = await nleCall<{ timeline: string }>(host, "create_timeline", { ...(current ? { timeline: current } : {}), name });
  useConnectionStore.getState().addMadeTimeline(host, timeline);

  const layout = timelineLayout(chosen.clips);
  const ctx = { host, timeline, step: `broll-${jobId()}`, stepText: `Build "${timeline}" from B-roll selects` };
  let placed = 0;
  const refused: string[] = [];
  for (let i = 0; i < layout.length; i += BUILD_BATCH) {
    const batch = layout.slice(i, i + BUILD_BATCH);
    onProgress?.(`Placing ${placed + 1}–${placed + batch.length} of ${layout.length}…`);
    const outcome = await addClips(
      ctx,
      "build_broll_selects",
      batch.map(({ path, sourceIn, sourceOut, at }) => ({ path, sourceIn, sourceOut, at })),
    );
    const result = outcome.result as { changes?: unknown[]; refused?: { reason: string }[] } | undefined;
    placed += result?.changes?.length ?? batch.length;
    for (const r of result?.refused ?? []) refused.push(r.reason);
  }
  const seconds = layout.reduce((sum, s) => sum + (s.sourceOut - s.sourceIn), 0);
  const parts = [`Made "${timeline}" in ${HOST_SHORT[host]} with ${count(layout.length, "segment")} (${clockLength(seconds)}); Revert in the Agent tab takes the clips back`];
  if (refused.length) parts.push(`${HOST_SHORT[host]} refused ${refused.length}: ${refused[0]}`);
  return `${parts.join(". ")}.`;
}
