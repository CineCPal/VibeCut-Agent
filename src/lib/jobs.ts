/**
 * Running a one-shot sidecar job from a tool and waiting for its answer (the Library's searches, the
 * agent's transcription and silence measuring). Progress and the result arrive as sidecar events into
 * `useSidecarStore` (useSidecarBridge), as for any job.
 */
import { startSidecar } from "./ipc";
import { newId } from "./id";
import { isActive, useSidecarStore } from "../store/useSidecarStore";
import type { SidecarCommand, SidecarJob } from "../types/sidecar";

export const jobId = () => newId().replace(/[^\w-]/g, "").slice(0, 64);

/** Resolves when the job has finished, however it finished. */
export function awaitJob(id: string): Promise<SidecarJob | undefined> {
  const find = () => useSidecarStore.getState().jobs.find((j) => j.id === id);
  return new Promise((resolve) => {
    const now = find();
    if (!now || !isActive(now)) return resolve(now);
    const stop = useSidecarStore.subscribe((s) => {
      const job = s.jobs.find((j) => j.id === id);
      if (!job || !isActive(job)) {
        stop();
        resolve(job);
      }
    });
  });
}

/** Starts a job and waits for it. `onStart` gets its id (to show its progress). */
export async function runJob(command: SidecarCommand, label: string, request: Record<string, unknown>, onStart?: (id: string) => void): Promise<SidecarJob | undefined> {
  const id = jobId();
  useSidecarStore.getState().addJob({ id, command, label });
  onStart?.(id);
  try {
    await startSidecar(id, command, request);
  } catch (error) {
    useSidecarStore.getState().fail(id, error instanceof Error ? error.message : String(error));
  }
  return awaitJob(id);
}
