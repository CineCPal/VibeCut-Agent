/**
 * Background transcription (PLAN.md, "Speaker labels and background transcription"). A two-hour file takes
 * twenty minutes or more to transcribe; waiting for it held the whole chat turn. With `background: true`,
 * transcribe_clips starts the job and answers at once. When the job ends, the app:
 *  - forgets the files' old transcript status, so the next read sees the new transcripts;
 *  - shows a notification (when notifications are on and the window is away);
 *  - posts a message into the chat (queued if a turn is running), so the agent picks up where it was.
 * While it runs, get_transcript on one of its files says it's still being transcribed, with progress.
 */
import { awaitJob, startJob } from "../jobs";
import { notifyAway } from "../notify";
import { useSidecarStore } from "../../store/useSidecarStore";
import type { SidecarJob } from "../../types/sidecar";
import { forgetTranscriptStatus } from "./awareness";

/** The background transcription job of each file being transcribed, by path. */
const running = new Map<string, string>();

const fileName = (path: string) => path.split(/[\\/]/).pop() || path;

export interface TranscribedFile {
  path: string;
  fromCache: boolean;
  speakers: string[];
  segmentCount: number;
}

/** "42%: Transcribing… 40%" for a file transcribing in the background, else null. */
export function backgroundProgress(path: string): string | null {
  const id = running.get(path);
  if (!id) return null;
  const job = useSidecarStore.getState().jobs.find((j) => j.id === id);
  if (!job) return "starting"; // until its first event; the map forgets it when the job ends
  const percent = job.fraction === null ? "" : `${Math.round(job.fraction * 100)}%`;
  return [percent, job.detail].filter(Boolean).join(": ") || "starting";
}

/** The message the agent gets when the job ends: what was transcribed, then what to do. */
export function finishedMessage(files: string[], job: SidecarJob | undefined): string {
  const result = (job?.result ?? {}) as { files?: TranscribedFile[]; failed?: { path: string; message: string }[] };
  const done = result.files ?? [];
  const failed = result.failed ?? [];
  if (!done.length) {
    const why = job?.status === "cancelled" ? "it was stopped" : (failed[0]?.message ?? job?.error ?? "it didn't finish");
    return `[App: background transcription failed] ${files.map(fileName).join(", ")}: ${why}.`;
  }
  const lines = done.map((f) => `${fileName(f.path)} (${f.segmentCount} lines, ${f.speakers.length} speaker(s))`);
  const failures = failed.length ? ` Failed: ${failed.map((f) => `${fileName(f.path)} (${f.message})`).join("; ")}.` : "";
  return `[App: background transcription finished] Transcribed ${lines.join(", ")}.${failures} Continue with what you were doing when you started it.`;
}

/**
 * Starts transcribing `files` in the background and answers with the job's id. `deliver` gets the message
 * for the agent when it ends; it is the chat's submitMessage unless a test gives another.
 */
export async function transcribeInBackground(
  files: string[],
  request: Record<string, unknown>,
  deliver?: (text: string) => Promise<unknown>,
): Promise<string> {
  const id = await startJob("transcribe", `Transcribe ${files.length} file(s) in the background`, { ...request, videos: files });
  for (const path of files) running.set(path, id);
  void awaitJob(id).then(async (job) => {
    for (const path of files) if (running.get(path) === id) running.delete(path);
    forgetTranscriptStatus(files);
    const text = finishedMessage(files, job);
    notifyAway(text.includes("failed]") ? "Transcription failed" : "Transcription finished", text.replace(/^\[[^\]]*\]\s*/, ""));
    try {
      // The controller imports the tools, so it's loaded only when needed.
      const send = deliver ?? (async (t: string) => (await import("./controller")).submitMessage(t));
      await send(text);
    } catch {
      // No chat to tell (it's offline): the notification and the job's own status remain.
    }
  });
  return id;
}

/** For tests: forget every running job. */
export function resetBackgroundTranscriptions(): void {
  running.clear();
}
